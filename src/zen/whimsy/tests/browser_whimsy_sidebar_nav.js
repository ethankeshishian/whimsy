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

// A field in the tab strip (the New Space form's name) keeps its keys:
// Space types a space instead of opening a Glance, and Backspace edits
// the text instead of closing the tab the sidebar cursor was on.
add_task(async function test_field_in_tab_strip_keeps_its_keys() {
  const { gBrowser } = window;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const input = document.createElementNS("http://www.w3.org/1999/xhtml", "input");
  registerCleanupFunction(() => {
    input.remove();
    if (gBrowser.tabs.includes(tab)) {
      BrowserTestUtils.removeTab(tab);
    }
  });
  window.document.getElementById("whimsy-focus-sidebar").doCommand();
  ok(tab.hasAttribute("whimsy-sidebar-focused"), "The sidebar cursor is on the tab");
  gZenWorkspaces.workspaceElement(gZenWorkspaces.activeWorkspace).append(input);
  ok(gBrowser.tabContainer.contains(input), "The field sits in the tab strip");
  input.focus();
  await TestUtils.waitForCondition(() => document.activeElement == input, "The field has focus");
  const tabCount = gBrowser.tabs.length;
  EventUtils.sendString("a b", window);
  EventUtils.synthesizeKey("KEY_Backspace", {}, window);
  is(input.value, "a ", "Space and Backspace edit the text");
  ok(gBrowser.tabs.includes(tab), "The tab stays open");
  is(gBrowser.tabs.length, tabCount, "and no Glance opened");
  ok(!tab.hasAttribute("whimsy-sidebar-focused"), "Leaving the tabs ends the sidebar cursor");
  input.remove();
  BrowserTestUtils.removeTab(tab);
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
