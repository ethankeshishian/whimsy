/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave7/menuprefs: Settings → Menus. Every item of every right-click menu
// can be turned off (user: "every option we have discovered will be in
// it"; everything stays on until they choose the defaults).
//
// This module is the one registry of those items: menu → its items in the
// order the menu shows them, each with the DOM ids (or a stable selector)
// of its row and the string Settings shows for it. Firefox's, Zen's and
// Whimsy's own rows are all here; a Whimsy module that adds a row at run
// time lists it below (or calls register()) so Settings can offer it.
// Ids that don't exist in this build (wave7/split2's split menus when that
// branch isn't in) are harmless: nothing matches, nothing is hidden.
//
// State: one string pref per menu, whimsy.menus.hidden.<menu>, listing the
// hidden item ids, comma-separated ("" = everything shows).
//
// At run time one window listener (bubbling, registered after every other
// menu module's, so it sees each menu exactly as it is about to show) marks
// hidden rows with an attribute whimsy-browser.css hides, then hides the
// separators that would lead, trail or double up. When nothing is hidden it
// changes nothing at all. A menu whose every row is off doesn't open.

const FEATURE_PREF = "whimsy.feature.menu-prefs";
export const PREF_PREFIX = "whimsy.menus.hidden.";
export const HIDDEN_ATTR = "whimsy-menu-pref-hidden";

const SEPARATOR = "-";
const installed = new WeakSet();

// One row of a menu: `id` is the stable key stored in the pref; `ids` the
// DOM ids it stands for (a row with a selected-tabs twin, or one whose
// label flips, such as Pin/Unpin); `selectors` for rows without an id.
function item(id, l10n, ids = [id], extra = {}) {
  return { id, l10n, selectors: ids.map(domId => `#${cssEscape(domId)}`), ...extra };
}
function bySelector(id, l10n, selectors, extra = {}) {
  return { id, l10n, selectors, ...extra };
}
function cssEscape(id) {
  return id.replace(/([^\w-])/g, "\\$1");
}

// The content area's menu serves four menus: the most specific wins (an
// image that is a link is the Image menu, a link inside a selection the
// Link menu).
function contentContext(win) {
  const c = win.gContextMenu;
  if (!c) {
    return null;
  }
  if (c.onImage || c.onCanvas) {
    return "image";
  }
  if (c.onLink) {
    return "link";
  }
  if (c.onTextInput || c.onVideo || c.onAudio) {
    return null;
  }
  if (c.isContentSelected) {
    return "selection";
  }
  return "page";
}

function contextTabIsEssential(win) {
  return !!win.TabContextMenu?.contextTab?.hasAttribute("zen-essential");
}

