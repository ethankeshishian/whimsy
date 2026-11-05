/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// fixD: splits up to four panes. Split Grid / Vertically / Horizontally in
// a split re-lays out its panes instead of answering "Can't add more
// panels"; a 3rd/4th tab dropped onto a split's tab in the sidebar joins the
// split beside the pane it was dropped on.

const FEATURE = "whimsy.feature.split-four-panes";

function addTab(n) {
  return BrowserTestUtils.openNewForegroundTab(gBrowser, `data:text/plain,tab${n}`);
}

function splitOf(tab) {
  return gZenViewSplitter._data.find(g => g.tabs.includes(tab));
}

function leaves(node) {
  return node.tab ? [node.tab] : node.children.flatMap(leaves);
}

async function openTabs(count) {
  const tabs = [];
  for (let i = 0; i < count; i++) {
    tabs.push(await addTab(i));
  }
  return tabs;
}

// Records toasts instead of showing them.
function spyToasts() {
  const shown = [];
  const original = gZenUIManager.showToast;
  gZenUIManager.showToast = (id, ...rest) => {
    shown.push(id);
    return original.call(gZenUIManager, id, ...rest);
  };
  return { shown, restore: () => (gZenUIManager.showToast = original) };
}

async function cleanup(tabs) {
  if (gZenViewSplitter.currentView >= 0) {
    gZenViewSplitter.unsplitCurrentView();
  }
  for (const tab of tabs) {
    if (tab.isConnected) {
      BrowserTestUtils.removeTab(tab);
    }
  }
}

add_task(async function test_grid_relayouts_a_full_split() {
  const tabs = await openTabs(5);
  const [a, b, c, d, e] = tabs;
  gZenViewSplitter.splitTabs([a, b, c, d], "vsep");
  await TestUtils.waitForCondition(() => splitOf(a)?.tabs.length == 4, "4-pane split");
  gBrowser.selectedTab = d; // the last pane: Zen's "next tab" is e, outside
  const toasts = spyToasts();
  try {
    gZenViewSplitter.toggleShortcut("grid");
    const group = splitOf(a);
    is(group.gridType, "grid", "The split is now a grid");
    is(group.tabs.length, 4, "Still four panes");
    ok(!e.splitView, "The next tab wasn't pulled in");
    is(group.layoutTree.direction, "row", "Grid root is a row");
    is(group.layoutTree.children.length, 2, "of two columns");
    ok(group.layoutTree.children.every(col => col.direction == "column" && col.children.length == 2), "2x2");

    // Same layout again on a full split: no error toast, still four.
    gZenViewSplitter.toggleShortcut("grid");
    is(splitOf(a).tabs.length, 4, "Still four panes");
    ok(!toasts.shown.includes("zen-split-view-limit-toast"), "No \"Can't add more panels\" toast");
  } finally {
    toasts.restore();
  }
  await cleanup(tabs);
});

add_task(async function test_layout_change_keeps_panes() {
  const tabs = await openTabs(4);
  const [a, b, c, d] = tabs;
  gZenViewSplitter.splitTabs([a, b, c], "grid");
  await TestUtils.waitForCondition(() => splitOf(a)?.tabs.length == 3, "3-pane split");
  gBrowser.selectedTab = c;
  gZenViewSplitter.toggleShortcut("hsep");
  const group = splitOf(a);
  is(group.gridType, "hsep", "Stacked");
  is(group.tabs.length, 3, "Three panes, nothing added");
  is(group.layoutTree.direction, "column", "One column");
  ok(!d.splitView, "The next tab stays out");
  await cleanup(tabs);
});

