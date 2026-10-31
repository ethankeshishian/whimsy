/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Scratch and private tabs (whimsy.feature.scratch): private browsing inside
// a normal window, instead of a separate private window.
//
// - Private tab (Cmd+Option+T): a tab in the current space that browses
//   privately, like Waterfox's private tabs. People open one to check
//   something without it landing in their history or logging them out of
//   anything, and keep it next to their normal tabs instead of
//   alt-tabbing to a whole other window. W8-17: the shortcut opens the
//   command bar in private mode (violet ring, "Private" badge), the way
//   Cmd+T opens it for a normal tab; the private tab only exists once
//   something is picked, and Esc leaves nothing behind.
// - Scratch (Cmd+Shift+N): a temporary private space, added to the right of
//   every space. Everything opened in it is private. Closing its last tab
//   (or Close Scratch) removes it; it is never saved or restored. "Save as
//   Space…" walks through Zen's New Space form (name, icon, profile, theme),
//   then asks, then turns it into a normal space (its pages reopen outside
//   private browsing). A tab moved to another space stays private there.
//
// This is Firefox's real private browsing, per tab: the tab's
// BrowsingContext has originAttributes.privateBrowsingId = 1, with its own
// in-memory cookie jar and cache, no history, session-only permissions,
// private downloads, and the whole lot wiped when the last private tab
// closes ("last-pb-context-exited"). Gecko ties that to the window, so a
// few engine patches let a <browser> marked mozprivatebrowsing="true" be
// private in a normal window (src/dom/base/whimsy-nsFrameLoader-cpp.patch,
// src/dom/ipc/whimsy-ContentParent-cpp.patch), make
// PrivateBrowsingUtils.isBrowserPrivate ask the browser
// (src/toolkit/modules/whimsy-PrivateBrowsingUtils-sys-mjs.patch), and keep
// private tabs out of the saved session
// (src/toolkit/modules/sessionstore/whimsy-PrivacyFilter-sys-mjs.patch).
//
// Here, without editing Zen or Firefox code:
// - gBrowser.addTab/createBrowser are wrapped so a tab is created private
//   when asked to, when it is opened from a private tab (window.open,
//   target=_blank, a middle-click, the link menu, a tab dragged between
//   windows), or when it opens in Scratch. The <browser> is marked before
//   it is inserted, which is when Gecko creates its BrowsingContext.
// - Private tabs are marked isPrivate in TabStateCache (PrivacyFilter drops
//   them from the session; SessionStore already keeps them out of Undo
//   Close Tab), stay out of Zen's window sync, can't be pinned or unloaded
//   (unloading the last one would wipe its cookies), and the address bar
//   doesn't record input or search history while one is selected.
// - Scratch is a Zen space flagged whimsyScratch, left out of what Zen saves.
//
// Engine patches also keep "switch to tab" within one side: private tabs
// register as private open pages (whimsy-Tabbrowser-sys-mjs.patch), the
// address bar's controller asks the selected tab
// (whimsy-UrlbarParentController-sys-mjs.patch), and switching compares
// tabs, not windows (whimsy-URILoadingHelper-sys-mjs.patch).
//
// Downloads: a private tab's download is a private download (Gecko reads
// the channel), so it stays out of history and is removed when the last
// private tab closes. While a private tab is selected, the window's
// downloads panel and toolbar indicator show private downloads, as a private
// window's do (whimsy-DownloadsCommon-sys-mjs.patch reads
// window.whimsyDownloadsPrivate; updateDownloads re-attaches them).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivacyFilter: "resource://gre/modules/sessionstore/PrivacyFilter.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  TabStateCache: "moz-src:///browser/components/sessionstore/TabStateCache.sys.mjs",
  UrlbarUtils: "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs",
  WhimsyAlreadyOpen: "resource:///modules/whimsy/WhimsyAlreadyOpen.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyPanels: "resource:///modules/whimsy/WhimsyPanels.sys.mjs",
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
  ZenSessionStore: "resource:///modules/zen/ZenSessionManager.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.scratch";
// Settings → Privacy: off makes both shortcuts open a private window.
const IN_WINDOW_PREF = "whimsy.private.in-window";
// The <browser> attribute nsFrameLoader.cpp reads.
const BROWSER_ATTR = "mozprivatebrowsing";
// Marks private tabs (whimsy-browser.css).
const TAB_ATTR = "whimsy-private";
// Marks Scratch's space element and switcher icon.
const SCRATCH_ATTR = "whimsy-scratch";
// Set on the window while a private tab is selected.
const SELECTED_ATTR = "whimsy-private-tab";
const PRIVATE_NEW_TAB_URL = "about:privatebrowsing";
const NEW_TAB_URLS = new Set(["about:newtab", "about:home"]);
const SCRATCH_ICON = "chrome://browser/skin/zen-icons/private-window-small.svg";
const PRIVATE_REMOTE_TYPE = /[\^&]privateBrowsingId=[1-9]/;
// W8-17/18: set on #urlbar while it serves private browsing (a private
// tab's Cmd+L, the private command bar, Cmd+T in Scratch).
const URLBAR_ATTR = "whimsy-private";
const URLBAR_BADGE_ID = "whimsy-urlbar-private-badge";
// How long an Enter in the private command bar keeps its loads private
// while the bar resolves what was typed (an async heuristic lookup).
const PENDING_PRIVATE_MS = 5000;
// Per-window command bar state: { compose, pendingUntil, forcePrivate, ... }.
const urlbarStates = new WeakMap();

