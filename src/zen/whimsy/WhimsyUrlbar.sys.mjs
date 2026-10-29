/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Show the full URL on click (Safari's "Show full website address"; Arc
// shows just the domain until you interact, then reveals the full, selected,
// editable URL on a single click). Firefox/Zen already untrim to the full
// https://... URL on focus (browser.urlbar.untrimOnUserInteraction.featureGate,
// zen.urlbar.show-domain-only-in-sidebar); this adds:
// - a single click selects the whole untrimmed URL (Arc), always;
// - a Settings checkbox, "Always show full address", for people who want the
//   full URL even without clicking (writes trimURLs/show-domain-only-in-sidebar).
// whimsy.feature.full-url-click gates the click-to-select behavior; turning
// it off leaves Firefox/Zen's own focus handling alone. The "always show"
// checkbox works independently of the switch.

const FEATURE_PREF = "whimsy.feature.full-url-click";
const ALWAYS_FULL_PREF = "whimsy.urlbar.always-full-url";
const MIRROR_PREFS = {
  "zen.urlbar.show-domain-only-in-sidebar": false,
  "browser.urlbar.trimURLs": false,
};

export const WhimsyUrlbar = {
  get clickToSelectEnabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  initWindow(win) {
    const { gURLBar } = win;
    if (!gURLBar) {
      return;
    }
    gURLBar.inputField.addEventListener("click", () => {
      if (!this.clickToSelectEnabled) {
        return;
      }
      // Let gURLBar's own focus/untrim handler run first.
      win.setTimeout(() => {
        if (win.document.activeElement == gURLBar.inputField) {
          gURLBar.select();
        }
      }, 0);
    });

    const update = () => this.applyAlwaysFull();
    Services.prefs.addObserver(ALWAYS_FULL_PREF, update);
    win.addEventListener("unload", () => Services.prefs.removeObserver(ALWAYS_FULL_PREF, update), {
      once: true,
    });
    // Once globally is enough (it writes global prefs, not per-window state),
    // but observing per window keeps Settings responsive without a restart.
    update();
  },

  applyAlwaysFull() {
    const always = Services.prefs.getBoolPref(ALWAYS_FULL_PREF, false);
    const defaults = Services.prefs.getDefaultBranch("");
    for (const [name, valueWhenAlways] of Object.entries(MIRROR_PREFS)) {
      if (always) {
        Services.prefs.setBoolPref(name, valueWhenAlways);
      } else if (Services.prefs.prefHasUserValue(name) && Services.prefs.getBoolPref(name) == valueWhenAlways) {
        // Only clear what we set; leave an unrelated user override alone.
        try {
          Services.prefs.setBoolPref(name, defaults.getBoolPref(name));
        } catch (e) {}
      }
    }
  },
};
