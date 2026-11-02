/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave6: Already open (Arc parity). In Arc, typing an address that is already
// open in any space and pressing Return takes you to that tab, switching
// space, instead of opening a second copy.
//
// What Zen already has, and is kept as is: Firefox's "Switch to Tab" results
// list open tabs from every space, and Zen's switchToTabHavingURI moves to
// the tab's space. What it lacks: Return on the address you typed (the
// heuristic "Visit" result) always opens a duplicate. This wraps the address
// bar's pickResult for that one case:
//   - only for an address you go to from a new tab (the command bar after
//     Cmd+T, or an empty tab), never when you edit the current page's address;
//   - only for tabs with the same container and the same privacy (a private
//     tab never matches a normal one, either way), in any space or window;
//   - any modifier (Option-Return = new tab, Shift, Cmd) keeps Firefox's
//     behavior, so a deliberate second copy is one key away.
// When the tab is in another space or window, a quiet toast says where you
// went (Zen's own space switch animation shows the move).
//
// W11-09: the command bar also ranks the match as Arc does. When what you
// type matches an open tab, its "Switch to Tab" row is first, above the
// typed address or search, and Return picks it; the address or search is
// the next row (UrlbarMuxerStandard's #whimsyRankOpenTabs, asked for by
// prepareQuery). A modified Return still goes to what you typed.
//
// W11-08: Cmd+T, then the tab you're on: Arc lists it and opens a second
// copy. Its row reads "Open Again in New Tab" and runs the command of that
// name (cmd_whimsyOpenAgainInNewTab), which any tab can run.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  UrlbarShared: "chrome://browser/content/urlbar/UrlbarShared.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.already-open";
const TAB_SWITCH_RESULT = 1; // UrlbarShared.RESULT_TYPE.TAB_SWITCH
const URL_RESULT = 3; // UrlbarShared.RESULT_TYPE.URL
const TABS_SOURCE = 4; // UrlbarShared.RESULT_SOURCE.TABS
const EMPTY_PAGES = new Set(["about:blank", "about:newtab", "about:home", "about:privatebrowsing"]);
const OPEN_AGAIN_COMMAND = "cmd_whimsyOpenAgainInNewTab";

