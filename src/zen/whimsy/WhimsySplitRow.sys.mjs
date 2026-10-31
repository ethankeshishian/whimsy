/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave7/split2: Arc's right-click menu on a split view's sidebar row.
// User: "Both. Copy Arc identically." Right-clicking any tab of a split in
// the sidebar opens this instead of the tab menu, with Arc's items, order
// and labels (arc-ref/menus-context.txt "split-tab", frames-menus/
// split-tab.png and split-tab-taboptions.png):
//
//   Share Split View…
//   ---
//   Separate All Tabs
//   Add Tab…
//   Convert to Vertical Split View   (or Horizontal, when stacked)
//   ---
//   Tab Options                      (greyed heading)
//   <page title> ▸                   (one per pane, in layout order)
//   ---
//   Change Icon…
//   Rename…
//   ---
//   Duplicate
//   Move to ▸                        (spaces, the current one checked;
//   ---                               New Space…)
//   Archive Item
//   Archive Tabs Below
//
// Each pane's submenu is Arc's per-pane list, the same items as that pane's
// header ⋯ menu (WhimsySplitPane.PANE_ITEMS). Arc's "Archive" is Whimsy's
// close (closed tabs go to the archive). Every item runs an existing Zen or
// Whimsy action: Zen's unsplit and share, WhimsySplitLayouts' add-a-pane
// and change-orientation, Zen's tab renamer and icon picker, Zen's move to
// space, Firefox's close-tabs-below. Duplicate copies every pane and splits
// the copies the same way.
//
// Several tabs selected beyond this split, or the switch off
// (whimsy.feature.split-row-menu): the ordinary tab menu.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  TabStateCache: "moz-src:///browser/components/sessionstore/TabStateCache.sys.mjs",
  WhimsySplitKeys: "resource:///modules/whimsy/WhimsySplitKeys.sys.mjs",
  WhimsySplitLayouts: "resource:///modules/whimsy/WhimsySplitLayouts.sys.mjs",
  WhimsySplitPane: "resource:///modules/whimsy/WhimsySplitPane.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.split-row-menu";
const LAYOUTS_PREF = "whimsy.feature.split-layouts";
const MENU_ID = "whimsySplitRowMenu";
const PANES_START = "whimsySplitRow-tabOptions";
const PANES_END = "whimsySplitRow-separator-2";
const installed = new WeakSet();

// Arc's row, in order. [id, l10n id, kind]; null is a separator.
export const ROW_ITEMS = [
  ["whimsySplitRow-share", "whimsy-split-row-share"],
  null,
  ["whimsySplitRow-separateAll", "whimsy-split-row-separate-all"],
  ["whimsySplitRow-addTab", "whimsy-split-row-add-tab"],
  ["whimsySplitRow-convert", "whimsy-split-row-convert-vertical"],
  null,
  ["whimsySplitRow-tabOptions", "whimsy-split-row-tab-options"],
  // (one submenu per pane goes here)
  null,
  ["whimsySplitRow-changeIcon", "whimsy-split-row-change-icon"],
  ["whimsySplitRow-rename", "whimsy-split-row-rename"],
  null,
  ["whimsySplitRow-duplicate", "whimsy-split-row-duplicate"],
  ["whimsySplitRow-moveTo", "whimsy-split-row-move-to", "menu"],
  null,
  ["whimsySplitRow-archive", "whimsy-split-row-archive"],
  ["whimsySplitRow-archiveBelow", "whimsy-split-row-archive-below"],
];

function enabled(pref = FEATURE_PREF) {
  return Services.prefs.getBoolPref(pref, true);
}

