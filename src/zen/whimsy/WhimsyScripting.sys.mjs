/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W30 AppleScript (research/macos-integration.md option B): what a script
// sees and does, behind the dictionary in Whimsy.sdef. Chrome's model,
// application → windows → tabs, plus spaces. applescript/nsWhimsyScripting.mm
// is the Cocoa side; it calls WhimsyScriptingService (nsIWhimsyScripting)
// for every property and command, so nothing is cached and every rule is
// checked on every call.
//
// The same rules as Claude's agents: private windows, private tabs,
// Scratch, hidden spaces, and locked spaces don't exist for a script, so it
// can't list, read, make, or close anything in them. Only http(s) and
// about:blank addresses, loaded without the system's rights. Read-mostly:
// addresses and titles, never page content, and no `execute javascript`.
// whimsy.feature.applescript.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  WhimsyAIContext: "resource:///modules/whimsy/WhimsyAIContext.sys.mjs",
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.applescript";

// Tab ids: a number per tab for this session, like Chrome's.
const tabIds = new WeakMap();
let lastTabId = 0;

function fail(result) {
  throw Components.Exception("", result);
}

function windowId(win) {
  return String(win.docShell.outerWindowID);
}

function tabId(tab) {
  if (!tabIds.has(tab)) {
    tabIds.set(tab, String(++lastTabId));
  }
  return tabIds.get(tab);
}

function principal(tab) {
  return Services.scriptSecurityManager.createNullPrincipal({ userContextId: tab?.userContextId ?? 0 });
}

// A tab that hasn't loaded since a restart still has its address.
function tabUrl(tab) {
  const spec = tab.linkedBrowser?.currentURI?.spec ?? "";
  if (spec && spec != "about:blank") {
    return spec;
  }
  try {
    const state = JSON.parse(lazy.SessionStore.getTabState(tab));
    return state.entries?.[(state.index ?? state.entries.length) - 1]?.url ?? spec;
  } catch {
    return spec;
  }
}

