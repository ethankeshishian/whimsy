/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Form protection (W9-03, W10-25, F08, F29, F33; rewritten for W13-R1).
// The design, every path a tab can go away by and how each one waits for
// the person's answer, is whimsy-handoff/wave13/r1-forms-design.md.
//
// - Unsaved input: the content actor (WhimsyFormProtectionChild) reports
//   one boolean per document: the person typed or picked something
//   themselves that the site hasn't saved yet. Parent side, the state is
//   per window global and only the current one of each frame counts.
//   A same-site fetch/XHR/beacon with a body from the tab after the edit
//   is the site saving: the observer below tells the document.
// - A tab with unsaved input: whimsy-form-typed (the marker),
//   whimsy-form-protected (also set by Protect This Tab; the auto-archive
//   sweep skips it), and tab.undiscardable (Firefox's TabUnloader skips it).
// - Asking: unloading (gBrowser.explicitUnloadTabs) and Zen's pinned and
//   Essential ⌘W/middle-click (onCloseTabShortcut) await "Unload this
//   tab?" before anything changes; Cancel abandons the whole action. A page
//   with its own beforeunload decides for itself (Firefox's prompt, once).
// - Refill: a snapshot taken as a page with unsaved input goes away is
//   offered back on the next load of that address ("Fill in 3 answers you
//   typed before?"). Passwords and card numbers are never kept.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AsyncShutdown: "resource://gre/modules/AsyncShutdown.sys.mjs",
  OSKeyStore: "resource://gre/modules/OSKeyStore.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  TabStateCache: "moz-src:///browser/components/sessionstore/TabStateCache.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));

const FEATURE_PREF = "whimsy.feature.form-protection";
const COMMAND_ID = "cmd_whimsyProtectForm";
const ATTR = "whimsy-form-protected";
// The person has unsaved input here (the marker shows only then).
const TYPED_ATTR = "whimsy-form-typed";
const MARKER_CLASS = "whimsy-tab-form-marker";
const MARKER_ICON = "chrome://browser/content/whimsy/whimsy-form-badge.svg";
// Protected by hand (Protect This Tab) with nothing typed: a lock in the
// same place. Typing takes precedence.
const MANUAL_ATTR = "whimsy-form-manual";
const LOCK_ICON = "chrome://browser/skin/zen-icons/selectable/lock-closed.svg";
// F29, the user's pick B: a small pencil with no backing.
const PENCIL_ICON = "chrome://browser/content/whimsy/whimsy-form-pencil.svg";
const SNAPSHOT_KEY = "whimsy-formdata";
const SNAPSHOT_MAX_BYTES = 64 * 1024;
const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const REFILL_OFFER_MS = 10000;
const TOAST_TIMEOUT_MS = 4000;
const UNLOAD_PANEL_ID = "whimsy-form-unload";
const HTML_NS = "http://www.w3.org/1999/xhtml";
// How long the fresh check before a dialog waits for a busy page.
const ASK_PAGE_MS = 500;
// Requests that carry a page's own save.
const SAVE_METHODS_SKIPPED = new Set(["GET", "HEAD", "OPTIONS"]);

// innerWindowId -> browsingContext, for documents that reported unsaved
// input. Only dirty documents are kept; a document counts only while it is
// the current one of its frame.
const dirtyDocuments = new Map();
// browser -> { url, data, time }: the last snapshot (memory).
const snapshots = new WeakMap();
// F08: browsers unloaded "without saving": the answers the page leaves as it
// unloads are dropped, until it's loaded again.
const discarding = new WeakSet();
// tab -> "save" | "discard": answered already (pinned ⌘W asks before Zen
// acts; Zen's unload then mustn't ask again).
const answered = new WeakMap();

// A page's form snapshot is page data: only plain records of strings,
// booleans and select values, within the size cap.
function cleanSnapshot(data) {
  if (!data || typeof data != "object") {
    return null;
  }
  const clean = {};
  for (const key of ["id", "xpath"]) {
    const record = data[key];
    if (!record || typeof record != "object") {
      continue;
    }
    clean[key] = {};
    for (const [name, value] of Object.entries(record)) {
      // "__proto__" would set the record's prototype, not add a field.
      if (typeof name != "string" || name.length > 500 || name == "__proto__") {
        continue;
      }
      if (typeof value == "string" || typeof value == "boolean") {
        clean[key][name] = value;
      } else if (value && typeof value == "object" && typeof value.value == "string") {
        clean[key][name] = { selectedIndex: Number(value.selectedIndex) || 0, value: value.value };
      }
    }
  }
  const json = JSON.stringify(clean);
  const fields = Object.values(clean).reduce((n, record) => n + Object.keys(record).length, 0);
  return json.length <= SNAPSHOT_MAX_BYTES && fields ? clean : null;
}

