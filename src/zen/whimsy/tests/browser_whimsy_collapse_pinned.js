/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Collapse the pinned section: Zen already ships it (nsZenCollapsiblePins in
// ZenSpace.mjs). Clicking the space's name folds its pinned tabs away with
// Zen's folder animation, keeping the selected pinned tab visible (the default
// the user chose); View > "Collapse Pinned Tabs" does the same, and the state
// is saved with the space. This checks that flow end to end.

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  const space = gZenWorkspaces.activeWorkspaceElement;
  if (space?.collapsiblePins.collapsed) {
    space.collapsiblePins.collapsed = false;
  }
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    BrowserTestUtils.removeTab(tab);
  }
});

// Whether the tab is really on screen: hit-test its centre.
function shown(tab) {
  const rect = tab.getBoundingClientRect();
  if (rect.height < 1) {
    return false;
  }
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return hit?.closest(".tabbrowser-tab") == tab;
}

async function pinnedTabs(n) {
  const tabs = [];
  for (let i = 0; i < n; i++) {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `https://example.com/?pin=${i}`);
    gBrowser.pinTab(tab);
    tabs.push(tab);
  }
  const space = gZenWorkspaces.activeWorkspaceElement;
  await TestUtils.waitForCondition(() => space.hasPinnedTabs, "The space has pinned tabs");
  return tabs;
}

add_task(async function test_collapse_keeps_selected_visible() {
  const space = gZenWorkspaces.activeWorkspaceElement;
  const tabs = await pinnedTabs(3);
  gBrowser.selectedTab = tabs[1];
  await TestUtils.waitForCondition(() => tabs.every(shown), "All pinned tabs are shown");

  // Clicking the space's name collapses the section.
  EventUtils.synthesizeMouseAtCenter(space.indicator.querySelector(".zen-current-workspace-indicator-name"), {});
  await TestUtils.waitForCondition(() => space.hasCollapsedPinnedTabs, "The pinned section collapsed");
  await TestUtils.waitForCondition(() => !shown(tabs[0]) && !shown(tabs[2]), "The other pinned tabs fold away");
  ok(shown(tabs[1]), "The selected pinned tab stays visible");

  // Selecting a normal tab keeps the collapsed section folded.
  const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  ok(space.hasCollapsedPinnedTabs, "Still collapsed after switching to a normal tab");

  // The View menu item reads the state and toggles it back.
  space.collapsiblePins.toggle();
  await TestUtils.waitForCondition(() => tabs.every(shown), "Expanded again: every pinned tab shows");
  ok(!space.hasCollapsedPinnedTabs, "Expanded");
  BrowserTestUtils.removeTab(normal);
  for (const tab of tabs) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_state_is_saved_with_the_space() {
  const space = gZenWorkspaces.activeWorkspaceElement;
  const tabs = await pinnedTabs(2);
  const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  space.collapsiblePins.collapsed = true;
  ok(space.hasCollapsedPinnedTabs, "Collapsed");
  await TestUtils.waitForCondition(() => !tabs.some(shown), "With a normal tab selected, every pinned tab folds away");
  // What Zen writes to the session for each space, and reads back on restart.
  const stored = gZenWorkspaces.getWorkspacesForSessionStore().find(w => w.uuid == space.id);
  ok(stored.hasCollapsedPinnedTabs, "The collapsed state is saved with the space");
  space.collapsiblePins.collapsed = false;
  BrowserTestUtils.removeTab(normal);
  for (const tab of tabs) {
    BrowserTestUtils.removeTab(tab);
  }
});
