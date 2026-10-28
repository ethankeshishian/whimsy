/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Whimsy: Arc-style Ctrl+Tab. A quick tap flips to the most recently used tab,
// so repeated taps alternate between the same two tabs.

async function quickCtrlTab() {
  const onSelect = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabSelect");
  EventUtils.synthesizeKey("VK_TAB", { ctrlKey: true });
  EventUtils.synthesizeKey("VK_CONTROL", { type: "keyup" });
  await onSelect;
}

async function selectTab(tab) {
  const onSelect = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabSelect");
  gBrowser.selectedTab = tab;
  await onSelect;
}

add_task(async function test_defaults() {
  ok(
    Services.prefs.getDefaultBranch("").getBoolPref("browser.ctrlTab.sortByRecentlyUsed"),
    "Ctrl+Tab uses recently-used order by default"
  );
  ok(
    Services.prefs.getDefaultBranch("").getBoolPref("zen.ctrlTab.show-pending-tabs"),
    "Unloaded tabs stay in the Ctrl+Tab history by default"
  );
});

add_task(async function test_quick_taps_alternate() {
  await SpecialPowers.pushPrefEnv({ set: [["browser.ctrlTab.sortByRecentlyUsed", true]] });

  const tabs = [];
  for (let i = 1; i <= 4; i++) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, `data:text/plain,tab${i}`));
  }
  const [a, b] = [tabs[1], tabs[3]];

  // b (opened last) is selected; visit a, so b becomes the most recently used.
  await selectTab(a);

  await quickCtrlTab();
  is(gBrowser.selectedTab, b, "First tap goes to the last-used tab");
  await quickCtrlTab();
  is(gBrowser.selectedTab, a, "Second tap comes back");
  await quickCtrlTab();
  is(gBrowser.selectedTab, b, "Third tap alternates again");
  ok(!ctrlTab.panel.state || ctrlTab.panel.state == "closed", "Quick taps never show the switcher");

  for (const tab of tabs) {
    BrowserTestUtils.removeTab(tab);
  }
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_pending_tab_stays_in_history() {
  await SpecialPowers.pushPrefEnv({ set: [["browser.ctrlTab.sortByRecentlyUsed", true]] });

  const tabs = [];
  for (let i = 1; i <= 3; i++) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, `data:text/plain,p${i}`));
  }
  const [a, b] = [tabs[0], tabs[2]];
  await selectTab(a);
  await gBrowser.explicitUnloadTabs([b]);
  ok(b.hasAttribute("pending"), "Previous tab is unloaded");

  await quickCtrlTab();
  is(gBrowser.selectedTab, b, "A tap still returns to the unloaded last-used tab");

  for (const tab of tabs) {
    BrowserTestUtils.removeTab(tab);
  }
  await SpecialPowers.popPrefEnv();
});
