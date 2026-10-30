/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Keep the window when the last tab closes (Arc). Zen honors
// browser.tabs.closeWindowWithLastTab in synced windows, but its
// shouldCloseWindow() also closes normal unsynced windows regardless of that
// pref. Honor the setting in those windows too. Cmd+W on a
// window that's already down to one empty tab closes the window, instead of
// recycling the same empty tab forever. The "keep window open" behavior
// itself is exposed as a Settings checkbox (whimsy-preferences-head.inc.xhtml,
// bound straight to Firefox's own pref).
// Disabling whimsy.feature.window-close restores Zen's policy, including
// zen.tabs.close-window-with-empty for Cmd+W on the empty sentinel.

const FEATURE_PREF = "whimsy.feature.window-close";

function isLoneEmptyTab(win) {
  const { gBrowser } = win;
  // Zen keeps internal empty-tab sentinels alongside real tabs (and may
  // retain more than one across spaces). They aren't user tabs. Pinned,
  // Essential and background-space tabs still prevent closing the window.
  if (gBrowser.tabs.some(tab => tab.isOpen && !tab.hasAttribute("zen-empty-tab"))) {
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
    const workspaces = win.gZenWorkspaces;
    const shouldCloseWindow = workspaces.shouldCloseWindow;
    const self = this;
    workspaces.shouldCloseWindow = function (...args) {
      // Match Firefox's pref for normal browser windows. Popup windows and
      // an explicit removeTab({ closeWindowWithLastTab }) retain their policy.
      // handleTabBeforeClose consults this before scheduling cmd_closeWindow;
      // intercepting cmd_close alone is too late and misses close buttons.
      if (self.enabled && win.toolbar.visible) {
        return Services.prefs.getBoolPref("browser.tabs.closeWindowWithLastTab");
      }
      return shouldCloseWindow.apply(this, args);
    };
    win.document.addEventListener(
      "command",
      event => {
        if (event.target.id != "cmd_close" || !this.enabled) {
          return;
        }
        const { gBrowser } = win;
        const tab = gBrowser.selectedTab;
        if (!tab.hasAttribute("zen-empty-tab") || tab.hasAttribute("split-view") || gBrowser.multiSelectedTabsCount) {
          return;
        }
        // Zen's empty-tab command may close the whole window even with real
        // tabs in other spaces. Consume it here so those tabs stay blockers.
        event.preventDefault();
        event.stopImmediatePropagation();
        if (isLoneEmptyTab(win)) {
          win.BrowserCommands.tryToCloseWindow(event);
        }
      },
      true
    );
  },
};
