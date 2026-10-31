/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave7/menus2: Arc's words for closing tabs, where Whimsy really archives.
//
// Arc never says "Close" for a tab: its tab menu ends Archive Tab ·
// Archive Tabs Below (arc-ref/menus-context.txt), Edit's Cmd+Z is "Undo
// Archive Tab" and File's Shift+Cmd+T is "Restore Last Closed Tab"
// (arc-ref/menus2.txt). In Whimsy a closed tab goes to the Archive
// (WhimsyArchive's store, wave6), so the tab menu says the same:
//
// - Close Tab → Archive Tab (Archive N Tabs for a selection). It stays
//   "Close Tab" where nothing is archived: a private tab or window, Mini
//   Whimsy, or with the Archive off. Essentials have no close row (Zen
//   hides it); a pinned tab closed from the menu is archived like any
//   other, so it says Archive too.
// - Archive Tabs Below (new, after it): archives the regular tabs under
//   this one in its space, one batch the Archive and Cmd+Z restore
//   together. Not on pinned tabs or Essentials (Arc shows Remove Pin /
//   Remove Favorite there instead); disabled with nothing below or with
//   several tabs selected, as in Arc.
// - Reopen Closed Tab(s) → Restore Last Closed Tab(s), Shift+Cmd+T's name
//   in Arc's File menu and Whimsy's shortcut sheet. Same command.
//
// Labels are set on every popupshowing, after Firefox's own (this listens
// on the window), so Firefox's tab counts are already in place.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyArchive: "resource:///modules/whimsy/WhimsyArchive.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.archive-tab-menu";
const POPUP_ID = "tabContextMenu";
export const BELOW_ID = "context_whimsyArchiveTabsBelow";
const PRIVATE_TAB_ATTR = "whimsy-private";

// Firefox's ids, restored when the feature is off.
const FIREFOX_CLOSE_L10N = "tab-context-close-n-tabs";
const FIREFOX_REOPEN_L10N = "tab-context-reopen-closed-tabs";

function enabled() {
  return Services.prefs.getBoolPref(FEATURE_PREF, true);
}

export const WhimsyArchiveMenu = {
  get enabled() {
    return enabled();
  },

  // Whether closing these tabs puts them in the Archive (WhimsyArchive's
  // recordClose keeps the same tabs SessionStore would).
  archives(win, tabs) {
    if (
      !lazy.WhimsyArchive.viewEnabled ||
      win._whimsyQuickWindow ||
      lazy.PrivateBrowsingUtils.isWindowPrivate(win)
    ) {
      return false;
    }
    return tabs.length > 0 && tabs.every(tab => !tab.hasAttribute(PRIVATE_TAB_ATTR));
  },

  // The regular tabs listed under `tab` in its space: not pinned, not
  // Essentials, not Zen's empty or Glance tabs, and not the rest of the
  // tab's own split (a split is one row in the sidebar, as in Arc).
  tabsBelow(win, tab) {
    if (!tab || tab.pinned || tab.hasAttribute("zen-essential")) {
      return [];
    }
    const space = tab.getAttribute("zen-workspace-id") || "";
    const ownSplit = tab.group?.hasAttribute("split-view-group") ? tab.group : null;
    const tabs = win.gBrowser.tabs;
    const start = tabs.indexOf(tab);
    if (start < 0) {
      return [];
    }
    return tabs.slice(start + 1).filter(
      t =>
        !t.pinned &&
        !t.hidden &&
        !t.closing &&
        !t.hasAttribute("zen-essential") &&
        !t.hasAttribute("zen-empty-tab") &&
        !t.hasAttribute("zen-glance-tab") &&
        (t.getAttribute("zen-workspace-id") || "") == space &&
        (!ownSplit || t.group != ownSplit)
    );
  },

  archiveTabsBelow(win, tab) {
    const below = this.tabsBelow(win, tab);
    if (!below.length) {
      return 0;
    }
    lazy.WhimsyArchive.archiveTabs(win, below, {
      reason: "manual",
      groupId: `below-${Date.now()}`,
    });
    return below.length;
  },

  initWindow(win) {
    const popup = win.document.getElementById(POPUP_ID);
    if (!popup) {
      return;
    }
    const onShowing = event => {
      if (event.target == popup) {
        try {
          this.update(win, popup);
        } catch (e) {
          console.error("Whimsy: archive tab menu", e);
        }
      }
    };
    win.addEventListener("popupshowing", onShowing);
    win.addEventListener("unload", () => win.removeEventListener("popupshowing", onShowing), { once: true });
  },

  // Created on first show, after Firefox has arranged its menu (its
  // MenuSectionLayout runs once, on the first popupshowing).
  ensureItem(win, popup) {
    const { document } = win;
    let item = document.getElementById(BELOW_ID);
    if (item) {
      return item;
    }
    const close = document.getElementById("context_closeTab");
    if (!close || close.parentNode != popup) {
      return null;
    }
    item = document.createXULElement("menuitem");
    item.id = BELOW_ID;
    item.addEventListener("command", () => {
      // The tab the menu opened on, even if Firefox already let go of it.
      const tab = win.TabContextMenu?.contextTab ?? item._whimsyTab;
      if (tab?.isConnected) {
        this.archiveTabsBelow(win, tab);
      }
    });
    close.after(item);
    return item;
  },

  // A row still carrying Firefox's lazy id would get it back on its first
  // translation, so that goes.
  setL10nId(item, id) {
    item.removeAttribute("data-lazy-l10n-id");
    if (item.getAttribute("data-l10n-id") != id) {
      item.setAttribute("data-l10n-id", id);
    }
  },

  update(win, popup) {
    const { document } = win;
    const close = document.getElementById("context_closeTab");
    const reopen = document.getElementById("context_undoCloseTab");
    const on = enabled();
    const tab = win.TabContextMenu?.contextTab;
    const contextTabs = win.TabContextMenu?.contextTabs ?? (tab ? [tab] : []);
    const archives = on && this.archives(win, contextTabs);

    // Firefox already set { tabCount } on both rows; only the ids change.
    if (close) {
      if (archives) {
        this.setL10nId(close, "whimsy-tab-context-archive-tabs");
      } else if (close.getAttribute("data-l10n-id")?.startsWith("whimsy-")) {
        // Back to Firefox's wording (its alt layout has its own id).
        const alt = win.TabContextMenu?._altTabContextMenu && close.dataset.altL10nId;
        this.setL10nId(close, alt || FIREFOX_CLOSE_L10N);
      }
    }
    if (reopen) {
      this.setL10nId(reopen, on ? "whimsy-tab-context-restore-closed-tabs" : FIREFOX_REOPEN_L10N);
    }

    const item = on ? this.ensureItem(win, popup) : document.getElementById(BELOW_ID);
    if (!item) {
      return;
    }
    const regular = tab && !tab.pinned && !tab.hasAttribute("zen-essential");
    item.hidden = !on || !regular || !close || close.hidden;
    if (item.hidden) {
      return;
    }
    item._whimsyTab = tab;
    const multi = contextTabs.length > 1;
    item.disabled = multi || !this.tabsBelow(win, tab).length;
    document.l10n.setAttributes(
      item,
      this.archives(win, [tab]) ? "whimsy-tab-context-archive-tabs-below" : "whimsy-tab-context-close-tabs-below"
    );
  },
};
