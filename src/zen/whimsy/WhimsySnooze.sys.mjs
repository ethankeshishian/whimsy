/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// batch8: tab lifecycle — snooze a tab.
//
// SigmaOS and Edge Workspaces: pick "later today / tomorrow / next week,"
// the tab vanishes from the strip, and reappears (with a toast) at that
// time, still in its original space. People use it to clear visual clutter
// without losing the tab's state the way a bookmark would.
//
// Closing through WhimsyArchive (reason "snooze") gives it a free entry in
// the Archive view and an undo entry; a JSONFile under the profile persists
// the wake time so a snooze survives a restart. Across a restart the
// original closedId can't be trusted (SessionStore's closedId counter
// starts over each session), so an overdue snooze found at startup reopens
// the URL fresh instead of trying to restore full session state.

import { REASON_KEY } from "resource:///modules/whimsy/WhimsyArchive.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  TabStateFlusher: "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs",
  WhimsyArchive: "resource:///modules/whimsy/WhimsyArchive.sys.mjs",
  WhimsyUndo: "resource:///modules/whimsy/WhimsyUndo.sys.mjs",
  JSONFile: "resource://gre/modules/JSONFile.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.snooze-tab";
const MENU_ID = "context_whimsySnooze";
const PANEL_ID = "whimsySnoozePanel";
const STORE_FILENAME = "whimsy-snoozed-tabs.json";

const PRESETS = [
  { key: "later-today", hours: 4 },
  { key: "tomorrow", atHour: 9, days: 1 },
  { key: "next-week", atHour: 9, days: 7 },
];

function wakeTimeFor(preset) {
  const now = new Date();
  if (preset.hours) {
    return now.getTime() + preset.hours * 3600 * 1000;
  }
  const at = new Date(now);
  at.setDate(at.getDate() + preset.days);
  at.setHours(preset.atHour, 0, 0, 0);
  if (at.getTime() <= now.getTime()) {
    at.setDate(at.getDate() + 1);
  }
  return at.getTime();
}

