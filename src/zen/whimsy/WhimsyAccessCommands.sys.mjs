/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave7/keys: commands for the Whimsy features that were reachable only
// from Settings, a sidebar control or a context menu (review/access-
// matrix.md). The user's rule: commands for most things, each with a
// shortcut the person can assign; a context menu or sidebar control only
// where it fits. Each one is registered in WhimsyCommands, so it's in the
// command bar under its name and under "Whimsy" in about:keyboard, unbound
// (none of these has an Arc key), ready to be given one.
//
// - Collapse/Expand Tab Children (tree tabs): the current tab's branch, or
//   its parent's when the tab has no children.
// - Show Hidden Spaces…: a short menu of hidden spaces; picking one shows
//   it again (the same restore as Settings).
// - Show/Hide Space Switcher, Mute Background Tabs / Stop Muting, Turn
//   Dark PDFs On/Off: the Settings toggles, state-aware like Turn VPN On/
//   Off.
// - Zoom Interface In / Out / Reset Interface Zoom: Settings → Zoom's
//   steps (80%–200%). Never the page's zoom, so Cmd+Plus stays Firefox's.
// - Turn Bionic Reading On/Off: Reader View's B button, from the keyboard.
// - New Live Folder…: Zen's GitHub/RSS and Whimsy's Jira/Linear live
//   folders, from a menu instead of only the sidebar's context menu.
// - New Folder…, Manage Spaces…, Air Traffic Control…: Zen's own commands,
//   given a bindable Whimsy key (Zen lists none for them) and Arc's names.
// - Add Finder Folder…: the Library's folder picker.
// - Open Claude Space, What's New: switch to Claude's space; open the
//   changelog.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyArcMenus: "resource:///modules/whimsy/WhimsyArcMenus.sys.mjs",
  WhimsyClaude: "resource:///modules/whimsy/WhimsyClaude.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyLiveFolders: "resource:///modules/whimsy/WhimsyLiveFolders.sys.mjs",
  WhimsySpaceArchive: "resource:///modules/whimsy/WhimsySpaceArchive.sys.mjs",
  WhimsyTreeTabs: "resource:///modules/whimsy/WhimsyTreeTabs.sys.mjs",
  gWhimsyFinderFoldersStore: "resource:///modules/whimsy/WhimsyFinderFoldersSection.sys.mjs",
});

const SWITCHER_PREF = "whimsy.spaces.hide-switcher";
const UI_ZOOM_PREF = "whimsy.ui-zoom";
const BACKGROUND_MUTE_PREF = "whimsy.media.background-mute";
const BIONIC_PREF = "whimsy.reader.bionic";
const DARK_PDF_PREF = "whimsy.pdf.dark";
const CHOOSER_ID = "whimsy-command-chooser";
const FINDER_SECTION = "whimsy-finder-folders";
const CHANGELOG_URL = "about:whimsy?tab=changelog";

// Settings → Look and Feel → Zoom's steps, in percent.
export const UI_ZOOM_STEPS = [80, 90, 100, 110, 125, 150, 175, 200];

const ICONS = {
  tree: "chrome://browser/skin/zen-icons/sidebar.svg",
  space: "chrome://browser/skin/zen-icons/selectable/eye.svg",
  zoom: "chrome://browser/skin/zen-icons/search-glass.svg",
  mute: "chrome://browser/skin/zen-icons/media-mute.svg",
  reader: "chrome://browser/skin/zen-icons/reader-mode.svg",
  pdf: "chrome://browser/skin/zen-icons/moon-stars.svg",
  folder: "chrome://browser/skin/zen-icons/folder.svg",
  spaces: "chrome://browser/skin/zen-icons/edit-theme.svg",
  routing: "chrome://browser/skin/zen-icons/forward.svg",
  claude: "chrome://browser/skin/zen-icons/sparkles.svg",
  news: "chrome://browser/skin/zen-icons/history.svg",
};

