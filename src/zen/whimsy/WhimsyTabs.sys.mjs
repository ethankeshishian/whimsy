/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Tab list options that need a little script (the CSS-only ones live in
// whimsy-browser.css).
//
// New tab button fixed at the bottom (whimsy.tabs.newtab-button-bottom):
// Zen puts its "+ New Tab" row at the top of the tab list or right after the
// last tab, so it scrolls away or floats mid-sidebar. With this on, each
// space's button moves into a row at the bottom of that space, above the
// sidebar's foot buttons, where it always stays put. It's the same element
// (Zen's listeners, paste-and-search, shortcut tooltip all keep working); it
// goes back into the list when the option or whimsy.feature.newtab-bottom is
// turned off. Choosing it also turns off Zen's "move it to the top" option
// (and that one turns this off), so new tabs land at the end of the list,
// right above the button.

const FEATURE_PREF = "whimsy.feature.newtab-bottom";
const BOTTOM_PREF = "whimsy.tabs.newtab-button-bottom";
const TOP_PREF = "zen.view.show-newtab-button-top";
const DOCK_CLASS = "whimsy-newtab-dock";

// Loading progress line (whimsy.tabs.loading-line): Zen shows a small
// pulsing pill above the page while it loads (ZenProgressBar,
// zen.view.enable-loading-indicator). Safari draws a thin line that fills as
// the page loads. With this on, whimsy-browser.css restyles Zen's indicator
// into that line, and the listener below feeds it the page's real progress
// as --whimsy-load-progress on the tab's panel (0 to 1, never going back
// during a load). Zen still decides when the indicator shows and hides.
const LINE_FEATURE_PREF = "whimsy.feature.loading-line";
const LINE_PREF = "whimsy.tabs.loading-line";
const PROGRESS_VAR = "--whimsy-load-progress";

// Notification badges and dots (Arc's Favorites and pinned tabs): sites put
// their unread count in the page title ("(3) Slack", "Inbox (12) - Gmail").
// A pinned tab or an Essential shows that count as a small badge on its
// icon. Firefox already marks a background tab whose title changed
// ([titlechanged], cleared when it's selected); Zen hides Firefox's dot, and
// whimsy-browser.css shows an Arc-style dot on pinned tabs and Essentials
// instead, when there's no count to show. whimsy.tabs.badges turns both off.
const BADGES_FEATURE_PREF = "whimsy.feature.tab-badges";
const BADGES_PREF = "whimsy.tabs.badges";
const UNREAD_ATTR = "whimsy-unread";
const UNREAD_PATTERNS = [
  // "(3) Slack", "[12] Discord", "(99+) Feed"
  /^\s*[(\[](\d{1,5})\+?[)\]]/,
  // "Inbox (3) - me@gmail.com", "Unread (5)", "Notifications (2)"
  /\b(?:inbox|unread|notifications?|messages?)\s*\((\d{1,5})\+?\)/i,
];

// Group by domain (Sidebery's and Vivaldi's "group tabs by site", Arc's
// Tidy Tabs by hand): the tab context menu's "Group N Tabs from site.com"
// gathers the space's loose tabs from that site into a new folder named
// after it. whimsy.feature.group-domain hides it.
const GROUP_FEATURE_PREF = "whimsy.feature.group-domain";
const GROUP_MENU_ID = "context_whimsyGroupByDomain";

export function parseUnreadCount(title) {
  for (const pattern of UNREAD_PATTERNS) {
    const match = pattern.exec(title ?? "");
    if (match) {
      const count = parseInt(match[1], 10);
      return count > 0 ? count : 0;
    }
  }
  return 0;
}

export const WhimsyTabs = {
  _prefsWatched: false,

  get newTabAtBottom() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true) && Services.prefs.getBoolPref(BOTTOM_PREF, false);
  },

  initWindow(win) {
    this.watchPrefs();
    const update = () => this.placeNewTabButtons(win);
    const observer = () => update();
    for (const pref of [FEATURE_PREF, BOTTOM_PREF]) {
      Services.prefs.addObserver(pref, observer);
    }
    win.addEventListener(
      "unload",
      () => {
        for (const pref of [FEATURE_PREF, BOTTOM_PREF]) {
          Services.prefs.removeObserver(pref, observer);
        }
      },
      { once: true }
    );
    // Spaces created later (a new space, or after startup) get theirs too.
    const strip = win.document.getElementById("tabbrowser-arrowscrollbox");
    if (strip) {
      new win.MutationObserver(() => {
        if (this.newTabAtBottom) {
          update();
        }
      }).observe(strip, { childList: true });
    }
    win.gZenWorkspaces?.promiseInitialized?.then(update);
    update();
    this.initLoadingLine(win);
    this.initBadges(win);
    this.initGroupByDomain(win);
  },

  // The site a tab belongs to ("github.com" for gist.github.com), or null
  // for pages without one (about:, file:, data:).
  siteOf(tab) {
    const uri = tab.linkedBrowser?.currentURI;
    if (!uri || !/^https?$/.test(uri.scheme)) {
      return null;
    }
    try {
      return Services.eTLD.getBaseDomain(uri);
    } catch {
      return uri.host?.replace(/^www\./, "") || null;
    }
  },

  // The loose tabs in the context tab's space from the same site: not
  // pinned, not Essentials, not already in a folder or a split, not Glance.
  sameSiteTabs(win, tab) {
    const site = this.siteOf(tab);
    if (!site || tab.pinned || tab.hasAttribute("zen-essential")) {
      return { site, tabs: [] };
    }
    const space = tab.getAttribute("zen-workspace-id");
    const tabs = win.gBrowser.tabs.filter(
      t =>
        !t.closing &&
        !t.pinned &&
        !t.group &&
        !t.hasAttribute("zen-essential") &&
        !t.hasAttribute("zen-glance-tab") &&
        !t.hasAttribute("zen-empty-tab") &&
        t.getAttribute("zen-workspace-id") == space &&
        this.siteOf(t) == site
    );
    return { site, tabs };
  },

  initGroupByDomain(win) {
    const { document } = win;
    const menu = document.getElementById("tabContextMenu");
    menu?.addEventListener("popupshowing", event => {
      if (event.target == menu) {
        this.updateGroupMenu(win);
      }
    });
  },

  updateGroupMenu(win) {
    const { document } = win;
    let item = document.getElementById(GROUP_MENU_ID);
    const tab = win.TabContextMenu?.contextTab;
    const enabled = Services.prefs.getBoolPref(GROUP_FEATURE_PREF, true) && win.gZenFolders;
    const { site, tabs } = enabled && tab ? this.sameSiteTabs(win, tab) : { tabs: [] };
    if (tabs.length < 2) {
      if (item) {
        item.hidden = true;
      }
      return;
    }
    if (!item) {
      item = document.createXULElement("menuitem");
      item.id = GROUP_MENU_ID;
      item.addEventListener("command", () => {
        const contextTab = win.TabContextMenu?.contextTab;
        if (contextTab) {
          this.groupByDomain(win, contextTab);
        }
      });
      const anchor = document.getElementById("context_zenMoveToFolder");
      if (anchor) {
        anchor.after(item);
      } else {
        document.getElementById("context_moveTabToGroup")?.before(item) ?? menu.appendChild(item);
      }
    }
    item.hidden = false;
    document.l10n.setAttributes(item, "tab-context-whimsy-group-domain", { count: tabs.length, site });
  },

  // Gather the site's loose tabs into a new folder named after the site, in
  // the order they were in, and keep the tab you were on selected.
  groupByDomain(win, tab) {
    const { site, tabs } = this.sameSiteTabs(win, tab);
    if (tabs.length < 2) {
      return null;
    }
    const selected = win.gBrowser.selectedTab;
    const folder = win.gZenFolders.createFolder(tabs, {
      label: site,
      renameFolder: false,
      workspaceId: tab.getAttribute("zen-workspace-id"),
    });
    if (selected && !selected.closing) {
      win.gBrowser.selectedTab = selected;
    }
    win.gZenUIManager?.showToast?.("whimsy-group-domain-toast", { l10nArgs: { count: tabs.length, site } });
    return folder;
  },

  get badges() {
    return Services.prefs.getBoolPref(BADGES_FEATURE_PREF, true) && Services.prefs.getBoolPref(BADGES_PREF, true);
  },

  initBadges(win) {
    const { gBrowser } = win;
    const updateAll = () => {
      for (const tab of gBrowser.tabs) {
        this.updateBadge(tab);
      }
    };
    const container = gBrowser.tabContainer;
    container.addEventListener("TabAttrModified", event => {
      if (event.detail?.changed?.includes("label")) {
        this.updateBadge(event.target);
      }
    });
    for (const type of ["TabPinned", "TabUnpinned"]) {
      container.addEventListener(type, event => this.updateBadge(event.target));
    }
    const observer = () => updateAll();
    for (const pref of [BADGES_FEATURE_PREF, BADGES_PREF]) {
      Services.prefs.addObserver(pref, observer);
    }
    win.addEventListener(
      "unload",
      () => {
        for (const pref of [BADGES_FEATURE_PREF, BADGES_PREF]) {
          Services.prefs.removeObserver(pref, observer);
        }
      },
      { once: true }
    );
    win.gZenWorkspaces?.promiseInitialized?.then(updateAll);
  },

  // The count goes on the tab (for selectors), and on its icon stack and
  // content row, where the badge draws it with attr(): on the icon's corner
  // for Essentials and a collapsed sidebar, at the end of the row for a
  // pinned tab in the expanded list. Only pinned tabs and Essentials, whose
  // titles are hidden or fixed, get one.
  updateBadge(tab) {
    const stack = tab.querySelector?.(".tab-icon-stack");
    const content = tab.querySelector?.(".tab-content");
    if (!stack || !content) {
      return;
    }
    let count = 0;
    if (this.badges && tab.pinned) {
      count = parseUnreadCount(tab.linkedBrowser?.contentTitle || tab.label);
    }
    if (count) {
      const text = count > 99 ? "99+" : String(count);
      for (const el of [tab, stack, content]) {
        el.setAttribute(UNREAD_ATTR, text);
      }
    } else {
      for (const el of [tab, stack, content]) {
        el.removeAttribute(UNREAD_ATTR);
      }
    }
  },

  get loadingLine() {
    return Services.prefs.getBoolPref(LINE_FEATURE_PREF, true) && Services.prefs.getBoolPref(LINE_PREF, true);
  },

  initLoadingLine(win) {
    const { gBrowser } = win;
    const panelOf = browser => gBrowser.getPanel?.(browser);
    const set = (browser, value) => {
      const panel = panelOf(browser);
      if (!panel) {
        return;
      }
      const old = parseFloat(panel.style.getPropertyValue(PROGRESS_VAR)) || 0;
      // During a load the line only moves forward; a new load starts at 0.
      if (value == 0 || value > old) {
        panel.style.setProperty(PROGRESS_VAR, value.toFixed(3));
      }
    };
    gBrowser.addTabsProgressListener({
      onStateChange: (browser, webProgress, request, flags) => {
        if (!webProgress?.isTopLevel || !this.loadingLine) {
          return;
        }
        const { STATE_START, STATE_STOP, STATE_IS_NETWORK } = Ci.nsIWebProgressListener;
        if (!(flags & STATE_IS_NETWORK)) {
          return;
        }
        if (flags & STATE_START) {
          set(browser, 0);
        } else if (flags & STATE_STOP) {
          set(browser, 1);
        }
      },
      onProgressChange: (browser, webProgress, request, curSelf, maxSelf, curTotal, maxTotal) => {
        if (!this.loadingLine || !(maxTotal > 0)) {
          return;
        }
        // Leave the last stretch for STATE_STOP, like Safari.
        set(browser, Math.min(0.95, curTotal / maxTotal));
      },
    });
  },

  // The two placements exclude each other: top and bottom can't both be on.
  watchPrefs() {
    if (this._prefsWatched) {
      return;
    }
    this._prefsWatched = true;
    Services.prefs.addObserver(BOTTOM_PREF, () => {
      if (Services.prefs.getBoolPref(BOTTOM_PREF, false)) {
        Services.prefs.setBoolPref(TOP_PREF, false);
      }
    });
    Services.prefs.addObserver(TOP_PREF, () => {
      if (Services.prefs.getBoolPref(TOP_PREF, false)) {
        Services.prefs.setBoolPref(BOTTOM_PREF, false);
      }
    });
  },

  placeNewTabButtons(win) {
    const bottom = this.newTabAtBottom;
    for (const space of win.document.querySelectorAll("zen-workspace")) {
      const periphery = space.querySelector("#tabbrowser-arrowscrollbox-periphery");
      if (!periphery) {
        continue;
      }
      let dock = space.querySelector(`:scope > .${DOCK_CLASS}`);
      if (bottom) {
        const button = periphery.querySelector("#tabs-newtab-button");
        if (!button) {
          continue;
        }
        if (!dock) {
          dock = win.document.createXULElement("hbox");
          dock.className = DOCK_CLASS;
          const before = space.querySelector(":scope > .zen-workspace-scroll-to-tab");
          if (before) {
            before.before(dock);
          } else {
            space.append(dock);
          }
        }
        dock.append(button);
      } else if (dock) {
        const button = dock.querySelector("#tabs-newtab-button");
        if (button) {
          const tabstop = periphery.querySelector("toolbartabstop");
          if (tabstop) {
            tabstop.after(button);
          } else {
            periphery.prepend(button);
          }
        }
        dock.remove();
      }
    }
    win.document.documentElement.toggleAttribute("whimsy-newtab-bottom", bottom);
  },
};