export const WhimsyScripting = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  check() {
    if (!this.enabled) {
      fail(Cr.NS_ERROR_NOT_AVAILABLE);
    }
  },

  // http(s) without a user name or password, or about:blank. Anything else
  // throws NS_ERROR_MALFORMED_URI.
  address(value) {
    if (value == "about:blank") {
      return value;
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      fail(Cr.NS_ERROR_MALFORMED_URI);
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      fail(Cr.NS_ERROR_MALFORMED_URI);
    }
    return url.href;
  },

  // --- What a script can see ---

  windows() {
    return lazy.BrowserWindowTracker.orderedWindows.filter(
      win =>
        !win.closed &&
        win.toolbar.visible &&
        !win._whimsyQuickWindow &&
        !lazy.PrivateBrowsingUtils.isWindowPrivate(win) &&
        win.gBrowserInit?.delayedStartupFinished
    );
  },

  isSpaceVisible(win, space) {
    return (
      !!space &&
      !space.whimsyScratch &&
      !space.whimsyLocked &&
      !lazy.WhimsyPrivate.isScratchId(win, space.uuid) &&
      !lazy.WhimsyAIContext.isHiddenSpace(win, space.uuid)
    );
  },

  spacesOf(win) {
    const spaces = win.gZenWorkspaces;
    if (!spaces?.workspaceEnabled) {
      return [];
    }
    return spaces.getWorkspaces().filter(space => this.isSpaceVisible(win, space));
  },

  isTabVisible(tab) {
    const win = tab?.documentGlobal;
    if (
      !win ||
      tab.closing ||
      !tab.isConnected ||
      tab.hasAttribute("zen-empty-tab") ||
      tab.hasAttribute("zen-glance-tab") ||
      lazy.WhimsyAIContext.isOffLimits(tab)
    ) {
      return false;
    }
    const uuid = tab.getAttribute("zen-workspace-id");
    if (tab.hasAttribute("zen-essential") || !uuid || !win.gZenWorkspaces?.workspaceEnabled) {
      return true;
    }
    return this.isSpaceVisible(win, win.gZenWorkspaces.getWorkspaceFromId(uuid));
  },

  // The window's current tabs (Essentials and the active space, what its
  // sidebar shows), or one space's.
  tabsOf(win, spaceId = "") {
    const spaces = win.gZenWorkspaces;
    let tabs;
    if (!spaces?.workspaceEnabled) {
      tabs = [...win.gBrowser.tabs];
    } else {
      const active = spaceId || spaces.activeWorkspace;
      tabs = spaces.allStoredTabs.filter(tab =>
        spaceId
          ? !tab.hasAttribute("zen-essential") && tab.getAttribute("zen-workspace-id") == active
          : tab.hasAttribute("zen-essential") || tab.getAttribute("zen-workspace-id") == active
      );
    }
    return tabs.filter(tab => this.isTabVisible(tab));
  },

  findWindow(id) {
    return this.windows().find(win => windowId(win) == id) ?? fail(Cr.NS_ERROR_INVALID_ARG);
  },

  findSpace(win, id) {
    return this.spacesOf(win).find(space => space.uuid == id) ?? fail(Cr.NS_ERROR_INVALID_ARG);
  },

  findTab(id) {
    for (const win of this.windows()) {
      const tab = (win.gZenWorkspaces?.workspaceEnabled ? win.gZenWorkspaces.allStoredTabs : win.gBrowser.tabs).find(
        candidate => tabIds.get(candidate) == id
      );
      if (tab && this.isTabVisible(tab)) {
        return tab;
      }
    }
    return fail(Cr.NS_ERROR_INVALID_ARG);
  },

  // --- nsIWhimsyScripting ---

  windowRecord(id) {
    this.check();
    const win = this.findWindow(id);
    const tabs = this.tabsOf(win);
    const selected = win.gBrowser.selectedTab;
    const index = tabs.indexOf(selected);
    const spaces = win.gZenWorkspaces;
    const space = spaces?.workspaceEnabled ? spaces.getWorkspaceFromId(spaces.activeWorkspace) : null;
    return {
      id,
      // The window's title is its selected tab's, which may be one a
      // script can't see.
      name: index == -1 ? "" : selected.label,
      mode: "normal",
      activeTabId: index == -1 ? null : tabId(selected),
      activeTabIndex: index == -1 ? null : index + 1,
      activeSpaceId: this.isSpaceVisible(win, space) ? space.uuid : null,
    };
  },

  tabRecord(id) {
    this.check();
    const tab = this.findTab(id);
    const uuid = tab.hasAttribute("zen-essential") ? null : tab.getAttribute("zen-workspace-id") || null;
    return {
      id,
      windowId: windowId(tab.documentGlobal),
      url: tabUrl(tab),
      title: tab.label,
      loading: tab.hasAttribute("busy"),
      pinned: tab.pinned,
      spaceId: uuid,
    };
  },

  makeTab(winId, spaceId, url) {
    this.check();
    const win = this.findWindow(winId);
    const target = url ? this.address(url) : "about:blank";
    const spaces = win.gZenWorkspaces;
    let space = null;
    if (spaceId) {
      space = this.findSpace(win, spaceId);
    } else if (spaces?.workspaceEnabled) {
      space = spaces.getWorkspaceFromId(spaces.activeWorkspace);
      if (!this.isSpaceVisible(win, space)) {
        // Never into Scratch or a locked space the user is in.
        fail(Cr.NS_ERROR_INVALID_ARG);
      }
    }
    const userContextId = space?.containerTabId || 0;
    const tab = win.gBrowser.addTab(target, {
      triggeringPrincipal: principal({ userContextId }),
      userContextId,
      zenWorkspaceId: space?.uuid,
    });
    if (!space || space.uuid == spaces.activeWorkspace) {
      win.gBrowser.selectedTab = tab;
    }
    return tabId(tab);
  },

  // The checks throw straight away; the window's id comes once it has
  // started.
  makeWindow(url) {
    this.check();
    let args = null;
    if (url) {
      args = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
      args.data = this.address(url);
    }
    return lazy.BrowserWindowTracker.promiseOpenWindow({ private: false, args }).then(windowId);
  },

  closeWindow(id) {
    this.check();
    this.findWindow(id).close();
  },

  closeTab(id) {
    this.check();
    const tab = this.findTab(id);
    tab.documentGlobal.gBrowser.removeTab(tab);
  },

  setURL(id, url) {
    this.check();
    const tab = this.findTab(id);
    const target = this.address(url);
    const { gBrowser } = tab.documentGlobal;
    if (!tab.linkedPanel) {
      gBrowser._insertBrowser(tab);
    }
    tab.linkedBrowser.fixupAndLoadURIString(target, { triggeringPrincipal: principal(tab) });
  },

  reload(id) {
    this.check();
    const tab = this.findTab(id);
    tab.documentGlobal.gBrowser.reloadTab(tab);
  },

  goBack(id) {
    this.check();
    const browser = this.findTab(id).linkedBrowser;
    if (browser?.canGoBack) {
      browser.goBack();
    }
  },

  goForward(id) {
    this.check();
    const browser = this.findTab(id).linkedBrowser;
    if (browser?.canGoForward) {
      browser.goForward();
    }
  },

  // Switches to the tab's space first when needed. The checks throw
  // straight away; the promise settles once the tab is selected.
  selectTab(id) {
    this.check();
    const tab = this.findTab(id);
    const win = tab.documentGlobal;
    const spaces = win.gZenWorkspaces;
    const uuid = tab.getAttribute("zen-workspace-id");
    const away =
      spaces?.workspaceEnabled && !tab.hasAttribute("zen-essential") && uuid && uuid != spaces.activeWorkspace;
    return (away ? spaces.changeWorkspaceWithID(uuid) : Promise.resolve()).then(() => {
      if (!win.closed && this.isTabVisible(tab)) {
        win.gBrowser.selectedTab = tab;
      }
    });
  },

  setActiveTabIndex(winId, index) {
    this.check();
    const tab = this.tabsOf(this.findWindow(winId))[index - 1] ?? fail(Cr.NS_ERROR_INVALID_ARG);
    tab.documentGlobal.gBrowser.selectedTab = tab;
  },

  selectSpace(winId, spaceId) {
    this.check();
    const win = this.findWindow(winId);
    const space = this.findSpace(win, spaceId);
    if (space.uuid == win.gZenWorkspaces.activeWorkspace) {
      return Promise.resolve();
    }
    return win.gZenWorkspaces.changeWorkspaceWithID(space.uuid);
  },
};

