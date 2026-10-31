/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/small: the idle archive sweep shows a toast with Undo, and Undo
// brings back exactly the swept tabs, even after another tab was closed.

const { WhimsyArchive } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyArchive.sys.mjs");
const { WhimsyUndo } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUndo.sys.mjs");

const IDLE_A = "https://example.com/?swept-a";
const IDLE_B = "https://example.com/?swept-b";
const OTHER = "https://example.com/?closed-later";

function openUrls() {
  return gBrowser.tabs.map(t => t.linkedBrowser.currentURI.spec);
}

add_task(async function test_sweep_toast_undo_restores_the_batch() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.tabs.archive.idle-after", "12h"]] });
  const old = Date.now() - 13 * 3600 * 1000;
  const a = await BrowserTestUtils.openNewForegroundTab(gBrowser, IDLE_A);
  const b = await BrowserTestUtils.openNewForegroundTab(gBrowser, IDLE_B);
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, OTHER);
  const keep = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?keep");
  gBrowser.selectedTab = keep;
  keep.updateLastAccessed(Date.now());
  other.updateLastAccessed(Date.now());
  a.updateLastAccessed(old);
  b.updateLastAccessed(old);

  WhimsyArchive.sweepWindow(window);
  await TestUtils.waitForCondition(() => !a.isConnected && !b.isConnected, "Both idle tabs were archived");
  const button = await TestUtils.waitForCondition(
    () => document.getElementById("whimsy-undo-toast-button"),
    "The sweep's toast offers Undo"
  );
  is(WhimsyUndo.peek(window)?.type, "archive:idle", "Cmd+Z would undo the sweep too");

  // Something else closes before the person presses Undo.
  BrowserTestUtils.removeTab(other);
  await TestUtils.waitForCondition(
    () => WhimsyArchive.listEntries(window).filter(e => e.url == IDLE_A || e.url == IDLE_B).length == 2,
    "The swept tabs are in the Archive"
  );

  button.doCommand();
  await TestUtils.waitForCondition(
    () => openUrls().includes(IDLE_A) && openUrls().includes(IDLE_B),
    "Undo brought both swept tabs back"
  );
  ok(!openUrls().includes(OTHER), "but not the tab closed after the sweep");
  is(gBrowser.selectedTab, keep, "The tab you were on stays selected");

  for (const tab of gBrowser.tabs.filter(t => [IDLE_A, IDLE_B].includes(t.linkedBrowser.currentURI.spec))) {
    BrowserTestUtils.removeTab(tab);
  }
  BrowserTestUtils.removeTab(keep);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_manual_archive_has_no_sweep_toast() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?manual");
  document.getElementById("whimsy-undo-toast-button")?.closest(".zen-toast")?.remove();
  WhimsyArchive.archiveTabs(window, [tab], { reason: "manual" });
  ok(!document.getElementById("whimsy-undo-toast-button"), "A manual archive doesn't show the sweep toast");
  is(WhimsyUndo.peek(window)?.type, "archive:manual", "and is still undoable with Cmd+Z");
});
