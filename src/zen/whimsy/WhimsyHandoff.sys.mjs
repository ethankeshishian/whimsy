/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Handoff (whimsy.feature.handoff). Firefox already advertises the current
// page to your other Apple devices (NSUserActivityTypeBrowsingWeb, sent from
// XULBrowserWindow._updateMacUserActivity on every location change and tab
// switch) and opens pages handed to it. Firefox only hides private *windows*;
// Whimsy also has private tabs and Scratch inside normal windows. This wraps
// that one method so:
// - private tabs, Scratch and anything that isn't http(s) are never offered;
// - only the URL goes out (the title is the URL too, never the page title);
// - Settings -> Privacy -> Handoff can stop offering pages entirely.
// With the feature switch off, Firefox's own method runs unchanged.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.handoff";
const SEND_PREF = "whimsy.handoff.send";

export const WhimsyHandoff = {
  get featureOn() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  get sendOn() {
    return Services.prefs.getBoolPref(SEND_PREF, true);
  },

  // Tests replace this with a recorder; headless Gecko ignores the real one.
  _updater: null,
  get updater() {
    if (!this._updater) {
      this._updater = Cc["@mozilla.org/widget/macuseractivityupdater;1"]?.getService(
        Ci.nsIMacUserActivityUpdater
      );
    }
    return this._updater;
  },
  set updater(value) {
    this._updater = value;
  },

  initWindow(win) {
    const xbw = win.XULBrowserWindow;
    if (
      Services.appinfo.OS != "Darwin" ||
      !xbw ||
      typeof xbw._updateMacUserActivity != "function" ||
      xbw._whimsyHandoffOriginal
    ) {
      return;
    }
    const original = xbw._updateMacUserActivity;
    xbw._whimsyHandoffOriginal = original;
    xbw._updateMacUserActivity = function (aWin, uri, webProgress) {
      if (!WhimsyHandoff.featureOn) {
        return original.call(this, aWin, uri, webProgress);
      }
      if (!webProgress?.isTopLevel) {
        return undefined;
      }
      return WhimsyHandoff.publish(aWin, uri);
    };

    // Turning sending off (or on) applies to the page that's open now.
    const onPref = () => {
      const browser = win.gBrowser?.selectedBrowser;
      if (browser) {
        xbw._updateMacUserActivity(win, browser.currentURI, browser.webProgress);
      }
    };
    Services.prefs.addObserver(SEND_PREF, onPref);
    Services.prefs.addObserver(FEATURE_PREF, onPref);
    win.addEventListener(
      "unload",
      () => {
        Services.prefs.removeObserver(SEND_PREF, onPref);
        Services.prefs.removeObserver(FEATURE_PREF, onPref);
      },
      { once: true }
    );
  },

  // Whether the selected tab is one that must never be offered.
  isExcludedTab(win, tab) {
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      return true;
    }
    if (!tab) {
      return true;
    }
    const P = lazy.WhimsyPrivate;
    if (P.isPrivateTab(tab) || P.isPrivateBrowser(tab.linkedBrowser)) {
      return true;
    }
    const spaceId = tab.getAttribute("zen-workspace-id");
    return P.isScratchId(win, spaceId) || P.activeSpaceIsScratch(win);
  },

  // The URL to offer for this window, or "" to offer nothing (an empty
  // string makes the native side invalidate the current activity).
  payloadFor(win, uri) {
    if (!this.sendOn || !uri || !["http", "https"].includes(uri.scheme)) {
      return "";
    }
    if (this.isExcludedTab(win, win.gBrowser?.selectedTab)) {
      return "";
    }
    return uri.spec;
  },

  publish(win, uri) {
    if (!win || win.closed) {
      return;
    }
    const url = this.payloadFor(win, uri);
    try {
      const baseWin = win.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow);
      // URL only: the title slot carries the URL, never the page's title.
      this.updater?.updateLocation(url, url, baseWin);
    } catch (e) {
      console.error("Whimsy: Handoff", e);
    }
  },
};