export const WhimsyAlreadyOpen = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  isTabSwitch(result) {
    if (!result) {
      return false;
    }
    return (
      result.type === TAB_SWITCH_RESULT ||
      result.source === TABS_SOURCE ||
      result.payload?.action?.type === "switchtab" ||
      result.payload?.action?.type === "tabswitch"
    );
  },

  promoteOpenTabs(queryContext) {
    if (!this.enabled || !queryContext?.results?.length) {
      return;
    }
    const results = queryContext.results;
    let targetIndex = results[0]?.heuristic ? 1 : 0;
    // W11-09: a tab ranked above what you typed keeps the typed address or
    // search right below it.
    if (this.isTypedRow(results[targetIndex])) {
      targetIndex++;
    }
    while (targetIndex < results.length && this.isTabSwitch(results[targetIndex])) {
      targetIndex++;
    }
    for (let i = targetIndex + 1; i < results.length; i++) {
      if (this.isTabSwitch(results[i])) {
        const [result] = results.splice(i, 1);
        results.splice(targetIndex, 0, result);
        targetIndex++;
      }
    }
  },

  // W11-09: the open tab ranked first, above what you typed.
  isRankedTab(result) {
    return !!result && result.heuristic && result.whimsyOwnHeuristic === false;
  },

  // W11-09: the typed address or search, moved below a ranked tab.
  isTypedRow(result) {
    return !!result && result.whimsyOwnHeuristic === true;
  },

  // W11-08: the row for the tab you're on, in the Cmd+T command bar.
  isOpenAgainRow(result) {
    return !!result && result.type === TAB_SWITCH_RESULT && !!result.payload?.whimsyOpenAgain;
  },

  // Whether this address bar is the command bar for a new tab: Zen's Cmd+T
  // bar or an empty tab (opensNewTab without a key event).
  inNewTabBar(win) {
    if (win.gURLBar.hasAttribute("zen-newtab")) {
      return true;
    }
    const tab = win.gBrowser.selectedTab;
    return !!tab?.isEmpty || EMPTY_PAGES.has(tab?.linkedBrowser?.currentURI?.spec);
  },

  // Marks a query for the muxer (whimsy-UrlbarMuxerStandard-sys-mjs.patch).
  prepareQuery(win, queryContext) {
    const urlbar = win.gURLBar;
    // W10-36: Zen's Cmd+T command bar opens over the tab you're on (no new
    // tab exists until you pick something), so Firefox took that tab as the
    // "current page" and hid it from Switch to Tab. A pinned tab you were on
    // then had no Switch to Tab row, while the same tab had one from any
    // other space. In the new-tab bar nothing is current yet, so every open
    // tab is offered. Editing the current page's address (Cmd+L) keeps
    // Firefox's rule.
    // W11-08: that tab's row opens it again in a new tab: switching to the
    // tab you're on would do nothing.
    if (urlbar.hasAttribute("zen-newtab") && "currentPage" in queryContext) {
      queryContext.whimsyOpenAgainPage = queryContext.currentPage;
      delete queryContext.currentPage;
    }
    // W11-09: rank an open tab that matches above what you typed, in the
    // command bar for a new tab (where Return on an open address already
    // goes to its tab), for the container and privacy the new tab gets.
    if (this.enabled && !queryContext.searchMode && this.inNewTabBar(win)) {
      queryContext.whimsyOpenTabFirst = {
        userContextId: lazy.UrlbarShared.normalizedUserContextId(this.targetUserContextId(win), !!urlbar.isPrivate),
      };
    }
  },

  // W11-08: the page "Open Again in New Tab" opens for the tab you're on,
  // or null (an empty tab has nothing to open again).
  openAgainUrl(win) {
    const tab = win.gBrowser?.selectedTab;
    if (!tab || tab.isEmpty || tab.hasAttribute("zen-empty-tab") || tab.hasAttribute("zen-glance-tab")) {
      return null;
    }
    const url = this.tabUrl(tab);
    return url && !EMPTY_PAGES.has(url) ? url : null;
  },

  // W11-08: Open Again in New Tab. A second copy of the tab you're on, as a
  // fresh load in a new tab of the same container (and private when the tab
  // is), the way Arc opens the tab you were on when you pick it in Cmd+T.
  // Duplicate Tab copies the tab's history; this doesn't.
  openAgain(win, url = this.openAgainUrl(win)) {
    if (!url) {
      return false;
    }
    lazy.WhimsyPrivate.openTabFor(win, url, {
      userContextId: this.userContextOf(win.gBrowser.selectedTab),
      inBackground: false,
    });
    return true;
  },

  // W11-08: picking the row for the tab you're on runs Open Again in New
  // Tab. The row's menu and its "open in" items keep Firefox's handling.
  maybeOpenAgain(win, { result, element }) {
    if (!this.isOpenAgainRow(result)) {
      return false;
    }
    if (element?.classList?.contains("urlbarView-button-menu")) {
      return false;
    }
    const data = element?.dataset;
    if (data && (data.command || data.openIn || data.usercontextid)) {
      return false;
    }
    const urlbar = win.gURLBar;
    // Close the bar the way Firefox does when a result is picked.
    if (urlbar._zenHandleUrlbarClose) {
      urlbar._zenHandleUrlbarClose(true, true);
    } else {
      urlbar.view?.close({ elementPicked: true });
    }
    this.openAgain(win, result.payload.url);
    return true;
  },

  // W11-09: what to pick instead, or null. A modified Return on the ranked
  // tab means what you typed, as it did before the tab ranked first
  // (Option-Return opens the address or search in a new tab). The typed
  // row, once picked, is the heuristic it was, so Firefox treats it as
  // such (HTTPS-First, input history), and it never switches to a tab:
  // you chose it over the tab.
  typedPick(win, { result, event }) {
    if (this.isTypedRow(result)) {
      return { result };
    }
    if (
      !this.isRankedTab(result) ||
      !event?.type?.startsWith("key") ||
      !(event.altKey || event.shiftKey || event.metaKey || event.ctrlKey)
    ) {
      return null;
    }
    const typed = win.gURLBar.view?.visibleResults?.find(r => this.isTypedRow(r));
    return typed ? { result: typed, element: null } : null;
  },

  // The key two addresses share when they are the same page: no fragment,
  // and http and https count as one (HTTPS-First upgrades typed addresses).
  key(spec) {
    if (!spec) {
      return null;
    }
    let uri;
    try {
      uri = Services.io.newURI(spec);
    } catch {
      return null;
    }
    if (!["http", "https"].includes(uri.scheme)) {
      return null;
    }
    return uri.specIgnoringRef.replace(/^http:/, "https:");
  },

  // The address a tab shows, including tabs that haven't loaded yet
  // (restored or unloaded tabs keep theirs in session store).
  tabUrl(tab) {
    const spec = tab.linkedBrowser?.currentURI?.spec;
    if (spec && spec != "about:blank") {
      return spec;
    }
    try {
      return lazy.SessionStore.getLazyTabValue(tab, "url") || spec;
    } catch {
      return spec;
    }
  },

  userContextOf(tab) {
    return Number(tab?.getAttribute("usercontextid") || 0);
  },

  // Whether Return in this address bar opens a new tab: the command bar Zen
  // opens for Cmd+T, an empty tab, or a pick Firefox sends to a new tab.
  opensNewTab(win, event) {
    const urlbar = win.gURLBar;
    if (urlbar.hasAttribute("zen-newtab")) {
      return true;
    }
    const tab = win.gBrowser.selectedTab;
    if (tab?.isEmpty || EMPTY_PAGES.has(tab?.linkedBrowser?.currentURI?.spec)) {
      return true;
    }
    let where = "current";
    try {
      where = urlbar.controller.whereToOpen(event);
    } catch {}
    return where == "tab" || where == "tabshifted";
  },

  // The container the new tab would get: the space's in Zen's new-tab
  // command bar, else the current (empty) tab's.
  targetUserContextId(win) {
    if (win.gURLBar.hasAttribute("zen-newtab")) {
      const space = win.gZenWorkspaces?.getActiveWorkspaceFromCache?.();
      if (space?.containerTabId) {
        return Number(space.containerTabId);
      }
    }
    return this.userContextOf(win.gBrowser.selectedTab);
  },

  // The open tab showing `url` for this window's address bar, or null. The
  // current window first (its selected tab last), then the others.
  findTab(win, url, { userContextId, isPrivate }) {
    const wanted = this.key(url);
    if (!wanted) {
      return null;
    }
    const windows = [win];
    for (const other of Services.wm.getEnumerator("navigator:browser")) {
      if (other != win && !other.closed && other.gBrowser) {
        windows.push(other);
      }
    }
    for (const w of windows) {
      if (w.document.documentElement.hasAttribute("whimsy-quick-window")) {
        continue;
      }
      const tabs = w.gZenWorkspaces?.allStoredTabs ?? w.gBrowser.tabs;
      const candidates = [...tabs].sort((a, b) => (a.selected ? 1 : 0) - (b.selected ? 1 : 0));
      for (const tab of candidates) {
        if (
          !tab?.linkedBrowser ||
          tab.closing ||
          tab.hasAttribute("zen-glance-tab") ||
          !w.gBrowser.isTab?.(tab) ||
          this.userContextOf(tab) != userContextId ||
          lazy.PrivateBrowsingUtils.isBrowserPrivate(tab.linkedBrowser) != isPrivate
        ) {
          continue;
        }
        if (this.key(this.tabUrl(tab)) == wanted) {
          return { win: w, tab };
        }
      }
    }
    return null;
  },

  spaceName(win, tab) {
    const id = tab.getAttribute("zen-workspace-id");
    return (id && win.gZenWorkspaces?.getWorkspaceFromId?.(id)?.name) || "";
  },

  // Called with pickResult's arguments; true when it switched instead.
  maybeSwitch(win, { result, event, element }) {
    if (!this.enabled || !result || result.type != URL_RESULT || !(result.heuristic || result.autofill)) {
      return false;
    }
    if (this.isTypedRow(result)) {
      return false;
    }
    if (event?.shiftKey || event?.altKey || event?.metaKey || event?.ctrlKey) {
      return false;
    }
    const data = element?.dataset;
    if (data && (data.openIn || data.usercontextid || data.command || data.url || data.action)) {
      return false;
    }
    const url = result.payload?.url;
    if (!url || !this.opensNewTab(win, event)) {
      return false;
    }
    const urlbar = win.gURLBar;
    const found = this.findTab(win, url, {
      userContextId: this.targetUserContextId(win),
      isPrivate: !!urlbar.isPrivate,
    });
    if (!found) {
      return false;
    }
    this.switchTo(win, found);
    return true;
  },

  switchTo(win, { win: targetWin, tab }) {
    const urlbar = win.gURLBar;
    const prevTab = win.gBrowser.selectedTab;
    const prevSpace = win.gZenWorkspaces?.activeWorkspace;
    urlbar.handleRevert();
    urlbar.view?.close();
    if (tab == prevTab) {
      // Cmd+T, then the address of the tab you're on: just close the bar.
      urlbar.blur();
      win.gBrowser.selectedBrowser.focus();
      return;
    }
    const select = () => {
      if (targetWin.gZenWorkspaces?.switchTabIfNeeded) {
        return targetWin.gZenWorkspaces.switchTabIfNeeded(tab);
      }
      targetWin.gBrowser.selectedTab = tab;
      return null;
    };
    if (targetWin != win) {
      targetWin.focus();
    }
    Promise.resolve(select())
      .then(() => {
        // An empty tab you typed into has done its job (Firefox does the same
        // for Switch to Tab).
        if (prevTab.isEmpty && !prevTab.closing && prevTab != tab && !prevTab.splitview && !prevTab.hasAttribute("split-view") && !prevTab.pinned) {
          win.gBrowser.removeTab(prevTab);
        }
        const movedSpace = tab.getAttribute("zen-workspace-id") != prevSpace && !tab.hasAttribute("zen-essential");
        if (targetWin != win || movedSpace) {
          const space = this.spaceName(targetWin, tab);
          targetWin.gZenUIManager?.showToast?.(space ? "whimsy-already-open-toast" : "whimsy-already-open-toast-window", {
            l10nArgs: { space },
            timeout: 3000,
          });
        }
      })
      .catch(e => console.error("Whimsy: already open", e));
  },

  initWindow(win) {
    const urlbar = win.gURLBar;
    if (!urlbar || urlbar._whimsyAlreadyOpen) {
      return;
    }
    urlbar._whimsyAlreadyOpen = true;
    const original = urlbar.pickResult;
    urlbar.pickResult = function (params = {}) {
      let typed = null;
      try {
        if (WhimsyAlreadyOpen.maybeOpenAgain(win, params)) {
          return undefined;
        }
        typed = WhimsyAlreadyOpen.typedPick(win, params);
        if (!typed && WhimsyAlreadyOpen.maybeSwitch(win, params)) {
          return undefined;
        }
      } catch (e) {
        console.error("Whimsy: already open", e);
      }
      if (!typed) {
        return original.call(this, params);
      }
      // The typed row is picked as the heuristic it is, then shown as it
      // was in case the bar stays open (a background tab).
      typed.result.heuristic = true;
      try {
        return original.call(this, { ...params, ...typed });
      } finally {
        if (WhimsyAlreadyOpen.isTypedRow(typed.result)) {
          typed.result.heuristic = false;
        }
      }
    };

    // W10-36, W11-08, W11-09: see prepareQuery.
    const controller = urlbar.controller;
    if (controller && !controller._whimsyNewTabCurrentPage) {
      controller._whimsyNewTabCurrentPage = true;
      const startQuery = controller.startQuery;
      controller.startQuery = function (queryContext) {
        try {
          if (queryContext) {
            WhimsyAlreadyOpen.prepareQuery(win, queryContext);
          }
        } catch (e) {
          console.error("Whimsy: command bar query", e);
        }
        return startQuery.apply(this, arguments);
      };
    }

    lazy.WhimsyCommands.register(win, {
      id: OPEN_AGAIN_COMMAND,
      l10nId: "whimsy-action-open-again-in-new-tab",
      icon: "chrome://browser/skin/zen-icons/duplicate-tab.svg",
      menu: "whimsy-tabs-menubar",
      run: w => WhimsyAlreadyOpen.openAgain(w),
      isAvailable: w => !!WhimsyAlreadyOpen.openAgainUrl(w),
    });

    if (urlbar.view && !urlbar.view._whimsyRankHooked) {
      urlbar.view._whimsyRankHooked = true;
      const origOnQueryResults = urlbar.view.onQueryResults;
      urlbar.view.onQueryResults = function (queryContext) {
        try {
          WhimsyAlreadyOpen.promoteOpenTabs(queryContext);
        } catch (e) {
          console.error("Whimsy: promoteOpenTabs error", e);
        }
        return origOnQueryResults.apply(this, arguments);
      };
    }
  },
};
