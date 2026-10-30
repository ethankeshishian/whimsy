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
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    ChromeUtils.registerWindowActor("WhimsyBionicReading", {
      parent: { esModuleURI: "resource:///modules/whimsy/WhimsyBionicReading.sys.mjs" },
      child: {
        esModuleURI: "resource:///modules/whimsy/WhimsyBionicReadingChild.sys.mjs",
        events: {
          AboutReaderContentReady: { wantUntrusted: true },
        },
      },
      matches: ["about:reader*"],
      allFrames: false,
      includeChrome: true,
      safeForUntrustedWebProcess: true,
    });
  },
};

// Content actors cannot write profile preferences. Keep the persistent toggle
// in the parent and return its value to the reader that requested the change.
export class WhimsyBionicReadingParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name == "Whimsy:SetBionic" && WhimsyBionicReading.enabled) {
      const on = !!message.data.on;
      Services.prefs.setBoolPref("whimsy.reader.bionic", on);
      return on;
    }
    return false;
  }
}
