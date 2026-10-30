/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// batch8: tab lifecycle — the shared archive store.
//
// Auto-archive, manual archive, snooze and "closing a tree branch archives
// it" all need the same thing: a durable, searchable list of "tabs that
// left a space, with enough state to recreate them." SessionStore already
// keeps this as the window's closed-tab list (undoCloseTab, the API behind
// Cmd+Shift+T); this module is a *view* over it, adding only a reason
// ("idle"/"manual"/"tree"/"snooze") and a group id for restoring a batch
// together, both stashed in the tab's own SessionStore custom value so they
// ride along in the closed tab's `extData` without a second store.
//
// Arc archives unpinned, silent, unselected tabs after 12 hours of disuse
// (adjustable); the appeal is that a space always looks the way you left
// it without manual cleanup, and nothing is truly lost — the archive is one
// click away. Arc's Archive view is a searchable, by-day list of everything
// that left a space, one click restoring it where it was.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  WhimsyUndo: "resource:///modules/whimsy/WhimsyUndo.sys.mjs",
  JSONFile: "resource://gre/modules/JSONFile.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));

// Private tabs (WhimsyPrivate) are never archived, like tabs in an Arc
// Incognito window: the idle sweep leaves them alone, and an explicit
// archive (fire button, closing a tree branch) just closes them, since
// SessionStore keeps private tabs out of the closed-tab list it's built on.
const PRIVATE_TAB_ATTR = "whimsy-private";

const SWEEP_FEATURE_PREF = "whimsy.feature.auto-archive-tabs";
const VIEW_FEATURE_PREF = "whimsy.feature.archive-view";
const IDLE_PREF = "whimsy.tabs.archive.idle-after";
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// Custom tab values (SessionStore.setCustomTabValue): they're collected
// into the closed tab's `extData` by TabState, so they survive the close
// without any bookkeeping of our own.
export const REASON_KEY = "whimsy-archive-reason";
export const GROUP_KEY = "whimsy-archive-group";
// wave6: ties a stored entry to SessionStore's closed copy of the same tab.
export const ID_KEY = "whimsy-archive-id";

const STORE_FILENAME = "whimsy-archive.json";
// Arc keeps the Archive until Clear Archive; this cap only stops a runaway
// file. Each entry keeps the tab's last few history steps, like a closed tab.
const MAX_ENTRIES = 5000;
const MAX_HISTORY = 10;
// Zen's window sync closes the same tab (same id) in every window.
const SYNC_DEDUPE_MS = 5000;
export const CHANGED_TOPIC = "whimsy-archive-changed";

const IDLE_MS = {
  "12h": 12 * 3600 * 1000,
  "24h": 24 * 3600 * 1000,
  "7d": 7 * 24 * 3600 * 1000,
  "30d": 30 * 24 * 3600 * 1000,
  never: Infinity,
};

