/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave9/menus: W9-09, right-click ↔ command parity (the user's answers,
// 2026-10-31). Two halves:
//
// 1. Menu actions that had no command get one: a <command>, a <key> with
//    no default shortcut (about:keyboard lists it, so one can be assigned)
//    and a command-bar row. Each acts on the current tab, space, split,
//    page or selection, the way its menu row acts on the one right-clicked.
//    Zen's and Firefox's own commands are reused where they act on the
//    current one already (Back, View Page Source, Rename Space…); a <key>
//    Firefox already has (Back's Cmd+[) stays Firefox's, listed in its own
//    group.
// 2. Commands that had no menu row get one, registered with Settings →
//    Menus (WhimsyMenuPrefs). The user asked for most to be off by default
//    (prefs/whimsy/whimsy.yaml, whimsy.menus.hidden.*); Allow Copy and Paste
//    shows by default, and only on pages that block copying; Move Tab ▸ New
//    Space… (WhimsyNewSpaceMove) shows too.
//
// The tab menu's Share ▸ (Firefox's) lists the macOS share services itself
// (WhimsyShareMenu), so it's a normal submenu, not a door to a second menu.
//
// Each row and command checks the feature switch when used.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
  DevToolsShim: "chrome://devtools-startup/content/DevToolsShim.sys.mjs",
  WhimsyArcMenus: "resource:///modules/whimsy/WhimsyArcMenus.sys.mjs",
  WhimsyArchiveMenu: "resource:///modules/whimsy/WhimsyArchiveMenu.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyCopy: "resource:///modules/whimsy/WhimsyCopy.sys.mjs",
  WhimsyDevMode: "resource:///modules/whimsy/WhimsyDevMode.sys.mjs",
  WhimsyMedia: "resource:///modules/whimsy/WhimsyMedia.sys.mjs",
  WhimsyMenuPrefs: "resource:///modules/whimsy/WhimsyMenuPrefs.sys.mjs",
  WhimsyPage: "resource:///modules/whimsy/WhimsyPage.sys.mjs",
  WhimsyPlaylist: "resource:///modules/whimsy/WhimsyPlaylist.sys.mjs",
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
  WhimsyShareMenu: "resource:///modules/whimsy/WhimsyShareMenu.sys.mjs",
  WhimsySplit: "resource:///modules/whimsy/WhimsySplit.sys.mjs",
  WhimsySplitKeys: "resource:///modules/whimsy/WhimsySplitKeys.sys.mjs",
  WhimsySplitPane: "resource:///modules/whimsy/WhimsySplitPane.sys.mjs",
  WhimsySplitRow: "resource:///modules/whimsy/WhimsySplitRow.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.menu-parity";
const ICON = name => `chrome://browser/skin/zen-icons/${name}.svg`;

function enabled() {
  return Services.prefs.getBoolPref(FEATURE_PREF, true);
}

// The tab a tab command acts on: the current one (a Glance's parent).
function currentTab(win) {
  const tab = win.gBrowser.selectedTab;
  return win.gZenGlanceManager?.getTabOrGlanceParent?.(tab) ?? tab;
}

function isWebPage(browser) {
  const uri = browser?.currentURI;
  return !!uri && ["http", "https", "file"].includes(uri.scheme);
}

function spacesUsable(win) {
  const spaces = win.gZenWorkspaces;
  return !!spaces?.workspaceEnabled && !spaces.privateWindowOrDisabled;
}

function activeIsScratch(win) {
  try {
    return lazy.WhimsyPrivate.activeSpaceIsScratch(win);
  } catch (e) {
    return false;
  }
}

// The current tab's split group, or null.
function currentSplit(win) {
  const tab = win.gBrowser.selectedTab;
  const group = tab?.group;
  return group?.hasAttribute?.("split-view-group") ? group : null;
}

function regularTab(tab) {
  return !!tab && !tab.pinned && !tab.hasAttribute("zen-essential");
}

// --- Commands -------------------------------------------------------------

// [id, l10nId, run(win), isAvailable(win), extra]. Ids starting cmd_zen /
// Browser: / View: are Zen's or Firefox's own <command>s, reused.
function commandSpecs() {
  const toast = (win, id) => win.gZenUIManager?.showToast?.(id);
  return [
    // Tab
    {
      id: "cmd_whimsyRenameTab",
      l10nId: "whimsy-action-rename-tab",
      icon: ICON("text-title-case"),
      run: w => w.gZenTabRenamer?.start({ target: currentTab(w) }),
      isAvailable: w =>
        !!w.gZenTabRenamer &&
        Services.prefs.getBoolPref("zen.tabs.rename-tabs", true) &&
        !!w.gZenVerticalTabsManager?._prefsSidebarExpanded &&
        !currentTab(w).hasAttribute("zen-essential"),
    },
    // Change Tab Icon… is wave9/restore's (cmd_whimsyChangeTabIcon).
    {
      id: "cmd_whimsyUnloadTab",
      l10nId: "whimsy-action-unload-tab",
      icon: ICON("close"),
      run: w => w.gBrowser.explicitUnloadTabs([currentTab(w)]),
      isAvailable: w => w.gBrowser.visibleTabs.length > 1,
    },
    {
      id: "cmd_whimsyArchiveTabsBelow",
      l10nId: "whimsy-action-archive-tabs-below",
      icon: ICON("arrow-down"),
      run: w => lazy.WhimsyArchiveMenu.archiveTabsBelow(w, currentTab(w)),
      isAvailable: w => lazy.WhimsyArchiveMenu.tabsBelow(w, currentTab(w)).length > 0,
    },
    {
      id: "cmd_whimsyCloseDuplicateTabs",
      l10nId: "whimsy-action-close-duplicate-tabs",
      icon: ICON("close"),
      run: w => w.gBrowser.removeDuplicateTabs(currentTab(w)),
      isAvailable: w => w.gBrowser.getDuplicateTabsToClose?.(currentTab(w))?.length > 0,
    },
    {
      id: "cmd_whimsyCloseOtherTabs",
      l10nId: "whimsy-action-close-other-tabs",
      icon: ICON("close"),
      run: w => w.gBrowser.removeAllTabsBut(currentTab(w)),
      isAvailable: w => w.gBrowser.visibleTabs.some(t => t != currentTab(w) && !t.pinned),
    },
    {
      id: "cmd_whimsyCloseTabsBelow",
      l10nId: "whimsy-action-close-tabs-below",
      icon: ICON("arrow-down"),
      run: w => w.gBrowser.removeTabsToTheEndFrom(currentTab(w)),
      isAvailable: w => w.gBrowser._getTabsToTheEndFrom(currentTab(w)).length > 0,
    },
    {
      id: "cmd_whimsySelectAllTabs",
      l10nId: "whimsy-action-select-all-tabs",
      icon: ICON("tab"),
      run: w => w.gBrowser.selectAllTabs(),
      isAvailable: w => !w.gBrowser.allTabsSelected(),
    },
    {
      id: "cmd_whimsyMuteTab",
      l10nId: "whimsy-action-mute-tab-toggle",
      icon: ICON("media-mute"),
      run: w => currentTab(w).toggleMuteAudio(),
      // In a split the focused pane has its own row (below).
      variants: [
        {
          l10nId: "whimsy-action-mute-tab",
          isAvailable: w => !currentSplit(w) && !currentTab(w).hasAttribute("muted"),
        },
        {
          l10nId: "whimsy-action-unmute-tab",
          isAvailable: w => !currentSplit(w) && currentTab(w).hasAttribute("muted"),
        },
      ],
    },
    {
      id: "cmd_whimsyAddSiteToRouting",
      l10nId: "whimsy-action-add-site-to-routing",
      icon: ICON("permissions"),
      run: w => w.gZenSpaceRoutingManager?.addRouteForSelected([currentTab(w)], w),
      isAvailable: w =>
        !!w.gZenSpaceRoutingManager &&
        spacesUsable(w) &&
        ["http", "https"].includes(currentTab(w).linkedBrowser?.currentURI?.scheme),
    },
    {
      id: "cmd_whimsyReplacePinnedUrl",
      l10nId: "whimsy-action-replace-pinned-url",
      icon: ICON("pin"),
      run: w => w.gZenPinnedTabManager?.replacePinnedUrlWithCurrent(currentTab(w)),
      isAvailable: w => currentTab(w).pinned && currentTab(w).hasAttribute("zen-pinned-changed"),
    },
    {
      id: "cmd_whimsyShareTab",
      l10nId: "whimsy-action-share-tab",
      icon: ICON("share"),
      run: w => WhimsyMenuParity.shareTab(w, currentTab(w)),
      isAvailable: w => lazy.AppConstants.platform == "macosx" && isWebPage(currentTab(w).linkedBrowser),
    },

    // Space: Zen's own commands act on the current space when no space menu
    // is open.
    {
      id: "cmd_zenChangeWorkspaceName",
      l10nId: "whimsy-action-rename-space",
      icon: ICON("text-title-case"),
      isAvailable: w => spacesUsable(w),
    },
    {
      id: "cmd_zenChangeWorkspaceIcon",
      l10nId: "whimsy-action-change-space-icon",
      icon: ICON("face-sun"),
      isAvailable: w => spacesUsable(w),
    },
    {
      id: "cmd_zenUnloadWorkspace",
      l10nId: "whimsy-action-unload-space",
      icon: ICON("close"),
      isAvailable: w => spacesUsable(w),
    },
    {
      id: "cmd_zenCtxShareWorkspace",
      l10nId: "whimsy-action-share-space",
      icon: ICON("share"),
      isAvailable: w => spacesUsable(w) && !!w.gZenShareManager?.enabled && !activeIsScratch(w),
    },
    {
      // Keeps Zen's confirmation. Scratch closes with Close Scratch instead.
      id: "cmd_zenCtxDeleteWorkspace",
      l10nId: "whimsy-action-delete-space",
      icon: ICON("trash"),
      isAvailable: w => spacesUsable(w) && w.gZenWorkspaces.getWorkspaces().length > 1 && !activeIsScratch(w),
    },

    // Split: the split the current tab is in.
    {
      id: "cmd_whimsyShareSplit",
      l10nId: "whimsy-action-share-split",
      icon: ICON("share"),
      run: w => lazy.WhimsySplitRow.run(w, "whimsySplitRow-share", w.gBrowser.selectedTab),
      isAvailable: w => !!currentSplit(w) && !!w.gZenShareManager?.enabled,
    },
    {
      id: "cmd_whimsyChangeSplitIcon",
      l10nId: "whimsy-action-change-split-icon",
      icon: ICON("face-sun"),
      run: w => lazy.WhimsySplitRow.run(w, "whimsySplitRow-changeIcon", w.gBrowser.selectedTab),
      isAvailable: w => !!currentSplit(w) && !!w.gZenEmojiPicker,
    },
    {
      id: "cmd_whimsyRenameSplit",
      l10nId: "whimsy-action-rename-split",
      icon: ICON("text-title-case"),
      run: w => lazy.WhimsySplitRow.run(w, "whimsySplitRow-rename", w.gBrowser.selectedTab),
      isAvailable: w =>
        !!currentSplit(w) &&
        !!w.gZenTabRenamer &&
        Services.prefs.getBoolPref("zen.tabs.rename-tabs", true) &&
        !!w.gZenVerticalTabsManager?._prefsSidebarExpanded,
    },
    {
      id: "cmd_whimsyDuplicateSplit",
      l10nId: "whimsy-action-duplicate-split",
      icon: ICON("duplicate-tab"),
      run: w => lazy.WhimsySplitRow.run(w, "whimsySplitRow-duplicate", w.gBrowser.selectedTab),
      isAvailable: w => !!currentSplit(w),
    },
    {
      id: "cmd_whimsyMutePane",
      l10nId: "whimsy-action-mute-pane-toggle",
      icon: ICON("media-mute"),
      run: w => currentSplit(w) && lazy.WhimsySplitPane.runPaneAction(w, "mute", w.gBrowser.selectedTab),
      variants: [
        {
          l10nId: "whimsy-action-mute-pane",
          isAvailable: w => !!currentSplit(w) && !w.gBrowser.selectedTab.hasAttribute("muted"),
        },
        {
          l10nId: "whimsy-action-unmute-pane",
          isAvailable: w => !!currentSplit(w) && w.gBrowser.selectedTab.hasAttribute("muted"),
        },
      ],
    },

    // Page: Firefox's commands (their own shortcuts stay theirs).
    {
      id: "Browser:Back",
      l10nId: "whimsy-action-back",
      icon: ICON("back"),
      isAvailable: w => w.gBrowser.canGoBack,
    },
    {
      id: "Browser:Forward",
      l10nId: "whimsy-action-forward",
      icon: ICON("forward"),
      isAvailable: w => w.gBrowser.canGoForward,
    },
    {
      id: "View:PageSource",
      l10nId: "whimsy-action-view-page-source",
      icon: ICON("selectable/code"),
      isAvailable: w => isWebPage(w.gBrowser.selectedBrowser),
    },
    {
      id: "Browser:SavePage",
      l10nId: "whimsy-action-save-page",
      icon: ICON("downloads"),
      isAvailable: w => isWebPage(w.gBrowser.selectedBrowser),
    },
    {
      id: "Browser:AddBookmarkAs",
      l10nId: "whimsy-action-bookmark-page",
      icon: ICON("bookmark"),
      isAvailable: w => isWebPage(w.gBrowser.selectedBrowser),
    },
    {
      id: "cmd_whimsyInspectAccessibility",
      l10nId: "whimsy-action-inspect-accessibility",
      icon: ICON("info"),
      run: w => lazy.DevToolsShim.showToolboxForTab(w.gBrowser.selectedTab, { toolId: "accessibility" }),
      isAvailable: w => lazy.DevToolsShim.isEnabled() && isWebPage(w.gBrowser.selectedBrowser),
    },

    // Selection: the page's selected text.
    {
      id: "cmd_whimsyCopyLinkToHighlight",
      l10nId: "whimsy-action-copy-link-to-highlight",
      icon: ICON("link"),
      run: w => WhimsyMenuParity.copyLinkToHighlight(w),
      isAvailable: w =>
        Services.prefs.getBoolPref("dom.text_fragments.enabled", true) &&
        ["http", "https"].includes(w.gBrowser.selectedBrowser?.currentURI?.scheme),
    },
    {
      id: "cmd_whimsyPrintSelection",
      l10nId: "whimsy-action-print-selection",
      icon: ICON("print"),
      run: w => WhimsyMenuParity.printSelection(w, toast),
      isAvailable: w => isWebPage(w.gBrowser.selectedBrowser) && Services.prefs.getBoolPref("print.enabled", true),
    },
  ];
}

// --- Menu rows --------------------------------------------------------------

// Each row: the menu (WhimsyMenuPrefs id), DOM id, label, the popup it goes
// in, where (after/before an existing row's id, else last), the command it
// runs (its <key> shows beside it) or a run(win, context) of its own, and
// when it shows. Rows are built once per window, on the popup's first show.
function rowSpecs() {
  const contextTab = win => win.TabContextMenu?.contextTab ?? null;
  return [
    // Page
    {
      menu: "page",
      id: "context-whimsy-allow-copy",
      popup: "contentAreaContextMenu",
      after: "context-selectall",
      run: w => lazy.WhimsyPage.toggleAllowCopy(w, w.gContextMenu?.browser ?? w.gBrowser.selectedBrowser),
      update: (w, item) => {
        const browser = w.gContextMenu?.browser;
        const allowed = !!browser && lazy.WhimsyPage.copyAllowed(browser);
        const show =
          lazy.WhimsyPage.allowCopyEnabled &&
          !!browser &&
          !!lazy.WhimsyMedia.siteFor(browser) &&
          (allowed || WhimsyMenuParity.copyBlocked(browser));
        w.document.l10n.setAttributes(item, allowed ? "whimsy-context-disallow-copy" : "whimsy-context-allow-copy");
        return show;
      },
    },
    {
      menu: "page",
      id: "context-whimsy-capture-full-page",
      l10nId: "whimsy-context-capture-full-page",
      popup: "contentAreaContextMenu",
      after: "context-take-screenshot",
      command: "cmd_whimsyCopyFullPage",
    },
    {
      menu: "page",
      id: "context-whimsy-capture-portrait",
      l10nId: "whimsy-context-capture-portrait",
      popup: "contentAreaContextMenu",
      after: "context-whimsy-capture-full-page",
      command: "cmd_whimsyCapturePortrait",
    },
    {
      menu: "page",
      id: "context-whimsy-wayback",
      l10nId: "whimsy-context-wayback",
      popup: "contentAreaContextMenu",
      after: "context-sendpagetodevice",
      command: "cmd_whimsyOpenInWayback",
    },
    {
      menu: "page",
      id: "context-whimsy-dev-mode",
      popup: "contentAreaContextMenu",
      before: "context-inspect-a11y",
      command: "whimsy-devmode-toggle-site",
      update: (w, item) => {
        const uri = w.gContextMenu?.browser?.currentURI;
        const on = !!uri && lazy.WhimsyDevMode.isDevMode(uri);
        w.document.l10n.setAttributes(item, on ? "whimsy-context-devmode-off" : "whimsy-context-devmode-on");
        return lazy.WhimsyDevMode.enabled && !!uri && ["http", "https", "file"].includes(uri.scheme);
      },
    },

    // Tab
    {
      menu: "tab",
      id: "context_whimsyTabVolume",
      l10nId: "whimsy-context-tab-volume",
      popup: "tabContextMenu",
      after: "context_whimsyMuteSite",
      fallbackAfter: "context_toggleMuteTab",
      run: w => {
        const tab = contextTab(w);
        if (tab && lazy.WhimsyMedia.canAdjustVolume(tab)) {
          lazy.WhimsyMedia.openVolumePanel(w, tab);
        }
      },
      keyCommand: "cmd_whimsyTabVolume",
      update: w => !!contextTab(w) && lazy.WhimsyMedia.canAdjustVolume(contextTab(w)),
    },
    {
      menu: "tab",
      id: "context_whimsyPlaylistSave",
      l10nId: "whimsy-context-playlist-save-tab",
      popup: "tabContextMenu",
      after: "context_whimsyTabVolume",
      run: w => {
        const tab = contextTab(w);
        if (tab) {
          lazy.WhimsyPlaylist.saveFromPage(w, tab.linkedBrowser).catch(e => console.error("Whimsy: playlist", e));
        }
      },
      keyCommand: "cmd_whimsyPlaylistSave",
      update: w =>
        lazy.WhimsyPlaylist.enabled &&
        !!contextTab(w) &&
        !contextTab(w).linkedBrowser?.browsingContext?.usePrivateBrowsing &&
        isWebPage(contextTab(w).linkedBrowser),
    },
    {
      menu: "tab",
      id: "context_whimsyCopyLinkMarkdown",
      l10nId: "whimsy-context-copy-link-markdown",
      popup: "tabContextMenu",
      after: "context_whimsyCopyLinks",
      fallbackAfter: "context_duplicateTab",
      run: w => lazy.WhimsyCopy.copy(w, lazy.WhimsyCopy.linksFor(lazy.WhimsyCopy.contextTabs(w)), { markdown: true }),
      key: "zen-copy-url-markdown",
      update: w => !!contextTab(w),
    },

    // Space
    {
      menu: "space",
      id: "whimsy-reset-space-tabs-menuitem",
      l10nId: "whimsy-context-reset-space-tabs",
      popup: "zenWorkspaceMoreActions",
      after: "context_zenUnloadWorkspace",
      run: (w, popup) => lazy.WhimsyArcMenus.resetSpaceTabs(w, WhimsyMenuParity.spaceMenuTarget(w, popup)),
      keyCommand: "cmd_whimsyResetSpaceTabs",
      update: (w, item, popup) => {
        const space = WhimsyMenuParity.spaceMenuTarget(w, popup);
        return (
          !lazy.WhimsyPrivate.isScratchId(w, space) &&
          w.gBrowser.tabs.some(
            t => t.pinned && !t.hasAttribute("zen-essential") && t.getAttribute("zen-workspace-id") == space
          )
        );
      },
    },
    {
      menu: "space",
      id: "whimsy-show-hidden-spaces-menuitem",
      l10nId: "whimsy-context-show-hidden-spaces",
      popup: "zenWorkspaceMoreActions",
      after: "whimsy-hide-space-menuitem",
      command: "cmd_whimsyShowHiddenSpaces",
    },

    // Sidebar (the toolbar menu, on the tab strip only) and Folder
    {
      menu: "sidebar",
      id: "whimsy-sidebar-add-finder-folder",
      l10nId: "whimsy-context-add-finder-folder",
      popup: "toolbar-context-menu",
      after: "zen-panel-ui-live-folder-create",
      command: "cmd_whimsyAddFinderFolder",
      tabbar: true,
    },
    {
      menu: "sidebar",
      id: "whimsy-sidebar-collapse-all-folders",
      l10nId: "whimsy-context-collapse-all-folders",
      popup: "toolbar-context-menu",
      after: "whimsy-sidebar-add-finder-folder",
      command: "cmd_whimsyCollapseAllFolders",
      tabbar: true,
    },
    {
      menu: "sidebar",
      id: "whimsy-sidebar-expand-all-folders",
      l10nId: "whimsy-context-expand-all-folders",
      popup: "toolbar-context-menu",
      after: "whimsy-sidebar-collapse-all-folders",
      command: "cmd_whimsyExpandAllFolders",
      tabbar: true,
    },
    {
      menu: "folder",
      id: "whimsy-folder-collapse-all-folders",
      l10nId: "whimsy-context-collapse-all-folders",
      popup: "zenFolderActions",
      after: "context_zenFolderNewSubfolder",
      command: "cmd_whimsyCollapseAllFolders",
    },
    {
      menu: "folder",
      id: "whimsy-folder-expand-all-folders",
      l10nId: "whimsy-context-expand-all-folders",
      popup: "zenFolderActions",
      after: "whimsy-folder-collapse-all-folders",
      command: "cmd_whimsyExpandAllFolders",
    },

    // Split row (right-click a split) and pane (⋯): the split clicked.
    {
      menu: "split-row",
      id: "whimsySplitRow-swapPanes",
      l10nId: "whimsy-context-swap-panes",
      popup: "whimsySplitRowMenu",
      after: "whimsySplitRow-convert",
      runOnSplit: "cmd_whimsySwapPanes",
    },
    {
      menu: "split-row",
      id: "whimsySplitRow-favorite",
      l10nId: "whimsy-context-favorite-split",
      popup: "whimsySplitRowMenu",
      after: "whimsySplitRow-duplicate",
      runOnSplit: "whimsy-cmd-favorite-split",
    },
    // wave10 (W10-56): shown by default, and it swaps the pane whose ⋯
    // menu it is (like Separate above it), not whichever pane has focus.
    {
      menu: "split-pane",
      id: "whimsySplitPane-swapPanes",
      l10nId: "whimsy-context-swap-panes",
      popup: "whimsySplitPaneMenu",
      after: "whimsySplitPane-separate",
      keyCommand: "cmd_whimsySwapPanes",
      run: (w, popup) => {
        const tab = WhimsyMenuParity.splitTabOf(w, popup);
        if (tab?.isConnected) {
          lazy.WhimsySplit.swapPanes(w, tab);
        }
      },
      update: (w, item, popup) =>
        lazy.WhimsySplit.canSwap(w, WhimsyMenuParity.splitTabOf(w, popup)),
    },

    // Selection
    {
      menu: "selection",
      id: "context-whimsy-copy-url-quote",
      l10nId: "whimsy-context-copy-url-quote",
      popup: "contentAreaContextMenu",
      after: "context-whimsy-copy-markdown",
      fallbackAfter: "context-copy",
      command: "cmd_whimsyCopyURLQuote",
      update: w => !!w.gContextMenu?.isContentSelected,
    },
  ];
}

// Which content-area menu a row belongs to (WhimsyMenuPrefs' rule).
function contentMenuOf(win) {
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
  return c.isContentSelected ? "selection" : "page";
}

const installed = new WeakSet();

export const WhimsyMenuParity = {
  get enabled() {
    return enabled();
  },

  commandSpecs,
  rowSpecs,

  initWindow(win) {
    if (installed.has(win)) {
      return;
    }
    installed.add(win);
    for (const spec of commandSpecs()) {
      const { run } = spec;
      lazy.WhimsyCommands.register(win, {
        ...spec,
        run: run && (w => enabled() && run(w)),
        isAvailable: spec.isAvailable && (w => enabled() && spec.isAvailable(w)),
        variants: spec.variants?.map(v => ({ ...v, isAvailable: w => enabled() && v.isAvailable(w) })),
        menu: spec.menu,
      });
    }
    this.initRows(win);
    lazy.WhimsyShareMenu.initWindow(win);
  },

  // Listens on each popup (so before WhimsyMenuPrefs' window listener,
  // which then hides what Settings → Menus turned off).
  initRows(win) {
    const { document } = win;
    const byPopup = new Map();
    for (const spec of rowSpecs()) {
      if (!byPopup.has(spec.popup)) {
        byPopup.set(spec.popup, []);
      }
      byPopup.get(spec.popup).push(spec);
    }
    for (const [popupId, specs] of byPopup) {
      const listen = popup => {
        popup.addEventListener("popupshowing", event => {
          if (event.target != popup) {
            return;
          }
          try {
            this.updateRows(win, popup, specs);
          } catch (e) {
            console.error("Whimsy: menu parity rows", e);
          }
        });
      };
      const popup = document.getElementById(popupId);
      if (popup) {
        listen(popup);
        continue;
      }
      // The split menus are built on first use.
      const observer = new win.MutationObserver(() => {
        const late = document.getElementById(popupId);
        if (late) {
          observer.disconnect();
          listen(late);
          try {
            this.updateRows(win, late, specs);
            // It's built while opening: Settings → Menus already ran on it
            // without these rows.
            if (["showing", "open"].includes(late.state)) {
              lazy.WhimsyMenuPrefs.refresh(win, late);
            }
          } catch (e) {
            console.error("Whimsy: menu parity rows", e);
          }
        }
      });
      const root = document.getElementById("mainPopupSet") ?? document.documentElement;
      observer.observe(root, { childList: true });
      win.addEventListener("unload", () => observer.disconnect(), { once: true });
    }
  },

  ensureRow(win, popup, spec) {
    const { document } = win;
    let item = document.getElementById(spec.id);
    if (item) {
      return item;
    }
    item = document.createXULElement("menuitem");
    item.id = spec.id;
    if (spec.l10nId) {
      item.setAttribute("data-l10n-id", spec.l10nId);
    }
    if (spec.tabbar) {
      // Firefox shows these only when the menu opened on the tab strip.
      item.setAttribute("contexttype", "tabbar");
    }
    // The shortcut beside it: its command's <key> (empty until assigned).
    const keyCommand = spec.keyCommand ?? spec.command ?? spec.runOnSplit;
    const keyId = spec.key ?? (keyCommand ? lazy.WhimsyCommands.get(keyCommand)?.keyId : null);
    if (keyId) {
      item.setAttribute("key", keyId);
    }
    if (spec.command && !spec.run) {
      item.setAttribute("command", spec.command);
    } else {
      item.addEventListener("command", () => {
        if (!enabled()) {
          return;
        }
        try {
          if (spec.runOnSplit) {
            this.runOnSplit(win, popup, spec.runOnSplit);
          } else {
            spec.run(win, popup);
          }
        } catch (e) {
          console.error(`Whimsy: ${spec.id}`, e);
        }
      });
    }
    const anchorOf = id => {
      const node = id && document.getElementById(id);
      return node?.parentNode == popup ? node : null;
    };
    const before = anchorOf(spec.before);
    const after = anchorOf(spec.after) ?? anchorOf(spec.fallbackAfter);
    if (before) {
      before.before(item);
    } else if (after) {
      after.after(item);
    } else {
      popup.append(item);
    }
    return item;
  },

  updateRows(win, popup, specs) {
    const contentMenu = popup.id == "contentAreaContextMenu" ? contentMenuOf(win) : null;
    for (const spec of specs) {
      const item = this.ensureRow(win, popup, spec);
      // A row that was placed before its anchor existed moves next to it.
      if (spec.after && item.previousElementSibling?.id != spec.after) {
        const anchor = win.document.getElementById(spec.after);
        if (anchor?.parentNode == popup) {
          anchor.after(item);
        }
      }
      let show = enabled();
      if (show && popup.id == "contentAreaContextMenu") {
        show = contentMenu == spec.menu;
      }
      if (show && spec.update) {
        show = !!spec.update(win, item, popup);
      } else if (show && spec.command && !spec.update) {
        show = this.commandAvailable(win, spec.command);
      }
      if (spec.tabbar) {
        // Firefox's own tab-strip test already ran; only ever hide more.
        show &&= !win.document.getElementById("toolbar-context-openANewTab")?.hidden;
      }
      if (spec.runOnSplit) {
        show &&= !!this.splitTabOf(win, popup);
      }
      item.hidden = !show;
    }
  },

  // Whether a registered command's command-bar row (any variant) is offered.
  commandAvailable(win, commandId) {
    const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
    const rows = globalActions.filter(a => a.whimsyCommand == commandId || a.command == commandId);
    if (!rows.length) {
      return !!win.document.getElementById(commandId);
    }
    return rows.some(a => {
      try {
        return !a.isAvailable || a.isAvailable(win);
      } catch (e) {
        return false;
      }
    });
  },

  // The tab a split menu was opened for (both keep it as whimsyTab).
  splitTabOf(win, popup) {
    for (let node = popup; node; node = node.parentNode) {
      if (node.whimsyTab) {
        return node.whimsyTab;
      }
    }
    return null;
  },

  // Runs a current-split command on the split the menu was opened for.
  runOnSplit(win, popup, commandId) {
    const tab = this.splitTabOf(win, popup);
    if (!tab?.isConnected) {
      return;
    }
    const group = tab.group;
    if (group?.hasAttribute("split-view-group") && !group.tabs.includes(win.gBrowser.selectedTab)) {
      win.gBrowser.selectedTab = tab;
    }
    win.document.getElementById(commandId)?.doCommand();
  },

  // The space Zen's space menu was opened for, else the current one.
  spaceMenuTarget(win, popup) {
    let id = null;
    try {
      id = popup?.triggerNode?.closest?.("[zen-workspace-id]")?.getAttribute("zen-workspace-id");
    } catch (e) {}
    return id || win.gZenWorkspaces?.activeWorkspace || null;
  },

  // --- Allow copy: is this a page that blocks copying? ---

  // Set by WhimsyPageParent from what WhimsyPageChild saw on the right-click
  // (Whimsy:CopyBlocked arrives before Firefox's ContextMenu:Open: both
  // actors share the window global's channel).
  copyBlocked(browser) {
    return !!browser?._whimsyCopyBlocked;
  },

  // --- Commands that need more than one line ---

  // Share Tab…: the macOS share picker, under the address bar.
  shareTab(win, tab) {
    const { SharingUtils } = win;
    if (!SharingUtils?.shareOnMacPicker || !tab?.linkedBrowser) {
      return;
    }
    const node = win.document.createXULElement("menu");
    node.contextBrowserToShare = Cu.getWeakReference(tab.linkedBrowser);
    node.browsersToShare = null;
    SharingUtils.shareOnMacPicker(node).catch(e => console.error("Whimsy: share tab", e));
  },

  async copyLinkToHighlight(win) {
    const browser = win.gBrowser.selectedBrowser;
    let url = null;
    try {
      const actor = browser.browsingContext?.currentWindowGlobal?.getActor("ContextMenu");
      url = await actor?.getTextDirective();
    } catch (e) {
      console.error("Whimsy: copy link to highlight", e);
    }
    if (!url) {
      win.gZenUIManager?.showToast?.("whimsy-highlight-none-toast");
      return null;
    }
    lazy.WhimsyCopy.writeClipboard(win, { text: url });
    win.gZenUIManager?.showToast?.("whimsy-highlight-copied-toast");
    return url;
  },

  async printSelection(win, toast) {
    const browser = win.gBrowser.selectedBrowser;
    let selected = null;
    try {
      selected = await browser.browsingContext?.currentWindowGlobal?.getActor("WhimsyPage").sendQuery("Whimsy:Selection");
    } catch (e) {
      // No page actor here (about: pages).
    }
    if (!selected?.text) {
      toast(win, "whimsy-print-selection-none-toast");
      return false;
    }
    win.PrintUtils.startPrintWindow(browser.browsingContext, { printSelectionOnly: true });
    return true;
  },
};
