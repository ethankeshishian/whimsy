/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave3/cmdbar: Arc's empty command bar (Cmd+T / Cmd+L with nothing typed)
// lists your recently used, still-open tabs, most recent first, so getting
// back to "that tab from a minute ago" is Cmd+T, Down, Enter. Typing
// anything hands the bar back to Firefox/Zen's normal results (which
// already match open tabs). Rows are not preselected: Enter in an untouched
// bar must keep doing what it does (load the URL that's in it).
import { UrlbarProvider } from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import { UrlbarShared } from "chrome://browser/content/urlbar/UrlbarShared.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  ProvidersManager: "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
});

const PREF = "whimsy.feature.command-bar-recent-tabs";
const MAX_TABS = 5;
const DYNAMIC_TYPE = "whimsy-recent-tab";
const SKIP_URLS = new Set(["about:blank", "about:newtab", "about:home", "about:whimsy"]);

// Results cross the parent/view boundary as plain data, so each row carries
// a number and the live tab stays here. Tab identity (not URL) matters: two
// tabs can show the same page.
let nextTarget = 0;
const targets = new Map();

const isPrivateTab = tab =>
  !!tab.linkedBrowser?.browsingContext?.usePrivateBrowsing || tab.hasAttribute("whimsy-private");

export class WhimsyRecentTabsProvider extends UrlbarProvider {
  get name() {
    return "WhimsyRecentTabs";
  }

  get type() {
    return UrlbarShared.PROVIDER_TYPE.PROFILE;
  }

  // Above top sites (1): the empty bar shows recent tabs instead, like Arc.
  getPriority() {
    return 2;
  }

  // Most recently used tabs of the current space (plus visible Essentials),
  // never the selected tab, never across the private/normal boundary.
  tabs(win) {
    const gBrowser = win?.gBrowser;
    if (!gBrowser) {
      return [];
    }
    const selected = gBrowser.selectedTab;
    const selectedPrivate = isPrivateTab(selected);
    const space = win.gZenWorkspaces?.activeWorkspace;
    return Array.from(gBrowser.tabs)
      .filter(tab => {
        if (tab == selected || tab.closing || tab.hasAttribute("zen-empty-tab") || tab.hasAttribute("zen-glance-tab")) {
          return false;
        }
        if (isPrivateTab(tab) != selectedPrivate) {
          return false;
        }
        if (space && !tab.hasAttribute("zen-essential") && tab.getAttribute("zen-workspace-id") != space) {
          return false;
        }
        const url = tab.linkedBrowser?.currentURI?.spec;
        return !!url && !SKIP_URLS.has(url.split(/[?#]/)[0]);
      })
      .sort((a, b) => b.lastAccessed - a.lastAccessed)
      .slice(0, MAX_TABS);
  }

  async isActive(context) {
    return (
      Services.prefs.getBoolPref(PREF, true) &&
      !context.searchString?.trim() &&
      !context.searchMode &&
      !context.restrictSource &&
      this.tabs(lazy.BrowserWindowTracker.getTopWindow()).length > 0
    );
  }

  async startQuery(context, addCallback) {
    const win = lazy.BrowserWindowTracker.getTopWindow();
    targets.clear();
    const tabs = this.tabs(win).slice(0, context.maxResults || MAX_TABS);
    for (const [index, tab] of tabs.entries()) {
      const target = ++nextTarget;
      targets.set(target, new WeakRef(tab));
      addCallback(
        this,
        new lazy.UrlbarResult({
          type: UrlbarShared.RESULT_TYPE.DYNAMIC,
          source: UrlbarShared.RESULT_SOURCE.TABS,
          suggestedIndex: index,
          rowLabel: { id: "whimsy-command-recent-tabs" },
          payload: {
            dynamicType: DYNAMIC_TYPE,
            target,
            title: tab.label || tab.linkedBrowser.currentURI.spec,
            url: tab.linkedBrowser.currentURI.spec,
            icon: tab.getAttribute("image") || "chrome://global/skin/icons/defaultFavicon.svg",
          },
        })
      );
    }
  }

  getViewTemplate() {
    return {
      attributes: { selectable: true },
      children: [
        { name: "icon", tag: "img", classList: ["urlbarView-favicon"] },
        { name: "title", tag: "span", classList: ["urlbarView-title"] },
        { name: "action", tag: "span", classList: ["urlbarView-action"] },
      ],
    };
  }

  getViewUpdate(result) {
    return {
      icon: { attributes: { src: result.payload.icon } },
      title: { textContent: result.payload.title },
      action: { l10n: { id: "whimsy-command-switch-tab" } },
    };
  }

  onEngagement(_context, _controller, details) {
    const tab = targets.get(details.result?.payload.target)?.deref();
    const win = tab?.documentGlobal;
    // The tab may have closed (or moved space) since the bar opened.
    if (!win || !tab.isConnected || tab.closing || !Services.prefs.getBoolPref(PREF, true)) {
      return;
    }
    if (win.gZenWorkspaces && tab.hasAttribute("zen-workspace-id") && !tab.hasAttribute("zen-essential")) {
      const space = tab.getAttribute("zen-workspace-id");
      if (space != win.gZenWorkspaces.activeWorkspace) {
        return;
      }
    }
    win.gBrowser.selectedTab = tab;
    win.gBrowser.selectedBrowser.focus();
  }
}

export const WhimsyRecentTabs = {
  provider: null,

  // Registered once even when the switch is off; isActive checks it on each
  // query, so the Settings checkbox applies live.
  init() {
    if (this.provider) {
      return;
    }
    const manager = lazy.ProvidersManager.getInstanceForSap("urlbar");
    this.provider = manager.getProvider("WhimsyRecentTabs");
    if (!this.provider) {
      this.provider = new WhimsyRecentTabsProvider();
      manager.registerProvider(this.provider);
    }
  },
};
