/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave7/split: a split pane's actions live on the pane. Zen already draws a
// small header at the top of each pane when you hover it (a drag handle to
// rearrange, and a button that takes the page out of the split). Whimsy
// adds a ⋯ button there that opens the pane's menu.
//
// wave7/split2 (user: "Both. Copy Arc identically."): the ⋯ menu holds
// exactly Arc's per-pane items, the ones Arc shows in the split row's
// "<page title> ▸" submenu (WhimsySplitRow builds those from the same list):
//   Separate from Split View
//   ---
//   Share ▸ · Mute · Copy Link ⇧⌘C · Copy link as Markdown
//   ---
//   Archive Item
// Swap Panes, Follower Split, Favorite This Split and Expand Current Split
// are still in the command bar and keep their keys.
//
// Arc's pane header is always visible: a strip over the page with back,
// forward, reload, the page's host in the middle, and the pane's buttons
// on the right. Whimsy keeps Zen's hover header by default; Settings →
// Links → Split view → "Always show split pane headers"
// (whimsy.split.always-show-headers) turns it into Arc's strip. The nav
// buttons and host are in every header and shown only in that mode (CSS).
//
// Zen's own header button for "take this page out" (fullscreen icon, no
// label) is hidden while this is on: the menu's first item does the same,
// with a name. The header also shows while its ⋯ button has keyboard focus
// or its menu is open, and "Split Pane Actions…" in the command bar opens
// the focused pane's menu from the keyboard.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyCopy: "resource:///modules/whimsy/WhimsyCopy.sys.mjs",
  WhimsySplitKeys: "resource:///modules/whimsy/WhimsySplitKeys.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.split-pane-menu";
export const ALWAYS_SHOW_PREF = "whimsy.split.always-show-headers";
const MENU_ID = "whimsySplitPaneMenu";
const BUTTON_CLASS = "whimsy-split-pane-menu-button";
const OPEN_ATTR = "whimsy-menu-open";
const installed = new WeakSet();

function enabled(pref = FEATURE_PREF) {
  return Services.prefs.getBoolPref(pref, true);
}

// Arc's per-pane items, in Arc's order. [action, l10n id]; null is a
// separator; "share" is Firefox's Share submenu (SharingUtils).
export const PANE_ITEMS = [
  ["separate", "whimsy-split-pane-separate"],
  null,
  ["share", null],
  ["mute", "whimsy-split-pane-mute"],
  ["copy-link", "whimsy-split-pane-copy-link"],
  ["copy-markdown", "whimsy-split-pane-copy-markdown"],
  null,
  ["archive", "whimsy-split-pane-archive"],
];

// The ⋯ menu's ids, one per action (the row submenus use data attributes).
const PANE_IDS = {
  separate: "whimsySplitPane-separate",
  share: "whimsySplitPane-share",
  mute: "whimsySplitPane-mute",
  "copy-link": "whimsySplitPane-copyLink",
  "copy-markdown": "whimsySplitPane-copyMarkdown",
  archive: "whimsySplitPane-archive",
};

function isBlank(tab) {
  const uri = tab?.linkedBrowser?.currentURI;
  return !uri || lazy.WhimsyCopy.isBlank(uri);
}

