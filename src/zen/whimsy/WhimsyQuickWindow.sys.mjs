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
// different one (Cmd+Shift+O, the caret button). A second link while one is
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
// Floating above other windows, matching Arc exactly (no deviation): Arc's
// own Little Arc is NOT pinned to every macOS Space — AltTab-macos issue
// #6092 (github.com/lwouis/alt-tab-macos) logged its window level as 0,
// the same as Arc's ordinary AXStandardWindow, and its own bug report
// described opening "a Little Arc window on the same Space as another
// app's window", i.e. it lives on the current Space like a normal window,
// not everywhere at once. But Arc's "Little Arc does not switch the
// desktop, keeping you in the full-screen app" (confirmed behavior, and
// issue #6007 also logged elevated levels of 3/24 at other times) means it
// *can* float above another application's full-screen Space when needed —
// that specific ability is the only part of "always on top" Arc actually
// has. This engine's plain `alwaysontop` window feature doesn't separate
// those two things: nsCocoaWindow.mm bundles NSFloatingWindowLevel with
// NSWindowCollectionBehaviorCanJoinAllSpaces (pinned to *every* Space)
// unconditionally, which is the DevTools-as-window/alert behavior, not
// Arc's. whimsy-alwaysontop-fullscreen-aux.patch (src/widget/cocoa/) adds a
// new `alwaysontopfullscreenaux` window feature/CHROME_ALWAYS_ON_TOP_FULLSCREEN_AUX
// flag that keeps NSFloatingWindowLevel (so `open()`'s `win.focus()` below
// still raises it properly — always-on-top non-popup windows are shown
// with `orderFront:` rather than `makeKeyAndOrderFront:`, so they don't
// steal focus just by existing) but skips CanJoinAllSpaces, and instead
// gives the window NSWindowCollectionBehaviorFullScreenAuxiliary (the same
// behavior the media Picture-in-Picture player already uses for the exact
// same reason) so it can still appear over a full-screen app. Existing
// `alwaysontop` consumers (DevTools-as-window, alerts, media PiP) are
// untouched; this is a new, separate, additive flag.

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
    // `alwaysontopfullscreenaux` is the floating half of Arc parity: its
    // own Space, plus able to float over another app's full-screen Space,
    // but not pinned to every ordinary Space (see the file banner comment
    // for the Arc evidence and how this reaches the Cocoa widget).
    const win = lazy.BrowserWindowTracker.openWindow({
      openerWindow: opener,
      args,
      all: false,
      features: `location,resizable,centerscreen,alwaysontopfullscreenaux,width=${WIDTH},height=${HEIGHT}`,
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
  // (Cmd+Shift+O) — Arc's split button, without relying on a toolbarbutton
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
      key: { id: "key_whimsyQuickWindowChooseSpace", key: "O", modifiers: "accel,shift" },
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
    // Cmd+O is Zen's "Expand Glance" and Cmd+Shift+O Firefox's "Show All
    // Bookmarks"; in a quick window both belong to Arc's move-to-space keys.
    for (const id of [GLANCE_EXPAND_KEY_ID, "manBookmarkKb"]) {
      const key = win.document.getElementById(id);
      if (!key) {
        continue;
      }
      for (const attr of ["data-l10n-id", "key", "keycode", "modifiers", "command"]) {
        key.removeAttribute(attr);
      }
      const keyset = key.parentElement;
      if (keyset) {
        const parent = keyset.parentElement;
        keyset.remove();
        parent?.append(keyset);
      }
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
