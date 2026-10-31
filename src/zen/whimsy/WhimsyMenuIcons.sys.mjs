/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave7/menus2: menu icons, macOS 26 style, as an option (Settings → Look
// and Feel → "Show icons in right-click menus", whimsy.look.menu-icons,
// off by default; Arc's own menus are text-only).
//
// macOS 26 (Tahoe) puts an SF Symbol beside the items of Apple's own
// menus, Safari's right-click menus included. Apple's guidance for it
// (HIG, Menus): an icon only where it clearly says what the item does,
// and consistently: a section that uses icons uses them on every item, or
// keeps the ones with icons together, so the text column never jumps
// between an indented row and a flush one. So, when the option is on:
//
// - every item of the tab menu and the page, link, selection, image and
//   media menus that has a clear symbol gets one, Zen's and Whimsy's rows
//   included (ICONS: Zen's monochrome set, the closest thing to SF
//   Symbols it ships);
// - in a section (between two visible separators) that still mixes rows
//   with and without one (checkboxes, "Select All", extension rows), the
//   rows with an icon move to the top while the menu is open, and go back
//   to their own places when it closes, so nothing else about the order
//   changes.
//
// When it's off, no row of those menus shows an icon: whimsy-browser.css
// also blanks the few Firefox draws itself there. Submenus keep the icons
// that identify their rows (space emoji, container and tab group colors),
// and extension rows keep theirs, as in Arc.

const FEATURE_PREF = "whimsy.feature.menu-icons";
const OPTION_PREF = "whimsy.look.menu-icons";
const POPUP_IDS = ["tabContextMenu", "contentAreaContextMenu"];
export const ICON_ATTR = "whimsy-menu-icon";
const ICON_VAR = "--whimsy-menu-icon";

const ZEN = name => `chrome://browser/skin/zen-icons/${name}.svg`;
const SELECTABLE = name => `chrome://browser/skin/zen-icons/selectable/${name}.svg`;

// Row id → icon. A function gets the window, for rows whose icon follows
// their state (Mute/Unmute, a starred page).
const ICONS = {
  // --- Tab menu ---
  context_openANewTab: ZEN("plus"),
  context_moveTabToNewGroup: ZEN("folder"),
  context_moveSplitViewToNewGroup: ZEN("folder"),
  context_moveTabToGroup: ZEN("folder"),
  context_ungroupTab: ZEN("folder"),
  context_zenMoveToFolder: ZEN("folder"),
  context_whimsyGroupByDomain: ZEN("folder"),
  context_moveTabToSplitView: ZEN("split"),
  context_separateSplitView: ZEN("split"),
  context_reverseSplitView: ZEN("split"),
  context_zenSplitTabs: ZEN("split"),
  context_zenShareSplitView: ZEN("share"),
  context_whimsyFollowerSplit: ZEN("split"),
  context_reloadTab: ZEN("reload"),
  context_reloadSelectedTabs: ZEN("reload"),
  context_playTab: ZEN("media-play"),
  context_playSelectedTabs: ZEN("media-play"),
  context_toggleMuteTab: win => (win.TabContextMenu?.contextTab?.muted ? ZEN("media-unmute") : ZEN("media-mute")),
  context_toggleMuteSelectedTabs: win =>
    win.TabContextMenu?.contextTab?.muted ? ZEN("media-unmute") : ZEN("media-mute"),
  context_whimsyMuteSite: SELECTABLE("globe"),
  context_whimsySnooze: SELECTABLE("time"),
  context_pinTab: ZEN("pin"),
  context_pinSelectedTabs: ZEN("pin"),
  context_unpinTab: ZEN("unpin"),
  context_unpinSelectedTabs: ZEN("unpin"),
  "context_zen-add-essential": ZEN("essential-add"),
  "context_zen-remove-essential": ZEN("essential-remove"),
  "context_zen-edit-pinned-page": ZEN("sliders"),
  "context_zen-reset-pinned-tab": ZEN("u-turn-to-left"),
  "context_zen-edit-tab-title": ZEN("text-title-case"),
  "context_zen-edit-tab-icon": ZEN("face-sun"),
  "context_zen-add-domain-to-routing": ZEN("algorithm"),
  context_unloadTab: SELECTABLE("moon"),
  context_duplicateTab: ZEN("duplicate-tab"),
  context_duplicateTabs: ZEN("duplicate-tab"),
  context_askChat: ZEN("sparkles"),
  context_askChatSummarize: ZEN("sparkles"),
  context_createAITab: ZEN("sparkles"),
  context_bookmarkTab: ZEN("bookmark-hollow"),
  context_bookmarkSelectedTabs: ZEN("bookmark-hollow"),
  context_whimsyCopyLinks: ZEN("link"),
  context_whimsyWatchPage: SELECTABLE("bell"),
  context_moveTabOptions: ZEN("move-cursor"),
  context_reopenInContainer: ZEN("container-tab"),
  context_selectAllTabs: SELECTABLE("checkbox"),
  context_shareSelectedTabs: ZEN("share"),
  context_sendTabToDevice: ZEN("send-to-device"),
  // An archive box where the row says Archive Tab (WhimsyArchiveMenu).
  context_closeTab: win =>
    win.document.getElementById("context_closeTab")?.getAttribute("data-l10n-id")?.startsWith("whimsy-")
      ? SELECTABLE("inbox")
      : ZEN("close"),
  context_whimsyArchiveTabsBelow: ZEN("arrow-down"),
  context_closeDuplicateTabs: ZEN("duplicate-tab"),
  context_closeTabOptions: ZEN("close"),
  context_undoCloseTab: ZEN("history"),

  // --- Page ---
  "context-back": ZEN("back"),
  "context-forward": ZEN("forward"),
  "context-reload": ZEN("reload"),
  "context-stop": ZEN("close"),
  "context-bookmarkpage": win =>
    win.document.getElementById("context-bookmarkpage")?.hasAttribute("starred")
      ? ZEN("bookmark")
      : ZEN("bookmark-hollow"),
  "context-savepage": ZEN("save"),
  "context-whimsy-qrcode": "chrome://browser/content/sharing/qr-code.svg",
  "context-whimsy-copy-markdown": ZEN("edit-copy"),
  "context-take-screenshot": ZEN("screenshot"),
  "context-use-mini-window": ZEN("window"),
  "context-whimsy-edit-page": ZEN("signature"),
  "context-viewsource": ZEN("brackets-curly"),
  "context-viewpartialsource-selection": ZEN("brackets-curly"),
  "context-inspect": ZEN("developer"),
  "context-inspect-a11y": ZEN("developer"),
  "context-sendpagetodevice": ZEN("send-to-device"),
  "context-media-eme-learnmore": ZEN("help"),
  "context-setDesktopBackground": ZEN("screen"),

  // --- Link ---
  "context-openlinkincurrent": ZEN("open"),
  "context-openlinkincontainertab": ZEN("container-tab"),
  "context-openlinkintab": ZEN("plus"),
  "context-zenOpenLinkInGlance": SELECTABLE("eye"),
  "context-zenSplitLink": ZEN("split"),
  "context-openlinkinsplitview": ZEN("split"),
  "context-whimsyOpenLinkInSpace": SELECTABLE("layers"),
  "context-openlinkinusercontext-menu": ZEN("container-tab"),
  "context-openlink": ZEN("window"),
  "context-openlinkprivate": ZEN("private-window"),
  "context-openlinksmartwindow": ZEN("sparkles"),
  "context-previewlink": SELECTABLE("eye"),
  "context-bookmarklink": ZEN("bookmark-hollow"),
  "context-savelink": ZEN("downloads"),
  "context-copyemail": ZEN("mail"),
  "context-copyphone": SELECTABLE("call"),
  "context-copylink": ZEN("link"),
  "context-stripOnShareLink": ZEN("link"),
  "context-sendlinktodevice": ZEN("send-to-device"),

  // --- Media ---
  "context-media-play": ZEN("media-play"),
  "context-media-pause": ZEN("media-pause"),
  "context-media-mute": ZEN("media-mute"),
  "context-media-unmute": ZEN("media-unmute"),
  "context-media-playbackrate": SELECTABLE("lightning"),
  "context-leave-dom-fullscreen": ZEN("fullscreen-exit"),
  "context-video-fullscreen": ZEN("fullscreen"),
  "context-media-hidecontrols": ZEN("sliders"),
  "context-media-showcontrols": ZEN("sliders"),
  "context-viewvideo": ZEN("open"),
  "context-video-pictureinpicture": ZEN("popup"),
  "context-whimsy-save-playlist": SELECTABLE("music"),

  // --- Image ---
  "context-reloadimage": ZEN("reload"),
  "context-viewimage": ZEN("open"),
  "context-saveimage": ZEN("save"),
  "context-video-saveimage": ZEN("screenshot"),
  "context-savevideo": ZEN("save"),
  "context-saveaudio": ZEN("save"),
  "context-copyimage-contents": ZEN("edit-copy"),
  "context-copyimage": ZEN("link"),
  "context-copyvideourl": ZEN("link"),
  "context-copyaudiourl": ZEN("link"),
  "context-sendimage": ZEN("mail"),
  "context-sendvideo": ZEN("mail"),
  "context-sendaudio": ZEN("mail"),
  "context-imagetext": ZEN("text-size"),
  "context-viewimageinfo": ZEN("info"),
  "context-viewimagedesc": ZEN("info"),
  "context-visual-search": ZEN("search-glass"),

  // --- Logins ---
  "fill-login": ZEN("passwords"),
  "fill-login-generated-password": ZEN("wand-sparkle"),
  "use-relay-mask": ZEN("mail"),
  "manage-saved-logins": ZEN("settings"),

  // --- Selection and editing ---
  "context-undo": ZEN("arrow-rotate-anticlockwise"),
  "context-redo": ZEN("reload"),
  "context-cut": ZEN("edit-cut"),
  "context-copy": ZEN("edit-copy"),
  "context-paste": ZEN("edit-paste"),
  "context-paste-no-formatting": ZEN("edit-paste"),
  "context-delete": ZEN("trash"),
  "context-selectall": SELECTABLE("checkbox"),
  "context-print-selection": ZEN("print"),
  "context-whimsy-verb-map": ZEN("geo"),
  "context-whimsy-verb-email": ZEN("mail"),
  "context-whimsy-verb-note": ZEN("reader-mode"),
  "context-whimsy-verb-calendar": ZEN("history"),
  "context-whimsy-verb-linear-new": ZEN("plus"),
  "context-whimsy-verb-linear-search": ZEN("search-page"),
  "context-copy-link-to-highlight": ZEN("link"),
  "context-copy-clean-link-to-highlight": ZEN("link"),
  "context-remove-highlight": ZEN("close"),
  "context-pdfjs-undo": ZEN("arrow-rotate-anticlockwise"),
  "context-pdfjs-redo": ZEN("reload"),
  "context-pdfjs-cut": ZEN("edit-cut"),
  "context-pdfjs-copy": ZEN("edit-copy"),
  "context-pdfjs-paste": ZEN("edit-paste"),
  "context-pdfjs-delete": ZEN("trash"),
  "context-pdfjs-select-all": SELECTABLE("checkbox"),
  "context-add-engine": ZEN("search-glass"),
  "context-searchselect": ZEN("search-glass"),
  "context-searchselect-private": ZEN("private-window"),
  "context-translate-selection": ZEN("translations"),
  "context-ask-chat": ZEN("sparkles"),
  "context-create-aitab": ZEN("sparkles"),
};

function shown(node) {
  return !node.hidden && node.getAttribute("hidden") != "true" && !node.collapsed;
}

// A row draws an icon: one of ours (not on a checkbox or radio row, which
// show a checkmark instead), or one it brings itself (an extension's).
export function hasIcon(node) {
  if (!["menuitem", "menu"].includes(node.localName)) {
    return false;
  }
  if (["checkbox", "radio"].includes(node.getAttribute("type"))) {
    return false;
  }
  return node.hasAttribute(ICON_ATTR) || node.hasAttribute("image");
}

export const WhimsyMenuIcons = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true) && Services.prefs.getBoolPref(OPTION_PREF, false);
  },

  initWindow(win) {
    const popups = POPUP_IDS.map(id => win.document.getElementById(id)).filter(Boolean);
    const onShowing = event => {
      if (popups.includes(event.target)) {
        try {
          this.restore(event.target);
          if (this.enabled) {
            this.apply(win, event.target);
          }
        } catch (e) {
          console.error("Whimsy: menu icons", e);
        }
      }
    };
    const onHidden = event => {
      if (popups.includes(event.target)) {
        try {
          this.restore(event.target);
        } catch (e) {
          console.error("Whimsy: menu icons restore", e);
        }
      }
    };
    win.addEventListener("popupshowing", onShowing);
    win.addEventListener("popuphidden", onHidden);
    win.addEventListener(
      "unload",
      () => {
        win.removeEventListener("popupshowing", onShowing);
        win.removeEventListener("popuphidden", onHidden);
      },
      { once: true }
    );
  },

  iconFor(win, id) {
    const icon = ICONS[id];
    return typeof icon == "function" ? icon(win) : icon;
  },

  apply(win, popup) {
    for (const node of popup.children) {
      const icon = node.id && this.iconFor(win, node.id);
      if (icon) {
        node.setAttribute(ICON_ATTR, "true");
        node.style.setProperty(ICON_VAR, `url("${icon}")`);
      }
    }
    this.arrange(popup);
  },

  // Each section between visible separators: rows with an icon first, the
  // rest after them in their own order. Hidden rows and hidden separators
  // ride along with the rows they sit among.
  arrange(popup) {
    const children = [...popup.children];
    const sections = [[]];
    for (const node of children) {
      if (node.localName == "menuseparator" && shown(node)) {
        sections.push([node], []);
      } else {
        sections.at(-1).push(node);
      }
    }
    const order = sections.flatMap(section => {
      const first = section.filter(node => shown(node) && hasIcon(node));
      return [...first, ...section.filter(node => !first.includes(node))];
    });
    if (order.every((node, i) => children[i] == node)) {
      return;
    }
    popup._whimsyMenuOrder = children;
    popup.append(...order);
  },

  // The menu's own order back, with any row added while it was open left
  // after the row it followed.
  restore(popup) {
    const original = popup._whimsyMenuOrder;
    if (!original) {
      return;
    }
    delete popup._whimsyMenuOrder;
    const known = new Set(original);
    const children = [...popup.children];
    const added = children.filter(node => !known.has(node));
    const order = original.filter(node => node.parentNode == popup);
    for (const node of added) {
      const before = node.previousElementSibling;
      const at = before ? order.indexOf(before) : -1;
      order.splice(at + 1, 0, node);
    }
    if (!order.every((node, i) => children[i] == node)) {
      popup.append(...order);
    }
  },
};
