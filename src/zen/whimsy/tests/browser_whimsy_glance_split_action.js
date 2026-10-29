/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Open Glance into a split: Zen's own sidebar Split button already does
// this (splitGlance -> fullyOpenGlance({forSplit:true}) -> splitTabs). This
// adds "Split Glance" to the command bar (only offered while a Glance is
// open and the split button isn't disabled), and covers the case Zen's
// splitTabs already knows about but wasn't tested here: a parent tab
// that's already in a 2-pane split grows to 3 panes instead of starting a
// second, separate split.

const { openGlanceOnTab } = ChromeUtils.importESModule("resource://testing-common/GlanceTestUtils.sys.mjs");
const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");

function action() {
  return globalActions.find(a => a.l10nId == "whimsy-action-split-glance");
}

function addTab(url) {
  return BrowserTestUtils.openNewForegroundTab(gBrowser, url);
}

function splitOf(tab) {
  return gZenViewSplitter._data.find(g => g.tabs.includes(tab));
}

function runAction() {
  document.getElementById("cmd_zenGlanceSplit").doCommand();
}

add_task(async function test_registered_with_the_right_label() {
  is(action()?.label, "Split Glance", "In the command bar");
});

add_task(async function test_availability_follows_whether_a_glance_is_open() {
  ok(!action().isAvailable(window), "Not offered with no Glance open");
  await openGlanceOnTab(
    window,
    async () => {
      ok(action().isAvailable(window), "Offered while a Glance is open");
    },
    true
  );
  ok(!action().isAvailable(window), "Not offered again once it's closed");
});

add_task(async function test_action_splits_the_glance() {
  await openGlanceOnTab(
    window,
    async glanceTab => {
      runAction();
      await TestUtils.waitForCondition(() => splitOf(glanceTab), "The glance tab joins a split");
      is(splitOf(glanceTab).tabs.length, 2, "The command bar action splits the glance same as the sidebar button");
      BrowserTestUtils.removeTab(glanceTab);
    },
    false
  );
});

add_task(async function test_already_split_parent_grows_to_three_panes() {
  const tabA = await addTab("data:text/plain,tabA");
  const tabB = await addTab("data:text/plain,tabB");
  gBrowser.selectedTab = tabA;
  gZenViewSplitter.splitTabs([tabA, tabB], "vsep");
  await TestUtils.waitForCondition(() => splitOf(tabA)?.tabs.length == 2, "Starts as a 2-pane split");
  gBrowser.selectedTab = tabA;

  await openGlanceOnTab(
    window,
    async glanceTab => {
      ok(action().isAvailable(window), "Offered even though the parent is already split (well under the 4-tab limit)");
      runAction();
      await TestUtils.waitForCondition(() => splitOf(glanceTab), "The glance tab joined the existing split");
      const group = splitOf(glanceTab);
      is(group.tabs.length, 3, "Three panes: the two original tabs plus the glance");
      ok([tabA, tabB].every(t => group.tabs.includes(t)), "Both original tabs are still in it");
      BrowserTestUtils.removeTab(glanceTab);
    },
    false
  );

  BrowserTestUtils.removeTab(tabA);
  BrowserTestUtils.removeTab(tabB);
});

add_task(async function test_feature_off_hides_the_action() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.glance-split-action", false]] });
  await openGlanceOnTab(
    window,
    async () => {
      ok(!action().isAvailable(window), "The switch hides it even with a Glance open");
    },
    true
  );
  await SpecialPowers.popPrefEnv();
});
