/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// batch3glance: more split layouts (scout batch13 #1), the Arc way. Arc
// doesn't offer layout presets: you build a layout pane by pane with the
// command bar's "Add Right / Left / Top / Bottom Split" (up to four panes,
// any mix of side-by-side and stacked), and a split's menu has "Change
// Orientation" to turn side-by-side into stacked and back.
//
// Zen already has the tree (rows and columns, resizable) and side-by-side,
// stacked and grid presets (command bar "Split Vertically / Horizontally /
// Grid", WhimsySplit). Missing: adding a pane on a chosen side of the
// focused pane once a split exists (Zen's "New Split View" only starts a
// split, on the right) and flipping the orientation. Both reuse Zen's own
// tree operations (splitTabs, removeNode, splitIntoNode, activateSplitView).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.split-layouts";
export const SPLIT_SIDES = ["right", "left", "top", "bottom"];
const installed = new WeakSet();

function enabled() {
  return Services.prefs.getBoolPref(FEATURE_PREF, true);
}

function findLeaf(node, tab) {
  if (!node) {
    return null;
  }
  if (!node.children) {
    return node.tab === tab ? node : null;
  }
  for (const child of node.children) {
    const leaf = findLeaf(child, tab);
    if (leaf) {
      return leaf;
    }
  }
  return null;
}

export const WhimsySplitLayouts = {
  group(win, tab = win.gBrowser.selectedTab) {
    return win.gZenViewSplitter._data.find(group => group.tabs.includes(tab)) ?? null;
  },

  canAddSplit(win) {
    const tab = win.gBrowser.selectedTab;
    if (!enabled() || !tab || tab.hasAttribute("zen-empty-tab") || tab.hasAttribute("zen-glance-tab")) {
      return false;
    }
    const group = this.group(win, tab);
    return !group || group.tabs.length < win.gZenViewSplitter.MAX_TABS;
  },

  // Arc's "Add <side> Split": an empty pane on that side of the focused
  // pane, filled from the URL bar. Escape adds nothing.
  addSplit(win, side) {
    if (!SPLIT_SIDES.includes(side) || !this.canAddSplit(win)) {
      return false;
    }
    const splitter = win.gZenViewSplitter;
    const anchorTab = win.gBrowser.selectedTab;
    if (!anchorTab.splitView) {
      // Starting a split: Zen's own empty-pane flow already takes a side.
      splitter.createEmptySplit(side);
      return true;
    }
    const closeToken = {};
    const controller = new win.AbortController();
    win.addEventListener(
      "ZenURLBarClosed",
      event => {
        if (!win.gZenUIManager.matchesCloseToken(closeToken, event)) {
          return;
        }
        controller.abort();
        const picked = win.gBrowser.selectedTab;
        const group = this.group(win, anchorTab);
        if (
          !event.detail.onElementPicked ||
          !group ||
          picked === anchorTab ||
          picked.splitView ||
          picked.closing ||
          picked.hasAttribute("zen-empty-tab") ||
          picked.getAttribute("zen-workspace-id") !== anchorTab.getAttribute("zen-workspace-id")
        ) {
          return;
        }
        this.insertBeside(win, anchorTab, picked, side);
      },
      { signal: controller.signal }
    );
    // Like Zen's "New Split View": let the command bar that ran this close
    // first, then open the URL bar for the new pane.
    win.setTimeout(() => {
      if (!win.gZenUIManager.handleNewTab(false, false, "tab", true, closeToken)) {
        controller.abort();
      }
    }, 0);
    return true;
  },

  // Puts `tab` into the focused pane's split, on `side` of that pane, taking
  // half of its room (Zen's drag-to-split does the same).
  insertBeside(win, anchorTab, tab, side) {
    const splitter = win.gZenViewSplitter;
    const group = this.group(win, anchorTab);
    if (!group || group.tabs.length >= splitter.MAX_TABS) {
      return null;
    }
    const before = new Set(group.tabs);
    // Zen adds it (or a copy of a pinned tab) at the end of the split.
    splitter.splitTabs([anchorTab, tab], undefined, 1);
    const added = group.tabs.find(t => !before.has(t));
    if (!added) {
      return null;
    }
    const leaf = findLeaf(group.layoutTree, added);
    const anchor = findLeaf(group.layoutTree, anchorTab);
    if (leaf && anchor && leaf.parent) {
      splitter.removeNode(leaf);
      leaf.parent = null;
      leaf.positionToRoot = null;
      splitter.splitIntoNode(anchor, leaf, side, 0.5);
      splitter.activateSplitView(group, true);
    }
    win.gBrowser.selectedTab = added;
    return added;
  },

  // Arc's "Change Orientation": side by side <-> stacked. The whole tree
  // turns, so a grid's rows become columns and every pane keeps its size.
  changeOrientation(win) {
    const group = this.group(win);
    if (!enabled() || !group) {
      return false;
    }
    const turn = node => {
      if (!node?.children) {
        return;
      }
      node.direction = node.direction === "row" ? "column" : "row";
      node.children.forEach(turn);
    };
    turn(group.layoutTree);
    if (group.gridType === "vsep") {
      group.gridType = "hsep";
    } else if (group.gridType === "hsep") {
      group.gridType = "vsep";
    }
    win.gZenViewSplitter.activateSplitView(group, true);
    return true;
  },

  initWindow(win) {
    if (installed.has(win) || !win.gZenViewSplitter) {
      return;
    }
    installed.add(win);
    for (const side of SPLIT_SIDES) {
      lazy.WhimsyCommands.register(win, {
        id: `cmd_whimsyAddSplit-${side}`,
        l10nId: `whimsy-action-add-split-${side}`,
        run: w => this.addSplit(w, side),
        icon: "chrome://browser/skin/zen-icons/split.svg",
        isAvailable: w => this.canAddSplit(w),
      });
    }
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsySplitChangeOrientation",
      l10nId: "whimsy-action-split-change-orientation",
      run: w => this.changeOrientation(w),
      icon: "chrome://browser/skin/zen-icons/split.svg",
      isAvailable: w => enabled() && !!w.gBrowser.selectedTab?.splitView,
    });
  },
};
