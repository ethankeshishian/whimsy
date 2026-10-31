/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Whimsy's app-startup hook (components.conf): runs at profile-after-change,
// before any window and before Firefox's update service stub, whose category
// entry ("nsUpdateServiceStub") sorts after this one ("WhimsyStartup").
// Keep it tiny: only what must happen before Firefox's own startup code.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyLiveFolders: "resource:///modules/whimsy/WhimsyLiveFolders.sys.mjs",
  WhimsyUpdates: "resource:///modules/whimsy/WhimsyUpdates.sys.mjs",
  WhimsyLibrarySection: "resource:///modules/whimsy/WhimsyLibrarySection.sys.mjs",
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
    // Live folder providers must be registered before Zen restores saved
    // live folders in the first window (see WhimsyLiveFolders).
    try {
      lazy.WhimsyLiveFolders.installManagerHook();
    } catch (e) {
      console.error("Whimsy: live folders", e);
    }
    // System pass: the old Archive Library section's saved state moves to
    // History's Closed filter before any window builds its Library.
    lazy.WhimsyLibrarySection.migratePrefs();
  }
}