// The tab menu (tabContextMenu). Essentials open the same menu; they get
// their own copy of this list, so an Essential's menu can differ.
const TAB_ITEMS = [
  item("new-tab", "whimsy-menus-tab-new-tab", ["context_openANewTab"]),
  item("move-to-folder", "whimsy-menus-tab-move-to-folder", ["context_zenMoveToFolder"]),
  item("group-by-site", "whimsy-menus-tab-group-by-site", ["context_whimsyGroupByDomain"]),
  item("split", "whimsy-menus-tab-split", ["context_zenSplitTabs"]),
  item("share-split", "whimsy-menus-tab-share-split", ["context_zenShareSplitView"]),
  SEPARATOR,
  item("reload", "whimsy-menus-tab-reload", ["context_reloadTab", "context_reloadSelectedTabs"]),
  item("play", "whimsy-menus-tab-play", ["context_playTab", "context_playSelectedTabs"]),
  item("mute", "whimsy-menus-tab-mute", ["context_toggleMuteTab", "context_toggleMuteSelectedTabs"]),
  item("mute-site", "whimsy-menus-tab-mute-site", ["context_whimsyMuteSite"]),
  item("snooze", "whimsy-menus-tab-snooze", ["context_whimsySnooze"]),
  SEPARATOR,
  item("essentials", "whimsy-menus-tab-essentials", ["context_zen-add-essential", "context_zen-remove-essential"]),
  item("rename", "whimsy-menus-tab-rename", ["context_zen-edit-tab-title"]),
  item("change-icon", "whimsy-menus-tab-change-icon", ["context_zen-edit-tab-icon"]),
  SEPARATOR,
  item("pin", "whimsy-menus-tab-pin", [
    "context_pinTab",
    "context_unpinTab",
    "context_pinSelectedTabs",
    "context_unpinSelectedTabs",
  ]),
  item("unload", "whimsy-menus-tab-unload", ["context_unloadTab"]),
  item("duplicate", "whimsy-menus-tab-duplicate", ["context_duplicateTab", "context_duplicateTabs"]),
  item("copy-links", "whimsy-menus-tab-copy-links", ["context_whimsyCopyLinks"]),
  SEPARATOR,
  item("ask-chat", "whimsy-menus-tab-ask-chat", ["context_askChat", "context_askChatSummarize", "context_createAITab"]),
  item("bookmark", "whimsy-menus-tab-bookmark", ["context_bookmarkTab", "context_bookmarkSelectedTabs"]),
  item("watch", "whimsy-menus-tab-watch", ["context_whimsyWatchPage"]),
  item("move-tab", "whimsy-menus-tab-move-tab", ["context_moveTabOptions"]),
  item("reopen-in-container", "whimsy-menus-tab-reopen-in-container", ["context_reopenInContainer"]),
  item("select-all", "whimsy-menus-tab-select-all", ["context_selectAllTabs"]),
  SEPARATOR,
  item("share", "whimsy-menus-tab-share", ["context_shareSelectedTabs"]),
  item("send-to-device", "whimsy-menus-tab-send-to-device", ["context_sendTabToDevice"]),
  SEPARATOR,
  item("close", "whimsy-menus-tab-close", ["context_closeTab"]),
  item("archive-below", "whimsy-menus-tab-archive-below", ["context_whimsyArchiveTabsBelow"]),
  item("close-duplicates", "whimsy-menus-tab-close-duplicates", ["context_closeDuplicateTabs"]),
  item("close-multiple", "whimsy-menus-tab-close-multiple", ["context_closeTabOptions"]),
  item("reopen", "whimsy-menus-tab-reopen", ["context_undoCloseTab"]),
  SEPARATOR,
  item("space-routing", "whimsy-menus-tab-space-routing", ["context_zen-add-domain-to-routing"]),
  item("edit-pinned", "whimsy-menus-tab-edit-pinned", ["context_zen-edit-pinned-page"]),
  item("reset-pinned", "whimsy-menus-tab-reset-pinned", ["context_zen-reset-pinned-tab"]),
  item("follower", "whimsy-menus-tab-follower", ["context_whimsyFollowerSplit"]),
];

