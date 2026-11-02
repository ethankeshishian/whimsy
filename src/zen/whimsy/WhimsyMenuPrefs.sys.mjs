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
// menu module's, so it sees each menu exactly as it is about to show)
// collapses hidden rows, then the separators that would lead, trail or
// double up. When nothing is hidden it changes nothing at all. A menu whose
// every row is off doesn't open.
//
// wave9/menus (design-full-4 H1): on macOS the right-click menus are native
// NSMenus (widget.macos.native-context-menus), which read only a row's
// `hidden` and `collapsed` attributes and ignore CSS. So a hidden row gets
// collapsed="true" (Firefox's own menu code toggles `hidden`, never
// `collapsed`, so the two never fight), plus a marker naming what Whimsy
// did, so the next popupshowing clears only Whimsy's own collapses.

const FEATURE_PREF = "whimsy.feature.menu-prefs";
export const PREF_PREFIX = "whimsy.menus.hidden.";
export const HIDDEN_ATTR = "whimsy-menu-pref-hidden";
// Set beside HIDDEN_ATTR when Whimsy (not someone else) collapsed the row.
export const COLLAPSED_ATTR = "whimsy-menu-pref-collapsed";

const SEPARATOR = "-";

// W10-42: Firefox's container rows, off for good and not in Settings (the
// user, W9-10 then W10-42: a space picks the container, so "Open in New
// Container Tab" was only a setting nobody needs). Keyed by popup. In a
// space with a container, Firefox's "Open Link in New <Container> Tab"
// (#context-openlinkincontainertab) is the plain new-tab row (it replaces
// "Open Link in New Tab"), so it stays, under Open Link in New Tab.
export const ALWAYS_HIDDEN = {
  "#tabContextMenu": ["#context_reopenInContainer"],
  "#contentAreaContextMenu": ["#context-openlinkinusercontext-menu"],
};
const installed = new WeakSet();

// wave9/menus: rows that start off (the user's W9-09/W9-10 answers: "most
// of what I suggested should not be on by default"; containers are picked
// through spaces). prefs/whimsy/whimsy.yaml holds the same lists as the
// defaults of whimsy.menus.hidden.*; someone who had already changed a menu
// gets them added once (DEFAULTS_VERSION), so a new row never just appears.
const DEFAULTS_VERSION_PREF = "whimsy.menus.defaults-version";
const DEFAULTS_VERSION = 2;
export const ADDED_HIDDEN = {
  1: {
    tab: ["tab-volume", "playlist", "copy-markdown"],
    essential: ["tab-volume", "playlist", "copy-markdown"],
    page: ["capture-full-page", "capture-portrait", "wayback", "dev-mode"],
    selection: ["copy-url-quote"],
    space: ["reset-tabs", "show-hidden"],
    sidebar: ["add-finder-folder", "collapse-all-folders", "expand-all-folders"],
    folder: ["collapse-all", "expand-all"],
    "split-row": ["swap-panes", "favorite"],
    // wave10 (W10-56): the pane's ⋯ menu shows Swap Panes after all (the
    // user missed it there), so nothing in it starts off.
  },
  // W10-20: the selection menu's regroup: rows few people use start off
  // (still in Settings → Menus).
  // W10-45: Element Info's row starts off in every menu (the user, applying
  // the W9-09 rule); the command bar and Tools ▸ Browser Tools still have it.
  2: {
    selection: ["search-private", "select-all", "inspect-a11y", "view-source", "element-info"],
    link: ["element-info"],
    page: ["element-info"],
    image: ["element-info"],
    media: ["element-info"],
  },
};

// Every row a menu starts with off, across all ADDED_HIDDEN versions.
export function defaultHiddenIdsFor(menuId) {
  return [...new Set(Object.values(ADDED_HIDDEN).flatMap(added => added[menuId] ?? []))];
}

