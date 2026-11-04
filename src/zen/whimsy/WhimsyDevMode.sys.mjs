/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Developer mode tabs (Arc parity): any localhost URL (or one with an
// explicit port, or *.local) switches the tab into Developer Mode
// automatically - a striped outline on the tab, and a bar across the top
// of the window with the full URL plus Console/Network/Elements buttons,
// so devs never hunt for DevTools or lose track of the port and path.
// "Turn On/Off Developer Mode for This Site" (command bar) stores a manual
// override as a permission, for sites that aren't on a dev host at all.
// whimsy.feature.dev-mode.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  DevToolsShim: "chrome://devtools-startup/content/DevToolsShim.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.dev-mode";
const PERM_TYPE = "whimsy-devmode";
const TOOLS = [
  ["inspector", "whimsy-devmode-elements"],
  ["webconsole", "whimsy-devmode-console"],
  ["netmonitor", "whimsy-devmode-network"],
];

function looksLikeDevHost(uri) {
  if (!uri || !/^https?$/.test(uri.scheme)) {
    return false;
  }
  const host = uri.asciiHost;
  if (host == "localhost" || host == "127.0.0.1" || host.endsWith(".local")) {
    return true;
  }
  try {
    return uri.port != -1;
  } catch (e) {
    return false;
  }
}

// wave9/secfix (security-full-2 L4): private browsing's choice is kept on
// the private principal, for the session only (Firefox keeps private
// permissions in memory), so the site never reaches permissions.sqlite.
// Private browsing also sees the normal choice.
function principalsFor(uri, isPrivate) {
  const make = attrs => Services.scriptSecurityManager.createContentPrincipal(uri, attrs);
  return isPrivate ? [make({ privateBrowsingId: 1 }), make({})] : [make({})];
}

function hasManualOverride(uri, isPrivate = false) {
  try {
    return principalsFor(uri, isPrivate).some(principal =>
      Services.perms.testPermissionFromPrincipal(principal, PERM_TYPE) == Services.perms.ALLOW_ACTION);
  } catch (e) {
    return false;
  }
}

function browserIsPrivate(browser) {
  try {
    return !!browser && lazy.PrivateBrowsingUtils.isBrowserPrivate(browser);
  } catch (e) {
    return false;
  }
}

export const WhimsyDevMode = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  isDevMode(uri, isPrivate = false) {
    return !!uri && (looksLikeDevHost(uri) || hasManualOverride(uri, isPrivate));
  },

  isPrivate: browserIsPrivate,

  toggleSite(uri, isPrivate = false) {
    try {
      const principals = principalsFor(uri, isPrivate);
      if (hasManualOverride(uri, isPrivate)) {
        for (const principal of principals) {
          Services.perms.removeFromPrincipal(principal, PERM_TYPE);
        }
      } else if (isPrivate) {
        Services.perms.addFromPrincipal(principals[0], PERM_TYPE, Services.perms.ALLOW_ACTION,
          Services.perms.EXPIRE_SESSION);
      } else {
        Services.perms.addFromPrincipal(principals[0], PERM_TYPE, Services.perms.ALLOW_ACTION);
      }
    } catch (e) {}
  },

  initWindow(win) {
    const { gBrowser, document } = win;
    const update = tab => {
      if (!this.enabled) {
        tab.removeAttribute("whimsy-devmode");
      } else if (this.isDevMode(tab.linkedBrowser?.currentURI, browserIsPrivate(tab.linkedBrowser))) {
        tab.setAttribute("whimsy-devmode", "");
      } else {
        tab.removeAttribute("whimsy-devmode");
      }
      if (tab == gBrowser.selectedTab) {
        this.updateBar(win, tab);
      }
    };
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
      onLocationChange: (browser, progress) => {
        if (progress.isTopLevel) {
          const tab = gBrowser.getTabForBrowser(browser);
          if (tab) {
            update(tab);
          }
        }
      },
    };
    gBrowser.addTabsProgressListener(listener);
    gBrowser.tabContainer.addEventListener("TabSelect", event => update(event.target));
    for (const tab of gBrowser.tabs) {
      update(tab);
    }
  },

  bar(win) {
    let bar = win.document.getElementById("whimsy-devmode-bar");
    if (bar) {
      return bar;
    }
    const container = win.document.getElementById("zen-appcontent-navbar-container");
    if (!container) {
      return null;
    }
    bar = win.document.createElement("div");
    bar.id = "whimsy-devmode-bar";
    bar.hidden = true;
    const url = win.document.createElement("span");
    url.className = "whimsy-devmode-url";
    bar.appendChild(url);
    for (const [toolId, l10nId] of TOOLS) {
      const button = win.document.createXULElement("toolbarbutton");
      button.className = "whimsy-devmode-button";
      win.document.l10n.setAttributes(button, l10nId);
      button.addEventListener("command", () => {
        lazy.DevToolsShim.showToolboxForTab(win.gBrowser.selectedTab, { toolId });
      });
      bar.appendChild(button);
    }
    container.appendChild(bar);
    return bar;
  },

  updateBar(win, tab) {
    const bar = this.bar(win);
    if (!bar) {
      return;
    }
    const inDevMode = tab.hasAttribute("whimsy-devmode");
    bar.hidden = !inDevMode;
    if (inDevMode) {
      bar.querySelector(".whimsy-devmode-url").textContent = tab.linkedBrowser.currentURI.spec;
    }
    this.placeToasts(win, bar);
  },

  // The bar is in the toolbar's layer, which stacks above the page's (where
  // Zen's toasts are), so toasts start below it rather than under it.
  placeToasts(win, bar) {
    const root = win.document.documentElement;
    if (bar.hidden) {
      root.style.removeProperty("--whimsy-devmode-bar-bottom");
      return;
    }
    const bottom = Math.ceil(bar.getBoundingClientRect().bottom);
    if (bottom > 0) {
      root.style.setProperty("--whimsy-devmode-bar-bottom", `${bottom}px`);
    }
  },
};
