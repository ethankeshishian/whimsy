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
// wave10/mini W10-13 (the user's picks for Mini's model, 2026-10-31):
// - One page looks exactly like Little Arc. A second page (a sign-in
//   popup, a target=_blank link, Cmd+Opt+T) brings in a row of pill tabs
//   under the bar; it leaves again at one page. No limit on pages.
// - Sign-in popups (window.open with features) open as Mini tabs that keep
//   their opener and postMessage (whimsy-nsWindowWatcher-cpp.patch reads
//   POPUPS_ATTR); when one closes itself, its opener's tab comes back.
// - Links from other apps add a tab to the open Mini instead of stacking
//   a new one (WhimsyExternalLinks passes `reuse`).
// - Cmd+O moves every page into the space, and its label counts them.
// - Cmd+W closes the current page; the last one closes Mini.
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
  WhimsyProfileMoves: "resource:///modules/whimsy/WhimsyProfileMoves.sys.mjs",
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.quick-window";
// wave10/mini W10-13: pages as pill tabs, popups as tabs, links reuse Mini.
const TABS_FEATURE_PREF = "whimsy.feature.mini-tabs";
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
// wave5/profiles: the profile pill (Little Arc's profile switcher).
const PROFILE_BUTTON_ID = "whimsy-quick-window-profile";
const PROFILE_PICKER_ID = "whimsy-quick-window-profile-picker";
// Zen's own Cmd+O ("Expand Glance"): meaningless in a quick window, which
// never has a Glance, so Mini Whimsy reuses the accelerator for Arc's
// "Open in Current Space" instead (see initChrome).
const GLANCE_EXPAND_KEY_ID = "zen-glance-expand";
// wave10/mini W10-13: the pill tab row, shown (TABS_ATTR on <html>) only
// while Mini holds more than one page.
const TABS_ID = "whimsy-quick-window-tabs";
const TABS_ATTR = "whimsy-mini-tabs";
// Read by whimsy-nsWindowWatcher-cpp.patch: window.open() in this window
// opens a tab here, popups with features included.
const POPUPS_ATTR = "whimsy-popups-as-tabs";
const CLOSING_ATTR = "whimsy-mini-closing";
const DEFAULT_FAVICON = "chrome://global/skin/icons/defaultFavicon.svg";

const READY_TOPIC = "whimsy-quick-window-ready";
const pointerPositions = new WeakMap();
const readyLayouts = new WeakMap();

