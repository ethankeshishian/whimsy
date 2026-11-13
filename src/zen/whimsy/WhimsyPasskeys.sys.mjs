/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W26 passkeys: Whimsy's own Touch ID passkeys, when Apple's passkey API
// isn't available to this build (design: whimsy-handoff/intake-w26/
// design-whimsy-touchid-passkeys.md). This is the front end behind
// WhimsyPasskeyService (passkeys/, the nsIWebAuthnService): the store, the
// routing, the WebAuthn bytes, the prompt, and the Secure Enclave helper.
//
// - Keys are P-256 keys made and held by this Mac's Secure Enclave through
//   the Swift helper (passkeys/helper/main.swift), used only after Touch ID
//   or the Mac password, and stored as SE-wrapped blobs that are bytes
//   anywhere else. They live on this Mac only: no sync, no export.
// - The store is one JSON file in the profile, encrypted as a whole with
//   OSKeyStore (the wrapper saved cards use), decrypted when a ceremony or
//   Settings needs it. Each record is tagged with its Whimsy profile, so a
//   profile never sees another's passkeys (as with passwords).
// - Sites see a plain platform passkey: ES256, discoverable, user-verified,
//   attestation "none", counter 0, transport internal, BE/BS 0.
// - Routing (design §5): a request for a security key, or one naming no
//   credential of ours, goes to authenticator-rs untouched, so YubiKeys
//   work exactly as before. 1Password's extension answers in the page
//   before any of this runs.
// - One prompt (WhimsySurface, centred like the private lock) for saving
//   and signing in; the macOS Touch ID sheet follows its primary button.
//
// Tests replace `_signer` with a WebCrypto stand-in, so the whole Gecko path
// runs with no hardware and no Touch ID sheet.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  JSONFile: "resource://gre/modules/JSONFile.sys.mjs",
  OSKeyStore: "resource://gre/modules/OSKeyStore.sys.mjs",
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["branding/brand.ftl", "browser/whimsy.ftl"], true));

const FEATURE_PREF = "whimsy.feature.passkeys";
const PRIVATE_CREATE_PREF = "whimsy.passkeys.private.create";
const FILE_NAME = "whimsy-passkeys.json";
const PROMPT_ID = "whimsy-passkeys-prompt";
const ES256 = -7;
const HTML_NS = "http://www.w3.org/1999/xhtml";
const KEY_ICON = "chrome://browser/skin/zen-icons/selectable/key.svg";
const WARNING_ICON = "chrome://global/skin/icons/warning.svg";

// One fixed AAGUID for every Whimsy install, so sites that label passkeys
// can say "Whimsy" (submitted to the community passkey-authenticator-aaguids
// list; whimsy-handoff/intake-w26/aaguid-submission.md). Never Apple's or
// Chrome's.
export const AAGUID_STRING = "6b0e4c7a-2f91-4d58-9b3c-71e2a5f0c8d4";
export const AAGUID = Uint8Array.from(AAGUID_STRING.replace(/-/g, "").match(/../g).map(h => parseInt(h, 16)));

// Prompt spam (design §7.3): after this many cancels from one origin inside
// the window, requests from it are refused without a prompt for the block.
const BACKOFF = { cancels: 3, windowMs: 60_000, blockMs: 60_000 };

// authenticatorData flags.
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

// -- bytes -----------------------------------------------------------------

