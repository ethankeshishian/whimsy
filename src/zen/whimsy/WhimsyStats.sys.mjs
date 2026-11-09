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

// wave9/secfix (security-full-1 M6): private browsing (private windows,
// private tabs, Scratch) never reaches these prefs, and Clear History or
// Forget About This Site takes the longest tab's title and URL with it.
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyAdultHistory: "resource:///modules/whimsy/WhimsyAdultHistory.sys.mjs",
});

export function isPrivateTab(tab) {
  try {
    return (
      tab.hasAttribute("whimsy-private") ||
      lazy.PrivateBrowsingUtils.isWindowPrivate(tab.ownerDocument?.defaultView) ||
      (!!tab.linkedBrowser && lazy.PrivateBrowsingUtils.isBrowserPrivate(tab.linkedBrowser))
    );
  } catch (e) {
    return true; // Can't tell: don't record it.
  }
}

function longestTouches(domain) {
  try {
    const url = readJSONPref(LONGEST_PREF)?.url;
    const host = url ? Services.io.newURI(url).host : "";
    return !!host && Services.eTLD.hasRootDomain(host, domain);
  } catch (e) {
    return false;
  }
}

Services.obs.addObserver(() => Services.prefs.clearUserPref(LONGEST_PREF), "browser:purge-session-history");
Services.obs.addObserver((subject, topic, domain) => {
  if (domain && longestTouches(domain)) {
    Services.prefs.clearUserPref(LONGEST_PREF);
  }
}, "browser:purge-session-history-for-domain");

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
  // A test that wants the longest-tab record under automation sets this
  // (and resets it in cleanup) — see browser_whimsy_security_private_stats.js.
  // Without it, any ordinary browser-chrome test that opens and closes a
  // regular tab would otherwise leave whimsy.stats.longest-tab changed,
  // which the mochitest harness flags as a "changed preference" todo in
  // whichever unrelated test file's run the tab's TabClose happens to land in.
  allowInAutomation: false,

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
      if (!this.enabled || !restoredWindows || isPrivateTab(tab) || (Cu.isInAutomation && !this.allowInAutomation)) {
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
      // W24: an adult site's page is never Year in tabs' longest tab.
      if (!this.enabled || !openedAt || isPrivateTab(tab) || !lazy.WhimsyAdultHistory.keepsTab(tab)) {
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
    if (Cu.isInAutomation && !this.allowInAutomation) {
      return;
    }
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

  unrecordZap(count = 1) {
    if (!this.enabled || count <= 0) {
      return;
    }
    const current = Services.prefs.getIntPref(ZAPPED_PREF, 0);
    Services.prefs.setIntPref(ZAPPED_PREF, Math.max(0, current - count));
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
        if (!openedAt || isPrivateTab(tab)) {
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