// Zen's live folder kinds (its own menu's ids, which its command handler
// reads), then Whimsy's: used only if Zen's menu isn't there.
const LIVE_FOLDER_KINDS = [
  { l10nId: "zen-live-folder-github-pull-requests", image: "chrome://browser/skin/zen-icons/selectable/logo-github.svg" },
  { l10nId: "zen-live-folder-github-issues", image: "chrome://browser/skin/zen-icons/selectable/logo-github.svg" },
  { l10nId: "zen-live-folder-type-rss", image: "chrome://browser/skin/zen-icons/selectable/logo-rss.svg" },
  {
    l10nId: "whimsy-live-folder-jira-create",
    image: "chrome://browser/skin/zen-icons/selectable/ticket.svg",
    isAvailable: () => lazy.WhimsyLiveFolders.jiraEnabled,
  },
  {
    l10nId: "whimsy-live-folder-linear-create",
    image: "chrome://browser/skin/zen-icons/selectable/ticket.svg",
    isAvailable: () => lazy.WhimsyLiveFolders.linearEnabled,
  },
];

function feature(id) {
  return Services.prefs.getBoolPref(`whimsy.feature.${id}`, true);
}

// The next Settings zoom step from `current` in `direction` (+1/-1), or
// null at either end.
export function nextZoomStep(current, direction) {
  if (direction > 0) {
    return UI_ZOOM_STEPS.find(step => step > current) ?? null;
  }
  return UI_ZOOM_STEPS.findLast(step => step < current) ?? null;
}

