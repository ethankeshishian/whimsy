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
// as --whimsy-load-progress on the tab's panel: the further of real progress
// and a slow creep, never going back while the indicator is up. Zen still
// decides when the indicator shows and hides.
const LINE_FEATURE_PREF = "whimsy.feature.loading-line";
const LINE_PREF = "whimsy.tabs.loading-line";
const PROGRESS_VAR = "--whimsy-load-progress";
const CREEP_MS = 12000;
const CREEP_TICK_MS = 100;
const BAR_ID = "zen-loading-progress-bar";

// cubic-bezier(0.1, 0.7, 0.3, 1), the creep's easing, solved for x by bisection.
function creepEase(x) {
  const [x1, y1, x2, y2] = [0.1, 0.7, 0.3, 1];
  const at = (t, a, b) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid, x1, x2) < x) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return at((lo + hi) / 2, y1, y2);
}

export function loadCreep(elapsedMs, reducedMotion = false) {
  if (reducedMotion) {
    return 0.15;
  }
  return 0.06 + 0.64 * creepEase(Math.min(1, Math.max(0, elapsedMs / CREEP_MS)));
}

// Notification badges and dots (Arc's Favorites and pinned tabs): sites put
// their unread count in the page title ("(3) Slack", "Inbox (12) - Gmail").
// A pinned tab or an Essential shows that count as a small badge on its
// icon. Firefox already marks a background tab whose title changed
// ([titlechanged], cleared when it's selected); Zen hides Firefox's dot, and
// whimsy-browser.css shows an Arc-style dot on pinned tabs and Essentials
// instead, when there's no count to show. whimsy.tabs.badges turns both off.
//
// W10-11: the badges stay live for Essentials you haven't opened, like Arc's
// Favorites, which keep running in the background so their counts update.
// Three things froze them:
//  - Essentials are pinned, and session restore leaves pinned tabs unloaded
//    until selected (browser.sessionstore.restore_pinned_tabs_on_demand), so
//    an Essential you hadn't opened since launch showed last session's count
//    forever. They now load in the background, one at a time, once the
//    session is restored (and when a pending tab becomes an Essential).
//    Tabs you unload yourself, or Firefox unloads for memory, stay unloaded.
//  - With Zen's window sync on, a restored tab only takes title updates once
//    it's been shown (Tabbrowser's #setTabLabel skips tabs without
//    _zenContentsVisible), and a renamed Essential's label never changes. So
//    the count is read from the page's own title (pagetitlechanged) instead
//    of waiting for the label.
//  - In a second window, a synced copy of the tab has no page of its own; it
//    reads the count from the copy that holds the page.
const BADGES_FEATURE_PREF = "whimsy.feature.tab-badges";
const BADGES_PREF = "whimsy.tabs.badges";
const UNREAD_ATTR = "whimsy-unread";
// W10-62 (Arc parity): each Essential's "Show Unread Badge" (its context
// menu, and a command for the current Essential). Off hides that
// Essential's count and its update dot. Saved with the tab
// (SessionStore), on every window's copy of it.
const HIDE_BADGE_ATTR = "whimsy-hide-badge";
const HIDE_BADGE_KEY = "whimsy-hide-unread-badge";
const BADGE_MENU_ID = "context_whimsyUnreadBadge";
const SETTLE_DELAY_MS = 5000;
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
    this.initMailHover(win);
    this.initGroupByDomain(win);
    this.initPinnedMarks(win);
  },

  // Mail summaries use the title only; a missing count means zero, not
  // message data fetched from the signed-in account. Other sites get no row.
  mailUnreadCount(tab) {
    const browser = this.contentOwner(tab)?.linkedBrowser;
    try {
      const url = new URL(browser?.currentURI?.spec);
      const mail = url.protocol == "https:" && (
        ["mail.google.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com",
          "mail.yahoo.com", "mail.proton.me", "mail.protonmail.com", "mail.aol.com"].includes(url.hostname) ||
        (["www.icloud.com", "icloud.com"].includes(url.hostname) && /^\/mail(?:\/|$)/.test(url.pathname))
      );
      // Outlook's calendar shares its host with mail.
      if (!mail || /^\/calendar(?:\/|$)/.test(url.pathname)) {
        return null;
      }
      return parseUnreadCount(browser.contentTitle || tab.label);
    } catch {
      return null;
    }
  },

  updateMailHover(win, tab) {
    const panel = win.document.getElementById("tab-preview-panel");
    if (!panel) {
      return;
    }
    let row = panel.querySelector("#whimsy-mail-unread-preview");
    const count = tab ? this.mailUnreadCount(tab) : null;
    if (count == null) {
      row?.remove();
      return;
    }
    if (!row) {
      row = win.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
      row.id = "whimsy-mail-unread-preview";
      // Keep the summary beside the native preview's title and address.
      (panel.querySelector(".tab-preview-title")?.parentElement || panel).append(row);
    }
    win.document.l10n.setAttributes(row, "whimsy-mail-unread-preview", { count });
  },

  initMailHover(win) {
    let hovered = null;
    const onHover = event => {
      hovered = event.target.closest?.("tab");
      this.updateMailHover(win, hovered);
    };
    const onPopup = event => {
      if (event.target.id == "tab-preview-panel") {
        this.updateMailHover(win, hovered);
      }
    };
    const onTitle = event => {
      if (event.target == hovered) {
        this.updateMailHover(win, hovered);
      }
    };
    win.addEventListener("TabHoverStart", onHover);
    win.addEventListener("popupshowing", onPopup);
    win.gBrowser.tabContainer.addEventListener("TabAttrModified", onTitle);
    win.addEventListener("unload", () => {
      win.removeEventListener("TabHoverStart", onHover);
      win.removeEventListener("popupshowing", onPopup);
      win.gBrowser.tabContainer.removeEventListener("TabAttrModified", onTitle);
    }, { once: true });
  },

  // fix7/tabs: stray blue lines on pinned tabs. Two things drew them:
  // - Firefox's container line. Zen hides it when the container is the
  //   space's own (zenDefaultUserContextId), but tabs that reached a space
  //   another way (moved in, restored from an older session, opened by a
  //   path that doesn't mark them) kept a full-height line down the tile's
  //   edge. A tab whose container is its space's gets the mark here; a tab
  //   in a different container keeps its line, drawn as a short pill (CSS).
  //   wave13/edge-line: every tab, not only pinned ones. An ordinary tab
  //   showed the same line, 3px down the trailing edge of its sidebar row
  //   in the profile's colour: Mini opens its link in the space's profile
  //   and Cmd+O adopts it with that container passed explicitly, so Zen
  //   never marks it ("a blue line on the right side of the tab"), and a
  //   call page opened in a profile showed it in purple. An adopted tab
  //   gets its space after TabOpen (adoptTabIntoSpace), so TabOpen checks
  //   again once that has run.
  // - Firefox's multi-tab drag "stack" (small-stack/big-stack, two box-
  //   shadow lines in the focus blue). Zen draws its own drag image and
  //   finishes some drops (Essentials, another space, a folder) without
  //   Firefox's reset, so the lines stayed under the dropped tabs.
  initPinnedMarks(win) {
    const { gBrowser } = win;
    const container = gBrowser.tabContainer;
    const mark = tab => this.markDefaultContainer(win, tab);
    for (const type of ["TabOpen", "TabPinned", "TabSelect"]) {
      container.addEventListener(type, event => mark(event.target));
    }
    container.addEventListener("TabOpen", event => win.setTimeout(() => mark(event.target), 0));
    win.addEventListener("ZenWorkspaceDataChanged", () => this.markAllDefaultContainers(win));
    win.gZenWorkspaces?.promiseInitialized?.then(() => this.markAllDefaultContainers(win));
    const clearStacks = () => {
      win.setTimeout(() => {
        if (!container.hasAttribute("movingtab")) {
          this.clearDragStacks(win);
        }
      }, 0);
    };
    win.addEventListener("dragend", clearStacks, true);
    win.addEventListener("drop", clearStacks, true);
  },

  markAllDefaultContainers(win) {
    for (const tab of win.gBrowser.tabs) {
      this.markDefaultContainer(win, tab);
    }
  },

  markDefaultContainer(win, tab) {
    if (tab?.localName != "tab" || tab.closing || tab.getAttribute("zenDefaultUserContextId") == "true") {
      return;
    }
    const userContextId = tab.userContextId || parseInt(tab.getAttribute("usercontextid")) || 0;
    if (!userContextId) {
      return;
    }
    const uuid = tab.getAttribute("zen-workspace-id");
    const space = uuid && win.gZenWorkspaces?.getWorkspaceFromId?.(uuid);
    if (space?.containerTabId == userContextId) {
      tab.setAttribute("zenDefaultUserContextId", "true");
    }
  },

  clearDragStacks(win) {
    for (const el of win.document.querySelectorAll("[small-stack], [big-stack]")) {
      el.removeAttribute("small-stack");
      el.removeAttribute("big-stack");
    }
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
    // wave5: the tab menu's "Group N Tabs from site" as a command for the
    // current tab.
    ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs").WhimsyCommands.register(win, {
      id: "cmd_whimsyGroupBySite",
      l10nId: "whimsy-action-group-by-site",
      run: w => this.groupByDomain(w, w.gBrowser.selectedTab),
      icon: "chrome://browser/skin/zen-icons/folder.svg",
      isAvailable: w =>
        Services.prefs.getBoolPref(GROUP_FEATURE_PREF, true) &&
        !!w.gZenFolders &&
        this.sameSiteTabs(w, w.gBrowser.selectedTab).tabs.length >= 2,
    });
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

  clock: { now: () => Date.now() },
  now() {
    return this.clock.now();
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
    const progressListener = {
      onStateChange: (browser, webProgress, request, flags) => {
        if (!webProgress?.isTopLevel) {
          return;
        }
        const { STATE_START, STATE_STOP, STATE_IS_NETWORK } = Ci.nsIWebProgressListener;
        const tab = gBrowser.getTabForBrowser(browser);
        if (!tab) {
          return;
        }
        if (flags & STATE_START && flags & STATE_IS_NETWORK) {
          tab._whimsyLoadFinishedAt = 0;
          tab._whimsyInitialTitleSettled = false;
          for (const copy of [tab, ...this.copiesOf(tab)]) {
            copy.removeAttribute("titlechanged");
          }
        } else if (flags & STATE_STOP && flags & STATE_IS_NETWORK) {
          tab._whimsyLoadFinishedAt = this.now();
          const title = browser.contentTitle || "";
          if (title) {
            tab._whimsyContentTitle = title;
            tab._whimsyInitialTitleSettled = true;
          }
        }
      },
      onLocationChange: (browser, webProgress, request, location, flags) => {
        if (!webProgress?.isTopLevel) {
          return;
        }
        const tab = gBrowser.getTabForBrowser(browser);
        if (!tab) {
          return;
        }
        const isSameDocument = !!(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT);
        if (!isSameDocument) {
          tab._whimsyLoadFinishedAt = 0;
          tab._whimsyInitialTitleSettled = false;
          for (const copy of [tab, ...this.copiesOf(tab)]) {
            copy.removeAttribute("titlechanged");
          }
        }
      },
    };
    gBrowser.addTabsProgressListener(progressListener);
    win.addEventListener(
      "unload",
      () => {
        gBrowser.removeTabsProgressListener(progressListener);
        for (const pref of [BADGES_FEATURE_PREF, BADGES_PREF]) {
          Services.prefs.removeObserver(pref, observer);
        }
      },
      { once: true }
    );
    // The page's own title, whether or not the tab's label follows it.
    gBrowser.addEventListener("pagetitlechanged", event => {
      const tab = gBrowser.getTabForBrowser(event.target);
      if (tab && !tab.hasAttribute("pending")) {
        this.onContentTitle(tab);
      }
    });
    container.addEventListener("TabSelect", event => {
      const tab = event.target;
      for (const copy of [tab, ...this.copiesOf(tab)]) {
        copy.removeAttribute("titlechanged");
      }
    });
    // Unloaded on purpose (the Unload command, ⌘W on an Essential, or
    // Firefox freeing memory): it stays unloaded until it's opened. Essentials
    // sit outside the tab strip, so these two are heard on the window.
    win.addEventListener("TabBrowserDiscarded", event => {
      event.target._whimsyUnloaded = true;
      event.target._whimsyLoadFinishedAt = 0;
      event.target._whimsyInitialTitleSettled = false;
      event.target.removeAttribute("titlechanged");
    });
    win.addEventListener("TabAddedToEssentials", event => {
      const tab = event.target;
      delete tab._whimsyUnloaded;
      // A tab moved into the Essentials is rebuilt a moment later, and its
      // page can finish loading without session restore ever saying so,
      // leaving "pending" on a live tab. Wake it, then clear that leftover.
      (async () => {
        const woken = this.wantsWaking(tab);
        if (woken) {
          await this.wakeEssentials(win, [tab]);
        }
        for (let i = 0; woken && i < 40 && !win.closed && !tab.closing && tab.hasAttribute("pending"); i++) {
          await new Promise(resolve => win.setTimeout(resolve, 250));
          const spec = tab.linkedBrowser?.currentURI?.spec;
          if (i >= 4 && !tab.hasAttribute("busy") && /^https?:/.test(spec || "") &&
            tab.linkedBrowser.browsingContext?.currentWindowGlobal?.documentURI?.spec == spec) {
            tab.removeAttribute("pending");
          }
        }
      })();
    });
    for (const tab of gBrowser.tabs) {
      if (!tab.hasAttribute("busy") && !tab.hasAttribute("pending")) {
        tab._whimsyLoadFinishedAt = this.now();
        const title = tab.linkedBrowser?.contentTitle || "";
        if (title) {
          tab._whimsyContentTitle = title;
          tab._whimsyInitialTitleSettled = true;
        }
      }
    }
    win.gZenWorkspaces?.promiseInitialized?.then(updateAll);
    this.initBadgeToggle(win);
    const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
    Promise.all([win.gZenWorkspaces?.promiseInitialized, SessionStore.promiseAllWindowsRestored])
      .then(() => new Promise(resolve => ChromeUtils.idleDispatch(resolve, { timeout: 5000 })))
      .then(() => !win.closed && this.keepEssentialsLive(win))
      .catch(console.error);
  },

  // --- W10-62: per-Essential "Show Unread Badge" ---

  // Only an Essential's own setting counts (a tab taken out of Essentials
  // and pinned shows its badge again).
  badgeShown(tab) {
    return !(tab?.hasAttribute(HIDE_BADGE_ATTR) && tab.hasAttribute("zen-essential"));
  },

  // Whether this Essential's badge can be turned on or off here.
  canToggleBadge(tab) {
    return this.badges && !!tab?.hasAttribute?.("zen-essential");
  },

  initBadgeToggle(win) {
    const { document } = win;
    const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
    // Restored tabs (Essentials sit outside the tab strip: heard on the
    // window), and tabs already restored before this window's modules ran.
    const restore = tab => {
      let hidden = false;
      try {
        hidden = SessionStore.getCustomTabValue(tab, HIDE_BADGE_KEY) == "true";
      } catch (e) {}
      if (hidden != tab.hasAttribute(HIDE_BADGE_ATTR)) {
        tab.toggleAttribute(HIDE_BADGE_ATTR, hidden);
        this.updateBadge(tab);
      }
    };
    win.addEventListener("SSTabRestoring", event => restore(event.target));
    win.gZenWorkspaces?.promiseInitialized?.then(() => {
      for (const tab of win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs) {
        restore(tab);
      }
    });
    const commands = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs").WhimsyCommands;
    commands.register(win, {
      id: "cmd_whimsyToggleUnreadBadge",
      l10nId: "whimsy-action-toggle-unread-badge",
      run: w => this.canToggleBadge(w.gBrowser.selectedTab) && this.toggleBadge(w.gBrowser.selectedTab),
      icon: "chrome://browser/skin/zen-icons/essential-add.svg",
      variants: [
        {
          l10nId: "whimsy-action-show-unread-badge",
          isAvailable: w => this.canToggleBadge(w.gBrowser.selectedTab) && !this.badgeShown(w.gBrowser.selectedTab),
        },
        {
          l10nId: "whimsy-action-hide-unread-badge",
          isAvailable: w => this.canToggleBadge(w.gBrowser.selectedTab) && this.badgeShown(w.gBrowser.selectedTab),
        },
      ],
    });
    const menu = document.getElementById("tabContextMenu");
    menu?.addEventListener("popupshowing", event => {
      if (event.target == menu) {
        this.updateBadgeMenu(win);
      }
    });
  },

  updateBadgeMenu(win) {
    const { document } = win;
    const tab = win.TabContextMenu?.contextTab;
    let item = document.getElementById(BADGE_MENU_ID);
    const show = this.canToggleBadge(tab) && !tab.multiselected;
    if (!show) {
      if (item) {
        item.hidden = true;
      }
      return;
    }
    if (!item) {
      item = document.createXULElement("menuitem");
      item.id = BADGE_MENU_ID;
      item.setAttribute("type", "checkbox");
      document.l10n.setAttributes(item, "tab-context-whimsy-unread-badge");
      item.addEventListener("command", () => {
        const contextTab = win.TabContextMenu?.contextTab;
        if (this.canToggleBadge(contextTab)) {
          this.toggleBadge(contextTab);
        }
      });
      const anchor = document.getElementById("context_zen-remove-essential");
      if (anchor) {
        anchor.after(item);
      } else {
        document.getElementById("tabContextMenu").appendChild(item);
      }
    }
    item.hidden = false;
    // A native menu reads its state now, not after an await.
    if (this.badgeShown(tab)) {
      item.setAttribute("checked", "true");
    } else {
      item.removeAttribute("checked");
    }
  },

  // Shows or hides one Essential's badge (every window's copy). Returns
  // whether it's shown now.
  toggleBadge(tab, show = !this.badgeShown(tab)) {
    const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
    for (const copy of [tab, ...this.copiesOf(tab)]) {
      copy.toggleAttribute(HIDE_BADGE_ATTR, !show);
      try {
        if (show) {
          SessionStore.deleteCustomTabValue(copy, HIDE_BADGE_KEY);
        } else {
          SessionStore.setCustomTabValue(copy, HIDE_BADGE_KEY, "true");
        }
      } catch (e) {
        // A tab the session store doesn't know yet.
      }
      this.updateBadge(copy);
    }
    return show;
  },

  // The copy of a tab that holds its page. With Zen's window sync every
  // window has a copy of each synced tab, but only one of them (marked
  // _zenContentsVisible) has the live page; the others show its label.
  contentOwner(tab) {
    if (tab._zenContentsVisible || !tab.id) {
      return tab;
    }
    for (const other of this.copiesOf(tab)) {
      if (other._zenContentsVisible) {
        return other;
      }
    }
    return tab;
  },

  copiesOf(tab) {
    const copies = [];
    if (!tab.id) {
      return copies;
    }
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (win == tab.ownerDocument.defaultView || win.closed) {
        continue;
      }
      const other = win.document.getElementById(tab.id);
      if (other && other != tab && other.localName == tab.localName) {
        copies.push(other);
      }
    }
    return copies;
  },

  onContentTitle(tab) {
    const title = tab.linkedBrowser?.contentTitle || "";
    const changed = tab._whimsyContentTitle !== undefined && tab._whimsyContentTitle != title;
    const isFirstTitle = !tab._whimsyInitialTitleSettled;
    tab._whimsyContentTitle = title;
    if (title && isFirstTitle) {
      tab._whimsyInitialTitleSettled = true;
    }

    const now = this.now();
    const isBusy = tab.hasAttribute("busy");
    // W11-11: Set [titlechanged] on a background pinned tab or Essential
    // only for a title change AFTER the page's first load has settled (>5s),
    // ignoring the first title after any load/restore and navigation.
    const loadSettled = !isBusy &&
      tab._whimsyLoadFinishedAt > 0 &&
      (now - tab._whimsyLoadFinishedAt >= SETTLE_DELAY_MS) &&
      !isFirstTitle;

    for (const copy of [tab, ...this.copiesOf(tab)]) {
      this.updateBadge(copy);
      const isPinnedOrEssential = copy.pinned || copy.hasAttribute("zen-essential");
      const hasUnread = copy.hasAttribute(UNREAD_ATTR);
      const isBackground = !tab.selected && !copy.selected;

      // Never show the dot when an unread count badge is showing.
      if (changed && this.badges && isPinnedOrEssential && isBackground && loadSettled && !hasUnread && title) {
        copy.setAttribute("titlechanged", "true");
      } else if (!isPinnedOrEssential || !isBackground || hasUnread || isBusy || !loadSettled) {
        copy.removeAttribute("titlechanged");
      }
    }
  },

  // A pending Essential whose page should be running: never opened since
  // launch (not unloaded on purpose), an http(s) page, in a normal window, and no other window's copy
  // holds (or has unloaded) its page.
  wantsWaking(tab) {
    if (!this.badges || !tab?.hasAttribute("zen-essential") || !tab.hasAttribute("pending") || tab._whimsyUnloaded || tab.closing || tab.selected) {
      return false;
    }
    const win = tab.ownerDocument.defaultView;
    if (win.gZenWorkspaces?.privateWindowOrDisabled || win.document.documentElement.hasAttribute("privatebrowsingmode")) {
      return false;
    }
    if (!/^https?:/.test(tab.linkedBrowser?.currentURI?.spec || "")) {
      return false;
    }
    return !this.copiesOf(tab).some(copy => copy._zenContentsVisible || !copy.hasAttribute("pending"));
  },

  keepEssentialsLive(win) {
    const tabs = (win.gZenWorkspaces?.allStoredTabs || win.gBrowser.tabs).filter(tab => this.wantsWaking(tab));
    return this.wakeEssentials(win, tabs);
  },

  // One at a time, a moment apart, so launch isn't a burst of page loads.
  async wakeEssentials(win, tabs, { gap = 300 } = {}) {
    const woken = [];
    for (const tab of tabs) {
      if (win.closed) {
        break;
      }
      if (!this.wantsWaking(tab)) {
        continue;
      }
      tab._whimsyLoadFinishedAt = 0;
      tab._whimsyInitialTitleSettled = false;
      tab.removeAttribute("titlechanged");
      // This copy now holds the page, so Zen's window sync moves it (rather
      // than loading a second one) when another window shows the tab, and
      // the tab takes its title updates.
      tab._zenContentsVisible = true;
      // A pending tab's reload restores its saved page (SessionStore's
      // onHistoryReload), as Firefox's Reload on an unloaded tab does.
      tab.linkedBrowser.reload();
      woken.push(tab);
      if (gap) {
        await new Promise(resolve => win.setTimeout(resolve, gap));
      }
    }
    return woken;
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
    if (this.badges && tab.pinned && this.badgeShown(tab)) {
      const browser = this.contentOwner(tab).linkedBrowser;
      const title = browser?.contentTitle || tab.label || "";
      count = parseUnreadCount(title);
      // batch8: W8-06: Gmail badge persistence while viewing an email thread
      const url = browser?.currentURI?.spec || "";
      const isGmail = /mail\.google\.com/.test(url) || /@gmail\.com| - Gmail$/.test(title);
      if (isGmail) {
        if (count > 0) {
          tab._whimsyLastUnreadCount = count;
        } else if (/\binbox\b/i.test(title)) {
          tab._whimsyLastUnreadCount = 0;
        } else if (tab._whimsyLastUnreadCount) {
          count = tab._whimsyLastUnreadCount;
        }
      } else {
        tab._whimsyLastUnreadCount = 0;
      }
    }
    if (count) {
      const text = count > 99 ? "99+" : String(count);
      for (const el of [tab, stack, content]) {
        el.setAttribute(UNREAD_ATTR, text);
      }
      for (const copy of [tab, ...this.copiesOf(tab)]) {
        copy.removeAttribute("titlechanged");
      }
      // The badge is drawn with CSS, so screen readers need the count too
      // ("Inbox, 128 unread"): the tab's own name stays, this describes it.
      tab.ownerDocument.l10n?.formatValue("whimsy-tab-unread-description", { count })
        .then(value => {
          if (tab.getAttribute(UNREAD_ATTR) == text) {
            tab.setAttribute("aria-description", value);
          }
        }).catch(() => {});
    } else {
      for (const el of [tab, stack, content]) {
        el.removeAttribute(UNREAD_ATTR);
      }
      tab.removeAttribute("aria-description");
    }
  },

  get loadingLine() {
    return Services.prefs.getBoolPref(LINE_FEATURE_PREF, true) && Services.prefs.getBoolPref(LINE_PREF, true);
  },

  initLoadingLine(win) {
    const { gBrowser } = win;
    const panelOf = browser => gBrowser.getPanel?.(browser);
    const states = new Map(); // panel -> { real, startedAt, sawBar }
    const barOf = panel => panel.querySelector(`:scope > #${BAR_ID}`);
    let timer = null;
    const paint = (panel, state) => {
      const reduced = win.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const creep = barOf(panel) ? loadCreep(Date.now() - state.startedAt, reduced) : 0;
      const value = Math.max(state.real, creep).toFixed(3);
      if (panel.style.getPropertyValue(PROGRESS_VAR) != value) {
        panel.style.setProperty(PROGRESS_VAR, value);
      }
    };
    const tick = () => {
      for (const [panel, state] of states) {
        if (!panel.isConnected) {
          states.delete(panel);
        } else if (barOf(panel)) {
          state.sawBar = true;
          paint(panel, state);
        } else if (state.sawBar || Date.now() - state.startedAt > 60000) {
          // Zen removed the bar: the next load starts over.
          states.delete(panel);
          panel.style.setProperty(PROGRESS_VAR, "0");
        }
      }
      if (!states.size && timer) {
        win.clearInterval(timer);
        timer = null;
      }
    };
    const track = panel => {
      let state = states.get(panel);
      if (!state) {
        state = { real: 0, startedAt: Date.now(), sawBar: false };
        states.set(panel, state);
      }
      if (!timer) {
        timer = win.setInterval(tick, CREEP_TICK_MS);
        win.addEventListener("unload", () => win.clearInterval(timer), { once: true });
      }
      return state;
    };
    const raise = (browser, value) => {
      const panel = panelOf(browser);
      if (!panel) {
        return;
      }
      const state = track(panel);
      state.real = Math.max(state.real, value);
      paint(panel, state);
    };
    const restart = browser => {
      const panel = panelOf(browser);
      if (!panel) {
        return;
      }
      // Progress never goes back while the bar is up; a fresh load starts at 0.
      if (barOf(panel) && states.has(panel)) {
        return;
      }
      states.delete(panel);
      panel.style.setProperty(PROGRESS_VAR, "0");
      track(panel);
    };
    gBrowser.addTabsProgressListener({
      onStateChange: (browser, webProgress, request, flags, status) => {
        if (!webProgress?.isTopLevel || !this.loadingLine) {
          return;
        }
        const { STATE_START, STATE_STOP, STATE_IS_NETWORK } = Ci.nsIWebProgressListener;
        if (!(flags & STATE_IS_NETWORK)) {
          return;
        }
        if (flags & STATE_START) {
          restart(browser);
        } else if (flags & STATE_STOP && Components.isSuccessCode(status) && !webProgress.isLoadingDocument) {
          raise(browser, 1);
        }
      },
      onProgressChange: (browser, webProgress, request, curSelf, maxSelf, curTotal, maxTotal) => {
        if (!this.loadingLine || !(maxTotal > 0)) {
          return;
        }
        // Leave the last stretch for STATE_STOP, like Safari.
        raise(browser, Math.min(0.95, curTotal / maxTotal));
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
