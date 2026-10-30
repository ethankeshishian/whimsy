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
});

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
    }
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

  // Closed-tab entries, newest first, optionally filtered by title/URL.
  listEntries(win, { query = "" } = {}) {
    const q = query.trim().toLowerCase();
    const raw = lazy.SessionStore.getClosedTabDataForWindow(win) || [];
    const entries = [];
    for (const data of raw) {
      const state = data.state;
      const active = state.entries?.[(state.index || state.entries.length) - 1] || state.entries?.at(-1);
      const title = active?.title || data.title || active?.url || "";
      const url = active?.url || "";
      if (q && !title.toLowerCase().includes(q) && !url.toLowerCase().includes(q)) {
        continue;
      }
      entries.push({
        closedId: data.closedId,
        title,
        url,
        image: data.image || "",
        reason: state.extData?.[REASON_KEY] || "closed",
        groupId: state.extData?.[GROUP_KEY] || null,
        closedAt: data.closedAt || Date.now(),
        zenWorkspace: state.zenWorkspace || "",
      });
    }
    return entries;
  },

  // Restores one closed tab by its stable closedId (unlike an index, this
  // keeps working even if other tabs closed in the meantime) and forces it
  // back into the space it left, in case the restore's own placement landed
  // it in whichever space is currently active instead.
  restore(win, closedId, { targetWin = win, select = true } = {}) {
    const [entry] = this.listEntries(win).filter(e => e.closedId == closedId);
    let tab;
    try {
      tab = lazy.SessionStore.undoClosedTabFromClosedWindow(win, closedId, targetWin);
    } catch (e) {
      console.error("Whimsy: archive restore", e);
      return null;
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
      lazy.SessionStore.forgetClosedTabById(closedId, win);
    } catch (e) {
      console.error("Whimsy: archive forget", e);
    }
  },
};