export const WhimsyAccessCommands = {
  // Tree tabs: the tab whose branch the command folds (the current tab,
  // or its parent when it has no children), or null.
  branchTab(win) {
    const tree = lazy.WhimsyTreeTabs;
    const tab = win.gBrowser.selectedTab;
    if (!tree.enabled || !tab) {
      return null;
    }
    if (tree.hasChildren(win, tab)) {
      return tab;
    }
    const parent = tree.openerOf(tab);
    return parent && tree.hasChildren(win, parent) ? parent : null;
  },

  toggleBranch(win) {
    const tab = this.branchTab(win);
    if (!tab) {
      return false;
    }
    lazy.WhimsyTreeTabs.toggleBranch(win, tab);
    return true;
  },

  hiddenSpaces(win) {
    if (!feature("archive-space") || !win.gZenWorkspaces?.workspaceEnabled) {
      return [];
    }
    try {
      return lazy.WhimsySpaceArchive.listHidden(win);
    } catch (e) {
      return [];
    }
  },

  showHiddenSpaces(win) {
    const spaces = this.hiddenSpaces(win);
    if (!spaces.length) {
      return null;
    }
    return this.showChooser(
      win,
      spaces.map(space => {
        // Zen's space icon is an emoji or an icon URL.
        const iconURL = /^[a-z-]+:\/\//.test(space.icon ?? "") ? space.icon : null;
        return {
          label: [iconURL ? null : space.icon, space.name].filter(Boolean).join(" "),
          image: iconURL,
          value: space.uuid,
          run: () => lazy.WhimsySpaceArchive.restore(win, space.uuid),
        };
      })
    );
  },

  switcherHidden() {
    return Services.prefs.getBoolPref(SWITCHER_PREF, false);
  },

  toggleSwitcher() {
    Services.prefs.setBoolPref(SWITCHER_PREF, !this.switcherHidden());
  },

  get uiZoom() {
    return Services.prefs.getIntPref(UI_ZOOM_PREF, 100);
  },

  zoomInterface(direction) {
    const next = direction == 0 ? 100 : nextZoomStep(this.uiZoom, direction);
    if (next == null) {
      return this.uiZoom;
    }
    Services.prefs.setIntPref(UI_ZOOM_PREF, next);
    return next;
  },

  backgroundMuted() {
    return Services.prefs.getStringPref(BACKGROUND_MUTE_PREF, "prioritize") != "off";
  },

  // Off ↔ the default mode (Settings keeps the choice between the two
  // muting modes).
  toggleBackgroundMute() {
    if (this.backgroundMuted()) {
      Services.prefs.setStringPref(BACKGROUND_MUTE_PREF, "off");
      return;
    }
    let mode = "prioritize";
    try {
      mode = Services.prefs.getDefaultBranch("").getStringPref(BACKGROUND_MUTE_PREF, "prioritize");
    } catch (e) {
      // No default: Whimsy's.
    }
    Services.prefs.setStringPref(BACKGROUND_MUTE_PREF, mode == "off" ? "prioritize" : mode);
  },

  inReader(win) {
    return !!win.gBrowser.selectedBrowser?.currentURI?.spec.startsWith("about:reader");
  },

  bionicOn() {
    return Services.prefs.getBoolPref(BIONIC_PREF, false);
  },

  // Flips the saved choice, then tells the open reader page (its B button
  // does the same through the actor's parent).
  toggleBionic(win) {
    const on = !this.bionicOn();
    Services.prefs.setBoolPref(BIONIC_PREF, on);
    try {
      win.gBrowser.selectedBrowser.browsingContext?.currentWindowGlobal
        ?.getActor("WhimsyBionicReading")
        ?.sendAsyncMessage("Whimsy:ApplyBionic", { on });
    } catch (e) {
      // No reader page (or its actor) here; the saved choice still applies
      // to the next one.
    }
    return on;
  },

  darkPdf() {
    return Services.prefs.getBoolPref(DARK_PDF_PREF, false);
  },

  toggleDarkPdf() {
    Services.prefs.setBoolPref(DARK_PDF_PREF, !this.darkPdf());
  },

  liveFoldersAvailable(win) {
    return !!win.document.getElementById("cmd_zenNewLiveFolder") && !!win.gZenFolders;
  },

  // The kinds in the sidebar's New Live Folder menu, as menuitems running
  // Zen's cmd_zenNewLiveFolder, named by the l10n id its handler (and
  // Whimsy's) reads. Taken from that menu after its popupshowing listeners
  // add Whimsy's kinds, so a kind added there shows here too; the fixed
  // list is the fallback.
  liveFolderKinds(win) {
    const menu = win.document.querySelector("#zen-panel-ui-live-folder-create > menupopup");
    if (menu) {
      try {
        menu.dispatchEvent(new win.Event("popupshowing", { bubbles: true }));
      } catch (e) {
        console.error("Whimsy: live folder kinds", e);
      }
      const kinds = [...menu.querySelectorAll(":scope > menuitem[command='cmd_zenNewLiveFolder']")]
        .filter(item => !item.hidden && item.getAttribute("data-l10n-id"))
        .map(item => ({ l10nId: item.getAttribute("data-l10n-id"), image: item.getAttribute("image") }));
      if (kinds.length) {
        return kinds;
      }
    }
    return LIVE_FOLDER_KINDS.filter(kind => kind.isAvailable?.() ?? true);
  },

  newLiveFolder(win) {
    if (!this.liveFoldersAvailable(win)) {
      return null;
    }
    return this.showChooser(
      win,
      this.liveFolderKinds(win).map(kind => ({
        l10nId: kind.l10nId,
        image: kind.image,
        command: "cmd_zenNewLiveFolder",
      }))
    );
  },

  async addFinderFolder(win) {
    if (!feature("finder-folders")) {
      return false;
    }
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    const title = await new Localization(["browser/whimsy.ftl"]).formatValue(
      "whimsy-library-finder-folders-picker-title"
    );
    picker.init(win.browsingContext, title ?? "", picker.modeGetFolder);
    const result = await new Promise(resolve => picker.open(resolve));
    if ((result != picker.returnOK && result != picker.returnReplace) || !picker.file) {
      return false;
    }
    await lazy.gWhimsyFinderFoldersStore.add(picker.file.path);
    lazy.WhimsyArcMenus.openLibrarySection(win, FINDER_SECTION);
    return true;
  },

  claudeSpace(win) {
    try {
      const id = lazy.WhimsyClaude.enabled ? lazy.WhimsyClaude.claudeSpaceId : "";
      return id ? (win.gZenWorkspaces?.getWorkspaces().find(space => space.uuid == id) ?? null) : null;
    } catch (e) {
      return null;
    }
  },

  async openClaudeSpace(win) {
    const space = this.claudeSpace(win);
    if (!space) {
      return false;
    }
    await win.gZenWorkspaces.changeWorkspaceWithID(space.uuid);
    return true;
  },

  whatsNew(win) {
    win.openTrustedLinkIn(CHANGELOG_URL, "tab");
  },

  /**
   * A small menu near the top of the window, centred like the command bar
   * the command was probably run from. Items: { label | l10nId, image,
   * command (a <command> id) | run() }.
   */
  showChooser(win, items) {
    const { document } = win;
    let popup = document.getElementById(CHOOSER_ID);
    if (!popup) {
      popup = document.createXULElement("menupopup");
      popup.id = CHOOSER_ID;
      (document.getElementById("mainPopupSet") ?? document.documentElement).append(popup);
    }
    popup.replaceChildren();
    for (const spec of items) {
      const item = document.createXULElement("menuitem");
      if (spec.l10nId) {
        item.setAttribute("data-l10n-id", spec.l10nId);
      } else {
        item.setAttribute("label", spec.label);
      }
      if (spec.value) {
        item.setAttribute("value", spec.value);
      }
      if (spec.image) {
        item.setAttribute("image", spec.image);
        item.classList.add("menuitem-iconic");
      }
      if (spec.command) {
        item.setAttribute("command", spec.command);
      } else if (spec.run) {
        item.addEventListener("command", () => {
          try {
            spec.run();
          } catch (e) {
            console.error("Whimsy: command menu", e);
          }
        });
      }
      popup.append(item);
    }
    const width = 240;
    const x = win.mozInnerScreenX + Math.max(0, (win.innerWidth - width) / 2);
    const y = win.mozInnerScreenY + Math.min(120, win.innerHeight / 4);
    popup.openPopupAtScreen(x, y, false);
    return popup;
  },

  initWindow(win) {
    // batch8: W8-04: When expanding a parent folder, keep collapsed subfolder containers hidden
    win.addEventListener("TabGroupExpand", event => {
      const group = event.target;
      if (!group?.isZenFolder) return;
      for (const child of group.querySelectorAll("zen-folder[collapsed]")) {
        child.groupContainer?.setAttribute("hidden", "true");
      }
    });

    const { WhimsyCommands } = lazy;
    const register = spec => {
      try {
        WhimsyCommands.register(win, spec);
      } catch (e) {
        console.error(`Whimsy: command ${spec.id}`, e);
      }
    };

    register({
      id: "cmd_whimsyTreeToggleBranch",
      l10nId: "whimsy-action-tree-toggle",
      run: w => this.toggleBranch(w),
      icon: ICONS.tree,
      variants: [
        {
          l10nId: "whimsy-action-tree-collapse",
          isAvailable: w => !!this.branchTab(w) && !this.branchTab(w).hasAttribute("whimsy-tree-collapsed"),
        },
        {
          l10nId: "whimsy-action-tree-expand",
          isAvailable: w => !!this.branchTab(w)?.hasAttribute("whimsy-tree-collapsed"),
        },
      ],
    });
    register({
      id: "cmd_whimsyShowHiddenSpaces",
      l10nId: "whimsy-action-show-hidden-spaces",
      run: w => this.showHiddenSpaces(w),
      icon: ICONS.space,
      isAvailable: w => this.hiddenSpaces(w).length > 0,
    });
    register({
      id: "cmd_whimsyToggleSpaceSwitcher",
      l10nId: "whimsy-action-space-switcher-toggle",
      run: () => feature("hide-switcher") && this.toggleSwitcher(),
      icon: ICONS.space,
      variants: [
        { l10nId: "whimsy-action-space-switcher-show", isAvailable: () => feature("hide-switcher") && this.switcherHidden() },
        { l10nId: "whimsy-action-space-switcher-hide", isAvailable: () => feature("hide-switcher") && !this.switcherHidden() },
      ],
    });
    for (const [id, l10nId, direction, isAvailable] of [
      ["cmd_whimsyZoomInterfaceIn", "whimsy-action-ui-zoom-in", 1, () => nextZoomStep(this.uiZoom, 1) != null],
      ["cmd_whimsyZoomInterfaceOut", "whimsy-action-ui-zoom-out", -1, () => nextZoomStep(this.uiZoom, -1) != null],
      ["cmd_whimsyZoomInterfaceReset", "whimsy-action-ui-zoom-reset", 0, () => this.uiZoom != 100],
    ]) {
      register({
        id,
        l10nId,
        run: () => feature("ui-zoom") && this.zoomInterface(direction),
        icon: ICONS.zoom,
        isAvailable: () => feature("ui-zoom") && isAvailable(),
      });
    }
    register({
      id: "cmd_whimsyToggleBackgroundMute",
      l10nId: "whimsy-action-background-mute-toggle",
      run: () => feature("background-mute") && this.toggleBackgroundMute(),
      icon: ICONS.mute,
      variants: [
        { l10nId: "whimsy-action-background-mute-on", isAvailable: () => feature("background-mute") && !this.backgroundMuted() },
        { l10nId: "whimsy-action-background-mute-off", isAvailable: () => feature("background-mute") && this.backgroundMuted() },
      ],
    });
    register({
      id: "cmd_whimsyToggleBionic",
      l10nId: "whimsy-action-bionic-toggle",
      run: w => feature("bionic-reading") && this.toggleBionic(w),
      icon: ICONS.reader,
      variants: [
        { l10nId: "whimsy-action-bionic-on", isAvailable: w => feature("bionic-reading") && this.inReader(w) && !this.bionicOn() },
        { l10nId: "whimsy-action-bionic-off", isAvailable: w => feature("bionic-reading") && this.inReader(w) && this.bionicOn() },
      ],
    });
    register({
      id: "cmd_whimsyToggleDarkPdf",
      l10nId: "whimsy-action-dark-pdf-toggle",
      run: () => feature("dark-pdf") && this.toggleDarkPdf(),
      icon: ICONS.pdf,
      variants: [
        { l10nId: "whimsy-action-dark-pdf-on", isAvailable: () => feature("dark-pdf") && !this.darkPdf() },
        { l10nId: "whimsy-action-dark-pdf-off", isAvailable: () => feature("dark-pdf") && this.darkPdf() },
      ],
    });
    register({
      id: "cmd_whimsyNewLiveFolder",
      l10nId: "whimsy-action-new-live-folder",
      run: w => this.newLiveFolder(w),
      icon: ICONS.folder,
      isAvailable: w => this.liveFoldersAvailable(w),
    });
    // Zen's commands: a Whimsy key so they can be bound. Zen's command bar
    // already lists New Folder… and Air Traffic Control… (renamed through
    // overlay.py), so only Manage Spaces… is added there.
    register({
      id: "cmd_zenOpenFolderCreation",
      l10nId: "whimsy-action-new-folder",
      keyId: "key_whimsyNewFolder",
      commandBar: false,
    });
    register({
      id: "cmd_zenManageWorkspaces",
      l10nId: "whimsy-action-manage-spaces",
      keyId: "key_whimsyManageSpaces",
      icon: ICONS.spaces,
      isAvailable: w => feature("space-manager-settings") && !!w.gZenWorkspaces?.workspaceEnabled,
    });
    register({
      id: "cmd_zenOpenSpaceRoutingSettings",
      l10nId: "whimsy-action-air-traffic-control",
      keyId: "key_whimsyAirTrafficControl",
      commandBar: false,
    });
    register({
      id: "cmd_whimsyAddFinderFolder",
      l10nId: "whimsy-action-add-finder-folder",
      run: w => this.addFinderFolder(w),
      icon: ICONS.folder,
      isAvailable: () => feature("finder-folders"),
    });
    register({
      id: "cmd_whimsyOpenClaudeSpace",
      l10nId: "whimsy-action-open-claude-space",
      run: w => this.openClaudeSpace(w),
      icon: ICONS.claude,
      isAvailable: w => !!this.claudeSpace(w) && w.gZenWorkspaces?.activeWorkspace != this.claudeSpace(w)?.uuid,
    });
    register({
      id: "cmd_whimsyWhatsNew",
      l10nId: "whimsy-action-whats-new",
      run: w => this.whatsNew(w),
      icon: ICONS.news,
      isAvailable: () => feature("home"),
    });

    // batch8: W8-04 Collapse/Expand All Folders (Arc parity)
    register({
      id: "cmd_whimsyCollapseAllFolders",
      l10nId: "whimsy-action-collapse-all-folders",
      run: w => this.collapseAllFolders(w),
      icon: "chrome://browser/skin/zen-icons/arrows-collapse.svg",
      isAvailable: w => this.hasExpandedFolders(w),
    });
    register({
      id: "cmd_whimsyExpandAllFolders",
      l10nId: "whimsy-action-expand-all-folders",
      run: w => this.expandAllFolders(w),
      icon: "chrome://browser/skin/zen-icons/arrows-expand.svg",
      isAvailable: w => this.hasCollapsedFolders(w),
    });
  },

  hasExpandedFolders(win) {
    return !!win.gZenFolders?.activeSpaceFolders?.some(f => !f.collapsed);
  },

  hasCollapsedFolders(win) {
    return !!win.gZenFolders?.activeSpaceFolders?.some(f => f.collapsed);
  },

  async collapseAllFolders(win) {
    if (win.gZenFolders) {
      await win.gZenFolders.collapseAllFolders();
      for (const folder of win.gZenFolders.activeSpaceFolders) {
        folder.collapsed = true;
      }
    }
  },

  async expandAllFolders(win) {
    if (win.gZenFolders) {
      await win.gZenFolders.expandAllFolders();
      for (const folder of win.gZenFolders.activeSpaceFolders) {
        folder.collapsed = false;
      }
    }
  },
};
