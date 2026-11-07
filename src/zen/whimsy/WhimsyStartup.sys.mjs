/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Whimsy's app-startup hook (components.conf): runs at profile-after-change,
// before any window and before Firefox's update service stub, whose category
// entry ("nsUpdateServiceStub") sorts after this one ("WhimsyStartup").
// Keep it tiny: only what must happen before Firefox's own startup code.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ExtensionPreferencesManager: "resource://gre/modules/ExtensionPreferencesManager.sys.mjs",
  WhimsyLibrarySection: "resource:///modules/whimsy/WhimsyLibrarySection.sys.mjs",
  WhimsyLiveFolders: "resource:///modules/whimsy/WhimsyLiveFolders.sys.mjs",
  WhimsyUpdates: "resource:///modules/whimsy/WhimsyUpdates.sys.mjs",
});

// Switches for features that were removed. A value someone set by hand in
// about:config would otherwise stay in prefs.js forever.
export const RETIRED_PREFS = [
  // W10-60: Whimsy's toasts waiting during a macOS Focus (removed).
  "whimsy.feature.macos-focus",
];

export function clearRetiredPrefs() {
  for (const name of RETIRED_PREFS) {
    try {
      Services.prefs.clearUserPref(name);
    } catch (e) {
      console.error("Whimsy: retired pref", name, e);
    }
  }
}

// The privacy API only controls password saving. Let the same password
// manager handle cards and addresses too, unless the person chose otherwise
// in Settings. Default-branch writes never change or erase that user choice.
export const WhimsyAutofill = {
  _initialized: false,
  _generation: 0,

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    Services.prefs.addObserver("signon.rememberSignons", this);
    this.refresh().catch(e => console.error("Whimsy: autofill defaults", e));
  },

  observe(_subject, topic, name) {
    if (topic == "nsPref:changed" && name == "signon.rememberSignons") {
      this.refresh().catch(e => console.error("Whimsy: autofill defaults", e));
    }
  },

  async refresh() {
    const generation = ++this._generation;
    const setting = await lazy.ExtensionPreferencesManager.getSetting("services.passwordSavingEnabled");
    // A later notification may finish first during extension startup/unload.
    if (generation != this._generation) {
      return;
    }
    const enabled = !(setting?.id && setting.value === false);
    const defaults = Services.prefs.getDefaultBranch("");
    defaults.setBoolPref("extensions.formautofill.creditCards.enabled", enabled);
    defaults.setBoolPref("extensions.formautofill.addresses.enabled", enabled);
  },
};

export class WhimsyStartup {
  QueryInterface = ChromeUtils.generateQI(["nsIObserver"]);

  observe(_subject, topic) {
    if (topic != "profile-after-change") {
      return;
    }
    WhimsyAutofill.init();
    try {
      lazy.WhimsyUpdates.initChannel();
    } catch (e) {
      console.error("Whimsy: update channel", e);
    }
    // System pass: the old Archive Library section's saved state moves to
    // History's Closed filter before any window builds its Library.
    lazy.WhimsyLibrarySection.migratePrefs();
    clearRetiredPrefs();
    // wave7/folders: Jira, Linear and Local Servers live folders register
    // before the first window's delayed startup runs Zen's live-folder
    // restore, so they come back after a restart.
    try {
      lazy.WhimsyLiveFolders.installManagerHooks();
    } catch (e) {
      console.error("Whimsy: live folders startup hook", e);
    }
    // wave7/profiles: before any page loads, so an extension limited to
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
