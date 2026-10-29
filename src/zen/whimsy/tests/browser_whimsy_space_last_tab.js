/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Last tab per space (Arc): switching back to a space returns to the tab you
// were last on there, even when Zen has forgotten it (after a restart, or
// once that tab moved or closed): then the space's most recently used tab.

const FEATURE = "whimsy.feature.space-last-tab";

let firstSpace, secondSpace;

add_setup(async function () {
  firstSpace = gZenWorkspaces.getWorkspaces().find(w => w.uuid == gZenWorkspaces.activeWorkspace);
  secondSpace = await gZenWorkspaces.createAndSaveWorkspace("Elsewhere", undefined, true);
  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref(FEATURE);
    await gZenWorkspaces.removeWorkspace(secondSpace.uuid);
  });
});

async function addTabHere(url) {
  const tab = BrowserTestUtils.addTab(gBrowser, url, { skipAnimation: true });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  return tab;
}

async function use(tab) {
  gBrowser.selectedTab = tab;
  // lastAccessed is in milliseconds; keep the order unambiguous.
  await new Promise(r => setTimeout(r, 30));
}

add_task(async function test_returns_to_recent_tab() {
  ok(Services.prefs.getBoolPref(FEATURE), "The feature switch is on");
  const a = await addTabHere("data:text/plain,a");
  const b = await addTabHere("data:text/plain,b");
  const c = await addTabHere("data:text/plain,c");
  await use(c);
  await use(b);
  await use(a);
  await use(b);

  await gZenWorkspaces.changeWorkspace(secondSpace);
  // What a restart leaves: Zen no longer remembers the space's tab.
  delete gZenWorkspaces.lastSelectedWorkspaceTabs[firstSpace.uuid];
  await gZenWorkspaces.changeWorkspace(firstSpace);
  is(gBrowser.selectedTab, b, "Back on the tab used last in that space");

  // The remembered tab closes while you're elsewhere: the next most recent.
  await gZenWorkspaces.changeWorkspace(secondSpace);
  BrowserTestUtils.removeTab(b);
  await gZenWorkspaces.changeWorkspace(firstSpace);
  is(gBrowser.selectedTab, a, "Then the next most recently used tab");

  // Switched off: Zen's own fallback (its empty new tab page).
  Services.prefs.setBoolPref(FEATURE, false);
  await gZenWorkspaces.changeWorkspace(secondSpace);
  delete gZenWorkspaces.lastSelectedWorkspaceTabs[firstSpace.uuid];
  await gZenWorkspaces.changeWorkspace(firstSpace);
  isnot(gBrowser.selectedTab, a, "With the switch off, Zen decides");
  Services.prefs.clearUserPref(FEATURE);

  BrowserTestUtils.removeTab(a);
  BrowserTestUtils.removeTab(c);
});

add_task(async function test_empty_space_keeps_zen_behaviour() {
  // A space with no tabs of its own still opens on Zen's empty tab.
  await gZenWorkspaces.changeWorkspace(secondSpace);
  delete gZenWorkspaces.lastSelectedWorkspaceTabs[secondSpace.uuid];
  await gZenWorkspaces.changeWorkspace(firstSpace);
  await gZenWorkspaces.changeWorkspace(secondSpace);
  const own = gBrowser.tabs.filter(
    t => t.getAttribute("zen-workspace-id") == secondSpace.uuid && !t.hasAttribute("zen-empty-tab")
  );
  if (!own.length) {
    is(gBrowser.selectedTab, gZenWorkspaces._emptyTab, "An empty space shows the empty tab");
  } else {
    ok(own.includes(gBrowser.selectedTab), "A tab of that space is selected");
  }
  await gZenWorkspaces.changeWorkspace(firstSpace);
});
