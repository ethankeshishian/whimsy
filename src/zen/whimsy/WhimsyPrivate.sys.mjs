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
//   alt-tabbing to a whole other window.
// - Scratch (Cmd+Shift+N): a temporary private space, added to the right of
//   every space. Everything opened in it is private. Closing its last tab
//   (or Close Scratch) removes it; it is never saved or restored. "Keep as
//   Space" turns it into a normal space (its pages reopen outside private
//   browsing), and a tab moved to another space stays private there.
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
// Not covered: the downloads panel lists a normal window's downloads, so a
// private tab's download is saved but only shown in the Library; "switch to
// tab" results can offer a private tab's page in a normal tab's address bar.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivacyFilter: "resource://gre/modules/sessionstore/PrivacyFilter.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  TabStateCache: "moz-src:///browser/components/sessionstore/TabStateCache.sys.mjs",
  UrlbarUtils: "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs",
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
    if (this.isWindowPrivate(win) || !win.gBrowser) {
      // Everything in a private window is private already.
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
        if (WhimsyPrivate.selectedTabIsPrivate()) {
          return Promise.resolve();
        }
        return original.apply(this, args);
      };
    };
    skipWhenPrivate("addToInputHistory");
    skipWhenPrivate("addToInputHistoryWhenReady");
    const addToFormHistory = utils.addToFormHistory;
    if (typeof addToFormHistory == "function") {
      utils.addToFormHistory = function (isPrivate, ...rest) {
        return addToFormHistory.call(this, isPrivate || WhimsyPrivate.selectedTabIsPrivate(), ...rest);
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
    // openPrivateTab already checked the switch and setting.
    if (options.whimsyPrivate) {
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
      focusUrlBar: !url && !inBackground,
    });
    if (!tab || !this.isPrivateTab(tab)) {
      return tab;
    }
    if (!inBackground) {
      gBrowser.selectedTab = tab;
      if (!url) {
        win.gURLBar?.select();
      }
    }
    return tab;
  },

  openPrivateWindow(win) {
    win.OpenBrowserWindow({ private: true });
  },

  // --- Shortcuts, menus, command bar ---

  initCommands(win) {
    const { WhimsyShortcuts } = lazy;
    if (this.featureOn) {
      // Scratch replaces the private window on Cmd+Shift+N (BUILD-PLAN), so
      // clear the two built-in bindings for that key in this window.
      for (const id of ["zen-new-unsynced-window", "key_privatebrowsing"]) {
        const keyEl = win.document.getElementById(id);
        if (keyEl?.getAttribute("key")?.toUpperCase() === "N") {
          keyEl.removeAttribute("key");
          keyEl.removeAttribute("modifiers");
          const keyset = keyEl.parentElement;
          const parent = keyset?.parentElement;
          if (parent) {
            keyset.remove();
            parent.append(keyset);
          }
        }
      }
    }
    WhimsyShortcuts.addCommand(win, {
      id: "cmd_whimsyNewPrivateTab",
      run: w => this.openPrivateTab(w) ?? this.openPrivateWindow(w),
      key: this.featureOn ? { id: "key_whimsyNewPrivateTab", key: "T", modifiers: "accel,alt" } : null,
    });
    WhimsyShortcuts.addCommand(win, {
      id: "cmd_whimsyNewScratch",
      run: w => {
        if (!this.inWindow || !w.gZenWorkspaces?.workspaceEnabled) {
          this.openPrivateWindow(w);
          return;
        }
        this.openScratch(w).catch(e => console.error("Whimsy: Scratch", e));
      },
      key: this.featureOn ? { id: "key_whimsyNewScratch", key: "N", modifiers: "accel,shift" } : null,
    });
    WhimsyShortcuts.addCommand(win, {
      id: "cmd_whimsyKeepScratch",
      run: w => this.keepScratch(w).catch(e => console.error("Whimsy: Scratch", e)),
    });
    WhimsyShortcuts.addCommand(win, {
      id: "cmd_whimsyCloseScratch",
      run: w => this.closeScratch(w).catch(e => console.error("Whimsy: Scratch", e)),
    });
    const icon = "chrome://browser/skin/zen-icons/private-window.svg";
    WhimsyShortcuts.addActions([
      { l10nId: "whimsy-action-new-private-tab", command: "cmd_whimsyNewPrivateTab", icon, isAvailable: () => this.inWindow },
      { l10nId: "whimsy-action-new-scratch", command: "cmd_whimsyNewScratch", icon, isAvailable: () => this.inWindow },
      {
        l10nId: "whimsy-action-keep-scratch",
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
        ["context_whimsyKeepScratch", "whimsy-scratch-keep", "cmd_whimsyKeepScratch"],
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
      if (el.id != scratchId && el.getAttribute("zen-workspace-id") != scratchId) {
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

  // Turns Scratch into a normal space. Private pages can't stop being
  // private, so each reopens as a normal tab in the same place.
  async keepScratch(win) {
    const spaces = win.gZenWorkspaces;
    const scratch = this.getScratch(win);
    if (!scratch) {
      return null;
    }
    const [name] = await win.document.l10n.formatValues([{ id: "whimsy-scratch-kept-name" }]);
    const { gBrowser } = win;
    const privateTabs = gBrowser.tabs.filter(
      tab => !tab.closing && tab.getAttribute("zen-workspace-id") == scratch.uuid && this.isPrivateTab(tab)
    );
    const kept = { ...scratch, name: name || "Space", icon: undefined };
    delete kept.whimsyScratch;
    spaces.saveWorkspace(kept);
    let reopened = 0;
    let selectedCopy = null;
    for (const tab of privateTabs) {
      const url = tab.linkedBrowser.currentURI?.spec;
      if (!url || url == PRIVATE_NEW_TAB_URL || url == "about:blank") {
        continue;
      }
      const copy = gBrowser.addTrustedTab(url, {
        tabIndex: tab._tPos,
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
        inBackground: true, zenWorkspaceId: scratch.uuid, skipRoute: true,
      });
    }
    if (selectedCopy && gBrowser.selectedTab != selectedCopy) {
      await new Promise(resolve => {
        gBrowser.addEventListener("TabSwitchDone", resolve, { once: true });
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

  // --- Indicators ---

  updateSelected(win) {
    const selected = win.gBrowser?.selectedTab;
    const isPrivate = this.isPrivateTab(selected);
    win.document.documentElement.toggleAttribute(SELECTED_ATTR, isPrivate);
    if (win.gURLBar && !this.isWindowPrivate(win)) {
      // The address bar's own private checks (input history, the private
      // search engine's placeholder).
      win.gURLBar.isPrivate = isPrivate;
    }
  },
};