export const WhimsyQuickWindow = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  // wave10/mini W10-13: Mini holds several pages (see the banner).
  get tabsEnabled() {
    return this.enabled && Services.prefs.getBoolPref(TABS_FEATURE_PREF, true);
  },

  // Called for every window Whimsy starts in, quick windows included (it
  // no-ops there: a quick window doesn't open another quick window).
  initWindow(win) {
    this.installPageTabs();
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
    // wave10/mini: Mini's own commands exist only in Mini windows, but are
    // listed from the start, so their shortcuts can be set before one opens.
    for (const spec of this.miniCommands()) {
      lazy.WhimsyCommands.describe(spec);
    }
  },

  // wave10/mini W10-13: Mini's new commands (registered in each Mini by
  // initChrome): a new page (Cmd+Opt+T, New Private Tab elsewhere; Mini
  // registers it first, so its own key wins there).
  miniCommands() {
    const inMini = w => !!w?._whimsyQuickWindow && !w._whimsyMiniBarOnly;
    return [{
      id: "cmd_whimsyMiniNewTab",
      l10nId: "whimsy-action-mini-new-tab",
      run: w => this.newTab(w),
      keyId: "key_whimsyMiniNewTab",
      key: this.tabsEnabled ? { key: "T", modifiers: "accel,alt" } : null,
      icon: "chrome://browser/skin/zen-icons/plus.svg",
      isAvailable: w => inMini(w) && this.tabsEnabled,
      menu: "file-menu",
    }];
  },

  // Opens `url` in a new Mini Whimsy window, stacked over the newest one
  // already open (Arc opens a second Little Arc rather than reusing the
  // first). With no `url` (Cmd+Opt+N) it opens the bar-only command-bar
  // panel instead. Returns the window, or null when the feature is off.
  // (`triggeringPrincipal` is accepted for callers; the URL goes in as the
  // new window's argument, like any other new browser window.)
  // wave10/mini W10-13: with `reuse` (a link from another app), the link
  // becomes the front tab of the newest open Mini instead.
  open(url, { opener, triggeringPrincipal, reuse = false } = {}) {
    if (!this.enabled) {
      return null;
    }
    const reused = url && reuse ? this.reusableWindow() : null;
    if (reused) {
      this.whenChromeReady(reused).then(() => {
        if (!reused.closed) {
          this.openLinkTab(reused, url, triggeringPrincipal);
          reused.focus();
        }
      });
      return reused;
    }
    // A link stacks over the newest Mini showing a page (never a panel).
    const below = url ? this.windows().filter(w => !w._whimsyMiniBarOnly).at(-1) : null;
    const barOnly = !url;
    // wave7/profiles: a link opens in the profile of the space "Open in"
    // points at, so adopting it later needn't change its profile. Firefox's
    // window argument can't carry a container: open blank, then load the
    // link in a tab of that container (it never loads in Default first).
    const profileId = url ? this.destinationProfileId(opener) : 0;
    const args = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
    args.data = profileId ? "about:blank" : url || "about:blank";
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
      root.toggleAttribute(POPUPS_ATTR, this.tabsEnabled);
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
    if (profileId) {
      this.whenChromeReady(win).then(() => {
        if (!win.closed) {
          this.loadInProfile(win, url, profileId, triggeringPrincipal);
        }
      });
    }
    return win;
  },

  // Where a new Mini opens, in screen pixels (left/top undefined, with no
  // screen to measure: the system centres it).
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
      // Centred on the screen, placed here rather than left to the system
      // (which may cascade it partly off the bottom), so a Mini stacked
      // over this one can sit below it.
      return {
        left: clamp(availLeft + (availWidth - width) / 2, availLeft, availWidth, width),
        top: clamp(availTop + (availHeight - height) / 2, availTop, availHeight, height),
        width, height,
      };
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
  // Not Scratch (wave9/secfix, security-full-1 M2): only private tabs go
  // there, and Mini's tab is a normal one.
  spaces(win) {
    return (this.mainWindow(win.opener)?.gZenWorkspaces?.getWorkspaces() ?? []).filter(space => !space.whimsyScratch);
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
    const selected = win.gBrowser.selectedTab;
    // wave10/mini W10-13: every page Mini holds moves, in order, and the
    // one you were looking at stays selected there.
    const tabs = this.tabsEnabled ? this.pages(win) : [selected];
    // wave5/profiles: another profile's space: Arc's warning, then the page
    // reopens there in that profile (async; nothing is adopted yet).
    const space = target.gZenWorkspaces.getWorkspaces().find(item => item.uuid == spaceId);
    if (!space || space.whimsyScratch || !tabs.length) {
      return null;
    }
    const profileId = lazy.WhimsyProfiles.profileIdOfSpace(space);
    // Always (wave8/isolation): with the Profiles switch off the space's
    // container still decides the tab's cookies.
    if (tabs.some(tab => (tab.userContextId ?? 0) != profileId)) {
      this.moveAcrossProfiles(win, target, tabs, space, profileId, selected).catch(console.error);
      return null;
    }
    let adopted = null;
    let moved = false;
    for (const tab of tabs) {
      // The last page's move closes Mini itself.
      if (win.closed || tab.closing) {
        continue;
      }
      const landed = target.gBrowser.adoptTab(tab, { selectTab: tab == selected, spaceId });
      moved ||= !!landed;
      if (tab == selected) {
        adopted = landed;
      }
    }
    if (adopted) {
      target.gZenWorkspaces.lastSelectedWorkspaceTabs[spaceId] = adopted;
    }
    if (moved) {
      target.focus();
      if (!win.closed) {
        win.close();
      }
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
      if (root.hasAttribute(CLOSING_ATTR)) {
        return;
      }
      if (win.matchMedia("(prefers-reduced-motion: reduce)").matches || win.closed) {
        close();
        return;
      }
      root.setAttribute(CLOSING_ATTR, "");
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
    // wave10/mini: Mini's new commands (miniCommands), offered by the
    // command bar in Mini only.
    for (const spec of this.miniCommands()) {
      lazy.WhimsyCommands.register(win, spec);
    }
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
    document.documentElement.toggleAttribute(POPUPS_ATTR, this.tabsEnabled);
    const bar = this.buildBar(win);
    navbar.before(bar);
    bar.after(this.buildTabRow(win));
    this.adoptWindowButtons(win);
    this.watchDestination(win);
    this.watchPage(win);
    this.watchTabs(win);
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
    address.append(host);

    // wave5/profiles: the page's profile, a pill before the address; it
    // opens the profile list (Little Arc's profile switcher). Hidden while
    // profiles are off.
    const profile = html("button");
    profile.id = PROFILE_BUTTON_ID;
    profile.type = "button";
    profile.className = "whimsy-mini-profile";
    profile.setAttribute("aria-haspopup", "menu");
    profile.addEventListener("click", () => this.openProfilePicker(win, profile));
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
    // wave9/mini W8-21: Arc's "Open in <Space> ⌘O" is one target; the
    // keycap shares the button's highlight (whimsy-browser.css) and click.
    shortcut.addEventListener("click", event => {
      if (event.button == 0 && !move.disabled) {
        move.doCommand();
      }
    });
    group.append(move, shortcut, choose);

    // fix7: Little Arc draws Extensions and Copy Link inside the address
    // strip, at its right end. The strip is a plain container (a button
    // can't hold buttons); the address button fills the rest of it.
    const field = html("div");
    field.id = ADDRESS_FIELD_ID;
    field.append(address, copy);
    bar.append(back, profile, field, group);
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
    this.keepResultsInMini(win);
    // Arc: Cmd+T in Little Arc opens its command bar; what you pick
    // replaces the page, it never opens a tab.
    const commands = win.BrowserCommands;
    if (commands?.openTab && !commands._whimsyMini) {
      commands._whimsyMini = true;
      commands.openTab = ({ url } = {}) => {
        if (url) {
          win.openTrustedLinkIn(url, "current");
        } else {
          this.openCommandBar(win);
        }
      };
    }
  },

  // wave9/mini W8-20 (Arc's Little Arc model, approved by the user): Mini
  // holds one page at a time and has no tab strip, so everything its
  // command bar opens replaces that page. Firefox and Zen would otherwise
  // send some picks to a tab: Alt/Cmd+Return, Zen's "new tab" command bar
  // (Cmd+T), an empty Zen tab, the open-in-tab pref. A popup window has no
  // tabs of its own, so those landed as tabs in the main window, behind the
  // floating Mini, and Mini looked like it did nothing. "Switch to Tab"
  // results switched a main window's tab the same way; in Mini they open
  // that page here instead. Downloads ("save") stay downloads. Moving the
  // page into a space is still Cmd+O / the Open in button.
  keepResultsInMini(win) {
    const controller = win.gURLBar?.controller;
    if (!controller?.whereToOpen) {
      // Not set up yet: try again when the command bar is first used.
      win.gURLBar?.addEventListener("focus", () => this.keepResultsInMini(win), { once: true });
      return false;
    }
    if (controller._whimsyMini) {
      return true;
    }
    controller._whimsyMini = true;
    const whereToOpen = controller.whereToOpen.bind(controller);
    controller.whereToOpen = event => {
      const where = whereToOpen(event);
      // wave10/mini: a Cmd+Opt+T page with a pick on its way stays.
      const tab = win.gBrowser?.selectedTab;
      if (tab && where != "save") {
        tab._whimsyMiniPicked = true;
      }
      return where == "save" ? where : "current";
    };
    const parent = controller.parentController;
    if (parent?.switchToTab) {
      parent.switchToTab = ({ url } = {}) => {
        if (!url || win.closed) {
          return;
        }
        // wave10/mini W10-13: a page Mini already holds is switched to.
        const open = this.tabsEnabled && this.pages(win).find(tab =>
          tab.linkedBrowser?.currentURI?.spec == url);
        if (open) {
          win.gBrowser.selectedTab = open;
        } else {
          win.openTrustedLinkIn(url, "current");
        }
      };
    }
    return true;
  },

  openCommandBar(win) {
    this.keepResultsInMini(win);
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
      this.updateProfile(win);
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
      win._whimsyMiniSpace = space ?? null;
      this.labelOpenIn(win);
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

  // -- wave10/mini W10-13: pages as tabs -----------------------------------

  // The pages Mini holds, in tab order: no closing tabs and none of Zen's
  // internal ones (empty-tab sentinels, Glance previews).
  pages(win) {
    return [...(win?.gBrowser?.tabs ?? [])].filter(tab =>
      !tab.closing && !tab.hidden &&
      !tab.hasAttribute("zen-empty-tab") && !tab.hasAttribute("zen-glance-tab"));
  },

  // Whether a tab shows nothing yet (a fresh Cmd+Opt+T page, a blank Mini).
  isBlank(tab) {
    const browser = tab?.linkedBrowser;
    const spec = browser?.currentURI?.spec ?? "";
    return (!spec || spec == "about:blank" || !!tab.documentGlobal?.isBlankPageURL?.(spec)) &&
      !tab.hasAttribute("busy") && !browser?.userTypedValue &&
      !browser?.webProgress?.isLoadingDocument;
  },

  // Whether new pages from this window's own pages stay in it as tabs.
  keepsTabs(win) {
    return !!win?._whimsyQuickWindow && !win.closed && this.tabsEnabled &&
      !win.document.documentElement.hasAttribute(CLOSING_ATTR);
  },

  // A target=_blank link or a window.open() from a page in Mini reaches
  // Firefox's BrowserDOMWindow as "open a new tab". For a popup window
  // (Mini is one) Firefox sends that tab to the main window, behind the
  // floating Mini. Mini keeps it as its own tab instead, exactly as
  // Firefox would build it (same opener, principal and window name), so
  // window.opener, postMessage and window.close() keep working. The C++
  // patch routes popups with features down this same path.
  installPageTabs() {
    if (this._pageTabsInstalled) {
      return;
    }
    this._pageTabsInstalled = true;
    const { BrowserDOMWindow } = ChromeUtils.importESModule("resource:///modules/BrowserDOMWindow.sys.mjs");
    const proto = BrowserDOMWindow.prototype;
    const { OPEN_NEWTAB, OPEN_NEWTAB_BACKGROUND, OPEN_NEWTAB_FOREGROUND, OPEN_EXTERNAL } = Ci.nsIBrowserDOMWindow;
    const isNewTab = where => where == OPEN_NEWTAB || where == OPEN_NEWTAB_BACKGROUND || where == OPEN_NEWTAB_FOREGROUND;
    const self = this;
    for (const [name, skipLoad] of [["createContentWindowInFrame", true], ["openURIInFrame", false]]) {
      const original = proto[name];
      proto[name] = function whimsyMiniTab(aURI, aParams, aWhere, aFlags, aName) {
        if (isNewTab(aWhere) && !(aFlags & OPEN_EXTERNAL) && self.keepsTabs(this.win)) {
          try {
            const browser = self.openPageTab(this.win, {
              // createContentWindowInFrame only makes the browser; the page
              // loads itself through openWindowInfo.
              uri: skipLoad ? null : aURI,
              params: aParams,
              where: aWhere,
              name: aName,
              skipLoad,
              forceAllowDataURI: !!(aFlags & Ci.nsIBrowserDOMWindow.OPEN_FORCE_ALLOW_DATA_URI),
            });
            if (browser) {
              return browser;
            }
          } catch (e) {
            console.error("Whimsy: Mini tab", e);
          }
        }
        return original.apply(this, arguments);
      };
    }
    // A page's own "new tab" opens (Cmd-click, middle-click, the context
    // menu's Open Link in New Tab) go through openLinkIn, which skips
    // popup windows for tabs; in Mini they stay in Mini too. Opens by
    // the browser itself (system principal: Settings, menus) keep
    // Firefox's choice of window.
    const { URILoadingHelper } = ChromeUtils.importESModule("resource:///modules/URILoadingHelper.sys.mjs");
    const resolve = URILoadingHelper._resolveInitialTargetWindow;
    if (typeof resolve == "function") {
      URILoadingHelper._resolveInitialTargetWindow = function whimsyMiniTarget(where, params, win, forceNonPrivate) {
        const top = win?.top;
        const principal = params?.triggeringPrincipal;
        if ((where == "tab" || where == "tabshifted") && !forceNonPrivate && principal &&
            !principal.isSystemPrincipal && self.keepsTabs(top)) {
          return top;
        }
        return resolve.apply(this, arguments);
      };
    }
  },

  // Adds the page's new tab to Mini, after the page that opened it, and
  // makes that page the one Mini returns to when the new one closes.
  openPageTab(win, { uri, params, where, name, skipLoad, forceAllowDataURI }) {
    const { gBrowser } = win;
    const openerTab = params.openerBrowser ? gBrowser.getTabForBrowser(params.openerBrowser) : null;
    const inBackground = where == Ci.nsIBrowserDOMWindow.OPEN_NEWTAB_BACKGROUND;
    const userContextId = params.openerOriginAttributes?.userContextId ?? openerTab?.userContextId ?? 0;
    const tab = gBrowser.addTab(uri ? uri.spec : "about:blank", {
      triggeringPrincipal: params.triggeringPrincipal ??
        Services.scriptSecurityManager.createNullPrincipal({ userContextId }),
      referrerInfo: params.referrerInfo,
      userContextId,
      inBackground,
      openWindowInfo: params.openWindowInfo,
      openerBrowser: params.openerBrowser,
      ownerTab: inBackground ? null : openerTab ?? gBrowser.selectedTab,
      relatedToCurrent: true,
      name,
      policyContainer: params.policyContainer,
      skipLoad,
      forceAllowDataURI,
      // Never routed to a space: Mini is where it was opened.
      skipRoute: true,
    });
    if (!tab) {
      return null;
    }
    if (openerTab && !inBackground) {
      gBrowser.setSuccessor(tab, openerTab);
    }
    return tab.linkedBrowser;
  },

  // The Mini a link from another app joins: the newest one showing pages
  // (not the bar-only panel, nor one fading out).
  reusableWindow() {
    if (!this.tabsEnabled) {
      return null;
    }
    return this.windows().filter(w => !w._whimsyMiniBarOnly &&
      !w.document?.documentElement?.hasAttribute(CLOSING_ATTR)).at(-1) ?? null;
  },

  // A link from another app, as Mini's front tab, in the profile of the
  // space Cmd+O points at. A Mini still blank just shows it.
  openLinkTab(win, url, triggeringPrincipal = null) {
    const { gBrowser } = win;
    const profileId = this.destinationProfileId(win.opener);
    const pages = this.pages(win);
    if (pages.length == 1 && this.isBlank(pages[0])) {
      if (profileId || pages[0].userContextId) {
        return this.loadInProfile(win, url, profileId, triggeringPrincipal);
      }
      gBrowser.selectedTab = pages[0];
      win.openTrustedLinkIn(url, "current", {
        triggeringPrincipal: triggeringPrincipal ?? Services.scriptSecurityManager.getSystemPrincipal(),
      });
      return pages[0];
    }
    const tab = gBrowser.addTab(url, {
      userContextId: profileId,
      triggeringPrincipal: this.principalFor(
        triggeringPrincipal ?? Services.scriptSecurityManager.getSystemPrincipal(), profileId, false),
      inBackground: false,
      skipRoute: true,
    });
    if (tab) {
      gBrowser.selectedTab = tab;
    }
    return tab;
  },

  // Cmd+Opt+T: a new page in Mini. Its command bar opens on the new tab and
  // what you pick loads there; dismissing the bar without a pick takes the
  // empty page away again.
  newTab(win) {
    if (!this.tabsEnabled || win._whimsyMiniBarOnly) {
      this.openCommandBar(win);
      return null;
    }
    const { gBrowser } = win;
    const previous = gBrowser.selectedTab;
    const tab = gBrowser.addTab("about:blank", {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      userContextId: previous?.userContextId ?? 0,
      inBackground: false,
      ownerTab: previous,
      relatedToCurrent: true,
      skipRoute: true,
    });
    if (!tab) {
      return null;
    }
    gBrowser.selectedTab = tab;
    if (previous) {
      gBrowser.setSuccessor(tab, previous);
    }
    this.openCommandBar(win);
    const input = win.gURLBar?.inputField;
    const discard = () => {
      win.setTimeout(() => {
        if (!win.closed && !tab.closing && tab.isConnected && !tab._whimsyMiniPicked &&
            this.isBlank(tab) && !win.gURLBar?.focused && this.pages(win).length > 1) {
          gBrowser.removeTab(tab, { animate: false });
        }
      }, 0);
    };
    input?.addEventListener("blur", discard, { once: true });
    return tab;
  },

  // The pill row: one pill per page (favicon, title, close), the current
  // one lit like the address strip. Hidden until there are two pages.
  buildTabRow(win) {
    const { document, gBrowser } = win;
    const row = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    row.id = TABS_ID;
    row.setAttribute("role", "tablist");
    document.l10n.setAttributes(row, "whimsy-quick-window-tabs");
    const pillOf = target => target?.closest?.(".whimsy-mini-tab");
    row.addEventListener("click", event => {
      const pill = pillOf(event.target);
      if (!pill?._tab || event.button != 0) {
        return;
      }
      if (event.target.closest(".whimsy-mini-tab-close")) {
        gBrowser.removeTab(pill._tab, { animate: true });
      } else {
        gBrowser.selectedTab = pill._tab;
      }
    });
    // Middle-click closes, as on any tab.
    row.addEventListener("auxclick", event => {
      const pill = pillOf(event.target);
      if (pill?._tab && event.button == 1) {
        event.preventDefault();
        gBrowser.removeTab(pill._tab, { animate: true });
      }
    });
    // Arrow keys move between pills (and select), Home/End jump.
    row.addEventListener("keydown", event => {
      const pill = pillOf(event.target);
      if (!pill || event.target != pill) {
        return;
      }
      const pills = [...row.children];
      const index = pills.indexOf(pill);
      const rtl = win.getComputedStyle(row).direction == "rtl";
      const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[event.key];
      let next = null;
      if (step) {
        next = pills[(index + step + pills.length) % pills.length];
      } else if (event.key == "Home") {
        next = pills[0];
      } else if (event.key == "End") {
        next = pills.at(-1);
      } else if (event.key == "Enter" || event.key == " ") {
        next = pill;
      }
      if (next?._tab) {
        event.preventDefault();
        gBrowser.selectedTab = next._tab;
        next.focus();
      }
    });
    return row;
  },

  makePill(win, tab) {
    const { document } = win;
    const html = tag => document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    const pill = html("div");
    pill.className = "whimsy-mini-tab";
    pill.setAttribute("role", "tab");
    pill._tab = tab;
    const icon = document.createXULElement("image");
    icon.className = "whimsy-mini-tab-icon";
    const label = html("span");
    label.className = "whimsy-mini-tab-label";
    const close = html("button");
    close.type = "button";
    close.className = "whimsy-mini-tab-close";
    close.tabIndex = -1;
    document.l10n.setAttributes(close, "whimsy-quick-window-tab-close");
    pill.append(icon, label, close);
    return pill;
  },

  updatePill(win, pill, tab) {
    const selected = tab == win.gBrowser.selectedTab;
    const label = tab.label || "";
    pill.toggleAttribute("selected", selected);
    pill.setAttribute("aria-selected", String(selected));
    pill.tabIndex = selected ? 0 : -1;
    pill.toggleAttribute("busy", tab.hasAttribute("busy"));
    pill.title = label;
    const text = pill.querySelector(".whimsy-mini-tab-label");
    if (text.textContent != label) {
      text.textContent = label;
    }
    const src = win.gBrowser.getIcon(tab) || DEFAULT_FAVICON;
    const icon = pill.querySelector(".whimsy-mini-tab-icon");
    if (icon.getAttribute("src") != src) {
      icon.setAttribute("src", src);
    }
  },

  // Keeps the pill row (and the "Open N Tabs in" count) on Mini's pages.
  syncTabs(win) {
    const { document } = win;
    const row = document.getElementById(TABS_ID);
    if (!row || win.closed) {
      return;
    }
    const pages = this.tabsEnabled ? this.pages(win) : [];
    const show = pages.length > 1;
    document.documentElement.toggleAttribute(TABS_ATTR, show);
    this.labelOpenIn(win);
    if (!show) {
      row.replaceChildren();
      return;
    }
    const existing = new Map([...row.children].map(pill => [pill._tab, pill]));
    const pills = pages.map(tab => {
      const pill = existing.get(tab) ?? this.makePill(win, tab);
      this.updatePill(win, pill, tab);
      return pill;
    });
    // Move only what changed, so pills already showing keep their place
    // (re-inserting one would replay its entrance).
    for (const pill of [...row.children]) {
      if (!pills.includes(pill)) {
        pill.remove();
      }
    }
    pills.forEach((pill, i) => {
      if (row.children[i] != pill) {
        row.insertBefore(pill, row.children[i] ?? null);
      }
    });
  },

  watchTabs(win) {
    const { gBrowser } = win;
    const sync = () => this.syncTabs(win);
    const events = ["TabOpen", "TabClose", "TabSelect", "TabMove", "TabAttrModified", "TabShow", "TabHide"];
    for (const type of events) {
      gBrowser.tabContainer.addEventListener(type, sync);
    }
    // A closed tab is gone from gBrowser.tabs only after TabClose.
    const closed = event => {
      if (event.type == "TabClose") {
        win.setTimeout(sync, 0);
      }
    };
    gBrowser.tabContainer.addEventListener("TabClose", closed);
    win.addEventListener("unload", () => {
      for (const type of events) {
        gBrowser.tabContainer.removeEventListener(type, sync);
      }
      gBrowser.tabContainer.removeEventListener("TabClose", closed);
    }, { once: true });
    sync();
  },

  // How many pages Cmd+O moves.
  movingCount(win) {
    return this.tabsEnabled ? Math.max(1, this.pages(win).length) : 1;
  },

  // "Open in <Space>", or "Open 3 Tabs in <Space>" with several pages.
  labelOpenIn(win) {
    const button = win.document.getElementById(MOVE_BUTTON_ID);
    if (!button) {
      return;
    }
    const space = win._whimsyMiniSpace;
    const args = space ? { space: space.name, count: this.movingCount(win) } : null;
    const id = space ? "whimsy-quick-window-move-to-space" : "whimsy-quick-window-no-space";
    const current = win.document.l10n.getAttributes(button);
    if (current.id != id || JSON.stringify(current.args ?? null) != JSON.stringify(args)) {
      win.document.l10n.setAttributes(button, id, args);
    }
  },

  // -- wave5/profiles: the profile pill ---------------------------------

  /** The profile of the space "Open in" points at (Default if none). */
  destinationProfileId(opener) {
    if (!lazy.WhimsyProfiles.enabled) {
      return 0;
    }
    const space = this.mainWindow(opener)?.gZenWorkspaces?.getActiveWorkspace?.();
    return space ? lazy.WhimsyProfiles.profileIdOfSpace(space) : 0;
  },

  // Keeps a private page private (WhimsyProfileMoves.rekey).
  principalFor(principal, userContextId, isPrivate = false) {
    return lazy.WhimsyProfileMoves.rekey(principal, userContextId, isPrivate);
  },

  /** Replaces Mini's page with `url` in profile `id`'s container. */
  loadInProfile(win, url, id, triggeringPrincipal = null) {
    const { gBrowser } = win;
    const old = gBrowser.selectedTab;
    const isPrivate = lazy.WhimsyProfileMoves.isPrivate(old);
    const tab = gBrowser.addTab(url, {
      userContextId: id,
      whimsyPrivate: isPrivate,
      triggeringPrincipal: this.principalFor(
        triggeringPrincipal ?? Services.scriptSecurityManager.getSystemPrincipal(), id, isPrivate),
      skipAnimation: true,
    });
    gBrowser.selectedTab = tab;
    gBrowser.removeTab(old, { animate: false });
    this.updateProfile(win);
    return tab;
  },

  updateProfile(win) {
    const button = win.document.getElementById(PROFILE_BUTTON_ID);
    if (!button) {
      return;
    }
    const on = lazy.WhimsyProfiles.enabled;
    button.hidden = !on;
    if (!on) {
      return;
    }
    const name = lazy.WhimsyProfiles.nameOf(win.gBrowser.selectedTab?.userContextId ?? 0);
    if (button.dataset.profile != name) {
      button.dataset.profile = name;
      win.document.l10n.setAttributes(button, "whimsy-quick-window-profile-button", { profile: name });
    }
  },

  openProfilePicker(win, anchor) {
    const { document } = win;
    let popup = document.getElementById(PROFILE_PICKER_ID);
    if (!popup) {
      popup = document.createXULElement("menupopup");
      popup.id = PROFILE_PICKER_ID;
      popup.addEventListener("command", event => {
        const id = Number(event.target.dataset.profileId);
        const current = win.gBrowser.selectedTab?.userContextId ?? 0;
        if (Number.isInteger(id) && id != current) {
          const url = win.gBrowser.selectedBrowser.currentURI?.spec || "about:blank";
          this.loadInProfile(win, url, id, win.gBrowser.selectedBrowser.contentPrincipal);
        }
      });
      document.getElementById("mainPopupSet")?.appendChild(popup) ?? document.documentElement.appendChild(popup);
    }
    const current = win.gBrowser.selectedTab?.userContextId ?? 0;
    popup.replaceChildren(...lazy.WhimsyProfiles.list().map(profile => {
      const item = document.createXULElement("menuitem");
      item.setAttribute("type", "radio");
      item.setAttribute("label", profile.name);
      item.dataset.profileId = profile.id;
      if (profile.id == current) {
        item.setAttribute("checked", "true");
      }
      return item;
    }));
    popup.openPopup(anchor, { position: "after_start" });
  },

  // wave10/mini W10-13: every page moves; one already in the space's
  // profile is adopted as it is, the others reopen there in that profile.
  async moveAcrossProfiles(win, target, tabs, space, profileId, selected) {
    const count = tabs.length;
    const ok = await lazy.WhimsyProfileMoves.confirm(target, {
      titleId: "whimsy-profile-move-tab-title",
      titleArgs: { count, space: space?.name ?? "" },
      bodyId: "whimsy-profile-move-tab-body",
      bodyArgs: { count, profile: lazy.WhimsyProfiles.nameOf(profileId) },
      acceptId: "whimsy-profile-move-tab-accept",
      acceptArgs: { count },
    });
    if (!ok || win.closed || target.closed) {
      return null;
    }
    let landed = null;
    // Reopened copies first: adopting the last page would close Mini, and
    // the pages still to reopen with it.
    const reopen = tabs.filter(tab => (tab.userContextId ?? 0) != profileId);
    const adopt = tabs.filter(tab => !reopen.includes(tab));
    const placed = new Map();
    for (const tab of reopen) {
      if (tab.closing) {
        continue;
      }
      const url = tab.linkedBrowser.currentURI?.spec || "about:blank";
      const isPrivate = lazy.WhimsyProfileMoves.isPrivate(tab);
      const principal = this.principalFor(tab.linkedBrowser.contentPrincipal, profileId, isPrivate);
      const added = target.gBrowser.addTab(url, {
        userContextId: profileId,
        whimsyPrivate: isPrivate,
        triggeringPrincipal: principal,
      });
      // Zen's move skips a tab already in the space's container, so the
      // space id is set first (else the tab has none).
      added.setAttribute("zen-workspace-id", space.uuid);
      target.gZenWorkspaces.moveTabToWorkspace(added, space.uuid);
      placed.set(tab, added);
    }
    for (const tab of adopt) {
      if (!win.closed && !tab.closing) {
        placed.set(tab, target.gBrowser.adoptTab(tab, { selectTab: false, spaceId: space.uuid }));
      }
    }
    landed = placed.get(selected) ?? [...placed.values()].find(Boolean) ?? null;
    if (target.gZenWorkspaces.activeWorkspace != space.uuid) {
      await target.gZenWorkspaces.changeWorkspaceWithID(space.uuid);
    }
    if (landed) {
      target.gBrowser.selectedTab = landed;
      target.gZenWorkspaces.lastSelectedWorkspaceTabs[space.uuid] = landed;
    }
    target.focus();
    if (!win.closed) {
      win.close();
    }
    return landed;
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
      // wave9/mini W8-22: drawn as Arc's popover, never the system menu.
      popup.setAttribute("nonnative", "true");
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
    document.l10n.setAttributes(caption, "whimsy-quick-window-picker-caption", { count: this.movingCount(win) });
    const defaultId = this.defaultSpaceId(win);
    const toItem = space => {
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
    };
    // wave5/profiles: spaces of the page's own profile first; the rest,
    // where it would reopen in another profile, after a separator.
    const current = win.gBrowser.selectedTab?.userContextId ?? 0;
    const mine = spaces.filter(space => !lazy.WhimsyProfiles.enabled ||
      lazy.WhimsyProfiles.profileIdOfSpace(space) == current);
    const others = spaces.filter(space => !mine.includes(space));
    const items = mine.map(toItem);
    if (others.length) {
      if (items.length) {
        items.push(document.createXULElement("menuseparator"));
      }
      items.push(...others.map(toItem));
    }
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
