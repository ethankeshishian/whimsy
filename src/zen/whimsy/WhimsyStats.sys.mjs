/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A lightweight, local-only counter behind Year in tabs (whimsy://year):
// Places has no record of a tab being *opened* (only of pages being
// *visited*), so this starts keeping its own count the moment it first
// runs. Nothing here is sent anywhere; it's two small JSON prefs.
// whimsy.feature.year-in-tabs.

const FEATURE_PREF = "whimsy.feature.year-in-tabs";
const COUNTER_PREF = "whimsy.stats.tabs-opened";
const LONGEST_PREF = "whimsy.stats.longest-tab";
const OPENED_ATTR = "whimsy-opened-at";
// wave6/zap
const ZAPPED_PREF = "whimsy.stats.zapped";

// Session-restored tabs fire TabOpen too; only count tabs opened after the
// window's own session restore has finished, so a browser restart doesn't
// inflate "tabs opened this year".
let restoredWindows = false;
Services.obs.addObserver(function observer() {
  restoredWindows = true;
  Services.obs.removeObserver(observer, "sessionstore-windows-restored");
}, "sessionstore-windows-restored");

function readJSONPref(name) {
  try {
    const raw = Services.prefs.getStringPref(name, "");
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function readCounter() {
  return readJSONPref(COUNTER_PREF) ?? { total: 0, bySpace: {}, since: Date.now() };
}

export const WhimsyStats = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  initWindow(win) {
    const { gBrowser } = win;
    if (!gBrowser?.tabContainer) {
      return;
    }
    const onOpen = event => {
      const tab = event.target;
      tab.setAttribute(OPENED_ATTR, String(Date.now()));
      if (!this.enabled || !restoredWindows) {
        return;
      }
      const data = readCounter();
      data.total++;
      const spaceId = tab.getAttribute("zen-workspace-id") || "default";
      data.bySpace[spaceId] = (data.bySpace[spaceId] || 0) + 1;
      Services.prefs.setStringPref(COUNTER_PREF, JSON.stringify(data));
    };
    const onClose = event => {
      const tab = event.target;
      const openedAt = parseInt(tab.getAttribute(OPENED_ATTR), 10);
      if (!this.enabled || !openedAt) {
        return;
      }
      this._recordIfLongest(tab, Date.now() - openedAt);
    };
    gBrowser.tabContainer.addEventListener("TabOpen", onOpen);
    gBrowser.tabContainer.addEventListener("TabClose", onClose);
    win.addEventListener(
      "unload",
      () => {
        gBrowser.tabContainer.removeEventListener("TabOpen", onOpen);
        gBrowser.tabContainer.removeEventListener("TabClose", onClose);
      },
      { once: true }
    );
  },

  _recordIfLongest(tab, ms) {
    const current = readJSONPref(LONGEST_PREF);
    if (current && current.ms >= ms) {
      return;
    }
    Services.prefs.setStringPref(
      LONGEST_PREF,
      JSON.stringify({
        title: tab.label || "",
        url: tab.linkedBrowser?.currentURI?.spec || "",
        ms,
      })
    );
  },

  // wave6/zap: things zapped off pages (WhimsyZap), for Year in tabs.
  recordZap() {
    if (!this.enabled) {
      return;
    }
    Services.prefs.setIntPref(ZAPPED_PREF, Services.prefs.getIntPref(ZAPPED_PREF, 0) + 1);
  },

  getZapCount() {
    return Services.prefs.getIntPref(ZAPPED_PREF, 0);
  },

  // { total, bySpace: { [workspaceId]: count }, since }.
  getCounter() {
    return readCounter();
  },

  // The longest-open tab recorded from a *closed* tab, or null.
  getLongestClosedTab() {
    return readJSONPref(LONGEST_PREF);
  },

  // The longest-open tab among all *currently* open windows/tabs, or null;
  // combine with getLongestClosedTab() for the true longest-ever.
  getLiveLongestTab() {
    let longest = null;
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      for (const tab of win.gBrowser?.tabs ?? []) {
        const openedAt = parseInt(tab.getAttribute(OPENED_ATTR), 10);
        if (!openedAt) {
          continue;
        }
        const ms = Date.now() - openedAt;
        if (!longest || ms > longest.ms) {
          longest = { title: tab.label || "", url: tab.linkedBrowser?.currentURI?.spec || "", ms };
        }
      }
    }
    return longest;
  },
};
