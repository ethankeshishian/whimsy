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
  // media: Playlist v1 (Brave Playlist-like offline saving and Library section)
  { sectionId: "whimsy-playlist", feature: "playlist", name: "WhimsyPlaylistSection" },
  // wave5: Easels (Arc's Library > Easels).
  { sectionId: "whimsy-easels", feature: "easel", name: "WhimsyEaselsSection" },
];

// Zen's History has a "Closed tabs" source that relabels its tab "Archive";
// Whimsy's History has its own Closed filter (archived tabs, with why each
// left) and a Snoozed one, so it drops that source and this pref is put
// back to plain History.
const ZEN_CLOSED_TABS_PREF = "zen.library.history.closed-tabs";
// System pass: which History filter is showing: "all", "closed" or
// "snoozed" (content/whimsy-library-space-history.mjs).
const HISTORY_VIEW_PREF = "whimsy.library.history.view";
const LAST_TAB_PREF = "zen.library.last-tab";
const HIDDEN_TABS_PREF = "zen.library.hidden-tabs";
// The Archive used to be a Library section of its own.
const OLD_ARCHIVE_SECTION = "whimsy-archive";
// Any of these puts Whimsy's History in place of Zen's.
const HISTORY_FEATURES = ["space-history", "archive-view", "snooze-tab"];

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
  // System pass: the Archive and Snooze sections became History filters.
  // Runs at startup (WhimsyStartup), before a window's <zen-library> reads
  // its last tab: a Library last left on the Archive opens on History →
  // Closed, and the Archive leaves the list of hidden rail tabs.
  migratePrefs() {
    try {
      if (Services.prefs.getStringPref(LAST_TAB_PREF, "") == OLD_ARCHIVE_SECTION) {
        Services.prefs.setStringPref(LAST_TAB_PREF, "history");
        Services.prefs.setStringPref(HISTORY_VIEW_PREF, "closed");
      }
      // With Closed off (archive-view), Zen's own closed-tabs source stays.
      if (
        Services.prefs.getBoolPref("whimsy.feature.archive-view", true) &&
        Services.prefs.getBoolPref(ZEN_CLOSED_TABS_PREF, false)
      ) {
        Services.prefs.setBoolPref(ZEN_CLOSED_TABS_PREF, false);
        Services.prefs.setStringPref(HISTORY_VIEW_PREF, "closed");
      }
      const hidden = Services.prefs.getStringPref(HIDDEN_TABS_PREF, "");
      if (hidden.split(",").includes(OLD_ARCHIVE_SECTION)) {
        Services.prefs.setStringPref(
          HIDDEN_TABS_PREF,
          hidden.split(",").filter(id => id && id != OLD_ARCHIVE_SECTION).join(",")
        );
      }
    } catch (e) {
      console.error("Whimsy: Library migration", e);
    }
  },

  get historyFeatureOn() {
    return HISTORY_FEATURES.some(id => Services.prefs.getBoolPref(`whimsy.feature.${id}`, true));
  },

  // Opens the Library on History with one of its filters ("all", "closed"
  // or "snoozed"). Used by "View Archive…" and "View Snoozed Tabs…".
  openHistory(win, view = "all") {
    const ZenLibrary = win.customElements.get("zen-library");
    const lib = win.document.querySelector("zen-library");
    if (!ZenLibrary?.toggle || !lib?.zenLibrarySections?.history?.whimsyHistory) {
      return false;
    }
    Services.prefs.setStringPref(HISTORY_VIEW_PREF, view);
    // A History already built switches now; a new one reads the pref.
    lib.querySelector("whimsy-space-history-section")?.setWhimsyView?.(view);
    if (lib.activeTab != "history" || !ZenLibrary.isLibraryOpen) {
      ZenLibrary.toggle("history");
    }
    return true;
  },

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

    // Zen keeps every section it has shown mounted (a private Set) and
    // renders each with zenLibrarySections[id].render(), so a section
    // removed while mounted (its switch turned off) threw on the next
    // render. A removed Whimsy section reads as an empty one instead; every
    // other lookup, key list and `in` check goes to Zen's own object.
    const removed = new Set();
    const emptySection = id => ({ id, render: () => null });
    lib.zenLibrarySections = new Proxy(lib.zenLibrarySections, {
      get(target, key, receiver) {
        if (typeof key == "string" && !(key in target) && removed.has(key)) {
          return emptySection(key);
        }
        return Reflect.get(target, key, receiver);
      },
    });

    const nativeHistory = lib.zenLibrarySections.history;
    const sync = () => {
      // batch hist: restore Zen immediately when the feature switch is off.
      // System pass: also with only Closed/Snoozed on (archive-view,
      // snooze-tab), since those are History's filters now.
      const history = this.historyFeatureOn ? sections.WhimsySpaceHistorySection : nativeHistory;
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
          changed = true;
        } else if (!on && has) {
          delete lib.zenLibrarySections[entry.sectionId];
          removed.add(entry.sectionId);
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
    for (const id of HISTORY_FEATURES) {
      const pref = `whimsy.feature.${id}`;
      const historyObserver = () => sync();
      Services.prefs.addObserver(pref, historyObserver);
      observers.push([pref, historyObserver]);
    }
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
