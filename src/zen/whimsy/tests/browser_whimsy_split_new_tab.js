/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// batch3glance: Cmd+T in a split loads the pick into the focused pane
// (Arc), Escape changes nothing, modified Enter still opens a new tab,
// and the switch off hands Cmd+T back to Zen.

async function openSplit() {
  const a = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const b = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  gZenViewSplitter.splitTabs([a, b], "vsep", 1);
  await TestUtils.waitForCondition(() => a.splitView && b.splitView, "Split active");
  is(gBrowser.selectedTab, b, "The right pane is focused");
  return [a, b];
}

async function closeSplit(tabs) {
  if (gZenViewSplitter.currentView >= 0) {
    gZenViewSplitter.unsplitCurrentView();
  }
  for (const tab of tabs) {
    BrowserTestUtils.removeTab(tab);
  }
}

async function pressCmdT() {
  EventUtils.synthesizeKey("t", { accelKey: true });
  await TestUtils.waitForCondition(() => gURLBar.hasAttribute("zen-newtab"), "The floating URL bar opened");
}

async function pressEscape() {
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(() => !gURLBar.hasAttribute("zen-newtab"), "The URL bar closed");
}

add_task(async function test_cmd_t_loads_into_the_focused_pane() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.split-new-tab", true]] });
  const [a, b] = await openSplit();
  try {
    const count = gBrowser.tabs.length;

    await pressCmdT();
    await pressEscape();
    is(b.linkedBrowser.currentURI.spec, "https://example.org/", "Escape leaves the focused pane alone");
    is(gBrowser.tabs.length, count, "Escape opens no tab");

    await pressCmdT();
    const url = "https://example.com/?replacement";
    const loaded = BrowserTestUtils.browserLoaded(b.linkedBrowser, false, url);
    gURLBar.value = url;
    gURLBar.inputField.dispatchEvent(new Event("input", { bubbles: true }));
    EventUtils.synthesizeKey("KEY_Enter");
    await loaded;
    is(gBrowser.tabs.length, count, "No new tab: the page opened in the pane");
    ok(a.splitView && b.splitView, "The split stays together");
    is(gBrowser.selectedTab, b, "The focused pane stays focused");
    is(a.linkedBrowser.currentURI.spec, "https://example.com/", "The other pane is unchanged");

    await pressCmdT();
    is(
      gURLBar.controller.whereToOpen(new KeyboardEvent("keydown", { key: "Enter", altKey: true })),
      "tab",
      "Alt+Enter still opens a tab outside the split"
    );
    is(
      gURLBar.controller.whereToOpen(new KeyboardEvent("keydown", { key: "Enter" })),
      "current",
      "Plain Enter opens in the pane"
    );
    await pressEscape();
  } finally {
    await closeSplit([a, b]);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_switch_off_and_unsplit_tabs_keep_zen() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.split-new-tab", false]] });
  const [a, b] = await openSplit();
  try {
    // Tests run with Zen's bar replacement off, so force it to look at the
    // destination Zen would pick.
    gZenUIManager.handleNewTab(false, false, "tab", true);
    await TestUtils.waitForCondition(() => gURLBar.hasAttribute("zen-newtab"));
    is(
      gURLBar.controller.whereToOpen(new KeyboardEvent("keydown", { key: "Enter" })),
      "tab",
      "Switch off: Zen's new tab"
    );
    await pressEscape();
  } finally {
    await closeSplit([a, b]);
    await SpecialPowers.popPrefEnv();
  }

  // A tab that isn't in a split: Cmd+T is Zen's/Firefox's own new tab.
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.split-new-tab", true]] });
  const lone = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const opened = BrowserTestUtils.waitForNewTab(gBrowser);
  EventUtils.synthesizeKey("t", { accelKey: true });
  const newTab = await opened;
  ok(!newTab.splitView, "Outside a split, Cmd+T opens an ordinary new tab");
  BrowserTestUtils.removeTab(newTab);
  BrowserTestUtils.removeTab(lone);
  await SpecialPowers.popPrefEnv();
});
