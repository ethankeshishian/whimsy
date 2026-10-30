/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// batch8: tab lifecycle — fire button (DuckDuckGo).
//
// One tap burns the current tab's session (or everything), with a literal
// flame animation, closing every tab in scope. People trust it as a
// visible, fast "nothing here happened" gesture rather than hunting
// through Clear Recent History's dialog. The actual clearing primitives
// (ForgetAboutSite, Services.clearData) already exist and are well-tested;
// this just wires a popover with four scopes to them and closes the tabs
// the clear affected.
//
// Build-plan answer: pinned tabs and Essentials survive — excluded from the
// tab *close* step, not from the data clear, since someone may still want
// a pinned Gmail tab's cookies burned without losing the tab.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ForgetAboutSite: "moz-src:///toolkit/components/forgetaboutsite/ForgetAboutSite.sys.mjs",
  WhimsyArchive: "resource:///modules/whimsy/WhimsyArchive.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.fire-button";
const PANEL_ID = "whimsyFirePanel";
const FIFTEEN_MIN_MS = 15 * 60 * 1000;

function siteOf(tab) {
  const uri = tab.linkedBrowser?.currentURI;
  if (!uri || !/^https?$/.test(uri.scheme)) {
    return null;
  }
  try {
    return Services.eTLD.getBaseDomain(uri);
  } catch {
    return uri.host || null;
  }
}

function clearDataCallback() {
  return new Promise(resolve => {
    Services.clearData.deleteData(Ci.nsIClearDataService.CLEAR_ALL, {
      onDataDeleted: resolve,
    });
  });
}

export const WhimsyFireButton = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  initWindow(win) {
    const { WhimsyShortcuts } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyShortcuts.sys.mjs");
    WhimsyShortcuts.addActions([
      {
        l10nId: "whimsy-action-fire-button",
        icon: "chrome://browser/skin/forget.svg",
        command: w => this.openPanel(w),
        isAvailable: () => this.enabled,
      },
    ]);
  },

  closableTabs(win, tabs) {
    return tabs.filter(tab => tab && !tab.pinned && !tab.hasAttribute("zen-essential") && !tab.closing);
  },

  burnTabs(win, tabs, reason) {
    const closable = this.closableTabs(win, tabs);
    if (closable.length) {
      lazy.WhimsyArchive.archiveTabs(win, closable, { reason: "fire", groupId: `fire-${reason}-${Date.now()}` });
    }
  },

  async burnSite(win) {
    const tab = win.gBrowser.selectedTab;
    const site = siteOf(tab);
    if (!site) {
      return;
    }
    await lazy.ForgetAboutSite.removeDataFromBaseDomain(site);
    this.burnTabs(win, win.gBrowser.tabs.filter(t => siteOf(t) == site), "site");
  },

  async burnLast15Min(win) {
    const now = Date.now();
    await new Promise(resolve => {
      Services.clearData.deleteDataInTimeRange(
        (now - FIFTEEN_MIN_MS) * 1000,
        now * 1000,
        true,
        Ci.nsIClearDataService.CLEAR_ALL,
        { onDataDeleted: resolve }
      );
    });
    this.burnTabs(win, win.gBrowser.tabs.filter(t => (t.lastAccessed || 0) >= now - FIFTEEN_MIN_MS), "recent");
  },

  async burnSpace(win) {
    const space = win.gZenWorkspaces?.activeWorkspace;
    const tabsInSpace = win.gBrowser.tabs.filter(t => t.getAttribute("zen-workspace-id") == space);
    const userContextIds = new Set(tabsInSpace.map(t => t.userContextId || 0).filter(Boolean));
    await Promise.all(
      [...userContextIds].map(
        userContextId =>
          new Promise(resolve => {
            Services.clearData.deleteDataFromOriginAttributesPattern({ userContextId }, resolve);
          })
      )
    );
    this.burnTabs(win, tabsInSpace, "space");
  },

  async burnEverything(win) {
    await clearDataCallback();
    this.burnTabs(win, win.gBrowser.tabs, "everything");
  },

  panel(win) {
    const { document } = win;
    let panel = document.getElementById(PANEL_ID);
    if (panel) {
      return panel;
    }
    panel = document.createXULElement("panel");
    panel.id = PANEL_ID;
    panel.setAttribute("type", "arrow");
    panel.setAttribute("noautofocus", "true");
    panel.setAttribute("role", "dialog");
    panel.className = "whimsy-fire-panel";
    document.l10n.setAttributes(panel, "whimsy-fire-panel");
    const scopes = [
      ["site", () => this.burnSite(win)],
      ["last-15-min", () => this.burnLast15Min(win)],
      ["space", () => this.burnSpace(win)],
      ["everything", () => this.burnEverything(win)],
    ];
    const list = document.createXULElement("vbox");
    for (const [id, run] of scopes) {
      const button = document.createXULElement("toolbarbutton");
      button.className = "whimsy-fire-scope toolbarbutton-1";
      button.dataset.scope = id;
      document.l10n.setAttributes(button, `whimsy-fire-${id}`);
      button.addEventListener("command", async () => {
        panel.hidePopup();
        const root = win.document.documentElement;
        // A brief flame/burst overlay (whimsy-browser.css); reduced motion
        // swaps it for an instant flash/checkmark there instead.
        root.setAttribute("whimsy-fire-burning", "");
        win.setTimeout(() => root.removeAttribute("whimsy-fire-burning"), 700);
        try {
          await run();
        } catch (e) {
          console.error("Whimsy: fire button", e);
        }
      });
      list.append(button);
    }
    panel.append(list);
    document.getElementById("mainPopupSet")?.appendChild(panel);
    return panel;
  },

  // "This Site" burns the whole site (ForgetAboutSite takes the base domain:
  // every subdomain, its history and data, and its tabs), so the row names
  // it ("Everything from example.com"); it's disabled off the web.
  updateSiteScope(win, panel) {
    const button = panel.querySelector('.whimsy-fire-scope[data-scope="site"]');
    const site = siteOf(win.gBrowser.selectedTab);
    if (site) {
      win.document.l10n.setAttributes(button, "whimsy-fire-site", { site });
    } else {
      win.document.l10n.setAttributes(button, "whimsy-fire-site-none");
    }
    button.disabled = !site;
  },

  openPanel(win) {
    const panel = this.panel(win);
    this.updateSiteScope(win, panel);
    panel.openPopup(win.document.documentElement, { position: "overlap", triggerEvent: null });
  },
};
