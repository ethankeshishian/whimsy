/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

// Undo for tab actions: Cmd+Z reverses the last close/pin/move, but never
// steals the key from an editable field (where it must stay plain text undo).

const { WhimsyUndo } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUndo.sys.mjs");

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    if (tab.isConnected && !tab.closing) {
      BrowserTestUtils.removeTab(tab);
    }
  }
});

function pressUndo({ shift = false } = {}) {
  const modifiers = AppConstants.platform == "macosx" ? { metaKey: true, shiftKey: shift } : { ctrlKey: true, shiftKey: shift };
  EventUtils.synthesizeKey("z", modifiers, window);
}

add_task(async function test_undo_close_restores_in_place() {
  const anchor = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?anchor");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?undo-close");
  const before = gBrowser.tabs.length;
  const recorded = BrowserTestUtils.waitForSessionStoreUpdate(tab);
  gBrowser.removeTab(tab, { animate: false });
  await recorded;
  await TestUtils.waitForCondition(() => gBrowser.tabs.length == before - 1, "Closed");
  ok(WhimsyUndo.canUndo(window), "Something to undo");
  gBrowser.tabContainer.focus();
  pressUndo();
  await TestUtils.waitForCondition(() => gBrowser.tabs.length == before, "Restored");
  const restored = await TestUtils.waitForCondition(
    () => gBrowser.tabs.find(t => t.linkedBrowser?.currentURI?.spec == "https://example.com/?undo-close"),
    "Restored tab loaded its URL"
  );
  ok(restored, "The right tab came back");
  BrowserTestUtils.removeTab(restored);
  BrowserTestUtils.removeTab(anchor);
});

add_task(async function test_undo_ignored_in_editable_field() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.undo-tab-actions", true]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?editable-guard");
  const recorded = BrowserTestUtils.waitForSessionStoreUpdate(tab);
  gBrowser.removeTab(tab, { animate: false });
  await recorded;
  await TestUtils.waitForCondition(() => WhimsyUndo.canUndo(window), "A pending undo exists");
  gURLBar.focus();
  gURLBar.value = "hello";
  const before = gBrowser.tabs.length;
  pressUndo();
  // Cmd+Z in the URL bar is plain text undo; our stack must still have the
  // entry (nothing was popped) and no tab should have reappeared from it.
  is(gBrowser.tabs.length, before, "No tab restored while focus was in the url bar");
  ok(WhimsyUndo.canUndo(window), "The undo entry is still there");
  gBrowser.tabContainer.focus();
  pressUndo();
  await TestUtils.waitForCondition(() => gBrowser.tabs.length == before + 1, "Now it restores");
  const restored = await TestUtils.waitForCondition(
    () => gBrowser.tabs.find(t => t.linkedBrowser?.currentURI?.spec == "https://example.com/?editable-guard"),
    "Restored tab loaded its URL"
  );
  BrowserTestUtils.removeTab(restored);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_undo_move_to_space_and_redo() {
  if (!window.gZenWorkspaces?.workspaceEnabled) {
    todo(false, "Spaces aren't enabled in this build");
    return;
  }
  const spaces = window.gZenWorkspaces.getWorkspaces();
  if (spaces.length < 2) {
    todo(false, "Needs a second space");
    return;
  }
  const originalSpace = window.gZenWorkspaces.activeWorkspace;
  const other = spaces.find(s => s.uuid != originalSpace);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?move-undo");
  window.gZenWorkspaces.moveTabToWorkspace(tab, other.uuid);
  is(tab.getAttribute("zen-workspace-id"), other.uuid, "Moved");
  pressUndo();
  await TestUtils.waitForCondition(() => tab.getAttribute("zen-workspace-id") == originalSpace, "Undo moved it back");
  pressUndo({ shift: true });
  await TestUtils.waitForCondition(() => tab.getAttribute("zen-workspace-id") == other.uuid, "Redo moved it again");
  BrowserTestUtils.removeTab(tab);
});