// Every menu, in the order Settings shows them. `popup` matches the
// menupopup(s) the menu's rows live in; `when` picks it when one popup
// serves several menus. `pref` (optional): a pref that must exist for
// Settings to list the menu (a branch that may not be in this build).
const MENUS = [
  {
    id: "tab",
    l10n: "whimsy-menus-tab",
    popup: "#tabContextMenu",
    when: win => !contextTabIsEssential(win),
    items: TAB_ITEMS,
  },
  {
    id: "essential",
    l10n: "whimsy-menus-essential",
    popup: "#tabContextMenu",
    when: contextTabIsEssential,
    items: TAB_ITEMS,
  },
  {
    id: "link",
    l10n: "whimsy-menus-link",
    popup: "#contentAreaContextMenu",
    when: win => contentContext(win) == "link",
    items: [
      item("open-in-tab", "whimsy-menus-link-open-in-tab", ["context-openlinkintab", "context-openlinkincurrent"]),
      item("open-in-container", "whimsy-menus-link-open-in-container", [
        "context-openlinkincontainertab",
        "context-openlinkinusercontext-menu",
      ]),
      item("open-in-space", "whimsy-menus-link-open-in-space", ["context-whimsyOpenLinkInSpace"]),
      item("open-in-window", "whimsy-menus-link-open-in-window", ["context-openlink"]),
      item("open-in-private", "whimsy-menus-link-open-in-private", ["context-openlinkprivate"]),
      item("preview", "whimsy-menus-link-preview", ["context-previewlink"]),
      item("split", "whimsy-menus-link-split", ["context-zenSplitLink", "context-openlinkinsplitview"]),
      item("glance", "whimsy-menus-link-glance", ["context-zenOpenLinkInGlance"]),
      SEPARATOR,
      item("bookmark", "whimsy-menus-link-bookmark", ["context-bookmarklink"]),
      item("save", "whimsy-menus-link-save", ["context-savelink"]),
      item("copy-email", "whimsy-menus-link-copy-email", ["context-copyemail", "context-copyphone"]),
      item("copy", "whimsy-menus-link-copy", ["context-copylink"]),
      item("copy-clean", "whimsy-menus-link-copy-clean", ["context-stripOnShareLink"]),
      SEPARATOR,
      item("send-to-device", "whimsy-menus-link-send-to-device", ["context-sendlinktodevice"]),
      SEPARATOR,
      item("inspect", "whimsy-menus-inspect", ["context-inspect"]),
    ],
  },
  {
    id: "page",
    l10n: "whimsy-menus-page",
    popup: "#contentAreaContextMenu",
    when: win => contentContext(win) == "page",
    items: [
      item("back", "whimsy-menus-page-back", ["context-back"]),
      item("forward", "whimsy-menus-page-forward", ["context-forward"]),
      item("reload", "whimsy-menus-page-reload", ["context-reload", "context-stop"]),
      item("bookmark", "whimsy-menus-page-bookmark", ["context-bookmarkpage"]),
      SEPARATOR,
      item("save", "whimsy-menus-page-save", ["context-savepage"]),
      item("qr-code", "whimsy-menus-page-qr-code", ["context-whimsy-qrcode"]),
      item("copy-markdown", "whimsy-menus-page-copy-markdown", ["context-whimsy-copy-markdown"]),
      item("new-note", "whimsy-menus-page-new-note", ["context-whimsy-new-note"]),
      item("select-all", "whimsy-menus-select-all", ["context-selectall"]),
      SEPARATOR,
      item("screenshot", "whimsy-menus-page-screenshot", ["context-take-screenshot"]),
      item("edit-text", "whimsy-menus-page-edit-text", ["context-whimsy-edit-page"]),
      SEPARATOR,
      item("send-to-device", "whimsy-menus-page-send-to-device", ["context-sendpagetodevice"]),
      item("view-source", "whimsy-menus-page-view-source", ["context-viewsource"]),
      item("inspect-a11y", "whimsy-menus-inspect-a11y", ["context-inspect-a11y"]),
      item("inspect", "whimsy-menus-inspect", ["context-inspect"]),
    ],
  },
  {
    id: "selection",
    l10n: "whimsy-menus-selection",
    popup: "#contentAreaContextMenu",
    when: win => contentContext(win) == "selection",
    items: [
      item("search", "whimsy-menus-selection-search", ["context-searchselect"]),
      item("search-private", "whimsy-menus-selection-search-private", ["context-searchselect-private"]),
      item("translate", "whimsy-menus-selection-translate", ["context-translate-selection"]),
      SEPARATOR,
      item("copy", "whimsy-menus-selection-copy", ["context-copy"]),
      item("copy-markdown", "whimsy-menus-selection-copy-markdown", ["context-whimsy-copy-markdown"]),
      item("map", "whimsy-menus-selection-map", ["context-whimsy-verb-map"]),
      item("email", "whimsy-menus-selection-email", ["context-whimsy-verb-email"]),
      item("note", "whimsy-menus-selection-note", ["context-whimsy-verb-note"]),
      item("calendar", "whimsy-menus-selection-calendar", ["context-whimsy-verb-calendar"]),
      item("linear-new", "whimsy-menus-selection-linear-new", ["context-whimsy-verb-linear-new"]),
      item("linear-search", "whimsy-menus-selection-linear-search", ["context-whimsy-verb-linear-search"]),
      item("select-all", "whimsy-menus-select-all", ["context-selectall"]),
      item("print", "whimsy-menus-selection-print", ["context-print-selection"]),
      SEPARATOR,
      item("copy-highlight", "whimsy-menus-selection-copy-highlight", [
        "context-copy-link-to-highlight",
        "context-copy-clean-link-to-highlight",
      ]),
      SEPARATOR,
      item("view-source", "whimsy-menus-selection-view-source", ["context-viewpartialsource-selection"]),
      item("inspect", "whimsy-menus-inspect", ["context-inspect"]),
    ],
  },
  {
    id: "image",
    l10n: "whimsy-menus-image",
    popup: "#contentAreaContextMenu",
    when: win => contentContext(win) == "image",
    items: [
      item("open-link-in-tab", "whimsy-menus-link-open-in-tab", ["context-openlinkintab", "context-openlinkincurrent"]),
      item("open-link-in-window", "whimsy-menus-link-open-in-window", ["context-openlink"]),
      item("open-link-in-private", "whimsy-menus-link-open-in-private", ["context-openlinkprivate"]),
      SEPARATOR,
      item("view", "whimsy-menus-image-view", ["context-viewimage"]),
      item("save", "whimsy-menus-image-save", ["context-saveimage"]),
      item("copy", "whimsy-menus-image-copy", ["context-copyimage-contents"]),
      item("copy-link", "whimsy-menus-image-copy-link", ["context-copyimage"]),
      item("email", "whimsy-menus-image-email", ["context-sendimage"]),
      item("copy-text", "whimsy-menus-image-copy-text", ["context-imagetext"]),
      SEPARATOR,
      item("desktop-background", "whimsy-menus-image-desktop-background", ["context-setDesktopBackground"]),
      SEPARATOR,
      item("inspect", "whimsy-menus-inspect", ["context-inspect"]),
    ],
  },
  {
    id: "space",
    l10n: "whimsy-menus-space",
    popup: "#zenWorkspaceMoreActions",
    // In WhimsySpaceMenu's order.
    items: [
      item("rename", "whimsy-menus-space-rename", ["context_zenEditWorkspace"]),
      item("change-icon", "whimsy-menus-space-change-icon", ["context_zenEditWorkspaceIcon"]),
      item("edit-theme", "whimsy-menus-space-edit-theme", ["context_zenChangeWorkspaceTheme"]),
      item("look", "whimsy-menus-space-look", ["whimsy-space-look-menuitem"]),
      item("profile", "whimsy-menus-space-profile", ["context_zenWorkspacesOpenInContainerTab"]),
      SEPARATOR,
      bySelector("new-space", "whimsy-menus-space-new", [
        '#zenWorkspaceMoreActions > menuitem[command="cmd_zenOpenWorkspaceCreation"]',
      ]),
      item("manage", "whimsy-menus-space-manage", ["context_zenManageWorkspaces"]),
      item("routing", "whimsy-menus-space-routing", ["context_zenSpaceRoutingSettings"]),
      SEPARATOR,
      item("unload", "whimsy-menus-space-unload", ["context_zenUnloadWorkspace"]),
      item("unload-others", "whimsy-menus-space-unload-others", ["context_zenUnloadAllOtherWorkspace"]),
      item("share", "whimsy-menus-space-share", ["context_zenShareWorkspace"]),
      SEPARATOR,
      item("lock", "whimsy-menus-space-lock", ["whimsy-lock-space-menuitem"]),
      item("hide", "whimsy-menus-space-hide", ["whimsy-hide-space-menuitem"]),
      SEPARATOR,
      item("delete", "whimsy-menus-space-delete", ["context_zenDeleteWorkspace"]),
      SEPARATOR,
      item("scratch-keep", "whimsy-menus-space-scratch-keep", ["context_whimsyKeepScratch"]),
      item("scratch-close", "whimsy-menus-space-scratch-close", ["context_whimsyCloseScratch"]),
    ],
  },
  {
    id: "sidebar",
    l10n: "whimsy-menus-sidebar",
    // The sidebar's empty area opens the toolbar menu, whose tab-bar rows
    // are Zen's; the live folder kinds are its submenu.
    popup: "#toolbar-context-menu, #zen-panel-ui-live-folder-create > menupopup",
    items: [
      item("new-folder", "whimsy-menus-sidebar-new-folder", ["zen-context-menu-new-folder-toolbar"]),
      item("new-live-folder", "whimsy-menus-sidebar-new-live-folder", ["zen-panel-ui-live-folder-create"]),
      SEPARATOR,
      bySelector("live-github-prs", "whimsy-menus-sidebar-live-github-prs", [
        '#zen-panel-ui-live-folder-create menuitem[data-l10n-id="zen-live-folder-github-pull-requests"]',
      ]),
      bySelector("live-github-issues", "whimsy-menus-sidebar-live-github-issues", [
        '#zen-panel-ui-live-folder-create menuitem[data-l10n-id="zen-live-folder-github-issues"]',
      ]),
      bySelector("live-rss", "whimsy-menus-sidebar-live-rss", [
        '#zen-panel-ui-live-folder-create menuitem[data-l10n-id="zen-live-folder-type-rss"]',
      ]),
      bySelector("live-jira", "whimsy-menus-sidebar-live-jira", [".whimsy-live-folder-jira-create"]),
      bySelector("live-linear", "whimsy-menus-sidebar-live-linear", [".whimsy-live-folder-linear-create"]),
      bySelector("live-local-servers", "whimsy-menus-sidebar-live-local-servers", [
        ".whimsy-live-folder-local-servers-create",
      ]),
    ],
  },
  {
    id: "folder",
    l10n: "whimsy-menus-folder",
    popup: "#zenFolderActions",
    items: [
      item("live-options", "whimsy-menus-folder-live-options", ["context_zenLiveFolderOptions"]),
      SEPARATOR,
      item("rename", "whimsy-menus-folder-rename", ["context_zenFolderRename"]),
      item("change-icon", "whimsy-menus-folder-change-icon", ["context_zenFolderChangeIcon"]),
      item("color", "whimsy-menus-folder-color", ["context_whimsyFolderColor"]),
      SEPARATOR,
      item("unload", "whimsy-menus-folder-unload", ["context_zenFolderUnloadAll"]),
      item("new-subfolder", "whimsy-menus-folder-new-subfolder", ["context_zenFolderNewSubfolder"]),
      SEPARATOR,
      item("move-to-space", "whimsy-menus-folder-move-to-space", ["context_zenChangeFolderSpace"]),
      item("convert-to-space", "whimsy-menus-folder-convert-to-space", ["context_zenFolderToSpace"]),
      item("share", "whimsy-menus-folder-share", ["context_zenShareFolder"]),
      SEPARATOR,
      item("unpack", "whimsy-menus-folder-unpack", ["context_zenFolderUnpack"]),
      item("delete", "whimsy-menus-folder-delete", ["context_zenFolderDelete"]),
    ],
  },
  {
    // wave7/split2: Arc's split row menu (WhimsySplitRow, ROW_ITEMS).
    id: "split-row",
    l10n: "whimsy-menus-split-row",
    popup: "#whimsySplitRowMenu",
    pref: "whimsy.feature.split-row-menu",
    items: [
      item("share", "whimsy-menus-split-share", ["whimsySplitRow-share"]),
      SEPARATOR,
      item("separate-all", "whimsy-menus-split-row-separate-all", ["whimsySplitRow-separateAll"]),
      item("add-tab", "whimsy-menus-split-row-add-tab", ["whimsySplitRow-addTab"]),
      item("convert", "whimsy-menus-split-row-convert", ["whimsySplitRow-convert"]),
      SEPARATOR,
      bySelector("tab-options", "whimsy-menus-split-row-tab-options", [
        "#whimsySplitRow-tabOptions",
        ".whimsy-split-row-pane",
      ]),
      SEPARATOR,
      item("change-icon", "whimsy-menus-split-row-change-icon", ["whimsySplitRow-changeIcon"]),
      item("rename", "whimsy-menus-split-row-rename", ["whimsySplitRow-rename"]),
      SEPARATOR,
      item("duplicate", "whimsy-menus-split-row-duplicate", ["whimsySplitRow-duplicate"]),
      item("move-to", "whimsy-menus-split-row-move-to", ["whimsySplitRow-moveTo"]),
      SEPARATOR,
      item("archive", "whimsy-menus-split-archive", ["whimsySplitRow-archive"]),
      item("archive-below", "whimsy-menus-tab-archive-below", ["whimsySplitRow-archiveBelow"]),
    ],
  },
  {
    // wave7/split2: the pane's ⋯ menu (WhimsySplitPane, PANE_ITEMS); the
    // same rows make each pane's submenu in the split row menu.
    id: "split-pane",
    l10n: "whimsy-menus-split-pane",
    popup: "#whimsySplitPaneMenu, .whimsy-split-row-pane > menupopup",
    pref: "whimsy.feature.split-pane-menu",
    items: [
      bySelector("separate", "whimsy-menus-split-pane-separate", ['[data-whimsy-pane-action="separate"]']),
      SEPARATOR,
      bySelector("share", "whimsy-menus-split-pane-share", ['[data-whimsy-pane-action="share"]']),
      bySelector("mute", "whimsy-menus-split-pane-mute", ['[data-whimsy-pane-action="mute"]']),
      bySelector("copy-link", "whimsy-menus-split-pane-copy-link", ['[data-whimsy-pane-action="copy-link"]']),
      bySelector("copy-markdown", "whimsy-menus-split-pane-copy-markdown", [
        '[data-whimsy-pane-action="copy-markdown"]',
      ]),
      SEPARATOR,
      bySelector("archive", "whimsy-menus-split-archive", ['[data-whimsy-pane-action="archive"]']),
    ],
  },
];