export const WhimsySplitPane = {
  get enabled() {
    return enabled();
  },

  get alwaysShow() {
    return Services.prefs.getBoolPref(ALWAYS_SHOW_PREF, false);
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
    if (!splitter || installed.has(win)) {
      return;
    }
    installed.add(win);
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

    // The always-visible header shows the page's host and whether it can go
    // back or forward; keep both current.
    win.gBrowser.addTabsProgressListener({
      onLocationChange: (browser, webProgress) => {
        if (webProgress?.isTopLevel) {
          this.updateHeaderFor(win, browser);
        }
      },
    });

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
    const paneTab = () => this.tabForContainer(win, container ?? header.closest(".browserSidebarContainer"));

    // Arc's strip: back, forward, reload, then the host. Shown only when
    // headers are always visible (whimsy-browser.css).
    const nav = (cls, l10nId, act) => {
      const el = document.createXULElement("toolbarbutton");
      el.classList.add("whimsy-split-pane-nav", cls);
      el.setAttribute("tabindex", "0");
      document.l10n.setAttributes(el, l10nId);
      el.addEventListener("command", () => {
        const browser = paneTab()?.linkedBrowser;
        if (browser) {
          act(browser);
        }
      });
      return el;
    };
    const back = nav("whimsy-split-pane-back", "whimsy-split-pane-back", b => b.canGoBack && b.goBack());
    const forward = nav("whimsy-split-pane-forward", "whimsy-split-pane-forward", b => b.canGoForward && b.goForward());
    const reload = nav("whimsy-split-pane-reload", "whimsy-split-pane-reload", b => b.reload());
    const host = document.createXULElement("hbox");
    host.classList.add("whimsy-split-pane-host");
    host.setAttribute("align", "center");
    host.setAttribute("pack", "center");
    const hostIcon = document.createXULElement("image");
    hostIcon.classList.add("whimsy-split-pane-host-icon");
    const hostLabel = document.createXULElement("label");
    hostLabel.classList.add("whimsy-split-pane-host-label");
    hostLabel.setAttribute("crop", "end");
    host.append(hostIcon, hostLabel);
    header.prepend(back, forward, reload, host);

    const button = document.createXULElement("toolbarbutton");
    button.classList.add(BUTTON_CLASS);
    button.setAttribute("tabindex", "0");
    button.setAttribute("aria-haspopup", "menu");
    document.l10n.setAttributes(button, "whimsy-split-pane-menu-button");
    button.addEventListener("command", event => {
      // A toolbarbutton fires command for Enter and Space as well as a
      // click; from the keyboard, the first arrow key picks its first item.
      const keyboard = event.inputSource == win.MouseEvent.MOZ_SOURCE_KEYBOARD;
      this.openMenuForTab(win, paneTab(), { anchor: button, keyboard });
    });
    // Zen's drag handle had no name either.
    const drag = header.querySelector(".zen-tab-rearrange-button");
    if (drag) {
      document.l10n.setAttributes(drag, "whimsy-split-pane-drag");
    }
    // Last, after Zen's two buttons.
    header.appendChild(button);
    const browser = paneTab()?.linkedBrowser ?? container?.querySelector("browser");
    if (browser) {
      // This header may not be in the pane yet, so pass it rather than
      // look it up from the browser (an already-loaded page fires no
      // further location change to fill it later).
      this.updateHeaderFor(win, browser, header);
    }
  },

  // The host label and back/forward state of the header over `browser`.
  updateHeaderFor(win, browser, header = browser?.closest(".browserSidebarContainer")?.querySelector(".zen-view-splitter-header")) {
    const label = header?.querySelector(".whimsy-split-pane-host-label");
    if (!label) {
      return;
    }
    let text = "";
    try {
      const uri = browser.currentURI;
      if (uri && !lazy.WhimsyCopy.isBlank(uri)) {
        text = uri.displayHostPort || uri.displaySpec;
      }
    } catch {
      // No host (about:, data:): leave it empty.
    }
    label.setAttribute("value", text);
    header.querySelector(".whimsy-split-pane-back")?.toggleAttribute("disabled", !browser.canGoBack);
    header.querySelector(".whimsy-split-pane-forward")?.toggleAttribute("disabled", !browser.canGoForward);
  },

  // Fills `popup` with Arc's per-pane items for `tab`. `ids` gives the ⋯
  // menu its fixed ids; the row's submenus (several panes) go without.
  fillPaneItems(win, popup, tab, { ids = false } = {}) {
    const { document } = win;
    popup.replaceChildren();
    let shareAfter = null;
    for (const entry of PANE_ITEMS) {
      if (!entry) {
        popup.appendChild(document.createXULElement("menuseparator"));
        continue;
      }
      const [action, l10nId] = entry;
      if (action == "share") {
        // Firefox's own Share ▸ (macOS share services, Copy Link, email),
        // inserted after the item before it.
        shareAfter = popup.lastElementChild;
        continue;
      }
      const item = document.createXULElement("menuitem");
      item.dataset.whimsyPaneAction = action;
      if (ids) {
        item.id = PANE_IDS[action];
      }
      document.l10n.setAttributes(item, l10nId);
      switch (action) {
        case "mute": {
          // Arc greys Mute out on a pane that isn't playing anything.
          const muted = tab.muted;
          document.l10n.setAttributes(item, muted ? "whimsy-split-pane-unmute" : "whimsy-split-pane-mute");
          item.disabled = !muted && !tab.soundPlaying;
          break;
        }
        case "copy-link":
          // Shows Copy URL's key (⇧⌘C), like Arc; the key copies the
          // focused page, this item this pane's.
          item.setAttribute("key", "zen-copy-url");
          item.disabled = isBlank(tab);
          break;
        case "copy-markdown":
          item.disabled = isBlank(tab);
          break;
      }
      popup.appendChild(item);
    }
    if (shareAfter && win.SharingUtils && tab.linkedBrowser) {
      try {
        win.SharingUtils.ensureShareMenu(tab.linkedBrowser, null, shareAfter);
        const share = shareAfter.nextElementSibling;
        if (share?.matches(".share-tab-url-item")) {
          share.dataset.whimsyPaneAction = "share";
          // Firefox's string has an access key and Arc's items don't;
          // a menu mixing the two trips Gecko's access-key check.
          document.l10n.setAttributes(share, "whimsy-menus-split-pane-share");
          share.removeAttribute("accesskey");
          if (ids) {
            share.id = PANE_IDS.share;
          }
        }
      } catch (e) {
        console.error("Whimsy: split pane share menu", e);
      }
    }
  },

  // Runs one of Arc's per-pane actions on `tab`'s pane.
  runPaneAction(win, action, tab) {
    if (!this.splitOf(win, tab)) {
      return false;
    }
    const keys = lazy.WhimsySplitKeys;
    switch (action) {
      case "separate":
        // Arc keeps the page in front once it's out.
        win.gBrowser.selectedTab = tab;
        return keys.separatePage(win);
      case "mute":
        tab.toggleMuteAudio();
        return true;
      case "copy-link":
      case "copy-markdown":
        lazy.WhimsyCopy.copy(win, lazy.WhimsyCopy.linksFor([tab]), { markdown: action == "copy-markdown" });
        return true;
      case "archive":
        win.gZenViewSplitter.removeTabFromGroup(tab, undefined, { forUnsplit: true, changeTab: tab.selected });
        win.gBrowser.removeTab(tab, { animate: true });
        return true;
    }
    return false;
  },

  ensureMenu(win) {
    const { document } = win;
    let menu = document.getElementById(MENU_ID);
    if (menu) {
      return menu;
    }
    menu = document.createXULElement("menupopup");
    menu.id = MENU_ID;
    menu.addEventListener("command", event => {
      const action = event.target.dataset?.whimsyPaneAction;
      // Share's own items (inside its submenu) are SharingUtils'.
      if (action && event.target.parentNode == menu && menu.whimsyTab) {
        this.runPaneAction(win, action, menu.whimsyTab);
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

  openMenuForTab(win, tab, { anchor = null, keyboard = false } = {}) {
    if (!this.enabled || !this.splitOf(win, tab)) {
      return false;
    }
    const container = tab.linkedBrowser?.closest(".browserSidebarContainer");
    const headerContainer = container?.querySelector(".zen-view-splitter-header-container");
    anchor ??= headerContainer?.querySelector(`.${BUTTON_CLASS}`) ?? container;
    const menu = this.ensureMenu(win);
    this.fillPaneItems(win, menu, tab, { ids: true });
    menu.whimsyTab = tab;
    menu.whimsyHeader = headerContainer ?? null;
    // Keep the header up while its menu is open (no hover needed).
    headerContainer?.setAttribute(OPEN_ATTR, "true");
    // From the keyboard the menu opens with nothing chosen, like a macOS
    // menu: the first arrow key highlights the first item. (activateItem
    // would *run* that item, Separate from Split View, and close the menu;
    // JS can't pre-select a menupopup row.)
    menu.openPopup(anchor, { position: "after_end", triggerEvent: null });
    return true;
  },

  // With the split row menu off, the tab menu keeps one split item, the one
  // that creates a split; a split tab's actions are on the pane instead.
  // (With it on, a split row opens WhimsySplitRow's menu, not this one.)
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
