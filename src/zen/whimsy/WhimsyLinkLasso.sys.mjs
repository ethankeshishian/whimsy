/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Link lasso (Linkclump, Snap Links, Multi-Link Paste): researching means
// opening ten results, a docs index or a reading list one Cmd+click at a
// time. Option-drag a rectangle over the links instead (the page shows a
// live count), let go, and a small pill offers "Open as Tabs" and "Make Folder".
// Both actions are also registered WhimsyCommands with NO default shortcut.
// Private tabs, private windows and Scratch never make folders (folders
// are kept; private pages aren't).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.link-lasso";
export const MAX_LINKS = 100;

export const WhimsyLinkLasso = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  selectionByBrowser: new WeakMap(),

  isPrivate(win, browser) {
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      return true;
    }
    const tab = win.gBrowser.getTabForBrowser(browser);
    const P = lazy.WhimsyPrivate;
    return (
      !tab ||
      P.isPrivateTab(tab) ||
      P.isPrivateBrowser(browser) ||
      P.isScratchId(win, tab.getAttribute("zen-workspace-id"))
    );
  },

  folderName(pageTitle, pageURL) {
    let name = (pageTitle ?? "").replace(/\s+/g, " ").trim();
    if (!name) {
      try {
        name = new URL(pageURL).hostname.replace(/^www\./, "");
      } catch (e) {}
    }
    return name.length > 60 ? `${name.slice(0, 59).trim()}…` : name || "Links";
  },

  setSelected(win, browser, data) {
    if (browser) {
      this.selectionByBrowser.set(browser, data);
    }
  },

  clearSelected(win, browser) {
    if (browser) {
      this.selectionByBrowser.delete(browser);
    }
  },

  hasSelection(win) {
    const browser = win?.gBrowser?.selectedBrowser;
    return !!(browser && this.selectionByBrowser.get(browser)?.links?.length);
  },

  closeChildLasso(browser) {
    try {
      const actor = browser?.browsingContext?.currentWindowGlobal?.getActor("WhimsyLasso");
      actor?.sendAsyncMessage("WhimsyLasso:Close");
    } catch (e) {}
  },

  _resolveArgs(win, targetBrowser, targetData) {
    if (targetBrowser && !targetBrowser.tagName && typeof targetBrowser == "object" && "links" in targetBrowser) {
      targetData = targetBrowser;
      targetBrowser = win?.gBrowser?.selectedBrowser;
    }
    const browser = targetBrowser ?? win?.gBrowser?.selectedBrowser;
    const data = targetData ?? (browser ? this.selectionByBrowser.get(browser) : null);
    return { browser, data };
  },

  // Opens the lassoed links as unloaded tabs in the background.
  openTabs(win, targetBrowser, targetData) {
    const { browser, data } = this._resolveArgs(win, targetBrowser, targetData);
    const links = data?.links;
    if (!this.enabled || !links?.length || !browser || !win?.gBrowser) {
      return null;
    }
    if (this.isPrivate(win, browser)) {
      win.gZenUIManager?.showToast?.("whimsy-link-lasso-private-toast");
      this.clearSelected(win, browser);
      this.closeChildLasso(browser);
      return null;
    }
    const { gBrowser } = win;
    const selected = gBrowser.selectedTab;
    const userContextId = browser.getAttribute("usercontextid") || 0;
    const tabs = [];
    for (const link of links.slice(0, MAX_LINKS)) {
      const tab = gBrowser.addTab(link.url, {
        createLazyBrowser: true,
        lazyTabTitle: link.title || link.url,
        noInitialLabel: true,
        inBackground: true,
        skipAnimation: true,
        userContextId: Number(userContextId),
        triggeringPrincipal: browser.contentPrincipal,
      });
      if (tab) {
        tabs.push(tab);
      }
    }
    if (!tabs.length) {
      return null;
    }
    if (selected && !selected.closing) {
      gBrowser.selectedTab = selected;
    }
    win.gZenUIManager?.showToast?.("whimsy-link-lasso-open-toast", {
      l10nArgs: { count: tabs.length },
    });
    this.clearSelected(win, browser);
    this.closeChildLasso(browser);
    return tabs;
  },

  // Makes the folder; returns it (or null when nothing was made).
  createFolder(win, targetBrowser, targetData) {
    const { browser, data } = this._resolveArgs(win, targetBrowser, targetData);
    const links = data?.links;
    const pageTitle = data?.pageTitle ?? "";
    const pageURL = data?.pageURL ?? "";
    if (!this.enabled || !links?.length || !browser || !win?.gBrowser) {
      return null;
    }
    if (this.isPrivate(win, browser)) {
      win.gZenUIManager?.showToast?.("whimsy-link-lasso-private-toast");
      this.clearSelected(win, browser);
      this.closeChildLasso(browser);
      return null;
    }
    const { gBrowser } = win;
    const sourceTab = gBrowser.getTabForBrowser(browser);
    const selected = gBrowser.selectedTab;
    const userContextId = browser.getAttribute("usercontextid") || 0;
    const tabs = [];
    for (const link of links.slice(0, MAX_LINKS)) {
      const tab = gBrowser.addTab(link.url, {
        createLazyBrowser: true,
        lazyTabTitle: link.title || link.url,
        noInitialLabel: true,
        inBackground: true,
        skipAnimation: true,
        userContextId: Number(userContextId),
        triggeringPrincipal: browser.contentPrincipal,
      });
      if (tab) {
        tabs.push(tab);
      }
    }
    if (!tabs.length) {
      return null;
    }
    const name = this.folderName(pageTitle, pageURL);
    let folder = null;
    if (win.gZenFolders) {
      folder = win.gZenFolders.createFolder(tabs, {
        label: name,
        renameFolder: false,
        workspaceId: sourceTab?.getAttribute("zen-workspace-id") || win.gZenWorkspaces?.activeWorkspace,
      });
    }
    if (selected && !selected.closing) {
      gBrowser.selectedTab = selected;
    }
    win.gZenUIManager?.showToast?.("whimsy-link-lasso-toast", {
      l10nArgs: { count: tabs.length, name },
    });
    this.clearSelected(win, browser);
    this.closeChildLasso(browser);
    return folder ?? tabs;
  },

  initWindow(win) {
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyLassoOpenTabs",
      l10nId: "whimsy-command-lasso-open-tabs",
      run: w => this.openTabs(w),
      menu: "whimsy-tabs-menubar",
      isAvailable: w => this.enabled && this.hasSelection(w),
    });
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyLassoMakeFolder",
      l10nId: "whimsy-command-lasso-make-folder",
      run: w => this.createFolder(w),
      menu: "whimsy-tabs-menubar",
      isAvailable: w => this.enabled && this.hasSelection(w),
    });
  },
};