// W16-20: inside a split the shortcuts only change its layout; the same
// layout again does nothing (no next tab joins).
add_task(async function test_same_layout_does_nothing_in_a_split() {
  const tabs = await openTabs(3);
  const [a, b, c] = tabs;
  gZenViewSplitter.splitTabs([a, b], "vsep");
  await TestUtils.waitForCondition(() => splitOf(a)?.tabs.length == 2, "2-pane split");
  gBrowser.selectedTab = b;
  gZenViewSplitter.toggleShortcut("vsep");
  await new Promise(resolve => setTimeout(resolve, 300)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
  is(splitOf(a).tabs.length, 2, "The same layout: still two panes");
  ok(!c.splitView, "…and the next tab stays out");
  gZenViewSplitter.toggleShortcut("hsep");
  is(splitOf(a).gridType, "hsep", "Another layout re-lays it out");
  is(splitOf(a).tabs.length, 2, "…with the same panes");
  gZenViewSplitter.toggleShortcut("hsep");
  is(splitOf(a).gridType, "hsep", "That layout again leaves it alone");
  is(splitOf(a).tabs.length, 2, "…two panes");
  await cleanup(tabs);
});

// W16-20 (the user's case): with an Essential first in the list, Split
// Vertically from a split's last pane copied the Essential in (and from a
// pinned split copied both panes into a second split row).
for (const pinned of [false, true]) {
  add_task(async function test_last_pane_never_pulls_in_an_essential() {
    const essential = await addTab("essential");
    gZenPinnedTabManager.addToEssentials(essential);
    await TestUtils.waitForCondition(() => essential.hasAttribute("zen-essential"), "An Essential");
    const tabs = await openTabs(2);
    const [a, b] = tabs;
    if (pinned) {
      gBrowser.pinTab(a);
      gBrowser.pinTab(b);
      await TestUtils.waitForCondition(() => a.pinned && b.pinned, "Both pinned");
    }
    try {
      gZenViewSplitter.splitTabs([a, b], "vsep");
      await TestUtils.waitForCondition(() => splitOf(a)?.tabs.length == 2, "2-pane split");
      const last = splitOf(a).tabs.at(-1);
      gBrowser.selectedTab = last;
      const before = gBrowser.tabs.length;
      gZenViewSplitter.toggleShortcut("vsep");
      await new Promise(resolve => setTimeout(resolve, 300)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
      is(gBrowser.tabs.length, before, `${pinned ? "Pinned" : "Unpinned"}: no tab was copied in`);
      is(splitOf(a).tabs.length, 2, "…the split keeps its two panes");
      const rows = [...document.querySelectorAll("tab-group[split-view-group]")]
        .filter(row => row.tabs?.some(t => t == a || t == b || t.linkedBrowser?.currentURI?.spec == essential.linkedBrowser.currentURI.spec));
      is(rows.length, 1, "…in one split row, with no copy of the Essential anywhere in a split");
      ok(!splitOf(essential), "The Essential stays out of it");
    } finally {
      await cleanup(tabs.filter(t => !t.pinned));
      for (const t of tabs) {
        if (t.isConnected) {
          if (t.pinned) {
            gBrowser.unpinTab(t);
          }
          BrowserTestUtils.removeTab(t);
        }
      }
      gZenPinnedTabManager.removeEssentials(essential);
      BrowserTestUtils.removeTab(essential);
    }
  });
}

add_task(async function test_switch_off_is_zen() {
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
  const tabs = await openTabs(5);
  const [a, b, c, d] = tabs;
  gZenViewSplitter.splitTabs([a, b, c, d], "vsep");
  await TestUtils.waitForCondition(() => splitOf(a)?.tabs.length == 4, "4-pane split");
  gBrowser.selectedTab = d;
  const toasts = spyToasts();
  try {
    gZenViewSplitter.toggleShortcut("grid");
    is(splitOf(a).gridType, "vsep", "Off: Zen's behavior, layout unchanged");
    ok(toasts.shown.includes("zen-split-view-limit-toast"), "Off: Zen's toast");
  } finally {
    toasts.restore();
  }
  ok(!gZenViewSplitter.whimsyCanDropIntoSplit(a, tabs[4]), "Off: no dropping into a split");
  await cleanup(tabs);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_drop_into_split() {
  const tabs = await openTabs(5);
  const [a, b, c, d, e] = tabs;
  gZenViewSplitter.splitTabs([a, b, c], "vsep");
  await TestUtils.waitForCondition(() => splitOf(a)?.tabs.length == 3, "3-pane split");

  ok(typeof gZenViewSplitter.whimsyCanDropIntoSplit == "function", "Hook for Zen's sidebar drop (hotfix) is there");
  ok(gZenViewSplitter.whimsyCanDropIntoSplit(b, d), "A 4th tab can join");
  ok(!gZenViewSplitter.whimsyCanDropIntoSplit(b, c), "A pane can't join its own split again");
  ok(!gZenViewSplitter.whimsyCanDropIntoSplit(e, d), "Not a split: Zen's own new-split path");

  ok(gZenViewSplitter.whimsyDropIntoSplit(d, b, "left", true), "Dropped left of b");
  const group = splitOf(a);
  is(group.tabs.length, 4, "Four panes");
  Assert.deepEqual(leaves(group.layoutTree), [a, d, b, c], "d sits just left of b");
  is(gBrowser.selectedTab, d, "The dropped tab is selected");
  ok(d.linkedBrowser.closest(".browserSidebarContainer").hasAttribute("zen-split"), "and shown as a pane");

  ok(!gZenViewSplitter.whimsyCanDropIntoSplit(b, e), "Full at four");
  ok(!gZenViewSplitter.whimsyDropIntoSplit(e, b, "right", true), "A fifth is left to Zen");
  is(splitOf(a).tabs.length, 4, "Still four");
  await cleanup(tabs);
});

add_task(async function test_drop_right_side() {
  const tabs = await openTabs(3);
  const [a, b, c] = tabs;
  gZenViewSplitter.splitTabs([a, b], "vsep");
  await TestUtils.waitForCondition(() => splitOf(a)?.tabs.length == 2, "2-pane split");
  ok(gZenViewSplitter.whimsyDropIntoSplit(c, a, "right", true), "Dropped right of a");
  Assert.deepEqual(leaves(splitOf(a).layoutTree), [a, c, b], "c sits just right of a");
  await cleanup(tabs);
});
