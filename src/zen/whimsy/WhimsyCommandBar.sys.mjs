/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// batch6: command bar extras (scout/batch6.md #13, #16).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
});

// #13: typing "/" (Linear, VS Code's ">") in the URL bar enters Zen's
// commands mode, the same mode Tab-in-an-empty-bar already opens. A pref,
// since "/path" is a (rare) valid query someone could type on purpose.
const SLASH_FEATURE_PREF = "whimsy.feature.command-bar-slash";

// #16: Arc's Cmd+T "New ..." actions open a fresh doc/meeting/issue before
// you've finished thinking about it, using the ".new" shortcut domains
// (docs.new etc., already registered by their owners) rather than
// anything Whimsy has to keep up to date itself. "New Note" opens
// whichever target Settings has chosen; hidden until one is.
const CREATE_FEATURE_PREF = "whimsy.feature.command-bar-create";
const NOTE_TARGET_PREF = "whimsy.new-note.target";

const NEW_THINGS = [
  { id: "doc", url: "https://docs.new", l10nId: "whimsy-action-new-doc" },
  { id: "sheet", url: "https://sheets.new", l10nId: "whimsy-action-new-sheet" },
  { id: "slides", url: "https://slides.new", l10nId: "whimsy-action-new-slides" },
  { id: "form", url: "https://forms.new", l10nId: "whimsy-action-new-form" },
  { id: "meet", url: "https://meet.new", l10nId: "whimsy-action-new-meet" },
  { id: "event", url: "https://cal.new", l10nId: "whimsy-action-new-event" },
  { id: "notion", url: "https://notion.new", l10nId: "whimsy-action-new-notion" },
  { id: "linear", url: "https://linear.new", l10nId: "whimsy-action-new-linear" },
  { id: "figma", url: "https://figma.new", l10nId: "whimsy-action-new-figma" },
  { id: "figjam", url: "https://figjam.new", l10nId: "whimsy-action-new-figjam" },
  { id: "repo", url: "https://repo.new", l10nId: "whimsy-action-new-repo" },
  { id: "gist", url: "https://gist.new", l10nId: "whimsy-action-new-gist" },
  { id: "word", url: "https://word.new", l10nId: "whimsy-action-new-word" },
  { id: "excel", url: "https://excel.new", l10nId: "whimsy-action-new-excel" },
  { id: "powerpoint", url: "https://powerpoint.new", l10nId: "whimsy-action-new-powerpoint" },
  { id: "miro", url: "https://miro.new", l10nId: "whimsy-action-new-miro" },
  { id: "loom", url: "https://loom.new", l10nId: "whimsy-action-new-loom" },
  { id: "canva", url: "https://canva.new", l10nId: "whimsy-action-new-canva" },
  { id: "playlist", url: "https://playlist.new", l10nId: "whimsy-action-new-playlist" },
];

// "New Note" targets: only sites with a stable, accountless ".new"-style
// URL. Confluence needs a workspace domain Whimsy doesn't have, so it's
// left out rather than shipping a link that 404s for everyone.
const NOTE_TARGETS = {
  notion: "https://notion.new",
  "google-docs": "https://docs.new",
  word: "https://word.new",
};

export const WhimsyCommandBar = {
  NEW_THINGS,
  NOTE_TARGETS,

  openNewThing(win, url) {
    win.openTrustedLinkIn(url, "tab");
  },

  initWindow(win) {
    this.initSlashFilter(win);
    lazy.WhimsyShortcuts.addActions([
      ...NEW_THINGS.map(thing => ({
        l10nId: thing.l10nId,
        command: w => this.openNewThing(w, thing.url),
        icon: "chrome://browser/skin/zen-icons/plus.svg",
        isAvailable: () => Services.prefs.getBoolPref(CREATE_FEATURE_PREF, true),
      })),
      {
        l10nId: "whimsy-action-new-note",
        command: w => {
          const url = NOTE_TARGETS[Services.prefs.getStringPref(NOTE_TARGET_PREF, "none")];
          if (url) {
            this.openNewThing(w, url);
          }
        },
        icon: "chrome://browser/skin/zen-icons/plus.svg",
        isAvailable: () =>
          Services.prefs.getBoolPref(CREATE_FEATURE_PREF, true) &&
          Services.prefs.getStringPref(NOTE_TARGET_PREF, "none") != "none",
      },
    ]);
  },

  initSlashFilter(win) {
    const urlbar = win.gURLBar;
    if (!urlbar?.inputField) {
      return;
    }
    urlbar.inputField.addEventListener("input", event => {
      if (!Services.prefs.getBoolPref(SLASH_FEATURE_PREF, true)) {
        return;
      }
      const value = urlbar.value;
      if (!value.startsWith("/")) {
        return;
      }
      urlbar.value = value.slice(1);
      win.gZenUIManager.enableCommandsMode(event);
    });
  },
};
