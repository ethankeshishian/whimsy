/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Snooze a tab: it closes right away and reopens on its own once the wake
// time passes, in the same space, with an undo entry in between.

const { WhimsySnooze } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySnooze.sys.mjs");
const { WhimsyUndo } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUndo.sys.mjs");

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    if (tab.isConnected && !tab.closing) {
      BrowserTestUtils.removeTab(tab);
    }
  }
});

add_task(async function test_snooze_closes_and_wakes() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?snooze-me");
  const before = gBrowser.tabs.length;
  await WhimsySnooze.snooze(window, tab, Date.now() + 200);
  await TestUtils.waitForCondition(() => gBrowser.tabs.length == before - 1, "Closes immediately");
  ok(!tab.isConnected, "The original tab element is gone");
  await TestUtils.waitForCondition(
    () => gBrowser.tabs.some(t => t.linkedBrowser?.currentURI?.spec == "https://example.com/?snooze-me"),
    "It reappears once the wake time passes",
    100,
    50
  );
  const woken = gBrowser.tabs.find(t => t.linkedBrowser?.currentURI?.spec == "https://example.com/?snooze-me");
  BrowserTestUtils.removeTab(woken);
});

add_task(async function test_snooze_undo_cancels_the_wake() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?snooze-undo");
  const before = gBrowser.tabs.length;
  await WhimsySnooze.snooze(window, tab, Date.now() + 60000);
  await TestUtils.waitForCondition(() => gBrowser.tabs.length == before - 1, "Closed");
  ok(WhimsyUndo.canUndo(window), "Pushed an undo entry");
  ok(WhimsyUndo.undo(window), "Undo it");
  await TestUtils.waitForCondition(() => gBrowser.tabs.length == before, "Restored right away, not in a minute");
  const restored = await TestUtils.waitForCondition(
    () => gBrowser.tabs.find(t => t.linkedBrowser?.currentURI?.spec == "https://example.com/?snooze-undo"),
    "The restored tab finished navigating"
  );
  BrowserTestUtils.removeTab(restored);
});
