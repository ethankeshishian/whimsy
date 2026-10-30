/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave7/split: a split pane's actions live on the pane. Zen already draws a
// small header at the top of each pane when you hover it (a drag handle to
// rearrange, and a button that takes the page out of the split). Whimsy
// adds a ⋯ button there that opens the pane's menu, and takes the same
// actions out of the tab right-click menu, which keeps only the one item
// that creates a split ("Add Split View" / "Open N Tabs in Split View").
// Why: the action sits on what it changes; a tab right-click doesn't say
// which pane it means, and each control lives in one place.
//
// The menu, in groups (optional items last, so the fixed ones never move):
//   Separate Page from Split View · Separate All Tabs
//   Swap Panes · Make This a Follower Split / Stop Following (2 panes)
//   Favorite This Split… · Share Split View… (when Zen's share is on)
//   Close this Split Pane · Expand Current Split
// Arc's names: "Separate Page from Split View", "Close this Split Pane" and
// "Expand Current Split" (Arc's View menu; Expand keeps this pane and closes
// the other panes, per Arc's command bar docs), "Separate All Tabs" (Arc's
// split tab menu, Help Center "Split View: View Multiple Tabs at Once":
// every pane goes back to being its own tab, nothing closes).
//
// Zen's own header button for "take this page out" (fullscreen icon, no
// label) is hidden while this is on: the menu's first item does the same,
// with a name. The header also shows while its ⋯ button has keyboard focus
// or its menu is open, and "Split Pane Actions…" in the command bar opens
// the focused pane's menu from the keyboard.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyFollowerTabs: "resource:///modules/whimsy/WhimsyFollowerTabs.sys.mjs",
  WhimsySplit: "resource:///modules/whimsy/WhimsySplit.sys.mjs",
  WhimsySplitFavorites: "resource:///modules/whimsy/WhimsySplitFavorites.sys.mjs",
  WhimsySplitKeys: "resource:///modules/whimsy/WhimsySplitKeys.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.split-pane-menu";
const MENU_ID = "whimsySplitPaneMenu";
const BUTTON_CLASS = "whimsy-split-pane-menu-button";
const OPEN_ATTR = "whimsy-menu-open";

function enabled(pref = FEATURE_PREF) {
  return Services.prefs.getBoolPref(pref, true);
}

// [id, l10n id] per group. Visibility is decided in updateMenu.
const GROUPS = [
  [
    ["whimsySplitPane-separate", "whimsy-menu-separate-page"],
    ["whimsySplitPane-separateAll", "whimsy-split-pane-separate-all"],
  ],
  [
    ["whimsySplitPane-swap", "whimsy-split-pane-swap"],
    ["whimsySplitPane-follow", "tab-context-whimsy-follow"],
  ],
  [
    ["whimsySplitPane-favorite", "whimsy-split-pane-favorite"],
    ["whimsySplitPane-share", "zen-share-split-view"],
  ],
  [
    ["whimsySplitPane-close", "whimsy-menu-close-split-pane"],
    ["whimsySplitPane-closeOthers", "whimsy-menu-expand-split"],
  ],
];

