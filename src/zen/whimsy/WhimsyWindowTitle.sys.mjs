/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W27: the window's title names its space. With more than one space, the
// title macOS shows in Mission Control, the Window menu and the Dock's
// window list is "<page title> — <space name>", so two windows on the
// same site can be told apart. With one space it stays Firefox's.
//
// No Zen file changes: Firefox builds the title in
// gBrowser.getWindowTitleForBrowser (Tabbrowser.sys.mjs), which this wraps
// per window, the way WhimsyPrivateLock does. The title is redone when
// Zen switches spaces (gZenWorkspaces.addChangeListeners), when spaces
// are added, removed or renamed (ZenWorkspaceDataChanged in the window
// that changed them, ZenWorkspacesUIUpdate in the others), and when the
// switch changes.
//
// The space is the selected tab's own (zen-workspace-id); an Essential,
// shared by every space, takes the active one. A private window behind
// the private lock keeps its generic title.

const FEATURE_PREF = "whimsy.feature.window-title-space";
// The separator Firefox puts between the parts of a window title.
const SEPARATOR = " — ";

let observing = false;

function browserWindows() {
  return [...Services.wm.getEnumerator("navigator:browser")].filter(win => !win.closed && win._whimsyWindowTitle);
}

export const WhimsyWindowTitle = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  // The name of the space a browser's tab is in, or null when the title
  // shouldn't name one: the switch is off, the window has no spaces (Mini
  // Whimsy, a popup) or only one, or the space has no name.
  spaceName(win, browser = win?.gBrowser?.selectedBrowser) {
    const spaces = win?.gZenWorkspaces;
    if (!this.enabled || win._whimsyQuickWindow || !spaces?.workspaceEnabled) {
      return null;
    }
    let list;
    try {
      list = spaces.getWorkspaces();
    } catch (e) {
      return null;
    }
    if (!Array.isArray(list) || list.length < 2) {
      return null;
    }
    const tab = browser ? win.gBrowser.getTabForBrowser(browser) : null;
    const own = tab?.getAttribute("zen-workspace-id");
    const space = (own && list.find(s => s.uuid == own)) || list.find(s => s.uuid == spaces.activeWorkspace);
    const name = space?.name?.trim();
    return name || null;
  },

  // Firefox's title for `browser`, with the space's name after it.
  title(win, base, browser) {
    if (!base || win.document.documentElement.hasAttribute("whimsy-private-window-locked")) {
      return base;
    }
    const name = this.spaceName(win, browser);
    return name ? `${base}${SEPARATOR}${name}` : base;
  },

  update(win) {
    if (win.closed || !win.gBrowser) {
      return;
    }
    try {
      win.gBrowser.updateTitlebar();
    } catch (e) {
      // The window is closing, or its tabs aren't ready yet.
    }
  },

  updateAll() {
    for (const win of browserWindows()) {
      this.update(win);
    }
  },

  initWindow(win) {
    const gBrowser = win.gBrowser;
    if (!gBrowser || win._whimsyWindowTitle) {
      return;
    }
    win._whimsyWindowTitle = true;
    const self = this;
    const getTitle = gBrowser.getWindowTitleForBrowser;
    if (typeof getTitle == "function") {
      gBrowser.getWindowTitleForBrowser = function (browser) {
        const base = getTitle.apply(this, arguments);
        try {
          return self.title(win, base, browser);
        } catch (e) {
          console.error("Whimsy: window title", e);
          return base;
        }
      };
    }

    const spaces = win.gZenWorkspaces;
    spaces?.addChangeListeners?.(() => this.update(win));
    // A rename, add or remove fires ZenWorkspaceDataChanged here; Zen hands
    // the new list to the other windows afterwards, where an add or remove
    // fires ZenWorkspacesUIUpdate (a rename fires nothing there, so they're
    // redone once the list has reached them).
    const onData = () => {
      this.update(win);
      win.setTimeout(() => this.updateAll(), 0);
    };
    const onUI = () => this.update(win);
    win.addEventListener("ZenWorkspaceDataChanged", onData);
    win.addEventListener("ZenWorkspacesUIUpdate", onUI);
    win.addEventListener(
      "unload",
      () => {
        win.removeEventListener("ZenWorkspaceDataChanged", onData);
        win.removeEventListener("ZenWorkspacesUIUpdate", onUI);
      },
      { once: true }
    );

    if (!observing) {
      observing = true;
      Services.prefs.addObserver(FEATURE_PREF, () => this.updateAll());
    }
    this.update(win);
  },
};