// The class of the separators the registry order (W10-20) puts between its
// groups, reused from one opening to the next.
export const ORDER_SEP_CLASS = "whimsy-menu-order-sep";

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
  if (c.onTextInput) {
    return null;
  }
  // wave9/menus (design-full-4 L10): a video or audio element's own menu.
  if (c.onVideo || c.onAudio) {
    return "media";
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
  // wave9/menus (W9-09): off by default.
  item("tab-volume", "whimsy-menus-tab-tab-volume", ["context_whimsyTabVolume"]),
  item("playlist", "whimsy-menus-tab-playlist", ["context_whimsyPlaylistSave"]),
  item("snooze", "whimsy-menus-tab-snooze", ["context_whimsySnooze"]),
  SEPARATOR,
  item("essentials", "whimsy-menus-tab-essentials", ["context_zen-add-essential", "context_zen-remove-essential"], {
    altL10n: "whimsy-menus-tab-essentials-alt",
  }),
  // W10-62: an Essential's Show Unread Badge (only Essentials have it).
  item("unread-badge", "whimsy-menus-tab-unread-badge", ["context_whimsyUnreadBadge"]),
  item("rename", "whimsy-menus-tab-rename", ["context_zen-edit-tab-title"]),
  item("change-icon", "whimsy-menus-tab-change-icon", ["context_zen-edit-tab-icon"]),
  SEPARATOR,
  item("pin", "whimsy-menus-tab-pin", [
    "context_pinTab",
    "context_unpinTab",
    "context_pinSelectedTabs",
    "context_unpinSelectedTabs",
  ], { altL10n: "whimsy-menus-tab-pin-alt" }),
  item("unload", "whimsy-menus-tab-unload", ["context_unloadTab"]),
  item("duplicate", "whimsy-menus-tab-duplicate", ["context_duplicateTab", "context_duplicateTabs"]),
  item("copy-links", "whimsy-menus-tab-copy-links", ["context_whimsyCopyLinks"]),
  // wave9/menus (W9-09): off by default.
  item("copy-markdown", "whimsy-menus-tab-copy-markdown", ["context_whimsyCopyLinkMarkdown"]),
  SEPARATOR,
  item("ask-chat", "whimsy-menus-tab-ask-chat", ["context_askChat", "context_askChatSummarize", "context_createAITab"]),
  item("bookmark", "whimsy-menus-tab-bookmark", ["context_bookmarkTab", "context_bookmarkSelectedTabs"]),
  item("watch", "whimsy-menus-tab-watch", ["context_whimsyWatchPage"]),
  // wave9/menus: New Space… is in the Move Tab submenu, first
  // (design-full-4 L10, W9-09). W13 F06: Settings shows it under Move Tab.
  item("move-tab", "whimsy-menus-tab-move-tab", ["context_moveTabOptions"], {
    children: [item("move-to-new-space", "whimsy-menus-tab-move-to-new-space", ["context_whimsyMoveToNewSpace"])],
  }),
  // W11-13 (d13): on by default (the user asked for it in the tab menu);
  // only shown for a private tab.
  item("move-out-of-private", "whimsy-menus-tab-move-out-of-private", ["context_whimsyMoveOutOfPrivate"]),
  item("select-all", "whimsy-menus-tab-select-all", ["context_selectAllTabs"]),
  SEPARATOR,
  // wave9/menus: Firefox's Share ▸ submenu (with the macOS services,
  // WhimsyShareMenu) and its content-sharing row for several tabs.
  bySelector("share", "whimsy-menus-tab-share", ["#context_shareSelectedTabs", ".share-tab-url-item"], {
    altL10n: "whimsy-menus-tab-share-alt",
  }),
  item("send-to-device", "whimsy-menus-tab-send-to-device", ["context_sendTabToDevice"]),
  SEPARATOR,
  item("close", "whimsy-menus-tab-close", ["context_closeTab"]),
  item("archive-below", "whimsy-menus-tab-archive-below", ["context_closeTabsToTheEnd", "context_whimsyArchiveTabsBelow"]),
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
    popup: "#tabContextMenu, #moveTabOptionsMenu",
    when: win => !contextTabIsEssential(win),
    items: TAB_ITEMS,
  },
  {
    id: "essential",
    l10n: "whimsy-menus-essential",
    popup: "#tabContextMenu, #moveTabOptionsMenu",
    when: contextTabIsEssential,
    items: TAB_ITEMS,
  },
  {
    id: "link",
    l10n: "whimsy-menus-link",
    popup: "#contentAreaContextMenu",
    when: win => contentContext(win) == "link",
    items: [
      item("open-in-tab", "whimsy-menus-link-open-in-tab", [
        "context-openlinkintab",
        "context-openlinkincontainertab",
        "context-openlinkincurrent",
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
      item("copy-email", "whimsy-menus-link-copy-email", ["context-copyemail", "context-copyphone"], {
        altL10n: "whimsy-menus-link-copy-email-alt",
      }),
      item("copy", "whimsy-menus-link-copy", ["context-copylink"]),
      item("copy-clean", "whimsy-menus-link-copy-clean", ["context-stripOnShareLink"]),
      // wave9/menus (design-full-4 L10): on a link to a video or audio file.
      item("playlist", "whimsy-menus-media-playlist", ["context-whimsy-save-playlist"]),
      SEPARATOR,
      item("send-to-device", "whimsy-menus-link-send-to-device", ["context-sendlinktodevice"]),
      SEPARATOR,
      item("inspect", "whimsy-menus-inspect", ["context-inspect"]),
      // W10-45: Element Info, beside Inspect.
      item("element-info", "whimsy-menus-element-info", ["context-whimsy-element-info"]),
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
      // wave9/menus (W9-09): shows only on pages that block copying.
      item("allow-copy", "whimsy-menus-page-allow-copy", ["context-whimsy-allow-copy"]),
      SEPARATOR,
      item("screenshot", "whimsy-menus-page-screenshot", ["context-take-screenshot"]),
      // wave9/menus (W9-09): off by default.
      item("capture-full-page", "whimsy-menus-page-capture-full-page", ["context-whimsy-capture-full-page"]),
      item("capture-portrait", "whimsy-menus-page-capture-portrait", ["context-whimsy-capture-portrait"]),
      item("edit-text", "whimsy-menus-page-edit-text", ["context-whimsy-edit-page"]),
      SEPARATOR,
      item("send-to-device", "whimsy-menus-page-send-to-device", ["context-sendpagetodevice"]),
      item("wayback", "whimsy-menus-page-wayback", ["context-whimsy-wayback"]),
      item("view-source", "whimsy-menus-page-view-source", ["context-viewsource"]),
      item("dev-mode", "whimsy-menus-page-dev-mode", ["context-whimsy-dev-mode"]),
      item("inspect-a11y", "whimsy-menus-inspect-a11y", ["context-inspect-a11y"]),
      item("inspect", "whimsy-menus-inspect", ["context-inspect"]),
      // W10-45: Element Info, beside Inspect.
      item("element-info", "whimsy-menus-element-info", ["context-whimsy-element-info"]),
    ],
  },
  {
    id: "selection",
    l10n: "whimsy-menus-selection",
    popup: "#contentAreaContextMenu",
    when: win => contentContext(win) == "selection",
    // W10-20: the selection menu shows its rows in this order (Arc's: search
    // first, then copy, then actions, print, developer rows). Firefox's own
    // DOM order is restored when the menu closes, so the page, link and
    // image menus keep theirs. Rows not listed here (extensions, Firefox
    // additions) keep their relative order after Print.
    order: "registry",
    extrasAfter: "print",
    items: [
      item("search", "whimsy-menus-selection-search", ["context-searchselect"]),
      item("translate", "whimsy-menus-selection-translate", ["context-translate-selection"], {
        hintL10n: "whimsy-menus-hint-translate",
      }),
      // W10-20: off by default.
      item("search-private", "whimsy-menus-selection-search-private", ["context-searchselect-private"]),
      SEPARATOR,
      item("copy", "whimsy-menus-selection-copy", ["context-copy"]),
      item("copy-highlight", "whimsy-menus-selection-copy-highlight", [
        "context-copy-link-to-highlight",
        "context-copy-clean-link-to-highlight",
      ]),
      item("copy-markdown", "whimsy-menus-selection-copy-markdown", ["context-whimsy-copy-markdown"]),
      // wave9/menus (W9-09): off by default.
      item("copy-url-quote", "whimsy-menus-selection-copy-url-quote", ["context-whimsy-copy-url-quote"]),
      // W10-20: off by default.
      item("select-all", "whimsy-menus-select-all", ["context-selectall"]),
      SEPARATOR,
      item("note", "whimsy-menus-selection-note", ["context-whimsy-verb-note"]),
      // W10-20: Quick Actions ▸ (macOS's own name for "do this in another
      // app"), with each row naming the app. WhimsyVerbs builds it; a
      // child's switch is its own id in this menu's pref, so prefs written
      // before the submenu keep working. With one row available it shows
      // as that row (context-whimsy-quick-action-solo), never a one-row
      // submenu; with none it hides.
      item("quick-actions", "whimsy-menus-selection-quick-actions", [
        "context-whimsy-quick-actions",
        "context-whimsy-quick-action-solo",
      ], {
        children: [
          item("calendar", "whimsy-menus-selection-calendar", ["context-whimsy-verb-calendar"], {
            hintL10n: "whimsy-menus-hint-date",
          }),
          item("map", "whimsy-menus-selection-map", ["context-whimsy-verb-map"]),
          item("email", "whimsy-menus-selection-email", ["context-whimsy-verb-email"], { l10nArgs: "mail-app" }),
          SEPARATOR,
          item("linear-new", "whimsy-menus-selection-linear-new", ["context-whimsy-verb-linear-new"], {
            hintL10n: "whimsy-menus-hint-linear",
          }),
          item("linear-search", "whimsy-menus-selection-linear-search", ["context-whimsy-verb-linear-search"], {
            hintL10n: "whimsy-menus-hint-linear",
          }),
        ],
      }),
      SEPARATOR,
      item("print", "whimsy-menus-selection-print", ["context-print-selection"]),
      SEPARATOR,
      item("inspect-font", "whimsy-menus-selection-inspect-font", ["context-whimsy-inspect-font"]),
      item("inspect", "whimsy-menus-inspect", ["context-inspect"]),
      // W10-20: off by default.
      item("inspect-a11y", "whimsy-menus-inspect-a11y", ["context-inspect-a11y"]),
      item("view-source", "whimsy-menus-selection-view-source", ["context-viewpartialsource-selection"]),
      // W10-45: Element Info, beside Inspect.
      item("element-info", "whimsy-menus-element-info", ["context-whimsy-element-info"]),
    ],
  },
  {
    id: "image",
    l10n: "whimsy-menus-image",
    popup: "#contentAreaContextMenu",
    when: win => contentContext(win) == "image",
    items: [
      item("open-link-in-tab", "whimsy-menus-link-open-in-tab", [
        "context-openlinkintab",
        "context-openlinkincontainertab",
        "context-openlinkincurrent",
      ]),
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
      // W10-45: Element Info, beside Inspect.
      item("element-info", "whimsy-menus-element-info", ["context-whimsy-element-info"]),
    ],
  },
  {
    // wave9/menus (design-full-4 L10): a video's or audio's own menu.
    id: "media",
    l10n: "whimsy-menus-media",
    popup: "#contentAreaContextMenu",
    when: win => contentContext(win) == "media",
    items: [
      item("play", "whimsy-menus-media-play", ["context-media-play", "context-media-pause"], { altL10n: "whimsy-menus-media-play-alt" }),
      item("mute", "whimsy-menus-media-mute", ["context-media-mute", "context-media-unmute"], { altL10n: "whimsy-menus-media-mute-alt" }),
      item("speed", "whimsy-menus-media-speed", ["context-media-playbackrate"]),
      item("loop", "whimsy-menus-media-loop", ["context-media-loop"]),
      item("fullscreen", "whimsy-menus-media-fullscreen", ["context-video-fullscreen"]),
      item("controls", "whimsy-menus-media-controls", ["context-media-hidecontrols", "context-media-showcontrols"], { altL10n: "whimsy-menus-media-controls-alt" }),
      SEPARATOR,
      item("view", "whimsy-menus-media-view", ["context-viewvideo"]),
      item("pip", "whimsy-menus-media-pip", ["context-video-pictureinpicture"]),
      item("playlist", "whimsy-menus-media-playlist", ["context-whimsy-save-playlist"]),
      SEPARATOR,
      item("save-frame", "whimsy-menus-media-save-frame", ["context-video-saveimage"]),
      item("save", "whimsy-menus-media-save", ["context-savevideo", "context-saveaudio"], { altL10n: "whimsy-menus-media-save-alt" }),
      item("copy-link", "whimsy-menus-media-copy-link", ["context-copyvideourl", "context-copyaudiourl"], { altL10n: "whimsy-menus-media-copy-link-alt" }),
      item("email", "whimsy-menus-media-email", ["context-sendvideo", "context-sendaudio"], { altL10n: "whimsy-menus-media-email-alt" }),
      SEPARATOR,
      item("inspect", "whimsy-menus-inspect", ["context-inspect"]),
      // W10-45: Element Info, beside Inspect.
      item("element-info", "whimsy-menus-element-info", ["context-whimsy-element-info"]),
    ],
  },
  {
    id: "space",
    l10n: "whimsy-menus-space",
    // wave9/menus: and its Profile ▸ submenu.
    popup: "#zenWorkspaceMoreActions, #context_zenWorkspacesOpenInContainerTab > menupopup",
    // In WhimsySpaceMenu's order.
    items: [
      item("rename", "whimsy-menus-space-rename", ["context_zenEditWorkspace"]),
      item("change-icon", "whimsy-menus-space-change-icon", ["context_zenEditWorkspaceIcon"]),
      item("edit-theme", "whimsy-menus-space-edit-theme", ["context_zenChangeWorkspaceTheme"]),
      item("look", "whimsy-menus-space-look", ["whimsy-space-look-menuitem"]),
      // wave9/menus (design-full-4 L10): Profile ▸ Create a New Profile….
      // W13 F06: Settings shows it under Profile.
      item("profile", "whimsy-menus-space-profile", ["context_zenWorkspacesOpenInContainerTab"], {
        children: [bySelector("new-profile", "whimsy-menus-space-new-profile", ["[data-whimsy-create-profile]"])],
      }),
      SEPARATOR,
      bySelector("new-space", "whimsy-menus-space-new", [
        '#zenWorkspaceMoreActions > menuitem[command="cmd_zenOpenWorkspaceCreation"]',
      ]),
      item("manage", "whimsy-menus-space-manage", ["context_zenManageWorkspaces"]),
      item("routing", "whimsy-menus-space-routing", ["context_zenSpaceRoutingSettings"]),
      SEPARATOR,
      item("unload", "whimsy-menus-space-unload", ["context_zenUnloadWorkspace"]),
      item("unload-others", "whimsy-menus-space-unload-others", ["context_zenUnloadAllOtherWorkspace"]),
      // wave9/menus (W9-09): off by default.
      item("reset-tabs", "whimsy-menus-space-reset-tabs", ["whimsy-reset-space-tabs-menuitem"]),
      item("share", "whimsy-menus-space-share", ["context_zenShareWorkspace"]),
      SEPARATOR,
      item("lock", "whimsy-menus-space-lock", ["whimsy-lock-space-menuitem"]),
      item("hide", "whimsy-menus-space-hide", ["whimsy-hide-space-menuitem"]),
      item("show-hidden", "whimsy-menus-space-show-hidden", ["whimsy-show-hidden-spaces-menuitem"]),
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
      // W13 F06: the kinds are Live Folder's submenu; Settings shows them
      // under it.
      item("new-live-folder", "whimsy-menus-sidebar-new-live-folder", ["zen-panel-ui-live-folder-create"], {
        children: [
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
      }),
      SEPARATOR,
      // wave9/menus (W9-09): off by default.
      item("add-finder-folder", "whimsy-menus-sidebar-add-finder-folder", ["whimsy-sidebar-add-finder-folder"]),
      item("collapse-all-folders", "whimsy-menus-sidebar-collapse-all-folders", ["whimsy-sidebar-collapse-all-folders"]),
      item("expand-all-folders", "whimsy-menus-sidebar-expand-all-folders", ["whimsy-sidebar-expand-all-folders"]),
    ],
  },
  {
    id: "folder",
    l10n: "whimsy-menus-folder",
    popup: "#zenFolderActions, #context_zenLiveFolderOptions > menupopup",
    items: [
      // wave9/menus (design-full-4 L10): a live folder's Live Folder
      // Options ▸ Resync. W13 F06: Settings shows it under its submenu.
      item("live-options", "whimsy-menus-folder-live-options", ["context_zenLiveFolderOptions"], {
        children: [bySelector("live-resync", "whimsy-menus-folder-live-resync", ['menuitem[option-key="whimsyResync"]'])],
      }),
      SEPARATOR,
      item("rename", "whimsy-menus-folder-rename", ["context_zenFolderRename"]),
      item("change-icon", "whimsy-menus-folder-change-icon", ["context_zenFolderChangeIcon"]),
      item("color", "whimsy-menus-folder-color", ["context_whimsyFolderColor"]),
      SEPARATOR,
      item("unload", "whimsy-menus-folder-unload", ["context_zenFolderUnloadAll"]),
      item("new-subfolder", "whimsy-menus-folder-new-subfolder", ["context_zenFolderNewSubfolder"]),
      // wave9/menus (W9-09): off by default.
      item("collapse-all", "whimsy-menus-folder-collapse-all", ["whimsy-folder-collapse-all-folders"]),
      item("expand-all", "whimsy-menus-folder-expand-all", ["whimsy-folder-expand-all-folders"]),
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
      // wave9/menus (W9-09): off by default.
      item("swap-panes", "whimsy-menus-split-swap-panes", ["whimsySplitRow-swapPanes"]),
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
      item("favorite", "whimsy-menus-split-row-favorite", ["whimsySplitRow-favorite"]),
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
      // wave9/menus (W9-09) had it off by default; wave10 (W10-56) shows it.
      item("swap-panes", "whimsy-menus-split-swap-panes", ["whimsySplitPane-swapPanes"]),
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

  // The menu's items in order, without the grouping separators. A
  // submenu's rows (W10-20, `children`) follow their parent.
  items(menuId) {
    return (this.menu(menuId)?.items ?? [])
      .filter(entry => entry != SEPARATOR)
      .flatMap(entry => [entry, ...(entry.children ?? []).filter(child => child != SEPARATOR)]);
  },

  // Only the rows the menu itself shows (not a submenu's).
  topItems(menuId) {
    return (this.menu(menuId)?.items ?? []).filter(entry => entry != SEPARATOR);
  },

  // The submenu row `itemId` belongs to, if any.
  parentOf(menuId, itemId) {
    return this.topItems(menuId).find(entry => entry.children?.some(child => child != SEPARATOR && child.id == itemId)) ?? null;
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
    this.writeHidden(menuId, ids);
  },

  // The ids hidden by default (the pref's default value).
  defaultHiddenIds(menuId) {
    const value = Services.prefs.getDefaultBranch("").getStringPref(this.prefName(menuId), "");
    return new Set(
      value
        .split(",")
        .map(id => id.trim())
        .filter(Boolean)
    );
  },

  // wave9/menus: once, a menu someone already changed also hides the rows
  // added since, off by default. Untouched menus follow the defaults anyway.
  migrateDefaults() {
    const from = Services.prefs.getIntPref(DEFAULTS_VERSION_PREF, 0);
    if (from >= DEFAULTS_VERSION) {
      return;
    }
    for (let version = from + 1; version <= DEFAULTS_VERSION; version++) {
      for (const [menuId, added] of Object.entries(ADDED_HIDDEN[version] ?? {})) {
        if (!Services.prefs.prefHasUserValue(this.prefName(menuId))) {
          continue;
        }
        const ids = this.hiddenIds(menuId);
        for (const id of added) {
          ids.add(id);
        }
        this.writeHidden(menuId, ids);
      }
    }
    Services.prefs.setIntPref(DEFAULTS_VERSION_PREF, DEFAULTS_VERSION);
  },

  writeHidden(menuId, ids) {
    const order = this.items(menuId).map(entry => entry.id);
    const sorted = [...ids].sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia == -1 ? Infinity : ia) - (ib == -1 ? Infinity : ib);
    });
    const name = this.prefName(menuId);
    const value = sorted.join(",");
    const defaults = this.defaultHiddenIds(menuId);
    if (defaults.size == ids.size && [...ids].every(id => defaults.has(id))) {
      Services.prefs.clearUserPref(name);
    } else {
      Services.prefs.setStringPref(name, value);
    }
  },

  // Restore Defaults: back to the pref's default (prefs/whimsy/whimsy.yaml):
  // every item shown except the ones that start off (ADDED_HIDDEN).
  restoreDefaults(menuId) {
    Services.prefs.clearUserPref(this.prefName(menuId));
  },

  isDefault(menuId) {
    return !Services.prefs.prefHasUserValue(this.prefName(menuId));
  },

  // Every row of the menu is off (a submenu's rows don't count: with its
  // parent off, they can't show anyway).
  allHidden(menuId) {
    const hidden = this.hiddenIds(menuId);
    const items = this.topItems(menuId);
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
    try {
      this.migrateDefaults();
    } catch (e) {
      console.error("Whimsy: menu defaults", e);
    }
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
    this.clearMarks(popup);
    if (!this.enabled) {
      return;
    }
    if (this.hideAlways(win, popup)) {
      this.collapseSeparators(win, popup);
    }
    const menu = menus.find(candidate => !candidate.when || candidate.when(win));
    if (!menu) {
      return;
    }
    if (this.apply(win, popup, menu.id) && !this.hasVisibleItem(win, popup)) {
      // Every row is off: no empty menu.
      event.preventDefault();
      return;
    }
    if (menu.order == "registry") {
      this.reorder(win, popup, menu);
    }
  },

  // W10-20: shows the visible rows of `popup` in the registry's order, with
  // one separator between groups. The moves are logged and undone when the
  // menu closes (restoreOrder), so other menus sharing the popup (the page,
  // link and image menus share #contentAreaContextMenu) keep Firefox's
  // order. Native NSMenus are built after popupshowing, so they show the
  // moved order.
  reorder(win, popup, menu) {
    this.restoreOrder(popup);
    const log = [];
    const move = node => {
      log.push({ node, prev: node.previousElementSibling, next: node.nextElementSibling });
      popup.append(node);
    };
    const rows = [...popup.children].filter(
      node => !isSeparator(node) && this.visible(win, node)
    );
    const used = new Set();
    const groups = [[]];
    let extrasGroup = -1;
    for (const entry of menu.items) {
      if (entry == SEPARATOR) {
        groups.push([]);
        continue;
      }
      for (const node of rows) {
        if (!used.has(node) && entry.selectors.some(selector => node.matches(selector))) {
          groups.at(-1).push(node);
          used.add(node);
        }
      }
      if (entry.id == menu.extrasAfter) {
        extrasGroup = groups.length - 1;
      }
    }
    const extras = rows.filter(node => !used.has(node));
    if (extras.length) {
      groups.splice(extrasGroup == -1 ? groups.length : extrasGroup + 1, 0, extras);
    }
    // Firefox's separators sit between its own groups; ours replace them.
    for (const node of popup.children) {
      if (isSeparator(node) && !node.classList.contains(ORDER_SEP_CLASS) && this.visible(win, node)) {
        this.hideRow(node);
      }
    }
    const spare = [...popup.querySelectorAll(`:scope > menuseparator.${ORDER_SEP_CLASS}`)];
    let first = true;
    for (const group of groups.filter(g => g.length)) {
      if (!first) {
        let separator = spare.shift();
        if (!separator) {
          separator = win.document.createXULElement("menuseparator");
          separator.classList.add(ORDER_SEP_CLASS);
        }
        separator.hidden = false;
        popup.append(separator);
      }
      first = false;
      for (const node of group) {
        move(node);
      }
    }
    for (const separator of spare) {
      separator.hidden = true;
    }
    popup._whimsyOrderLog = log;
    if (!popup._whimsyOrderRestore) {
      popup._whimsyOrderRestore = event => {
        if (event.target == popup) {
          this.restoreOrder(popup);
        }
      };
      popup.addEventListener("popuphidden", popup._whimsyOrderRestore);
    }
  },

  // Puts every row reorder() moved back where Firefox had it, newest move
  // first. A row's old neighbour may be gone (an extension's rows are
  // removed when the menu closes); then its other neighbour, or the end.
  restoreOrder(popup) {
    const log = popup._whimsyOrderLog;
    if (!log) {
      return;
    }
    popup._whimsyOrderLog = null;
    for (const { node, prev, next } of log.reverse()) {
      if (node.parentNode != popup) {
        continue;
      }
      if (next && next != node && next.parentNode == popup) {
        popup.insertBefore(node, next);
      } else if (prev && prev != node && prev.parentNode == popup) {
        prev.after(node);
      } else {
        popup.append(node);
      }
    }
    for (const separator of popup.querySelectorAll(`:scope > menuseparator.${ORDER_SEP_CLASS}`)) {
      separator.hidden = true;
    }
  },

  // Applies Settings → Menus again to a popup whose rows changed after its
  // popupshowing (WhimsyMenuParity adds rows to the split menus, which are
  // built on first use, once their popup exists).
  refresh(win, popup) {
    if (!this.enabled || popup?.localName != "menupopup") {
      return;
    }
    const menu = MENUS.filter(m => popup.matches(m.popup)).find(m => !m.when || m.when(win));
    if (menu) {
      this.apply(win, popup, menu.id);
    }
  },

  // W10-42: ALWAYS_HIDDEN's rows. Returns whether one that would have
  // shown was hidden.
  hideAlways(win, popup) {
    const selectors = Object.entries(ALWAYS_HIDDEN)
      .filter(([popupSelector]) => popup.matches(popupSelector))
      .flatMap(([, rows]) => rows);
    let changed = false;
    for (const node of popup.children) {
      if (!selectors.some(selector => node.matches(selector))) {
        continue;
      }
      if (this.visible(win, node)) {
        changed = true;
      }
      this.hideRow(node);
    }
    return changed;
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
      this.hideRow(node);
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
          this.hideRow(node);
        } else {
          afterSeparator = true;
          trailing = node;
        }
      } else {
        afterSeparator = false;
        trailing = null;
      }
    }
    if (trailing) {
      this.hideRow(trailing);
    }
  },

  // Hides a row the way a native menu sees: collapsed="true". A row that
  // was already collapsed by someone else stays theirs to clear.
  hideRow(node) {
    if (!node.hasAttribute(HIDDEN_ATTR) && node.getAttribute("collapsed") != "true") {
      node.setAttribute(COLLAPSED_ATTR, "true");
      node.setAttribute("collapsed", "true");
    }
    node.setAttribute(HIDDEN_ATTR, "true");
  },

  // Undoes last time's hideRow on every row of `popup`.
  clearMarks(popup) {
    for (const node of popup.querySelectorAll(`:scope > [${HIDDEN_ATTR}], :scope > [${COLLAPSED_ATTR}]`)) {
      if (node.hasAttribute(COLLAPSED_ATTR)) {
        node.removeAttribute(COLLAPSED_ATTR);
        node.removeAttribute("collapsed");
      }
      node.removeAttribute(HIDDEN_ATTR);
    }
  },

  hasVisibleItem(win, popup) {
    return [...popup.children].some(node => !isSeparator(node) && this.visible(win, node));
  },
};
