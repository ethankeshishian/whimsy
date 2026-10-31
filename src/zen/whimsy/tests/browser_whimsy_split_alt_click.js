/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave6/parity: Peek stays on Zen's Option+click (user decision);
// Shift+click-to-split stays an opt-in; Option+click a sidebar tab splits
// it with the current one.

add_task(function test_peek_keeps_zen_trigger() {
  is(
    Services.prefs.getDefaultBranch("").getStringPref("zen.glance.activation-method"),
    "alt",
    "Glance (Peek) keeps Zen's Option+click"
  );
  isnot(
    Services.prefs.getDefaultBranch("").getStringPref("zen.glance.activation-method"),
    "shift",
    "W8-16: Glance is not activated by Shift (decided against Arc; keeps Option+click)"
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
