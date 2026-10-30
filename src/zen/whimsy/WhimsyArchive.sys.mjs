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

const PANEL_ID = "whimsyArchivePanel";

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
  restore(win, closedId, { targetWin = win } = {}) {
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
    if (tab) {
      targetWin.gBrowser.selectedTab = tab;
    }
    return tab;
  },

  // A command-bar action; no persistent toolbar button to avoid a second
  // place for the same control (see no-duplicate-controls).
  initArchiveAction(win) {
    const { WhimsyShortcuts } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyShortcuts.sys.mjs");
    WhimsyShortcuts.addActions([
      {
        l10nId: "whimsy-action-show-archive",
        icon: "chrome://browser/skin/zen-icons/history.svg",
        command: w => this.openPanel(w),
        isAvailable: () => this.viewEnabled,
      },
    ]);
  },

  panel(win) {
    const { document } = win;
    let panel = document.getElementById(PANEL_ID);
    if (panel) {
      return panel;
    }
    panel = document.createXULElement("panel");
    panel.id = PANEL_ID;
    panel.setAttribute("type", "arrow");
    panel.setAttribute("noautofocus", "true");
    panel.setAttribute("role", "dialog");
    panel.className = "whimsy-archive-panel";
    document.l10n.setAttributes(panel, "whimsy-archive-panel");

    const search = document.createElementNS("http://www.w3.org/1999/xhtml", "input");
    search.type = "search";
    search.className = "whimsy-archive-search";
    document.l10n.setAttributes(search, "whimsy-archive-search");

    const list = document.createXULElement("vbox");
    list.className = "whimsy-archive-list";

    const empty = document.createXULElement("description");
    empty.className = "whimsy-archive-empty";
    document.l10n.setAttributes(empty, "whimsy-archive-empty");

    panel.append(search, list, empty);
    search.addEventListener("input", () => this.renderPanel(win, search.value));
    document.getElementById("mainPopupSet")?.appendChild(panel);
    return panel;
  },

  renderPanel(win, query = "") {
    const panel = this.panel(win);
    const list = panel.querySelector(".whimsy-archive-list");
    const empty = panel.querySelector(".whimsy-archive-empty");
    list.textContent = "";
    const entries = this.listEntries(win, { query });
    empty.hidden = !!entries.length;
    const { document } = win;
    let lastDay = "";
    const now = new Date();
    for (const entry of entries) {
      const day = new Date(entry.closedAt);
      const dayKey = day.toDateString();
      if (dayKey != lastDay) {
        lastDay = dayKey;
        const heading = document.createXULElement("label");
        heading.className = "whimsy-archive-day";
        heading.textContent =
          dayKey == now.toDateString()
            ? "Today"
            : day.toLocaleDateString(undefined, { month: "short", day: "numeric" });
        list.append(heading);
      }
      const row = document.createXULElement("hbox");
      row.className = "whimsy-archive-row";
      row.setAttribute("align", "center");
      row.setAttribute("whimsy-archive-reason", entry.reason);
      const icon = document.createXULElement("image");
      icon.className = "whimsy-archive-icon";
      if (entry.image) {
        icon.setAttribute("src", entry.image);
      }
      const label = document.createXULElement("label");
      label.className = "whimsy-archive-title";
      label.setAttribute("crop", "end");
      label.textContent = entry.title || entry.url;
      const restore = document.createXULElement("toolbarbutton");
      restore.className = "whimsy-archive-restore toolbarbutton-1";
      document.l10n.setAttributes(restore, "whimsy-archive-restore");
      restore.addEventListener("command", () => {
        this.restore(win, entry.closedId);
        panel.hidePopup();
      });
      row.append(icon, label, restore);
      list.append(row);
    }
  },

  openPanel(win) {
    const panel = this.panel(win);
    panel.querySelector(".whimsy-archive-search").value = "";
    this.renderPanel(win, "");
    panel.openPopup(win.document.documentElement, { position: "overlap", triggerEvent: null });
  },
};
