/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Seasonal loading colors: a small calendar surprise on existing indicators.
// Space colors stay the user's own. Both switches restore native styling.

const FEATURE_PREF = "whimsy.feature.seasonal-themes";
const ENABLED_PREF = "whimsy.seasons.enabled";
const ATTR = "whimsy-season";

// Inclusive local-calendar ranges; winter wraps across the year boundary.
const SEASONS = [
  { id: "autumn", from: 922, to: 1130 },
  { id: "winter", from: 1201, to: 229 }, // Include leap day.
  { id: "spring", from: 301, to: 531 },
  { id: "summer", from: 601, to: 921 },
];

export const WhimsySeasons = {
  // Overridable in tests.
  _now() {
    return new Date();
  },

  get enabled() {
    return (
      Services.prefs.getBoolPref(FEATURE_PREF, true) && Services.prefs.getBoolPref(ENABLED_PREF, true)
    );
  },

  current() {
    if (!this.enabled) {
      return null;
    }
    const now = this._now();
    const key = (now.getMonth() + 1) * 100 + now.getDate();
    return SEASONS.find(({ from, to }) =>
      from <= to ? key >= from && key <= to : key >= from || key <= to
    ) ?? null;
  },

  initWindow(win) {
    const update = () => this.apply(win);
    // Recheck on focus and navigation so windows left open across a season
    // boundary update without a polling timer.
    const onTabChange = event => {
      if (event.detail.changed.includes("busy")) {
        update();
      }
    };
    win.addEventListener("focus", update);
    win.gBrowser.tabContainer.addEventListener("TabAttrModified", onTabChange);
    Services.prefs.addObserver(FEATURE_PREF, update);
    Services.prefs.addObserver(ENABLED_PREF, update);
    win.addEventListener(
      "unload",
      () => {
        win.removeEventListener("focus", update);
        win.gBrowser.tabContainer.removeEventListener("TabAttrModified", onTabChange);
        Services.prefs.removeObserver(FEATURE_PREF, update);
        Services.prefs.removeObserver(ENABLED_PREF, update);
      },
      { once: true }
    );
    update();
  },

  apply(win) {
    const root = win.document.documentElement;
    const season = this.current();
    if (season) {
      root.setAttribute(ATTR, season.id);
    } else {
      root.removeAttribute(ATTR);
    }
  },
};
