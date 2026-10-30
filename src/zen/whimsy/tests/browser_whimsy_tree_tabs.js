/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Tree tabs (on by default since wave 3): a tab opened from another gets nested under
// it; closing a parent archives the whole branch as one group instead of
// leaving orphans, and the depth cap caps the *visual* indent, not the data.

const { WhimsyTreeTabs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTreeTabs.sys.mjs");
const { WhimsyArchive } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyArchive.sys.mjs");

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    if (tab.isConnected && !tab.closing) {
      BrowserTestUtils.removeTab(tab);
    }
  }
});

function openChildOf(opener, url) {
  const tab = BrowserTestUtils.addTab(gBrowser, url, { openerBrowser: opener.linkedBrowser });
  return BrowserTestUtils.browserLoaded(tab.linkedBrowser).then(() => tab);
}

add_task(async function test_depth_and_branch_archive() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.tree-tabs", true]] });
  const root = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?root");
  const child = await openChildOf(root, "https://example.com/?child");
  const grandchild = await openChildOf(child, "https://example.com/?grandchild");
  WhimsyTreeTabs.render(window);

  is(WhimsyTreeTabs.depthOf(root), 0, "The root has no opener");
  is(WhimsyTreeTabs.depthOf(child), 1, "One level under its opener");
  is(WhimsyTreeTabs.depthOf(grandchild), 2, "Two");
  ok(WhimsyTreeTabs.hasChildren(window, root), "The root has children");
  is(child.getAttribute("whimsy-tree-depth"), "1", "The attribute CSS reads matches");

  const before = gBrowser.tabs.length;
  const closedBefore = WhimsyArchive.listEntries(window).length;
  gBrowser.removeTab(root, { animate: false });
  await TestUtils.waitForCondition(() => gBrowser.tabs.length == before - 3, "The whole branch closed together");
  await TestUtils.waitForCondition(
    () => WhimsyArchive.listEntries(window).length >= closedBefore + 3,
    "SessionStore recorded the entire branch"
  );
  const entries = WhimsyArchive.listEntries(window).slice(0, 3);
  ok(entries.every(e => e.reason == "tree"), "All three tagged as a tree-close");
  const groupIds = new Set(entries.map(e => e.groupId));
  is(groupIds.size, 1, "...and share one group id");

  for (const entry of entries) {
    const tab = WhimsyArchive.restore(window, entry.closedId);
    if (tab) {
      await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, entry.url);
      await BrowserTestUtils.removeTab(tab);
    }
  }
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_on_by_default_and_orphan() {
  ok(Services.prefs.getBoolPref("whimsy.feature.tree-tabs"), "On by default (wave-3 request)");
  const orphan = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?orphan");
  is(WhimsyTreeTabs.depthOf(orphan), 0, "No opener at all renders at depth 0");
  BrowserTestUtils.removeTab(orphan);
});
