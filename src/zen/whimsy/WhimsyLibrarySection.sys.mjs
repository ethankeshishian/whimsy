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

const SECTIONS = [
  { sectionId: "whimsy-notes", feature: "notes", name: "WhimsyNotesSection" },
  { sectionId: "whimsy-finder-folders", feature: "finder-folders", name: "WhimsyFinderFoldersSection" },
  { sectionId: "whimsy-files", feature: "screenshot-sidebar", name: "WhimsyFilesSection" },
  // meeting: Next meeting in the Library rail.
  { sectionId: "whimsy-next-meeting", feature: "next-meeting", name: "WhimsyNextMeetingSection" },
  // fixB: the Archive, right after History so the two read as a pair.
  { sectionId: "whimsy-archive", feature: "archive-view", name: "WhimsyArchiveSection", after: "history" },
  // media: Playlist v1 (Brave Playlist-like offline saving and Library section)
  { sectionId: "whimsy-playlist", feature: "playlist", name: "WhimsyPlaylistSection" },
];

// Zen's History has a "Closed tabs" source that relabels its tab "Archive";
// with Whimsy's Archive beside it that would be two Archives (and two
// controls for one thing), so Whimsy's History drops that source and this
// pref is put back to plain History.
const ZEN_CLOSED_TABS_PREF = "zen.library.history.closed-tabs";

// Moves `id` to sit right after `afterId` in the (plain, ordered) sections
// object, keeping the same object Zen holds.
function placeAfter(sections, id, afterId) {
  if (!(id in sections) || !(afterId in sections)) {
    return;
  }
  const entries = Object.entries(sections);
  for (const [key] of entries) {
    delete sections[key];
  }
  for (const [key, value] of entries) {
    if (key == id) {
      continue;
    }
    sections[key] = value;
    if (key == afterId) {
      sections[id] = entries.find(([k]) => k == id)[1];
    }
  }
}

export const WhimsyLibrarySection = {
  initWindow(win) {
    if (win._whimsyLibraryLoading) {
      return;
    }
    win._whimsyLibraryLoading = true;
    // A module script uses the window loader, so Lit and customElements
    // belong to this document rather than the documentless system global.
    const script = win.document.createElementNS("http://www.w3.org/1999/xhtml", "script");
    script.type = "module";
    script.src = "chrome://browser/content/whimsy/whimsy-library-sections.mjs";
    win.document.documentElement.append(script);
  },

  registerWindow(win, sections) {
    const lib = win.document.querySelector("zen-library");
    if (!lib?.zenLibrarySections) {
      // <zen-library> should already be upgraded by the time a window's
      // init runs, but if this particular window hasn't gotten there yet,
      // try once more once it's idle rather than silently never hooking up.
      if (!win.closed && !win._whimsyLibraryRetried) {
        win._whimsyLibraryRetried = true;
        win.requestIdleCallback(() => this.registerWindow(win, sections));
      }
      return;
    }
    if (lib._whimsySectionsHooked) {
      return;
    }
    lib._whimsySectionsHooked = true;

    const nativeHistory = lib.zenLibrarySections.history;
    const sync = () => {
      // batch hist: restore Zen immediately when the feature switch is off.
      const history = Services.prefs.getBoolPref("whimsy.feature.space-history", true)
        ? sections.WhimsySpaceHistorySection : nativeHistory;
      const historyChanged = lib.zenLibrarySections.history !== history;
      lib.zenLibrarySections.history = history;
      let changed = historyChanged;
      for (const entry of SECTIONS) {
        const on = Services.prefs.getBoolPref(`whimsy.feature.${entry.feature}`, true);
        const has = entry.sectionId in lib.zenLibrarySections;
        if (on && !has) {
          lib.zenLibrarySections[entry.sectionId] = sections[entry.name];
          if (entry.after) {
            placeAfter(lib.zenLibrarySections, entry.sectionId, entry.after);
          }
          if (entry.sectionId == "whimsy-archive" && Services.prefs.getBoolPref(ZEN_CLOSED_TABS_PREF, false)) {
            Services.prefs.setBoolPref(ZEN_CLOSED_TABS_PREF, false);
          }
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
    // batch hist: use the same observer lifetime as Library sections.
    const historyObserver = () => sync();
    Services.prefs.addObserver("whimsy.feature.space-history", historyObserver);
    observers.push(["whimsy.feature.space-history", historyObserver]);
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
