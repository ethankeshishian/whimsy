/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spaces (Arc parity). Zen's code is wrapped or listened to, never edited.
//
// Drop tabs on space icons (whimsy.feature.space-icon-drop): in Arc you drag
// a tab onto a space's icon at the bottom of the sidebar to send it there.
// Zen already switches to a space while a dragged tab hovers its icon, but
// letting go on the icon itself did nothing. Now the icon lights up as a
// drop target, and dropping moves the tab (every selected tab, or a folder)
// into that space, switches there, bounces the icon and confirms with a
// toast.
//
// Last tab per space (whimsy.feature.space-last-tab): switching back to a
// space returns to the tab you were last on there. Zen remembers that only
// for the session, so after a restart (or once that tab was closed) it fell
// back to the space's first tab. Now the fallback is the space's most
// recently used tab (tab.lastAccessed, which the session keeps).
//
// Emoji search (whimsy.feature.emoji-search): Zen's space icon picker
// already has a search field, matching one word against each emoji's tags.
// Slack- and Notion-style pickers go further: every word you type must
// match ("red heart", "cat face"), Enter picks the first result, and an
// empty result says so instead of showing a blank grid.
//
// Hide the space switcher (whimsy.spaces.hide-switcher, whimsy-browser.css):
// for people who switch spaces by swiping or shortcut and want the sidebar's
// foot clear. While a tab is dragged the switcher comes back, so dropping
// on a space still works ([whimsy-tab-dragging], set here).
//
// Open Link in Space (whimsy.feature.open-link-in-space): Arc's link menu
// can send a link straight to another space, so a work link clicked in a
// personal space opens where it belongs. Right-click a link > Open Link in
// Space > (each other space, with its icon): the link opens there, in that
// space's container, and you land on it. Zen already moves existing tabs
// (tab menu > Move To).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyProfileMoves: "resource:///modules/whimsy/WhimsyProfileMoves.sys.mjs",
});

const TAB_DROP_TYPE = "application/x-moz-tabbrowser-tab";
let moveToLabel = null; // "Move to", before the space's name in the command bar
const DROP_FEATURE_PREF = "whimsy.feature.space-icon-drop";
const LAST_TAB_FEATURE_PREF = "whimsy.feature.space-last-tab";
const DROP_TARGET_ATTR = "whimsy-drop-target";
const LANDED_ATTR = "whimsy-landed";
const EMOJI_FEATURE_PREF = "whimsy.feature.emoji-search";
const EMOJI_EMPTY_ID = "whimsy-emoji-search-empty";
const LINK_FEATURE_PREF = "whimsy.feature.open-link-in-space";
const LINK_MENU_ID = "context-whimsyOpenLinkInSpace";

function featureOn(pref) {
  return Services.prefs.getBoolPref(pref, true);
}

