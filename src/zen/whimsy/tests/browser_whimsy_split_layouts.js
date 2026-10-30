/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// batch3glance: Arc's split layouts. "Add Right/Left/Top/Bottom Split" puts
// a pane on that side of the focused one (up to Zen's four), and "Change
// Orientation" turns side-by-side into stacked and back.

const { WhimsySplitLayouts } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySplitLayouts.sys.mjs");

// Where a pane sits, in percent of the split (Zen's own layout math, so no
// waiting on the panes' CSS transitions).
function box(tab) {
  const { top, left, right, bottom } = gZenViewSplitter.getSplitNodeFromTab(tab).positionToRoot;
  return { top, left, width: 100 - left - right, height: 100 - top - bottom };
}

function near(a, b) {
  return Math.abs(a - b) < 0.5;
}

async function openTabs(count) {
  const tabs = [];
  for (let i = 0; i < count; i++) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, `https://example.com/?pane=${i}`));
  }
  return tabs;
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

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.split-layouts", true]] });
});

add_task(async function test_change_orientation() {
  const [a, b] = await openTabs(2);
  try {
    gZenViewSplitter.splitTabs([a, b], "vsep", 0);
    await TestUtils.waitForCondition(() => a.splitView && b.splitView);
    ok(box(a).left < box(b).left && near(box(a).top, box(b).top), "Side by side");

    ok(WhimsySplitLayouts.changeOrientation(window), "Turned");
    ok(near(box(a).left, box(b).left) && box(a).top < box(b).top, "Stacked, same order");
    is(WhimsySplitLayouts.group(window).gridType, "hsep", "Saved as stacked");
    ok(near(box(a).height, 50) && near(box(a).width, 100), "Each pane takes half the height");

    WhimsySplitLayouts.changeOrientation(window);
    ok(box(a).left < box(b).left && near(box(a).top, box(b).top), "Back to side by side");
    is(WhimsySplitLayouts.group(window).gridType, "vsep", "Saved as side by side");
  } finally {
    await cleanup([a, b]);
  }
});

add_task(async function test_add_split_on_each_side_up_to_four() {
  const [a, b, c, d, e] = await openTabs(5);
  try {
    gZenViewSplitter.splitTabs([a, b], "vsep", 0);
    await TestUtils.waitForCondition(() => a.splitView && b.splitView);
    is(gBrowser.selectedTab, a, "The left pane is focused");

    // Below the focused pane: it shares the left half with the new one.
    is(WhimsySplitLayouts.insertBeside(window, a, c, "bottom"), c, "Added below");
    is(WhimsySplitLayouts.group(window).tabs.length, 3, "Three panes");
    ok(near(box(a).left, box(c).left) && box(a).top < box(c).top, "Stacked under the focused pane");
    ok(near(box(c).width, 50) && near(box(c).height, 50), "It takes half of that pane");
    ok(near(box(b).left, 50) && near(box(b).height, 100), "The other pane is untouched");
    is(gBrowser.selectedTab, c, "The new pane is focused");

    // Left of the top-left pane.
    WhimsySplitLayouts.insertBeside(window, a, d, "left");
    is(WhimsySplitLayouts.group(window).tabs.length, 4, "Four panes");
    ok(box(d).left < box(a).left && near(box(d).top, box(a).top), "Left of the focused pane");
    ok(near(box(b).left, 50), "The right pane is still untouched");

    gBrowser.selectedTab = a;
    ok(!WhimsySplitLayouts.canAddSplit(window), "Zen's four-pane limit");
    is(WhimsySplitLayouts.insertBeside(window, a, e, "right"), null, "A fifth pane is refused");
    ok(!e.splitView, "The fifth tab stays a normal tab");
  } finally {
    await cleanup([a, b, c, d, e]);
  }
});

add_task(async function test_add_split_from_the_url_bar() {
  const [a, b] = await openTabs(2);
  const before = new Set(gBrowser.tabs);
  try {
    gZenViewSplitter.splitTabs([a, b], "vsep", 1);
    await TestUtils.waitForCondition(() => a.splitView && b.splitView);

    // Escape: nothing added.
    ok(WhimsySplitLayouts.addSplit(window, "top"), "Started");
    await TestUtils.waitForCondition(() => gURLBar.hasAttribute("zen-newtab"), "URL bar open");
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(() => !gURLBar.hasAttribute("zen-newtab"));
    is(WhimsySplitLayouts.group(window, b).tabs.length, 2, "Escape adds no pane");

    // Pick a URL: it opens in a pane above the focused one.
    gBrowser.selectedTab = b;
    WhimsySplitLayouts.addSplit(window, "top");
    await TestUtils.waitForCondition(() => gURLBar.hasAttribute("zen-newtab"), "URL bar open");
    gURLBar.value = "https://example.org/?top";
    gURLBar.inputField.dispatchEvent(new Event("input", { bubbles: true }));
    EventUtils.synthesizeKey("KEY_Enter");
    await TestUtils.waitForCondition(
      () => WhimsySplitLayouts.group(window, b)?.tabs.length === 3,
      "The picked page joined the split"
    );
    const added = WhimsySplitLayouts.group(window, b).tabs.find(t => t !== a && t !== b);
    ok(near(box(added).left, box(b).left) && box(added).top < box(b).top, "Above the focused pane");
    is(gBrowser.selectedTab, added, "The new pane is focused");
  } finally {
    await cleanup([...gBrowser.tabs].filter(t => !before.has(t)).concat([a, b]));
  }
});

add_task(async function test_starting_a_split_uses_zens_empty_pane() {
  const [a] = await openTabs(1);
  try {
    ok(WhimsySplitLayouts.addSplit(window, "left"), "Started");
    await TestUtils.waitForCondition(() => gURLBar.hasAttribute("zen-newtab"), "URL bar open");
    ok(a.splitView, "Zen's empty pane is beside the tab");
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(() => !a.splitView, "Escape removes the empty pane");
  } finally {
    await cleanup([a]);
  }
});

add_task(async function test_switch_off() {
  const [a, b] = await openTabs(2);
  try {
    gZenViewSplitter.splitTabs([a, b], "vsep", 0);
    await TestUtils.waitForCondition(() => a.splitView);
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.split-layouts", false]] });
    ok(!WhimsySplitLayouts.canAddSplit(window), "No Add Split actions");
    ok(!WhimsySplitLayouts.changeOrientation(window), "No Change Orientation");
    is(WhimsySplitLayouts.group(window).gridType, "vsep", "The split is unchanged");
    await SpecialPowers.popPrefEnv();
  } finally {
    await cleanup([a, b]);
  }
});
