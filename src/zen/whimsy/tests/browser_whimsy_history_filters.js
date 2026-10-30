/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// System pass: Archive and Snooze are filters of the Library's History
// (Show: All / Closed / Snoozed). Each filter lists the right items, the
// commands land on the right filter, and the old Archive section's saved
// state migrates.

const { WhimsyArchive } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyArchive.sys.mjs");
const { WhimsySnooze } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySnooze.sys.mjs");
const { WhimsyLibrarySection } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyLibrarySection.sys.mjs"
);

const VIEW_PREF = "whimsy.library.history.view";
const library = document.querySelector("zen-library");
const startTabs = new Set(gBrowser.tabs);
const wasTab = library.activeTab;

registerCleanupFunction(async () => {
  await library.constructor.animateProgress(0);
  library.activeTab = wasTab;
  Services.prefs.clearUserPref(VIEW_PREF);
  for (const record of await WhimsySnooze.list()) {
    WhimsySnooze.cancelSnooze(null, record);
  }
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    if (tab.isConnected && !tab.closing) {
      BrowserTestUtils.removeTab(tab);
    }
  }
});

async function historySection() {
  await TestUtils.waitForCondition(() => library.zenLibrarySections.history?.whimsyHistory, "Whimsy's History");
  const section = await TestUtils.waitForCondition(
    () => library.querySelector("whimsy-space-history-section"),
    "History is built"
  );
  await section.updateComplete;
  return section;
}

add_task(async function test_show_filter_and_closed() {
  const keep = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/?filters-keep");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?filters-closed");
  WhimsyArchive.archiveTabs(window, [tab], { reason: "idle", groupId: "filters-test" });
  const entry = await TestUtils.waitForCondition(
    () => WhimsyArchive.listEntries(window).find(e => e.url.includes("filters-closed")),
    "Archived"
  );

  ok(WhimsyLibrarySection.openHistory(window, "all"), "History opens");
  const section = await historySection();
  is(library.activeTab, "history", "On History");
  is(section.whimsyView, null, "All is Zen's History");
  const show = section.filterGroups.find(g => g.id == "show");
  ok(show, "History has a Show filter");
  Assert.deepEqual(show.options.map(o => o.id), ["all", "closed", "snoozed"], "All, Closed, Snoozed");
  ok(section.filterGroups.some(g => g.id == "when"), "When was it visited? stays");
  ok(section.filterGroups.some(g => g.id == "sort"), "Sort by stays");
  ok(!section.querySelector(".whimsy-archive-row"), "No closed-tab rows under All");

  section.setWhimsyView("closed");
  await TestUtils.waitForCondition(
    () => section.querySelector(`.whimsy-archive-row[data-closed-id="${entry.closedId}"]`),
    "Closed lists the archived tab"
  );
  is(Services.prefs.getStringPref(VIEW_PREF), "closed", "The choice is remembered");
  ok(!section.filterGroups.some(g => g.id == "sort"), "Closed is always newest first");
  ok(section.filterGroups.some(g => g.id == "reason"), "Closed can filter by why it left");

  // Why it left: "Closed" hides the idle one.
  section.activeFilters.add("reason:closed");
  section.onFiltersChanged();
  await TestUtils.waitForCondition(
    () => ![...section.querySelectorAll(".whimsy-archive-row .whimsy-archive-reason")]
      .some(r => r.dataset.reason == "idle"),
    "Filtering by reason hides other reasons"
  );
  section.activeFilters.delete("reason:closed");

  // Turning Show's current choice off goes back to All.
  section.activeFilters.delete("show:closed");
  section.onFiltersChanged();
  await TestUtils.waitForCondition(() => section.isFilterActive("show", "all"), "Back to All");
  BrowserTestUtils.removeTab(keep);
});

