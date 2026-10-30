/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave6/parity: Arc's menu bar (arc-ref/menus2.txt), on top of Firefox's
// and Zen's menus. Every item runs a registered command (WhimsyCommands)
// or Zen's/Firefox's own, so the menu, the command bar and about:keyboard
// share one name and one shortcut. Nothing of Firefox's or Zen's is
// removed; Arc's names replace Zen's in the menu bar only.
//
// - File: "Blank Window" (Zen's New Blank Window), Capture..., Capture
//   Full Page, Capture in Portrait Mode before Save Page As.
// - Edit: Undo names what Cmd+Z will undo ("Undo Archive Tab") while the
//   tab-action undo (WhimsyUndo) has it, and runs that undo.
// - View: Hide Sidebar / Show Sidebar (Zen's compact mode, Cmd+S) and
//   Show Toolbar / Hide Toolbar (Zen's single toolbar off/on; unbound,
//   since Arc's Cmd+Shift+D is Whimsy's Duplicate Tab).
// - Spaces: New Space..., Edit Theme..., Rename Space.
// - Tabs (new, after Spaces): New Tab..., Pin Tab, New Folder..., Next Tab,
//   Previous Tab, Reveal Tab in Sidebar, Clear Today, Reset all tabs in
//   this Space (every pinned tab back to its pinned page).
// - Window: Open Library..., View Downloads..., View Media..., View
//   Boosts... (the Library's sections).
// - Help: Essential Keyboard Shortcuts (the Cmd+/ sheet).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyUndo: "resource:///modules/whimsy/WhimsyUndo.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.arc-menus";
const SINGLE_TOOLBAR_PREF = "zen.view.use-single-toolbar";
const REVEAL_ATTR = "whimsy-revealed";
const REVEAL_MS = 700;

// Zen's spaces menu ids → Arc's names.
const SPACE_LABELS = {
  "zen-panel-ui-workspaces-create": "whimsy-menu-new-space",
  "zen-workspaces-change-theme": "whimsy-menu-edit-theme",
  "zen-workspaces-panel-change-name": "whimsy-menu-rename-space",
};

function enabled() {
  return Services.prefs.getBoolPref(FEATURE_PREF, true);
}

function menuitem(document, id, l10nId, command, key = null) {
  const item = document.createXULElement("menuitem");
  item.id = id;
  item.setAttribute("data-l10n-id", l10nId);
  item.setAttribute("command", command);
  if (key) {
    item.setAttribute("key", key);
  }
  return item;
}

// WhimsyUndo entry type → the undo's name in the Edit menu.
export function undoAction(type) {
  if (!type) {
    return null;
  }
  if (type == "close" || type.startsWith("archive")) {
    return "archive";
  }
  return ["pin", "unpin", "move"].includes(type) ? type : "other";
}

