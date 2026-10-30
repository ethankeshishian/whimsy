/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// batch6: command bar extras (scout/batch6.md #13, #16).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
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

// Zen's three appearance actions only match their own label, so searching
// "dark" found Switch to Dark Mode but hid Light and Automatic (and vice
// versa). Each now also matches its siblings' labels (the
// "command-bar-related-actions" hotfix in whimsy/overlay.py reads
// whimsyKeywords), ranked just below the direct match.
const APPEARANCE_ACTIONS = [
  "zen-action-switch-to-automatic-appearance",
  "zen-action-switch-to-light-mode",
  "zen-action-switch-to-dark-mode",
];

// fix7 settings: settings people looked for in the command bar and couldn't
// find there: History (Zen's palette only had Reopen Closed Tab), Liquid
// Glass and Glance size. Each follows its feature switch.
const GLANCE_SIZES = ["compact", "standard", "wide"];

function featureOn(id) {
  return Services.prefs.getBoolPref(`whimsy.feature.${id}`, true);
}

function liquidGlassSupported() {
  return (
    featureOn("liquid-glass") &&
    featureOn("transparency") &&
    lazy.AppConstants.isPlatformAndVersionAtLeast("macosx", "25")
  );
}

export const WhimsyCommandBar = {
  NEW_THINGS,
  GLANCE_SIZES,
  NOTE_TARGETS,
  APPEARANCE_ACTIONS,

  linkAppearanceActions() {
    const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
    const group = globalActions.filter(a => APPEARANCE_ACTIONS.includes(a.l10nId));
    for (const action of group) {
      if (Object.hasOwn(action, "whimsyKeywords")) {
        continue;
      }
      Object.defineProperty(action, "whimsyKeywords", {
        configurable: true,
        get: () => group.filter(a => a != action).map(a => a.label),
      });
    }
  },

  openNewThing(win, url) {
    win.openTrustedLinkIn(url, "tab");
  },

  initWindow(win) {
    this.initSlashFilter(win);
    this.linkAppearanceActions();
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
      ...this.settingsActions(),
    ]);
  },

  // History: Zen's Library on its History section (left open if it's
  // already there), or Firefox's Library window when Zen's is off.
  viewHistory(win) {
    const Library = win.customElements.get("zen-library");
    if (Library && Services.prefs.getBoolPref("zen.library.enabled", false)) {
      if (!(Library.isLibraryOpen && Library.getInstance().activeTab == "history")) {
        Library.toggle("history");
      }
      return;
    }
    win.PlacesCommandHook.showPlacesOrganizer("History");
  },

  settingsActions() {
    return [
      {
        l10nId: "whimsy-action-view-history",
        command: w => this.viewHistory(w),
        icon: "chrome://browser/skin/zen-icons/history.svg",
        isAvailable: () => true,
      },
      {
        l10nId: "whimsy-action-liquid-glass-on",
        command: () => Services.prefs.setBoolPref("whimsy.look.liquid-glass", true),
        icon: "chrome://browser/skin/zen-icons/sparkles.svg",
        isAvailable: () => liquidGlassSupported() && !Services.prefs.getBoolPref("whimsy.look.liquid-glass", false),
      },
      {
        l10nId: "whimsy-action-liquid-glass-off",
        command: () => Services.prefs.setBoolPref("whimsy.look.liquid-glass", false),
        icon: "chrome://browser/skin/zen-icons/sparkles.svg",
        isAvailable: () => liquidGlassSupported() && Services.prefs.getBoolPref("whimsy.look.liquid-glass", false),
      },
      ...GLANCE_SIZES.map(size => ({
        l10nId: `whimsy-action-glance-size-${size}`,
        command: () => Services.prefs.setStringPref("whimsy.glance.size", size),
        icon: "chrome://browser/skin/zen-icons/window.svg",
        isAvailable: () =>
          featureOn("glance-size") && Services.prefs.getStringPref("whimsy.glance.size", "standard") != size,
      })),
    ];
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
      const { UrlbarShared } = ChromeUtils.importESModule(
        "chrome://browser/content/urlbar/UrlbarShared.mjs"
      );
      // Enter directly: Zen's toggle can be locked by its preceding mode
      // animation, or toggle an existing commands mode back off.
      urlbar.value = value.slice(1);
      urlbar.searchMode = { source: UrlbarShared.RESULT_SOURCE.ZEN_ACTIONS, isPreview: false };
      urlbar.startQuery({ allowAutofill: false, event });
    });
  },
};