export const WhimsySplitRow = {
  get enabled() {
    return enabled();
  },

  groupOf(win, tab) {
    return (tab && win.gZenViewSplitter?._data?.find(g => g.tabs.includes(tab))) || null;
  },

  // The split's last tab in the sidebar (where "below" starts).
  lastTab(group) {
    const row = group.tabs[0]?.group;
    return row?.tabs?.at(-1) ?? group.tabs.at(-1);
  },

  // Side by side ("row") or stacked ("column"), by the layout's top level.
  isStacked(group) {
    return group.layoutTree?.direction == "column" || group.gridType == "hsep";
  },

  initWindow(win) {
    if (installed.has(win) || !win.gZenViewSplitter) {
      return;
    }
    installed.add(win);
    // Capture, so the tab menu (a XUL context popup) sees the event already
    // cancelled and stays closed.
    win.addEventListener("contextmenu", event => this.onContextMenu(win, event), true);
  },

  // The split tab a right-click on the sidebar is about, or null.
  tabFromEvent(win, event) {
    const target = event.target;
    if (!target?.closest || target.ownerDocument?.defaultView != win) {
      return null;
    }
    let tab = target.closest(".tabbrowser-tab");
    if (tab?.hasAttribute("zen-glance-tab")) {
      return null;
    }
    if (!tab) {
      const row = target.closest("tab-group[split-view-group]");
      tab = row?.tabs?.[0] ?? null;
    }
    if (!tab?.group?.hasAttribute("split-view-group") || !this.groupOf(win, tab)) {
      return null;
    }
    return tab;
  },

  onContextMenu(win, event) {
    if (!this.enabled || event.defaultPrevented) {
      return;
    }
    const tab = this.tabFromEvent(win, event);
    if (!tab) {
      return;
    }
    const group = this.groupOf(win, tab);
    // Several tabs selected, some outside this split: that's a tab-menu job.
    if (tab.multiselected && win.gBrowser.selectedTabs.some(t => !group.tabs.includes(t))) {
      return;
    }
    event.preventDefault();
    const keyboard = event.inputSource == win.MouseEvent.MOZ_SOURCE_KEYBOARD;
    this.openForTab(win, tab, keyboard ? { anchor: tab } : { event });
  },

  ensureMenu(win) {
    const { document } = win;
    let menu = document.getElementById(MENU_ID);
    if (menu) {
      return menu;
    }
    menu = document.createXULElement("menupopup");
    menu.id = MENU_ID;
    let separators = 0;
    for (const entry of ROW_ITEMS) {
      if (!entry) {
        const separator = document.createXULElement("menuseparator");
        separator.id = `whimsySplitRow-separator-${separators++}`;
        menu.appendChild(separator);
        continue;
      }
      const [id, l10nId, kind] = entry;
      const item = document.createXULElement(kind == "menu" ? "menu" : "menuitem");
      item.id = id;
      document.l10n.setAttributes(item, l10nId);
      if (kind == "menu") {
        const popup = document.createXULElement("menupopup");
        popup.id = `${id}Popup`;
        item.appendChild(popup);
      }
      menu.appendChild(item);
    }
    // Arc's "Tab Options" is a greyed heading over the pane submenus.
    // (Looked up in the menu: it isn't in the document yet.)
    menu.querySelector(`#${PANES_START}`)?.setAttribute("disabled", "true");
    menu.addEventListener("command", event => {
      const tab = menu.whimsyTab;
      if (tab) {
        this.onCommand(win, event.target, tab);
      }
    });
    document.getElementById("mainPopupSet").appendChild(menu);
    return menu;
  },

  // Sets every item for this split: labels that depend on it, what's
  // available, one submenu per pane, the spaces.
  updateMenu(win, tab) {
    const { document } = win;
    const menu = this.ensureMenu(win);
    const group = this.groupOf(win, tab);
    if (!group) {
      return false;
    }
    const get = id => document.getElementById(id);
    const splitter = win.gZenViewSplitter;
    const layouts = enabled(LAYOUTS_PREF);

    get("whimsySplitRow-share").disabled = !win.gZenShareManager?.enabled;
    get("whimsySplitRow-addTab").disabled = !layouts || group.tabs.length >= splitter.MAX_TABS;
    const convert = get("whimsySplitRow-convert");
    document.l10n.setAttributes(
      convert,
      this.isStacked(group) ? "whimsy-split-row-convert-horizontal" : "whimsy-split-row-convert-vertical"
    );
    convert.disabled = !layouts;

    // One "<page title> ▸" per pane, in the order they're laid out.
    for (const old of menu.querySelectorAll(".whimsy-split-row-pane")) {
      old.remove();
    }
    const end = get(PANES_END);
    for (const pane of lazy.WhimsySplitKeys.panes(group)) {
      const item = document.createXULElement("menu");
      item.classList.add("whimsy-split-row-pane");
      item.setAttribute("label", pane.label || pane.linkedBrowser?.currentURI?.spec || "");
      item.whimsyTab = pane;
      const popup = document.createXULElement("menupopup");
      item.appendChild(popup);
      lazy.WhimsySplitPane.fillPaneItems(win, popup, pane);
      menu.insertBefore(item, end);
    }

    get("whimsySplitRow-rename").disabled =
      tab.hasAttribute("zen-essential") ||
      !Services.prefs.getBoolPref("zen.tabs.rename-tabs", true) ||
      !win.gZenVerticalTabsManager?._prefsSidebarExpanded ||
      !win.gZenTabRenamer;
    get("whimsySplitRow-changeIcon").disabled = !win.gZenEmojiPicker;
    this.fillSpaces(win, tab);
    const last = this.lastTab(group);
    get("whimsySplitRow-archiveBelow").disabled = !win.gBrowser._getTabsToTheEndFrom(last).length;
    menu.whimsyTab = tab;
    return true;
  },

  // Move to ▸: every space, this split's checked, then New Space….
  fillSpaces(win, tab) {
    const { document } = win;
    const moveTo = document.getElementById("whimsySplitRow-moveTo");
    const popup = document.getElementById("whimsySplitRow-moveToPopup");
    const workspaces = win.gZenWorkspaces;
    popup.replaceChildren();
    const spaces = workspaces?.workspaceEnabled ? workspaces.getWorkspaces() : [];
    moveTo.disabled = !spaces.length || tab.hasAttribute("zen-essential");
    const current = tab.getAttribute("zen-workspace-id");
    for (const space of spaces) {
      const item = document.createXULElement("menuitem");
      item.setAttribute("type", "checkbox");
      item.setAttribute("label", space.name);
      item.dataset.whimsySpace = space.uuid;
      if (space.uuid == current) {
        item.setAttribute("checked", "true");
      }
      popup.appendChild(item);
    }
    popup.appendChild(document.createXULElement("menuseparator"));
    const create = document.createXULElement("menuitem");
    create.id = "whimsySplitRow-newSpace";
    document.l10n.setAttributes(create, "whimsy-split-row-new-space");
    popup.appendChild(create);
  },

  openForTab(win, tab, { event = null, anchor = null } = {}) {
    if (!this.enabled || !this.updateMenu(win, tab)) {
      return false;
    }
    const menu = this.ensureMenu(win);
    if (event && !anchor) {
      menu.openPopupAtScreen(event.screenX, event.screenY, true, event);
    } else {
      menu.openPopup(anchor ?? tab, { position: "after_start", isContextMenu: true });
    }
    return true;
  },

  onCommand(win, target, tab) {
    // A pane's item: its submenu says which pane.
    const paneAction = target.dataset?.whimsyPaneAction;
    if (paneAction) {
      const paneMenu = target.parentNode?.parentNode;
      if (paneMenu?.classList?.contains("whimsy-split-row-pane") && paneMenu.whimsyTab) {
        lazy.WhimsySplitPane.runPaneAction(win, paneAction, paneMenu.whimsyTab);
      }
      return;
    }
    if (target.dataset?.whimsySpace) {
      this.moveToSpace(win, tab, target.dataset.whimsySpace);
      return;
    }
    this.run(win, target.id, tab);
  },

  run(win, id, tab) {
    const group = this.groupOf(win, tab);
    if (!group) {
      return false;
    }
    const { gBrowser } = win;
    switch (id) {
      case "whimsySplitRow-share":
        win.gZenShareManager?.shareSplitView(tab.group);
        return true;
      case "whimsySplitRow-separateAll":
        return this.separateAll(win, group);
      case "whimsySplitRow-addTab": {
        // Arc adds the new pane after the last one, from the command bar.
        const panes = lazy.WhimsySplitKeys.panes(group);
        gBrowser.selectedTab = panes.at(-1);
        return lazy.WhimsySplitLayouts.addSplit(win, this.isStacked(group) ? "bottom" : "right");
      }
      case "whimsySplitRow-convert":
        if (!group.tabs.includes(gBrowser.selectedTab)) {
          gBrowser.selectedTab = tab;
        }
        return lazy.WhimsySplitLayouts.changeOrientation(win);
      case "whimsySplitRow-changeIcon":
        return this.changeIcon(win, tab);
      case "whimsySplitRow-rename":
        win.gZenTabRenamer?.start({ target: tab });
        return true;
      case "whimsySplitRow-duplicate":
        return !!this.duplicate(win, group);
      case "whimsySplitRow-newSpace":
        win.document.getElementById("cmd_zenOpenWorkspaceCreation")?.doCommand();
        return true;
      case "whimsySplitRow-archive":
        gBrowser.removeTabs([...group.tabs]);
        return true;
      case "whimsySplitRow-archiveBelow":
        gBrowser.removeTabsToTheEndFrom(this.lastTab(group));
        return true;
    }
    return false;
  },

  // Arc's Separate All Tabs: every pane its own tab again, nothing closes.
  separateAll(win, group) {
    const splitter = win.gZenViewSplitter;
    const index = splitter._data.indexOf(group);
    if (index < 0) {
      return false;
    }
    if (index == splitter.currentView) {
      splitter.unsplitCurrentView();
    } else {
      splitter.removeGroup(index);
    }
    return true;
  },

  // Zen's Change Icon (the tab menu's), for the tab that was right-clicked.
  changeIcon(win, tab) {
    const { gBrowser, gZenEmojiPicker } = win;
    if (!gZenEmojiPicker) {
      return false;
    }
    gZenEmojiPicker.open(tab.iconImage, {
      emojiAsSVG: true,
      closeOnSelect: false,
      allowNone: Boolean(tab.zenStaticIcon),
      onSelect: icon => {
        if (icon) {
          tab.zenStaticIcon = icon;
        } else {
          delete tab.zenStaticIcon;
        }
        gBrowser.setIcon(tab, icon);
        lazy.TabStateCache.update(tab.permanentKey, { image: icon || null });
      },
    });
    return true;
  },

  // A copy of every pane, split the same way, after this split.
  duplicate(win, group) {
    const { gBrowser } = win;
    const splitter = win.gZenViewSplitter;
    const panes = lazy.WhimsySplitKeys.panes(group);
    const copies = panes.map(pane => gBrowser.duplicateTab(pane, true));
    for (const copy of copies) {
      // A copy starts next to its original, inside the split's row; it
      // belongs to the new split only.
      if (copy.splitView && this.groupOf(win, copy)) {
        splitter.removeTabFromGroup(copy, undefined, { forUnsplit: true });
      }
      if (copy.group?.hasAttribute("split-view-group")) {
        gBrowser.ungroupTab(copy);
      }
    }
    return splitter.splitTabs(copies, group.gridType, 0);
  },

  // Zen's tab menu "move to space" for the whole split (Zen moves a split's
  // row as one), then shows that space like Zen does.
  async moveToSpace(win, tab, uuid) {
    const workspaces = win.gZenWorkspaces;
    const group = this.groupOf(win, tab);
    if (!workspaces || !group || tab.getAttribute("zen-workspace-id") == uuid) {
      return;
    }
    workspaces.moveTabToWorkspace(tab, uuid);
    workspaces.lastSelectedWorkspaceTabs[uuid] = tab;
    const space = workspaces.getWorkspaces().find(w => w.uuid == uuid);
    if (space) {
      await workspaces.changeWorkspace(space);
    }
  },
};
