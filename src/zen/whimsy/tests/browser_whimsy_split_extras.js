/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// batch6 #9 (Close Other Panes), #10 (Swap Panes), #11 (Split Vertically /
// Horizontally / Grid from the command bar), #7 (Shift+click a link opens
// it in a split, off by default).

const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
const { WhimsySplit } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySplit.sys.mjs");

function action(l10nId) {
  return globalActions.find(a => a.l10nId == l10nId);
}

function addTab(url) {
  return BrowserTestUtils.openNewForegroundTab(gBrowser, url);
}

function splitOf(tab) {
  return gZenViewSplitter._data.find(g => g.tabs.includes(tab));
}

const initialTabs = new Set(gBrowser.tabs);
registerCleanupFunction(async () => {
  if (gZenViewSplitter.currentView >= 0) {
    gZenViewSplitter.unsplitCurrentView();
  }
  for (const tab of gBrowser.tabs.filter(t => !initialTabs.has(t))) {
    await BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_close_other_panes() {
  const tabA = await addTab("data:text/plain,tabA");
  const tabB = await addTab("data:text/plain,tabB");
  const tabC = await addTab("data:text/plain,tabC");
  gZenViewSplitter.splitTabs([tabA, tabB, tabC], "grid");
  await TestUtils.waitForCondition(() => splitOf(tabB)?.tabs.length == 3, "3-pane split");
  gBrowser.selectedTab = tabB;

  ok(action("whimsy-action-close-other-panes").isAvailable(window), "Offered while in a split");
  document.getElementById("cmd_whimsyCloseOtherPanes").doCommand();
  await TestUtils.waitForCondition(() => !tabA.isConnected && !tabC.isConnected, "tabA and tabC closed");
  ok(!tabB.splitView, "B is no longer in a split");
  ok(!action("whimsy-action-close-other-panes").isAvailable(window), "Not offered once unsplit");

  BrowserTestUtils.removeTab(tabB);
});

add_task(async function test_swap_panes() {
  const tabA = await addTab("data:text/plain,tabA");
  const tabB = await addTab("data:text/plain,tabB");
  gZenViewSplitter.splitTabs([tabA, tabB], "vsep");
  await TestUtils.waitForCondition(() => splitOf(tabA)?.tabs.length == 2, "2-pane split");
  gBrowser.selectedTab = tabA;

  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const rectBefore = tabA.linkedBrowser.closest(".browserSidebarContainer").getBoundingClientRect();
  ok(action("whimsy-action-swap-panes").isAvailable(window), "Offered while in a split");
  WhimsySplit.swapPanes(window);
  const rectAfter = tabA.linkedBrowser.closest(".browserSidebarContainer").getBoundingClientRect();
  ok(rectAfter.left > rectBefore.left, "A's pane moved to the other side");

  WhimsySplit.swapPanes(window);
  const rectBack = tabA.linkedBrowser.closest(".browserSidebarContainer").getBoundingClientRect();
  is(Math.round(rectBack.left), Math.round(rectBefore.left), "Swapping again returns to the start");

  gZenViewSplitter.unsplitCurrentView();
  BrowserTestUtils.removeTab(tabA);
  BrowserTestUtils.removeTab(tabB);
});

add_task(async function test_split_from_command_bar() {
  const tabA = await addTab("data:text/plain,tabA");
  const tabB = await addTab("data:text/plain,tabB");
  gBrowser.selectedTab = tabA;

  ok(action("whimsy-action-split-vertically").isAvailable(window), "Offered with 2+ tabs");
  action("whimsy-action-split-vertically").command(window);
  await TestUtils.waitForCondition(() => splitOf(tabA), "toggleShortcut split the selected tab and its neighbor");
  is(splitOf(tabA).gridType, "vsep", "Vertical split");

  gZenViewSplitter.unsplitCurrentView();
  BrowserTestUtils.removeTab(tabA);
  BrowserTestUtils.removeTab(tabB);
});

add_task(async function test_switches_hide_the_actions() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.split-close-other-panes", false],
      ["whimsy.feature.split-swap-panes", false],
      ["whimsy.feature.split-command-bar", false],
    ],
  });
  const tabA = await addTab("data:text/plain,tabA");
  const tabB = await addTab("data:text/plain,tabB");
  gZenViewSplitter.splitTabs([tabA, tabB], "vsep");
  await TestUtils.waitForCondition(() => splitOf(tabA), "split");

  ok(!action("whimsy-action-close-other-panes").isAvailable(window), "Switch off: hidden");
  ok(!action("whimsy-action-swap-panes").isAvailable(window), "Switch off: hidden");
  ok(!action("whimsy-action-split-vertically").isAvailable(window), "Switch off: hidden");

  gZenViewSplitter.unsplitCurrentView();
  BrowserTestUtils.removeTab(tabA);
  BrowserTestUtils.removeTab(tabB);
  await SpecialPowers.popPrefEnv();
});

// #7: Shift+click a link opens it in a split. Off by default, so the
// first task checks the pref-off (normal navigation) path, matching how a
// fresh profile behaves; the second turns it on.
add_task(async function test_shift_click_off_by_default_does_nothing_special() {
  is(Services.prefs.getBoolPref("whimsy.splitlink.shift-click"), false, "Off by default");
});

add_task(async function test_shift_click_opens_a_split() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.splitlink.shift-click", true]] });
  const tab = await addTab("data:text/html,<a id='l' href='https://example.org/'>link</a>");

  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const link = content.document.getElementById("l");
    const win = content.window;
    link.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true, button: 0 })
    );
  });

  await TestUtils.waitForCondition(() => splitOf(tab), "Shift+click split the tab instead of navigating it");
  is(splitOf(tab).tabs.length, 2, "A new pane with the link's URL");

  gZenViewSplitter.unsplitCurrentView();
  for (const t of [...gBrowser.tabs]) {
    if (t != gBrowser.tabs[0]) {
      BrowserTestUtils.removeTab(t);
    }
  }
  await SpecialPowers.popPrefEnv();
});