export const WhimsySnooze = {
  _timers: new Map(), // record -> { win, timerId }
  _store: null,
  _resumed: false,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  async store() {
    if (!this._store) {
      this._store = new lazy.JSONFile({
        path: PathUtils.join(PathUtils.profileDir, STORE_FILENAME),
        dataPostProcessor: data => (data && Array.isArray(data.snoozed) ? data : { snoozed: [] }),
      });
      await this._store.load();
    }
    return this._store;
  },

  initWindow(win) {
    if (!this.enabled) {
      return;
    }
    this.initMenu(win);
    if (!this._resumed) {
      this._resumed = true;
      this.resume(win);
    }
  },

  initMenu(win) {
    const { document } = win;
    const menu = document.getElementById("tabContextMenu");
    menu?.addEventListener("popupshowing", event => {
      if (event.target == menu) {
        this.updateMenu(win);
      }
    });
  },

  updateMenu(win) {
    const { document } = win;
    let item = document.getElementById(MENU_ID);
    const tab = win.TabContextMenu?.contextTab;
    const show = this.enabled && !!tab && !tab.pinned && !tab.hasAttribute("zen-essential") && !tab.multiselected;
    if (!show) {
      if (item) {
        item.hidden = true;
      }
      return;
    }
    if (!item) {
      item = document.createXULElement("menuitem");
      item.id = MENU_ID;
      document.l10n.setAttributes(item, "tab-context-whimsy-snooze");
      item.addEventListener("command", () => {
        const contextTab = win.TabContextMenu?.contextTab;
        if (contextTab) {
          this.openPanel(win, contextTab);
        }
      });
      const anchor = document.getElementById("context_toggleMuteTab") || document.getElementById("context_pinTab");
      anchor ? anchor.after(item) : document.getElementById("tabContextMenu").appendChild(item);
    }
    item.hidden = false;
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
    document.l10n.setAttributes(panel, "whimsy-snooze-panel");
    const list = document.createXULElement("vbox");
    for (const preset of PRESETS) {
      const button = document.createXULElement("toolbarbutton");
      button.className = "whimsy-snooze-preset toolbarbutton-1";
      document.l10n.setAttributes(button, `whimsy-snooze-${preset.key}`);
      button.addEventListener("command", () => {
        const tab = panel.whimsyTab;
        panel.hidePopup();
        if (tab && tab.isConnected && !tab.closing) {
          this.snooze(win, tab, wakeTimeFor(preset));
        }
      });
      list.append(button);
    }
    panel.append(list);
    win.document.getElementById("mainPopupSet")?.appendChild(panel);
    return panel;
  },

  openPanel(win, tab) {
    const panel = this.panel(win);
    panel.whimsyTab = tab;
    panel.openPopup(tab, { position: "after_start", triggerEvent: null });
  },

  async snooze(win, tab, wakeAt) {
    await lazy.TabStateFlusher.flush(tab.linkedBrowser);
    if (!tab.isConnected || tab.closing) {
      return;
    }
    const title = tab.label;
    const url = tab.linkedBrowser?.currentURI?.spec || "";
    lazy.WhimsyUndo.runSuppressed(() => {
      try {
        lazy.SessionStore.setCustomTabValue(tab, REASON_KEY, "snooze");
      } catch (e) {
        console.error("Whimsy: snooze tag", e);
      }
      win.gBrowser.removeTab(tab, { animate: false });
    });
    // The state was flushed before removal; pick this tab rather than a
    // different recent close from another workspace.
    const justClosed = lazy.WhimsyArchive.listEntries(win).find(entry => entry.url == url);
    const record = {
      closedId: justClosed?.closedId ?? null,
      wakeAt,
      title,
      url,
      zenWorkspace: justClosed?.zenWorkspace || "",
    };
    this.schedule(win, record);
    this.persist(record);
    win.gZenUIManager?.showToast?.("whimsy-snooze-toast", { l10nArgs: { title } });
    lazy.WhimsyUndo.push(win, {
      type: "snooze",
      undo: () => {
        this.cancel(record);
        if (record.closedId != null) {
          lazy.WhimsyArchive.restore(win, record.closedId);
        }
      },
      redo: null,
    });
  },

  schedule(win, record) {
    const delay = Math.max(0, record.wakeAt - Date.now());
    const timerId = win.setTimeout(() => this.wake(win, record), delay);
    this._timers.set(record, { win, timerId });
  },

  cancel(record) {
    const timer = this._timers.get(record);
    if (timer) {
      try {
        timer.win.clearTimeout(timer.timerId);
      } catch (e) {
        // The window is already gone; nothing to clear.
      }
      this._timers.delete(record);
    }
    this.forget(record);
  },

  wake(win, record) {
    this._timers.delete(record);
    this.forget(record);
    if (!win || win.closed) {
      return;
    }
    if (record.closedId != null) {
      const tab = lazy.WhimsyArchive.restore(win, record.closedId, { targetWin: win });
      if (tab) {
        win.gZenUIManager?.showToast?.("whimsy-snooze-wake-toast", { l10nArgs: { title: record.title } });
        return;
      }
    }
    // The closed-tab entry didn't survive (a restart regenerates closedIds)
    // — reopen the URL fresh rather than lose the tab entirely.
    if (record.url) {
      const tab = win.gBrowser.addTab(record.url, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      if (record.zenWorkspace && win.gZenWorkspaces) {
        try {
          win.gZenWorkspaces.moveTabToWorkspace(tab, record.zenWorkspace);
        } catch (e) {
          // Best effort.
        }
      }
      win.gZenUIManager?.showToast?.("whimsy-snooze-wake-toast", { l10nArgs: { title: record.title } });
    }
  },

  async persist(record) {
    try {
      const store = await this.store();
      store.data.snoozed.push(record);
      store.saveSoon();
    } catch (e) {
      console.error("Whimsy: snooze persist", e);
    }
  },

  async forget(record) {
    try {
      const store = await this.store();
      store.data.snoozed = store.data.snoozed.filter(
        r => r.closedId != record.closedId || r.wakeAt != record.wakeAt
      );
      store.saveSoon();
    } catch (e) {
      // Not fatal: at worst a stale entry wakes once more and no-ops.
    }
  },

  // Re-arms (or, if overdue, immediately wakes) whatever was still pending
  // when the browser last closed. Runs once per session, against the
  // first window to initialize.
  async resume(win) {
    try {
      const store = await this.store();
      for (const record of [...store.data.snoozed]) {
        if (record.wakeAt <= Date.now()) {
          record.closedId = null; // Force the URL-reopen fallback.
          this.wake(win, record);
        } else {
          this.schedule(win, record);
        }
      }
    } catch (e) {
      console.error("Whimsy: snooze resume", e);
    }
  },
};
