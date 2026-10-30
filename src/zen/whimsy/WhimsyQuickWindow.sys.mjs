/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Mini Whimsy (Arc calls this Little Arc; Cmd+Opt+N, and "links from other
// apps open in: Mini Whimsy" in WhimsyExternalLinks): a small window with
// just a URL bar and the page, no sidebar, no space switcher, no tab strip,
// floating above every other window (full Arc parity, decided in the
// build plan). Arc's flow: a link from Slack or Mail, or Cmd+Opt+N for a
// blank one, opens here so it never costs you a tab in one of your spaces;
// glance at it, then either close it (Esc, Cmd+W, or the close button —
// gone for good, no history or session entry) or press "Open in Current
// Space" (Cmd+O, matching Arc) to adopt it into a real tab, or pick a
// different one (Cmd+Opt+O, the caret button). A second link while one is
// already open reuses the same window rather than stacking more, as Arc
// does.
//
// It's an ordinary browser.xhtml window (BrowserWindowTracker.openWindow,
// same primitive Firefox uses for every new window): no new window type,
// no engine change. `_whimsyQuickWindow` is set on the window object itself
// right after creation, read by Whimsy.initWindow before anything else
// runs, which sets `whimsy-quick-window` on <html> for whimsy-browser.css
// to hide the sidebar.
//
// Floating above other windows: the `alwaysontop` window-open feature
// (nsWindowWatcher.cpp parses it into nsIWebBrowserChrome.CHROME_ALWAYS_ON_TOP,
// which nsAppShellService.cpp turns into widget::InitData.mAlwaysOnTop) is
// the mechanism — on macOS, nsCocoaWindow.mm sets NSFloatingWindowLevel and
// NSWindowCollectionBehaviorCanJoinAllSpaces for it (the same flag Firefox's
// own PiP and DevTools-as-window already use; there's no separate
// nsIAppWindow.zLevel in this engine, it was folded into this flag). One
// trade-off worth knowing: an always-on-top *non-popup* window (ours is an
// ordinary WindowType::TopLevel, not Popup) is deliberately shown with
// `orderFront:` rather than `makeKeyAndOrderFront:` so it doesn't steal
// focus just by existing (nsCocoaWindow.mm's Show()) — so `open()` below
// calls `win.focus()` itself once the window exists, which goes through
// nsCocoaWindow::SetFocus and *does* raise+activate it, same as clicking it.

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
const CHOOSE_BUTTON_ID = "whimsy-quick-window-choose-space";
// Zen's own Cmd+O ("Expand Glance"): meaningless in a quick window, which
// never has a Glance, so Mini Whimsy reuses the accelerator for Arc's
// "Open in Current Space" instead (see initChrome).
const GLANCE_EXPAND_KEY_ID = "zen-glance-expand";

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
    // trace". `location` keeps the nav bar/URL bar Mini Whimsy still needs.
    // `alwaysontop` is the floating-above-everything half of Arc parity
    // (see the file banner comment for how this reaches the Cocoa widget).
    const win = lazy.BrowserWindowTracker.openWindow({
      openerWindow: opener,
      args,
      all: false,
      features: `location,resizable,centerscreen,alwaysontop,width=${WIDTH},height=${HEIGHT}`,
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
    // Always-on-top windows don't steal focus just by being shown (so a
    // background PiP-style window doesn't yank focus); Mini Whimsy should
    // still come forward like Arc's Little Arc does, so ask explicitly.
    win.focus();
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

  // The space Cmd+O / the main button's click adopts into: whichever space
  // was active in the window that opened this one (the opener's "current
  // space", matching Arc's Cmd+O), or null when there's no such window.
  defaultSpaceId(win) {
    return this.mainWindow(win.opener)?.gZenWorkspaces?.activeWorkspace ?? null;
  },

  // "Move to space": adopts the quick window's selected tab into that
  // space in the chosen (or most recent) ordinary window, then closes the
  // quick window. Returns the adopted tab, or null.
  moveToSpace(win, spaceId) {
    const target = this.mainWindow(win.opener);
    if (!target?.gZenWorkspaces || !win._whimsyQuickWindow || !spaceId) {
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

  // The quick window's own chrome: an "Open in Current Space" button
  // (Cmd+O) with a small caret beside it to choose a different one
  // (Cmd+Opt+O) — Arc's split button, without relying on a toolbarbutton
  // "menu-button" type this engine doesn't seem to use anywhere else.
  // Added to the nav bar above the content (the sidebar it would normally
  // sit beside is hidden by whimsy-browser.css).
  initChrome(win) {
    const { document } = win;
    // Never let this window's size/position feed back into the ordinary
    // browser windows': browser.xhtml persists screenX/screenY/width/height
    // under the document's root id ("main-window"), the same id every
    // window — quick or not — shares, so a save here would clobber theirs.
    // Dropping `persist` makes AppWindow::SavePersistentAttributes a no-op
    // for this window (it reads the attribute live, at save time).
    document.documentElement.removeAttribute("persist");
    const navbar = document.getElementById(NAVBAR_ID);
    if (!navbar || document.getElementById(MOVE_BUTTON_ID)) {
      return;
    }
    this.disableGlanceExpandKey(win);
    lazy.WhimsyShortcuts.addCommand(win, {
      id: "cmd_whimsyQuickWindowOpenInSpace",
      run: w => {
        const spaceId = this.defaultSpaceId(w);
        if (spaceId) {
          this.moveToSpace(w, spaceId);
        } else {
          this.openSpacePicker(w, w.document.getElementById(MOVE_BUTTON_ID));
        }
      },
      key: { id: "key_whimsyQuickWindowOpenInSpace", key: "O", modifiers: "accel" },
    });
    lazy.WhimsyShortcuts.addCommand(win, {
      id: "cmd_whimsyQuickWindowChooseSpace",
      run: w => this.openSpacePicker(w, w.document.getElementById(MOVE_BUTTON_ID)),
      key: { id: "key_whimsyQuickWindowChooseSpace", key: "O", modifiers: "accel,alt" },
    });
    win.addEventListener("keydown", event => {
      // Arc: "quickly verify the content and hit Esc to vanish the
      // window." Only when nothing closer to the keypress (the URL bar
      // reverting an edit, an open popup) already handled it.
      if (event.key == "Escape" && !event.defaultPrevented) {
        win.close();
      }
    });
    const button = document.createXULElement("toolbarbutton");
    button.id = MOVE_BUTTON_ID;
    button.className = "toolbarbutton-1";
    document.l10n.setAttributes(button, "whimsy-quick-window-move-to-space");
    button.setAttribute("command", "cmd_whimsyQuickWindowOpenInSpace");
    navbar.appendChild(button);
    const choose = document.createXULElement("toolbarbutton");
    choose.id = CHOOSE_BUTTON_ID;
    choose.className = "toolbarbutton-1";
    choose.setAttribute("command", "cmd_whimsyQuickWindowChooseSpace");
    document.l10n.setAttributes(choose, "whimsy-quick-window-choose-space");
    navbar.appendChild(choose);
  },

  // Zen's own Cmd+O ("Expand Glance") would otherwise compete with Mini
  // Whimsy's own Cmd+O for the same accelerator in the same window; a
  // quick window never has a Glance to expand, so it's safe to clear.
  // Same technique WhimsyShortcuts.initWindow uses for rebinding a key:
  // strip its attributes, then re-add its keyset (Gecko only reads <key>s
  // when their keyset is (re)bound).
  disableGlanceExpandKey(win) {
    const key = win.document.getElementById(GLANCE_EXPAND_KEY_ID);
    if (!key) {
      return;
    }
    key.removeAttribute("key");
    key.removeAttribute("keycode");
    key.removeAttribute("modifiers");
    key.removeAttribute("command");
    const keyset = key.parentElement;
    if (keyset) {
      const parent = keyset.parentElement;
      keyset.remove();
      parent?.append(keyset);
    }
  },

  // A small menu of the user's spaces, anchored on the "Open in Current
  // Space" button; choosing one calls moveToSpace.
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
