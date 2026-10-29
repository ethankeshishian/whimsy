/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Little Arc (Arc's Cmd+Opt+N, and "links from other apps open in: Quick
// window" in WhimsyExternalLinks): a small window with just a URL bar and
// the page, no sidebar, no space switcher, no tab strip. Arc's flow: a link
// from Slack or Mail, or Cmd+Opt+N for a blank one, opens here so it never
// costs you a tab in one of your spaces; read it, then either close it
// (gone for good, no history or session entry) or press "Move to space" to
// adopt it into a real tab. A second link while one is already open reuses
// the same window rather than stacking more, as Arc does.
//
// It's an ordinary browser.xhtml window (BrowserWindowTracker.openWindow,
// same primitive Firefox uses for every new window): no new window type,
// no engine change. `_whimsyQuickWindow` is set on the window object itself
// right after creation, read by Whimsy.initWindow before anything else
// runs, which sets `whimsy-quick-window` on <html> for whimsy-browser.css
// to hide the sidebar.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.quick-window";
const WIDTH = 480;
const HEIGHT = 720;
const NAVBAR_ID = "zen-appcontent-navbar-wrapper";
const MOVE_BUTTON_ID = "whimsy-quick-window-move-to-space";

export const WhimsyQuickWindow = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  // Called for every window Whimsy starts in, quick windows included (it
  // no-ops there: a quick window doesn't open another quick window).
  initWindow(win) {
    if (win._whimsyQuickWindow) {
      this.initChrome(win);
      return;
    }
    lazy.WhimsyShortcuts.addCommand(win, {
      id: "cmd_whimsyQuickWindow",
      run: w => this.open(null, { opener: w }),
      key: this.enabled ? { id: "key_whimsyQuickWindow", key: "N", modifiers: "accel,alt" } : null,
    });
    lazy.WhimsyShortcuts.addActions([
      {
        l10nId: "whimsy-action-quick-window",
        command: "cmd_whimsyQuickWindow",
        icon: "chrome://browser/skin/zen-icons/link.svg",
        isAvailable: () => this.enabled,
      },
    ]);
  },

  // Opens `url` (or an empty, URL-bar-focused window for the shortcut) in
  // Whimsy's quick window, reusing one that's already open. Returns the
  // window, or null when the feature is off.
  open(url, { triggeringPrincipal, opener } = {}) {
    if (!this.enabled) {
      return null;
    }
    const existing = this.current();
    if (existing) {
      if (url) {
        existing.gBrowser.selectedBrowser.fixupAndLoadURIString(url, { triggeringPrincipal });
      }
      existing.focus();
      return existing;
    }
    const args = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
    args.data = url || "about:blank";
    // `all: false` (no "toolbar" chrome flag) makes SessionStore treat this
    // as a popup window (it checks aWindow.toolbar.visible): never in the
    // closed-windows list, never restored, matching "closes without a
    // trace". `location` keeps the nav bar/URL bar Little Arc still needs.
    const win = lazy.BrowserWindowTracker.openWindow({
      openerWindow: opener,
      args,
      all: false,
      features: `location,resizable,centerscreen,width=${WIDTH},height=${HEIGHT}`,
    });
    win._whimsyQuickWindow = true;
    this._current = win;
    win.addEventListener(
      "unload",
      () => {
        if (this._current == win) {
          this._current = null;
        }
      },
      { once: true }
    );
    if (!url) {
      win.addEventListener("MozAfterPaint", () => win.gURLBar?.focus(), { once: true });
    }
    return win;
  },

  // The quick window already open, if there's a live one.
  current() {
    const win = this._current;
    return win && !win.closed ? win : null;
  },

  // The most recent ordinary browser window (never a quick window itself),
  // preferring the one that opened this quick window.
  mainWindow(preferred) {
    if (preferred && !preferred.closed && !preferred._whimsyQuickWindow) {
      return preferred;
    }
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (!win.closed && !win._whimsyQuickWindow) {
        return win;
      }
    }
    return null;
  },

  // The spaces a quick window's tab can be moved to.
  spaces(win) {
    return this.mainWindow(win.opener)?.gZenWorkspaces?.getWorkspaces() ?? [];
  },

  // "Move to space": adopts the quick window's selected tab into that
  // space in the chosen (or most recent) ordinary window, then closes the
  // quick window. Returns the adopted tab, or null.
  moveToSpace(win, spaceId) {
    const target = this.mainWindow(win.opener);
    if (!target?.gZenWorkspaces || !win._whimsyQuickWindow) {
      return null;
    }
    const tab = win.gBrowser.selectedTab;
    const adopted = target.gBrowser.adoptTab(tab, { selectTab: true, spaceId });
    if (adopted) {
      target.gZenWorkspaces.lastSelectedWorkspaceTabs[spaceId] = adopted;
      target.focus();
      win.close();
    }
    return adopted ?? null;
  },

  // The quick window's own chrome: just the "Move to space" button, added
  // to the nav bar above the content (the sidebar it would normally sit
  // beside is hidden by whimsy-browser.css).
  initChrome(win) {
    const { document } = win;
    const navbar = document.getElementById(NAVBAR_ID);
    if (!navbar || document.getElementById(MOVE_BUTTON_ID)) {
      return;
    }
    const button = document.createXULElement("toolbarbutton");
    button.id = MOVE_BUTTON_ID;
    button.className = "toolbarbutton-1";
    document.l10n.setAttributes(button, "whimsy-quick-window-move-to-space");
    button.addEventListener("command", () => this.openSpacePicker(win, button));
    navbar.appendChild(button);
  },

  // A small menu of the user's spaces, anchored on the "Move to space"
  // button; choosing one calls moveToSpace.
  openSpacePicker(win, anchor) {
    const { document } = win;
    const spaces = this.spaces(win);
    if (!spaces.length) {
      return;
    }
    let popup = document.getElementById("whimsy-quick-window-space-picker");
    if (!popup) {
      popup = document.createXULElement("menupopup");
      popup.id = "whimsy-quick-window-space-picker";
      popup.addEventListener("command", event => {
        const spaceId = event.target.getAttribute("zen-workspace-id");
        if (spaceId) {
          this.moveToSpace(win, spaceId);
        }
      });
      document.getElementById("mainPopupSet")?.appendChild(popup) ?? document.documentElement.appendChild(popup);
    }
    const main = this.mainWindow(win.opener);
    const items = spaces.map(space => {
      const item = main.gZenWorkspaces.generateMenuItemForWorkspace(space, true);
      item.classList.remove("zen-workspace-context-menu-item");
      return item;
    });
    popup.replaceChildren(...items);
    popup.openPopup(anchor, { position: "after_start" });
  },
};