// The XPCOM face (components.conf, @whimsy/scripting;1): records as JSON.
export class WhimsyScriptingService {
  QueryInterface = ChromeUtils.generateQI(["nsIWhimsyScripting"]);

  windows() {
    WhimsyScripting.check();
    return JSON.stringify(WhimsyScripting.windows().map(windowId));
  }

  window(id) {
    return JSON.stringify(WhimsyScripting.windowRecord(id));
  }

  tabs(winId, spaceId) {
    WhimsyScripting.check();
    const win = WhimsyScripting.findWindow(winId);
    if (spaceId) {
      WhimsyScripting.findSpace(win, spaceId);
    }
    return JSON.stringify(WhimsyScripting.tabsOf(win, spaceId).map(tabId));
  }

  tab(id) {
    return JSON.stringify(WhimsyScripting.tabRecord(id));
  }

  spaces(winId) {
    WhimsyScripting.check();
    const win = WhimsyScripting.findWindow(winId);
    return JSON.stringify(WhimsyScripting.spacesOf(win).map(space => ({ id: space.uuid, name: space.name })));
  }

  makeTab(winId, spaceId, url) {
    return WhimsyScripting.makeTab(winId, spaceId, url);
  }

  makeWindow(url, callback) {
    WhimsyScripting.makeWindow(url).then(
      id => callback.onWindow(id),
      e => {
        console.error("Whimsy scripting: make new window", e);
        callback.onError(e.result ?? Cr.NS_ERROR_FAILURE);
      }
    );
  }

  closeWindow(id) {
    WhimsyScripting.closeWindow(id);
  }

  closeTab(id) {
    WhimsyScripting.closeTab(id);
  }

  setURL(id, url) {
    WhimsyScripting.setURL(id, url);
  }

  reload(id) {
    WhimsyScripting.reload(id);
  }

  goBack(id) {
    WhimsyScripting.goBack(id);
  }

  goForward(id) {
    WhimsyScripting.goForward(id);
  }

  selectTab(id) {
    WhimsyScripting.selectTab(id).catch(e => console.error("Whimsy scripting: select", e));
  }

  setActiveTabIndex(winId, index) {
    WhimsyScripting.setActiveTabIndex(winId, index);
  }

  selectSpace(winId, spaceId) {
    WhimsyScripting.selectSpace(winId, spaceId).catch(e => console.error("Whimsy scripting: select", e));
  }
}
