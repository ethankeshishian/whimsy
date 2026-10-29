/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Menu bar extra (Arc parity): Arc's menu bar icon gives a global entry
// point even when no Arc window is focused — click it for a quick window or
// a recent tab without alt-tabbing to the browser first. Built entirely on
// the already-shipped nsISystemStatusBar bridge (addItem/removeItem on a
// XUL <menu>), the same category of native bridge WhimsyAppIcon already
// calls for nsIMacDockSupport, so no new native code is needed.
//
// macOS only. A Settings checkbox (whimsy.menu-bar-extra.show) lets people
// turn the icon off; whimsy.feature.menu-bar-extra is the usual Whimsy
// feature switch (off if Zen ever ships its own).

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  RecentlyClosedTabsAndWindowsMenuUtils:
    "resource:///modules/sessionstore/RecentlyClosedTabsAndWindowsMenuUtils.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.menu-bar-extra";
const SHOW_PREF = "whimsy.menu-bar-extra.show";
const ICON_URL = "chrome://browser/content/whimsy/app-icons/daydream.png";

export const WhimsyMenuBarExtra = {
  get enabled() {
    return (
      AppConstants.platform == "macosx" &&
      Services.prefs.getBoolPref(FEATURE_PREF, true) &&
      Services.prefs.getBoolPref(SHOW_PREF, true)
    );
  },

  init() {
    if (this._initialized || AppConstants.platform != "macosx") {
      return;
    }
    this._initialized = true;
    const update = () => this.apply();
    Services.prefs.addObserver(FEATURE_PREF, update);
    Services.prefs.addObserver(SHOW_PREF, update);
    this.apply();
  },

  apply() {
    if (this.enabled) {
      this._add();
    } else {
      this._remove();
    }
  },

  _statusBar() {
    return Cc["@mozilla.org/widget/systemstatusbar;1"].getService(Ci.nsISystemStatusBar);
  },

  // The menu element lives in the most recent window's document (any
  // window's chrome document works; the status bar service only cares
  // about the element itself, not which window it came from).
  _add() {
    if (this._menu) {
      return;
    }
    const win = Services.wm.getMostRecentWindow(null);
    const doc = win?.document;
    if (!doc) {
      return;
    }
    const menu = doc.createXULElement("menu");
    menu.id = "whimsyMenuBarExtra";
    menu.setAttribute("image", ICON_URL);
    menu.className = "whimsy-menu-bar-extra";
    const popup = doc.createXULElement("menupopup");
    popup.id = "whimsyMenuBarExtraPopup";
    popup.addEventListener("popupshowing", () => this._populate(popup, win));
    menu.append(popup);
    (doc.getElementById("mainPopupSet") ?? doc.documentElement).append(menu);
    try {
      this._statusBar().addItem(menu);
      this._menu = menu;
    } catch (e) {
      console.error("Whimsy: couldn't add the menu bar extra", e);
      menu.remove();
    }
  },

  _remove() {
    if (!this._menu) {
      return;
    }
    const menu = this._menu;
    // Cleared before removeItem, so a failure still leaves `enabled`
    // toggling back on able to create a fresh element rather than reusing
    // one the status bar already forgot.
    this._menu = null;
    try {
      this._statusBar().removeItem(menu);
    } catch (e) {
      console.error("Whimsy: couldn't remove the menu bar extra", e);
    }
    menu.remove();
  },

  async _openQuickWindow(win) {
    try {
      const { WhimsyQuickWindow } = ChromeUtils.importESModule(
        "resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs"
      );
      await WhimsyQuickWindow.open(win.BROWSER_NEW_TAB_URL ?? "about:blank", {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
    } catch (e) {
      // Not landed yet, or it failed: at least bring a window forward.
      console.error("Whimsy: menu bar extra quick window failed", e);
      win.focus();
    }
  },

  _populate(popup, win) {
    while (popup.firstChild) {
      popup.firstChild.remove();
    }
    const doc = popup.ownerDocument;
    const quickWindow = doc.createXULElement("menuitem");
    quickWindow.setAttribute("data-l10n-id", "whimsy-menu-bar-extra-quick-window");
    quickWindow.addEventListener("command", () => {
      const top = Services.wm.getMostRecentWindow(null) ?? win;
      this._openQuickWindow(top);
    });
    popup.append(quickWindow);
    popup.append(doc.createXULElement("menuseparator"));

    const fragment = lazy.RecentlyClosedTabsAndWindowsMenuUtils.getTabsFragment(win, "menuitem");
    if (fragment.children.length) {
      popup.append(fragment);
    } else {
      const none = doc.createXULElement("menuitem");
      none.setAttribute("data-l10n-id", "whimsy-menu-bar-extra-no-recent-tabs");
      none.setAttribute("disabled", "true");
      popup.append(none);
    }
    // Dynamically-inserted elements aren't picked up by the document's own
    // localization pass, so translate the ones Whimsy just added itself.
    doc.l10n?.translateFragment(popup).catch(e => console.error("Whimsy: menu bar extra l10n", e));
  },
};