export const WhimsyPrivate = {
  get featureOn() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  // Private tabs and Scratch open inside the window (unless a policy
  // forbids private browsing).
  get inWindow() {
    return (
      this.featureOn &&
      Services.prefs.getBoolPref(IN_WINDOW_PREF, true) &&
      lazy.PrivateBrowsingUtils.enabled
    );
  },

  isWindowPrivate(win) {
    return lazy.PrivateBrowsingUtils.isWindowPrivate(win);
  },

  isPrivateBrowser(browser) {
    if (!browser) {
      return false;
    }
    return (
      browser.getAttribute?.(BROWSER_ATTR) == "true" ||
      (browser.isConnected && !!browser.browsingContext?.usePrivateBrowsing)
    );
  },

  // A private tab in a normal window.
  isPrivateTab(tab) {
    return !!tab?.hasAttribute?.(TAB_ATTR);
  },

  // --- Window setup ---

  initWindow(win) {
    if (this.isWindowPrivate(win) && win.gBrowser) {
      // Everything in a private window is private already.
      this.calmPrivateWindow(win);
      return;
    }
    if (!win.gBrowser) {
      return;
    }
    this.initGlobal();
    this.installTabHooks(win);
    this.initCommands(win);
    this.initMenus(win);
    const { gBrowser } = win;
    gBrowser.tabContainer.addEventListener("TabSelect", () => this.updateSelected(win));
    gBrowser.tabContainer.addEventListener("TabClose", event => this.onTabClose(win, event.target));
    this.updateSelected(win);
    win.gZenWorkspaces?.promiseInitialized
      ?.then(() => this.initSpaces(win))
      .catch(e => console.error("Whimsy: Scratch", e));
  },

  // fix7/private: Firefox selects the address bar when a private window
  // opens on the private page, which in Zen reads as the command bar opening
  // by itself. The window opens on the page instead; Cmd+L still opens the
  // bar. Only an untouched, empty bar is given up.
  calmPrivateWindow(win) {
    if (!this.featureOn) {
      return;
    }
    const calm = () => {
      const { gBrowser, gURLBar } = win;
      if (
        gURLBar?.focused && !gURLBar.value && !gURLBar.view?.isOpen &&
        gBrowser?.selectedBrowser?.currentURI?.spec == PRIVATE_NEW_TAB_URL
      ) {
        gBrowser.selectedBrowser.focus();
      }
    };
    calm();
    win.requestAnimationFrame(calm);
    // Firefox selects the bar during startup, possibly after this runs.
    win.delayedStartupPromise?.then(() => win.setTimeout(calm, 0)).catch(() => {});
    // The private page may commit after all of that (the first tab starts
    // on about:blank): calm once more when it arrives.
    const { gBrowser } = win;
    if (gBrowser?.selectedBrowser?.currentURI?.spec != PRIVATE_NEW_TAB_URL) {
      const listener = {
        onLocationChange(webProgress, request, location) {
          if (webProgress?.isTopLevel && location?.spec == PRIVATE_NEW_TAB_URL) {
            gBrowser.removeProgressListener(listener);
            calm();
          }
        },
      };
      gBrowser.addProgressListener(listener);
      // Only the window's opening counts.
      win.setTimeout(() => gBrowser.removeProgressListener(listener), 10000);
    }
  },

  // Once per session: wrappers on shared modules.
  initGlobal() {
    if (this._globalDone) {
      return;
    }
    this._globalDone = true;
    // UnifiedExtensions asks about every installed extension on TabSelect.
    // TabBase deliberately throws for extensions without private permission;
    // avoid constructing that wrapper for a private tab in a normal window.
    const { OriginControls } = ChromeUtils.importESModule(
      "resource://gre/modules/ExtensionPermissions.sys.mjs"
    );
    const getState = OriginControls.getState;
    OriginControls.getState = function (policy, tab) {
      if (WhimsyPrivate.isPrivateTab(tab) && !policy?.extension?.privateBrowsingAllowed) {
        return { noAccess: true };
      }
      return getState.call(this, policy, tab);
    };

    // The address bar's controller learns whether it's private once, from
    // the window. Keep a private tab's typing out of input and search
    // history.
    const utils = lazy.UrlbarUtils;
    const skipWhenPrivate = name => {
      const original = utils[name];
      if (typeof original != "function") {
        return;
      }
      utils[name] = function (...args) {
        if (WhimsyPrivate.urlbarPrivateNow()) {
          return Promise.resolve();
        }
        return original.apply(this, args);
      };
    };
    skipWhenPrivate("addToInputHistory");
    skipWhenPrivate("addToInputHistoryWhenReady");
    // Marking a page as typed only matters for its next (normal) visit, so
    // a private bar's address must not be marked (Firefox skips it in
    // private windows).
    const addToUrlbarHistory = utils.addToUrlbarHistory;
    if (typeof addToUrlbarHistory == "function") {
      utils.addToUrlbarHistory = function (url, window, ...rest) {
        try {
          if (window?.gBrowser && WhimsyPrivate.urlbarIsPrivate(window)) {
            return undefined;
          }
        } catch (e) {
          console.error("Whimsy: private command bar", e);
          return undefined;
        }
        return addToUrlbarHistory.call(this, url, window, ...rest);
      };
    }
    const addToFormHistory = utils.addToFormHistory;
    if (typeof addToFormHistory == "function") {
      utils.addToFormHistory = function (isPrivate, ...rest) {
        return addToFormHistory.call(
          this,
          isPrivate || WhimsyPrivate.selectedTabIsPrivate() || WhimsyPrivate.urlbarPrivateNow(),
          ...rest
        );
      };
    }
    // Zen saves the last normal window to close straight from its data,
    // which is also what Undo Close Window would bring back.
    const store = lazy.ZenSessionStore;
    const maybeSaveClosedWindow = store.maybeSaveClosedWindow;
    if (typeof maybeSaveClosedWindow == "function") {
      store.maybeSaveClosedWindow = function (winData, ...rest) {
        try {
          WhimsyPrivate.filterWindowState(winData);
        } catch (e) {
          console.error("Whimsy: private tabs", e);
        }
        return maybeSaveClosedWindow.call(this, winData, ...rest);
      };
    }
  },

  filterWindowState(winData) {
    if (!winData) {
      return;
    }
    lazy.PrivacyFilter.filterPrivateTabs?.(winData);
    if (Array.isArray(winData.spaces)) {
      winData.spaces = winData.spaces.filter(space => !space.whimsyScratch);
    }
  },

  selectedTabIsPrivate() {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    return !!win && this.isPrivateTab(win.gBrowser?.selectedTab);
  },

  // Whether the front window's address bar serves private browsing right
  // now. Before its hooks are in, the selected tab decides (as before).
  urlbarPrivateNow() {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    if (!win) {
      return false;
    }
    if (!this.urlbarState(win).inputHooked) {
      return this.isPrivateTab(win.gBrowser?.selectedTab);
    }
    return this.urlbarIsPrivate(win);
  },

  // --- Creating private tabs ---

  installTabHooks(win) {
    const { gBrowser } = win;
    if (gBrowser._whimsyPrivateHooks) {
      return;
    }
    gBrowser._whimsyPrivateHooks = true;
    const self = this;
    // While addTab builds a private tab: the URL it will load.
    let pending = null;

    // TabOpen observers (including window sync and extensions) must see the
    // privacy marker, rather than learning about it after addTab returns.
    gBrowser.tabContainer.addEventListener("TabOpen", event => {
      if (pending) {
        self.markTab(event.target);
      }
    }, { capture: true });

    const addTab = gBrowser.addTab;
    gBrowser.addTab = function (uriString, options = {}) {
      let makePrivate = false;
      try {
        makePrivate = self.shouldOpenPrivate(win, uriString, options);
      } catch (e) {
        console.error("Whimsy: private tabs", e);
      }
      if (!makePrivate) {
        return addTab.call(this, uriString, options);
      }
      if (self.isNewTabURL(win, uriString)) {
        uriString = PRIVATE_NEW_TAB_URL;
      }
      const outer = pending;
      pending = { url: uriString };
      let tab;
      try {
        tab = addTab.call(this, uriString, options);
      } finally {
        pending = outer;
      }
      if (tab) {
        self.markTab(tab);
      }
      return tab;
    };

    const createBrowser = gBrowser.createBrowser;
    gBrowser.createBrowser = function (options = {}) {
      const browser = createBrowser.call(this, options);
      if (pending && !options.isPreloadBrowser) {
        try {
          self.makeBrowserPrivate(win, browser, pending.url, options);
        } catch (e) {
          console.error("Whimsy: private tabs", e);
        }
      }
      return browser;
    };

    // Unloading the last private tab would wipe the cookies it still needs.
    const discardBrowser = gBrowser.discardBrowser;
    gBrowser.discardBrowser = function (tab, ...rest) {
      if (self.isPrivateTab(tab)) {
        return false;
      }
      return discardBrowser.call(this, tab, ...rest);
    };

    // Pinned tabs and Essentials are saved and synced to other windows.
    const pinTab = gBrowser.pinTab;
    gBrowser.pinTab = function (tab, ...rest) {
      if (self.isPrivateTab(tab)) {
        win.gZenUIManager?.showToast("whimsy-private-tab-no-pin");
        return undefined;
      }
      return pinTab.call(this, tab, ...rest);
    };

    // Duplicating copies the tab's history through the session store, into
    // a normal tab. A private tab's copy is a new private tab instead.
    const duplicateTab = gBrowser.duplicateTab;
    gBrowser.duplicateTab = function (tab, ...rest) {
      if (self.isPrivateTab(tab)) {
        return self.openPrivateTab(win, {
          url: tab.linkedBrowser.currentURI?.spec,
          inBackground: true,
          force: true,
        });
      }
      return duplicateTab.call(this, tab, ...rest);
    };
  },

  isNewTabURL(win, url) {
    return !url || NEW_TAB_URLS.has(url) || url == win.BROWSER_NEW_TAB_URL;
  },

  shouldOpenPrivate(win, uriString, options) {
    if (this.isWindowPrivate(win) || options._forZenEmptyTab) {
      return false;
    }
    // Opened from a private tab: always private, switch or not, or it
    // would carry the private page's state into normal browsing.
    const adopted = options.eventDetail?.adoptedTab;
    if (adopted) {
      return this.isPrivateTab(adopted);
    }
    if (options.openWindowInfo?.originAttributes?.privateBrowsingId > 0) {
      return true;
    }
    if (this.isPrivateBrowser(options.openerBrowser)) {
      return true;
    }
    if (PRIVATE_REMOTE_TYPE.test(options.triggeringRemoteType || "")) {
      return true;
    }
    for (const principal of [options.triggeringPrincipal, options.originPrincipal]) {
      if (principal?.isContentPrincipal && principal.originAttributes?.privateBrowsingId > 0) {
        return true;
      }
    }
    // openPrivateTab already checked the switch and setting. A load from
    // the address bar while it serves private browsing (W8-17) is private
    // whatever the switch says, or a private tab's typing would land in a
    // normal tab.
    if (options.whimsyPrivate || this.urlbarState(win).forcePrivate > 0) {
      return true;
    }
    if (!this.inWindow) {
      return false;
    }
    // Everything opened in Scratch is private, but not tabs restored or
    // mirrored into it, nor pinned ones.
    return !options.createLazyBrowser && !options.pinned && this.activeSpaceIsScratch(win);
  },

  // Marks a <browser> before it is inserted (nsFrameLoader.cpp reads the
  // attribute when it creates the BrowsingContext), and starts it in a
  // private web process.
  makeBrowserPrivate(win, browser, url, options) {
    browser.setAttribute(BROWSER_ATTR, "true");
    // A tab opened by a private page already has its private remote
    // browser; anything else needs a private remote type.
    if (options.openWindowInfo || browser.getAttribute("remote") != "true") {
      return;
    }
    const current = browser.getAttribute("remoteType") || "";
    const remoteType = ChromeUtils.predictRemoteTypeForURI(url || "about:blank", {
      window: win,
      userContextId: parseInt(options.userContextId, 10) || 0,
      privateBrowsingId: 1,
      ...(PRIVATE_REMOTE_TYPE.test(current) ? { preferredRemoteType: current } : {}),
    });
    if (remoteType) {
      browser.setAttribute("remoteType", remoteType);
    }
  },

  markTab(tab) {
    tab.setAttribute(TAB_ATTR, "true");
    const browser = tab.linkedBrowser;
    if (browser?.permanentKey) {
      // TabState copies this into the tab's session data: PrivacyFilter
      // drops it, and SessionStore keeps it out of Undo Close Tab.
      lazy.TabStateCache.update(browser.permanentKey, { isPrivate: true });
    }
    // Zen's window sync ignores tabs that already have an id (it gives one
    // to each tab it mirrors), so private tabs stay in this window only.
    if (!tab.id) {
      tab.id = `whimsy-private-${Services.uuid.generateUUID().toString().slice(1, -1)}`;
    }
    if (tab.selected) {
      this.updateSelected(tab.documentGlobal);
    }
  },

  // Opens a private tab in the current space. Returns it, or null when
  // private tabs don't open in the window (switch or Settings off, or a
  // private window).
  openPrivateTab(win, { url = null, inBackground = false, force = false } = {}) {
    if ((!this.inWindow && !force) || this.isWindowPrivate(win)) {
      return null;
    }
    const { gBrowser } = win;
    const tab = gBrowser.addTrustedTab(url || PRIVATE_NEW_TAB_URL, {
      whimsyPrivate: true,
      inBackground,
      relatedToCurrent: true,
    });
    if (!tab || !this.isPrivateTab(tab)) {
      return tab;
    }
    if (!inBackground) {
      // fix7/private: the private page opens calm, with no command bar
      // popping up over it; Cmd+L opens the address bar. (Cmd+Option+T
      // itself opens the private command bar, openPrivateCommandBar.)
      gBrowser.selectedTab = tab;
    }
    return tab;
  },

  // Opens `url` in a new foreground tab on behalf of the page the person
  // is on (verbs, page actions). From a private tab it opens private, so a
  // selection or a tracking number never reaches normal history and
  // cookies. Run from the private command bar (W8-17), it opens private
  // too. `params` are openTrustedLinkIn's (userContextId,
  // triggeringPrincipal).
  openTabFor(win, url, params = {}) {
    const { gBrowser } = win;
    if (!this.isPrivateTab(gBrowser.selectedTab) && !this.urlbarIsPrivateSafe(win)) {
      win.openTrustedLinkIn(url, "tab", params);
      return;
    }
    const tab = gBrowser.addTab(url, {
      ...params,
      triggeringPrincipal: params.triggeringPrincipal ?? Services.scriptSecurityManager.getSystemPrincipal(),
      whimsyPrivate: true,
      relatedToCurrent: true,
    });
    if (tab) {
      gBrowser.selectedTab = tab;
    }
  },

  openPrivateWindow(win) {
    win.OpenBrowserWindow({ private: true });
  },

  // --- Shortcuts, menus, command bar ---

  initCommands(win) {
    const { WhimsyCommands } = lazy;
    if (this.featureOn) {
      // Scratch replaces the private window on Cmd+Shift+N (BUILD-PLAN), so
      // clear the two built-in bindings for that key in this window. wave6:
      // Zen's New Blank Window moves to Arc's Blank Window key,
      // Cmd+Ctrl+N, instead of losing its key (when that's free).
      for (const id of ["zen-new-unsynced-window", "key_privatebrowsing"]) {
        const keyEl = win.document.getElementById(id);
        if (keyEl?.getAttribute("key")?.toUpperCase() === "N") {
          const blank = { key: "N", modifiers: "accel,control" };
          if (id == "zen-new-unsynced-window" && !WhimsyCommands.findConflict(win.document, blank, id)) {
            keyEl.setAttribute("modifiers", blank.modifiers);
          } else {
            keyEl.removeAttribute("key");
            keyEl.removeAttribute("modifiers");
          }
          const keyset = keyEl.parentElement;
          const parent = keyset?.parentElement;
          if (parent) {
            keyset.remove();
            parent.append(keyset);
          }
        }
      }
    }
    const icon = "chrome://browser/skin/zen-icons/private-window.svg";
    WhimsyCommands.register(win, {
      id: "cmd_whimsyNewPrivateTab",
      l10nId: "whimsy-action-new-private-tab",
      run: w => this.runNewPrivateTab(w),
      keyId: "key_whimsyNewPrivateTab",
      key: this.featureOn ? { key: "T", modifiers: "accel,alt" } : null,
      icon,
      isAvailable: () => this.inWindow,
    });
    WhimsyCommands.register(win, {
      id: "cmd_whimsyNewScratch",
      l10nId: "whimsy-action-new-scratch",
      run: w => {
        if (!this.inWindow || !w.gZenWorkspaces?.workspaceEnabled) {
          this.openPrivateWindow(w);
          return;
        }
        this.openScratch(w).catch(e => console.error("Whimsy: Scratch", e));
      },
      keyId: "key_whimsyNewScratch",
      key: this.featureOn ? { key: "N", modifiers: "accel,shift" } : null,
      icon,
      isAvailable: () => this.inWindow,
    });
    WhimsyCommands.register(win, {
      id: "cmd_whimsyKeepScratch",
      l10nId: "whimsy-action-save-scratch",
      run: w => this.saveScratch(w).catch(e => console.error("Whimsy: Scratch", e)),
      icon,
      isAvailable: w => this.featureOn && !!this.getScratch(w),
    });
    WhimsyCommands.register(win, {
      id: "cmd_whimsyCloseScratch",
      l10nId: "whimsy-action-close-scratch",
      run: w => this.closeScratch(w).catch(e => console.error("Whimsy: Scratch", e)),
      icon,
      isAvailable: w => this.featureOn && !!this.getScratch(w),
    });
    lazy.WhimsyShortcuts.addActions([
      { l10nId: "whimsy-action-new-private-tab", command: "cmd_whimsyNewPrivateTab", icon, isAvailable: () => this.inWindow },
      { l10nId: "whimsy-action-new-scratch", command: "cmd_whimsyNewScratch", icon, isAvailable: () => this.inWindow },
      {
        l10nId: "whimsy-action-save-scratch",
        command: "cmd_whimsyKeepScratch",
        icon,
        isAvailable: w => this.featureOn && !!this.getScratch(w),
      },
      {
        l10nId: "whimsy-action-close-scratch",
        command: "cmd_whimsyCloseScratch",
        icon,
        isAvailable: w => this.featureOn && !!this.getScratch(w),
      },
    ]);
  },

  initMenus(win) {
    const { document } = win;
    const anchor = document.getElementById("menu_newPrivateWindow");
    const filePopup = document.getElementById("menu_FilePopup");
    if (anchor && !document.getElementById("menu_whimsyNewScratch")) {
      const items = [
        ["menu_whimsyNewScratch", "whimsy-menu-new-scratch", "cmd_whimsyNewScratch", "key_whimsyNewScratch"],
        ["menu_whimsyNewPrivateTab", "whimsy-menu-new-private-tab", "cmd_whimsyNewPrivateTab", "key_whimsyNewPrivateTab"],
      ].map(([id, l10nId, command, key]) => {
        const item = document.createXULElement("menuitem");
        item.id = id;
        item.setAttribute("data-l10n-id", l10nId);
        item.setAttribute("command", command);
        item.setAttribute("key", key);
        return item;
      });
      anchor.after(...items);
      // Scratch replaces the private window in the File menu (it stays in
      // Firefox's own places, and the setting brings it back).
      filePopup?.addEventListener("popupshowing", () => {
        const inWindow = this.inWindow;
        for (const item of items) {
          item.hidden = !inWindow;
        }
        if (!Services.policies || Services.policies.isAllowed("privatebrowsing")) {
          anchor.hidden = inWindow;
        }
      });
    }
    // Zen's space menu (right-click a space icon, or the space's "..."):
    // Scratch's own actions.
    const spaceMenu = document.getElementById("zenWorkspaceMoreActions");
    if (spaceMenu && !document.getElementById("context_whimsyKeepScratch")) {
      const separator = document.createXULElement("menuseparator");
      separator.id = "context_whimsyScratchSeparator";
      const items = [
        ["context_whimsyKeepScratch", "whimsy-scratch-save", "cmd_whimsyKeepScratch"],
        ["context_whimsyCloseScratch", "whimsy-scratch-close", "cmd_whimsyCloseScratch"],
      ].map(([id, l10nId, command]) => {
        const item = document.createXULElement("menuitem");
        item.id = id;
        item.setAttribute("data-l10n-id", l10nId);
        item.setAttribute("command", command);
        return item;
      });
      spaceMenu.append(separator, ...items);
      spaceMenu.addEventListener("popupshowing", event => {
        if (event.target != spaceMenu) {
          return;
        }
        let targetId = null;
        try {
          targetId = event.explicitOriginalTarget?.closest?.("toolbarbutton")?.getAttribute("zen-workspace-id");
        } catch (e) {}
        targetId ||= win.gZenWorkspaces?.activeWorkspace;
        const show = this.featureOn && this.isScratchId(win, targetId);
        separator.hidden = !show;
        for (const item of items) {
          item.hidden = !show;
        }
      });
    }
  },

  // --- Scratch ---

  initSpaces(win) {
    const spaces = win.gZenWorkspaces;
    if (!spaces?.workspaceEnabled || spaces._whimsyScratchHooks) {
      return;
    }
    spaces._whimsyScratchHooks = true;
    // Scratch is never saved, so never restored.
    const forSessionStore = spaces.getWorkspacesForSessionStore;
    spaces.getWorkspacesForSessionStore = function (...args) {
      return forSessionStore.apply(this, args).filter(space => !space.whimsyScratch);
    };
    // Zen rebuilds the switcher's icons after these, asynchronously.
    const refresh = () => {
      this.refreshScratchMarks(win);
      win.requestAnimationFrame(() => this.refreshScratchMarks(win));
    };
    win.addEventListener("ZenWorkspacesUIUpdate", refresh);
    win.addEventListener("ZenWorkspaceDataChanged", refresh);
    this.refreshScratchMarks(win);
  },

  getScratch(win) {
    return win.gZenWorkspaces?.getWorkspaces?.().find(space => space.whimsyScratch) ?? null;
  },

  isScratchId(win, id) {
    return !!id && this.getScratch(win)?.uuid == id;
  },

  activeSpaceIsScratch(win) {
    const spaces = win.gZenWorkspaces;
    return !!spaces?.workspaceEnabled && this.isScratchId(win, spaces.activeWorkspace);
  },

  // Marks Scratch's space and icon (they're rebuilt as spaces change).
  refreshScratchMarks(win) {
    const scratchId = this.getScratch(win)?.uuid;
    const { document } = win;
    for (const el of document.querySelectorAll(`[${SCRATCH_ATTR}]`)) {
      // With no Scratch (just kept), every mark goes: null != undefined is
      // false, so the plain comparison kept them all.
      if (!scratchId || (el.id != scratchId && el.getAttribute("zen-workspace-id") != scratchId)) {
        el.removeAttribute(SCRATCH_ATTR);
      }
    }
    if (scratchId) {
      win.gZenWorkspaces.workspaceElement(scratchId)?.setAttribute(SCRATCH_ATTR, "true");
      for (const button of document.querySelectorAll(`toolbarbutton[zen-workspace-id="${win.CSS.escape(scratchId)}"]`)) {
        button.setAttribute(SCRATCH_ATTR, "true");
      }
    }
    this.updateSelected(win);
  },

  // Opens Scratch (creating it to the right of every space if needed) and a
  // new private tab in it. Returns the Scratch space, or null.
  async openScratch(win) {
    const spaces = win.gZenWorkspaces;
    if (!this.inWindow || this.isWindowPrivate(win) || !spaces?.workspaceEnabled) {
      return null;
    }
    let scratch = this.getScratch(win);
    if (scratch) {
      if (spaces.activeWorkspace != scratch.uuid) {
        await spaces.changeWorkspaceWithID(scratch.uuid);
      }
    } else {
      const [name] = await win.document.l10n.formatValues([{ id: "whimsy-scratch-name" }]);
      const last = spaces.getWorkspaces().at(-1);
      scratch = await spaces.createAndSaveWorkspace(name || "Scratch", SCRATCH_ICON, false, 0, {
        insertAfterId: last?.uuid ?? null,
        beforeChangeCallback: space => {
          space.whimsyScratch = true;
          this.refreshScratchMarks(win);
        },
      });
      if (!scratch) {
        return null;
      }
      scratch.whimsyScratch = true;
      if (name && scratch.name != name) {
        // Zen names a space after its container in an unsynced window.
        scratch.name = name;
        scratch.icon = SCRATCH_ICON;
        spaces.saveWorkspace(scratch);
      }
      this.refreshScratchMarks(win);
    }
    this.openPrivateTab(win);
    return scratch;
  },

  // Removes Scratch and everything in it.
  async closeScratch(win) {
    if (win._whimsyClosingScratch) {
      return win._whimsyClosingScratch;
    }
    const scratch = this.getScratch(win);
    if (!scratch) {
      return false;
    }
    // Leave the space before closing its browsers. Zen otherwise selects a
    // tab in a workspace which is being removed, while TabClose schedules a
    // second removal of the same workspace.
    const closing = (async () => {
      const spaces = win.gZenWorkspaces;
      const destination = spaces.getWorkspaces().find(space => space.uuid != scratch.uuid);
      if (!destination) {
        return false;
      }
      if (spaces.activeWorkspace == scratch.uuid) {
        await spaces.changeWorkspaceWithID(destination.uuid);
      }
      const tabs = win.gBrowser.tabs.filter(tab =>
        !tab.closing && tab.getAttribute("zen-workspace-id") == scratch.uuid &&
        !tab.hasAttribute("zen-empty-tab") && !tab.hasAttribute("zen-essential")
      );
      // Let queued TabOpen observers run before destroying newly opened tabs.
      await new Promise(resolve => win.setTimeout(resolve, 0));
      win.gBrowser.removeTabs(tabs, { closeWindowWithLastTab: false, animate: false });
      // TabClose observers still need the workspace while they finish.
      await new Promise(resolve => win.setTimeout(resolve, 0));
      await spaces.removeWorkspace(scratch.uuid);
      this.refreshScratchMarks(win);
      return true;
    })();
    win._whimsyClosingScratch = closing;
    try {
      return await closing;
    } finally {
      delete win._whimsyClosingScratch;
    }
  },

  // wave7/scratch: saving Scratch walks through the same steps as New
  // Space, and the "no longer private" question comes last. Save as Space… opens
  // Zen's own create-space form (<zen-workspace-creation>: name, icon,
  // profile, Change Theme) inside Scratch, over its tabs, with an empty name
  // (Zen's "Space Name" placeholder) and Scratch's theme. Its button reads
  // "Save Space"; pressing it asks askKeepScratch's modal, Cancel there
  // returns to the form with everything still filled in, and Save Space
  // converts Scratch with those settings and its tabs. Cancel or Esc on the
  // form, switching spaces or closing Scratch leave it private and as it
  // was. The form is Zen's, not a copy: only its three handlers are
  // replaced on this one element, and they finish through Zen's own code.
  async saveScratch(win) {
    const scratch = this.getScratch(win);
    if (!scratch) {
      return;
    }
    const { document } = win;
    const open = win._whimsyScratchSave;
    if (open) {
      open.form.inputName?.focus();
      return;
    }
    // Zen's New Space form is already up; one form at a time.
    if (document.documentElement.hasAttribute("zen-creating-workspace")) {
      return;
    }
    const spaces = win.gZenWorkspaces;
    if (spaces.activeWorkspace != scratch.uuid) {
      await spaces.changeWorkspaceWithID(scratch.uuid);
    }
    const spaceElement = spaces.workspaceElement(scratch.uuid);
    if (!this.isScratchId(win, scratch.uuid) || spaces.activeWorkspace != scratch.uuid || !spaceElement ||
        win._whimsyScratchSave || document.documentElement.hasAttribute("zen-creating-workspace")) {
      return;
    }
    const form = document.createXULElement("zen-workspace-creation");
    const flow = { form, scratchId: scratch.uuid, snapshot: { ...this.getScratch(win) }, asking: false, done: false };
    form.setAttribute("workspace-id", scratch.uuid);
    form.setAttribute("previous-workspace-id", scratch.uuid);
    form.setAttribute("whimsy-scratch-save", "true");
    // Own properties win over the class's methods, and Zen binds these
    // three when the element connects, so set them before appending it.
    form.onCreateButtonCommand = () => this.onScratchSaveCommand(win, flow);
    form.onCancelButtonCommand = () => this.endScratchSave(win, flow);
    form.handleZenWorkspacesChange = () => this.endScratchSave(win, flow);
    win._whimsyScratchSave = flow;
    document.documentElement.setAttribute("zen-creating-workspace", "true");
    spaceElement.appendChild(form);
    await form.promiseInitialized;
    // Same form, Scratch's words: set before the first paint.
    const l10n = [
      [".zen-workspace-creation-title", "whimsy-scratch-save-header"],
      [".zen-workspace-creation-label", "whimsy-scratch-save-label"],
      [".zen-workspace-creation-create-button", "whimsy-scratch-save-button"],
    ];
    for (const [selector, id] of l10n) {
      const el = form.querySelector(selector);
      if (el) {
        document.l10n.setAttributes(el, id);
      }
    }
    form.inputName.value = "";
    form.createButton.disabled = true;
    if (!spaces.shouldShowContainers) {
      // No profile row: Create would otherwise reset it to Default.
      form._profileId = scratch.containerTabId ?? 0;
    }
    this.revealScratchSave(win, form);
    form.finishSetup();
  },

  // Zen's form slides in with a new space; Scratch is already there, so the
  // form rises into place instead: Zen's own exit (y 20, blur 2px, 30ms
  // stagger, 0.3s spring without bounce) played forwards. A plain cut with
  // reduced motion.
  revealScratchSave(win, form) {
    const motion = win.gZenUIManager?.motion;
    const elements = form.elementsToAnimate.filter(Boolean);
    const reduced = win.gReduceMotion || win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!motion || reduced || !elements.length) {
      return;
    }
    for (const el of elements) {
      el.style.opacity = "0";
    }
    motion
      .animate(
        elements,
        { y: [20, 0], opacity: [0, 1], filter: ["blur(2px)", "blur(0)"] },
        { duration: 0.3, type: "spring", bounce: 0, delay: motion.stagger(0.03) }
      )
      .then(() => {
        for (const el of elements) {
          el.style.removeProperty("opacity");
          el.style.removeProperty("transform");
          el.style.removeProperty("filter");
        }
      })
      .catch(() => {});
  },

  // "Save Space": the privacy question is the last step.
  async onScratchSaveCommand(win, flow) {
    const { form } = flow;
    if (flow.asking || flow.done) {
      return;
    }
    // Zen's rule for New Space: no name, no space (the button stays off).
    if (!form.inputName.value.trim()) {
      form.inputName.focus();
      return;
    }
    flow.asking = true;
    let keep = false;
    try {
      keep = await this.askKeepScratch(win);
    } finally {
      flow.asking = false;
    }
    if (flow.done) {
      // Scratch closed or another space was chosen meanwhile.
      return;
    }
    if (!keep) {
      // Back to the form, everything still filled in.
      form.inputName.focus();
      return;
    }
    const spaces = win.gZenWorkspaces;
    if (!this.isScratchId(win, flow.scratchId) || spaces.activeWorkspace != flow.scratchId) {
      await this.endScratchSave(win, flow);
      return;
    }
    flow.done = true;
    delete win._whimsyScratchSave;
    await this.closeThemePicker(win);
    // Zen's own Create: writes the name, icon and profile into the active
    // space (Scratch) and tidies the form away. Then Scratch stops being
    // Scratch, keeping those and its theme.
    const proto = win.customElements.get("zen-workspace-creation").prototype;
    try {
      await proto.onCreateButtonCommand.call(form);
    } catch (e) {
      console.error("Whimsy: Scratch", e);
      form.remove();
    }
    await this.keepScratch(win).catch(e => console.error("Whimsy: Scratch", e));
  },

  // Cancel, Esc, another space or Scratch closing: Scratch stays private and
  // exactly as it was (name, icon, profile, theme).
  async endScratchSave(win, flow) {
    if (flow.done) {
      return;
    }
    flow.done = true;
    if (win._whimsyScratchSave == flow) {
      delete win._whimsyScratchSave;
    }
    const { form, snapshot } = flow;
    const spaces = win.gZenWorkspaces;
    const proto = win.customElements.get("zen-workspace-creation").prototype;
    await this.closeThemePicker(win);
    const restore = () => {
      const scratch = spaces.getWorkspaceFromId(flow.scratchId);
      if (scratch?.whimsyScratch) {
        const restored = { ...snapshot };
        spaces.saveWorkspace(restored);
        if (spaces.activeWorkspace == restored.uuid) {
          win.gZenThemePicker?.onWorkspaceChange(restored);
        }
      }
    };
    try {
      if (!form.isConnected) {
        // Gone with its space; nothing to tidy.
      } else if (spaces.activeWorkspace == flow.scratchId && this.isScratchId(win, flow.scratchId)) {
        // Zen's form only tidies itself away (with its fade) through Create,
        // so Create puts Scratch's own values back: the form shows them, then
        // they're saved unchanged, theme included.
        const scratch = spaces.getWorkspaceFromId(flow.scratchId);
        scratch.theme = snapshot.theme;
        form.inputName.value = snapshot.name ?? "";
        if (snapshot.icon?.endsWith(".svg")) {
          form.inputIcon.label = "";
          form.inputIcon.image = snapshot.icon;
        } else {
          form.inputIcon.image = "";
          form.inputIcon.label = snapshot.icon || "";
        }
        form._profileId = snapshot.containerTabId ?? 0;
        await proto.onCreateButtonCommand.call(form);
      } else {
        // Another space is showing: Zen's tidy-up for that case, minus the
        // part that deletes the space being created (that's Scratch here).
        const own = Object.getOwnPropertyDescriptor(spaces, "removeWorkspace");
        spaces.removeWorkspace = () => Promise.resolve();
        try {
          await proto.handleZenWorkspacesChange.call(form);
        } finally {
          if (own) {
            Object.defineProperty(spaces, "removeWorkspace", own);
          } else {
            delete spaces.removeWorkspace;
          }
        }
      }
    } catch (e) {
      console.error("Whimsy: Scratch", e);
      form.remove();
    }
    restore();
    this.refreshScratchMarks(win);
  },

  // The theme picker saves the space it edits when it closes, so close it
  // first and let that land before Scratch is saved or restored.
  async closeThemePicker(win) {
    const panel = win.gZenThemePicker?.panel;
    if (!panel || panel.state == "closed") {
      return;
    }
    await new Promise(resolve => {
      const timer = win.setTimeout(resolve, 1000);
      panel.addEventListener("popuphidden", () => {
        win.clearTimeout(timer);
        resolve();
      }, { once: true });
      panel.hidePopup();
    });
  },

  // fixC: keeping Scratch ends its private browsing, which the old "Keep as
  // Space" didn't say, so it asks first. wave5/uxfix + fix7/private: it
  // can't be undone, so it asks in a modal dialog, the same window-modal
  // prompt as Firefox's close-window warning and Whimsy's Delete Space
  // (never a toast or notification): a title, one sentence, Cancel and
  // "Save Space" (wave7: one verb, Save, through the flow). Cancel is the default (Return and Esc both cancel).
  // wave7/scratch: it is the last step of saveScratch. Resolves true for
  // Save Space.
  async askKeepScratch(win) {
    const [title, body, accept] = await win.document.l10n.formatValues([
      "whimsy-scratch-save-confirm-title",
      "whimsy-scratch-save-confirm",
      "whimsy-scratch-save-confirm-accept",
    ]);
    return lazy.WhimsyPanels.confirm(win, { title, body, accept, cancelDefault: true });
  },

  // Turns Scratch into a normal space. Private pages can't stop being
  // private, so each reopens as a normal tab in the same place.
  async keepScratch(win) {
    const spaces = win.gZenWorkspaces;
    const scratch = this.getScratch(win);
    if (!scratch) {
      return null;
    }
    const { gBrowser } = win;
    const privateTabs = gBrowser.tabs.filter(
      tab => !tab.closing && tab.getAttribute("zen-workspace-id") == scratch.uuid && this.isPrivateTab(tab)
    );
    // fix7/private: the kept space keeps the name it had ("Scratch", or
    // what the person renamed it to). It used to take a fixed string,
    // whimsy-scratch-kept-name, whose value was "Space". Rename inline later.
    // wave7/scratch: saved through the form, it has the name and icon chosen
    // there; only the private icon goes.
    const kept = { ...scratch, name: scratch.name || "Scratch", icon: scratch.icon == SCRATCH_ICON ? undefined : scratch.icon };
    delete kept.whimsyScratch;
    spaces.saveWorkspace(kept);
    // fixC: the private look goes the moment it's a normal space. Zen only
    // redraws a space's name and icon when it is switched to or renamed
    // inline (ZenSpace.onIndicatorRenameFinished sets the text itself), so
    // the header kept saying "Scratch" with the private icon; and the marks
    // were only cleared at the very end, after waiting for tab switches.
    spaces.updateWorkspaceIndicator?.(kept, spaces.workspaceElement(kept.uuid)?.indicator);
    this.refreshScratchMarks(win);
    let reopened = 0;
    let selectedCopy = null;
    for (const tab of privateTabs) {
      const url = tab.linkedBrowser.currentURI?.spec;
      if (!url || url == PRIVATE_NEW_TAB_URL || url == "about:blank") {
        continue;
      }
      const copy = gBrowser.addTrustedTab(url, {
        // The profile chosen in the form (Default otherwise).
        userContextId: kept.containerTabId || 0,
        tabIndex: tab.index,
        inBackground: true,
        relatedToCurrent: false,
        zenWorkspaceId: scratch.uuid,
        skipRoute: true,
      });
      if (copy && tab.selected) {
        selectedCopy = copy;
      }
      if (copy) {
        reopened++;
      }
    }
    // Keep an empty Scratch usable too, without selecting a browser about
    // to be destroyed. Private new-tab pages have no public page to reopen.
    if (privateTabs.some(tab => tab.selected) && !selectedCopy) {
      selectedCopy = gBrowser.addTrustedTab(win.BROWSER_NEW_TAB_URL, {
        userContextId: kept.containerTabId || 0,
        inBackground: true, zenWorkspaceId: scratch.uuid, skipRoute: true,
      });
    }
    if (selectedCopy && gBrowser.selectedTab != selectedCopy) {
      await new Promise(resolve => {
        // Don't hang the rest (closing the private pages) on a switch that
        // never reports back.
        const timer = win.setTimeout(resolve, 2000);
        gBrowser.addEventListener("TabSwitchDone", () => {
          win.clearTimeout(timer);
          resolve();
        }, { once: true });
        gBrowser.selectedTab = selectedCopy;
      });
    }
    await new Promise(resolve => win.setTimeout(resolve, 0));
    gBrowser.removeTabs(privateTabs, { closeWindowWithLastTab: false, animate: false });
    this.refreshScratchMarks(win);
    win.gZenUIManager?.showToast("whimsy-scratch-kept-toast", { l10nArgs: { count: reopened } });
    return kept;
  },

  // Closing Scratch's last tab closes Scratch.
  onTabClose(win, tab) {
    if (win._whimsyClosingScratch) {
      return;
    }
    const scratch = this.getScratch(win);
    if (!scratch || tab.getAttribute("zen-workspace-id") != scratch.uuid) {
      return;
    }
    win.setTimeout(() => {
      const current = this.getScratch(win);
      if (win._whimsyClosingScratch || !current || current.uuid != scratch.uuid) {
        return;
      }
      const left = win.gBrowser.tabs.some(
        t =>
          !t.closing &&
          t.getAttribute("zen-workspace-id") == scratch.uuid &&
          !t.hasAttribute("zen-empty-tab") &&
          !t.hasAttribute("zen-essential")
      );
      if (!left) {
        this.closeScratch(win).catch(e => console.error("Whimsy: Scratch", e));
      }
    }, 0);
  },

  // --- Private command bar (W8-17, W8-18) ---
  //
  // Cmd+Option+T opens Zen's floating command bar in private mode: the
  // bar wears the private tab's violet ring and a "Private" badge, its
  // query runs as private browsing (no input or search history, Firefox's
  // private suggestion prefs, private open tabs only), and whatever is
  // picked opens in a new private tab. Esc creates nothing. Cmd+T is always
  // the normal bar, even over a private tab (it opens a normal tab), except
  // in Scratch, where every new tab is private. Cmd+L on a private tab is
  // violet: it edits that private tab.
  //
  // The address bar learns its side from urlbarIsPrivate, read live by the
  // input's and its controller's isPrivate. Loads are checked again where
  // they happen (the controller's loadURL and switchToTab), so a private
  // bar never loads into a normal tab or opens one.

  urlbarState(win) {
    let state = urlbarStates.get(win);
    if (!state) {
      state = { compose: false, pendingUntil: 0, forcePrivate: 0 };
      urlbarStates.set(win, state);
    }
    return state;
  },

  // Whether the window's address bar serves private browsing right now.
  urlbarIsPrivate(win) {
    if (this.isWindowPrivate(win)) {
      return true;
    }
    const state = this.urlbarState(win);
    if (state.compose || state.pendingUntil > Date.now()) {
      return true;
    }
    const urlbar = win.gURLBar;
    if (urlbar?.hasAttribute("zen-newtab")) {
      // Cmd+T's bar is for a new tab: normal, unless that tab will be
      // private because it opens in Scratch (shouldOpenPrivate).
      return this.inWindow && this.activeSpaceIsScratch(win);
    }
    return this.isPrivateTab(win.gBrowser?.selectedTab);
  },

  // For the isPrivate getters: if the answer can't be worked out (a
  // window closing), private is the safe one.
  urlbarIsPrivateSafe(win) {
    try {
      return this.urlbarIsPrivate(win);
    } catch (e) {
      console.error("Whimsy: private command bar", e);
      return true;
    }
  },

  // A load or switch is starting from the address bar: private or not.
  // An Enter's pending flag is used once.
  takeUrlbarPrivate(win) {
    const state = this.urlbarState(win);
    const pending = state.pendingUntil > Date.now();
    state.pendingUntil = 0;
    return pending || this.urlbarIsPrivate(win);
  },

  // Installs, once per window and as each part exists, the hooks that make
  // the address bar follow urlbarIsPrivate. Returns the window's state;
  // `controllerHooked` says whether loads can be steered (needed before the
  // private command bar may open).
  installUrlbarHooks(win) {
    const state = this.urlbarState(win);
    const urlbar = win.gURLBar;
    if (!urlbar || this.isWindowPrivate(win)) {
      return state;
    }
    const self = this;
    if (!state.inputHooked) {
      state.inputHooked = true;
      // The input's isPrivate is read for every query (UrlbarQueryContext),
      // pick and load; it used to be set on each TabSelect.
      Object.defineProperty(urlbar, "isPrivate", {
        configurable: true,
        enumerable: true,
        get: () => self.urlbarIsPrivateSafe(win),
        set: () => {},
      });
      // Enter can resolve what was typed asynchronously; keep that load
      // private even if the bar has closed by then.
      const handleNavigation = urlbar.handleNavigation;
      urlbar.handleNavigation = function (...args) {
        if (state.compose) {
          state.pendingUntil = Date.now() + PENDING_PRIVATE_MS;
        }
        return handleNavigation.apply(this, args);
      };
      // A fresh Cmd+L session starts clean.
      urlbar.addEventListener("focus", () => {
        if (!state.compose) {
          state.pendingUntil = 0;
        }
      }, true);
      // Zen's new-tab session ends (pick, Esc, blur, tab switch) by
      // removing zen-newtab: the private bar ends with it.
      new win.MutationObserver(() => {
        if (state.compose && !urlbar.hasAttribute("zen-newtab")) {
          state.compose = false;
        }
        self.refreshUrlbar(win);
      }).observe(urlbar, { attributes: true, attributeFilter: ["zen-newtab"] });
      // Cmd+T while the private bar is open turns it back into the normal
      // bar (each shortcut means its own bar); any other new-tab session
      // ends private mode first.
      const ui = win.gZenUIManager;
      if (ui && typeof ui.handleNewTab == "function") {
        const handleNewTab = ui.handleNewTab;
        ui.handleNewTab = function (werePassedURL, searchClipboard, where, override, ...rest) {
          if (!state.openingCompose) {
            try {
              state.pendingUntil = 0;
              if (
                state.compose &&
                !override &&
                !werePassedURL &&
                !searchClipboard &&
                where === "tab" &&
                !ui.testingEnabled &&
                urlbar.hasAttribute("zen-newtab") &&
                win.gZenVerticalTabsManager?._canReplaceNewTab
              ) {
                self.setCompose(win, false);
                return true;
              }
              if (state.compose) {
                self.setCompose(win, false, { requery: false });
              }
            } catch (e) {
              console.error("Whimsy: private command bar", e);
            }
          }
          return handleNewTab.call(this, werePassedURL, searchClipboard, where, override, ...rest);
        };
      }
    }
    if (!state.controllerHooked) {
      let controller = null;
      try {
        controller = urlbar.parentController;
      } catch (e) {
        // Not initialised yet; the next TabSelect or Cmd+Option+T retries.
      }
      // Only the in-process controller; with browser.urlbar.ipc.
      // chromeMessagePassing loads can't be steered, so the private command
      // bar stays off (Cmd+Option+T opens a private tab as before).
      if (controller?.constructor?.name == "UrlbarParentController") {
        state.controllerHooked = true;
        this.hookUrlbarController(win, controller);
      }
    }
    return state;
  },

  hookUrlbarController(win, controller) {
    const self = this;
    const state = this.urlbarState(win);
    // Form history, input history, URI fixup and the fallback heuristic
    // ask the controller (the engine patch made it ask the selected tab).
    Object.defineProperty(controller, "isPrivate", {
      configurable: true,
      enumerable: true,
      get: () => self.urlbarIsPrivateSafe(win),
      set: () => {},
    });
    const loadURL = controller.loadURL;
    controller.loadURL = function (args = {}) {
      let isPrivate = false;
      try {
        isPrivate = self.takeUrlbarPrivate(win);
      } catch (e) {
        // Unsure: private is the safe side.
        console.error("Whimsy: private command bar", e);
        isPrivate = true;
      }
      if (!isPrivate) {
        return loadURL.call(this, args);
      }
      let { where, params = {} } = args;
      if (where == "current") {
        // Never into a normal tab: the private bar opened over one, or a
        // result asked to replace it.
        const target = this.resolveTargetBrowser?.(args.browserId) || win.gBrowser.selectedBrowser;
        if (!self.isPrivateBrowser(target)) {
          where = "tab";
        }
      }
      // A new window is a private window, and principals carry the
      // private origin attributes (URILoadingHelper's updatePrincipals).
      params = { ...params, private: true };
      state.forcePrivate++;
      try {
        return loadURL.call(this, { ...args, where, params });
      } finally {
        state.forcePrivate--;
      }
    };
    // Searches the bar runs itself (a one-off's search page, an engine's
    // home page) skip loadURL: steer them the same way. They can't be told
    // to open a private window, so a new window becomes a private tab.
    for (const [name, whereAt, browserAt] of [["openSERP", 2, 4], ["openSearchForm", 1, 3]]) {
      const original = controller[name];
      if (typeof original != "function") {
        continue;
      }
      controller[name] = function (...args) {
        let isPrivate = true;
        try {
          isPrivate = self.takeUrlbarPrivate(win);
        } catch (e) {
          console.error("Whimsy: private command bar", e);
        }
        if (!isPrivate) {
          return original.apply(this, args);
        }
        let where = args[whereAt];
        if (where == "window") {
          where = "tab";
        } else if (where == "current") {
          const target = this.resolveTargetBrowser?.(args[browserAt]) || win.gBrowser.selectedBrowser;
          if (!self.isPrivateBrowser(target)) {
            where = "tab";
          }
        }
        args[whereAt] = where;
        state.forcePrivate++;
        try {
          return original.apply(this, args);
        } finally {
          state.forcePrivate--;
        }
      };
    }
    // Switch to Tab compares candidates with the selected tab's side
    // (whimsy-URILoadingHelper-sys-mjs.patch); the bar's side is what
    // counts when the two differ (the private bar over a normal tab, Cmd+T
    // over a private one).
    const switchToTab = controller.switchToTab;
    controller.switchToTab = function (args = {}) {
      let isPrivate;
      try {
        isPrivate = self.takeUrlbarPrivate(win);
        if (isPrivate == self.isPrivateBrowser(win.gBrowser.selectedBrowser)) {
          return switchToTab.call(this, args);
        }
        const { WhimsyAlreadyOpen } = lazy;
        const found = WhimsyAlreadyOpen.findTab(win, args.url, {
          userContextId: Number(args.userContextId) || 0,
          isPrivate,
        });
        if (found) {
          WhimsyAlreadyOpen.switchTo(win, found);
          return undefined;
        }
      } catch (e) {
        console.error("Whimsy: private command bar", e);
        if (isPrivate === undefined) {
          return switchToTab.call(this, args);
        }
      }
      // The tab has gone: open its page on the bar's side instead.
      if (isPrivate) {
        self.openPrivateTab(win, { url: args.url, force: true });
      } else {
        win.openTrustedLinkIn(args.url, "tab");
      }
      return undefined;
    };
  },

  // Cmd+Option+T (and New Private Tab in menus and the command bar).
  runNewPrivateTab(win) {
    if (!this.inWindow || this.isWindowPrivate(win)) {
      this.openPrivateWindow(win);
      return;
    }
    const open = () => {
      if (!this.openPrivateCommandBar(win)) {
        this.openPrivateTab(win);
      }
    };
    // Run from inside the bar (a command bar action, or the key while it's
    // focused): let Zen finish closing the current session first, so it
    // doesn't close the private one. Both are zero-delay timeouts, in order.
    if (win.gURLBar?.focused) {
      win.setTimeout(() => {
        try {
          open();
        } catch (e) {
          console.error("Whimsy: private command bar", e);
        }
      }, 0);
      return;
    }
    open();
  },

  // Opens the command bar in private mode. False when it can't (the caller
  // opens a private tab instead).
  openPrivateCommandBar(win) {
    const { gURLBar: urlbar, gZenUIManager: ui } = win;
    if (!urlbar || typeof ui?.handleNewTab != "function") {
      return false;
    }
    const state = this.installUrlbarHooks(win);
    if (!state.controllerHooked || !state.inputHooked) {
      return false;
    }
    if (state.compose) {
      // Pressed again: close it, as Cmd+T closes its bar.
      if (urlbar._zenHandleUrlbarClose) {
        urlbar._zenHandleUrlbarClose();
      } else {
        this.setCompose(win, false, { requery: false });
      }
      return true;
    }
    if (urlbar.hasAttribute("zen-newtab") && urlbar.focused) {
      // Cmd+T's bar is open: turn it private, keeping what was typed.
      this.setCompose(win, true);
      return true;
    }
    // Private before Zen opens the bar, so its first query is private.
    state.compose = true;
    state.pendingUntil = 0;
    let opened = false;
    state.openingCompose = true;
    try {
      opened = ui.handleNewTab(false, false, "tab", true);
    } catch (e) {
      console.error("Whimsy: private command bar", e);
    } finally {
      state.openingCompose = false;
    }
    if (!opened || !urlbar.hasAttribute("zen-newtab")) {
      state.compose = false;
      this.refreshUrlbar(win);
      return false;
    }
    this.guardComposeClose(win);
    this.refreshUrlbar(win);
    return true;
  },

  // Zen keeps the last new-tab text for its next Cmd+T bar (zen.urlbar.
  // wait-to-clear). Text typed privately never carries over: the private
  // session closes as a tab switch does, which forgets it.
  guardComposeClose(win) {
    const urlbar = win.gURLBar;
    const close = urlbar._zenHandleUrlbarClose;
    if (typeof close != "function" || close._whimsyPrivate) {
      return;
    }
    const state = this.urlbarState(win);
    const guarded = (onSwitch, onElementPicked) =>
      close(onSwitch || state.compose, onElementPicked);
    guarded._whimsyPrivate = true;
    urlbar._zenHandleUrlbarClose = guarded;
  },

  // Switches the open bar between private and normal, and re-runs its query
  // so the results match the new side.
  setCompose(win, on, { requery = true } = {}) {
    const state = this.urlbarState(win);
    state.compose = !!on;
    if (!on) {
      state.pendingUntil = 0;
    } else {
      this.guardComposeClose(win);
    }
    this.refreshUrlbar(win);
    const urlbar = win.gURLBar;
    if (requery && urlbar?.focused) {
      try {
        urlbar.startQuery?.({ allowAutofill: false });
      } catch (e) {
        console.error("Whimsy: private command bar", e);
      }
    }
  },

  // The violet ring and the "Private" badge (whimsy-browser.css), and the
  // badge as the input's description, so it's announced too.
  refreshUrlbar(win) {
    const urlbar = win.gURLBar;
    if (!urlbar || this.isWindowPrivate(win)) {
      return;
    }
    const isPrivate = this.urlbarIsPrivate(win);
    urlbar.toggleAttribute(URLBAR_ATTR, isPrivate);
    const doc = win.document;
    let badge = doc.getElementById(URLBAR_BADGE_ID);
    if (!badge && isPrivate) {
      const box = urlbar.querySelector(".urlbar-input-box");
      if (box) {
        badge = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
        badge.id = URLBAR_BADGE_ID;
        badge.setAttribute("data-l10n-id", "whimsy-urlbar-private-badge");
        box.after(badge);
      }
    }
    const input = urlbar.inputField;
    if (input) {
      const ids = (input.getAttribute("aria-describedby") || "").split(/\s+/).filter(id => id && id != URLBAR_BADGE_ID);
      if (isPrivate && badge) {
        ids.push(URLBAR_BADGE_ID);
      }
      if (ids.length) {
        input.setAttribute("aria-describedby", ids.join(" "));
      } else {
        input.removeAttribute("aria-describedby");
      }
    }
  },

  // --- Indicators ---

  updateSelected(win) {
    const selected = win.gBrowser?.selectedTab;
    const isPrivate = this.isPrivateTab(selected);
    win.document.documentElement.toggleAttribute(SELECTED_ATTR, isPrivate);
    if (win.gURLBar && !this.isWindowPrivate(win)) {
      // The address bar's own private checks (input history, suggestions,
      // open tabs) follow what it is editing, not just the selected tab.
      if (!this.installUrlbarHooks(win).inputHooked) {
        win.gURLBar.isPrivate = isPrivate;
      }
      this.refreshUrlbar(win);
    }
    this.updateDownloads(win, isPrivate);
  },

  // Points the downloads panel and indicator at the private or the normal
  // downloads list. Both attach to a list once, so they're detached and
  // re-attached when the selected tab's side changes.
  updateDownloads(win, isPrivate) {
    if (!!win.whimsyDownloadsPrivate == isPrivate) {
      return;
    }
    const panel = win.DownloadsPanel;
    const indicator = win.DownloadsIndicatorView;
    const panelOn = !!panel?._initialized;
    const indicatorOn = !!indicator?._initialized;
    try {
      if (panelOn) {
        panel.terminate();
        // The view keeps the old list's rows; drop them before the other
        // list adds its own.
        const view = win.DownloadsView;
        for (const download of [...(view?._downloads ?? [])]) {
          view.onDownloadRemoved(download);
        }
      }
      if (indicatorOn) {
        indicator.ensureTerminated();
      }
    } catch (e) {
      console.error("Whimsy: private downloads", e);
    }
    // Not enumerable: it's window state, not a script global.
    Object.defineProperty(win, "whimsyDownloadsPrivate", {
      value: isPrivate,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    try {
      if (indicatorOn) {
        indicator.ensureInitialized();
      }
      if (panelOn) {
        panel.initialize();
      }
    } catch (e) {
      console.error("Whimsy: private downloads", e);
    }
  },
};
