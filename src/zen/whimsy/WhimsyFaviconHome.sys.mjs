/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyPrivateLock: "resource:///modules/whimsy/WhimsyPrivateLock.sys.mjs",
  WhimsyUndo: "resource:///modules/whimsy/WhimsyUndo.sys.mjs",
});
const PREF = "whimsy.feature.favicon-home";

export const WhimsyFaviconHome = {
  get enabled() {
    return Services.prefs.getBoolPref(PREF, true);
  },

  home(win, tab) {
    if (!this.enabled || tab?.localName != "tab" || tab.pinned || tab.closing ||
        tab.matches("[zen-essential], [zen-empty-tab], [zen-glance-tab]") ||
        lazy.WhimsyPrivateLock.isTabHidden(win, tab)) {
      return null;
    }
    const uri = tab.linkedBrowser?.currentURI;
    if (!uri || !["http", "https"].includes(uri.scheme)) {
      return null;
    }
    const home = uri.prePath + "/";
    return uri.spec == home ? null : home;
  },

  expanded(win) {
    return win.gZenVerticalTabsManager?._prefsSidebarExpanded === true;
  },

  refresh(win, tab) {
    const ready = !!this.home(win, tab) && this.expanded(win);
    tab.toggleAttribute("whimsy-home-ready", ready);
    let button = tab.querySelector(".whimsy-home-button");
    let label = tab.querySelector(".whimsy-home-sublabel");
    if (!ready) {
      button?.remove();
      label?.remove();
      return;
    }
    if (!button) {
      button = win.document.createXULElement("box");
      button.className = "whimsy-home-button";
      button.setAttribute("role", "button");
      button.setAttribute("keyNav", "false");
      button.append(win.document.createXULElement("image"));
      tab.querySelector(".tab-icon-stack").append(button);
      label = win.document.createXULElement("label");
      label.className = "zen-tab-sublabel whimsy-home-sublabel";
      label.setAttribute("role", "presentation");
      tab.querySelector(".tab-label-container").append(label);
      win.document.l10n.setAttributes(button, "whimsy-favicon-home-button");
      this.setLabel(win, tab, false);
    }
  },

  setLabel(win, tab, accel) {
    const label = tab?.querySelector(".whimsy-home-sublabel");
    if (label) {
      win.document.l10n.setAttributes(label, accel ?
        "whimsy-favicon-home-sublabel-new-tab" : "whimsy-favicon-home-sublabel");
    }
  },

  go(win, tab, newTab = false) {
    const home = this.home(win, tab);
    if (!home || !this.expanded(win)) {
      return;
    }
    const browser = tab.linkedBrowser;
    const principal = Services.scriptSecurityManager.getSystemPrincipal();
    win.gBrowser.tabContainer._blockDblClick = true;
    win.gBrowser.selectedTab = tab;
    if (newTab) {
      const opened = win.gBrowser.addTab(home, {
        triggeringPrincipal: principal,
        userContextId: tab.userContextId,
        relatedToCurrent: true,
        index: tab._tPos + 1,
      });
      lazy.WhimsyUndo.push(win, {
        type: "favicon-home",
        undo: () => {
          if (opened.isConnected && !opened.closing) {
            win.gBrowser.removeTab(opened);
          }
        },
      });
    } else {
      browser.stop();
      browser.loadURI(Services.io.newURI(home), { triggeringPrincipal: principal });
      lazy.WhimsyUndo.push(win, {
        type: "favicon-home",
        undo: () => {
          if (tab.isConnected && !tab.closing && browser.currentURI.spec == home && browser.canGoBack) {
            browser.goBack();
          }
        },
      });
    }
  },

  initWindow(win) {
    const container = win.gBrowser.tabContainer;
    let dragging = false;
    let hovered = null;
    let clicked = null;
    const listeners = [];
    const listen = (target, type, handler) => {
      target.addEventListener(type, handler, true);
      listeners.push(() => target.removeEventListener(type, handler, true));
    };
    const refresh = () => {
      for (const tab of win.gBrowser.tabs) {
        this.refresh(win, tab);
      }
    };
    for (const type of ["TabOpen", "TabBrowserInserted", "TabPinned", "TabUnpinned", "TabAttrModified"]) {
      listen(container, type, refresh);
    }
    const observer = new win.MutationObserver(refresh);
    observer.observe(win.document.documentElement, { subtree: true, attributes: true,
      attributeFilter: ["zen-sidebar-expanded", "whimsy-private-locked", "whimsy-space-covered"] });
    // Lock/Essential/Glance state can change without a location change.
    observer.observe(container, { subtree: true, attributes: true,
      attributeFilter: ["zen-essential", "zen-glance-tab", "whimsy-private-locked", "whimsy-space-covered"] });
    const progress = {
      onLocationChange: (browser, webProgress) => {
        if (webProgress?.isTopLevel) {
          const tab = win.gBrowser.getTabForBrowser(browser);
          if (tab) {
            this.refresh(win, tab);
          }
        }
      },
    };
    win.gBrowser.addTabsProgressListener(progress);
    Services.prefs.addObserver(PREF, refresh);
    listen(container, "dragstart", () => {
      dragging = true;
      hovered = null;
      container.setAttribute("whimsy-home-dragging", "true");
    });
    listen(container, "dragend", () => {
      // Keep the drag's trailing click suppressed until the next press.
      container.removeAttribute("whimsy-home-dragging");
    });
    for (const type of ["mousedown", "mouseup", "click", "dblclick"]) {
      listen(container, type, event => {
        const tab = event.target.closest?.("tab");
        if (type == "mousedown" && event.detail <= 1) {
          dragging = false;
          clicked = null;
        }
        if (type == "dblclick" && tab == clicked) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        const target = event.target.closest?.(".whimsy-home-button, .tab-icon-image");
        if (!target || event.button != 0 || !this.expanded(win) ||
            (!this.home(win, tab) && tab != clicked)) {
          return;
        }
        // Ordinary presses/releases must reach the native tab drag and
        // selection bookkeeping. Accel presses must not multi-select tabs.
        if (type == "mouseup" || (type == "mousedown" && !event.getModifierState("Accel"))) {
          return;
        }
        event.stopPropagation();
        if (type == "click") {
          event.preventDefault();
          if (!dragging && event.detail <= 1) {
            clicked = tab;
            this.go(win, tab, event.getModifierState("Accel"));
          }
        }
      });
    }
    listen(container, "mouseover", event => {
      hovered = dragging ? null : event.target.closest?.(".whimsy-home-button")?.closest("tab");
      this.setLabel(win, hovered, event.getModifierState("Accel"));
    });
    for (const type of ["keydown", "keyup"]) {
      listen(win, type, event => this.setLabel(win, hovered, event.getModifierState("Accel")));
    }
    listen(win, "blur", () => this.setLabel(win, hovered, false));
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsySiteHome",
      l10nId: "whimsy-action-site-home",
      icon: "chrome://browser/content/whimsy/icons/site-home.svg",
      run: w => this.go(w, w.gBrowser.selectedTab),
    });
    win.addEventListener("unload", () => {
      for (const remove of listeners) {
        remove();
      }
      observer.disconnect();
      win.gBrowser.removeTabsProgressListener(progress);
      Services.prefs.removeObserver(PREF, refresh);
    }, { once: true });
    refresh();
  },
};
