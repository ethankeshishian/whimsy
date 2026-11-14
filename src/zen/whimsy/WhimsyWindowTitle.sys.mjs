/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W27: Show space name in window title (Settings → Tab Management, off by
// default). When it's on, the window's title starts with its space:
// "<space> — <page title>", so Mission Control, the Window menu, and
// screen-share pickers show which space a window is in.
//
// No Zen file changes: Firefox already puts the window's `titlepreface`
// attribute in front of the page title (Tabbrowser.sys.mjs), so this sets
// it to "<space> — " and asks for the title again. It's redone when Zen
// switches spaces (gZenWorkspaces.addChangeListeners), when spaces are
// renamed, added, or removed (ZenWorkspaceDataChanged in the window that
// changed them, ZenWorkspacesUIUpdate in the others), and when the
// setting or the switch changes. A private window behind the private lock
// shows no space name.

const FEATURE_PREF = "whimsy.feature.window-title-space";
const SHOW_PREF = "whimsy.spaces.window-title-name";
const LOCK_ATTR = "whimsy-private-window-locked";
// The separator Firefox puts between the parts of a window title.
const SEPARATOR = " — ";

let observing = false;

function browserWindows() {
  return [...Services.wm.getEnumerator("navigator:browser")].filter(win => !win.closed && win._whimsyWindowTitle);
}

export const WhimsyWindowTitle = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true) && Services.prefs.getBoolPref(SHOW_PREF, false);
  },

  // The name of the window's active space, or null when the title shouldn't
  // name one: the setting or the switch is off, or the window has no spaces
  // (Mini Whimsy, a popup), or the space has no name. With one space it's
  // still named: the setting was turned on knowingly.
  spaceName(win) {
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
    const space = Array.isArray(list) ? list.find(s => s.uuid == spaces.activeWorkspace) : null;
    const name = space?.name?.replace(/\0/g, "").trim();
    return name || null;
  },

  // The titlepreface for the window, or null for none.
  preface(win) {
    if (win.document.documentElement.hasAttribute(LOCK_ATTR)) {
      return null;
    }
    const name = this.spaceName(win);
    return name ? `${name}${SEPARATOR}` : null;
  },

  update(win) {
    if (win.closed || !win.gBrowser) {
      return;
    }
    const root = win.document.documentElement;
    const preface = this.preface(win);
    if (preface) {
      root.setAttribute("titlepreface", preface);
      win._whimsyTitlePreface = preface;
    } else if (win._whimsyTitlePreface) {
      // Only take away a preface this set.
      if (root.getAttribute("titlepreface") == win._whimsyTitlePreface) {
        root.removeAttribute("titlepreface");
      }
      win._whimsyTitlePreface = null;
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
    if (!win.gBrowser || win._whimsyWindowTitle) {
      return;
    }
    win._whimsyWindowTitle = true;

    const spaces = win.gZenWorkspaces;
    spaces?.addChangeListeners?.(() => this.update(win));
    // A rename, add, or remove fires ZenWorkspaceDataChanged here; Zen hands
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
    // The private lock coming on or off.
    const lockWatch = new win.MutationObserver(() => this.update(win));
    lockWatch.observe(win.document.documentElement, { attributes: true, attributeFilter: [LOCK_ATTR] });
    win.addEventListener(
      "unload",
      () => {
        win.removeEventListener("ZenWorkspaceDataChanged", onData);
        win.removeEventListener("ZenWorkspacesUIUpdate", onUI);
        lockWatch.disconnect();
      },
      { once: true }
    );

    if (!observing) {
      observing = true;
      const all = () => this.updateAll();
      Services.prefs.addObserver(FEATURE_PREF, all);
      Services.prefs.addObserver(SHOW_PREF, all);
    }
    this.update(win);
  },
};
