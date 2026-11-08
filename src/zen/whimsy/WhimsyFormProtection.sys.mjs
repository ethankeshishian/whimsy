/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Form protection (W9-03, W10-25, F08, F29, F33, W13-R1, then R1 v2 "save
// instead of ask"). The design is whimsy-handoff/wave13/r1-forms-design.md
// (what counts as unsaved input) and whimsy-handoff/wave13/r1-v2-design.md
// (the draft store, close paths, SessionStore hooks).
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
// - R1 v2: closing never asks. While the document is typed, the child keeps
//   WhimsyFormDrafts (below) up to date; closing just leaves the draft
//   where it is. Only when saving is off, or the tab is private, does a
//   single ⌘W/close button or ⌘Q warn once and need a second press
//   (wrapRemoveTab, wrapPinnedClose, the quit-application-requested
//   observer). A page with its own beforeunload still decides for itself
//   (Firefox's prompt, unchanged).
// - Refill: the draft for an address is offered back on its next load
//   ("Restore what you typed?"). Nothing is filled unless the person presses
//   Restore.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AsyncShutdown: "resource://gre/modules/AsyncShutdown.sys.mjs",
  OSKeyStore: "resource://gre/modules/OSKeyStore.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
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
// The old R1 snapshot's SessionStore key (§7: stripped on upgrade; nothing
// writes it any more).
const SNAPSHOT_KEY = "whimsy-formdata";
const SNAPSHOT_MAX_BYTES = 64 * 1024;
const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const REFILL_OFFER_MS = 10000;
const REFILLED_MS = 2000;
const REFILL_FAILED_MS = 4000;
const TOAST_TIMEOUT_MS = 4000;
// R1 v2 §3: a second ⌘W/close button or ⌘Q within this long closes/quits
// without warning again.
const CLOSE_CONFIRM_MS = 4000;
// Requests that carry a page's own save.
const SAVE_METHODS_SKIPPED = new Set(["GET", "HEAD", "OPTIONS"]);

// innerWindowId -> browsingContext, for documents that reported unsaved
// input. Only dirty documents are kept; a document counts only while it is
// the current one of its frame.
const dirtyDocuments = new Map();
// tab -> the time a close warning was shown for it (R1 v2 §3): a press
// within CLOSE_CONFIRM_MS of that time closes/unloads without asking again.
const closeWarnedAt = new WeakMap();
// The last time the quit warning showed, shared by every window (ms, or 0).
let quitWarnedAt = 0;

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
// The Keychain can sit on an unlock or "allow access" prompt; quitting gives
// up on the last write after this long (the previous file stays).
const DRAFTS_SHUTDOWN_MS = 3000;

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
  _shutdownMs: DRAFTS_SHUTDOWN_MS,

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
    lazy.AsyncShutdown.profileBeforeChange.addBlocker("WhimsyFormDrafts: write the drafts", () => this.flushAtShutdown(), {
      fetchState: () => ({ dirty: this._dirty, writing: !!this._writing }),
    });
  },

  // A pending write can hang on an unanswered Keychain prompt; give up on
  // waiting for it (not on the write itself, which keeps running) after a
  // moment instead of blocking the caller.
  _bounded(promise) {
    dump("WDBG _bounded start ms=" + this._shutdownMs + "\n");
    let timer;
    const late = new Promise(resolve => (timer = lazy.setTimeout(() => { dump("WDBG _bounded late fired\n"); resolve(); }, this._shutdownMs)));
    return Promise.race([promise, late]).finally(() => { dump("WDBG _bounded settled\n"); lazy.clearTimeout(timer); });
  },

  flushAtShutdown() {
    return this._bounded(this.flush());
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

  // Fire "This Profile": every draft typed in that container, regardless
  // of site (the scope matches what the profile's burn otherwise clears).
  async forgetContainer(userContextId) {
    userContextId = Number(userContextId) || 0;
    for (const [id, record] of this._private) {
      if (record.userContextId == userContextId) {
        this._private.delete(id);
      }
    }
    const records = await this._load();
    for (const [id, record] of records) {
      if (record.userContextId == userContextId) {
        records.delete(id);
        this._scheduleWrite();
      }
    }
  },

  // Fire everywhere, or the setting turned off: memory and the file.
  async forgetAll() {
    dump("WDBG forgetAll start writing=" + !!this._writing + "\n");
    this._private.clear();
    this._records = new Map();
    this._loading = null;
    this._dirty = false;
    lazy.clearTimeout(this._timer);
    this._timer = null;
    dump("WDBG forgetAll before bounded\n");
    await this._bounded(this._writing);
    dump("WDBG forgetAll after bounded\n");
    await IOUtils.remove(this.path, { ignoreAbsent: true });
    dump("WDBG forgetAll after remove\n");
  },

  _scheduleWrite() {
    this._dirty = true;
    lazy.clearTimeout(this._timer);
    this._timer = lazy.setTimeout(() => this.flush(), DRAFTS_WRITE_MS);
  },

  async flush() {
    dump("WDBG flush entry writing=" + !!this._writing + "\n");
    lazy.clearTimeout(this._timer);
    this._timer = null;
    await this._writing;
    dump("WDBG flush after first await dirty=" + this._dirty + " records=" + !!this._records + "\n");
    if (!this._dirty || !this._records) {
      return;
    }
    this._dirty = false;
    this._writing = this._write([...this._records.values()].filter(r => draftFresh(r.time)));
    dump("WDBG flush set _writing, awaiting\n");
    await this._writing;
    dump("WDBG flush write settled\n");
    this._writing = null;
  },

  async _write(list) {
    dump("WDBG _write entry\n");
    let blob;
    try {
      await lazy.OSKeyStore.ensureLoggedIn(false);
      dump("WDBG _write after ensureLoggedIn\n");
      blob = await lazy.OSKeyStore.encrypt(JSON.stringify(list));
      dump("WDBG _write after encrypt\n");
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

  // ---- R1 v2 §7: typed text never enters SessionStore ----
  //
  // Two one-line hooks (whimsy-SessionStore-sys-mjs.patch and
  // whimsy-SessionStartup-sys-mjs.patch) call these, so Firefox's own
  // session cache and file never hold a typed value in the clear, and
  // never auto-fill it back in (that's the draft/refill offer's job).
  // Both are no-ops while the feature itself is off.

  get stripEnabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  // #onTabStateUpdate's `update.data.formdata`, before it reaches the
  // TabStateCache (and so every closed-tab list, window and backup built
  // from it).
  stripSessionUpdate(update) {
    if (this.stripEnabled && update?.data && "formdata" in update.data) {
      delete update.data.formdata;
    }
  },

  // A freshly read session: every window's (open and closed) tabs' typed
  // formdata, and the old R1 snapshot (extData[SNAPSHOT_KEY]), both
  // plaintext leftovers from before this store existed.
  stripSessionState(state) {
    if (!this.stripEnabled || !state) {
      return;
    }
    const stripTab = tabData => {
      if (tabData && "formdata" in tabData) {
        delete tabData.formdata;
      }
      if (tabData?.extData && SNAPSHOT_KEY in tabData.extData) {
        delete tabData.extData[SNAPSHOT_KEY];
      }
    };
    const stripWindow = win => {
      for (const tab of win?.tabs ?? []) {
        stripTab(tab);
      }
    };
    for (const win of state.windows ?? []) {
      stripWindow(win);
    }
    for (const win of state._closedWindows ?? []) {
      stripWindow(win);
    }
    for (const item of state._closedTabs ?? []) {
      stripTab(item?.state ?? item);
    }
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
        WhimsyFormProtection.refreshBrowser(browser);
        return null;
      }
      // R1 v2 §2, §6: the continuous draft of the top document's typing.
      // data: null deletes it (a save, a submit, back to the start).
      case "Whimsy:FormDraft": {
        if (!browser || this.browsingContext != this.browsingContext.top) {
          return null;
        }
        const { userContextId, isPrivate } = WhimsyFormProtection.contextFor(browser);
        const url = message.data?.url;
        if (message.data?.data) {
          WhimsyFormDrafts.put({ url, data: message.data.data, userContextId, isPrivate });
        } else if (url) {
          WhimsyFormDrafts.delete({ url, userContextId, isPrivate });
        }
        return null;
      }
      case "Whimsy:FormSnapshotFor": {
        if (!browser || this.browsingContext != this.browsingContext.top) {
          return null;
        }
        return WhimsyFormProtection.snapshotFor(browser, message.data?.url);
      }
      case "Whimsy:FormRefillReady":
        if (browser) {
          WhimsyFormProtection.offerRefill(browser, this, message.data?.url, message.data?.count);
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
          // R1 v2 §2: flush a pending draft at once as the page goes away.
          beforeunload: { mozSystemGroup: true },
          pagehide: { mozSystemGroup: true },
        },
      },
      matches: ["https://*/*", "http://*/*"],
      allFrames: true,
      messageManagerGroups: ["browsers"],
      safeForUntrustedWebProcess: true,
    });
    Services.obs.addObserver(networkSaveObserver, "http-on-modify-request");
    Services.obs.addObserver(this, "quit-application-requested");
  },

  observe(subject, topic) {
    if (topic == "quit-application-requested") {
      this.onQuitRequested(subject);
    }
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

  // ---- refill: keep what was typed (W10-25, F08, R1 v2 §4, §6) ----

  // The draft's address and container key (design §4, §9: same address,
  // same container; private never crosses into normal).
  contextFor(browser) {
    let userContextId = 0;
    try {
      userContextId = browser?.browsingContext?.originAttributes?.userContextId ?? 0;
    } catch (e) {}
    return { userContextId, isPrivate: lazy.PrivateBrowsingUtils.isBrowserPrivate(browser) };
  },

  snapshotFor(browser, url) {
    if (!this.enabled || typeof url != "string") {
      return null;
    }
    const { userContextId, isPrivate } = this.contextFor(browser);
    return WhimsyFormDrafts.get({ url, userContextId, isPrivate });
  },

  // "Restore what you typed?" / "N fields on this page" · Restore (design
  // refill-toast B). Nothing is filled unless the person presses Restore;
  // the toast's ✕ or Esc deletes the draft, letting it time out keeps it.
  // Restore changes the toast in place: what it filled, or that it filled
  // nothing (the draft is kept).
  offerRefill(browser, actor, url, count = 0) {
    const win = browser.documentGlobal;
    if (!url || !win?.gBrowser || win.gBrowser.selectedBrowser != browser) {
      return null;
    }
    const { userContextId, isPrivate } = this.contextFor(browser);
    const forget = () => WhimsyFormDrafts.delete({ url, userContextId, isPrivate });
    let answered = false;
    const restore = async toast => {
      answered = true;
      toast.update({ busy: true });
      let filled = 0;
      try {
        filled = (await actor.sendQuery("Whimsy:FormRefill"))?.filled ?? 0;
      } catch (e) {}
      if (filled > 0) {
        forget();
        toast.update({ busy: false, messageId: "whimsy-form-refilled", l10nArgs: { count: filled }, descriptionId: null, buttons: null, timeout: REFILLED_MS });
      } else {
        toast.update({
          busy: false,
          messageId: "whimsy-form-refill-failed",
          l10nArgs: null,
          descriptionId: "whimsy-form-refill-failed-detail",
          buttons: null,
          timeout: REFILL_FAILED_MS,
        });
      }
    };
    return (
      win.gZenUIManager?.toasts?.open("whimsy-form-refill-ask", {
        key: "whimsy-form-refill",
        icon: MARKER_ICON,
        browser,
        timeout: REFILL_OFFER_MS,
        closable: true,
        ...(count > 0 && { descriptionId: "whimsy-form-refill-fields", descriptionArgs: { count } }),
        onClose: reason => {
          if (!answered && reason == "dismissed") {
            forget();
          }
        },
        buttons: [
          {
            id: "whimsyFormRefillButton",
            l10nId: "whimsy-form-refill-button",
            command: (event, toast) => {
              restore(toast);
              return "keep";
            },
          },
        ],
      }) ?? null
    );
  },

  // ---- R1 v2 §3: warn before losing typing (saving off, or private) ----

  isPrivateTab(tab) {
    try {
      return lazy.PrivateBrowsingUtils.isBrowserPrivate(tab?.linkedBrowser);
    } catch (e) {
      return false;
    }
  },

  // Whether closing/quitting `tab` right now would lose typing silently.
  needsWarning(tab) {
    return this.enabled && this.hasUnsavedInput(tab) && (!WhimsyFormDrafts.saving || this.isPrivateTab(tab));
  },

  // Whether `tab` was warned within CLOSE_CONFIRM_MS, without spending
  // that confirmation. Safe to call on a tab that may not end up closing.
  isCloseConfirmed(tab) {
    const at = closeWarnedAt.get(tab);
    return !!(at && Date.now() - at <= CLOSE_CONFIRM_MS);
  },

  // True exactly once per warning: the press that follows a fresh warning
  // (within CLOSE_CONFIRM_MS) consumes it and lets the real close/quit
  // through; a later press needs a fresh warning again.
  closeConfirmed(tab) {
    if (!this.isCloseConfirmed(tab)) {
      return false;
    }
    closeWarnedAt.delete(tab);
    return true;
  },

  // "Unsaved typing will be lost · ⌘W again to close", with a Close
  // button that closes right away. One toast, reused by a normal tab's
  // ⌘W/close button and by pinned/Essential ⌘W.
  warnBeforeClose(win, tabs, proceed) {
    tabs.forEach(tab => closeWarnedAt.set(tab, Date.now()));
    try {
      win.gZenUIManager?.toasts?.open("whimsy-form-close-warning", {
        key: "whimsy-form-close-warning",
        browser: tabs[0]?.linkedBrowser,
        timeout: CLOSE_CONFIRM_MS,
        buttons: [
          {
            id: "whimsyFormCloseButton",
            l10nId: "whimsy-form-close-button",
            command: () => {
              tabs.forEach(tab => closeWarnedAt.delete(tab));
              proceed();
            },
          },
        ],
      });
    } catch (e) {}
  },

  // ⌘W, the close button, middle-click and double-click all call
  // gBrowser.removeTab for a single tab; bulk closes (Close Other Tabs,
  // window close) go through removeTabs and never warn per tab (design §3).
  wrapRemoveTab(win) {
    const gBrowser = win.gBrowser;
    if (!gBrowser?.removeTab || gBrowser._whimsyFormClose) {
      return;
    }
    gBrowser._whimsyFormClose = true;
    const originalRemoveTab = gBrowser.removeTab;
    const originalRemoveTabs = gBrowser.removeTabs;
    gBrowser._whimsyFormOriginalRemoveTab = originalRemoveTab;
    const self = this;
    gBrowser.removeTab = function (tab, options = {}) {
      if (self.enabled && !gBrowser._whimsyFormBulk && self.needsWarning(tab) && !self.closeConfirmed(tab)) {
        self.warnBeforeClose(win, [tab], () => gBrowser._whimsyFormOriginalRemoveTab(tab, options));
        return undefined;
      }
      return originalRemoveTab.call(this, tab, options);
    };
    if (originalRemoveTabs) {
      gBrowser.removeTabs = function (tabs, ...rest) {
        gBrowser._whimsyFormBulk = true;
        try {
          return originalRemoveTabs.call(this, tabs, ...rest);
        } finally {
          gBrowser._whimsyFormBulk = false;
        }
      };
    }
  },

  // Zen's pinned and Essential ⌘W (and middle-click, and folders) resets
  // or unloads the tab. Zen binds its ⌘W listener at init, so a capture
  // listener on cmd_close routes ⌘W through this wrapper when (and only
  // when) a pinned target needs the warning.
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
      const typed = tabs.filter(tab => self.needsWarning(tab));
      // Peek, don't consume: a press that ends up warning (because some
      // other typed tab isn't confirmed yet) closes nothing, so it must
      // leave every tab's confirmation exactly as it found it.
      const needWarn = typed.filter(tab => !self.isCloseConfirmed(tab));
      if (needWarn.length) {
        event?.stopPropagation?.();
        event?.preventDefault?.();
        self.warnBeforeClose(win, needWarn, () => original.call(this, event, selectedTab, options));
        return undefined;
      }
      // Nothing left to warn about: the close goes ahead, so this is the
      // one press that gets to spend every typed tab's confirmation.
      typed.forEach(tab => self.closeConfirmed(tab));
      return original.call(this, event, selectedTab, options);
    };
    win.document.addEventListener(
      "command",
      event => {
        if (event.target.id != "cmd_close" || !self.enabled || manager.enabled === false) {
          return;
        }
        const tab = win.gBrowser.selectedTab;
        if (!pinnedTargets(tab, behaviorOf()).some(t => self.needsWarning(t))) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        manager.onCloseTabShortcut(event, tab);
      },
      true
    );
  },

  // Quitting (⌘Q, the menu, the Dock, a restart): a toast warns once for
  // the whole app when any tab, anywhere, needs it; a second ⌘Q within
  // CLOSE_CONFIRM_MS quits.
  onQuitRequested(subject) {
    if (!this.enabled || !(subject instanceof Ci.nsISupportsPRBool) || subject.data) {
      return;
    }
    const tabs = [];
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (!win.closed && win.gBrowser) {
        tabs.push(...win.gBrowser.tabs.filter(tab => this.needsWarning(tab)));
      }
    }
    if (!tabs.length) {
      return;
    }
    if (quitWarnedAt && Date.now() - quitWarnedAt <= CLOSE_CONFIRM_MS) {
      quitWarnedAt = 0;
      return;
    }
    subject.data = true;
    quitWarnedAt = Date.now();
    this.warnBeforeQuit(Services.wm.getMostRecentWindow("navigator:browser"), tabs.length);
  },

  // "N tabs have unsaved typing · ⌘Q again to quit."
  warnBeforeQuit(win, count) {
    if (!win) {
      return;
    }
    try {
      win.gZenUIManager?.toasts?.open("whimsy-form-quit-warning", {
        key: "whimsy-form-quit-warning",
        l10nArgs: { count },
        timeout: CLOSE_CONFIRM_MS,
        buttons: [
          {
            id: "whimsyFormQuitButton",
            l10nId: "whimsy-form-quit-button",
            command: () => {
              quitWarnedAt = 0;
              Services.startup.quit(Services.startup.eAttemptQuit);
            },
          },
        ],
      });
    } catch (e) {}
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
      icon: "chrome://browser/skin/zen-icons/tracking-protection.svg",
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
    // R1 v2 §8: every feature gets a command with an assignable shortcut.
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyToggleSaveDrafts",
      l10nId: "whimsy-action-save-drafts-toggle",
      run: w => {
        const on = !WhimsyFormDrafts.saving;
        Services.prefs.setBoolPref(SAVE_PREF, on);
        try {
          w.gZenUIManager?.toasts?.show(on ? "whimsy-setting-turned-on" : "whimsy-setting-turned-off", {
            l10nArgs: { name: lazy.l10n.formatValueSync("whimsy-form-save-drafts-name") },
          });
        } catch (e) {}
      },
      icon: "chrome://browser/skin/zen-icons/tracking-protection.svg",
      variants: [
        { l10nId: "whimsy-action-save-drafts-on", isAvailable: () => !WhimsyFormDrafts.saving },
        { l10nId: "whimsy-action-save-drafts-off", isAvailable: () => WhimsyFormDrafts.saving },
      ],
    });
    this.wrapTooltip(win);
    this.wrapRemoveTab(win);
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
