/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W28 verification codes (TOTP, whimsy.feature.totp): the six-digit codes
// sites ask for after the password, kept by Whimsy and filled on a click.
//
// - Add: right-click a site's setup QR code → Add Verification Code… (the
//   page side, WhimsyTOTPChild, decodes it), or Settings → Verification
//   codes → Add Code… with the setup key. One WhimsySurface for both.
// - Fill: the field button in a code field (WhimsyTOTPChild) asks the
//   parent (WhimsyTOTPParent); one code fills, several open a chooser.
// - Manage: the Settings card (whimsy-settings.js): Copy code behind Touch
//   ID once per session, Delete with Undo.
//
// Storage (owner, W28: "Sync. Unique per profile."): each code is a record
// in Firefox's own login store, under a chrome:// origin no web page or
// HTTP auth prompt can ever match. That store is encrypted on disk with the
// profile's key (and the primary password when one is set), and Firefox
// Sync's passwords engine already carries every record end to end, so codes
// follow the person's other devices whenever password sync is on, with no
// new Sync collection. Everything about that lives in `store` below; the
// rest of Whimsy only sees `list`, `save`, `remove`, `restore`, and codes.
//
// Secrets never leave the parent process except as the one code filled into
// the field the person clicked, and are never logged: errors are reported
// by name only.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LoginHelper: "resource://gre/modules/LoginHelper.sys.mjs",
  WhimsyAuth: "resource:///modules/whimsy/WhimsyAuth.sys.mjs",
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["branding/brand.ftl", "browser/whimsy.ftl"], true));

const FEATURE_PREF = "whimsy.feature.totp";
const HTML_NS = "http://www.w3.org/1999/xhtml";
export const STORE_ORIGIN = "chrome://whimsy-verification-codes";
const REALM_PREFIX = "whimsy-totp|v1|";
const MENU_ID = "context-whimsy-totp-add";
const KEY_ICON = "chrome://browser/skin/zen-icons/selectable/key.svg";
const ADD_ID = "whimsy-totp-add";
const CHOOSER_ID = "whimsy-totp-chooser";
const CHANGED_TOPIC = "whimsy-totp-changed";
// Under this many seconds left, the next code is filled (design: "Code
// about to change").
const NEXT_CODE_UNDER = 5;
const MAX_URI = 2048;
const MAX_TEXT = 256;
const MIN_SECRET_BYTES = 10; // 80 bits: the shortest keys sites hand out
const MAX_SECRET_BYTES = 128;
const ALGORITHMS = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" };
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// -- the math (RFC 4648 base32, RFC 6238 TOTP) --------------------------------

/** Bytes of a base32 key (spaces, dashes, and padding allowed), or null. */
export function base32Decode(text) {
  if (typeof text != "string" || text.length > 512) {
    return null;
  }
  const clean = text.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (!clean || !/^[A-Z2-7]+$/.test(clean)) {
    return null;
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

/** A base32 key in its plain form (upper case, no spaces or padding), or null. */
export function normalizeSecret(text) {
  const bytes = base32Decode(text);
  if (!bytes || bytes.length < MIN_SECRET_BYTES || bytes.length > MAX_SECRET_BYTES) {
    return null;
  }
  return text.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
}

/**
 * The code for `entry` ({secret, algorithm, digits, period}) at `timeMs`.
 */
export async function totp(entry, timeMs) {
  const key = base32Decode(entry.secret);
  if (!key?.length) {
    throw new Error("Whimsy TOTP: bad key");
  }
  const counter = Math.floor(timeMs / 1000 / entry.period);
  const message = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    message[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: ALGORITHMS[entry.algorithm] ?? "SHA-1" },
    false,
    ["sign"]
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, message));
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(binary % 10 ** entry.digits).padStart(entry.digits, "0");
}

/** Whole seconds until the code at `timeMs` changes (1…period). */
export function secondsLeft(entry, timeMs) {
  const elapsed = Math.floor(timeMs / 1000) % entry.period;
  return entry.period - elapsed;
}

/** The code to fill now: the next one when this one is about to change. */
export async function fillCode(entry, timeMs) {
  const left = secondsLeft(entry, timeMs);
  if (left < NEXT_CODE_UNDER) {
    return { code: await totp(entry, timeMs + left * 1000), seconds: left + entry.period };
  }
  return { code: await totp(entry, timeMs), seconds: left };
}

