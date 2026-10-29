/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Registers the actor that puts a "Bionic reading" toggle button into
// about:reader's own toolbar. See WhimsyBionicReadingChild.sys.mjs for the
// word-bolding itself; this module only wires the actor up once per
// session, matched to about:reader pages so it's never created for an
// ordinary page.

const FEATURE_PREF = "whimsy.feature.bionic-reading";

export const WhimsyBionicReading = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  init() {
    if (this._initialized || !this.enabled) {
      return;
    }
    this._initialized = true;
    ChromeUtils.registerWindowActor("WhimsyBionicReading", {
      child: {
        esModuleURI: "resource:///modules/whimsy/WhimsyBionicReadingChild.sys.mjs",
        events: {
          DOMContentLoaded: {},
        },
      },
      matches: ["about:reader*"],
      allFrames: false,
    });
  },
};
