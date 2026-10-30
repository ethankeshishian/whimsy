/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Whimsy's app-startup hook (components.conf): runs at profile-after-change,
// before any window and before Firefox's update service stub, whose category
// entry ("nsUpdateServiceStub") sorts after this one ("WhimsyStartup").
// Keep it tiny: only what must happen before Firefox's own startup code.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyUpdates: "resource:///modules/whimsy/WhimsyUpdates.sys.mjs",
});

export class WhimsyStartup {
  QueryInterface = ChromeUtils.generateQI(["nsIObserver"]);

  observe(_subject, topic) {
    if (topic != "profile-after-change") {
      return;
    }
    try {
      lazy.WhimsyUpdates.initChannel();
    } catch (e) {
      console.error("Whimsy: update channel", e);
    }
    // wave5/profiles: before any page loads, so an extension limited to
    // some profiles never runs its content scripts in another's restored
    // tabs (see whimsy-profiles-process.js).
    try {
      if (Services.prefs.getBoolPref("whimsy.feature.space-extensions", true)) {
        Services.ppmm.loadProcessScript("chrome://browser/content/whimsy/whimsy-profiles-process.js", true);
      }
    } catch (e) {
      console.error("Whimsy: profile content-script guard", e);
    }
  }
}