function sameAddress(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    x.hash = "";
    y.hash = "";
    return x.href == y.href;
  } catch (e) {
    return false;
  }
}

// ---- R1 v2: the draft store (wave13/r1-v2-design.md §4, §6, §9) ----
//
// One draft per address (the URL without its fragment; the URL parser
// lower-cases scheme and host and drops a default port) and container. Normal
// drafts live in memory and on disk as ONE OSKeyStore ciphertext (so not even
// the addresses are readable); private drafts live in memory only. Values are
// never logged.
const SAVE_PREF = "whimsy.forms.saveDrafts";
const DRAFTS_FILE = "whimsy-form-drafts.json";
const DRAFTS_WRITE_MS = 1000;

function draftKey(url) {
  try {
    const u = new URL(url);
    if (u.protocol != "https:" && u.protocol != "http:") {
      return null;
    }
    u.hash = "";
    return u.href;
  } catch (e) {
    return null;
  }
}

function draftId(key, userContextId) {
  return `${Number(userContextId) || 0}|${key}`;
}

function draftFresh(time) {
  return Date.now() - time <= SNAPSHOT_MAX_AGE_MS;
}

function draftOnHost(record, host) {
  try {
    const h = new URL(record.key).hostname;
    return h == host || h.endsWith("." + host);
  } catch (e) {
    return false;
  }
}

export const WhimsyFormDrafts = {
  _records: null,
  _loading: null,
  _private: new Map(),
  _dirty: false,
  _timer: null,
  _writing: null,
  _initialized: false,

  get path() {
    return PathUtils.join(PathUtils.profileDir, DRAFTS_FILE);
  },

  get saving() {
    return Services.prefs.getBoolPref(SAVE_PREF, true);
  },

  _init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    Services.prefs.addObserver(SAVE_PREF, this);
    Services.obs.addObserver(this, "last-pb-context-exited");
    lazy.AsyncShutdown.profileBeforeChange.addBlocker("WhimsyFormDrafts: write the drafts", () => this.flush());
  },

  observe(subject, topic) {
    if (topic == "last-pb-context-exited") {
      this._private.clear();
    } else if (topic == "nsPref:changed" && !this.saving) {
      this.forgetAll();
    }
  },

  async _load() {
    if (this._records) {
      return this._records;
    }
    this._loading ??= (async () => {
      const records = new Map();
      let text = null;
      try {
        text = await IOUtils.readUTF8(this.path);
      } catch (e) {
        // No file yet.
      }
      if (text != null) {
        try {
          const list = JSON.parse(await lazy.OSKeyStore.decrypt(JSON.parse(text).blob));
          for (const r of Array.isArray(list) ? list : []) {
            const key = draftKey(r?.key);
            const data = cleanSnapshot(r?.data);
            const time = Number(r?.time) || 0;
            const userContextId = Number(r?.userContextId) || 0;
            if (key && data && draftFresh(time)) {
              records.set(draftId(key, userContextId), { key, data, time, userContextId });
            }
          }
        } catch (e) {
          // The Keychain item was reset or the profile came from another
          // Mac: losing the drafts is the safe outcome.
          await IOUtils.remove(this.path, { ignoreAbsent: true }).catch(() => {});
        }
      }
      if (!this._records) {
        this._records = records;
      }
      this._loading = null;
      return this._records;
    })();
    return this._loading;
  },

  async put({ url, data, userContextId = 0, isPrivate = false, time = Date.now() }) {
    this._init();
    const key = draftKey(url);
    const clean = cleanSnapshot(data);
    if (!this.saving || !key || !clean || !draftFresh(time)) {
      return false;
    }
    const record = { key, data: clean, time, userContextId: Number(userContextId) || 0 };
    if (isPrivate) {
      this._private.set(draftId(key, userContextId), record);
      return true;
    }
    (await this._load()).set(draftId(key, userContextId), record);
    this._scheduleWrite();
    return true;
  },

  async get({ url, userContextId = 0, isPrivate = false }) {
    this._init();
    const key = draftKey(url);
    if (!key) {
      return null;
    }
    const map = isPrivate ? this._private : await this._load();
    const id = draftId(key, userContextId);
    const record = map.get(id);
    if (!record) {
      return null;
    }
    if (!draftFresh(record.time)) {
      map.delete(id);
      if (!isPrivate) {
        this._scheduleWrite();
      }
      return null;
    }
    return { data: structuredClone(record.data), time: record.time };
  },

  async delete({ url, userContextId = 0, isPrivate = false }) {
    const key = draftKey(url);
    if (!key) {
      return;
    }
    if (isPrivate) {
      this._private.delete(draftId(key, userContextId));
    } else if ((await this._load()).delete(draftId(key, userContextId))) {
      this._scheduleWrite();
    }
  },

  // Fire on a site: the site and its subdomains, private ones too.
  async forgetSite(host) {
    host = String(host ?? "").toLowerCase();
    if (!host) {
      return;
    }
    for (const [id, record] of this._private) {
      if (draftOnHost(record, host)) {
        this._private.delete(id);
      }
    }
    const records = await this._load();
    for (const [id, record] of records) {
      if (draftOnHost(record, host)) {
        records.delete(id);
        this._scheduleWrite();
      }
    }
  },

  // Fire everywhere, or the setting turned off: memory and the file.
  async forgetAll() {
    this._private.clear();
    this._records = new Map();
    this._loading = null;
    this._dirty = false;
    lazy.clearTimeout(this._timer);
    this._timer = null;
    await this._writing;
    await IOUtils.remove(this.path, { ignoreAbsent: true });
  },

  _scheduleWrite() {
    this._dirty = true;
    lazy.clearTimeout(this._timer);
    this._timer = lazy.setTimeout(() => this.flush(), DRAFTS_WRITE_MS);
  },

  async flush() {
    lazy.clearTimeout(this._timer);
    this._timer = null;
    await this._writing;
    if (!this._dirty || !this._records) {
      return;
    }
    this._dirty = false;
    this._writing = this._write([...this._records.values()].filter(r => draftFresh(r.time)));
    await this._writing;
    this._writing = null;
  },

  async _write(list) {
    let blob;
    try {
      await lazy.OSKeyStore.ensureLoggedIn(false);
      blob = await lazy.OSKeyStore.encrypt(JSON.stringify(list));
    } catch (e) {
      // No key store: drafts stay in memory for this session, never on
      // disk in the clear.
      return;
    }
    try {
      await IOUtils.writeUTF8(this.path, JSON.stringify({ version: 1, blob }), { tmpPath: this.path + ".tmp" });
    } catch (e) {
      // Disk full or similar: keep it in memory, the next write retries.
      this._dirty = true;
    }
  },

  async _dropMemoryForTests() {
    await this.flush();
    this._records = null;
    this._loading = null;
    this._private.clear();
  },

  async _resetForTests() {
    await this.flush();
    this._records = new Map();
    this._loading = null;
    this._private.clear();
    this._dirty = false;
    await IOUtils.remove(this.path, { ignoreAbsent: true });
  },
};