function isSeparator(node) {
  return node.localName == "menuseparator";
}

export const WhimsyMenuPrefs = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  // Every menu (Settings lists the available ones).
  get menus() {
    return MENUS;
  },

  menu(id) {
    return MENUS.find(menu => menu.id == id) ?? null;
  },

  // Whether Settings offers this menu in this build.
  available(menu) {
    return !menu.pref || Services.prefs.getPrefType(menu.pref) != Services.prefs.PREF_INVALID;
  },

  // The menu's items in order, without the grouping separators.
  items(menuId) {
    return (this.menu(menuId)?.items ?? []).filter(entry => entry != SEPARATOR);
  },

  // The menu's items with SEPARATOR ("-") between groups, for Settings.
  groupedItems(menuId) {
    return this.menu(menuId)?.items ?? [];
  },

  isSeparator(entry) {
    return entry == SEPARATOR;
  },

  // For a Whimsy module that adds a row at run time and isn't listed
  // above: `entry` is { id, l10n, ids } or { id, l10n, selectors }; it goes
  // after the item `after` (or last). Registering twice is a no-op.
  register(menuId, entry, { after } = {}) {
    const menu = this.menu(menuId);
    if (!menu || this.items(menuId).some(existing => existing.id == entry.id)) {
      return;
    }
    const row = entry.selectors
      ? bySelector(entry.id, entry.l10n, entry.selectors)
      : item(entry.id, entry.l10n, entry.ids ?? [entry.id]);
    // Essentials share the tab menu's list; give the tab menus their own
    // copy before changing it.
    const items = [...menu.items];
    const index = after ? items.findIndex(existing => existing.id == after) : -1;
    items.splice(index == -1 ? items.length : index + 1, 0, row);
    for (const other of MENUS) {
      if (other.items == menu.items && other != menu) {
        other.items = items;
      }
    }
    menu.items = items;
  },

  prefName(menuId) {
    return PREF_PREFIX + menuId;
  },

  hiddenIds(menuId) {
    const value = Services.prefs.getStringPref(this.prefName(menuId), "");
    return new Set(
      value
        .split(",")
        .map(id => id.trim())
        .filter(Boolean)
    );
  },

  isHidden(menuId, itemId) {
    return this.hiddenIds(menuId).has(itemId);
  },

  // Shows or hides one item. Stored in the menu's own order, so the pref
  // reads the way the menu does.
  setHidden(menuId, itemId, hidden) {
    const ids = this.hiddenIds(menuId);
    if (hidden) {
      ids.add(itemId);
    } else {
      ids.delete(itemId);
    }
    const order = this.items(menuId).map(entry => entry.id);
    const sorted = [...ids].sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia == -1 ? Infinity : ia) - (ib == -1 ? Infinity : ib);
    });
    const name = this.prefName(menuId);
    const value = sorted.join(",");
    if (value == Services.prefs.getDefaultBranch("").getStringPref(name, "")) {
      Services.prefs.clearUserPref(name);
    } else {
      Services.prefs.setStringPref(name, value);
    }
  },

  // Restore Defaults: back to the pref's default. Today that is every
  // item shown (the user picks the defaults later, in
  // prefs/whimsy/whimsy.yaml).
  restoreDefaults(menuId) {
    Services.prefs.clearUserPref(this.prefName(menuId));
  },

  isDefault(menuId) {
    return !Services.prefs.prefHasUserValue(this.prefName(menuId));
  },

  // Every item of the menu is off.
  allHidden(menuId) {
    const hidden = this.hiddenIds(menuId);
    const items = this.items(menuId);
    return items.length > 0 && items.every(entry => hidden.has(entry.id));
  },

  // --- Run time ---

  // Called last from Whimsy.initWindow, so this bubbling window listener
  // runs after every other module's (WhimsySpaceMenu's order, Archive's
  // labels, menu icons): it sees each menu as it is about to show.
  initWindow(win) {
    if (installed.has(win)) {
      return;
    }
    installed.add(win);
    const onShowing = event => {
      try {
        this.onPopupShowing(win, event);
      } catch (e) {
        console.error("Whimsy: menu items setting", e);
      }
    };
    win.addEventListener("popupshowing", onShowing);
    win.addEventListener("unload", () => win.removeEventListener("popupshowing", onShowing), { once: true });
  },

  onPopupShowing(win, event) {
    const popup = event.target;
    if (popup?.localName != "menupopup") {
      return;
    }
    const menus = MENUS.filter(menu => popup.matches(menu.popup));
    if (!menus.length) {
      return;
    }
    // Last time's marks go first: this menu may now be a different one
    // (an Essential's after a tab's, a link's after the page's).
    for (const node of popup.querySelectorAll(`:scope > [${HIDDEN_ATTR}]`)) {
      node.removeAttribute(HIDDEN_ATTR);
    }
    if (!this.enabled) {
      return;
    }
    const menu = menus.find(candidate => !candidate.when || candidate.when(win));
    if (!menu) {
      return;
    }
    if (this.apply(win, popup, menu.id) && !this.hasVisibleItem(win, popup)) {
      // Every row is off: no empty menu.
      event.preventDefault();
    }
  },

  // Marks the hidden rows of `popup` and tidies its separators. Returns
  // whether any row that would have shown was hidden.
  apply(win, popup, menuId) {
    const hidden = this.hiddenIds(menuId);
    if (!hidden.size) {
      return false;
    }
    const selectors = this.items(menuId)
      .filter(entry => hidden.has(entry.id))
      .flatMap(entry => entry.selectors);
    if (!selectors.length) {
      return false;
    }
    let changed = false;
    for (const node of popup.children) {
      if (isSeparator(node) || !selectors.some(selector => node.matches(selector))) {
        continue;
      }
      if (this.visible(win, node)) {
        changed = true;
      }
      node.setAttribute(HIDDEN_ATTR, "true");
    }
    if (changed) {
      this.collapseSeparators(win, popup);
    }
    return changed;
  },

  visible(win, node) {
    if (node.hidden || node.getAttribute("hidden") == "true" || node.collapsed || node.hasAttribute(HIDDEN_ATTR)) {
      return false;
    }
    return win.getComputedStyle(node).display != "none";
  },

  // No separator first, last, or next to another one.
  collapseSeparators(win, popup) {
    let afterSeparator = true;
    let trailing = null;
    for (const node of popup.children) {
      if (!this.visible(win, node)) {
        continue;
      }
      if (isSeparator(node)) {
        if (afterSeparator) {
          node.setAttribute(HIDDEN_ATTR, "true");
        } else {
          afterSeparator = true;
          trailing = node;
        }
      } else {
        afterSeparator = false;
        trailing = null;
      }
    }
    trailing?.setAttribute(HIDDEN_ATTR, "true");
  },

  hasVisibleItem(win, popup) {
    return [...popup.children].some(node => !isSeparator(node) && this.visible(win, node));
  },
};
