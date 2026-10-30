/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// batch3glance: a split restored into a new window comes back whole: every
// pane, its resized layout and its arrangement. And when the saved layout
// lost a pane (zen#12403), the restored split still shows all its tabs.

const { SessionStore } = ChromeUtils.importESModule("resource:///modules/sessionstore/SessionStore.sys.mjs");
const { TabStateFlusher } = ChromeUtils.importESModule("resource:///modules/sessionstore/TabStateFlusher.sys.mjs");
const { WhimsySplitRestore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySplitRestore.sys.mjs");

function leaves(node, out = []) {
  if (node.children) {
    node.children.forEach(child => leaves(child, out));
  } else {
    out.push(node);
  }
  return out;
}

// A 3-pane split, resized: the first pane wide, the other two narrow.
async function makeSplit() {
  const tabs = [];
  for (let i = 0; i < 3; i++) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, `https://example.com/?pane=${i}`));
  }
  const group = gZenViewSplitter.splitTabs(tabs, "vsep", 0);
  await TestUtils.waitForCondition(() => tabs.every(t => t.splitView), "Split active");
  const [first, second, third] = group.layoutTree.children;
  first.sizeInParent = 50;
  second.sizeInParent = 25;
  third.sizeInParent = 25;
  gZenViewSplitter.activateSplitView(group, true);
  return { tabs, group };
}

// This window's saved state, cut down to just the split's tabs.
async function savedSplitState(tabs, group) {
  await Promise.all(tabs.map(t => TabStateFlusher.flush(t.linkedBrowser)));
  const state = SessionStore.getWindowState(window);
  const winData = state.windows[0];
  const ids = new Set(tabs.map(t => t.id));
  winData.tabs = winData.tabs.filter(t => ids.has(t.zenSyncId));
  is(winData.tabs.length, 3, "The three split tabs are in the saved state");
  winData.selected = 1;
  winData.splitViewData = (winData.splitViewData || []).filter(s => s.groupId == group.groupId);
  is(winData.splitViewData.length, 1, "The split is in the saved state");
  winData.groups = (winData.groups || []).filter(g => g.id == group.groupId);
  delete winData._closedTabs;
  return { windows: [winData] };
}

async function restoreInNewWindow(state) {
  const win = await BrowserTestUtils.openNewBrowserWindow();
  const restored = new Promise(resolve => win.addEventListener("SSWindowRestored", resolve, { once: true }));
  SessionStore.setWindowState(win, JSON.stringify(state), true);
  await restored;
  await TestUtils.waitForCondition(
    () => win.gZenViewSplitter._data.some(s => s.tabs.length === 3),
    "The split came back in the new window"
  );
  return { win, split: win.gZenViewSplitter._data.find(s => s.tabs.length === 3) };
}

async function cleanup(tabs) {
  if (gZenViewSplitter.currentView >= 0) {
    gZenViewSplitter.unsplitCurrentView();
  }
  for (const tab of tabs) {
    BrowserTestUtils.removeTab(tab);
  }
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.split-restore", true]] });
});

add_task(async function test_split_restores_whole_into_a_new_window() {
  const { tabs, group } = await makeSplit();
  let win;
  try {
    const state = await savedSplitState(tabs, group);
    ({ win } = await restoreInNewWindow(state));
    const split = win.gZenViewSplitter._data.find(s => s.tabs.length === 3);
    is(split.gridType, "vsep", "Same arrangement");
    const panes = leaves(split.layoutTree);
    is(panes.length, 3, "Every pane is in the layout");
    Assert.deepEqual(
      panes.map(p => Math.round(p.sizeInParent)),
      [50, 25, 25],
      "The resized widths came back"
    );
    Assert.deepEqual(
      split.tabs.map(t => t.id).sort(),
      tabs.map(t => t.id).sort(),
      "The same tabs, by their saved ids"
    );
    ok(tabs.every(t => t.splitView), "The source split is untouched");
  } finally {
    if (win) {
      await BrowserTestUtils.closeWindow(win);
    }
    await cleanup(tabs);
  }
});

add_task(async function test_layout_missing_a_pane_still_restores_every_tab() {
  const { tabs, group } = await makeSplit();
  let win;
  try {
    const state = await savedSplitState(tabs, group);
    // zen#12403: the saved tree no longer names the first pane's tab.
    const saved = state.windows[0].splitViewData[0].layoutTree;
    saved.children[0].tabId = "whimsy-missing-tab";
    ({ win } = await restoreInNewWindow(state));
    const split = win.gZenViewSplitter._data.find(s => s.tabs.length === 3);
    const panes = leaves(split.layoutTree);
    is(panes.length, 3, "All three tabs are in the rebuilt layout");
    Assert.deepEqual(
      panes.map(p => p.tab).sort((a, b) => a.id.localeCompare(b.id)),
      [...split.tabs].sort((a, b) => a.id.localeCompare(b.id)),
      "Each pane is one of the split's tabs"
    );
    is(split.layoutTree.direction, "row", "Rebuilt in its saved arrangement (side by side)");
  } finally {
    if (win) {
      await BrowserTestUtils.closeWindow(win);
    }
    await cleanup(tabs);
  }
});

add_task(async function test_layout_check() {
  const { tabs, group } = await makeSplit();
  try {
    ok(WhimsySplitRestore.layoutMatches(group.layoutTree, group.tabs), "A live split's tree matches its tabs");
    const short = gZenViewSplitter.calculateLayoutTree(tabs.slice(0, 2), "vsep");
    ok(!WhimsySplitRestore.layoutMatches(short, group.tabs), "A tree missing a pane doesn't");
    ok(!WhimsySplitRestore.layoutMatches(null, group.tabs), "No tree doesn't");
    const rebuilt = WhimsySplitRestore.layoutFor(short, group, gZenViewSplitter);
    is(leaves(rebuilt).length, 3, "A mismatched tree is rebuilt with every tab");
    is(WhimsySplitRestore.layoutFor(group.layoutTree, group, gZenViewSplitter), group.layoutTree, "A good tree is kept");

    await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.split-restore", false]] });
    is(WhimsySplitRestore.layoutFor(short, group, gZenViewSplitter), short, "Switch off: Zen's tree as saved");
    await SpecialPowers.popPrefEnv();
  } finally {
    await cleanup(tabs);
  }
});
