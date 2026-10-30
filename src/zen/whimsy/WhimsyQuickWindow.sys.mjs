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
// gone for good, no history or session entry) or press "Open in <Space name>"
// (Cmd+O, matching Arc) to adopt it into a real tab, or pick a
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
const SIZE_PREF = "whimsy.quick-window.size";
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
        this.whenReady(existing).then(() => {
          if (!existing.closed) {
            existing.gBrowser.selectedBrowser.fixupAndLoadURIString(url, {
              triggeringPrincipal: triggeringPrincipal ?? Services.scriptSecurityManager.getSystemPrincipal(),
            });
          }
        });
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
    const { width, height } = this.savedSize();
    const win = lazy.BrowserWindowTracker.openWindow({
      openerWindow: opener,
      args,
      zenSyncedWindow: Services.prefs.getBoolPref("zen.window-sync.prefer-unsynced-windows", false),
      all: false,
      features: `location,resizable,centerscreen,alwaysontopfullscreenaux,width=${width},height=${height}`,
    });
    win._whimsyQuickWindow = true;
    this._current = win;
    // The initial about:blank document unloads before browser.xhtml loads.
    // Only an actual window close ends this window's lifetime.
    const onClosed = subject => {
      if (subject != win) {
        return;
      }
      Services.obs.removeObserver(onClosed, "domwindowclosed");
      if (this._current == win) {
        this._current = null;
      }
    };
    Services.obs.addObserver(onClosed, "domwindowclosed");
    // Always-on-top windows need an explicit focus request. Wait until
    // browser chrome exists so the initial document cannot consume it.
    this.whenReady(win).then(() => {
      if (!win.closed) {
        win.focus();
      }
    });
    if (!url) {
      this.whenReady(win).then(() => {
        if (!win.closed) {
          win.gURLBar?.focus();
        }
      });
    }
    return win;
  },

  // BrowserWindowTracker returns before browser chrome exists. Reused links
  // must wait too, including links arriving while the first window loads.
  whenReady(win) {
    if (win.closed || win.gBrowserInit?.delayedStartupFinished) {
      return Promise.resolve();
    }
    return win._whimsyQuickReady ??= new Promise(resolve => {
      const cleanup = () => {
        Services.obs.removeObserver(observer, "browser-delayed-startup-finished");
        Services.obs.removeObserver(onClosed, "domwindowclosed");
        resolve();
      };
      const onClosed = subject => {
        if (subject == win) {
          cleanup();
        }
      };
      const observer = subject => {
        if (subject == win) {
          cleanup();
        }
      };
      Services.obs.addObserver(observer, "browser-delayed-startup-finished");
      Services.obs.addObserver(onClosed, "domwindowclosed");
    });
  },

  // Arc saves Little Arc's size separately (installed Arc's NSUserDefaults
  // key LittleBrowserWindow_size), rather than overwriting normal windows.
  // Store inner dimensions to match window.open's width/height features.
  savedSize() {
    try {
      const size = JSON.parse(Services.prefs.getStringPref(SIZE_PREF, ""));
      if (Number.isInteger(size.width) && size.width > 0 &&
          Number.isInteger(size.height) && size.height > 0) {
        return size;
      }
    } catch {}
    return { width: WIDTH, height: HEIGHT };
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
      if (!win.closed && !win._whimsyQuickWindow && win.gBrowser) {
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
    if (!target?.gZenWorkspaces || !win._whimsyQuickWindow || !win.gBrowser || !spaceId) {
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

  // The quick window's own chrome: an "Open in <Space name>" button
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
    button.setAttribute("command", "cmd_whimsyQuickWindowOpenInSpace");
    navbar.appendChild(button);
    const choose = document.createXULElement("toolbarbutton");
    choose.id = CHOOSE_BUTTON_ID;
    choose.className = "toolbarbutton-1";
    choose.setAttribute("command", "cmd_whimsyQuickWindowChooseSpace");
    document.l10n.setAttributes(choose, "whimsy-quick-window-choose-space");
    navbar.appendChild(choose);
    this.watchDestination(win);
    const rememberSize = () => {
      if (!win.fullScreen && win.windowState == win.STATE_NORMAL &&
          win.innerWidth > 0 && win.innerHeight > 0) {
        Services.prefs.setStringPref(SIZE_PREF, JSON.stringify({
          width: win.innerWidth, height: win.innerHeight,
        }));
      }
    };
    // Save while the window is live: unload may already have torn down
    // its widget. No coordinates or shared XUL geometry are persisted.
    win.addEventListener("resize", rememberSize);
    win.addEventListener("unload", () => win.removeEventListener("resize", rememberSize), { once: true });
  },

  // Mirror the destination window's rendered Zen theme, including opacity,
  // grain and light/dark contrast. Changing Mini's own active workspace would
  // also change its tab/container state; theme inheritance must not do that.
  watchDestination(win) {
    const doc = win.document;
    const style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
    doc.documentElement.appendChild(style);
    let source;
    const attributes = ["zen-default-theme", "zen-should-be-dark-mode"];
    const copyAttributes = () => {
      if (!source || source.closed) {
        return;
      }
      for (const name of attributes) {
        const value = source.document.documentElement.getAttribute(name);
        if (value === null) {
          doc.documentElement.removeAttribute(name);
        } else if (doc.documentElement.getAttribute(name) !== value) {
          doc.documentElement.setAttribute(name, value);
        }
      }
      for (const id of ["zen-browser-background", "zen-toolbar-background"]) {
        const value = source.document.getElementById(id).getAttribute("zen-show-grainy-background") || "false";
        const target = doc.getElementById(id);
        if (target.getAttribute("zen-show-grainy-background") !== value) {
          target.setAttribute("zen-show-grainy-background", value);
        }
      }
    };
    const update = () => {
      const next = this.mainWindow(win.opener);
      if (next !== source) {
        unwatch();
        source = next;
        if (source) {
          for (const event of ["ZenWorkspacesUIUpdate", "ZenWorkspaceDataChanged"]) {
            source.addEventListener(event, update);
          }
          for (const id of ["main-window", "zen-browser-background", "zen-toolbar-background"]) {
            const element = source.document.getElementById(id);
            if (element) {
              observer.observe(element, { attributes: true, attributeFilter: ["style", "zen-show-grainy-background", ...attributes] });
            }
          }
          source.addEventListener("unload", sourceClosed, { once: true });
          source.gZenWorkspaces?.promiseInitialized?.then(() => {
            if (!win.closed) {
              update();
            }
          });
        }
      }
      const space = source?.gZenWorkspaces?.getActiveWorkspace();
      const button = doc.getElementById(MOVE_BUTTON_ID);
      button.disabled = !space;
      doc.l10n.setAttributes(button, space ? "whimsy-quick-window-move-to-space" :
        "whimsy-quick-window-no-space", space ? { space: space.name } : null);
      if (!space) {
        for (const name of attributes) {
          doc.documentElement.removeAttribute(name);
        }
        style.textContent = "";
        return;
      }
      const rules = [
        [":root", source.document.documentElement,
          ["--zen-primary-color", "--toolbox-textcolor", "--toolbar-color-scheme", "color-scheme"]],
        ["#zen-browser-background", source.document.getElementById("zen-browser-background"),
          ["--zen-main-browser-background", "--zen-grainy-background-opacity"]],
        ["#zen-toolbar-background", source.document.getElementById("zen-toolbar-background"),
          ["--zen-main-browser-background-toolbar", "--zen-grainy-background-opacity"]],
      ];
      const css = rules.map(([selector, element, properties]) => {
        const computed = source.getComputedStyle(element);
        return `${selector} { ${properties.map(name =>
          `${name}: ${computed.getPropertyValue(name)} !important;`).join(" ")} }`;
      }).join("\n");
      if (style.textContent !== css) {
        style.textContent = css;
      }
      copyAttributes();
    };
    const observer = new win.MutationObserver(update);
    const ownObserver = new win.MutationObserver(copyAttributes);
    ownObserver.observe(doc.documentElement, { attributes: true, attributeFilter: attributes });
    for (const id of ["zen-browser-background", "zen-toolbar-background"]) {
      ownObserver.observe(doc.getElementById(id), {
        attributes: true, attributeFilter: ["zen-show-grainy-background"],
      });
    }
    const sourceClosed = () => win.setTimeout(update, 0);
    const unwatch = () => {
      observer.disconnect();
      if (source) {
        for (const event of ["ZenWorkspacesUIUpdate", "ZenWorkspaceDataChanged"]) {
          source.removeEventListener(event, update);
        }
        source.removeEventListener("unload", sourceClosed);
      }
    };
    win.addEventListener("focus", update);
    win.addEventListener("unload", () => {
      unwatch();
      ownObserver.disconnect();
      win.removeEventListener("focus", update);
    }, { once: true });
    update();
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

  // A small menu of the user's spaces, anchored on the "Open in <Space name>"
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