export const WhimsySplitPane = {
  get enabled() {
    return enabled();
  },

  // The tab shown in a pane (its .browserSidebarContainer), or null.
  tabForContainer(win, container) {
    const browser = container?.querySelector("browser");
    return (browser && win.gBrowser.getTabForBrowser(browser)) || null;
  },

  splitOf(win, tab) {
    return (tab?.splitView && win.gZenViewSplitter?._data?.find(g => g.tabs.includes(tab))) || null;
  },

  initWindow(win) {
    const splitter = win.gZenViewSplitter;
    if (!splitter) {
      return;
    }
    // Every header Zen creates from now on gets the ⋯ button; headers of
    // splits restored before Whimsy started get it here.
    const createHeader = splitter._createHeader;
    if (typeof createHeader == "function" && !createHeader.whimsyWrapped) {
      splitter._createHeader = function (container) {
        const header = createHeader.call(this, container);
        try {
          WhimsySplitPane.decorateHeader(win, header, container);
        } catch (e) {
          console.error("Whimsy: split pane header", e);
        }
        return header;
      };
      splitter._createHeader.whimsyWrapped = true;
    }
    for (const header of win.document.querySelectorAll(".zen-view-splitter-header-container")) {
      this.decorateHeader(win, header, header.closest(".browserSidebarContainer"));
    }

    const tabMenu = win.document.getElementById("tabContextMenu");
    // Runs after Zen's own popupshowing (TabContextMenu.updateContextMenu),
    // which is set in markup and so registered first.
    tabMenu?.addEventListener("popupshowing", event => {
      if (event.target == tabMenu) {
        this.updateTabMenu(win);
      }
    });

    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsySplitPaneMenu",
      l10nId: "whimsy-action-split-pane-menu",
      run: w => this.openMenuForTab(w, w.gBrowser.selectedTab, { keyboard: true }),
      icon: "chrome://browser/skin/zen-icons/menu.svg",
      isAvailable: w => this.enabled && !!this.splitOf(w, w.gBrowser.selectedTab),
    });
  },

  decorateHeader(win, headerContainer, container) {
    const header = headerContainer?.querySelector(".zen-view-splitter-header");
    if (!header || header.querySelector(`.${BUTTON_CLASS}`)) {
      return;
    }
    const { document } = win;
    const button = document.createXULElement("toolbarbutton");
    button.classList.add(BUTTON_CLASS);
    button.setAttribute("tabindex", "0");
    button.setAttribute("aria-haspopup", "menu");
    document.l10n.setAttributes(button, "whimsy-split-pane-menu-button");
    button.addEventListener("command", event => {
      const pane = container ?? button.closest(".browserSidebarContainer");
      const tab = this.tabForContainer(win, pane);
      // A toolbarbutton fires command for Enter and Space as well as a
      // click; from the keyboard, the menu opens with its first item active.
      const keyboard = event.inputSource == win.MouseEvent.MOZ_SOURCE_KEYBOARD;
      this.openMenuForTab(win, tab, { anchor: button, keyboard });
    });
    // Zen's drag handle had no name either.
    const drag = header.querySelector(".zen-tab-rearrange-button");
    if (drag) {
      document.l10n.setAttributes(drag, "whimsy-split-pane-drag");
    }
    // Last, after Zen's two buttons.
    header.appendChild(button);
  },

  ensureMenu(win) {
    const { document } = win;
    let menu = document.getElementById(MENU_ID);
    if (menu) {
      return menu;
    }
    menu = document.createXULElement("menupopup");
    menu.id = MENU_ID;
    GROUPS.forEach((group, index) => {
      if (index) {
        const separator = document.createXULElement("menuseparator");
        separator.id = `whimsySplitPane-separator-${index}`;
        menu.appendChild(separator);
      }
      for (const [id, l10nId] of group) {
        const item = document.createXULElement("menuitem");
        item.id = id;
        document.l10n.setAttributes(item, l10nId);
        menu.appendChild(item);
      }
    });
    menu.addEventListener("command", event => {
      const tab = menu.whimsyTab;
      if (tab) {
        this.run(win, event.target.id, tab);
      }
    });
    menu.addEventListener("popuphidden", event => {
      if (event.target == menu) {
        menu.whimsyHeader?.removeAttribute(OPEN_ATTR);
        menu.whimsyHeader = null;
      }
    });
    document.getElementById("mainPopupSet").appendChild(menu);
    return menu;
  },

  // Shows each item that applies to this pane and hides separators left
  // with nothing on one side.
  updateMenu(win, tab) {
    const { document } = win;
    const group = this.splitOf(win, tab);
    const follower = lazy.WhimsyFollowerTabs;
    const partner = follower.enabled ? follower.partnerOf(win, tab) : null;
    const shown = {
      "whimsySplitPane-separate": true,
      "whimsySplitPane-separateAll": true,
      "whimsySplitPane-swap": enabled("whimsy.feature.split-swap-panes"),
      "whimsySplitPane-follow": !!partner,
      "whimsySplitPane-favorite": lazy.WhimsySplitFavorites.enabled,
      "whimsySplitPane-share": !!win.gZenShareManager?.enabled && !!tab.group?.hasAttribute("split-view-group"),
      "whimsySplitPane-close": true,
      "whimsySplitPane-closeOthers": enabled("whimsy.feature.split-close-other-panes") && (group?.tabs.length ?? 0) > 1,
    };
    for (const [id, show] of Object.entries(shown)) {
      document.getElementById(id).hidden = !show;
    }
    if (partner) {
      document.l10n.setAttributes(
        document.getElementById("whimsySplitPane-follow"),
        follower.isSource(tab) ? "tab-context-whimsy-unfollow" : "tab-context-whimsy-follow"
      );
    }
    GROUPS.forEach((items, index) => {
      if (!index) {
        return;
      }
      const before = GROUPS.slice(0, index).flat().some(([id]) => shown[id]);
      const mine = items.some(([id]) => shown[id]);
      document.getElementById(`whimsySplitPane-separator-${index}`).hidden = !before || !mine;
    });
  },

  openMenuForTab(win, tab, { anchor = null, keyboard = false } = {}) {
    if (!this.enabled || !this.splitOf(win, tab)) {
      return false;
    }
    const container = tab.linkedBrowser?.closest(".browserSidebarContainer");
    const headerContainer = container?.querySelector(".zen-view-splitter-header-container");
    anchor ??= headerContainer?.querySelector(`.${BUTTON_CLASS}`) ?? container;
    const menu = this.ensureMenu(win);
    this.updateMenu(win, tab);
    menu.whimsyTab = tab;
    menu.whimsyHeader = headerContainer ?? null;
    // Keep the header up while its menu is open (no hover needed).
    headerContainer?.setAttribute(OPEN_ATTR, "true");
    if (keyboard) {
      menu.addEventListener(
        "popupshown",
        () => {
          const first = [...menu.children].find(el => el.localName == "menuitem" && !el.hidden);
          if (first) {
            menu.activateItem(first);
          }
        },
        { once: true }
      );
    }
    menu.openPopup(anchor, { position: "after_end", triggerEvent: null });
    return true;
  },

  // Each action works on the selected tab, the way its keyboard command
  // does, so the pane is focused first.
  run(win, id, tab) {
    if (!this.splitOf(win, tab)) {
      return;
    }
    if (win.gBrowser.selectedTab != tab) {
      win.gBrowser.selectedTab = tab;
    }
    const keys = lazy.WhimsySplitKeys;
    const split = lazy.WhimsySplit;
    switch (id) {
      case "whimsySplitPane-separate":
        keys.separatePage(win);
        break;
      case "whimsySplitPane-separateAll":
        win.gZenViewSplitter.unsplitCurrentView();
        break;
      case "whimsySplitPane-swap":
        split.swapPanes(win);
        break;
      case "whimsySplitPane-follow":
        lazy.WhimsyFollowerTabs.toggle(win, tab);
        break;
      case "whimsySplitPane-favorite":
        lazy.WhimsySplitFavorites.favoriteCurrentSplit(win);
        break;
      case "whimsySplitPane-share":
        win.gZenShareManager?.shareSplitView(tab.group);
        break;
      case "whimsySplitPane-close":
        keys.closePane(win);
        break;
      case "whimsySplitPane-closeOthers":
        split.closeOtherPanes(win);
        break;
    }
  },

  // The tab menu keeps one split item, the one that creates a split. On a
  // tab that's already in one, its pane actions are on the pane instead.
  updateTabMenu(win) {
    if (!this.enabled) {
      return;
    }
    const { document } = win;
    const contextTab = win.TabContextMenu?.contextTab;
    if (!contextTab) {
      return;
    }
    const selected = contextTab.multiselected ? win.gBrowser.selectedTabs : [contextTab];
    const inSplit = selected.every(t => t.group?.hasAttribute("split-view-group"));
    if (inSplit) {
      const create = document.getElementById("context_zenSplitTabs");
      if (create) {
        create.hidden = true;
      }
      const share = document.getElementById("context_zenShareSplitView");
      if (share) {
        share.hidden = true;
      }
    }
  },
};
