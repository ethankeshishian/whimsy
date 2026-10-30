/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Developer mode tabs (Arc parity): any localhost URL (or one with an
// explicit port, or *.local) switches the tab into Developer Mode
// automatically - a striped outline on the tab, and a bar across the top
// of the window with the full URL plus Console/Network/Elements buttons,
// so devs never hunt for DevTools or lose track of the port and path.
// "Turn on/off Developer Mode for this site" (command bar) stores a manual
// override as a permission, for sites that aren't on a dev host at all.
// whimsy.feature.dev-mode.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  DevToolsShim: "chrome://devtools-startup/content/DevToolsShim.sys.mjs",
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

function hasManualOverride(uri) {
  try {
    const principal = Services.scriptSecurityManager.createContentPrincipal(uri, {});
    return Services.perms.testPermissionFromPrincipal(principal, PERM_TYPE) == Services.perms.ALLOW_ACTION;
  } catch (e) {
    return false;
  }
}

export const WhimsyDevMode = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  isDevMode(uri) {
    return !!uri && (looksLikeDevHost(uri) || hasManualOverride(uri));
  },

  toggleSite(uri) {
    try {
      const principal = Services.scriptSecurityManager.createContentPrincipal(uri, {});
      if (hasManualOverride(uri)) {
        Services.perms.removeFromPrincipal(principal, PERM_TYPE);
      } else {
        Services.perms.addFromPrincipal(principal, PERM_TYPE, Services.perms.ALLOW_ACTION);
      }
    } catch (e) {}
  },

  initWindow(win) {
    const { gBrowser, document } = win;
    const update = tab => {
      if (!this.enabled) {
        tab.removeAttribute("whimsy-devmode");
      } else if (this.isDevMode(tab.linkedBrowser?.currentURI)) {
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
  },
};
