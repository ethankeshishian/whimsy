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

// fixB: the Snooze sheet (WhimsyPanels): a title, the tab's name, three
// presets each showing when the tab comes back; arrow keys move between
// them and Esc closes it without snoozing anything.
add_task(async function test_snooze_sheet() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?snooze-sheet");
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsySnoozePanel");
  WhimsySnooze.openPanel(window, tab);
  await shown;
  const panel = document.getElementById("whimsySnoozePanel");
  ok(panel.classList.contains("whimsy-sheet"), "It is a Whimsy sheet");
  ok(panel.querySelector(".panel-header .whimsy-sheet-close"), "It has a close button");
  const items = [...panel.querySelectorAll(".whimsy-sheet-item")];
  is(items.length, 3, "Three presets");
  ok(items.every(i => i.querySelector(".whimsy-sheet-item-detail")?.value), "Each preset shows its wake time");
  is(document.activeElement, items[0], "The first preset has focus");
  EventUtils.synthesizeKey("KEY_ArrowDown", {}, window);
  is(document.activeElement, items[1], "Arrow down moves to the next preset");

  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  await hidden;
  ok(tab.isConnected, "Esc closes the sheet without snoozing the tab");
  ok(!document.getElementById("whimsySnoozePanel"), "The sheet is removed once hidden");
  BrowserTestUtils.removeTab(tab);
});