/** "481920" → "481 920" (and "12345678" → "1234 5678"). */
export function groupCode(code) {
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)} ${code.slice(half)}`;
}

function cleanText(text) {
  if (typeof text != "string") {
    return null;
  }
  const trimmed = text.trim();
  if (trimmed.length > MAX_TEXT || CONTROL.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Parses an otpauth://totp/ URI strictly. Returns {issuer, account, secret,
 * algorithm, digits, period} or null for anything else: hotp codes, a
 * missing or short key, unknown parameters' values, control characters, or
 * anything over 2048 characters.
 */
export function parseOtpauth(uri) {
  if (typeof uri != "string" || uri.length > MAX_URI || CONTROL.test(uri)) {
    return null;
  }
  const match = /^otpauth:\/\/totp\/([^?#]*)(?:\?([^#]*))?$/i.exec(uri);
  if (!match) {
    return null;
  }
  let label;
  try {
    label = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  let params;
  try {
    params = new URLSearchParams(match[2] ?? "");
  } catch {
    return null;
  }
  const one = name => {
    const all = params.getAll(name);
    return all.length > 1 ? undefined : (all[0] ?? null);
  };
  const secret = normalizeSecret(one("secret") ?? "");
  if (!secret) {
    return null;
  }
  const algorithm = (one("algorithm") ?? "SHA1").toUpperCase();
  const digits = one("digits") ?? "6";
  const period = one("period") ?? "30";
  if (!ALGORITHMS[algorithm] || !/^[678]$/.test(digits) || !/^\d{1,3}$/.test(period)) {
    return null;
  }
  const periodValue = Number(period);
  if (periodValue < 1 || periodValue > 300) {
    return null;
  }
  let issuer = one("issuer");
  if (issuer === undefined) {
    return null;
  }
  let account = label;
  const colon = label.indexOf(":");
  if (colon != -1) {
    const prefix = label.slice(0, colon);
    account = label.slice(colon + 1);
    issuer ??= prefix;
  }
  issuer = cleanText(issuer ?? "");
  account = cleanText(account);
  if (issuer == null || account == null) {
    return null;
  }
  return { issuer, account, secret, algorithm, digits: Number(digits), period: periodValue };
}

/** The URI a parsed entry is stored as. */
export function buildOtpauth(entry) {
  const label = encodeURIComponent(entry.issuer ? `${entry.issuer}:${entry.account}` : entry.account);
  const params = new URLSearchParams({ secret: entry.secret });
  if (entry.issuer) {
    params.set("issuer", entry.issuer);
  }
  params.set("algorithm", entry.algorithm);
  params.set("digits", String(entry.digits));
  params.set("period", String(entry.period));
  return `otpauth://totp/${label}?${params}`;
}

/** A site the way codes are kept: a lower-case host name, or null. */
export function normalizeSite(text) {
  if (typeof text != "string") {
    return null;
  }
  let host = text.trim().toLowerCase();
  if (!host || host.length > 253) {
    return null;
  }
  try {
    host = new URL(host.includes("://") ? host : `https://${host}`).hostname;
  } catch {
    return null;
  }
  if (!host || !/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".")) {
    return null;
  }
  return host;
}

function baseDomain(host) {
  try {
    return Services.eTLD.getBaseDomainFromHost(host);
  } catch {
    return host;
  }
}

// -- the store: Firefox's login store, behind this one object -----------------

