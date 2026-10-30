/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Three tabs. Cmd+Opt+Down twice selects the third. Focus sidebar, ArrowUp,
// Enter -> the second tab is selected. Delete closes it.

add_task(async function test_sidebar_keyboard_navigation() {
  const { gBrowser } = window;
  const tabA = gBrowser.selectedTab;
  const tabB = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const tabC = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  registerCleanupFunction(async () => {
    for (const tab of [tabB, tabC]) {
      if (gBrowser.tabs.includes(tab)) {
        BrowserTestUtils.removeTab(tab);
      }
    }
  });

  gBrowser.selectedTab = tabA;
  const next = window.document.getElementById("whimsy-tab-next");
  next.doCommand();
  next.doCommand();
  is(gBrowser.selectedTab, tabC, "Cmd+Opt+Down twice reaches the third tab");

  window.document.getElementById("whimsy-focus-sidebar").doCommand();
  is(window.document.activeElement, tabC, "Focus Sidebar moves focus onto the selected tab");
  ok(tabC.hasAttribute("whimsy-sidebar-focused"), "A visible focus ring is set");

  EventUtils.synthesizeKey("KEY_ArrowUp", {}, window);
  is(gBrowser.tabContainer.ariaFocusedItem, tabB, "ArrowUp moves the sidebar cursor to B");
  is(document.activeElement, tabC, "Keys still go to the selected tab C");
  is(gBrowser.selectedTab, tabC, "Moving the cursor does not select B yet");
  EventUtils.synthesizeKey("KEY_Enter", {}, window);
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == tabB);
  is(gBrowser.selectedTab, tabB, "ArrowUp then Enter selects the second tab");

  const removed = BrowserTestUtils.waitForTabClosing(tabB);
  EventUtils.synthesizeKey("KEY_Delete", {}, window);
  await removed;
  ok(!gBrowser.tabs.includes(tabB), "Delete closes the focused tab");
});

add_task(async function test_disabled_feature_leaves_keys_unbound() {
  Services.prefs.setBoolPref("whimsy.feature.sidebar-nav", false);
  registerCleanupFunction(() => Services.prefs.clearUserPref("whimsy.feature.sidebar-nav"));
  const { gBrowser } = window;
  const start = gBrowser.selectedTab;
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  gBrowser.selectedTab = start;
  window.document.getElementById("whimsy-tab-next").doCommand();
  is(gBrowser.selectedTab, start, "With the feature off, the command no-ops");
  BrowserTestUtils.removeTab(other);
  Services.prefs.clearUserPref("whimsy.feature.sidebar-nav");
});
