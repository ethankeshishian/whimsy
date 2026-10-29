/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Keep the window when the last tab closes (Arc): already shipped by Zen
// (browser.tabs.closeWindowWithLastTab = false; ZenSpaceManager replaces the
// closed tab with an empty one instead of closing the window). What's
// missing, and what this module adds, is Arc's other half: Cmd+W on a
// window that's already down to one empty tab closes the window, instead of
// recycling the same empty tab forever. The "keep window open" behavior
// itself is exposed as a Settings checkbox (whimsy-preferences-head.inc.xhtml,
// bound straight to Firefox's own pref).
// whimsy.feature.window-close gates only the Cmd+W behavior; turning it off
// hands cmd_close straight back to Firefox.

const FEATURE_PREF = "whimsy.feature.window-close";

function isLoneEmptyTab(win) {
  const { gBrowser } = win;
  if (gBrowser.tabs.length != 1) {
    return false;
  }
  const tab = gBrowser.selectedTab;
  return tab.hasAttribute("zen-empty-tab") && !tab.pinned;
}

export const WhimsyWindowClose = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  initWindow(win) {
    win.document.addEventListener(
      "command",
      event => {
        if (event.target.id != "cmd_close" || !this.enabled) {
          return;
        }
        if (isLoneEmptyTab(win)) {
          event.stopPropagation();
          win.close();
        }
      },
      true
    );
  },
};
