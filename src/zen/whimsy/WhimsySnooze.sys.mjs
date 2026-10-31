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
  WhimsyPanels: "resource:///modules/whimsy/WhimsyPanels.sys.mjs",
  WhimsySnoozePicker: "resource:///modules/whimsy/WhimsySnoozePicker.sys.mjs",
  WhimsySnoozeTime: "resource:///modules/whimsy/WhimsySnoozeTime.sys.mjs",
  WhimsyLibrarySection: "resource:///modules/whimsy/WhimsyLibrarySection.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.snooze-tab";
const MENU_ID = "context_whimsySnooze";
const STORE_FILENAME = "whimsy-snoozed-tabs.json";

// wave8/snooze: the presets and the time reading live in
// WhimsySnoozeTime; the picker in WhimsySnoozePicker.
const PRESET_COMMANDS = {
  "later-today": "cmd_whimsySnoozeLaterToday",
  tonight: "cmd_whimsySnoozeTonight",
  tomorrow: "cmd_whimsySnoozeTomorrow",
  weekend: "cmd_whimsySnoozeWeekend",
  "next-week": "cmd_whimsySnoozeNextWeek",
};

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
    // wave5: the tab menu's "Snooze…" as a command for the current tab.
    const canSnooze = tab => !!tab && !tab.pinned && !tab.hasAttribute("zen-essential");
    const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
    WhimsyCommands.register(win, {
      id: "cmd_whimsySnoozeTab",
      l10nId: "whimsy-action-snooze-tab",
      run: w => canSnooze(w.gBrowser.selectedTab) && this.openPanel(w, w.gBrowser.selectedTab),
      icon: "chrome://browser/skin/zen-icons/moon-stars.svg",
      isAvailable: w => this.enabled && canSnooze(w.gBrowser.selectedTab),
    });
    // wave8/snooze: each preset as its own command ("Snooze Tab Until
    // Tomorrow"), so the command bar snoozes in one step, and any of them
    // can take a shortcut in about:keyboard.
    for (const [key, id] of Object.entries(PRESET_COMMANDS)) {
      WhimsyCommands.register(win, {
        id,
        l10nId: `whimsy-action-snooze-${key}`,
        run: w => {
          const tab = w.gBrowser.selectedTab;
          const preset = lazy.WhimsySnoozeTime.resolvePreset(key, new Date());
          if (canSnooze(tab) && preset.available) {
            this.snooze(w, tab, preset.at.getTime());
          }
        },
        icon: "chrome://browser/skin/zen-icons/moon-stars.svg",
        isAvailable: w =>
          this.enabled && canSnooze(w.gBrowser.selectedTab) &&
          lazy.WhimsySnoozeTime.resolvePreset(key, new Date()).available,
      });
    }
    // History → Snoozed, where snoozed tabs are seen and managed.
    WhimsyCommands.register(win, {
      id: "cmd_whimsyViewSnoozedTabs",
      l10nId: "whimsy-action-view-snoozed",
      run: w => lazy.WhimsyLibrarySection.openHistory(w, "snoozed"),
      icon: "chrome://browser/skin/zen-icons/history.svg",
      isAvailable: () => this.enabled,
    });
    if (!this._resumed) {
      this._resumed = true;
      this.resume(win);
    }
  },

  // The tabs still waiting to come back, soonest first. The records are the
  // store's own objects, so they can be handed back to wakeNow/cancelSnooze.
  async list() {
    try {
      const store = await this.store();
      return [...store.data.snoozed].sort((a, b) => a.wakeAt - b.wakeAt);
    } catch (e) {
      console.error("Whimsy: snooze list", e);
      return [];
    }
  },

  // The same record, whichever copy the caller holds.
  _sameRecord(a, b) {
    return a == b || (a.closedId == b.closedId && a.wakeAt == b.wakeAt && a.url == b.url);
  },

  _stopTimer(record) {
    for (const [key, timer] of this._timers) {
      if (this._sameRecord(key, record)) {
        try {
          timer.win.clearTimeout(timer.timerId);
        } catch (e) {
          // The window is already gone; nothing to clear.
        }
        this._timers.delete(key);
      }
    }
  },

  // "Wake now" in History → Snoozed: brings the tab back right away.
  wakeNow(win, record) {
    this._stopTimer(record);
    this.wake(win, record);
  },

  // "Cancel snooze": the tab stays closed (it is still in History → Closed)
  // and never comes back on its own.
  cancelSnooze(win, record) {
    this._stopTimer(record);
    this.forget(record);
    win?.gZenUIManager?.showToast?.("whimsy-snooze-cancel-toast", { l10nArgs: { title: record.title || record.url } });
  },

  _notifyChanged() {
    Services.obs.notifyObservers(null, "whimsy-snooze-changed");
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
        if (!contextTab) {
          return;
        }
        // wave8/snooze: open once the menu has gone, so the picker isn't
        // caught in the menu's own close (and a compact sidebar has
        // settled) before it's placed.
        const menu = document.getElementById("tabContextMenu");
        if (menu && menu.state != "closed") {
          const onHidden = event => {
            if (event.target == menu) {
              menu.removeEventListener("popuphidden", onHidden);
              this.openPanel(win, contextTab);
            }
          };
          menu.addEventListener("popuphidden", onHidden);
        } else {
          this.openPanel(win, contextTab);
        }
      });
      const anchor = document.getElementById("context_toggleMuteTab") || document.getElementById("context_pinTab");
      anchor ? anchor.after(item) : document.getElementById("tabContextMenu").appendChild(item);
    }
    item.hidden = false;
  },

  // wave8/snooze (W8-37): the picker (WhimsySnoozePicker): five presets
  // with where each lands, a field that reads typed times, and a date and
  // time; hung off the tab.
  async openPanel(win, tab) {
    const { document } = win;
    if (!tab?.isConnected || tab.closing || !document) {
      return null;
    }
    const snoozedCount = (await this.list()).length;
    return lazy.WhimsySnoozePicker.open(win, tab, {
      snoozedCount,
      onPick: (target, wakeAt) => this.snooze(win, target, wakeAt),
      onViewSnoozed: () => lazy.WhimsyLibrarySection.openHistory(win, "snoozed"),
    });
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
    // wave8/snooze: "Snoozed until tomorrow, 9:00 AM" over the tab's title,
    // with Undo.
    lazy.WhimsyUndo.showToast(
      win,
      "whimsy-snooze-undo-toast",
      {
        type: "snooze",
        undo: () => {
          this.cancel(record);
          if (record.closedId != null) {
            lazy.WhimsyArchive.restore(win, record.closedId);
          }
        },
        redo: null,
      },
      lazy.WhimsySnoozeTime.whenArgs(wakeAt, new Date(), Services.locale.appLocalesAsBCP47),
      { detail: title }
    );
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
      this._notifyChanged();
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
      this._notifyChanged();
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