function tabFor(browser) {
  return browser?.documentGlobal?.gBrowser?.getTabForBrowser(browser) ?? null;
}

function isCurrent(innerWindowId, bc) {
  try {
    return !bc.isDiscarded && bc.currentWindowGlobal?.innerWindowId == innerWindowId;
  } catch (e) {
    return false;
  }
}

// The open "Unload this tab?" ask per window (one at a time).
const askingWindows = new WeakMap();

// The site saved (W13-R1 design §2): after the edit, a fetch/XHR/beacon
// with a body to the dirty document's own site, made by that document's tab
// or by a service worker of its site. One rule for every site, no list.
// Observed at http-on-modify-request, which nsHttpChannel notifies in
// ContinuePrepareToConnect, before ContinueOnBeforeConnect hands a request
// to a service worker, so pages a worker controls are seen the same way.
// (WebSocket saves are seen by the content side:
// WhimsyFormProtectionChild._watchSocketSaves.)
const networkSaveObserver = {
  observe(subject) {
    if (!dirtyDocuments.size) {
      return;
    }
    let channel;
    try {
      channel = subject.QueryInterface(Ci.nsIHttpChannel);
    } catch (e) {
      return;
    }
    if (SAVE_METHODS_SKIPPED.has(channel.requestMethod)) {
      return;
    }
    const loadInfo = channel.loadInfo;
    const type = loadInfo?.externalContentPolicyType;
    if (
      type != Ci.nsIContentPolicy.TYPE_XMLHTTPREQUEST &&
      type != Ci.nsIContentPolicy.TYPE_FETCH &&
      type != Ci.nsIContentPolicy.TYPE_BEACON
    ) {
      return;
    }
    // A document's request carries its browsing context; a service
    // worker's has none (it can't be tied to one document, so it counts
    // for every dirty document of its site).
    // (A dedicated worker's requests carry its document's browsing context;
    // only shared and service workers have none, nsILoadInfo.idl.)
    const topId = loadInfo.browsingContextID ? BrowsingContext.get(loadInfo.browsingContextID)?.top?.id : null;
    const fromWorker = !loadInfo.browsingContextID && !!loadInfo.triggeringPrincipal?.isContentPrincipal;
    if (!topId && !fromWorker) {
      return;
    }
    for (const [innerWindowId, bc] of dirtyDocuments) {
      if (bc.isDiscarded) {
        dirtyDocuments.delete(innerWindowId);
        continue;
      }
      if ((topId && bc.top?.id != topId) || !isCurrent(innerWindowId, bc)) {
        continue;
      }
      try {
        const global = bc.currentWindowGlobal;
        // The site's own request, to its own site (not a third-party
        // frame, tracker or worker posting somewhere).
        if (
          global.documentPrincipal.isThirdPartyURI(channel.URI) ||
          !global.documentURI ||
          loadInfo.triggeringPrincipal?.isThirdPartyURI(global.documentURI) !== false
        ) {
          continue;
        }
        global.getExistingActor("WhimsyFormProtection")?.sendAsyncMessage("Whimsy:FormSaved", {});
      } catch (e) {
        // The document is going away.
      }
    }
  },
};

