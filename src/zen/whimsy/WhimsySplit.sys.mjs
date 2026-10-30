/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// batch6: Split view extras (scout/batch6.md #7, #9, #10, #11). Each part
// checks its own whimsy.feature.<id> switch, so turning one off hands the
// behavior straight back to Zen.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
});

// #7 Open a link in split: Arc's Shift+click opens a link beside the
// current tab instead of navigating it away. Shift+click is Firefox's own
// "open in new window", so this only runs the link through to a split when
// the user has explicitly turned it on (default off); the WhimsyPage actor
// does the in-page detection (see WhimsyPageChild/Parent) and calls
// openLinkInSplit below.
const LINK_FEATURE_PREF = "whimsy.feature.split-link-click";
export const SHIFT_CLICK_PREF = "whimsy.splitlink.shift-click";

// #9 Close every other pane, keeping the selected one full-width (Arc's
// pane menu "Close other split views"). Removing tabs one at a time lets
// Zen's own removeTabFromGroup collapse the group once one tab is left.
const CLOSE_OTHERS_FEATURE_PREF = "whimsy.feature.split-close-other-panes";

// #10 Swap the focused pane with its neighbor (Vivaldi's "Swap tiles").
const SWAP_FEATURE_PREF = "whimsy.feature.split-swap-panes";

// #11 Split actions in the command bar: "Split Vertically / Horizontally /
// Grid" run Zen's own toggleShortcut, which already splits the
// multiselected tabs, or the selected tab and the next one.
const COMMAND_BAR_FEATURE_PREF = "whimsy.feature.split-command-bar";

// fixD: Splits of up to four panes (Zen's MAX_TABS). Zen caps a split at
// four because its layouts (side by side, stacked, a 2x2 grid) stop being
// usable past that; Zen issue #10080 asked for more and was closed. Whimsy
// keeps the cap and fixes the two ways it got in the way below four or at it:
// - Split Vertically / Horizontally / Grid (shortcut or command bar) inside a
//   split paired the current pane with the next tab in the list. From the
//   last pane that's a tab outside the split, so a 4-pane split answered
//   "Can't add more panels" and a smaller one swallowed an unrelated tab
//   instead of changing its layout. Now a layout change re-lays out the
//   panes you have; the same layout again still adds the next tab while
//   there's room (Zen's behavior).
// - Dropping a tab onto a tab in the sidebar splits them, but Zen refused
//   tabs already in a split (it only knew how to make a new 2-pane split).
//   Two hotfixes in whimsy/overlay.py ask gZenViewSplitter's
//   whimsyCanDropIntoSplit/whimsyDropIntoSplit (set below), so the third
//   and fourth tab join the split beside the pane you drop on.
const FOUR_PANES_FEATURE_PREF = "whimsy.feature.split-four-panes";

function enabled(pref) {
  return Services.prefs.getBoolPref(pref, true);
}

function findLeaf(node, tab) {
  if (!node) {
    return null;
  }
  if (node.tab === tab) {
    return node;
  }
  for (const child of node.children ?? []) {
    const found = findLeaf(child, tab);
    if (found) {
      return found;
    }
  }
  return null;
}

function hasActiveSplit(win) {
  return !!win.gBrowser.selectedTab?.splitView;
}

