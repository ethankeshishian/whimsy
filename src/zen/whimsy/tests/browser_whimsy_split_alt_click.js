/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave6/parity: Peek stays on Zen's Option+click (user decision);
// Shift+click opens Peek too (W8-16), Shift+click-to-split stays an opt-in;
// Option+click a sidebar tab splits
// it with the current one.

add_task(function test_peek_keeps_zen_trigger() {
  is(
    Services.prefs.getDefaultBranch("").getStringPref("zen.glance.activation-method"),
    "alt",
    "Glance (Peek) keeps Zen's Option+click"
  );
  ok(!Services.prefs.getDefaultBranch("").getBoolPref("whimsy.splitlink.shift-click"), "Shift+click to split stays off");
});

async function twoTabs() {
  const a = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?alt-a");
  const b = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?alt-b");
  gBrowser.selectedTab = a;
  return [a, b];
}

add_task(async function test_option_click_tab_splits() {
  const [a, b] = await twoTabs();
  EventUtils.synthesizeMouseAtCenter(b, { altKey: true });
  await TestUtils.waitForCondition(() => a.splitView && b.splitView, "Option+click split the two tabs");
  ok(
    gZenViewSplitter._data.some(g => g.tabs.includes(a) && g.tabs.includes(b)),
    "In one split"
  );
  BrowserTestUtils.removeTab(b);
  BrowserTestUtils.removeTab(a);
});

add_task(async function test_option_click_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.split-alt-click", false]] });
  const [a, b] = await twoTabs();
  EventUtils.synthesizeMouseAtCenter(b, { altKey: true });
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == b, "With the switch off, the click just selects");
  ok(!a.splitView && !b.splitView, "No split");
  BrowserTestUtils.removeTab(b);
  BrowserTestUtils.removeTab(a);
  await SpecialPowers.popPrefEnv();
});

// W8-16: Shift+click a link opens Peek (Glance), as in Arc, beside Zen's
// Option+click; not Firefox's new window. With Shift+click-to-split turned
// on, it splits instead.
async function linkTab() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?shift-click");
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.body.innerHTML = "<a id='l' href='https://example.org/?peek' style='font-size:40px'>link</a>";
  });
  return tab;
}

add_task(async function test_shift_click_opens_peek() {
  const tab = await linkTab();
  let newWindow = false;
  const onWindow = () => (newWindow = true);
  Services.ww.registerNotification(onWindow);
  try {
    await BrowserTestUtils.synthesizeMouseAtCenter("#l", { shiftKey: true }, tab.linkedBrowser);
    const glance = await TestUtils.waitForCondition(
      () => gBrowser.tabs.find(t => t.hasAttribute("zen-glance-tab")),
      "Shift+click opened a Glance"
    );
    await TestUtils.waitForCondition(() => glance.linkedBrowser.currentURI?.spec == "https://example.org/?peek", "…of the link");
    is(tab.linkedBrowser.currentURI.spec, "https://example.com/?shift-click", "The page itself stays");
    ok(!newWindow, "No new window opened");
    await gZenGlanceManager.closeGlance({ onTabClose: true });
    await TestUtils.waitForCondition(() => !gBrowser.tabs.some(t => t.hasAttribute("zen-glance-tab")), "Glance closed");
  } finally {
    Services.ww.unregisterNotification(onWindow);
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_shift_click_split_opt_in_wins() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.splitlink.shift-click", true]] });
  const tab = await linkTab();
  try {
    await BrowserTestUtils.synthesizeMouseAtCenter("#l", { shiftKey: true }, tab.linkedBrowser);
    await TestUtils.waitForCondition(() => tab.splitView, "Shift+click split the tab");
    ok(!gBrowser.tabs.some(t => t.hasAttribute("zen-glance-tab")), "No Glance");
  } finally {
    if (tab.splitView) {
      gZenViewSplitter.unsplitCurrentView();
    }
    for (const t of [...gBrowser.tabs]) {
      if (t != gBrowser.tabs[0]) {
        BrowserTestUtils.removeTab(t);
      }
    }
    await SpecialPowers.popPrefEnv();
  }
});

