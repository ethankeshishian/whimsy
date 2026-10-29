/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Seasonal themes: a small, dated surprise (like Google Doodles or Firefox's
// old Colorways), never changing a space's own colours. A gentle accent tint
// plus one flourish (falling leaves or snow), off under reduced motion, and
// off entirely with Settings → Look and Feel → "Seasonal themes" or
// whimsy.seasons.enabled. Nothing in Firefox or Zen does this.
// whimsy.feature.seasonal-themes gates the whole thing.

const FEATURE_PREF = "whimsy.feature.seasonal-themes";
const ENABLED_PREF = "whimsy.seasons.enabled";
const ATTR = "whimsy-season";

// Ranges are inclusive, [month, day] (month is 1-based), and may wrap the
// year end (winter). `flourish` names the CSS layer in whimsy-browser.css;
// null means a tint only.
const SEASONS = [
  { id: "halloween", from: [10, 24], to: [10, 31], flourish: "leaves" },
  { id: "winter", from: [12, 15], to: [12, 31], flourish: "snow" },
  { id: "winter", from: [1, 1], to: [1, 1], flourish: "snow" },
  { id: "spring", from: [3, 20], to: [4, 10], flourish: "blossom" },
];

function inRange(month, day, [fromMonth, fromDay], [toMonth, toDay]) {
  const key = month * 100 + day;
  const from = fromMonth * 100 + fromDay;
  const to = toMonth * 100 + toDay;
  return key >= from && key <= to;
}

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
    const month = now.getMonth() + 1;
    const day = now.getDate();
    return SEASONS.find(s => inRange(month, day, s.from, s.to)) ?? null;
  },

  initWindow(win) {
    const update = () => this.apply(win);
    Services.prefs.addObserver(FEATURE_PREF, update);
    Services.prefs.addObserver(ENABLED_PREF, update);
    win.addEventListener(
      "unload",
      () => {
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
      root.setAttribute("whimsy-season-flourish", season.flourish);
    } else {
      root.removeAttribute(ATTR);
      root.removeAttribute("whimsy-season-flourish");
    }
  },
};
