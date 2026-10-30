/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// batch3glance: splits come back whole when a window is restored (restart,
// a reopened window, or a window's session restored into a new one; scout
// batch6 #12, zen#12403 "Restoring Split Tabs Ignored": a 3-pane split came
// back showing only its last tab).
//
// Zen restores a split's saved layout tree by looking up each pane's tab by
// its saved id. When an id isn't found (or Zen swapped a pinned tab for a
// copy while re-splitting), that pane silently drops out of the tree, so the
// panes left in the split no longer match the tree and only some are drawn.
// A Whimsy hotfix in ZenViewSplitter.restoreDataFromSessionStore (see
// whimsy/overlay.py) passes the restored tree through layoutFor(): a tree
// that holds exactly the split's tabs is kept, sizes and all; anything else
// is rebuilt from the split's tabs in its saved arrangement, so every pane
// shows.

const FEATURE_PREF = "whimsy.feature.split-restore";

function leafTabs(node, out = []) {
  if (!node) {
    return out;
  }
  if (node.children) {
    for (const child of node.children) {
      leafTabs(child, out);
    }
  } else {
    out.push(node.tab);
  }
  return out;
}

export const WhimsySplitRestore = {
  // True when `layout` draws every tab of the split exactly once, and only
  // those tabs, with no empty or single-child splitter left behind.
  layoutMatches(layout, tabs) {
    const leaves = leafTabs(layout);
    if (leaves.length !== tabs.length || new Set(leaves).size !== leaves.length) {
      return false;
    }
    if (!leaves.every(tab => tab && tabs.includes(tab))) {
      return false;
    }
    const wellFormed = node => !node.children || (node.children.length >= 2 && node.children.every(wellFormed));
    return wellFormed(layout);
  },

  // Called by the hotfixed restore with Zen's deserialized tree.
  layoutFor(layout, splitData, splitter) {
    if (!Services.prefs.getBoolPref(FEATURE_PREF, true) || this.layoutMatches(layout, splitData.tabs)) {
      return layout;
    }
    console.warn("Whimsy: a restored split's saved layout didn't match its tabs; rebuilt it (zen#12403)");
    return splitter.calculateLayoutTree(splitData.tabs, splitData.gridType);
  },
};
