/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Link lasso (Linkclump, Snap Links, Multi-Link Paste): researching means
// opening ten results, a docs index or a reading list one Cmd+click at a
// time. Option-drag a rectangle over the links instead (the page shows a
// live count), let go, and they become a folder named after the page, as
// unloaded tabs that load when you open them: Arc and Zen keep groups of
// tabs as folders, so the batch lands where it can be kept, opened one by
// one, or thrown away together. The page side is WhimsyLassoChild.
// Private tabs, private windows and Scratch never make folders (folders
// are kept; private pages aren't).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.link-lasso";
export const MAX_LINKS = 100;

export const WhimsyLinkLasso = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

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

  // Makes the folder; returns it (or null when nothing was made).
  createFolder(win, browser, { links, pageTitle = "", pageURL = "" }) {
    if (!this.enabled || !links?.length) {
      return null;
    }
    if (this.isPrivate(win, browser)) {
      win.gZenUIManager?.showToast?.("whimsy-link-lasso-private-toast");
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
    return folder ?? tabs;
  },
};
