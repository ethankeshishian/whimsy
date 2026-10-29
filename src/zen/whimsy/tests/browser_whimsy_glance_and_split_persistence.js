/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// batch6 #4 (keep Glance across tab switches) and #12 (splits survive
// restart): both already exist in Zen. No new Whimsy code; these tests
// just pin down the behavior the scout verified by reading, since neither
// had a test in this suite yet.

const { openGlanceOnTab } = ChromeUtils.importESModule("resource://testing-common/GlanceTestUtils.sys.mjs");

function addTab(url) {
  return BrowserTestUtils.openNewForegroundTab(gBrowser, url);
}

// #4: switching away from a Glance's parent tab hides the Glance;
// switching back to the parent reselects it (gZenGlanceManager.onLocationChange).
add_task(async function test_glance_reselects_its_parent_tab_on_switch_back() {
  const other = await addTab("data:text/plain,other");
  await openGlanceOnTab(
    window,
    async glanceTab => {
      const parentTab = gZenGlanceManager.getTabOrGlanceParent(glanceTab);
      gBrowser.selectedTab = other;
      await TestUtils.waitForCondition(() => gBrowser.selectedTab === other, "Switched away");
      gBrowser.selectedTab = parentTab;
      await TestUtils.waitForCondition(
        () => gBrowser.selectedTab === glanceTab,
        "Switching back to the parent reselects its Glance"
      );
    },
    false
  );
  BrowserTestUtils.removeTab(other);
});

// #12: SessionStore-sys-mjs.patch saves gZenViewSplitter.storeDataForSessionStore()
// into winData.splitViewData. This only checks the save side (the layout
// tree, grid type and tab ids); restoring into a fresh window, and
// issue #12403 (a pinned 3-pane split restoring only the last tab), need a
// build to exercise and are left for a batch that can run one.
add_task(async function test_split_view_data_is_saved_for_session_store() {
  const tabA = await addTab("data:text/plain,tabA");
  const tabB = await addTab("data:text/plain,tabB");
  gZenViewSplitter.splitTabs([tabA, tabB], "vsep");
  await TestUtils.waitForCondition(() => tabA.splitView, "Split active");

  const saved = gZenViewSplitter.storeDataForSessionStore();
  is(saved.length, 1, "One split group");
  Assert.deepEqual(saved[0].tabs.sort(), [tabA, tabB].map(t => t.id).sort(), "Both tab ids recorded");
  is(saved[0].gridType, "vsep", "Grid type recorded");
  is(saved[0].layoutTree.type, "splitter", "The layout tree root is recorded");

  gZenViewSplitter.unsplitCurrentView();
  BrowserTestUtils.removeTab(tabA);
  BrowserTestUtils.removeTab(tabB);
});
