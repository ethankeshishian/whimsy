/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Mini Whimsy (Arc calls this Little Arc; Cmd+Opt+N, and "links from other
// apps open in: Mini Whimsy" in WhimsyExternalLinks): a small window with
// one slim bar over the page (Arc's Little Arc layout, see initChrome), no
// sidebar, no space switcher, no tab strip, no native title bar,
// floating above every other window (full Arc parity, decided in the
// build plan). Arc's flow: a link from Slack or Mail opens here so it never
// costs you a tab in one of your spaces; glance at it, then either close it
// (Cmd+W or the close button — gone for good, no history or session entry)
// or press "Open in <Space name>" (Cmd+O, matching Arc) to adopt it into a
// real tab, or pick a different one (the caret button or Cmd+Shift+O).
// wave7, from the 120 fps recording little-095501:
// - Cmd+Opt+N first shows only a floating command-bar panel at the
//   screen's top-right (Arc: ~510x335pt). Return materialises the full
//   window, right-anchored, with a space-gradient placeholder until the
//   page paints (see materialise).
// - Esc does not close Mini (it only closes its command bar), except in
//   the bar-only panel, where dismissing the bar is all there is to close.
// - A second link opens a second Mini stacked over the first, offset down,
//   rather than replacing the page you were reading.
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
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.quick-window";
const WIDTH = 1260;
const HEIGHT = 780;
const SIZE_PREF = "whimsy.quick-window.size";
// wave7: Cmd+Opt+N's bar-only panel (Arc's Little Arc before ↵: ~510x335pt,
// a search field plus five rows, ~8pt in from the screen's top-right).
const PANEL_WIDTH = 510;
const PANEL_HEIGHT = 335;
const PANEL_MARGIN = 8;
// A second Mini lands this far below the one it stacks over.
const STACK_OFFSET = 28;
// The placeholder gives way when the page has loaded, or after this long.
const PLACEHOLDER_MAX_MS = 5000;
const BAR_ONLY_ATTR = "whimsy-mini-bar-only";
const PLACEHOLDER_ATTR = "whimsy-mini-placeholder";
const NAVBAR_ID = "zen-appcontent-navbar-wrapper";
const BAR_ID = "whimsy-quick-window-bar";
const BACK_BUTTON_ID = "whimsy-quick-window-back";
const ADDRESS_ID = "whimsy-quick-window-address";
const COPY_BUTTON_ID = "whimsy-quick-window-copy-link";
const ADDRESS_FIELD_ID = "whimsy-quick-window-address-field";
const SPACE_PICKER_ID = "whimsy-quick-window-space-picker";
const OPEN_GROUP_ID = "whimsy-quick-window-open";
const MOVE_BUTTON_ID = "whimsy-quick-window-move-to-space";
const CHOOSE_BUTTON_ID = "whimsy-quick-window-choose-space";
// Zen's own Cmd+O ("Expand Glance"): meaningless in a quick window, which
// never has a Glance, so Mini Whimsy reuses the accelerator for Arc's
// "Open in Current Space" instead (see initChrome).
const GLANCE_EXPAND_KEY_ID = "zen-glance-expand";

const READY_TOPIC = "whimsy-quick-window-ready";
const pointerPositions = new WeakMap();
const readyLayouts = new WeakMap();

export const WhimsyQuickWindow = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  // Called for every window Whimsy starts in, quick windows included (it
  // no-ops there: a quick window doesn't open another quick window).
  initWindow(win) {
    if (win._whimsyQuickWindow) {
      try {
        this.initChrome(win);
      } finally {
        win._whimsyQuickChromeReady = true;
        Services.obs.notifyObservers(win, READY_TOPIC);
      }
      return;
    }
    win.addEventListener("pointermove", event => {
      pointerPositions.set(win, { x: event.screenX, y: event.screenY });
    }, { passive: true });
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyQuickWindow",
      l10nId: "whimsy-action-quick-window",
      run: w => this.open(null, { opener: w }),
      keyId: "key_whimsyQuickWindow",
      key: this.enabled ? { key: "N", modifiers: "accel,alt" } : null,
      icon: "chrome://browser/skin/zen-icons/link.svg",
      isAvailable: () => this.enabled,
    });
  },

  // Opens `url` in a new Mini Whimsy window, stacked over the newest one
  // already open (Arc opens a second Little Arc rather than reusing the
  // first). With no `url` (Cmd+Opt+N) it opens the bar-only command-bar
  // panel instead. Returns the window, or null when the feature is off.
  // (`triggeringPrincipal` is accepted for callers; the URL goes in as the
  // new window's argument, like any other new browser window.)
  open(url, { opener } = {}) {
    if (!this.enabled) {
      return null;
    }
    // A link stacks over the newest Mini showing a page (never a panel).
    const below = url ? this.windows().filter(w => !w._whimsyMiniBarOnly).at(-1) : null;
    const barOnly = !url;
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
    const { left, top, width, height } = this.initialRect({ opener, below, barOnly });
    const position = left === undefined ? "centerscreen" : `left=${left},top=${top}`;
    const win = lazy.BrowserWindowTracker.openWindow({
      openerWindow: opener,
      args,
      zenSyncedWindow: Services.prefs.getBoolPref("zen.window-sync.prefer-unsynced-windows", false),
      all: false,
      features: `location,resizable,${position},alwaysontopfullscreenaux,width=${width},height=${height}`,
    });
    win._whimsyQuickWindow = true;
    win._whimsyMiniBarOnly = barOnly;
    this._windows = (this._windows ?? []).filter(w => !w.closed);
    this._windows.push(win);
    // The initial about:blank document unloads before browser.xhtml loads.
    // Only an actual window close ends this window's lifetime.
    // Before the window is first shown: Mini's look (no native title bar,
    // no sidebar) from the first frame, not after Whimsy's later setup.
    const beforeShow = subject => {
      if (subject != win) {
        return;
      }
      Services.obs.removeObserver(beforeShow, "browser-window-before-show");
      const root = win.document.documentElement;
      root.setAttribute("whimsy-quick-window", "");
      root.toggleAttribute(BAR_ONLY_ATTR, !!win._whimsyMiniBarOnly);
      this.useCustomTitlebar(win);
    };
    Services.obs.addObserver(beforeShow, "browser-window-before-show");
    const onClosed = subject => {
      if (subject != win) {
        return;
      }
      Services.obs.removeObserver(onClosed, "domwindowclosed");
      try {
        Services.obs.removeObserver(beforeShow, "browser-window-before-show");
      } catch {}
      this._windows = this._windows.filter(w => w != win && !w.closed);
    };
    Services.obs.addObserver(onClosed, "domwindowclosed");
    // Always-on-top windows need an explicit focus request. Wait until
    // browser chrome exists so the initial document cannot consume it.
    this.whenReady(win).then(() => {
      if (!win.closed) {
        win.focus();
        if (barOnly) {
          // Arc: Cmd+Opt+N opens Little Arc as just its command bar.
          this.openCommandBar(win);
        }
      }
    });
    return win;
  },

  // Where a new Mini opens, in screen pixels (left/top undefined: centred).
  // The bar-only panel sits at the screen's top-right; a link Mini centres
  // on the pointer, or stacks STACK_OFFSET below the Mini it opens over.
  initialRect({ opener, below, barOnly }) {
    const screen = (opener ?? this.mainWindow(null))?.screen;
    const saved = barOnly ? { width: PANEL_WIDTH, height: PANEL_HEIGHT } : this.savedSize();
    const width = Math.min(saved.width, screen?.availWidth || saved.width);
    const height = Math.min(saved.height, screen?.availHeight || saved.height);
    if (!screen) {
      return { width, height };
    }
    const clamp = (value, min, size, extent) =>
      Math.round(Math.max(min, Math.min(value, min + size - extent)));
    const { availLeft, availTop, availWidth, availHeight } = screen;
    if (barOnly) {
      return {
        left: clamp(availLeft + availWidth - width - PANEL_MARGIN, availLeft, availWidth, width),
        top: clamp(availTop + PANEL_MARGIN, availTop, availHeight, height),
        width, height,
      };
    }
    if (below) {
      return {
        left: clamp(below.screenX, availLeft, availWidth, width),
        top: clamp(below.screenY + STACK_OFFSET, availTop, availHeight, height),
        width, height,
      };
    }
    const pointer = opener && pointerPositions.get(opener);
    if (!pointer) {
      return { width, height };
    }
    return {
      left: clamp(pointer.x - width / 2, availLeft, availWidth, width),
      top: clamp(pointer.y - height / 2, availTop, availHeight, height),
      width, height,
    };
  },

  // BrowserWindowTracker returns before browser chrome exists. Reused links
  // must wait too, including links arriving while the first window loads.
  // Ready means delayed startup finished and Whimsy has set up Mini's own
  // chrome (Zen's startup calls Whimsy.initWindow later than that).
  isReady(win) {
    return !!(win.gBrowserInit?.delayedStartupFinished && win._whimsyQuickChromeReady);
  },

  whenReady(win) {
    if (!readyLayouts.has(win)) {
      readyLayouts.set(win, this.whenChromeReady(win).then(async () => {
        if (win.closed) {
          return;
        }
        await win.promiseDocumentFlushed(() => {});
        const animations = win.document.getElementById("browser")?.getAnimations() || [];
        await Promise.all(animations.filter(a => a.animationName == "whimsy-mini-open")
          .map(a => a.finished.catch(() => {})));
        if (!win.closed) {
          await win.promiseDocumentFlushed(() => {});
        }
      }));
    }
    return readyLayouts.get(win);
  },

  whenChromeReady(win) {
    if (win.closed || this.isReady(win)) {
      return Promise.resolve();
    }
    return win._whimsyQuickReady ??= new Promise(resolve => {
      const topics = ["browser-delayed-startup-finished", READY_TOPIC, "domwindowclosed"];
      const observer = subject => {
        if (subject == win && (win.closed || this.isReady(win) || !win._whimsyQuickWindow)) {
          for (const topic of topics) {
            Services.obs.removeObserver(observer, topic);
          }
          resolve();
        }
      };
      for (const topic of topics) {
        Services.obs.addObserver(observer, topic);
      }
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

  // The newest Mini window still open, if any.
  current() {
    return this.windows().at(-1) ?? null;
  },

  // Every open Mini window, oldest first (a second link stacks a new one).
  windows() {
    return (this._windows ?? []).filter(w => !w.closed);
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

  // wave6/parity: Little Arc fades out in place (~100 ms, no scale) when it
  // closes. Every close path (Cmd+W on its one tab, the close button, Esc in
  // the bar-only panel, moving the page to a space) ends in win.close(), so that's where the
  // fade goes; with reduced motion it closes at once.
  fadeOnClose(win) {
    const close = win.close.bind(win);
    win.close = () => {
      const root = win.document.documentElement;
      if (root.hasAttribute("whimsy-mini-closing")) {
        return;
      }
      if (win.matchMedia("(prefers-reduced-motion: reduce)").matches || win.closed) {
        close();
        return;
      }
      root.setAttribute("whimsy-mini-closing", "");
      const ms = parseFloat(win.getComputedStyle(root).getPropertyValue("--whimsy-mini-close-duration")) || 100;
      win.setTimeout(close, ms);
    };
  },

  // wave7: the bar-only panel Cmd+Opt+N opens. It stays a panel until a
  // page starts loading (Return in its command bar), then materialises.
  // While it's a panel, bringing it back to the front reopens its bar.
  watchBarOnly(win) {
    if (!win._whimsyMiniBarOnly) {
      return;
    }
    win.document.documentElement.setAttribute(BAR_ONLY_ATTR, "");
    const { gBrowser } = win;
    const { STATE_START, STATE_IS_NETWORK } = Ci.nsIWebProgressListener;
    const isPage = spec => !!spec && spec != "about:blank" && !win.isBlankPageURL?.(spec);
    const listener = {
      onStateChange: (webProgress, request, flags) => {
        if (!webProgress?.isTopLevel || !(flags & STATE_START) || !(flags & STATE_IS_NETWORK)) {
          return;
        }
        let spec = "";
        try {
          spec = request.QueryInterface(Ci.nsIChannel).URI.spec;
        } catch {
          spec = request?.name ?? "";
        }
        if (isPage(spec)) {
          this.materialise(win);
        }
      },
      onLocationChange: (webProgress, request, location) => {
        if (webProgress?.isTopLevel && isPage(location?.spec)) {
          this.materialise(win);
        }
      },
      QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
    };
    const reopen = () => {
      if (win._whimsyMiniBarOnly && !win.gURLBar?.focused) {
        this.openCommandBar(win);
      }
    };
    const stop = () => {
      gBrowser.removeProgressListener(listener);
      win.removeEventListener("activate", reopen);
    };
    win._whimsyMiniStopBarOnly = stop;
    gBrowser.addProgressListener(listener);
    win.addEventListener("activate", reopen);
    win.addEventListener("unload", stop, { once: true });
  },

  // The panel becomes the full Mini window: Mini's saved size, still
  // anchored at the panel's right edge (as Arc's grows), with the destination
  // space's gradient standing in for the page until it has loaded. The
  // content grows in with the open motion; reduced motion skips it.
  materialise(win) {
    if (!win._whimsyMiniBarOnly || win.closed) {
      return;
    }
    win._whimsyMiniBarOnly = false;
    win._whimsyMiniStopBarOnly?.();
    const root = win.document.documentElement;
    root.setAttribute(PLACEHOLDER_ATTR, "");
    root.removeAttribute(BAR_ONLY_ATTR);

    const { width, height } = this.savedSize();
    const { availLeft, availTop, availWidth, availHeight } = win.screen;
    const outerWidth = Math.min(width + win.outerWidth - win.innerWidth, availWidth);
    const outerHeight = Math.min(height + win.outerHeight - win.innerHeight, availHeight);
    const right = win.screenX + win.outerWidth;
    const left = Math.max(availLeft, Math.min(right - outerWidth, availLeft + availWidth - outerWidth));
    const top = Math.max(availTop, Math.min(win.screenY, availTop + availHeight - outerHeight));
    win.moveTo(Math.round(left), Math.round(top));
    win.resizeTo(Math.round(outerWidth), Math.round(outerHeight));

    const browser = win.document.getElementById("browser");
    if (browser && !win.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const style = win.getComputedStyle(root);
      const duration = parseFloat(style.getPropertyValue("--whimsy-mini-open-duration")) || 90;
      const easing = style.getPropertyValue("--whimsy-mini-ease-out").trim() || "ease-out";
      browser.animate([
        { transform: "scale(.1)", transformOrigin: "top right" },
        { transform: "none", transformOrigin: "top right" },
      ], { duration, easing });
    }

    // The placeholder gives way once the page has loaded (or errored), or
    // after PLACEHOLDER_MAX_MS, whichever comes first.
    const { gBrowser } = win;
    const { STATE_STOP, STATE_IS_NETWORK } = Ci.nsIWebProgressListener;
    let timer;
    const done = () => {
      win.clearTimeout(timer);
      try {
        gBrowser.removeProgressListener(listener);
      } catch {}
      if (!win.closed) {
        root.removeAttribute(PLACEHOLDER_ATTR);
      }
    };
    const listener = {
      onStateChange: (webProgress, request, flags) => {
        if (webProgress?.isTopLevel && flags & STATE_STOP && flags & STATE_IS_NETWORK) {
          done();
        }
      },
      QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
    };
    gBrowser.addProgressListener(listener);
    timer = win.setTimeout(done, PLACEHOLDER_MAX_MS);
    win.addEventListener("unload", done, { once: true });
  },

  // The quick window's own chrome, laid out like Arc's Little Arc: one slim
  // bar above the page, on the destination space's colours (see
  // watchDestination), holding the window controls, Back, the address
  // (profile + host; clicking it opens the command bar, Cmd+L) with the
  // Extensions and Copy URL (Cmd+Shift+C) buttons inside its right end, as
  // in Little Arc, and the "Open in <Space name>" split button (Cmd+O, with
  // a caret for the space dropdown, Cmd+Shift+O). Below it the page is the same inset rounded
  // card as in a main window. Zen's own nav bar and sidebar stay hidden.
  initChrome(win) {
    const { document } = win;
    // Mini is often closed moments after it opens. A urlbar query still
    // running then (Top Sites, started when its address bar wakes up) would
    // deliver results to a window whose urlbar actor is gone, which throws in
    // Firefox's controller; stop it as the window goes.
    win.addEventListener(
      "unload",
      () => {
        try {
          win.gURLBar?.controller?.cancelQuery?.();
        } catch (e) {
          // Already torn down.
        }
      },
      { once: true }
    );
    // Never let this window's size/position feed back into the ordinary
    // browser windows': browser.xhtml persists screenX/screenY/width/height
    // under the document's root id ("main-window"), the same id every
    // window — quick or not — shares, so a save here would clobber theirs.
    // Dropping `persist` makes AppWindow::SavePersistentAttributes a no-op
    // for this window (it reads the attribute live, at save time).
    document.documentElement.removeAttribute("persist");
    const navbar = document.getElementById(NAVBAR_ID);
    if (!navbar || document.getElementById(BAR_ID)) {
      return;
    }
    this.useCustomTitlebar(win);
    this.useFloatingCommandBar(win);
    this.disableGlanceExpandKey(win);
    lazy.WhimsyShortcuts.addCommand(win, {
      id: "cmd_whimsyQuickWindowOpenInSpace",
      run: w => {
        if (w._whimsyMiniBarOnly) {
          return;
        }
        const spaceId = this.defaultSpaceId(w);
        if (spaceId) {
          this.moveToSpace(w, spaceId);
        } else {
          this.openSpacePicker(w, w.document.getElementById(OPEN_GROUP_ID));
        }
      },
      key: { id: "key_whimsyQuickWindowOpenInSpace", key: "O", modifiers: "accel" },
    });
    lazy.WhimsyShortcuts.addCommand(win, {
      id: "cmd_whimsyQuickWindowChooseSpace",
      run: w => !w._whimsyMiniBarOnly && this.openSpacePicker(w, w.document.getElementById(OPEN_GROUP_ID)),
      // fix7: Cmd+Shift+O opens the same dropdown as the chevron (the user
      // keeps this key; wave6/parity had dropped it). Firefox's Show All
      // Bookmarks gives it up in Mini only, see disableGlanceExpandKey.
      key: { id: "key_whimsyQuickWindowChooseSpace", key: "O", modifiers: "accel,shift" },
    });
    // wave7: Esc never closes a materialised Mini (Arc's Little Arc keeps
    // its window; Esc only closes the command bar). In the bar-only panel
    // the command bar is all there is, so Esc dismisses the panel.
    win.addEventListener("keydown", event => {
      if (event.key == "Escape" && win._whimsyMiniBarOnly) {
        event.preventDefault();
        event.stopPropagation();
        win.close();
      }
    }, { capture: true });
    this.fadeOnClose(win);
    this.watchBarOnly(win);
    navbar.before(this.buildBar(win));
    this.adoptWindowButtons(win);
    this.watchDestination(win);
    this.watchPage(win);
    const rememberSize = () => {
      // The bar-only panel's size is Arc's fixed one, not Mini's.
      if (!win._whimsyMiniBarOnly && !win.fullScreen && win.windowState == win.STATE_NORMAL &&
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

  buildBar(win) {
    const { document } = win;
    const html = tag => document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    const button = (id, l10nId, attrs = {}) => {
      const el = document.createXULElement("toolbarbutton");
      el.id = id;
      el.className = "whimsy-mini-button tabbable";
      el.setAttribute("tabindex", "0");
      for (const [name, value] of Object.entries(attrs)) {
        el.setAttribute(name, value);
      }
      if (l10nId) {
        document.l10n.setAttributes(el, l10nId);
      }
      return el;
    };
    const bar = html("div");
    bar.id = BAR_ID;
    bar.setAttribute("role", "toolbar");
    document.l10n.setAttributes(bar, "whimsy-quick-window-bar");

    // Arc's Little Arc has Back but no Forward. Browser:Back keeps its own
    // disabled state, so the button never moves (it only dims).
    const back = button(BACK_BUTTON_ID, "whimsy-quick-window-back", { command: "Browser:Back" });

    // The address: what Arc shows (favicon + bare host), not an editable
    // field. Editing happens in the command bar it opens, as in Arc.
    const address = html("button");
    address.id = ADDRESS_ID;
    address.setAttribute("type", "button");
    document.l10n.setAttributes(address, "whimsy-quick-window-address");
    const host = html("span");
    host.className = "whimsy-mini-host";
    const profile = html("span");
    profile.className = "whimsy-mini-profile";
    document.l10n.setAttributes(profile, "whimsy-quick-window-profile");
    address.append(profile, host);
    address.addEventListener("click", () => this.openCommandBar(win));

    const copy = button(COPY_BUTTON_ID, "whimsy-quick-window-copy-link", { command: "cmd_zenCopyCurrentURL" });

    // "Open in <Space>" + caret, one pill split by a hairline (Arc's split
    // button). The button's image is the space's own icon.
    const group = html("div");
    group.id = OPEN_GROUP_ID;
    const move = button(MOVE_BUTTON_ID, null, { command: "cmd_whimsyQuickWindowOpenInSpace" });
    const choose = button(CHOOSE_BUTTON_ID, "whimsy-quick-window-choose-space", {
      command: "cmd_whimsyQuickWindowChooseSpace",
    });
    const shortcut = html("kbd");
    shortcut.textContent = "⌘O";
    shortcut.setAttribute("aria-hidden", "true");
    group.append(move, shortcut, choose);

    // fix7: Little Arc draws Extensions and Copy Link inside the address
    // strip, at its right end. The strip is a plain container (a button
    // can't hold buttons); the address button fills the rest of it.
    const field = html("div");
    field.id = ADDRESS_FIELD_ID;
    field.append(address, copy);
    bar.append(back, field, group);
    this.placeExtensionsButton(win);
    return bar;
  },

  // Reuse Firefox's real extensions button and panel, rather than a
  // separate picker with different extension behavior. It sits in the
  // address strip before Copy Link. Zen's toolbar re-layout prepends it to
  // the sidebar's top buttons again, so adoptWindowButtons calls this back.
  placeExtensionsButton(win) {
    const { document } = win;
    const extensions = document.getElementById("unified-extensions-button");
    const copy = document.getElementById(COPY_BUTTON_ID);
    if (!extensions || !copy || extensions.nextElementSibling == copy) {
      return;
    }
    extensions.classList.add("whimsy-mini-button", "tabbable");
    extensions.setAttribute("tabindex", "0");
    copy.before(extensions);
    // Zen normally anchors this panel to its site-controls icon. That
    // icon is in Mini's parked nav bar; use the visible puzzle button.
    if (win.gUnifiedExtensions) {
      win.gUnifiedExtensions._button = extensions;
    }
  },

  // Popup windows (Mini opens as one, so it never lands in session history)
  // get a native, grey macOS title bar from Firefox's TabBarVisibility.
  // Arc's Little Arc has none: the bar *is* the title bar, traffic lights
  // and all. Keep the custom (drawn-in) titlebar on for this window only.
  useCustomTitlebar(win) {
    const { CustomTitlebar, TabBarVisibility } = win;
    if (!CustomTitlebar?.allowedBy || !TabBarVisibility?.update || win._whimsyQuickTitlebar) {
      return;
    }
    win._whimsyQuickTitlebar = true;
    const allowedBy = CustomTitlebar.allowedBy;
    CustomTitlebar.allowedBy = function (condition, allow) {
      // Intercept the popup policy itself. Re-enabling after update() would
      // recursively toggle it off/on through CustomTitlebar._update().
      return allowedBy.call(this, condition,
        condition == "non-popup" || condition == "pref" ? true : allow);
    };
    CustomTitlebar.allowedBy("non-popup", true);
    CustomTitlebar.allowedBy("pref", true);
  },

  // Firefox makes a popup's address bar read-only, and Zen only floats its
  // URL bar ("command bar") on some paths. Mini has no sidebar for it to
  // sit in, so it always floats, centred over the page, like the command
  // bar Arc opens from Little Arc's address.
  useFloatingCommandBar(win) {
    const urlbar = win.gURLBar;
    if (!urlbar) {
      return;
    }
    urlbar.readOnly = false;
    Object.defineProperty(urlbar, "zenUrlbarBehavior", {
      configurable: true,
      get: () => "float",
    });
  },

  openCommandBar(win) {
    if (win.gURLBar) {
      win.gURLBar.readOnly = false;
      // Reveal the input before focusing it: its normal toolbar is collapsed
      // in Mini, and focusing a hidden input cannot open its popover.
      win.gURLBar.setAttribute("breakout-extend", "true");
    }
    const command = win.document.getElementById("Browser:OpenLocation");
    if (command) {
      command.doCommand();
    } else {
      win.gURLBar?.select();
    }
  },

  // The traffic lights (macOS) or caption buttons live in Zen's sidebar,
  // which Mini hides; they belong at the bar's edge. Zen may move them
  // back when it re-lays out its toolbars, so keep them here.
  adoptWindowButtons(win) {
    const { document } = win;
    const bar = document.getElementById(BAR_ID);
    const find = () => win.gZenVerticalTabsManager?.actualWindowButtons ??
      document.querySelector(".titlebar-buttonbox-container");
    const adopt = () => {
      let buttons;
      try {
        buttons = find();
      } catch {}
      if (buttons && buttons.parentNode != bar) {
        bar.prepend(buttons);
      }
      this.placeExtensionsButton(win);
    };
    adopt();
    const observer = new win.MutationObserver(adopt);
    for (const id of ["navigator-toolbox", NAVBAR_ID, BAR_ID]) {
      const area = document.getElementById(id);
      if (area) {
        observer.observe(area, { childList: true, subtree: true });
      }
    }
    win.addEventListener("unload", () => observer.disconnect(), { once: true });
  },

  // Keeps the address (favicon + host) and its tooltip on the current page.
  watchPage(win) {
    const { document, gBrowser } = win;
    const address = document.getElementById(ADDRESS_ID);
    const host = address.querySelector(".whimsy-mini-host");
    const copy = document.getElementById(COPY_BUTTON_ID);
    const update = () => {
      if (win.closed) {
        return;
      }
      const tab = gBrowser.selectedTab;
      const uri = gBrowser.selectedBrowser.currentURI;
      const spec = uri?.spec ?? "";
      const blank = !spec || spec == "about:blank" || !!win.isBlankPageURL?.(spec);
      let name = "";
      if (!blank) {
        try {
          name = uri.host;
        } catch {}
        name = (name || uri.displaySpec || spec).replace(/^www\./, "");
      }
      address.toggleAttribute("blank", blank);
      copy.disabled = blank;
      if (blank) {
        host.removeAttribute("data-l10n-id");
        host.textContent = "about:blank";
      } else {
        host.removeAttribute("data-l10n-id");
        host.removeAttribute("data-l10n-args");
        host.textContent = name;
      }
      const title = blank ? "" : tab.label || name;
      if (address.dataset.page != `${title}\n${spec}`) {
        address.dataset.page = `${title}\n${spec}`;
        document.l10n.setAttributes(address, blank ? "whimsy-quick-window-address" :
          "whimsy-quick-window-address-page", blank ? null : { title, url: uri.displaySpec || spec });
      }
    };
    const listener = {
      onLocationChange: update,
      QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
    };
    gBrowser.addProgressListener(listener);
    gBrowser.tabContainer.addEventListener("TabAttrModified", update);
    gBrowser.tabContainer.addEventListener("TabSelect", update);
    win.addEventListener("unload", () => {
      gBrowser.removeProgressListener(listener);
      gBrowser.tabContainer.removeEventListener("TabAttrModified", update);
      gBrowser.tabContainer.removeEventListener("TabSelect", update);
    }, { once: true });
    update();
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
      const icon = this.spaceIcon(space);
      if (icon) {
        button.setAttribute("image", icon);
      } else {
        button.removeAttribute("image");
      }
      if (!space) {
        for (const name of attributes) {
          doc.documentElement.removeAttribute(name);
        }
        style.textContent = "";
        return;
      }
      // Doubled attribute: outranks Zen's own window-state rules such as
      // :root[zen-unsynced-window="true"] (Mini opens unsynced).
      const root = ":root[whimsy-quick-window][whimsy-quick-window]";
      const rules = [
        [root, source.document.documentElement,
          ["--zen-primary-color", "--toolbox-textcolor", "--toolbar-color-scheme", "color-scheme"]],
        [`${root} #zen-browser-background`, source.document.getElementById("zen-browser-background"),
          ["--zen-main-browser-background", "--zen-grainy-background-opacity"]],
        [`${root} #zen-toolbar-background`, source.document.getElementById("zen-toolbar-background"),
          ["--zen-main-browser-background-toolbar", "--zen-grainy-background-opacity"]],
      ];
      const css = rules.map(([selector, element, properties]) => {
        const computed = source.getComputedStyle(element);
        return `${selector} { ${properties.map(name =>
          `${name}: ${computed.getPropertyValue(name)} !important;`).join(" ")} }`;
      });
      // wave7: the space's own gradient, for the placeholder a freshly
      // materialised Mini shows until its page paints.
      const gradient = source.getComputedStyle(source.document.getElementById("zen-browser-background"))
        .getPropertyValue("--zen-main-browser-background").trim();
      if (gradient) {
        css.push(`${root} { --whimsy-mini-space-gradient: ${gradient}; }`);
      }
      const text = css.join("\n");
      if (style.textContent !== text) {
        style.textContent = text;
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

  // The space's icon as an image URL: Zen's SVG icons as they are, an
  // emoji drawn into a small SVG (toolbarbutton images are URLs only).
  spaceIcon(space) {
    const icon = space?.icon?.trim();
    if (!icon) {
      return null;
    }
    if (icon.endsWith(".svg") || /^(chrome|resource|moz-extension|data):/.test(icon)) {
      return icon;
    }
    const text = icon.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
    return "data:image/svg+xml," + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">` +
      `<text x="8" y="8" dominant-baseline="central" text-anchor="middle" font-size="13">${text}</text></svg>`);
  },

  // Zen's own Cmd+O ("Expand Glance") would otherwise compete with Mini
  // Whimsy's own Cmd+O for the same accelerator in the same window; a
  // quick window never has a Glance to expand, so it's safe to clear.
  // Same technique WhimsyShortcuts.initWindow uses for rebinding a key:
  // strip its attributes, then re-add its keyset (Gecko only reads <key>s
  // when their keyset is (re)bound).
  disableGlanceExpandKey(win) {
    // Cmd+O is Zen's "Expand Glance" and Cmd+Shift+O Firefox's "Show All
    // Bookmarks"; in a quick window they open the page in a space and open
    // the space dropdown.
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

  // fix7: Little Arc's space dropdown, from the caret or Cmd+Shift+O: a
  // Zen-style menu headed "Open in", one row per space with its icon on a
  // tile of the space's own colour (a colour dot when it has no icon). The
  // space Cmd+O uses shows that shortcut. Choosing a row calls moveToSpace.
  // Anchored under the split button, end-aligned, as Arc's drops from its
  // right edge; Zen's menu motion and reduced-motion handling apply.
  openSpacePicker(win, anchor) {
    const { document } = win;
    const spaces = this.spaces(win);
    if (!spaces.length) {
      return;
    }
    let popup = document.getElementById(SPACE_PICKER_ID);
    if (!popup) {
      popup = document.createXULElement("menupopup");
      popup.id = SPACE_PICKER_ID;
      popup.addEventListener("command", event => {
        const spaceId = event.target.getAttribute("zen-workspace-id");
        if (spaceId) {
          this.moveToSpace(win, spaceId);
        }
      });
      // The caret reads as pressed while its menu is open.
      const choose = () => document.getElementById(CHOOSE_BUTTON_ID);
      popup.addEventListener("popupshowing", () => choose()?.setAttribute("open", "true"));
      popup.addEventListener("popuphidden", () => choose()?.removeAttribute("open"));
      document.getElementById("mainPopupSet")?.appendChild(popup) ?? document.documentElement.appendChild(popup);
    }
    const caption = document.createXULElement("menucaption");
    caption.className = "whimsy-mini-picker-caption";
    document.l10n.setAttributes(caption, "whimsy-quick-window-picker-caption");
    const defaultId = this.defaultSpaceId(win);
    const items = spaces.map(space => {
      const item = document.createXULElement("menuitem");
      item.className = "menuitem-iconic whimsy-mini-picker-space";
      item.setAttribute("zen-workspace-id", space.uuid);
      item.setAttribute("label", space.name);
      item.setAttribute("image", this.spaceIcon(space) ?? this.spaceDot(space));
      const color = this.spaceColor(space);
      if (color) {
        item.style.setProperty("--whimsy-space-color", color);
      }
      if (space.uuid == defaultId) {
        item.setAttribute("key", "key_whimsyQuickWindowOpenInSpace");
        item.setAttribute("default", "true");
      }
      return item;
    });
    popup.replaceChildren(caption, ...items);
    popup.openPopup(anchor, { position: "after_end" });
  },

  // A space's first theme colour as CSS, or null for Zen's default theme.
  spaceColor(space) {
    const rgb = space?.theme?.gradientColors?.[0]?.c;
    return Array.isArray(rgb) && rgb.length >= 3 ? `rgb(${rgb.slice(0, 3).join(" ")})` : null;
  },

  // A space with no icon gets a dot in its colour (a mid grey, readable in
  // light and dark menus, for Zen's default theme). Context paint isn't
  // allowed for data: images, so the colour is baked in.
  spaceDot(space) {
    const fill = this.spaceColor(space) ?? "rgb(128 128 128)";
    return "data:image/svg+xml," + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.5" fill="${fill}"/></svg>`);
  },
};
