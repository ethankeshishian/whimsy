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

function enabled(pref) {
  return Services.prefs.getBoolPref(pref, true);
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
    if (splitter.currentView < 0) {
      return;
    }
    const group = splitter._data[splitter.currentView];
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

  initWindow(win) {
    const { WhimsyShortcuts } = lazy;

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