function b64url(bytes) {
  return ChromeUtils.base64URLEncode(bytes, { pad: false });
}
function fromB64url(text) {
  return new Uint8Array(ChromeUtils.base64URLDecode(text, { padding: "ignore" }));
}
function b64(bytes) {
  let s = "";
  for (const b of bytes) {
    s += String.fromCharCode(b);
  }
  return btoa(s);
}
function fromB64(text) {
  return Uint8Array.from(atob(text), c => c.charCodeAt(0));
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
function sameBytes(a, b) {
  return a.length == b.length && a.every((v, i) => v == b[i]);
}
async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

// -- CBOR (the little WebAuthn needs: canonical, as CTAP2 writes it) ------

function cborHead(major, n) {
  const m = major << 5;
  if (n < 24) {
    return Uint8Array.of(m | n);
  }
  if (n < 0x100) {
    return Uint8Array.of(m | 24, n);
  }
  if (n < 0x10000) {
    return Uint8Array.of(m | 25, n >> 8, n & 0xff);
  }
  return Uint8Array.of(m | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
}
const cbor = {
  uint: n => cborHead(0, n),
  int: n => (n < 0 ? cborHead(1, -1 - n) : cborHead(0, n)),
  bytes: b => concat(cborHead(2, b.length), b),
  text(s) {
    const utf8 = new TextEncoder().encode(s);
    return concat(cborHead(3, utf8.length), utf8);
  },
  map: n => cborHead(5, n),
};

/** COSE_Key for a P-256 public key: {1: 2, 3: -7, -1: 1, -2: x, -3: y}. */
export function coseKey(x, y) {
  return concat(
    cbor.map(5),
    cbor.int(1), cbor.int(2),
    cbor.int(3), cbor.int(ES256),
    cbor.int(-1), cbor.int(1),
    cbor.int(-2), cbor.bytes(x),
    cbor.int(-3), cbor.bytes(y),
  );
}

/** {fmt: "none", attStmt: {}, authData}. */
export function attestationObject(authData) {
  return concat(
    cbor.map(3),
    cbor.text("fmt"), cbor.text("none"),
    cbor.text("attStmt"), cbor.map(0),
    cbor.text("authData"), cbor.bytes(authData),
  );
}

/** rpIdHash ‖ flags ‖ counter (always 0) ‖ [attested credential data]. */
export async function authenticatorData(rpId, { credentialId = null, x = null, y = null } = {}) {
  const rpIdHash = await sha256(rpId);
  const counter = new Uint8Array(4);
  if (!credentialId) {
    return concat(rpIdHash, Uint8Array.of(FLAG_UP | FLAG_UV), counter);
  }
  const length = Uint8Array.of(credentialId.length >> 8, credentialId.length & 0xff);
  return concat(rpIdHash, Uint8Array.of(FLAG_UP | FLAG_UV | FLAG_AT), counter, AAGUID, length, credentialId, coseKey(x, y));
}

// -- the helper --------------------------------------------------------------

export class PasskeyError extends Error {
  /** @param {"cancel"|"bad-blob"|"unavailable"|"failed"} code */
  constructor(code, detail = "") {
    super(`Whimsy passkeys: ${code}${detail ? `: ${detail}` : ""}`);
    this.code = code;
  }
}

/**
 * The real signer: one helper process per call, JSON in and out
 * (passkeys/helper/main.swift has the protocol). `available()` never shows
 * a sheet; `create()` and `sign()` each show one Touch ID sheet.
 */
class HelperSigner {
  get path() {
    try {
      const file = Services.dirsvc.get("GreBinD", Ci.nsIFile);
      for (const part of ["whimsy-passkeys.app", "Contents", "MacOS", "whimsy-passkeys"]) {
        file.append(part);
      }
      return file.exists() ? file.path : null;
    } catch {
      return null;
    }
  }

  async _call(request, signal = null) {
    const command = this.path;
    if (!command) {
      throw new PasskeyError("unavailable", "no helper");
    }
    const proc = await lazy.Subprocess.call({ command, arguments: [], stderr: "pipe" });
    const kill = () => proc.kill();
    signal?.addEventListener("abort", kill, { once: true });
    try {
      await proc.stdin.write(JSON.stringify(request));
      await proc.stdin.close();
      let text = "";
      for (let chunk; (chunk = await proc.stdout.readString()); ) {
        text += chunk;
      }
      await proc.wait();
      let reply = null;
      try {
        reply = JSON.parse(text.trim().split("\n").at(-1) || "null");
      } catch {}
      if (!reply || typeof reply != "object") {
        throw new PasskeyError(signal?.aborted ? "cancel" : "failed", "no reply");
      }
      if (!reply.ok) {
        throw new PasskeyError(reply.error || "failed", reply.detail || "");
      }
      return reply;
    } finally {
      signal?.removeEventListener("abort", kill);
    }
  }

  async available() {
    try {
      const reply = await this._call({ op: "available" });
      return { se: !!reply.se, biometry: !!reply.biometry, biometryType: reply.biometryType || "none" };
    } catch {
      return { se: false, biometry: false, biometryType: "none" };
    }
  }

  /** @returns {Promise<{blob: string, x: Uint8Array, y: Uint8Array}>} */
  async create({ reason, signal = null }) {
    const reply = await this._call({ op: "create", reason }, signal);
    return { blob: reply.blob, x: fromB64(reply.x), y: fromB64(reply.y) };
  }

  /** @returns {Promise<Uint8Array>} the DER ECDSA signature */
  async sign({ blob, message, reason, signal = null }) {
    const reply = await this._call({ op: "sign", blob, message: b64(message), reason }, signal);
    return fromB64(reply.der);
  }
}

// -- the module ----------------------------------------------------------------

export const WhimsyPasskeys = {
  // Tests replace this with a WebCrypto stand-in ({ available, create, sign }).
  _signer: null,
  _availability: null,
  _ready: null,
  _file: null,
  _initialized: false,
  // The transaction in flight: { tid, done, controller, prompt, callback }.
  _active: null,
  // origin → cancel timestamps (back-off).
  _cancels: new Map(),

  get signer() {
    return this._signer ?? (this._helper ??= new HelperSigner());
  },

  get enabled() {
    return AppConstants.platform == "macosx" && Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  /** isUVPAA: the feature is on and the Secure Enclave answered. */
  get available() {
    return this.enabled && !!this._availability?.se;
  },

  get biometry() {
    return this._availability ?? { se: false, biometry: false, biometryType: "none" };
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    if (!this.enabled) {
      return;
    }
    // Deleting a Whimsy profile deletes its passkeys (owner, 2026-11-12).
    lazy.WhimsyProfiles.onDelete?.((id, key) => this.removeProfile(key));
    this.probe().catch(() => {});
  },

  /** Asks the helper whether this Mac can hold passkeys; cached. */
  probe() {
    this._ready ??= (async () => {
      this._availability = this.enabled ? await this.signer.available() : { se: false, biometry: false, biometryType: "none" };
      return this._availability;
    })();
    return this._ready;
  },

  /** Forgets the cached answer (tests swap the signer). */
  resetAvailability() {
    this._ready = null;
    this._availability = null;
  },

  // -- the store -------------------------------------------------------------

  get file() {
    this._file ??= new lazy.JSONFile({ path: PathUtils.join(PathUtils.profileDir, FILE_NAME) });
    return this._file;
  },

  /** Every record, decrypted. */
  async load() {
    await this.file.load();
    const cipher = this.file.data.cipher;
    if (!cipher) {
      return [];
    }
    try {
      const records = JSON.parse(await lazy.OSKeyStore.decrypt(cipher, "whimsy-passkeys"));
      return Array.isArray(records) ? records : [];
    } catch (e) {
      // A failed decrypt (the keychain refused, or the secret changed with
      // a new signing identity, design §6.4): nothing to use, nothing lost.
      console.error("Whimsy passkeys: couldn't read the store", e);
      return [];
    }
  },

  async save(records) {
    await this.file.load();
    this.file.data.cipher = records.length ? await lazy.OSKeyStore.encrypt(JSON.stringify(records)) : "";
    this.file.data.count = records.length;
    this.file.saveSoon();
    Services.obs.notifyObservers(null, "whimsy-passkeys-changed");
  },

  profileKeyFor(userContextId) {
    return lazy.WhimsyProfiles.keyFor(userContextId);
  },

  profileNameOf(key) {
    const id = lazy.WhimsyProfiles.idForKey(key);
    return lazy.WhimsyProfiles.nameOf(id ?? 0);
  },

  /** This profile's passkeys for a site. */
  async recordsFor(rpId, profile) {
    return (await this.load()).filter(r => r.rpId == rpId && r.profile == profile);
  },

  /** For Settings: every record with its profile's name, newest first. */
  async list() {
    const records = await this.load();
    return records
      .map(r => ({ ...r, profileName: this.profileNameOf(r.profile) }))
      .sort((a, b) => (b.lastUsed || b.created) - (a.lastUsed || a.created));
  },

  /** Removes one record; returns it (for undo) or null. */
  async remove(id) {
    const records = await this.load();
    const at = records.findIndex(r => r.id == id);
    if (at < 0) {
      return null;
    }
    const [record] = records.splice(at, 1);
    await this.save(records);
    return record;
  },

  /** Puts a removed record back (undo). */
  async restore(record) {
    const records = await this.load();
    if (!records.some(r => r.id == record.id)) {
      records.push(record);
      await this.save(records);
    }
  },

  async countForProfile(key) {
    return (await this.load()).filter(r => r.profile == key).length;
  },

  async removeProfile(key) {
    const records = await this.load();
    const kept = records.filter(r => r.profile != key);
    if (kept.length != records.length) {
      await this.save(kept);
    }
  },

  // -- back-off ----------------------------------------------------------------

  _noteCancel(origin) {
    const now = Date.now();
    const times = (this._cancels.get(origin) || []).filter(t => now - t < BACKOFF.windowMs);
    times.push(now);
    this._cancels.set(origin, times);
  },

  _blocked(origin) {
    const now = Date.now();
    const times = (this._cancels.get(origin) || []).filter(t => now - t < BACKOFF.windowMs + BACKOFF.blockMs);
    this._cancels.set(origin, times);
    if (times.length < BACKOFF.cancels) {
      return false;
    }
    const third = times[times.length - BACKOFF.cancels];
    return now - third < BACKOFF.windowMs + BACKOFF.blockMs;
  },

  // -- the transactions ---------------------------------------------------------

  _start(tid, callback) {
    this._finish();
    const active = { tid, callback, done: false, controller: new AbortController(), prompt: null };
    this._active = active;
    return active;
  },

  /** Ends the active transaction without answering (cancel/reset). */
  _finish() {
    const active = this._active;
    if (!active) {
      return;
    }
    this._active = null;
    active.done = true;
    active.controller.abort();
    active.prompt?.close();
  },

  _answer(active, method, ...args) {
    if (active.done) {
      return;
    }
    active.done = true;
    active.controller.abort();
    if (this._active == active) {
      this._active = null;
    }
    active.prompt?.close();
    try {
      active.callback[method](...args);
    } catch (e) {
      console.error("Whimsy passkeys: callback", e);
    }
  },

  cancel(tid) {
    const active = this._active;
    if (active && (!tid || active.tid == tid)) {
      this._finish();
    }
  },

  windowFor(browsingContextId) {
    const bc = BrowsingContext.get(browsingContextId);
    const browser = bc?.top?.embedderElement;
    const win = browser?.documentGlobal;
    return win?.gBrowser ? win : null;
  },

  async makeCredential(tid, browsingContextId, json, callback) {
    const active = this._start(tid, callback);
    const req = JSON.parse(json);
    const answer = (method, ...args) => this._answer(active, method, ...args);
    try {
      await this.probe();
      if (active.done) {
        return;
      }
      if (!this.available || req.authenticatorAttachment == "cross-platform") {
        answer("onDelegate");
        return;
      }
      if (!Array.isArray(req.coseAlgs) || !req.coseAlgs.includes(ES256)) {
        answer("onError", Cr.NS_ERROR_DOM_NOT_SUPPORTED_ERR);
        return;
      }
      const win = this.windowFor(browsingContextId);
      if (!win) {
        answer("onDelegate");
        return;
      }
      const securityKey = !req.authenticatorAttachment;
      const profile = this.profileKeyFor(req.userContextId);
      const ctx = {
        origin: req.origin,
        site: req.rpId,
        profile: this.profileNameOf(profile),
        account: req.userDisplayName || req.userName,
        userName: req.userName,
        securityKey,
      };
      if (req.privateBrowsing && !Services.prefs.getBoolPref(PRIVATE_CREATE_PREF, false)) {
        const prompt = this._openPrompt(win, active, ctx);
        prompt.render("private");
        return;
      }
      if (this._blocked(req.origin)) {
        answer("onError", Cr.NS_ERROR_DOM_NOT_ALLOWED_ERR);
        return;
      }
      const records = await this.load();
      if (active.done) {
        return;
      }
      const existing = records.filter(r => r.rpId == req.rpId && r.profile == profile);
      const excluded = existing.find(r => (req.excludeList || []).includes(r.id));
      if (excluded) {
        // The spec wants consent before the site learns this (P8).
        const prompt = this._openPrompt(win, active, { ...ctx, account: excluded.displayName || excluded.userName });
        prompt.render("exists");
        return;
      }
      const prompt = this._openPrompt(win, active, ctx);
      prompt.onPrimary = async () => {
        prompt.render("waiting");
        try {
          const reason = lazy.l10n.formatValueSync("whimsy-passkeys-reason-create", { site: req.rpId });
          const { blob, x, y } = await this.signer.create({ reason, signal: active.controller.signal });
          if (active.done) {
            return;
          }
          const credentialId = new Uint8Array(32);
          crypto.getRandomValues(credentialId);
          const record = {
            id: b64url(credentialId),
            rpId: req.rpId,
            profile,
            userHandle: req.userId,
            userName: req.userName,
            displayName: req.userDisplayName,
            blob,
            x: b64url(x),
            y: b64url(y),
            created: Date.now(),
            lastUsed: 0,
          };
          // The same account on the same site in the same profile replaces
          // its old passkey (WebAuthn L3 §6.3.2 step 7).
          const kept = (await this.load()).filter(r => !(r.rpId == req.rpId && r.profile == profile && r.userHandle == req.userId));
          kept.push(record);
          await this.save(kept);
          const authData = await authenticatorData(req.rpId, { credentialId, x, y });
          answer("onRegister", Array.from(attestationObject(authData)), Array.from(credentialId));
        } catch (e) {
          this._failed(active, prompt, e);
        }
      };
      prompt.render(this.biometry.biometry ? "create" : "create-password");
    } catch (e) {
      console.error("Whimsy passkeys: create", e);
      answer("onError", Cr.NS_ERROR_DOM_NOT_ALLOWED_ERR);
    }
  },

  async getAssertion(tid, browsingContextId, json, callback) {
    const active = this._start(tid, callback);
    const req = JSON.parse(json);
    const answer = (method, ...args) => this._answer(active, method, ...args);
    try {
      await this.probe();
      if (active.done) {
        return;
      }
      if (!this.available) {
        answer("onDelegate");
        return;
      }
      const profile = this.profileKeyFor(req.userContextId);
      const records = await this.recordsFor(req.rpId, profile);
      if (active.done) {
        return;
      }
      const allowList = req.allowList || [];
      const matches = allowList.length ? records.filter(r => allowList.includes(r.id)) : records;
      if (!matches.length) {
        // The Apple Account and GitHub-with-YubiKey case: not ours at all.
        answer("onDelegate");
        return;
      }
      matches.sort((a, b) => (b.lastUsed || b.created) - (a.lastUsed || a.created));
      const clientDataHash = fromB64url(req.clientDataHash);
      const sign = async (record, prompt) => {
        try {
          const reason = lazy.l10n.formatValueSync("whimsy-passkeys-reason-sign", { site: req.rpId });
          const authData = await authenticatorData(req.rpId);
          const der = await this.signer.sign({
            blob: record.blob,
            message: concat(authData, clientDataHash),
            reason,
            signal: active.controller.signal,
          });
          if (active.done) {
            return;
          }
          if (!req.privateBrowsing) {
            const all = await this.load();
            const stored = all.find(r => r.id == record.id);
            if (stored) {
              stored.lastUsed = Date.now();
              await this.save(all);
            }
          }
          answer("onSign", Array.from(fromB64url(record.id)), Array.from(authData), Array.from(der), Array.from(fromB64url(record.userHandle)));
        } catch (e) {
          this._failed(active, prompt, e);
        }
      };
      // Picked from the login autocomplete list (conditional mediation):
      // the person chose this passkey already, so the Touch ID sheet
      // follows at once, as in Safari.
      if (req.conditionallyMediated && allowList.length == 1 && matches.length == 1) {
        await sign(matches[0], null);
        return;
      }
      const win = this.windowFor(browsingContextId);
      if (!win) {
        answer("onDelegate");
        return;
      }
      if (this._blocked(req.origin)) {
        answer("onError", Cr.NS_ERROR_DOM_NOT_ALLOWED_ERR);
        return;
      }
      const prompt = this._openPrompt(win, active, {
        origin: req.origin,
        site: req.rpId,
        profile: this.profileNameOf(profile),
        account: matches[0].displayName || matches[0].userName,
        userName: matches[0].userName,
        securityKey: true,
        choices: matches,
      });
      prompt.onPrimary = async () => {
        const record = matches.find(r => r.id == prompt.selected) ?? matches[0];
        prompt.render("waiting");
        await sign(record, prompt);
      };
      prompt.render(this.biometry.biometry ? "sign" : "sign-password");
    } catch (e) {
      console.error("Whimsy passkeys: sign", e);
      answer("onError", Cr.NS_ERROR_DOM_NOT_ALLOWED_ERR);
    }
  },

  /** A helper failure after the primary press: the prompt says what next. */
  _failed(active, prompt, error) {
    if (active.done) {
      return;
    }
    const code = error?.code || "failed";
    if (code != "cancel" && code != "bad-blob") {
      console.error("Whimsy passkeys: helper", error);
    }
    if (!prompt) {
      this._answer(active, "onError", Cr.NS_ERROR_DOM_NOT_ALLOWED_ERR);
      return;
    }
    prompt.render(code == "bad-blob" ? "error" : "cancelled");
  },

  // -- conditional mediation (autofill) -----------------------------------------

  async getAutoFillEntries(rpId, browsingContextId, allowList, callback) {
    try {
      await this.probe();
      if (!this.available || !browsingContextId) {
        callback.resolve([]);
        return;
      }
      const bc = BrowsingContext.get(browsingContextId);
      const userContextId = bc?.top?.originAttributes?.userContextId ?? 0;
      const profile = this.profileKeyFor(userContextId);
      let records = await this.recordsFor(rpId, profile);
      const allowed = (allowList || []).map(id => b64url(new Uint8Array(id)));
      if (allowed.length) {
        records = records.filter(r => allowed.includes(r.id));
      }
      records.sort((a, b) => (b.lastUsed || b.created) - (a.lastUsed || a.created));
      callback.resolve(records.map(r => ({
        QueryInterface: ChromeUtils.generateQI(["nsIWebAuthnAutoFillEntry"]),
        provider: Ci.nsIWebAuthnAutoFillEntry.PROVIDER_PLATFORM_MACOS,
        userName: r.userName || r.displayName || "",
        rpId,
        credentialId: Array.from(fromB64url(r.id)),
      })));
    } catch (e) {
      console.error("Whimsy passkeys: autofill", e);
      try {
        callback.reject(Cr.NS_ERROR_FAILURE);
      } catch {}
    }
  },

  // -- the prompt ----------------------------------------------------------------

  /**
   * One centred WhimsySurface for the whole ceremony, re-rendered per state
   * (design §8.2): create, create-password, sign, sign-password, waiting,
   * cancelled, error, exists, private. Esc and Cancel reject the site's
   * request; "Use a security key" hands it to authenticator-rs.
   */
  _openPrompt(win, active, ctx) {
    const S = lazy.WhimsySurface;
    const doc = win.document;
    const prompt = {
      state: null,
      selected: ctx.choices?.[0]?.id ?? null,
      onPrimary: null,
      parts: null,
      close() {
        if (this.parts) {
          const { panel } = this.parts;
          this.parts = null;
          S.close(panel);
        }
      },
      render: state => this._renderPrompt(win, active, ctx, prompt, state),
    };
    const parts = S.create(win, {
      id: PROMPT_ID,
      width: 380,
      footer: true,
      className: "whimsy-passkeys-prompt",
      closeOnOutsideClick: false,
      onEscape: () => {
        this._cancelFromPrompt(active, ctx);
        return true;
      },
      onHidden: () => {
        // Closed from outside (the window went away): the site's request
        // must not hang.
        if (!active.done) {
          this._answer(active, "onError", Cr.NS_ERROR_DOM_NOT_ALLOWED_ERR);
        }
      },
      initialFocus: () => parts.footer.querySelector("[default='true']") ?? parts.footer.querySelector("button"),
    });
    prompt.parts = parts;
    parts.panel.dataset.state = "";
    parts.view.setAttribute("tabindex", "-1");
    const body = doc.createXULElement("vbox");
    body.className = "whimsy-passkeys-body";
    parts.view.append(body);
    prompt.body = body;
    // Enter anywhere in the prompt runs the primary button, as a sheet does.
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
    S.finish(parts);
    active.prompt = prompt;
    S.open(win, parts.panel, { at: "page-center" });
    return prompt;
  },

  _cancelFromPrompt(active, ctx) {
    this._noteCancel(ctx.origin || ctx.site);
    this._answer(active, "onError", Cr.NS_ERROR_DOM_NOT_ALLOWED_ERR);
  },

  _renderPrompt(win, active, ctx, prompt, state) {
    const S = lazy.WhimsySurface;
    const doc = win.document;
    const parts = prompt.parts;
    if (!parts) {
      return;
    }
    const { panel, footer } = parts;
    const body = prompt.body;
    prompt.state = state;
    panel.dataset.state = state;
    const tone = state == "error" ? "destructive" : null;
    const title = state.startsWith("create") ? "create" : state.startsWith("sign") ? "sign" : state;
    const l10n = (el, id, args) => doc.l10n.setAttributes(el, id, args);
    const args = { site: ctx.site, profile: ctx.profile, account: ctx.account ?? "" };
    const noPrimary = state == "error" || state == "private" || state == "exists";
    // A re-render after a failure keeps the sign-in text and account; the
    // "cancelled" and "error" states add a line under it.
    const flow = ctx.choices ? "sign" : "create";
    const several = flow == "sign" && ctx.choices.length > 1;

    body.replaceChildren();
    const head = doc.createXULElement("hbox");
    head.className = "whimsy-passkeys-head";
    head.setAttribute("align", "start");
    const tile = S.tile(doc, { icon: KEY_ICON, tone });
    const text = doc.createXULElement("vbox");
    text.setAttribute("flex", "1");
    const heading = doc.createElementNS(HTML_NS, "h1");
    heading.className = "whimsy-surface-title";
    heading.id = `${PROMPT_ID}-title`;
    const line = doc.createElementNS(HTML_NS, "p");
    line.className = "whimsy-passkeys-text";
    switch (state == "waiting" || state == "cancelled" ? (prompt.lastShown ?? title) : title) {
      case "create":
        l10n(heading, "whimsy-passkeys-create-title", args);
        l10n(line, "whimsy-passkeys-create-text", args);
        break;
      case "sign":
        l10n(heading, "whimsy-passkeys-signin-title", args);
        if (several) {
          l10n(line, "whimsy-passkeys-choose", args);
        } else {
          l10n(line, "whimsy-passkeys-signin-text", args);
        }
        break;
      case "error":
        l10n(heading, "whimsy-passkeys-error-title", args);
        l10n(line, "whimsy-passkeys-error-text", args);
        break;
      case "exists":
        l10n(heading, "whimsy-passkeys-exists-title", args);
        l10n(line, "whimsy-passkeys-exists-text", args);
        break;
      case "private":
        l10n(heading, "whimsy-passkeys-private-title", args);
        l10n(line, "whimsy-passkeys-private-text", args);
        break;
    }
    if (state != "waiting" && state != "cancelled") {
      prompt.lastShown = title;
    }
    text.append(heading);
    // The amber line (P5) and the quiet status line (P6) sit under the
    // title, before the body text, as the private lock shows its own.
    if (state.endsWith("-password")) {
      const warn = doc.createXULElement("hbox");
      warn.className = "whimsy-call-options-fallback whimsy-passkeys-fallback";
      warn.setAttribute("align", "start");
      const icon = doc.createXULElement("image");
      icon.setAttribute("src", WARNING_ICON);
      const warnText = doc.createElementNS(HTML_NS, "span");
      l10n(warnText, this.biometry.biometryType == "none" ? "whimsy-passkeys-no-touch-id" : "whimsy-passkeys-lid-closed");
      warn.append(icon, warnText);
      text.append(warn);
    } else if (state == "cancelled") {
      const status = doc.createElementNS(HTML_NS, "p");
      status.className = "whimsy-passkeys-status";
      status.setAttribute("role", "alert");
      l10n(status, "whimsy-passkeys-cancelled");
      text.append(status);
    } else if (state == "error") {
      const status = doc.createElementNS(HTML_NS, "p");
      status.className = "whimsy-passkeys-status whimsy-passkeys-status-error";
      status.setAttribute("role", "alert");
      l10n(status, "whimsy-passkeys-error-line");
      text.append(status);
    }
    text.append(line);
    head.append(tile, text);
    body.append(head);
    panel.setAttribute("aria-labelledby", heading.id);

    // The account: one row, or radio cards to choose among (P4).
    if (state != "private") {
      if (several && state != "error") {
        const group = S.group(doc, { role: "radiogroup" });
        group.classList.add("whimsy-passkeys-choices");
        group.setAttribute("aria-label", lazy.l10n.formatValueSync("whimsy-passkeys-choose"));
        for (const record of ctx.choices) {
          const card = S.choice(doc, {
            value: record.id,
            icon: null,
            nameL10nId: null,
            detailL10nId: null,
            onPick: value => {
              prompt.selected = value;
              S.check(group, value);
            },
          });
          card.querySelector(".whimsy-surface-tile").append(this._initial(doc, record.displayName || record.userName));
          card.querySelector(".whimsy-surface-choice-name").textContent = record.displayName || record.userName;
          card.querySelector(".whimsy-surface-choice-detail").textContent = record.userName;
          group.append(card);
        }
        S.check(group, prompt.selected);
        body.append(group);
      } else {
        const group = S.group(doc);
        const { row } = S.row(doc, { text: ctx.account ?? "", detail: ctx.userName || null });
        row.classList.add("whimsy-passkeys-account");
        const avatar = S.tile(doc, { icon: null });
        avatar.append(this._initial(doc, ctx.account ?? ""));
        row.prepend(avatar);
        group.append(row);
        body.append(group);
      }
    }

    // Footer: Use a security key (quiet, start), Cancel, the primary.
    footer.replaceChildren();
    const cancelId = "whimsy-passkeys-cancel";
    if (state == "exists") {
      footer.append(S.footerButton(doc, {
        id: "whimsy-passkeys-ok",
        l10nId: "whimsy-passkeys-ok",
        primary: true,
        onCommand: () => this._answer(active, "onError", Cr.NS_ERROR_DOM_INVALID_STATE_ERR),
      }));
    } else {
      if (ctx.securityKey) {
        const key = S.textButton(doc, {
          id: "whimsy-passkeys-security-key",
          l10nId: "whimsy-passkeys-security-key",
          ghost: true,
          onCommand: () => this._answer(active, "onDelegate"),
        });
        key.disabled = state == "waiting";
        const spacer = doc.createXULElement("spacer");
        spacer.setAttribute("flex", "1");
        footer.append(key, spacer);
      }
      footer.append(S.footerButton(doc, {
        id: cancelId,
        l10nId: "whimsy-passkeys-cancel",
        onCommand: () => this._cancelFromPrompt(active, ctx),
      }));
      if (!noPrimary) {
        const primaryId = state == "cancelled" ? "whimsy-passkeys-retry"
          : state.endsWith("-password") ? "whimsy-passkeys-password"
          : flow == "create" ? "whimsy-passkeys-save"
          : "whimsy-passkeys-continue";
        const primary = S.footerButton(doc, {
          id: "whimsy-passkeys-primary",
          l10nId: state == "waiting" ? (prompt.lastPrimary ?? primaryId) : primaryId,
          primary: true,
          onCommand: () => {
            if (prompt.state == "waiting") {
              return;
            }
            prompt.onPrimary?.();
          },
        });
        if (state != "waiting") {
          prompt.lastPrimary = primaryId;
        }
        primary.disabled = state == "waiting";
        footer.append(primary);
      }
    }
    if (panel.state == "open") {
      const focus = footer.querySelector("[default='true']:not([disabled])") ?? footer.querySelector("button:not([disabled])");
      focus?.focus({ focusVisible: false });
    }
  },

  _initial(doc, name) {
    const span = doc.createElementNS(HTML_NS, "span");
    span.className = "whimsy-surface-tile-text";
    span.textContent = (name || "?").trim().charAt(0).toUpperCase() || "?";
    return span;
  },
};

// The XPCOM face of the module (@whimsy/passkeys;1), what
// WhimsyPasskeyService calls. Every call answers exactly once, through the
// callback, or hands the request back to authenticator-rs.
export class WhimsyPasskeysService {
  QueryInterface = ChromeUtils.generateQI(["nsIWhimsyPasskeys"]);

  get available() {
    return WhimsyPasskeys.available;
  }

  makeCredential(tid, browsingContextId, request, callback) {
    WhimsyPasskeys.makeCredential(tid, browsingContextId, request, callback).catch(e => {
      console.error("Whimsy passkeys: makeCredential", e);
    });
  }

  getAssertion(tid, browsingContextId, request, callback) {
    WhimsyPasskeys.getAssertion(tid, browsingContextId, request, callback).catch(e => {
      console.error("Whimsy passkeys: getAssertion", e);
    });
  }

  cancel(tid) {
    WhimsyPasskeys.cancel(tid);
  }

  getAutoFillEntries(rpId, browsingContextId, allowList, callback) {
    WhimsyPasskeys.getAutoFillEntries(rpId, browsingContextId, allowList, callback).catch(e => {
      console.error("Whimsy passkeys: getAutoFillEntries", e);
    });
  }
}