export const WhimsySplit = {
  // Called by WhimsyPageParent when the page actor reports a Shift+click on
  // a link. Opens the link next to the clicked tab, as a 2-pane split.
  openLinkInSplit(win, tab, href, triggeringPrincipal) {
    if (!enabled(LINK_FEATURE_PREF) || !enabled(SHIFT_CLICK_PREF)) {
      return false;
    }
    const splitter = win.gZenViewSplitter;
    const currentTab = win.gZenGlanceManager?.getTabOrGlanceParent(tab) ?? tab;
    const newTab = splitter.openAndSwitchToTab(href, {
      skipRoute: true,
      inBackground: false,
      triggeringPrincipal,
    });
    if (!newTab) {
      return false;
    }
    splitter.splitTabs([currentTab, newTab], undefined, 1);
    return true;
  },

  closeOtherPanes(win) {
    const splitter = win.gZenViewSplitter;
    const tab = win.gBrowser.selectedTab;
    const groupIndex = splitter._data.findIndex(group => group.tabs.includes(tab));
    if (groupIndex < 0) {
      return;
    }
    for (const other of splitter._data[groupIndex].tabs.filter(t => t !== tab)) {
      win.gBrowser.removeTab(other);
    }
  },

  swapPanes(win) {
    const splitter = win.gZenViewSplitter;
    const group = splitter._data.find(group => group.tabs.includes(win.gBrowser.selectedTab));
    if (!group) {
      return;
    }
    const node = splitter.getSplitNodeFromTab(win.gBrowser.selectedTab);
    if (!node?.parent) {
      return;
    }
    const siblings = node.parent.children;
    if (siblings.length < 2) {
      return;
    }
    const idx = siblings.indexOf(node);
    splitter.swapNodes(node, siblings[(idx + 1) % siblings.length]);
    splitter.applyGridLayout(group.layoutTree);
  },

  // The split the selected tab is in, if the user asks for a layout that
  // should re-lay it out rather than pull in another tab.
  relayoutTarget(win, gridType) {
    const splitter = win.gZenViewSplitter;
    const selected = win.gBrowser.selectedTab;
    if (!enabled(FOUR_PANES_FEATURE_PREF) || gridType == "unsplit" || selected?.multiselected) {
      return null;
    }
    const group = splitter._data.find(g => g.tabs.includes(selected));
    if (!group) {
      return null;
    }
    const full = group.tabs.length >= splitter.MAX_TABS;
    return group.gridType != gridType || full ? group : null;
  },

  relayout(win, group, gridType) {
    const splitter = win.gZenViewSplitter;
    group.gridType = gridType;
    group.layoutTree = splitter.calculateLayoutTree(group.tabs, gridType);
    // Session store reads the layout from _data when it saves. No
    // ZenSplitViewTabsSplit event: window sync would re-split a full split
    // in the other windows and show them Zen's limit toast.
    splitter.activateSplitView(group, true);
  },

  wrapToggleShortcut(win) {
    const splitter = win.gZenViewSplitter;
    const original = splitter?.toggleShortcut;
    if (typeof original != "function" || original._whimsy) {
      return;
    }
    const self = this;
    const wrapped = function (gridType) {
      try {
        const group = self.relayoutTarget(win, gridType);
        if (group) {
          self.relayout(win, group, gridType);
          return undefined;
        }
      } catch (e) {
        console.error("Whimsy: split layout", e);
      }
      return original.call(this, gridType);
    };
    wrapped._whimsy = true;
    splitter.toggleShortcut = wrapped;
  },

  // Asked by Zen's sidebar drag code (hotfix): can this tab join the split
  // that dropElement is a pane of?
  canDropIntoSplit(win, dropElement, draggedTab) {
    if (!enabled(FOUR_PANES_FEATURE_PREF) || !draggedTab || draggedTab.hasAttribute("zen-essential")) {
      return false;
    }
    const splitter = win.gZenViewSplitter;
    const group = splitter._data.find(g => g.tabs.includes(dropElement));
    return !!group && !group.tabs.includes(draggedTab) && group.tabs.length < splitter.MAX_TABS;
  },

  // Adds draggedTab to droppedOnTab's split, on dropSide ("left"/"right")
  // of that pane. Returns false to leave the drop to Zen (no split there).
  dropIntoSplit(win, draggedTab, droppedOnTab, dropSide, activate = true) {
    if (!this.canDropIntoSplit(win, droppedOnTab, draggedTab)) {
      return false;
    }
    const splitter = win.gZenViewSplitter;
    const group = splitter._data.find(g => g.tabs.includes(droppedOnTab));
    const before = new Set(group.tabs);
    // Zen's own path for adding to a split (moves the tab into the split's
    // group, pins/duplicates like the split, appends a pane at the end).
    splitter.splitTabs([droppedOnTab, draggedTab], undefined, -1, { activate: false });
    const added = group.tabs.find(t => !before.has(t));
    if (!added) {
      return true;
    }
    // Move the new pane next to the one it was dropped on.
    const leaf = findLeaf(group.layoutTree, added);
    const target = findLeaf(group.layoutTree, droppedOnTab);
    if (leaf && target && leaf.parent) {
      splitter.removeNode(leaf);
      splitter.splitIntoNode(target, leaf, dropSide == "left" ? "left" : "right", 0.5);
    }
    if (activate) {
      if (win.gBrowser.selectedTab != added) {
        win.gBrowser.selectedTab = added;
      }
      splitter.activateSplitView(group, true);
    } else if (splitter._data[splitter.currentView] === group) {
      splitter.activateSplitView(group, true);
    }
    return true;
  },

  initWindow(win) {
    const { WhimsyShortcuts } = lazy;

    this.wrapToggleShortcut(win);
    if (win.gZenViewSplitter) {
      win.gZenViewSplitter.whimsyCanDropIntoSplit = (dropElement, draggedTab) => {
        try {
          return this.canDropIntoSplit(win, dropElement, draggedTab);
        } catch (e) {
          console.error("Whimsy: split drop", e);
          return false;
        }
      };
      win.gZenViewSplitter.whimsyDropIntoSplit = (draggedTab, droppedOnTab, dropSide, activate) => {
        try {
          return this.dropIntoSplit(win, draggedTab, droppedOnTab, dropSide, activate);
        } catch (e) {
          console.error("Whimsy: split drop", e);
          return false;
        }
      };
    }

    // #9
    WhimsyShortcuts.addCommand(win, {
      id: "cmd_whimsyCloseOtherPanes",
      run: w => this.closeOtherPanes(w),
      key: { id: "key_whimsyCloseOtherPanes", key: "W", modifiers: "accel,alt,shift" },
    });
    // #10
    WhimsyShortcuts.addCommand(win, {
      id: "cmd_whimsySwapPanes",
      run: w => this.swapPanes(w),
      key: { id: "key_whimsySwapPanes", key: "S", modifiers: "accel,alt,shift" },
    });

    WhimsyShortcuts.addActions([
      {
        l10nId: "whimsy-action-close-other-panes",
        command: "cmd_whimsyCloseOtherPanes",
        icon: "chrome://browser/skin/zen-icons/close.svg",
        isAvailable: w => enabled(CLOSE_OTHERS_FEATURE_PREF) && hasActiveSplit(w),
      },
      {
        l10nId: "whimsy-action-swap-panes",
        command: "cmd_whimsySwapPanes",
        icon: "chrome://browser/skin/zen-icons/split.svg",
        isAvailable: w => enabled(SWAP_FEATURE_PREF) && hasActiveSplit(w),
      },
      {
        l10nId: "whimsy-action-split-vertically",
        command: w => w.gZenViewSplitter.toggleShortcut("vsep"),
        icon: "chrome://browser/skin/zen-icons/split.svg",
        isAvailable: w => enabled(COMMAND_BAR_FEATURE_PREF) && w.gBrowser.visibleTabs.length >= 2,
      },
      {
        l10nId: "whimsy-action-split-horizontally",
        command: w => w.gZenViewSplitter.toggleShortcut("hsep"),
        icon: "chrome://browser/skin/zen-icons/split.svg",
        isAvailable: w => enabled(COMMAND_BAR_FEATURE_PREF) && w.gBrowser.visibleTabs.length >= 2,
      },
      {
        l10nId: "whimsy-action-split-grid",
        command: w => w.gZenViewSplitter.toggleShortcut("grid"),
        icon: "chrome://browser/skin/zen-icons/split.svg",
        isAvailable: w => enabled(COMMAND_BAR_FEATURE_PREF) && w.gBrowser.visibleTabs.length >= 2,
      },
    ]);
  },
};