export class WhimsyFormProtectionParent extends JSWindowActorParent {
  receiveMessage(message) {
    const browser = this.browsingContext?.top?.embedderElement;
    switch (message.name) {
      case "Whimsy:FormState": {
        this._innerWindowId = this.manager.innerWindowId;
        this._browser = browser;
        if (message.data?.dirty && WhimsyFormProtection.enabled) {
          dirtyDocuments.set(this._innerWindowId, this.browsingContext);
        } else {
          dirtyDocuments.delete(this._innerWindowId);
        }
        // A saved page leaves nothing to offer back next time.
        if (message.data?.saved && browser && this.browsingContext == this.browsingContext.top) {
          WhimsyFormProtection.clearSnapshot(browser);
        }
        WhimsyFormProtection.refreshBrowser(browser);
        return null;
      }
      case "Whimsy:FormSnapshot":
        if (browser && this.browsingContext == this.browsingContext.top) {
          WhimsyFormProtection.storeSnapshot(browser, message.data?.url, message.data?.data);
        }
        return null;
      case "Whimsy:FormSnapshotFor": {
        if (!browser || this.browsingContext != this.browsingContext.top) {
          return null;
        }
        const snapshot = WhimsyFormProtection.snapshotFor(browser, message.data?.url);
        return snapshot ? { data: snapshot.data } : null;
      }
      case "Whimsy:FormRefillReady":
        if (browser) {
          WhimsyFormProtection.offerRefill(browser, this, Math.max(0, Math.round(Number(message.data?.count) || 0)));
        }
        return null;
    }
    return null;
  }

  didDestroy() {
    if (this._innerWindowId && dirtyDocuments.delete(this._innerWindowId)) {
      WhimsyFormProtection.refreshBrowser(this._browser);
    }
  }
}

