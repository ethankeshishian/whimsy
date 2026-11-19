/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29 (owner: "when i full screen a glance window from a pinned tab (or
// essential), it should open as a normal tab, not a pinned tab in another
// folder"). Expanding a Glance opened from a pinned tab, a pinned tab in a
// folder, or an Essential gives a normal tab in the current space.

const { openGlanceOnTab } = ChromeUtils.importESModule("resource://testing-common/GlanceTestUtils.sys.mjs");

async function expandFrom(parent) {
  gBrowser.selectedTab = parent;
  let expanded;
  await openGlanceOnTab(
    window,
    async glanceTab => {
      await gZenGlanceManager.fullyOpenGlance();
      expanded = glanceTab;
    },
    false
  );
  return expanded;
}

function assertNormalTab(tab, label) {
  ok(!tab.pinned, `${label}: not pinned`);
  ok(!tab.hasAttribute("zen-essential"), `${label}: not an Essential`);
  ok(!tab.group, `${label}: not in a folder or group`);
  is(tab.getAttribute("zen-workspace-id"), gZenWorkspaces.activeWorkspace, `${label}: in the current space`);
  is(gBrowser.selectedTab, tab, `${label}: selected`);
}

add_task(async function expand_from_pinned_tab() {
  const parent = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  gBrowser.pinTab(parent);
  const tab = await expandFrom(parent);
  assertNormalTab(tab, "pinned");
  ok(parent.pinned && !parent.group, "pinned: the parent stays where it was");
  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(parent);
});

add_task(async function expand_from_pinned_tab_in_folder() {
  const parent = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const folder = await gZenFolders.createFolder([parent], { renameFolder: false, label: "Work" });
  const tab = await expandFrom(parent);
  assertNormalTab(tab, "folder");
  is(folder.tabs.length, 1, "folder: only the parent is in the folder");
  BrowserTestUtils.removeTab(tab);
  await folder.delete();
});

add_task(async function expand_from_essential() {
  const parent = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  gZenPinnedTabManager.addToEssentials(parent);
  const tab = await expandFrom(parent);
  assertNormalTab(tab, "essential");
  ok(parent.hasAttribute("zen-essential"), "essential: the parent stays an Essential");
  BrowserTestUtils.removeTab(tab);
  gZenPinnedTabManager.removeEssentials(parent);
  BrowserTestUtils.removeTab(parent);
});