export const WhimsySpaces = {
  initWindow(win) {
    if (!win.gZenWorkspaces?.workspaceEnabled) {
      return;
    }
    this.initCommands(win);
    this.initIconDrop(win);
    this.initLastTab(win);
    this.initEmojiSearch(win);
    this.initTabDragging(win);
    this.initOpenLinkInSpace(win);
  },

  initCommands(win) {
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyMoveTabToNextSpace",
      l10nId: "whimsy-action-move-tab-next-space",
      whimsyKeywords: ["Move Tab to Next Space", "Move to Next Space", "Send Tab to Next Space"],
      run: w => this.moveTabRelative(w, 1),
      icon: "chrome://browser/skin/zen-icons/forward.svg",
      isAvailable: w =>
        (w.gZenWorkspaces?._workspaceCache?.length ?? 0) > 1 &&
        !w.gBrowser.selectedTab?.hasAttribute("zen-essential"),
    });
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyMoveTabToPrevSpace",
      l10nId: "whimsy-action-move-tab-prev-space",
      whimsyKeywords: ["Move Tab to Previous Space", "Move to Previous Space", "Send Tab to Previous Space"],
      run: w => this.moveTabRelative(w, -1),
      icon: "chrome://browser/skin/zen-icons/back.svg",
      isAvailable: w =>
        (w.gZenWorkspaces?._workspaceCache?.length ?? 0) > 1 &&
        !w.gBrowser.selectedTab?.hasAttribute("zen-essential"),
    });

    this.syncSpaceActions(win);
    win.gURLBar?.addEventListener("focus", () => this.syncSpaceActions(win));
  },

  moveTabRelative(win, direction = 1) {
    const spaces = win.gZenWorkspaces?.getWorkspaces();
    if (!spaces || spaces.length <= 1) {
      return;
    }
    const currentId = win.gZenWorkspaces.activeWorkspace;
    const currentIndex = spaces.findIndex(s => s.uuid == currentId);
    if (currentIndex == -1) {
      return;
    }
    const targetIndex = (currentIndex + direction + spaces.length) % spaces.length;
    const targetSpace = spaces[targetIndex];
    if (targetSpace && targetSpace.uuid != currentId) {
      const tab = win.gBrowser.selectedTab;
      if (tab && !tab.hasAttribute("zen-essential")) {
        this.moveToSpace(win, tab, targetSpace.uuid);
      }
    }
  },

  syncSpaceActions(win) {
    const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
    const spaces = win.gZenWorkspaces?.getWorkspaces() || [];
    for (const workspace of spaces) {
      const commandId = `whimsy:move-to-space-${workspace.uuid}`;
      if (globalActions.some(a => a.commandId == commandId)) {
        continue;
      }
      globalActions.push({
        l10nId: `whimsy-move-to-space-${workspace.uuid}`,
        get label() {
          moveToLabel ??= new Localization(["browser/whimsy.ftl"], true).formatValueSync("whimsy-action-move-to");
          return moveToLabel;
        },
        extraPayload: {
          workspaceId: workspace.uuid,
          get prettyName() {
            return win.gZenWorkspaces?.getWorkspaces().find(w => w.uuid == workspace.uuid)?.name || workspace.name;
          },
          get prettyIcon() {
            return win.gZenWorkspaces?.getWorkspaces().find(w => w.uuid == workspace.uuid)?.icon || workspace.icon;
          },
          get accentColor() {
            return win.gZenWorkspaces
              ?.workspaceElement(workspace.uuid)
              ?.style.getPropertyValue("--zen-primary-color");
          },
        },
        whimsyKeywords: [
          "Move",
          "Move to",
          "Move tab",
          "Move tab to",
          "Move to Space",
        ],
        commandId,
        icon: "chrome://browser/skin/zen-icons/arrow-right.svg",
        isAvailable: w => {
          const ws = w.gZenWorkspaces;
          if (!ws?.workspaceEnabled || ws.privateWindowOrDisabled) {
            return false;
          }
          const tab = w.gBrowser?.selectedTab;
          if (!tab || tab.hasAttribute("zen-essential")) {
            return false;
          }
          const exists = ws.getWorkspaces().some(s => s.uuid == workspace.uuid);
          return exists && ws.activeWorkspace != workspace.uuid;
        },
        command: w => {
          const tab = w.gBrowser?.selectedTab;
          if (tab && !tab.hasAttribute("zen-essential")) {
            this.moveToSpace(w, tab, workspace.uuid);
          }
        },
      });
    }
  },

  // --- Drop tabs on space icons ---

  // The dragged tab or folder label, if it can move to another space.
  draggedItem(win, event) {
    const dt = event.dataTransfer;
    if (!dt || dt.mozTypesAt(0)[0] != TAB_DROP_TYPE) {
      return null;
    }
    const item = dt.mozGetDataAt(TAB_DROP_TYPE, 0);
    if (!item || item.documentGlobal != win || item.hasAttribute("zen-essential")) {
      return null;
    }
    const { gBrowser } = win;
    if (gBrowser.isTab(item) || gBrowser.isTabGroupLabel?.(item)) {
      return item;
    }
    return null;
  },

  initIconDrop(win) {
    const icons = win.document.getElementById("zen-workspaces-button");
    if (!icons) {
      return;
    }
    let highlighted = null;
    const highlight = button => {
      if (highlighted == button) {
        return;
      }
      highlighted?.removeAttribute(DROP_TARGET_ATTR);
      highlighted = button;
      button?.setAttribute(DROP_TARGET_ATTR, "");
    };
    const buttonFor = event => event.target.closest?.("toolbarbutton[zen-workspace-id]");

    icons.addEventListener("dragover", event => {
      const button = buttonFor(event);
      if (!featureOn(DROP_FEATURE_PREF) || !button || !this.draggedItem(win, event)) {
        highlight(null);
        return;
      }
      // Accept the drop here; Zen's own listener still switches spaces.
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      highlight(button);
    });
    icons.addEventListener("dragleave", event => {
      if (highlighted && !highlighted.contains(event.relatedTarget)) {
        highlight(null);
      }
    });
    icons.addEventListener("drop", event => {
      const button = buttonFor(event);
      const item = this.draggedItem(win, event);
      highlight(null);
      if (!featureOn(DROP_FEATURE_PREF) || !button || !item) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.moveToSpace(win, item, button.getAttribute("zen-workspace-id"));
    });
    win.addEventListener("dragend", () => highlight(null), true);
  },

  // Moves a dragged tab (with the other selected tabs) or folder into a
  // space, switches there and selects it.
  async moveToSpace(win, item, spaceId) {
    const { gBrowser, gZenWorkspaces, gZenFolders } = win;
    const space = gZenWorkspaces.getWorkspaces().find(w => w.uuid == spaceId);
    if (!space) {
      return;
    }
    let count = 1;
    if (gBrowser.isTab(item)) {
      const selected = gBrowser.selectedTabs;
      let tabs =
        item._dragData?.movingTabs ?? (selected.length > 1 && selected.includes(item) ? selected : [item]);
      tabs = tabs.filter(tab => !tab.hasAttribute("zen-essential"));
      count = tabs.length;
      gZenWorkspaces.moveTabsToWorkspace(tabs, spaceId);
      // wave8/isolation: a tab of another profile is held back (and may be
      // reopened); only a tab that really moved is the space's pick.
      if (item.getAttribute("zen-workspace-id") == spaceId) {
        gZenWorkspaces.lastSelectedWorkspaceTabs[spaceId] = win.gZenGlanceManager?.getTabOrGlanceParent(item) ?? item;
      }
    } else {
      gZenFolders.changeFolderToSpace(item.group, spaceId, { hasDndSwitch: gZenWorkspaces.activeWorkspace == spaceId });
    }
    if (gZenWorkspaces.activeWorkspace != spaceId) {
      await gZenWorkspaces.changeWorkspace(space);
    }
    // Zen may still be finishing the switch it began on hover; select the
    // tab once it's done, or Zen's own pick would win.
    for (let i = 0; i < 40 && gZenWorkspaces._animatingChange; i++) {
      await new Promise(resolve => win.setTimeout(resolve, 50));
    }
    // The tab, or the one that replaced it in the new profile.
    const landed = gBrowser.isTab(item) ? lazy.WhimsyProfileMoves.replacementOf(item) : null;
    if (landed && !landed.closing && landed.isConnected && gBrowser.selectedTab != landed &&
        landed.getAttribute("zen-workspace-id") == spaceId) {
      gBrowser.selectedTab = landed;
    }
    gZenWorkspaces.updateTabsContainers?.();
    this.land(win, spaceId);
    win.gZenUIManager?.showToast?.("whimsy-space-drop-toast", {
      l10nArgs: { count, space: space.name || "" },
    });
  },

  // A short bounce on the icon that received the drop.
  land(win, spaceId) {
    const button = win.document.querySelector(`#zen-workspaces-button toolbarbutton[zen-workspace-id="${spaceId}"]`);
    if (!button) {
      return;
    }
    button.removeAttribute(LANDED_ATTR);
    // Restart the animation if it's still playing.
    void button.getBoundingClientRect();
    button.setAttribute(LANDED_ATTR, "");
    win.setTimeout(() => button.removeAttribute(LANDED_ATTR), 400);
  },

  // --- Last tab per space ---

  // The tab to return to in a space: the most recently used one there,
  // never an Essential (Zen never selects those on a switch) or Zen's empty
  // placeholder.
  recentTabIn(win, spaceId) {
    let best = null;
    for (const tab of win.gBrowser.tabs) {
      if (
        tab.closing ||
        tab.getAttribute("zen-workspace-id") != spaceId ||
        tab.hasAttribute("zen-essential") ||
        tab.hasAttribute("zen-empty-tab") ||
        tab.hasAttribute("zen-glance-tab")
      ) {
        continue;
      }
      if (!best || tab.lastAccessed > best.lastAccessed) {
        best = tab;
      }
    }
    return best;
  },

  initLastTab(win) {
    const workspaces = win.gZenWorkspaces;
    const original = workspaces._handleTabSelection;
    if (typeof original != "function" || original._whimsy) {
      return;
    }
    const self = this;
    const wrapped = function (workspace, onInit, previousWorkspaceId) {
      try {
        if (featureOn(LAST_TAB_FEATURE_PREF) && workspace?.uuid && !onInit) {
          const remembered = this.lastSelectedWorkspaceTabs[workspace.uuid];
          // An Essential you were on stays Zen's call; a tab that was closed
          // or moved to another space doesn't count.
          const stale =
            !remembered ||
            remembered.closing ||
            !remembered.isConnected ||
            (!remembered.hasAttribute("zen-essential") &&
              remembered.getAttribute("zen-workspace-id") != workspace.uuid);
          if (stale) {
            const recent = self.recentTabIn(win, workspace.uuid);
            if (recent) {
              this.lastSelectedWorkspaceTabs[workspace.uuid] = recent;
            }
          }
        }
      } catch (e) {
        console.error("Whimsy: last tab per space", e);
      }
      return original.call(this, workspace, onInit, previousWorkspaceId);
    };
    wrapped._whimsy = true;
    workspaces._handleTabSelection = wrapped;
  },

  // --- Emoji search ---

  // Whether an emoji's tags match every word of the query.
  emojiMatches(emoji, words) {
    return words.every(word => emoji.emoji == word || emoji.tags.some(tag => tag.toLowerCase().includes(word)));
  },

  initEmojiSearch(win) {
    const { document } = win;
    const input = document.getElementById("PanelUI-zen-emojis-picker-search");
    const list = document.getElementById("PanelUI-zen-emojis-picker-list");
    if (!input || !list) {
      return;
    }
    const visible = () => [...list.children].filter(button => !button.hidden);
    const updateEmpty = query => {
      let empty = document.getElementById(EMOJI_EMPTY_ID);
      const show = !!query && !visible().length;
      if (show && !empty) {
        empty = document.createXULElement("label");
        empty.id = EMOJI_EMPTY_ID;
        list.after(empty);
      }
      if (empty) {
        empty.hidden = !show;
        if (show) {
          document.l10n.setAttributes(empty, "whimsy-emoji-search-empty", { query });
        }
      }
    };
    // Runs after Zen's own listener (added earlier), refining its result.
    input.addEventListener("input", () => {
      // wave3/icons: with a skin tone (WhimsySpaceIcons.sys.mjs) a button's
      // label isn't the emoji in Zen's data, so Zen's search hides it; the
      // emoji it shows in a tone is in whimsy-base, and this search redoes
      // Zen's (one phrase) when the emoji search switch is off.
      const toned = list.hasAttribute("whimsy-skin-tone");
      const searchOn = featureOn(EMOJI_FEATURE_PREF);
      if (!searchOn && !toned) {
        return;
      }
      const query = input.value.trim();
      const words = searchOn
        ? query.toLowerCase().split(/\s+/).filter(Boolean)
        : [query.toLowerCase()].filter(Boolean);
      const emojis = win.gZenEmojiPicker?._emojis;
      if ((words.length > 1 || toned) && emojis) {
        const byChar = new Map(emojis.map(e => [e.emoji, e]));
        for (const button of list.children) {
          const emoji = byChar.get(button.getAttribute("whimsy-base") || button.getAttribute("label"));
          button.hidden = !emoji || !this.emojiMatches(emoji, words);
          if (emoji) {
            button.style.order = emoji.order;
          }
        }
      }
      if (searchOn) {
        updateEmpty(query);
      }
    });
    input.addEventListener("keydown", event => {
      if (event.key != "Enter" || !featureOn(EMOJI_FEATURE_PREF) || !input.value.trim()) {
        return;
      }
      // The first result in display order.
      const first = visible().sort((a, b) => (parseInt(a.style.order) || 0) - (parseInt(b.style.order) || 0))[0];
      if (first) {
        event.preventDefault();
        first.doCommand();
      }
    });
    document.getElementById("PanelUI-zen-emojis-picker")?.addEventListener("popupshowing", event => {
      if (event.target.id == "PanelUI-zen-emojis-picker") {
        updateEmpty("");
      }
    });
  },

  // --- Hide the space switcher ---

  initTabDragging(win) {
    const root = win.document.documentElement;
    win.addEventListener(
      "dragstart",
      event => {
        if (event.dataTransfer?.mozTypesAt(0)[0] == TAB_DROP_TYPE) {
          root.setAttribute("whimsy-tab-dragging", "");
        }
      },
      true
    );
    const done = () => root.removeAttribute("whimsy-tab-dragging");
    win.addEventListener("dragend", done, true);
    win.addEventListener("drop", () => win.setTimeout(done, 0), true);
  },

  // --- Open Link in Space ---

  initOpenLinkInSpace(win) {
    const menu = win.document.getElementById("contentAreaContextMenu");
    // nsContextMenu has set up its items by now (its handler is inline).
    menu?.addEventListener("popupshowing", event => {
      if (event.target == menu) {
        this.updateLinkMenu(win);
      }
    });
  },

  updateLinkMenu(win) {
    const { document, gZenWorkspaces } = win;
    let item = document.getElementById(LINK_MENU_ID);
    const openInTab = document.getElementById("context-openlinkintab");
    const others = gZenWorkspaces.getWorkspaces().filter(w => w.uuid != gZenWorkspaces.activeWorkspace);
    const show =
      featureOn(LINK_FEATURE_PREF) &&
      !gZenWorkspaces.privateWindowOrDisabled &&
      !!win.gContextMenu?.onLink &&
      !!openInTab &&
      !openInTab.hidden &&
      others.length > 0;
    if (!show) {
      if (item) {
        item.hidden = true;
      }
      return;
    }
    if (!item) {
      item = document.createXULElement("menu");
      item.id = LINK_MENU_ID;
      item.className = "context-menu-open-link";
      document.l10n.setAttributes(item, "whimsy-open-link-in-space");
      const popup = document.createXULElement("menupopup");
      popup.addEventListener("command", event => {
        const uuid = event.target.getAttribute("zen-workspace-id");
        if (uuid) {
          this.openLinkInSpace(win, uuid);
        }
      });
      item.appendChild(popup);
      const anchor =
        document.getElementById("context-openlinkinusercontext-menu") ?? openInTab;
      anchor.after(item);
    }
    item.hidden = false;
    const items = others.map(space => {
      const option = gZenWorkspaces.generateMenuItemForWorkspace(space, true);
      option.classList.remove("zen-workspace-context-menu-item");
      return option;
    });
    item.menupopup.replaceChildren(...items);
  },

  // Opens the context menu's link in a space: in that space's container,
  // then switches there and selects it.
  openLinkInSpace(win, uuid) {
    const { gZenWorkspaces, gBrowser } = win;
    const context = win.gContextMenu;
    const space = gZenWorkspaces.getWorkspaces().find(w => w.uuid == uuid);
    if (!context?.linkURL || !space) {
      return;
    }
    const params = context._openLinkInParameters({
      userContextId: space.containerTabId || 0,
      inBackground: true,
      resolveOnNewTabCreated: browser => {
        const tab = gBrowser.getTabForBrowser(browser);
        if (!tab) {
          return;
        }
        // The container is the space's default, not one the link asked for:
        // mark it the way Zen marks its own new tabs in a space, so Zen hides
        // the container's colour line (zen.workspaces.hide-default-container-
        // indicator) instead of drawing it as a stray border on the tab.
        if (space.containerTabId) {
          tab.setAttribute("zenDefaultUserContextId", "true");
        }
        gZenWorkspaces.moveTabToWorkspace(tab, uuid);
        gZenWorkspaces.lastSelectedWorkspaceTabs[uuid] = tab;
        gZenWorkspaces.changeWorkspace(space).then(() => {
          if (!tab.closing) {
            gBrowser.selectedTab = tab;
          }
        });
      },
    });
    win.openLinkIn(context.linkURL, "tab", params);
  },
};