export const WhimsyFormProtection = {
  COMMAND_ID,
  ATTR,
  _initialized: false,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    ChromeUtils.registerWindowActor("WhimsyFormProtection", {
      parent: { esModuleURI: "resource:///modules/whimsy/WhimsyFormProtection.sys.mjs" },
      child: {
        esModuleURI: "resource:///modules/whimsy/WhimsyFormProtectionChild.sys.mjs",
        events: {
          beforeinput: { mozSystemGroup: true, capture: true },
          input: { mozSystemGroup: true, capture: true },
          change: { mozSystemGroup: true, capture: true },
          submit: { mozSystemGroup: true },
          pageshow: { mozSystemGroup: true },
          // W10-25: a snapshot of typed answers as the page goes away.
          pagehide: { mozSystemGroup: true },
        },
      },
      matches: ["https://*/*", "http://*/*"],
      allFrames: true,
      messageManagerGroups: ["browsers"],
      safeForUntrustedWebProcess: true,
    });
    Services.obs.addObserver(networkSaveObserver, "http-on-modify-request");
  },

  canProtect(win) {
    return this.enabled && !!win.gBrowser?.selectedBrowser?.currentURI?.spec?.startsWith("http");
  },

  // ---- state ----

  /** Last reported: does any current document in the tab have unsaved input? */
  hasUnsavedInput(tab) {
    const browser = tab?.linkedBrowser;
    if (!this.enabled || !browser || !dirtyDocuments.size) {
      return false;
    }
    for (const [innerWindowId, bc] of dirtyDocuments) {
      if (bc.top?.embedderElement == browser && isCurrent(innerWindowId, bc)) {
        return true;
      }
    }
    return false;
  },

  /**
   * Asks the pages again (a report can be a moment old, or a field may have
   * left the page). A page that doesn't answer in time keeps its last report.
   */
  async checkUnsavedInput(tab) {
    if (!this.hasUnsavedInput(tab)) {
      return false;
    }
    const browser = tab.linkedBrowser;
    const asks = [];
    for (const [innerWindowId, bc] of dirtyDocuments) {
      if (bc.top?.embedderElement != browser || !isCurrent(innerWindowId, bc)) {
        continue;
      }
      const actor = bc.currentWindowGlobal.getExistingActor("WhimsyFormProtection");
      if (!actor) {
        continue;
      }
      asks.push(
        Promise.race([
          actor.sendQuery("Whimsy:FormIsDirty").catch(() => false),
          new Promise(resolve => lazy.setTimeout(() => resolve(true), ASK_PAGE_MS)),
        ])
      );
    }
    const answers = await Promise.all(asks);
    return answers.some(Boolean);
  },

  /** Whether unloading `tab` should ask first (W13-R1 design §3, §4). */
  async needsAsk(tab) {
    if (!this.enabled || !tab?.linkedPanel || tab.hasAttribute("pending") || answered.has(tab)) {
      return false;
    }
    let ownGuard = false;
    try {
      ownGuard = !!tab.linkedBrowser.hasBeforeUnload;
    } catch (e) {}
    // A page with its own beforeunload decides for itself (Firefox's
    // prompt, inside the original unload): never two dialogs.
    if (ownGuard) {
      return false;
    }
    return this.checkUnsavedInput(tab);
  },

  isFormProtected(tab) {
    if (!this.enabled || !tab) {
      return false;
    }
    return !!tab._whimsyFormManual || this.hasUnsavedInput(tab);
  },

  isFormTyped(tab) {
    return !!tab?.hasAttribute(TYPED_ATTR);
  },

  isManuallyProtected(tab) {
    return !!tab?._whimsyFormManual;
  },

  refreshBrowser(browser) {
    const tab = tabFor(browser);
    if (tab) {
      this.refreshTab(tab);
    }
  },

  // Derives the tab's attributes from the reports. The meaning goes in the
  // tab's tooltip and accessible description (wrapTooltip).
  refreshTab(tab) {
    const typed = this.hasUnsavedInput(tab);
    const manual = this.enabled && !!tab._whimsyFormManual;
    tab.toggleAttribute(TYPED_ATTR, typed);
    tab.toggleAttribute(ATTR, typed || manual);
    // Firefox's TabUnloader never discards an undiscardable tab.
    if (typed && !tab.undiscardable) {
      tab.undiscardable = true;
      tab._whimsyFormUndiscardable = true;
    } else if (!typed && tab._whimsyFormUndiscardable) {
      tab.undiscardable = false;
      delete tab._whimsyFormUndiscardable;
    }
    this.refreshMarker(tab);
  },

  // ---- F29 marker ----

  // The one place that decides where the marker element lives: inside
  // .tab-content, after the title; CSS ("F29 marker placement") puts it at
  // the row's end or inside the tile's bottom-start corner.
  placeMarker(tab, marker) {
    const label = tab.querySelector(".tab-label-container");
    if (label) {
      label.after(marker);
    } else {
      tab.querySelector(".tab-content")?.append(marker);
    }
  },

  // The one marker: unsaved input, else a lock while the tab is protected
  // by hand, else nothing.
  refreshMarker(tab) {
    const typed = tab.hasAttribute(TYPED_ATTR);
    const manual = !typed && !!tab._whimsyFormManual && tab.hasAttribute(ATTR) && this.enabled;
    tab.toggleAttribute(MANUAL_ATTR, manual);
    let marker = tab.querySelector(`.${MARKER_CLASS}`);
    if (!typed && !manual) {
      return;
    }
    if (!marker) {
      marker = tab.ownerDocument.createXULElement("image");
      marker.className = MARKER_CLASS;
      this.placeMarker(tab, marker);
    }
    marker.setAttribute("kind", typed ? "form" : "lock");
    if (manual) {
      marker.setAttribute("src", LOCK_ICON);
      marker.removeAttribute("aria-hidden");
      marker.setAttribute("role", "img");
      tab.ownerDocument.l10n.setAttributes(marker, "whimsy-tab-protected-marker");
    } else {
      marker.setAttribute("src", PENCIL_ICON);
      marker.setAttribute("aria-hidden", "true");
      marker.removeAttribute("role");
      marker.removeAttribute("data-l10n-id");
      marker.removeAttribute("tooltiptext");
      marker.removeAttribute("aria-label");
    }
  },

  // ---- refill: keep what was typed (W10-25, F08) ----

  storeSnapshot(browser, url, data) {
    if (discarding.has(browser)) {
      return false;
    }
    if (!this.enabled || typeof url != "string" || !/^https?:/.test(url)) {
      return false;
    }
    const clean = cleanSnapshot(data);
    if (!clean) {
      return false;
    }
    // Only the page the tab is on can leave its answers.
    try {
      // URL.host has the port, nsIURI.host doesn't: compare like with like.
      const host = new URL(url).host;
      if (browser.currentURI?.host && browser.currentURI.hostPort != host) {
        return false;
      }
    } catch (e) {
      return false;
    }
    const snapshot = { url, data: clean, time: Date.now() };
    snapshots.set(browser, snapshot);
    const win = browser.documentGlobal;
    const tab = tabFor(browser);
    // Private tabs keep it in memory only; normal ones in the session too,
    // so it survives a restart.
    if (tab && !lazy.PrivateBrowsingUtils.isBrowserPrivate(browser) && !lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      try {
        lazy.SessionStore.setCustomTabValue(tab, SNAPSHOT_KEY, JSON.stringify(snapshot));
      } catch (e) {
        console.error("Whimsy: form snapshot", e);
      }
    }
    return true;
  },

  snapshotFor(browser, url) {
    if (!this.enabled || typeof url != "string") {
      return null;
    }
    let snapshot = snapshots.get(browser) ?? null;
    if (!snapshot) {
      const tab = tabFor(browser);
      try {
        const stored = tab ? lazy.SessionStore.getCustomTabValue(tab, SNAPSHOT_KEY) : "";
        if (stored) {
          const parsed = JSON.parse(stored);
          snapshot = { url: String(parsed.url ?? ""), data: cleanSnapshot(parsed.data), time: Number(parsed.time) || 0 };
        }
      } catch (e) {
        snapshot = null;
      }
    }
    if (!snapshot?.data || Date.now() - snapshot.time > SNAPSHOT_MAX_AGE_MS) {
      if (snapshot) {
        this.clearSnapshot(browser);
      }
      return null;
    }
    return sameAddress(snapshot.url, url) ? snapshot : null;
  },

  async saveSnapshotNow(browser) {
    try {
      const actor = browser?.browsingContext?.currentWindowGlobal?.getActor("WhimsyFormProtection");
      const snapshot = await actor?.sendQuery("Whimsy:FormTakeSnapshot");
      if (snapshot) {
        this.storeSnapshot(browser, snapshot.url, snapshot.data);
      }
    } catch (e) {
      // The page went away first; its own pagehide snapshot is all there is.
    }
  },

  clearSnapshot(browser) {
    snapshots.delete(browser);
    const tab = tabFor(browser);
    if (tab) {
      try {
        if (lazy.SessionStore.getCustomTabValue(tab, SNAPSHOT_KEY)) {
          lazy.SessionStore.deleteCustomTabValue(tab, SNAPSHOT_KEY);
        }
      } catch (e) {}
    }
  },

  // "Fill in 3 answers you typed before?" · Fill In. Nothing is filled
  // unless the person asks.
  offerRefill(browser, actor, count) {
    const win = browser.documentGlobal;
    if (!count || !win?.gBrowser || win.gBrowser.selectedBrowser != browser) {
      return null;
    }
    return (
      win.gZenUIManager?.toasts?.open("whimsy-form-refill-ask", {
        l10nArgs: { count },
        descriptionId: "whimsy-form-refill-ask-detail",
        icon: MARKER_ICON,
        browser,
        timeout: REFILL_OFFER_MS,
        buttons: [
          {
            id: "whimsyFormRefillFill",
            l10nId: "whimsy-form-refill-fill",
            command: () => {
              this.clearSnapshot(browser);
              actor.sendQuery("Whimsy:FormRefill").catch(() => {});
            },
          },
        ],
      }) ?? null
    );
  },

  // ---- asking before a tab's input is lost ----

  /**
   * "Unload this tab?" beside the sidebar, level with the tab. Resolves
   * "save" (Save and Unload), "discard" (Unload Without Saving) or false
   * (Cancel, focused first; Esc; a click outside). One at a time per
   * window: a second ask while one is open resolves false at once.
   */
  confirmUnload(win, tabs) {
    if (askingWindows.has(win)) {
      return Promise.resolve(false);
    }
    const doc = win.document;
    const tab = tabs[0];
    const browser = tab.linkedBrowser;
    let host = "";
    try {
      host = browser.currentURI?.displayHost || "";
    } catch (e) {}
    const isPrivate = lazy.PrivateBrowsingUtils.isBrowserPrivate(browser) || lazy.PrivateBrowsingUtils.isWindowPrivate(win);
    const asking = new Promise(resolve => {
      let answer = false;
      const parts = lazy.WhimsySurface.create(win, {
        id: UNLOAD_PANEL_ID,
        width: 320,
        titleL10nId: "whimsy-form-unload-title",
        titleArgs: { count: tabs.length },
        footer: true,
        className: "whimsy-form-unload",
        initialFocus: () => cancel,
        onHidden: () => {
          askingWindows.delete(win);
          resolve(answer);
        },
      });
      const body = doc.createElementNS(HTML_NS, "p");
      body.className = "whimsy-form-unload-body";
      body.id = "whimsy-form-unload-body";
      if (tabs.length > 1) {
        doc.l10n.setAttributes(body, "whimsy-form-unload-body-many", { count: tabs.length });
      } else {
        doc.l10n.setAttributes(body, isPrivate ? "whimsy-form-unload-body-private" : "whimsy-form-unload-body",
          { host: host || browser.currentURI?.spec || "" });
      }
      parts.view.append(body);
      parts.panel.setAttribute("aria-describedby", body.id);
      // F08 order: Unload Without Saving, Save and Unload, Cancel, one per
      // row (three long labels never fit one row). Cancel has focus.
      const choose = value => () => {
        answer = value;
        lazy.WhimsySurface.close(parts.panel);
      };
      const discard = lazy.WhimsySurface.footerButton(doc, {
        l10nId: "whimsy-form-unload-discard",
        id: "whimsy-form-unload-discard",
        onCommand: choose("discard"),
      });
      const save = lazy.WhimsySurface.footerButton(doc, {
        l10nId: "whimsy-form-unload-accept",
        id: "whimsy-form-unload-accept",
        primary: true,
        onCommand: choose("save"),
      });
      const cancel = lazy.WhimsySurface.footerButton(doc, {
        l10nId: "whimsy-form-unload-keep",
        id: "whimsy-form-unload-keep",
        onCommand: choose(false),
      });
      parts.footer.setAttribute("orient", "vertical");
      parts.footer.setAttribute("align", "stretch");
      parts.footer.append(discard, save, cancel);
      lazy.WhimsySurface.finish(parts);
      // Beside the sidebar, where the Look picker and Hidden Spaces open.
      // (An arrow panel on the full-height sidebar is centred along it;
      // a y offset is ignored, so it can't sit level with the tab. Where
      // all such surfaces open is B4's call.)
      lazy.WhimsySurface.open(win, parts.panel, { at: "beside-sidebar" });
    }).catch(e => {
      // Never leave a close or unload waiting on a dialog that didn't open.
      console.error("Whimsy: form unload dialog", e);
      askingWindows.delete(win);
      return false;
    });
    askingWindows.set(win, asking);
    return asking;
  },

  /**
   * Asks for the tabs that need it. Resolves the answer ("save",
   * "discard"), true when nobody needed asking, or false for Cancel.
   * `asked` gets the tabs that were asked about.
   */
  async ask(win, tabs, asked = []) {
    const checks = await Promise.all(tabs.map(tab => this.needsAsk(tab)));
    asked.push(...tabs.filter((tab, i) => checks[i]));
    if (!asked.length) {
      return true;
    }
    const answer = await this.confirmUnload(win, asked);
    if (answer == "save") {
      await Promise.all(asked.map(tab => this.saveSnapshotNow(tab.linkedBrowser)));
    }
    if (answer == "discard") {
      for (const tab of asked) {
        discarding.add(tab.linkedBrowser);
        this.clearSnapshot(tab.linkedBrowser);
        // Loading it again starts over.
        tab.addEventListener("SSTabRestoring", () => discarding.delete(tab.linkedBrowser), { once: true });
      }
    }
    return answer;
  },

  // Unload Without Saving: Firefox's session copy of the form goes too,
  // or restoring the tab would fill it all back in.
  forgetSessionForm(tab) {
    try {
      lazy.TabStateCache.update(tab.linkedBrowser.permanentKey, { formdata: null });
    } catch (e) {}
  },

  // Every unload the person asks for goes through explicitUnloadTabs. The
  // tabs with unsaved input ask first; Cancel unloads nothing and returns
  // false (Zen's pinned ⌘W stops there too).
  wrapUnload(win) {
    const gBrowser = win.gBrowser;
    if (!gBrowser?.explicitUnloadTabs || gBrowser._whimsyFormUnload) {
      return;
    }
    gBrowser._whimsyFormUnload = true;
    const original = gBrowser.explicitUnloadTabs;
    const self = this;
    gBrowser.explicitUnloadTabs = async function (tabs, ...rest) {
      const list = [...(tabs ?? [])];
      const asked = [];
      const answer = self.enabled ? await self.ask(win, list, asked) : true;
      if (!answer) {
        return false;
      }
      const forget = [
        ...asked.filter(() => answer == "discard"),
        ...list.filter(tab => answered.get(tab) == "discard"),
      ];
      const result = await original.call(this, list, ...rest);
      if (result) {
        forget.forEach(tab => self.forgetSessionForm(tab));
      }
      return result;
    };
  },

  // Zen's pinned and Essential ⌘W (and middle-click, and folders) resets
  // or unloads the tab, and it moves to another tab and animates before it
  // unloads. Ask before any of that. Zen binds its ⌘W listener at init, so
  // a capture listener on cmd_close routes ⌘W through this wrapper when
  // (and only when) there's something to ask about.
  wrapPinnedClose(win) {
    const manager = win.gZenPinnedTabManager;
    if (!manager?.onCloseTabShortcut || manager._whimsyFormClose) {
      return;
    }
    manager._whimsyFormClose = true;
    const original = manager.onCloseTabShortcut;
    const self = this;
    const pinnedTargets = (selected, behavior, { noClose = false, alwaysUnload = false } = {}) => {
      const tabs = Array.isArray(selected) ? selected : [selected];
      const pinned = [
        ...new Set(tabs.flatMap(tab => (tab?.group?.hasAttribute("split-view-group") ? tab.group.tabs : tab)).filter(tab => tab?.pinned)),
      ];
      // Zen's own mapping (ZenPinnedTabManager.onCloseTabShortcut): "close"
      // and "switch" lose nothing a person can't get back; the others
      // unload or reset. A Glance open on the tab only closes the Glance.
      if (noClose && behavior == "close") {
        behavior = "unload-switch";
      }
      if (alwaysUnload && ["close", "reset", "switch", "reset-switch"].includes(behavior)) {
        behavior = behavior.includes("reset") ? "reset-unload-switch" : "unload-switch";
      }
      if (!/unload|reset/.test(behavior ?? "") || pinned.some(tab => tab.hasAttribute("glance-id"))) {
        return [];
      }
      return pinned;
    };
    const behaviorOf = options =>
      options?.behavior ?? Services.prefs.getStringPref("zen.pinned-tab-manager.close-shortcut-behavior", "reset-unload-switch");
    manager.onCloseTabShortcut = async function (event, selectedTab = win.gBrowser.selectedTab, options = {}) {
      const tabs = self.enabled ? pinnedTargets(selectedTab, behaviorOf(options), options) : [];
      if (tabs.length) {
        event?.stopPropagation?.();
        event?.preventDefault?.();
        const answer = await self.ask(win, tabs);
        if (!answer) {
          return undefined;
        }
        if (answer == "save" || answer == "discard") {
          tabs.forEach(tab => answered.set(tab, answer));
        }
        try {
          return await original.call(this, event, selectedTab, options);
        } finally {
          tabs.forEach(tab => answered.delete(tab));
        }
      }
      return original.call(this, event, selectedTab, options);
    };
    win.document.addEventListener(
      "command",
      event => {
        if (event.target.id != "cmd_close" || !self.enabled || manager.enabled === false) {
          return;
        }
        const tab = win.gBrowser.selectedTab;
        if (!pinnedTargets(tab, behaviorOf()).some(t => self.hasUnsavedInput(t))) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        manager.onCloseTabShortcut(event, tab);
      },
      true
    );
  },

  toggleTabProtection(tab) {
    if (!tab) {
      return false;
    }
    const protect = !tab._whimsyFormManual;
    tab._whimsyFormManual = protect;
    this.refreshTab(tab);
    const win = tab.documentGlobal;
    try {
      win.gZenUIManager?.toasts?.open(protect ? "whimsy-form-protected-toast" : "whimsy-form-unprotected-toast", {
        key: "whimsy-form-protect",
        timeout: TOAST_TIMEOUT_MS,
      });
    } catch (e) {}
    return protect;
  },

  // Firefox's tab tooltip and the focused tab's accessible description both
  // come from gBrowser.getTabTooltip; add a line while the tab is protected.
  wrapTooltip(win) {
    const gBrowser = win.gBrowser;
    if (!gBrowser?.getTabTooltip || gBrowser._whimsyFormTooltip) {
      return;
    }
    gBrowser._whimsyFormTooltip = true;
    const original = gBrowser.getTabTooltip;
    const self = this;
    gBrowser.getTabTooltip = function (tab, ...args) {
      const text = original.call(this, tab, ...args);
      if (!self.enabled || !tab?.hasAttribute(ATTR)) {
        return text;
      }
      let note = "";
      try {
        note = lazy.l10n.formatValueSync("whimsy-tab-form-protected-tooltip", {
          reason: tab.hasAttribute(TYPED_ATTR) ? "form" : "manual",
        });
      } catch (e) {}
      return [text, note].filter(Boolean).join("\n");
    };
  },

  initWindow(win) {
    this.init();
    lazy.WhimsyCommands.register(win, {
      id: COMMAND_ID,
      l10nId: "whimsy-action-protect-form",
      run: w => {
        const tab = w.gBrowser?.selectedTab;
        if (tab) {
          this.toggleTabProtection(tab);
        }
      },
      icon: "chrome://browser/skin/zen-icons/shield.svg",
      isAvailable: w => this.canProtect(w),
      // Review design-full-4 L5: say what running it will do.
      variants: [
        {
          l10nId: "whimsy-action-protect-form-on",
          isAvailable: w => this.canProtect(w) && !this.isManuallyProtected(w.gBrowser.selectedTab),
        },
        {
          l10nId: "whimsy-action-protect-form-off",
          isAvailable: w => this.canProtect(w) && this.isManuallyProtected(w.gBrowser.selectedTab),
        },
      ],
    });
    this.wrapTooltip(win);
    this.wrapUnload(win);
    this.wrapPinnedClose(win);

    // A new page in the tab: the old document's report no longer counts.
    win.gBrowser?.addTabsProgressListener({
      onLocationChange: (browser, webProgress) => {
        if (webProgress?.isTopLevel) {
          this.refreshBrowser(browser);
        }
      },
    });
  },
};
