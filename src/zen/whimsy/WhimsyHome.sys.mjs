/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W11-07: Whimsy Home or Firefox Home, for new windows and new tabs.
//
// Settings → Home and startup has one control for each (Firefox's own
// dropdowns, extended by whimsy-home-startup-mjs.patch):
//
// - New windows: browser.startup.homepage, about:whimsy (Whimsy Home, the
//   default), about:home (Firefox Home), a blank page or custom URLs.
// - New tabs: whimsy.newtab.page, "whimsy" (the default) or "home"; Blank
//   stays Firefox's browser.newtabpage.enabled. Whimsy Home reaches new tabs
//   the way Firefox lets anything replace the new tab page:
//   AboutNewTab.newTabURL, which BROWSER_NEW_TAB_URL reads. An add-on that
//   replaces the new tab page wins, and Whimsy Home comes back when it
//   lets go.
//
// Firefox Home stays a real choice, so Firefox's "Firefox Home" settings
// group (search, widgets, shortcuts, stories, ...) still governs the page
// it describes.
//
// Look used to have a second control, "Use the Whimsy homepage"
// (whimsy.feature.home). It's gone; someone who had turned it off gets
// Firefox Home for both, which is what that switch gave them. The pref
// stays as the feature's off switch (about:whimsy then shows Firefox Home).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AboutNewTab: "resource:///modules/AboutNewTab.sys.mjs",
});

export const WHIMSY_HOME_URL = "about:whimsy";
export const FIREFOX_HOME_URL = "about:home";
export const BLANK_HOME_URL = "chrome://browser/content/blanktab.html";

const HOMEPAGE_PREF = "browser.startup.homepage";
const NEWTAB_PAGE_PREF = "whimsy.newtab.page";
const NEWTAB_ENABLED_PREF = "browser.newtabpage.enabled";
const EXTENSION_PREF = "browser.newtab.extensionControlled";
const FEATURE_PREF = "whimsy.feature.home";
const NEWTAB_URL_CHANGED = "newtab-url-changed";

export const WhimsyHome = {
  initialized: false,

  init() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    try {
      this.migrate();
    } catch (e) {
      console.error("Whimsy: homepage switch migration", e);
    }
    this.update = () => {
      try {
        this.apply();
      } catch (e) {
        console.error("Whimsy: new tab page", e);
      }
    };
    for (const pref of [NEWTAB_PAGE_PREF, NEWTAB_ENABLED_PREF, EXTENSION_PREF, FEATURE_PREF]) {
      Services.prefs.addObserver(pref, this.update);
    }
    Services.obs.addObserver(this.update, NEWTAB_URL_CHANGED);
    this.update();
  },

  // Tests only.
  uninit() {
    if (!this.initialized) {
      return;
    }
    for (const pref of [NEWTAB_PAGE_PREF, NEWTAB_ENABLED_PREF, EXTENSION_PREF, FEATURE_PREF]) {
      Services.prefs.removeObserver(pref, this.update);
    }
    Services.obs.removeObserver(this.update, NEWTAB_URL_CHANGED);
    this.initialized = false;
  },

  // "Use the Whimsy homepage" off meant Firefox Home in new windows (and new
  // tabs showed Firefox Home anyway). Say so with the two choices, then let
  // the old switch go back to its default.
  migrate() {
    if (!Services.prefs.prefHasUserValue(FEATURE_PREF) || Services.prefs.getBoolPref(FEATURE_PREF, true)) {
      return;
    }
    const homepage = Services.prefs.getStringPref(HOMEPAGE_PREF, "");
    if (!Services.prefs.prefHasUserValue(HOMEPAGE_PREF) || homepage == WHIMSY_HOME_URL) {
      Services.prefs.setStringPref(HOMEPAGE_PREF, FIREFOX_HOME_URL);
    }
    if (!Services.prefs.prefHasUserValue(NEWTAB_PAGE_PREF)) {
      Services.prefs.setStringPref(NEWTAB_PAGE_PREF, "home");
    }
    Services.prefs.clearUserPref(FEATURE_PREF);
  },

  // What new windows show: "whimsy", "home", "blank" or "custom" (the
  // values of Settings' New windows dropdown).
  newWindowsChoice() {
    switch (Services.prefs.getStringPref(HOMEPAGE_PREF, "")) {
      case WHIMSY_HOME_URL:
        return "whimsy";
      case FIREFOX_HOME_URL:
        return "home";
      case BLANK_HOME_URL:
        return "blank";
      default:
        return "custom";
    }
  },

  setNewWindowsChoice(choice) {
    const url = { whimsy: WHIMSY_HOME_URL, home: FIREFOX_HOME_URL, blank: BLANK_HOME_URL }[choice];
    if (url) {
      Services.prefs.setStringPref(HOMEPAGE_PREF, url);
    }
  },

  // What new tabs show: "whimsy", "home" or "blank" (the values of
  // Settings' New tabs dropdown).
  newTabsChoice() {
    if (!Services.prefs.getBoolPref(NEWTAB_ENABLED_PREF, true)) {
      return "blank";
    }
    return Services.prefs.getStringPref(NEWTAB_PAGE_PREF, "whimsy") == "home" ? "home" : "whimsy";
  },

  setNewTabsChoice(choice) {
    if (!["whimsy", "home", "blank"].includes(choice)) {
      return;
    }
    if (choice != "blank") {
      Services.prefs.setStringPref(NEWTAB_PAGE_PREF, choice);
    }
    Services.prefs.setBoolPref(NEWTAB_ENABLED_PREF, choice != "blank");
  },

  // Whether new tabs should open Whimsy Home now.
  get wantsWhimsyNewTab() {
    return (
      Services.prefs.getBoolPref(FEATURE_PREF, true) &&
      this.newTabsChoice() == "whimsy" &&
      !Services.prefs.getBoolPref(EXTENSION_PREF, false)
    );
  },

  apply() {
    const newTab = lazy.AboutNewTab;
    const ours = newTab.newTabURL == WHIMSY_HOME_URL;
    if (this.wantsWhimsyNewTab) {
      // Someone else (an add-on, a policy) replaced the new tab page: theirs.
      if (!ours && !newTab.newTabURLOverridden) {
        newTab.newTabURL = WHIMSY_HOME_URL;
      }
    } else if (ours) {
      newTab.resetNewTabURL();
    }
  },
};