export const WhimsyArcMenus = {
  get enabled() {
    return enabled();
  },

  showsToolbar() {
    return !Services.prefs.getBoolPref(SINGLE_TOOLBAR_PREF, true);
  },

  toggleToolbar() {
    Services.prefs.setBoolPref(SINGLE_TOOLBAR_PREF, this.showsToolbar());
  },

  // Arc's Tabs → Reveal Tab in Sidebar: opens the folders it's in, shows
  // the sidebar if it's hidden, scrolls the tab into view and marks it
  // briefly.
  revealTab(win) {
    const tab = win.gBrowser.selectedTab;
    if (!tab) {
      return false;
    }
    for (let group = tab.group; group; group = group.group) {
      if (group.collapsed && !group.hasAttribute("split-view-group")) {
        group.collapsed = false;
      }
    }
    if (win.gZenCompactModeManager?.preference) {
      win.document.getElementById("cmd_zenCompactModeShowSidebar")?.doCommand();
    }
    const reduce = win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    tab.scrollIntoView({ block: "nearest", behavior: reduce ? "instant" : "smooth" });
    tab.setAttribute(REVEAL_ATTR, "");
    win.clearTimeout(tab._whimsyRevealTimer);
    tab._whimsyRevealTimer = win.setTimeout(() => tab.removeAttribute(REVEAL_ATTR), REVEAL_MS);
    return true;
  },

  // Arc's Tabs → Reset all tabs in this Space: Zen's per-tab "Reset Pinned
  // Tab", for every pinned tab (not Essentials) of the current space.
  resetSpaceTabs(win) {
    const space = win.gZenWorkspaces?.activeWorkspace;
    const tabs = win.gBrowser.tabs.filter(
      tab =>
        tab.pinned &&
        !tab.hasAttribute("zen-essential") &&
        (!space || tab.getAttribute("zen-workspace-id") == space)
    );
    for (const tab of tabs) {
      try {
        win.gZenPinnedTabManager?.resetPinnedTab(tab);
      } catch (e) {
        console.error("Whimsy: reset pinned tab", e);
      }
    }
    return tabs.length;
  },

  openLibrarySection(win, section) {
    const ZenLibrary = win.customElements.get("zen-library");
    const lib = win.document.querySelector("zen-library");
    if (!ZenLibrary?.toggle || (lib?.zenLibrarySections && !(section in lib.zenLibrarySections))) {
      return false;
    }
    ZenLibrary.toggle(section);
    return true;
  },

  initWindow(win) {
    const { WhimsyCommands } = lazy;
    WhimsyCommands.register(win, {
      id: "cmd_whimsyResetSpaceTabs",
      l10nId: "whimsy-action-reset-space-tabs",
      run: w => this.resetSpaceTabs(w),
      icon: "chrome://browser/skin/zen-icons/reload.svg",
      isAvailable: w => enabled() && w.gBrowser.tabs.some(t => t.pinned && !t.hasAttribute("zen-essential")),
    });
    for (const [section, l10nId] of [["media", "whimsy-action-view-media"], ["boosts", "whimsy-action-view-boosts"]]) {
      WhimsyCommands.register(win, {
        id: `cmd_whimsyView-${section}`,
        l10nId,
        run: w => this.openLibrarySection(w, section),
        icon: "chrome://browser/skin/zen-icons/library.svg",
        isAvailable: () => enabled(),
      });
    }
    WhimsyCommands.register(win, {
      id: "cmd_whimsyToggleToolbar",
      l10nId: "whimsy-action-toggle-toolbar",
      run: () => this.toggleToolbar(),
      icon: "chrome://browser/skin/zen-icons/sidebar.svg",
      variants: [
        { l10nId: "whimsy-action-show-toolbar", isAvailable: () => enabled() && !this.showsToolbar() },
        { l10nId: "whimsy-action-hide-toolbar", isAvailable: () => enabled() && this.showsToolbar() },
      ],
    });
    WhimsyCommands.register(win, {
      id: "cmd_whimsyRevealTab",
      l10nId: "whimsy-action-reveal-tab",
      run: w => this.revealTab(w),
      icon: "chrome://browser/skin/zen-icons/sidebar.svg",
      isAvailable: () => enabled(),
    });
    WhimsyCommands.addCommandElement(win, "cmd_whimsyUndoTabAction", w => lazy.WhimsyUndo.undo(w));
    this.ensureMenus(win);
    // Zen builds its Spaces menu during startup; catch it (and any menu
    // rebuilt later) the first time a menu opens.
    win.document.getElementById("main-menubar")?.addEventListener("popupshowing", event => {
      this.ensureMenus(win);
      this.updateMenu(win, event.target);
    });
  },

  ensureMenus(win) {
    if (!enabled()) {
      return;
    }
    const { document } = win;
    try {
      this.initFile(document);
      this.initView(document);
      this.initSpaces(document);
      this.initTabs(document);
      this.initWindowMenu(document);
      this.initHelp(document);
    } catch (e) {
      console.error("Whimsy: Arc menus", e);
    }
  },

  initFile(document) {
    const blank = document.getElementById("menu_new_zen_unsynced_window");
    if (blank && blank.getAttribute("data-l10n-id") != "whimsy-menu-blank-window") {
      blank.setAttribute("data-l10n-id", "whimsy-menu-blank-window");
    }
    const save = document.getElementById("menu_savePage");
    if (save && !document.getElementById("menu_whimsyCapture") && Services.prefs.getBoolPref("whimsy.feature.capture", true)) {
      save.before(
        menuitem(document, "menu_whimsyCapture", "whimsy-menu-capture", "Browser:Screenshot", "key_whimsyScreenshotArc"),
        menuitem(document, "menu_whimsyCaptureFullPage", "whimsy-menu-capture-full-page", "cmd_whimsyCopyFullPage", "key_whimsyCopyFullPage"),
        menuitem(document, "menu_whimsyCapturePortrait", "whimsy-menu-capture-portrait", "cmd_whimsyCapturePortrait")
      );
    }
  },

  initView(document) {
    const anchor = document.getElementById("viewToolbarsMenu");
    if (!anchor || document.getElementById("menu_whimsyToggleSidebar")) {
      return;
    }
    anchor.before(
      menuitem(document, "menu_whimsyToggleSidebar", "whimsy-menu-hide-sidebar", "cmd_toggleCompactModeIgnoreHover", "zen-compact-mode-toggle"),
      menuitem(document, "menu_whimsyToggleToolbar", "whimsy-menu-show-toolbar", "cmd_whimsyToggleToolbar", "key_cmd_whimsyToggleToolbar"),
      document.createXULElement("menuseparator")
    );
  },

  initSpaces(document) {
    const popup = document.querySelector("#zen-spaces-menubar > menupopup");
    if (!popup) {
      return;
    }
    for (const [zenId, whimsyId] of Object.entries(SPACE_LABELS)) {
      popup.querySelector(`menuitem[data-l10n-id="${zenId}"]`)?.setAttribute("data-l10n-id", whimsyId);
    }
  },

  initTabs(document) {
    if (document.getElementById("whimsy-tabs-menubar")) {
      return;
    }
    const after = document.getElementById("zen-spaces-menubar") ?? document.getElementById("view-menu");
    if (!after) {
      return;
    }
    const menu = document.createXULElement("menu");
    menu.id = "whimsy-tabs-menubar";
    menu.setAttribute("data-l10n-id", "whimsy-menu-tabs");
    const popup = document.createXULElement("menupopup");
    popup.id = "whimsy-tabs-menubar-popup";
    popup.append(
      menuitem(document, "menu_whimsyTabsNewTab", "whimsy-menu-new-tab", "cmd_newNavigatorTab", "key_newNavigatorTab"),
      menuitem(document, "menu_whimsyTabsPin", "whimsy-menu-pin-tab", "cmd_zenTogglePinTab", "zen-toggle-pin-tab"),
      menuitem(document, "menu_whimsyTabsNewFolder", "whimsy-menu-new-folder", "cmd_zenOpenFolderCreation"),
      document.createXULElement("menuseparator"),
      menuitem(document, "menu_whimsyTabsNext", "whimsy-menu-next-tab", "whimsy-tab-next", "key_whimsyTabNext"),
      menuitem(document, "menu_whimsyTabsPrev", "whimsy-menu-prev-tab", "whimsy-tab-prev", "key_whimsyTabPrev"),
      menuitem(document, "menu_whimsyTabsReveal", "whimsy-menu-reveal-tab", "cmd_whimsyRevealTab"),
      document.createXULElement("menuseparator"),
      menuitem(document, "menu_whimsyTabsClearToday", "whimsy-menu-clear-today", "cmd_zenCloseUnpinnedTabs", "zen-close-all-unpinned-tabs"),
      menuitem(document, "menu_whimsyTabsResetSpace", "whimsy-menu-reset-space-tabs", "cmd_whimsyResetSpaceTabs")
    );
    menu.append(popup);
    after.after(menu);
  },

  initWindowMenu(document) {
    const anchor = document.getElementById("sep-window-list");
    if (!anchor || document.getElementById("menu_whimsyOpenLibrary")) {
      return;
    }
    anchor.before(
      document.createXULElement("menuseparator"),
      menuitem(document, "menu_whimsyOpenLibrary", "whimsy-menu-open-library", "cmd_zenToggleLibrary", "zen-library-toggle"),
      menuitem(document, "menu_whimsyViewDownloads", "whimsy-menu-view-downloads", "Tools:Downloads", "key_openDownloads"),
      menuitem(document, "menu_whimsyViewMedia", "whimsy-menu-view-media", "cmd_whimsyView-media"),
      menuitem(document, "menu_whimsyViewBoosts", "whimsy-menu-view-boosts", "cmd_whimsyView-boosts")
    );
  },

  initHelp(document) {
    const popup = document.getElementById("menu_HelpPopup");
    if (!popup || document.getElementById("menu_whimsyKeyboardShortcuts")) {
      return;
    }
    popup.prepend(
      menuitem(document, "menu_whimsyKeyboardShortcuts", "whimsy-menu-essential-shortcuts", "whimsy-cheatsheet", "key_whimsyCheatsheet")
    );
  },

  // State-dependent names, set as the menu opens.
  updateMenu(win, popup) {
    if (!enabled()) {
      return;
    }
    const { document } = win;
    switch (popup.id) {
      case "menu_EditPopup": {
        const undo = document.getElementById("menu_undo");
        const action = undoAction(lazy.WhimsyUndo.pendingUndo?.(win));
        if (!undo) {
          break;
        }
        if (action) {
          document.l10n.setAttributes(undo, "whimsy-menu-undo-action", { action });
          undo.setAttribute("command", "cmd_whimsyUndoTabAction");
        } else if (undo.getAttribute("command") == "cmd_whimsyUndoTabAction") {
          undo.setAttribute("data-l10n-id", "text-action-undo");
          undo.removeAttribute("data-l10n-args");
          undo.setAttribute("command", "cmd_undo");
        }
        break;
      }
      case "menu_viewPopup": {
        const compact = !!win.gZenCompactModeManager?.preference;
        document.getElementById("menu_whimsyToggleSidebar")?.setAttribute(
          "data-l10n-id",
          compact ? "whimsy-menu-show-sidebar" : "whimsy-menu-hide-sidebar"
        );
        document.getElementById("menu_whimsyToggleToolbar")?.setAttribute(
          "data-l10n-id",
          this.showsToolbar() ? "whimsy-menu-hide-toolbar" : "whimsy-menu-show-toolbar"
        );
        break;
      }
      case "whimsy-tabs-menubar-popup": {
        const pinned = !!win.gBrowser.selectedTab?.pinned;
        document.getElementById("menu_whimsyTabsPin")?.setAttribute(
          "data-l10n-id",
          pinned ? "whimsy-menu-unpin-tab" : "whimsy-menu-pin-tab"
        );
        break;
      }
    }
  },
};