const store = {
  // Metadata only (never a key): rebuilt from the login store when it
  // changes. null until first read.
  cache: null,
  loading: null,

  realm(profileKey, site) {
    return `${REALM_PREFIX}${profileKey}|${site}`;
  },

  parseRealm(realm) {
    if (typeof realm != "string" || !realm.startsWith(REALM_PREFIX)) {
      return null;
    }
    const rest = realm.slice(REALM_PREFIX.length);
    const bar = rest.lastIndexOf("|");
    if (bar <= 0) {
      return null;
    }
    const profileKey = rest.slice(0, bar);
    const site = normalizeSite(rest.slice(bar + 1));
    return site ? { profileKey, site } : null;
  },

  // The record's password: the otpauth URI and the profile's name when it
  // was saved (another device may not know that profile by key).
  pack(entry, profileName) {
    return JSON.stringify({ v: 1, uri: buildOtpauth(entry), profile: profileName ?? "" });
  },

  unpack(password) {
    try {
      const data = JSON.parse(password);
      const entry = data?.v == 1 ? parseOtpauth(data.uri) : null;
      return entry ? { entry, profileName: typeof data.profile == "string" ? data.profile : "" } : null;
    } catch {
      return null;
    }
  },

  /** Whether reading needs no primary password prompt. */
  readableQuietly() {
    try {
      return !lazy.LoginHelper.isPrimaryPasswordSet() || Services.logins.isLoggedIn;
    } catch {
      return false;
    }
  },

  async logins() {
    const all = await Services.logins.searchLoginsAsync({ origin: STORE_ORIGIN });
    return all.filter(login => login.origin == STORE_ORIGIN && this.parseRealm(login.httpRealm));
  },

  record(login) {
    const where = this.parseRealm(login.httpRealm);
    const unpacked = this.unpack(login.password);
    if (!where || !unpacked) {
      return null;
    }
    const meta = login.QueryInterface(Ci.nsILoginMetaInfo);
    return {
      guid: meta.guid,
      site: where.site,
      profileKey: where.profileKey,
      savedProfileName: unpacked.profileName,
      account: login.username,
      issuer: unpacked.entry.issuer,
      digits: unpacked.entry.digits,
      period: unpacked.entry.period,
      algorithm: unpacked.entry.algorithm,
      created: meta.timeCreated,
    };
  },

  async load() {
    if (this.cache) {
      return this.cache;
    }
    this.loading ??= (async () => {
      const records = (await this.logins()).map(login => this.record(login)).filter(Boolean);
      this.cache = records;
      return records;
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  },

  invalidate() {
    this.cache = null;
  },

  async secretEntry(guid) {
    const [login] = await Services.logins.searchLoginsAsync({ guid, origin: STORE_ORIGIN });
    if (!login || login.origin != STORE_ORIGIN) {
      return null;
    }
    return this.unpack(login.password)?.entry ?? null;
  },

  async find(site, profileKey, account) {
    const realm = this.realm(profileKey, site);
    const logins = await Services.logins.searchLoginsAsync({ origin: STORE_ORIGIN, httpRealm: realm });
    return logins.find(login => login.origin == STORE_ORIGIN && login.httpRealm == realm && login.username == account) ?? null;
  },

  newLogin(site, profileKey, account, password) {
    const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
    login.init(STORE_ORIGIN, null, this.realm(profileKey, site), account, password, "", "");
    return login;
  },

  async save({ site, profileKey, profileName, account, entry }) {
    const password = this.pack({ ...entry, account }, profileName);
    const existing = await this.find(site, profileKey, account);
    if (existing) {
      const update = Cc["@mozilla.org/hash-property-bag;1"].createInstance(Ci.nsIWritablePropertyBag);
      update.setProperty("password", password);
      update.setProperty("timeCreated", Date.now());
      await Services.logins.modifyLoginAsync(existing, update);
    } else {
      await Services.logins.addLoginAsync(this.newLogin(site, profileKey, account, password));
    }
    this.invalidate();
  },

  async remove(guid) {
    const [login] = await Services.logins.searchLoginsAsync({ guid, origin: STORE_ORIGIN });
    if (!login || login.origin != STORE_ORIGIN) {
      return null;
    }
    const removed = login.clone();
    await Services.logins.removeLoginAsync(login);
    this.invalidate();
    return removed;
  },

  async restore(login) {
    if (login?.origin != STORE_ORIGIN) {
      return;
    }
    const where = this.parseRealm(login.httpRealm);
    if (where && !(await this.find(where.site, where.profileKey, login.username))) {
      await Services.logins.addLoginAsync(login);
    }
    this.invalidate();
  },
};

// -- the feature -----------------------------------------------------------------

export const WhimsyTOTP = {
  // Tests set these.
  _now: () => Date.now(),
  _store: store,
  // Copy code asked for Touch ID this session (design: once per session).
  _unlocked: false,
  _inited: false,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  /** Once per session: keep codes out of Firefox's password lists. */
  init() {
    if (this._inited) {
      return;
    }
    this._inited = true;
    // about:logins, breach alerts, and every other "user-facing" list go
    // through LoginHelper.isUserFacingLogin, which already keeps Firefox
    // Accounts' own record out. Codes are kept out the same way (design:
    // no change to the saved-passwords page).
    const helper = lazy.LoginHelper;
    const original = helper.isUserFacingLogin;
    helper.isUserFacingLogin = function (login) {
      return login?.origin != STORE_ORIGIN && original.call(helper, login);
    };
    // Only changes that can touch a code: anything about our records, and
    // the store-wide ones (remove all, import, a sync).
    const ours = subject => {
      try {
        if (subject instanceof Ci.nsIArray) {
          return [...subject.enumerate(Ci.nsILoginInfo)].some(login => login.origin == STORE_ORIGIN);
        }
        return subject?.QueryInterface(Ci.nsILoginInfo).origin == STORE_ORIGIN;
      } catch {
        return true;
      }
    };
    const observer = (subject, topic, data) => {
      if (["addLogin", "modifyLogin", "removeLogin"].includes(data) && !ours(subject)) {
        return;
      }
      store.invalidate();
      Services.obs.notifyObservers(null, CHANGED_TOPIC);
    };
    Services.obs.addObserver(observer, "passwordmgr-storage-changed");
    Services.obs.addObserver(function onQuit() {
      Services.obs.removeObserver(observer, "passwordmgr-storage-changed");
      Services.obs.removeObserver(onQuit, "quit-application");
    }, "quit-application");
  },

  // -- profiles and sites ----------------------------------------------------

  profileKeyFor(userContextId) {
    return lazy.WhimsyProfiles.keyFor(userContextId);
  },

  profileName(record) {
    const id = lazy.WhimsyProfiles.idForKey(record.profileKey);
    if (id == null) {
      return record.savedProfileName || lazy.WhimsyProfiles.defaultName();
    }
    return lazy.WhimsyProfiles.nameOf(id);
  },

  /** The site of a top-level page, for matching codes: its host. */
  siteOf(uri) {
    if (!uri || !/^https?$/.test(uri.scheme)) {
      return null;
    }
    try {
      return normalizeSite(uri.host);
    } catch {
      return null;
    }
  },

  matches(record, site, profileKey) {
    return record.profileKey == profileKey && (record.site == site || baseDomain(record.site) == baseDomain(site));
  },

  // -- reading ------------------------------------------------------------------

  /** Every saved code, newest first, with its profile's name. No keys. */
  async list() {
    const records = await store.load();
    return records
      .map(record => ({ ...record, profileName: this.profileName(record) }))
      .sort((a, b) => b.created - a.created);
  },

  /**
   * Whether this site has codes in this profile, without ever asking for
   * the primary password (a page's field focus must not prompt).
   */
  async hasCodes(site, profileKey) {
    if (!this.enabled || !site || !store.readableQuietly()) {
      return false;
    }
    try {
      return (await store.load()).some(record => this.matches(record, site, profileKey));
    } catch (e) {
      console.error("Whimsy: verification codes", e?.name ?? "error");
      return false;
    }
  },

  /** The codes to offer on this site: [{guid, account, code, seconds}]. */
  async codesFor(site, profileKey) {
    const records = (await store.load()).filter(record => this.matches(record, site, profileKey));
    const now = this._now();
    const codes = [];
    for (const record of records) {
      const entry = await store.secretEntry(record.guid);
      if (entry) {
        codes.push({ guid: record.guid, account: record.account, ...(await fillCode(entry, now)) });
      }
    }
    return codes;
  },

  async codeFor(guid) {
    const entry = await store.secretEntry(guid);
    return entry ? fillCode(entry, this._now()) : null;
  },

  async remove(guid) {
    const removed = await store.remove(guid);
    Services.obs.notifyObservers(null, CHANGED_TOPIC);
    return removed;
  },

  async restore(removed) {
    await store.restore(removed);
    Services.obs.notifyObservers(null, CHANGED_TOPIC);
  },

  /**
   * Settings → Copy code: Touch ID once per session, then the code on the
   * clipboard (marked sensitive, so clipboard history skips it).
   */
  async copyCode(win, guid) {
    if (!this._unlocked) {
      const result = await lazy.WhimsyAuth.unlock(win, "whimsy-auth-reason-totp");
      if (result == "cancel") {
        return false;
      }
      // "unavailable": a Mac without a password prompt; the login store's
      // own encryption still holds.
      this._unlocked = true;
    }
    const now = await this.codeFor(guid);
    if (!now) {
      return false;
    }
    Cc["@mozilla.org/widget/clipboardhelper;1"]
      .getService(Ci.nsIClipboardHelper)
      .copyString(now.code, null, Ci.nsIClipboardHelper.Sensitive);
    win.gZenUIManager?.showToast("whimsy-totp-copied-toast", { l10nArgs: { seconds: now.seconds } });
    return true;
  },

  // -- the context menu item -------------------------------------------------------

  // The setup code the page side found under the last right-click, per
  // window: {browsingContext, uri}. Cleared when the menu closes.
  _qr: new WeakMap(),
  // What the shown item will add when chosen.
  _offered: new WeakMap(),

  initWindow(win) {
    const doc = win.document;
    const menu = doc.getElementById("contentAreaContextMenu");
    if (!menu || doc.getElementById(MENU_ID)) {
      return;
    }
    const item = doc.createXULElement("menuitem");
    item.id = MENU_ID;
    item.hidden = true;
    doc.l10n.setAttributes(item, "whimsy-totp-context-add");
    item.addEventListener("command", () => {
      // The menu may already be hidden (and the page's answer dropped) by
      // the time the command runs; the item keeps what it was shown for.
      const found = this._offered.get(win);
      this._offered.delete(win);
      if (found) {
        this.openAdd(win, { uri: found.uri, browsingContext: found.browsingContext })
          .catch(e => console.error("Whimsy: verification codes", e?.name ?? "error"));
      }
    });
    const anchor = doc.getElementById("context-sep-setbackground");
    anchor ? anchor.before(item) : menu.append(item);
    menu.addEventListener("popupshowing", event => {
      if (event.target == menu) {
        this._updateItem(win);
      }
    });
    menu.addEventListener("popuphidden", event => {
      if (event.target == menu) {
        this._qr.delete(win);
        item.hidden = true;
      }
    });
  },

  _updateItem(win) {
    const item = win.document.getElementById(MENU_ID);
    if (!item) {
      return;
    }
    const found = this._qr.get(win);
    const browser = win.gContextMenu?.browser ?? win.gBrowser?.selectedBrowser;
    item.hidden = !this.enabled || !found || !browser ||
      found.browsingContext?.top != browser.browsingContext ||
      browser.browsingContext?.usePrivateBrowsing;
    if (item.hidden) {
      this._offered.delete(win);
    } else {
      this._offered.set(win, found);
    }
  },

  /** From WhimsyTOTPParent: the page side read a setup code here. */
  onSetupCode(browsingContext, uri) {
    const win = browsingContext.topChromeWindow;
    if (!win || !this.enabled || browsingContext.usePrivateBrowsing || !parseOtpauth(uri)) {
      return;
    }
    this._qr.set(win, { browsingContext, uri });
    // The menu may already be open (its own message came first).
    const menu = win.document.getElementById("contentAreaContextMenu");
    if (menu?.state == "open" || menu?.state == "showing") {
      this._updateItem(win);
    }
  },

  // -- the add surface ---------------------------------------------------------------

  /** Where an add happens: the site, the profile, and its name. */
  _context(win, browsingContext) {
    const top = browsingContext?.top;
    const site = this.siteOf(top?.currentWindowGlobal?.documentURI ?? null);
    const userContextId = top?.originAttributes?.userContextId ?? lazy.WhimsyProfiles.activeProfileId(win);
    return {
      site,
      profileKey: this.profileKeyFor(userContextId),
      profileName: lazy.WhimsyProfiles.nameOf(userContextId),
    };
  },

  /** The open page in `win` that Add Code… starts from (Settings itself is skipped). */
  _lastWebBrowser(win) {
    const tabs = [...(win.gBrowser?.tabs ?? [])]
      .filter(tab => /^https?$/.test(tab.linkedBrowser?.currentURI?.scheme ?? ""))
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    return tabs[0]?.linkedBrowser ?? null;
  },

  /** The usernames saved for `site`, when they can be read without a prompt. */
  async _savedAccounts(site) {
    if (!store.readableQuietly()) {
      return [];
    }
    const names = new Set();
    const base = baseDomain(site);
    const origins = new Set([`https://${site}`, `https://${base}`, `https://www.${base}`]);
    for (const origin of origins) {
      try {
        for (const login of await Services.logins.searchLoginsAsync({ origin })) {
          if (login.username && !CONTROL.test(login.username)) {
            names.add(login.username);
          }
        }
      } catch (e) {
        console.error("Whimsy: verification codes", e?.name ?? "error");
      }
    }
    return [...names];
  },

  /**
   * Opens the add surface: from a setup QR code (`uri`), or with a field
   * for the setup key (Settings' Add Code…).
   */
  async openAdd(win, { uri = null, browsingContext = null } = {}) {
    const qr = uri ? parseOtpauth(uri) : null;
    if (uri && !qr) {
      return null;
    }
    const context = this._context(win, browsingContext ?? this._lastWebBrowser(win)?.browsingContext ?? null);
    if (qr && !context.site) {
      return null;
    }
    const saved = context.site ? await this._savedAccounts(context.site) : [];
    const state = {
      mode: qr ? "qr" : "key",
      site: context.site ?? "",
      profileKey: context.profileKey,
      profileName: context.profileName,
      entry: qr,
      account: qr?.account || saved[0] || "",
      accounts: qr ? [...new Set([qr.account, ...saved].filter(Boolean))] : [],
      saved: new Set(saved),
      exists: false,
      timer: null,
    };
    return this._renderAdd(win, state);
  },

  _renderAdd(win, state) {
    const S = lazy.WhimsySurface;
    const doc = win.document;
    const parts = S.create(win, {
      id: ADD_ID,
      width: 380,
      titleL10nId: "whimsy-totp-add-title",
      titleArgs: { site: state.site },
      footer: true,
      className: "whimsy-totp-add",
      onHidden: () => win.clearInterval(state.timer),
    });
    state.parts = parts;
    const body = doc.createXULElement("vbox");
    body.className = "whimsy-totp-body";
    parts.view.append(body);
    state.body = body;
    parts.panel.addEventListener("keydown", event => {
      if (event.key != "Enter" || event.defaultPrevented || event.target.localName == "button") {
        return;
      }
      const primary = parts.footer.querySelector("[default='true']:not([disabled])");
      if (primary) {
        event.preventDefault();
        event.stopPropagation();
        primary.doCommand();
      }
    });
    this._fillAdd(win, state);
    S.finish(parts);
    const tick = () => this._tick(state).catch(e => console.error("Whimsy: verification codes", e?.name ?? "error"));
    state.timer = win.setInterval(tick, 1000);
    tick();
    S.open(win, parts.panel, { at: "page-center" });
    return parts.panel;
  },

  _initial(doc, name) {
    const span = doc.createElementNS(HTML_NS, "span");
    span.className = "whimsy-surface-tile-text";
    span.textContent = (name || "?").trim().charAt(0).toUpperCase() || "?";
    return span;
  },

  _field(doc, { id, labelL10nId, labelArgs, value = "", placeholderL10nId = null, placeholderArgs = null, onInput }) {
    const form = doc.createElementNS(HTML_NS, "div");
    form.className = "whimsy-profile-name-form whimsy-totp-field";
    const label = doc.createElementNS(HTML_NS, "label");
    label.className = "whimsy-profile-name-label";
    label.htmlFor = id;
    doc.l10n.setAttributes(label, labelL10nId, labelArgs);
    const input = doc.createElementNS(HTML_NS, "input");
    input.id = id;
    input.className = "whimsy-profile-name-input";
    input.type = "text";
    input.value = value;
    input.maxLength = MAX_TEXT;
    input.setAttribute("autocomplete", "off");
    input.spellcheck = false;
    if (placeholderL10nId) {
      doc.l10n.setAttributes(input, placeholderL10nId, placeholderArgs);
    }
    input.addEventListener("input", () => onInput(input.value));
    form.append(label, input);
    return { form, input };
  },

  _fillAdd(win, state) {
    const S = lazy.WhimsySurface;
    const doc = win.document;
    const { panel, title, footer } = state.parts;
    const body = state.body;
    body.replaceChildren();
    footer.replaceChildren();
    state.codeRow = null;
    panel.dataset.state = state.exists ? "exists" : state.mode;

    if (state.exists) {
      doc.l10n.setAttributes(title, "whimsy-totp-exists-title", { account: state.account });
      const text = doc.createElementNS(HTML_NS, "p");
      text.className = "whimsy-totp-text";
      doc.l10n.setAttributes(text, "whimsy-totp-exists-text", { site: state.site });
      body.append(text);
      footer.append(
        S.footerButton(doc, { id: "whimsy-totp-cancel", l10nId: "whimsy-totp-cancel", onCommand: () => S.close(panel) }),
        S.footerButton(doc, {
          id: "whimsy-totp-replace",
          l10nId: "whimsy-totp-replace",
          primary: true,
          onCommand: () => this._save(win, state, { replace: true }),
        })
      );
      return;
    }

    doc.l10n.setAttributes(title, "whimsy-totp-add-title", { site: state.site });
    if (state.mode == "key") {
      const keyField = this._field(doc, {
        id: "whimsy-totp-key",
        labelL10nId: "whimsy-totp-key-label",
        placeholderL10nId: "whimsy-totp-key-placeholder",
        placeholderArgs: { site: state.site },
        value: state.keyText ?? "",
        onInput: value => {
          state.keyText = value;
          const secret = normalizeSecret(value);
          state.entry = secret ? { issuer: "", account: state.account, secret, algorithm: "SHA1", digits: 6, period: 30 } : null;
          error.hidden = true;
          keyField.input.removeAttribute("aria-invalid");
          this._tick(state).catch(() => {});
        },
      });
      const error = doc.createElementNS(HTML_NS, "p");
      error.id = "whimsy-totp-key-error";
      error.className = "whimsy-profile-name-error";
      error.hidden = true;
      error.setAttribute("role", "alert");
      doc.l10n.setAttributes(error, "whimsy-totp-key-error");
      keyField.input.setAttribute("aria-describedby", error.id);
      keyField.form.append(error);
      state.keyInput = keyField.input;
      state.keyError = error;
      const account = this._field(doc, {
        id: "whimsy-totp-account-input",
        labelL10nId: "whimsy-totp-account",
        value: state.account,
        onInput: value => (state.account = value),
      });
      const site = this._field(doc, {
        id: "whimsy-totp-site-input",
        labelL10nId: "whimsy-totp-site",
        value: state.site,
        onInput: value => {
          state.site = value.trim();
          doc.l10n.setAttributes(title, "whimsy-totp-add-title", { site: state.site });
          doc.l10n.setAttributes(keyField.input, "whimsy-totp-key-placeholder", { site: state.site });
        },
      });
      state.siteInput = site.input;
      body.append(keyField.form, account.form, site.form);
    } else {
      const { caption } = S.caption(doc, { l10nId: "whimsy-totp-account", id: "whimsy-totp-account-caption" });
      body.append(caption);
      if (state.accounts.length > 1) {
        const group = S.group(doc, { role: "radiogroup", label: "whimsy-totp-account-caption" });
        group.classList.add("whimsy-totp-accounts");
        for (const [index, name] of state.accounts.entries()) {
          const card = S.choice(doc, {
            value: `account-${index}`,
            icon: null,
            nameL10nId: null,
            detailL10nId: state.saved.has(name) ? "whimsy-totp-saved-login" : null,
            onPick: value => {
              state.account = name;
              S.check(group, value);
            },
          });
          card.dataset.account = name;
          card.querySelector(".whimsy-surface-tile").append(this._initial(doc, name));
          card.querySelector(".whimsy-surface-choice-name").textContent = name;
          group.append(card);
        }
        S.check(group, `account-${Math.max(0, state.accounts.indexOf(state.account))}`);
        body.append(group);
      } else {
        const group = S.group(doc);
        const { row } = S.row(doc, { text: state.account });
        row.classList.add("whimsy-totp-account");
        const avatar = S.tile(doc, { icon: null });
        avatar.append(this._initial(doc, state.account));
        row.prepend(avatar);
        group.append(row);
        body.append(group);
      }
    }

    // The code, live, to finish the site's own setup step: a key tile, the
    // code itself (a copy button, as in the mockup), and its countdown.
    const codeGroup = S.group(doc);
    const { caption: codeCaption } = S.caption(doc, { l10nId: "whimsy-totp-code", id: "whimsy-totp-code-caption" });
    const value = doc.createElementNS(HTML_NS, "span");
    value.className = "whimsy-surface-copy-value whimsy-totp-code-value";
    const copy = S.copyButton(doc, {
      value: () => state.code ?? "",
      content: [value],
      className: "whimsy-totp-code-copy",
    });
    const { row, label } = S.row(doc, {
      detailL10nId: "whimsy-totp-changes-in",
      detailArgs: { seconds: 30 },
      id: "whimsy-totp-code-row",
    });
    label.append(copy);
    row.prepend(S.tile(doc, { icon: KEY_ICON }));
    codeGroup.append(row);
    const codeBox = doc.createXULElement("vbox");
    codeBox.className = "whimsy-totp-code-box";
    codeBox.append(codeCaption, codeGroup);
    codeBox.hidden = !state.entry;
    state.codeRow = { group: codeBox, value, detail: row.querySelector(".whimsy-surface-row-detail"), copy };
    body.append(codeBox);

    const help = doc.createElementNS(HTML_NS, "p");
    help.className = "whimsy-totp-help";
    doc.l10n.setAttributes(help, "whimsy-totp-help", { profile: state.profileName });
    body.append(help);

    footer.append(
      S.footerButton(doc, { id: "whimsy-totp-cancel", l10nId: "whimsy-totp-cancel", onCommand: () => S.close(panel) }),
      S.footerButton(doc, {
        id: "whimsy-totp-save",
        l10nId: "whimsy-totp-save",
        primary: true,
        onCommand: () => this._save(win, state),
      })
    );
  },

  async _tick(state) {
    const row = state.codeRow;
    if (!row) {
      return;
    }
    row.group.hidden = !state.entry;
    if (!state.entry) {
      state.code = null;
      return;
    }
    const now = this._now();
    const code = await totp(state.entry, now);
    if (state.codeRow != row) {
      return;
    }
    state.code = code;
    if (!row.copy.hasAttribute("copied")) {
      row.value.textContent = groupCode(code);
    }
    row.copy.setAttribute("aria-label", code.split("").join(" "));
    const doc = row.detail.ownerDocument;
    doc.l10n.setAttributes(row.detail, "whimsy-totp-changes-in", { seconds: secondsLeft(state.entry, now) });
  },

  async _save(win, state, { replace = false } = {}) {
    if (state.saving) {
      return;
    }
    const site = normalizeSite(state.site);
    const account = cleanText(state.account ?? "");
    if (state.mode == "key" && !state.entry) {
      state.keyError.hidden = false;
      state.keyInput.setAttribute("aria-invalid", "true");
      state.keyInput.focus();
      return;
    }
    if (!site) {
      state.siteInput?.setAttribute("aria-invalid", "true");
      state.siteInput?.focus();
      return;
    }
    if (account == null) {
      return;
    }
    state.site = site;
    state.account = account;
    state.saving = true;
    try {
      if (!replace && (await store.find(site, state.profileKey, account))) {
        state.exists = true;
        this._fillAdd(win, state);
        return;
      }
      await store.save({ site, profileKey: state.profileKey, profileName: state.profileName, account, entry: state.entry });
      Services.obs.notifyObservers(null, CHANGED_TOPIC);
      lazy.WhimsySurface.close(state.parts.panel);
      win.gZenUIManager?.showToast("whimsy-totp-saved-toast", { l10nArgs: { site } });
    } catch (e) {
      // Cancelled primary password, or a store that can't be written.
      console.error("Whimsy: verification codes", e?.name ?? "error");
    } finally {
      state.saving = false;
    }
  },

  // -- the chooser (several accounts on a site) -----------------------------------

  /**
   * From WhimsyTOTPParent after a click on the field button: fills the one
   * code, or lets the person choose. `fill(code)` sends it to that field.
   */
  async pick(win, { site, profileKey, screenRect }, fill) {
    const codes = await this.codesFor(site, profileKey);
    if (!codes.length) {
      return;
    }
    if (codes.length == 1) {
      await fill(codes[0].code);
      return;
    }
    this._openChooser(win, codes, screenRect, fill);
  },

  _openChooser(win, codes, screenRect, fill) {
    const S = lazy.WhimsySurface;
    const doc = win.document;
    const parts = S.create(win, {
      id: CHOOSER_ID,
      width: 300,
      titleL10nId: "whimsy-totp-choose-title",
      className: "whimsy-totp-chooser",
      initialFocus: () => parts.view.querySelector("[role=radio][tabindex='0']"),
    });
    const group = S.group(doc, { role: "radiogroup", label: `${CHOOSER_ID}-title` });
    for (const [index, item] of codes.entries()) {
      const card = S.choice(doc, {
        value: `code-${index}`,
        icon: null,
        nameL10nId: null,
        detailL10nId: "whimsy-totp-choose-detail",
        detailArgs: { code: groupCode(item.code), seconds: item.seconds },
        onPick: () => {
          S.close(parts.panel);
          fill(item.code).catch(() => {});
        },
      });
      card.dataset.account = item.account;
      card.querySelector(".whimsy-surface-tile").append(this._initial(doc, item.account));
      card.querySelector(".whimsy-surface-choice-name").textContent = item.account;
      card.addEventListener("keydown", event => {
        if (event.key == "Enter" || event.key == " ") {
          event.preventDefault();
          card.click();
        }
      });
      group.append(card);
    }
    S.check(group, "code-0");
    parts.view.append(group);
    S.finish(parts);
    S.open(win, parts.panel, { screenRect, position: "after_start", gap: 4 });
    return parts.panel;
  },
};
