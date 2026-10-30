/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// batch10: shared plugin point for the Library panel (the toolbar-button
// popout built around <zen-library>, src/zen/library/ZenLibrary.mjs). Its
// sections live in `this.zenLibrarySections`, a plain {id: SectionClass}
// object assigned once in the constructor - there's no prototype getter to
// wrap, so each Whimsy section is merged straight into that already-built
// object, once per window. By the time a window's own init runs, Zen has
// already parsed <zen-library> and built it (custom elements upgrade as
// soon as the tag is parsed, and ZenLibrary.mjs's customElements.define
// already ran during Zen's own startup), so this is a plain object mutation
// rather than the riskier "patch the prototype before construction" route.
// Each entry stays out until its own whimsy.feature.<id> pref is on, and a
// pref observer keeps that live without reopening the window.

const lazy = {};
ChromeUtils.defineESModuleGetters(
  lazy,
  {
    WhimsyNotesSection: "resource:///modules/whimsy/WhimsyNotesSection.sys.mjs",
    WhimsyFinderFoldersSection: "resource:///modules/whimsy/WhimsyFinderFoldersSection.sys.mjs",
    WhimsyFilesSection: "resource:///modules/whimsy/WhimsyFilesSection.sys.mjs",
    // meeting: Next meeting
    WhimsyNextMeetingSection: "resource:///modules/whimsy/WhimsyNextMeetingSection.sys.mjs",
  },
  { global: "current" }
);

// Rail order: Notes and Finder folders first (least new code, per the
// scout), then captured screenshots.
const SECTIONS = [
  { sectionId: "whimsy-notes", feature: "notes", get Section() { return lazy.WhimsyNotesSection; } },
  { sectionId: "whimsy-finder-folders", feature: "finder-folders", get Section() { return lazy.WhimsyFinderFoldersSection; } },
  { sectionId: "whimsy-files", feature: "screenshot-sidebar", get Section() { return lazy.WhimsyFilesSection; } },
  // meeting: Next meeting
  { sectionId: "whimsy-next-meeting", feature: "next-meeting", get Section() { return lazy.WhimsyNextMeetingSection; } },
];

export const WhimsyLibrarySection = {
  initWindow(win) {
    const lib = win.document.querySelector("zen-library");
    if (!lib?.zenLibrarySections) {
      // <zen-library> should already be upgraded by the time a window's
      // init runs, but if this particular window hasn't gotten there yet,
      // try once more once it's idle rather than silently never hooking up.
      if (!win.closed && !win._whimsyLibraryRetried) {
        win._whimsyLibraryRetried = true;
        win.requestIdleCallback(() => this.initWindow(win));
      }
      return;
    }
    if (lib._whimsySectionsHooked) {
      return;
    }
    lib._whimsySectionsHooked = true;

    const sync = () => {
      let changed = false;
      for (const entry of SECTIONS) {
        const on = Services.prefs.getBoolPref(`whimsy.feature.${entry.feature}`, true);
        const has = entry.sectionId in lib.zenLibrarySections;
        if (on && !has) {
          lib.zenLibrarySections[entry.sectionId] = entry.Section;
          changed = true;
        } else if (!on && has) {
          delete lib.zenLibrarySections[entry.sectionId];
          if (lib.activeTab === entry.sectionId) {
            lib.activeTab = "history";
          }
          changed = true;
        }
      }
      if (changed) {
        lib.requestUpdate?.();
      }
    };

    const observers = SECTIONS.map(entry => {
      const pref = `whimsy.feature.${entry.feature}`;
      const observer = () => sync();
      Services.prefs.addObserver(pref, observer);
      return [pref, observer];
    });
    win.addEventListener(
      "unload",
      () => {
        for (const [pref, observer] of observers) {
          Services.prefs.removeObserver(pref, observer);
        }
      },
      { once: true }
    );
    sync();
  },
};
