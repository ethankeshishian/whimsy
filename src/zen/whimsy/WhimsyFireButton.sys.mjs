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
  WhimsyPanels: "resource:///modules/whimsy/WhimsyPanels.sys.mjs",
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

  // fixB: a WhimsyPanels sheet, centred like the command bar it opens
  // from. Each scope says exactly what it clears; the last one is red.
  // Built (not yet open) fresh each time; openPanel() shows it.
  panel(win) {
    const { document, gBrowser } = win;
    const spaceName = win.gZenWorkspaces?.getActiveWorkspace?.()?.name || "";
    const { panel, body } = lazy.WhimsyPanels.create(win, {
      id: PANEL_ID,
      titleL10nId: "whimsy-fire-title",
      subtitleL10nId: "whimsy-fire-subtitle",
      size: "medium",
    });
    const scopes = [
      {
        id: "site",
        l10nId: "whimsy-fire-site-none",
        run: () => this.burnSite(win),
        icon: gBrowser.selectedTab.getAttribute("image") || "chrome://global/skin/icons/defaultFavicon.svg",
        favicon: true,
        // updateSiteScope() names the site (or not) once the sheet exists.
        subtitleL10nId: "whimsy-fire-site-none-detail",
      },
      {
        id: "last-15-min",
        run: () => this.burnLast15Min(win),
        icon: "chrome://browser/skin/zen-icons/history.svg",
        subtitleL10nId: "whimsy-fire-last-15-min-detail",
      },
      {
        id: "space",
        run: () => this.burnSpace(win),
        icon: "chrome://browser/skin/zen-icons/window.svg",
        subtitleL10nId: spaceName ? "whimsy-fire-space-detail" : "whimsy-fire-space-detail-unnamed",
        subtitleArgs: spaceName ? { space: spaceName } : null,
      },
      {
        id: "everything",
        run: () => this.burnEverything(win),
        icon: "chrome://browser/skin/zen-icons/forget.svg",
        subtitleL10nId: "whimsy-fire-everything-detail",
        destructive: true,
      },
    ];
    for (const scope of scopes) {
      const item = lazy.WhimsyPanels.item(document, {
        l10nId: scope.l10nId ?? `whimsy-fire-${scope.id}`,
        icon: scope.icon,
        favicon: scope.favicon,
        subtitleL10nId: scope.subtitleL10nId,
        subtitleArgs: scope.subtitleArgs,
        destructive: scope.destructive,
        onCommand: async () => {
          lazy.WhimsyPanels.close(panel);
          const root = win.document.documentElement;
          // A brief flame/burst overlay (whimsy-browser.css); reduced motion
          // swaps it for an instant flash there instead.
          root.setAttribute("whimsy-fire-burning", "");
          win.setTimeout(() => root.removeAttribute("whimsy-fire-burning"), 700);
          try {
            await scope.run();
          } catch (e) {
            console.error("Whimsy: fire button", e);
          }
        },
      });
      item.classList.add("whimsy-fire-scope");
      item.setAttribute("whimsy-fire-scope", scope.id);
      item.dataset.scope = scope.id;
      body.append(item);
    }
    return panel;
  },

  // "This Site" burns the whole site (ForgetAboutSite takes the base domain:
  // every subdomain, its history and data, and its tabs), so the row names
  // it ("Everything from example.com"); it's disabled off the web.
  updateSiteScope(win, panel) {
    const { document } = win;
    const button = panel.querySelector('.whimsy-fire-scope[data-scope="site"]');
    const title = button.querySelector(".whimsy-sheet-item-title");
    const subtitle = button.querySelector(".whimsy-sheet-item-subtitle");
    const site = siteOf(win.gBrowser.selectedTab);
    if (site) {
      document.l10n.setAttributes(title, "whimsy-fire-site", { site });
      document.l10n.setAttributes(subtitle, "whimsy-fire-site-detail", { site });
    } else {
      document.l10n.setAttributes(title, "whimsy-fire-site-none");
      document.l10n.setAttributes(subtitle, "whimsy-fire-site-none-detail");
    }
    button.disabled = !site;
  },

  openPanel(win) {
    const panel = this.panel(win);
    this.updateSiteScope(win, panel);
    lazy.WhimsyPanels.open(win, panel);
  },
};