export const WhimsyArchive = {
  get sweepEnabled() {
    return Services.prefs.getBoolPref(SWEEP_FEATURE_PREF, true);
  },

  get viewEnabled() {
    return Services.prefs.getBoolPref(VIEW_FEATURE_PREF, true);
  },

  idleThresholdMs() {
    const choice = Services.prefs.getStringPref(IDLE_PREF, "12h");
    return IDLE_MS[choice] ?? IDLE_MS["12h"];
  },

  initWindow(win) {
    if (this.sweepEnabled) {
      this.initSweep(win);
    }
    if (this.viewEnabled) {
      this.initArchiveAction(win);
      this.initStore(win);
    }
  },

  // --- wave6: the durable store ---

  get store() {
    if (!this._store) {
      this._store = new lazy.JSONFile({
        path: PathUtils.join(PathUtils.profileDir, STORE_FILENAME),
        dataPostProcessor: data => (data && Array.isArray(data.entries) ? data : { version: 1, entries: [] }),
      });
      this._store.ensureDataReady();
    }
    return this._store;
  },

  get storedEntries() {
    return this.store.data.entries;
  },

  changed() {
    this.store.saveSoon();
    Services.obs.notifyObservers(null, CHANGED_TOPIC);
  },

  initStore(win) {
    // Capturing on the window runs before SessionStore's own TabClose
    // listener (capturing on the tab container), so the archive id set
    // here rides along into SessionStore's closed-tab copy.
    const onClose = event => {
      // A tab moving to another window, or one its closer asked SessionStore
      // not to keep, isn't leaving.
      if (event.detail?.adoptedBy || event.detail?.skipSessionStore) {
        return;
      }
      try {
        this.recordClose(win, event.target);
      } catch (e) {
        console.error("Whimsy: archive record", e);
      }
    };
    // A tab coming back by any route (Cmd+Shift+T, Firefox's Recently
    // Closed menu, the Archive) leaves the Archive.
    const onRestoring = event => {
      try {
        const id = lazy.SessionStore.getCustomTabValue(event.target, ID_KEY);
        if (id) {
          lazy.SessionStore.deleteCustomTabValue(event.target, ID_KEY);
          this.removeStored(id);
        }
      } catch (e) {
        console.error("Whimsy: archive restore tracking", e);
      }
    };
    win.addEventListener("TabClose", onClose, true);
    win.addEventListener("SSTabRestoring", onRestoring);
    win.addEventListener(
      "unload",
      () => {
        win.removeEventListener("TabClose", onClose, true);
        win.removeEventListener("SSTabRestoring", onRestoring);
      },
      { once: true }
    );
  },

  // What SessionStore itself would keep (no private, empty or Glance tabs),
  // trimmed to what restoring needs: no form data or session storage.
  recordClose(win, tab) {
    if (
      !this.viewEnabled ||
      lazy.PrivateBrowsingUtils.isWindowPrivate(win) ||
      tab.hasAttribute(PRIVATE_TAB_ATTR) ||
      tab.hasAttribute("zen-empty-tab") ||
      tab.hasAttribute("zen-glance-tab") ||
      win._whimsyQuickWindow
    ) {
      return null;
    }
    const now = Date.now();
    if (tab.id && this.storedEntries.some(e => e.tabId == tab.id && now - e.closedAt < SYNC_DEDUPE_MS)) {
      return null;
    }
    const id = `a${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    lazy.SessionStore.setCustomTabValue(tab, ID_KEY, id);
    const full = JSON.parse(lazy.SessionStore.getTabState(tab));
    if (full.isPrivate) {
      return null;
    }
    const entries = (full.entries ?? []).filter(e => e?.url);
    if (!entries.length || entries.every(e => /^about:(blank|newtab|home)$/.test(e.url))) {
      return null;
    }
    const index = Math.min(Math.max(full.index || entries.length, 1), entries.length);
    const start = Math.max(0, index - MAX_HISTORY);
    const kept = entries.slice(start, start + MAX_HISTORY);
    const state = {
      entries: kept,
      index: index - start,
      userContextId: full.userContextId || 0,
      extData: full.extData ?? {},
    };
    if (full.zenWorkspace) {
      state.zenWorkspace = full.zenWorkspace;
    }
    let image = win.gBrowser.getIcon(tab) || "";
    if (image.startsWith("data:") && image.length > 4096) {
      image = "";
    }
    const active = kept[state.index - 1] ?? kept.at(-1);
    const entry = {
      id,
      tabId: tab.id || "",
      title: tab.label || active?.title || active?.url || "",
      url: active?.url || "",
      image,
      closedAt: now,
      reason: state.extData[REASON_KEY] || "closed",
      groupId: state.extData[GROUP_KEY] || null,
      zenWorkspace: full.zenWorkspace || tab.getAttribute("zen-workspace-id") || "",
      state,
    };
    const list = this.storedEntries;
    list.unshift(entry);
    if (list.length > MAX_ENTRIES) {
      list.length = MAX_ENTRIES;
    }
    this.changed();
    return entry;
  },

  removeStored(id) {
    const list = this.storedEntries;
    const i = list.findIndex(e => e.id == id);
    if (i < 0) {
      return null;
    }
    const [entry] = list.splice(i, 1);
    this.changed();
    return entry;
  },

  // SessionStore's own closed copy of a stored entry, while it has one.
  findClosed(id) {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      let data = [];
      try {
        data = lazy.SessionStore.getClosedTabDataForWindow(win) || [];
      } catch (e) {
        continue;
      }
      const found = data.find(d => d.state?.extData?.[ID_KEY] == id);
      if (found) {
        return { win, closedId: found.closedId };
      }
    }
    return null;
  },

  initSweep(win) {
    const timerId = win.setInterval(() => {
      try {
        this.sweepWindow(win);
      } catch (e) {
        console.error("Whimsy: archive sweep", e);
      }
    }, SWEEP_INTERVAL_MS);
    win.addEventListener("unload", () => win.clearInterval(timerId), { once: true });
  },

  // Tabs that stay out of the sweep no matter how long they've sat: pinned,
  // Essentials, playing or showing picture-in-picture, the selected tab,
  // and anything in a split view.
  isSweepExempt(tab) {
    return (
      tab.selected ||
      tab.hasAttribute(PRIVATE_TAB_ATTR) ||
      tab.pinned ||
      tab.hasAttribute("zen-essential") ||
      tab.soundPlaying ||
      tab.pictureinpicture ||
      tab.closing ||
      tab.hasAttribute("zen-glance-tab") ||
      tab.hasAttribute("zen-empty-tab") ||
      !!tab.group?.hasAttribute("split-view-group")
    );
  },

  sweepWindow(win) {
    if (!this.sweepEnabled) {
      return;
    }
    const threshold = this.idleThresholdMs();
    if (!Number.isFinite(threshold)) {
      return; // "Never"
    }
    const now = Date.now();
    const idle = [];
    for (const tab of win.gBrowser.tabs) {
      if (this.isSweepExempt(tab)) {
        continue;
      }
      if (now - (tab.lastAccessed || 0) >= threshold) {
        idle.push(tab);
      }
    }
    if (idle.length) {
      this.archiveTabs(win, idle, { reason: "idle", groupId: `idle-${now}` });
    }
  },

  // Tags each tab with the reason (and group, for a batch that should
  // restore or undo together) before closing it, so the tagging survives
  // into SessionStore's closed-tab data without a second store. Suppresses
  // WhimsyUndo's generic close-tracking (it would otherwise also push a
  // plain "close" entry for the same tabs) and pushes its own
  // reason-labeled one instead.
  archiveTabs(win, tabs, { reason, groupId = null } = {}) {
    tabs = tabs.filter(tab => tab && tab.isConnected && !tab.closing);
    const privateTabs = tabs.filter(tab => tab.hasAttribute(PRIVATE_TAB_ATTR));
    if (privateTabs.length) {
      tabs = tabs.filter(tab => !privateTabs.includes(tab));
      // Suppressed, so tree tabs' removeTab wrapper doesn't route these
      // straight back here.
      lazy.WhimsyUndo.runSuppressed(() => win.gBrowser.removeTabs(privateTabs, { animate: false }));
    }
    if (!tabs.length) {
      return;
    }
    for (const tab of tabs) {
      try {
        lazy.SessionStore.setCustomTabValue(tab, REASON_KEY, reason);
        if (groupId) {
          lazy.SessionStore.setCustomTabValue(tab, GROUP_KEY, groupId);
        }
      } catch (e) {
        console.error("Whimsy: archive tag", e);
      }
    }
    const selected = win.gBrowser.selectedTab;
    const count = tabs.length;
    lazy.WhimsyUndo.runSuppressed(() => {
      if (count > 1) {
        win.gBrowser.removeTabs(tabs, { animate: false });
      } else {
        win.gBrowser.removeTab(tabs[0], { animate: false });
      }
    });
    if (selected && selected.isConnected && !selected.closing && !tabs.includes(selected)) {
      win.gBrowser.selectedTab = selected;
    }
    lazy.WhimsyUndo.push(win, {
      type: `archive:${reason}`,
      undo: () => this.undoLastArchive(win, count),
      redo: null, // the original tab objects are gone; nothing sane to redo.
    });
  },

  // Cmd+Shift+T-style: the most recently closed tabs are always index 0,
  // so restoring `count` of them in a row un-archives the whole batch, the
  // same trick Firefox's own "Undo Close Tabs" menu item uses.
  undoLastArchive(win, count) {
    for (let i = 0; i < count; i++) {
      try {
        lazy.SessionStore.undoCloseTab(win, 0, win);
      } catch (e) {
        break; // Someone else's close got in the way; stop rather than guess.
      }
    }
  },

  // Archived tabs, newest first, optionally filtered by title/URL: the
  // durable store (every window, like Arc's one Archive), plus any of this
  // window's SessionStore closed tabs from before the store existed.
  listEntries(win, { query = "" } = {}) {
    const q = query.trim().toLowerCase();
    const matches = e =>
      !q || e.title.toLowerCase().includes(q) || e.url.toLowerCase().includes(q);
    const entries = this.viewEnabled
      ? this.storedEntries.map(e => ({
          closedId: e.id,
          title: e.title,
          url: e.url,
          image: e.image || "",
          reason: e.reason || "closed",
          groupId: e.groupId || null,
          closedAt: e.closedAt,
          zenWorkspace: e.zenWorkspace || "",
        }))
      : [];
    let raw = [];
    try {
      raw = lazy.SessionStore.getClosedTabDataForWindow(win) || [];
    } catch (e) {
      // An untracked window (closing, or not a browser window).
    }
    for (const data of raw) {
      const state = data.state;
      if (this.viewEnabled && state.extData?.[ID_KEY]) {
        continue; // Listed from the store.
      }
      const active = state.entries?.[(state.index || state.entries.length) - 1] || state.entries?.at(-1);
      entries.push({
        closedId: data.closedId,
        title: active?.title || data.title || active?.url || "",
        url: active?.url || "",
        image: data.image || "",
        reason: state.extData?.[REASON_KEY] || "closed",
        groupId: state.extData?.[GROUP_KEY] || null,
        closedAt: data.closedAt || Date.now(),
        zenWorkspace: state.zenWorkspace || "",
      });
    }
    return entries.filter(matches).sort((a, b) => b.closedAt - a.closedAt);
  },

  // Restores one archived tab by its closedId (stable, unlike an index) and
  // forces it back into the space it left, in case the restore's own
  // placement landed it in whichever space is currently active instead.
  restore(win, closedId, { targetWin = win, select = true } = {}) {
    const entry = this.listEntries(win).find(e => e.closedId == closedId);
    let tab = null;
    if (typeof closedId == "number") {
      try {
        tab = lazy.SessionStore.undoClosedTabFromClosedWindow(win, closedId, targetWin);
      } catch (e) {
        console.error("Whimsy: archive restore", e);
        return null;
      }
    } else {
      const stored = this.storedEntries.find(e => e.id == closedId);
      if (!stored) {
        return null;
      }
      // SessionStore's copy, while it has one, so Cmd+Shift+T's list loses
      // it too; otherwise the stored state.
      const closed = this.findClosed(closedId);
      if (closed) {
        try {
          tab = lazy.SessionStore.undoClosedTabFromClosedWindow(closed.win, closed.closedId, targetWin);
        } catch (e) {
          tab = null;
        }
      }
      if (!tab) {
        try {
          tab = targetWin.gBrowser.addTrustedTab("about:blank", { skipAnimation: true });
          lazy.SessionStore.setTabState(tab, stored.state);
        } catch (e) {
          console.error("Whimsy: archive restore", e);
          if (tab) {
            targetWin.gBrowser.removeTab(tab, { animate: false });
          }
          return null;
        }
      }
      this.removeStored(closedId);
    }
    if (tab && entry?.zenWorkspace && targetWin.gZenWorkspaces) {
      try {
        targetWin.gZenWorkspaces.moveTabToWorkspace(tab, entry.zenWorkspace);
      } catch (e) {
        // Best-effort: SessionStore's own restore usually gets this right.
      }
    }
    if (tab && select) {
      targetWin.gBrowser.selectedTab = tab;
    }
    return tab;
  },

  // A command-bar action; no persistent toolbar button to avoid a second
  // place for the same control (see no-duplicate-controls).
  initArchiveAction(win) {
    const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
    WhimsyCommands.register(win, {
      id: "cmd_whimsyViewArchive",
      l10nId: "whimsy-action-show-archive",
      run: w => this.openPanel(w),
      icon: "chrome://browser/skin/zen-icons/history.svg",
      isAvailable: () => this.viewEnabled,
    });
    // wave6: Arc's Archive menu → Clear Archive.
    WhimsyCommands.register(win, {
      id: "cmd_whimsyClearArchive",
      l10nId: "whimsy-action-clear-archive",
      run: w => this.clear(w),
      icon: "chrome://browser/skin/zen-icons/trash.svg",
      isAvailable: w => this.viewEnabled && this.listEntries(w).length > 0,
    });
    this.initHistoryMenu(win);
  },

  // Arc's "Archive" menu is its History menu (Back, Forward, View History,
  // View Archive…, Clear Archive), so both go in Firefox's History menu,
  // after Show All History.
  initHistoryMenu(win) {
    const { document } = win;
    const anchor = document.getElementById("menu_showAllHistory");
    if (!anchor || document.getElementById("menu_whimsyViewArchive")) {
      return;
    }
    const items = [
      ["menu_whimsyViewArchive", "whimsy-menu-view-archive", "cmd_whimsyViewArchive"],
      ["menu_whimsyClearArchive", "whimsy-menu-clear-archive", "cmd_whimsyClearArchive"],
    ].map(([id, l10nId, command]) => {
      const item = document.createXULElement("menuitem");
      item.id = id;
      item.setAttribute("data-l10n-id", l10nId);
      item.setAttribute("command", command);
      return item;
    });
    anchor.after(...items);
    anchor.parentElement.addEventListener("popupshowing", event => {
      if (event.target == anchor.parentElement) {
        items[1].disabled = !this.listEntries(win).length;
      }
    });
  },

  // fixB: the Archive is a Library section beside History
  // (content/whimsy-library-archive.mjs). "Show Archive" opens the
  // Library on it.
  openPanel(win) {
    const ZenLibrary = win.customElements.get("zen-library");
    const lib = win.document.querySelector("zen-library");
    if (!ZenLibrary?.toggle || !lib?.zenLibrarySections || !("whimsy-archive" in lib.zenLibrarySections)) {
      return false;
    }
    ZenLibrary.toggle("whimsy-archive");
    return true;
  },

  // Drops one entry from the Archive for good (SessionStore forgets it).
  forget(win, closedId) {
    try {
      if (typeof closedId == "number") {
        lazy.SessionStore.forgetClosedTabById(closedId, win);
        return;
      }
      const closed = this.findClosed(closedId);
      if (closed) {
        lazy.SessionStore.forgetClosedTabById(closed.closedId, closed.win);
      }
      this.removeStored(closedId);
    } catch (e) {
      console.error("Whimsy: archive forget", e);
    }
  },

  // Arc's Archive → Clear Archive: empties the Archive and every window's
  // closed-tab list (Cmd+Shift+T), after asking, since it can't be undone.
  clear(win, { confirm = true } = {}) {
    if (confirm) {
      const [title, message, button] = lazy.l10n.formatValuesSync([
        "whimsy-archive-clear-title",
        "whimsy-archive-clear-message",
        "whimsy-archive-clear-button",
      ]);
      const flags =
        Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
        Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_CANCEL +
        Services.prompt.BUTTON_POS_1_DEFAULT;
      const choice = Services.prompt.confirmEx(win, title, message, flags, button, null, null, null, {});
      if (choice != 0) {
        return false;
      }
    }
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      let data = [];
      try {
        data = lazy.SessionStore.getClosedTabDataForWindow(w) || [];
      } catch (e) {
        continue;
      }
      for (const d of data) {
        try {
          lazy.SessionStore.forgetClosedTabById(d.closedId, w);
        } catch (e) {
          // Already gone.
        }
      }
    }
    this.store.data.entries = [];
    this.changed();
    if (confirm) {
      win.gZenUIManager?.showToast?.("whimsy-archive-cleared-toast");
    }
    return true;
  },
};
