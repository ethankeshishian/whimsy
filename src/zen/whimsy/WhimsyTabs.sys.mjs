/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Tab list options that need a little script (the CSS-only ones live in
// whimsy-browser.css).
//
// New tab button fixed at the bottom (whimsy.tabs.newtab-button-bottom):
// Zen puts its "+ New Tab" row at the top of the tab list or right after the
// last tab, so it scrolls away or floats mid-sidebar. With this on, each
// space's button moves into a row at the bottom of that space, above the
// sidebar's foot buttons, where it always stays put. It's the same element
// (Zen's listeners, paste-and-search, shortcut tooltip all keep working); it
// goes back into the list when the option or whimsy.feature.newtab-bottom is
// turned off. Choosing it also turns off Zen's "move it to the top" option
// (and that one turns this off), so new tabs land at the end of the list,
// right above the button.

const FEATURE_PREF = "whimsy.feature.newtab-bottom";
const BOTTOM_PREF = "whimsy.tabs.newtab-button-bottom";
const TOP_PREF = "zen.view.show-newtab-button-top";
const DOCK_CLASS = "whimsy-newtab-dock";

export const WhimsyTabs = {
  _prefsWatched: false,

  get newTabAtBottom() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true) && Services.prefs.getBoolPref(BOTTOM_PREF, false);
  },

  initWindow(win) {
    this.watchPrefs();
    const update = () => this.placeNewTabButtons(win);
    const observer = () => update();
    for (const pref of [FEATURE_PREF, BOTTOM_PREF]) {
      Services.prefs.addObserver(pref, observer);
    }
    win.addEventListener(
      "unload",
      () => {
        for (const pref of [FEATURE_PREF, BOTTOM_PREF]) {
          Services.prefs.removeObserver(pref, observer);
        }
      },
      { once: true }
    );
    // Spaces created later (a new space, or after startup) get theirs too.
    const strip = win.document.getElementById("tabbrowser-arrowscrollbox");
    if (strip) {
      new win.MutationObserver(() => {
        if (this.newTabAtBottom) {
          update();
        }
      }).observe(strip, { childList: true });
    }
    win.gZenWorkspaces?.promiseInitialized?.then(update);
    update();
  },

  // The two placements exclude each other: top and bottom can't both be on.
  watchPrefs() {
    if (this._prefsWatched) {
      return;
    }
    this._prefsWatched = true;
    Services.prefs.addObserver(BOTTOM_PREF, () => {
      if (Services.prefs.getBoolPref(BOTTOM_PREF, false)) {
        Services.prefs.setBoolPref(TOP_PREF, false);
      }
    });
    Services.prefs.addObserver(TOP_PREF, () => {
      if (Services.prefs.getBoolPref(TOP_PREF, false)) {
        Services.prefs.setBoolPref(BOTTOM_PREF, false);
      }
    });
  },

  placeNewTabButtons(win) {
    const bottom = this.newTabAtBottom;
    for (const space of win.document.querySelectorAll("zen-workspace")) {
      const periphery = space.querySelector("#tabbrowser-arrowscrollbox-periphery");
      if (!periphery) {
        continue;
      }
      let dock = space.querySelector(`:scope > .${DOCK_CLASS}`);
      if (bottom) {
        const button = periphery.querySelector("#tabs-newtab-button");
        if (!button) {
          continue;
        }
        if (!dock) {
          dock = win.document.createXULElement("hbox");
          dock.className = DOCK_CLASS;
          const before = space.querySelector(":scope > .zen-workspace-scroll-to-tab");
          if (before) {
            before.before(dock);
          } else {
            space.append(dock);
          }
        }
        dock.append(button);
      } else if (dock) {
        const button = dock.querySelector("#tabs-newtab-button");
        if (button) {
          const tabstop = periphery.querySelector("toolbartabstop");
          if (tabstop) {
            tabstop.after(button);
          } else {
            periphery.prepend(button);
          }
        }
        dock.remove();
      }
    }
    win.document.documentElement.toggleAttribute("whimsy-newtab-bottom", bottom);
  },
};