add_task(async function test_snoozed_wake_and_cancel() {
  const wake = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?filters-wake");
  const cancel = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.net/?filters-cancel");
  await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/?filters-stay");
  const hour = 3600 * 1000;
  await WhimsySnooze.snooze(window, wake, Date.now() + hour);
  await WhimsySnooze.snooze(window, cancel, Date.now() + 2 * hour);
  await TestUtils.waitForCondition(async () => (await WhimsySnooze.list()).length >= 2, "Two snoozed tabs");

  // The command lands on Snoozed.
  ok(WhimsyLibrarySection.openHistory(window, "snoozed"), "View Snoozed Tabs opens History");
  const section = await historySection();
  await TestUtils.waitForCondition(() => section.whimsyView == "snoozed", "On Snoozed");
  const wakeRow = await TestUtils.waitForCondition(
    () => section.querySelector(".whimsy-snoozed-row:first-child"),
    "Snoozed tabs have rows"
  );
  is(section.querySelectorAll(".whimsy-snoozed-row").length, (await WhimsySnooze.list()).length, "One row per snoozed tab");
  await document.l10n.translateFragment(section);
  ok(wakeRow.querySelector(".whimsy-snoozed-wake").textContent.startsWith("Wakes"), "Each row says when it wakes");
  ok(!section.querySelector(".whimsy-archive-row"), "No closed-tab rows under Snoozed");
  const first = Number(wakeRow.dataset.wakeAt);
  const second = Number(section.querySelectorAll(".whimsy-snoozed-row")[1].dataset.wakeAt);
  Assert.lessOrEqual(first, second, "Soonest first");

  // Cancel snooze: the record goes, the tab stays closed.
  const cancelRow = section.querySelectorAll(".whimsy-snoozed-row")[1];
  const tabsBefore = gBrowser.tabs.length;
  cancelRow.querySelector(".whimsy-snoozed-cancel").click();
  await TestUtils.waitForCondition(async () => (await WhimsySnooze.list()).length == 1, "The snooze is cancelled");
  is(gBrowser.tabs.length, tabsBefore, "Cancelling doesn't reopen the tab");
  ok(WhimsyArchive.listEntries(window).some(e => e.url.includes("filters-cancel")), "It's still under Closed");
  await TestUtils.waitForCondition(
    () => section.querySelectorAll(".whimsy-snoozed-row").length == 1,
    "Its row goes"
  );

  // Wake now: the tab comes back right away.
  section.querySelector(".whimsy-snoozed-row .whimsy-snoozed-wake-now").click();
  await TestUtils.waitForCondition(
    () => gBrowser.tabs.some(t => t.linkedBrowser?.currentURI?.spec == "https://example.com/?filters-wake"),
    "Wake now reopens the tab"
  );
  is((await WhimsySnooze.list()).length, 0, "Nothing left snoozed");
  await library.constructor.animateProgress(0);
});

add_task(async function test_view_archive_switches_an_open_history() {
  ok(WhimsyLibrarySection.openHistory(window, "snoozed"), "Open on Snoozed");
  const section = await historySection();
  await TestUtils.waitForCondition(() => section.whimsyView == "snoozed");
  ok(WhimsyArchive.openPanel(window), "View Archive");
  await TestUtils.waitForCondition(() => section.whimsyView == "closed", "The open History switches to Closed");
  ok(library.constructor.isLibraryOpen, "It stays open");
  await library.constructor.animateProgress(0);
});

add_task(async function test_switches_remove_their_filter() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.snooze-tab", false]] });
  Services.prefs.setStringPref(VIEW_PREF, "snoozed");
  const section = await historySection();
  section.setWhimsyView("snoozed");
  is(section.whimsyView, null, "Snoozed falls back to All while snooze is off");
  const show = section.filterGroups.find(g => g.id == "show");
  Assert.deepEqual(show.options.map(o => o.id), ["all", "closed"], "No Snoozed option");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.archive-view", false]] });
  ok(!section.filterGroups.some(g => g.id == "show"), "With both off, no Show filter");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_migrates_the_old_archive_section() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.library.last-tab", "whimsy-archive"],
      ["zen.library.hidden-tabs", "media,whimsy-archive"],
      [VIEW_PREF, "all"],
    ],
  });
  WhimsyLibrarySection.migratePrefs();
  is(Services.prefs.getStringPref("zen.library.last-tab"), "history", "The Library opens on History");
  is(Services.prefs.getStringPref(VIEW_PREF), "closed", "…with Closed showing");
  is(Services.prefs.getStringPref("zen.library.hidden-tabs"), "media", "The Archive leaves the hidden list");
  await SpecialPowers.popPrefEnv();
});
