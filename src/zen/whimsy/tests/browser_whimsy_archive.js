/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// The shared archive store: the idle sweep skips tabs it must never touch,
// archives (and tags) the rest once they're old enough, and the Archive
// view's restore puts a tab back where it was.

const { WhimsyArchive, REASON_KEY } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyArchive.sys.mjs");
const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    if (tab.isConnected && !tab.closing) {
      BrowserTestUtils.removeTab(tab);
    }
  }
});

add_task(function test_idle_threshold_parsing() {
  is(WhimsyArchive.idleThresholdMs() > 0, true, "A finite default (12h)");
  Services.prefs.setStringPref("whimsy.tabs.archive.idle-after", "never");
  ok(!Number.isFinite(WhimsyArchive.idleThresholdMs()), "\"Never\" parses to Infinity");
  Services.prefs.clearUserPref("whimsy.tabs.archive.idle-after");
});

add_task(async function test_sweep_exemptions_and_idle_close() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.tabs.archive.idle-after", "12h"]] });
  const now = Date.now();
  const old = now - 13 * 3600 * 1000;

  const pinned = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?pinned");
  gBrowser.pinTab(pinned);

  const idle = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?idle");
  const fresh = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?fresh");
  // updateLastAccessed() pins a selected tab's value to Infinity, so set the
  // selection to `fresh` first and only then backdate `idle`.
  gBrowser.selectedTab = fresh;
  fresh.updateLastAccessed(now);
  idle.updateLastAccessed(old);
  pinned.updateLastAccessed(old);

  ok(WhimsyArchive.isSweepExempt(pinned), "Pinned tabs are exempt");
  ok(!WhimsyArchive.isSweepExempt(idle), "A plain old background tab isn't");

  const before = gBrowser.tabs.length;
  WhimsyArchive.sweepWindow(window);
  await TestUtils.waitForCondition(() => gBrowser.tabs.length == before - 1, "The idle tab closes");
  ok(!idle.isConnected, "It's gone");
  ok(pinned.isConnected, "The pinned tab survived");
  ok(fresh.isConnected, "The fresh tab survived");

  await TestUtils.waitForCondition(() => WhimsyArchive.listEntries(window).some(e => e.url == "https://example.com/?idle"), "SessionStore recorded the idle tab");
  const entry = WhimsyArchive.listEntries(window).find(e => e.url == "https://example.com/?idle");
  is(entry.reason, "idle", "Tagged as an idle archive");

  await SpecialPowers.popPrefEnv();
  BrowserTestUtils.removeTab(pinned);
  BrowserTestUtils.removeTab(fresh);
});

add_task(async function test_restore_lands_in_original_space() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?restore-me");
  SessionStore.setCustomTabValue(tab, REASON_KEY, "manual");
  const closedBefore = WhimsyArchive.listEntries(window).length;
  gBrowser.removeTab(tab, { animate: false });
  await TestUtils.waitForCondition(
    () => WhimsyArchive.listEntries(window).length > closedBefore,
    "The close is recorded"
  );
  const [entry] = WhimsyArchive.listEntries(window);
  is(entry.reason, "manual", "Reason survived the close");
  const restored = WhimsyArchive.restore(window, entry.closedId);
  ok(restored, "Something came back");
  await BrowserTestUtils.browserLoaded(restored.linkedBrowser, false, "https://example.com/?restore-me");
  is(restored.linkedBrowser?.currentURI?.spec, "https://example.com/?restore-me", "The right tab");
  is(gBrowser.selectedTab, restored, "Selected after restoring");
  BrowserTestUtils.removeTab(restored);
});

// System pass: the Archive is History's Closed filter. "View Archive…"
// opens History on it; it says what it is, shows why each tab left and
// restores on click; there is no Archive section of its own any more.
add_task(async function test_archive_is_history_closed() {
  const library = document.querySelector("zen-library");
  await TestUtils.waitForCondition(
    () => library.zenLibrarySections.history?.whimsyHistory,
    "Whimsy's History is in place"
  );
  ok(!("whimsy-archive" in library.zenLibrarySections), "No separate Archive section");

  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?archive-section");
  await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?archive-keep");
  WhimsyArchive.archiveTabs(window, [tab], { reason: "idle", groupId: "idle-test" });
  await TestUtils.waitForCondition(
    () => WhimsyArchive.listEntries(window).some(e => e.url.includes("archive-section")),
    "The tab is archived"
  );
  const entry = WhimsyArchive.listEntries(window).find(e => e.url.includes("archive-section"));

  const wasTab = library.activeTab;
  try {
    ok(WhimsyArchive.openPanel(window), "View Archive opens the Library");
    await TestUtils.waitForCondition(() => library.activeTab == "history", "On History");
    const section = await TestUtils.waitForCondition(() => library.querySelector("whimsy-space-history-section"));
    await TestUtils.waitForCondition(() => section.whimsyView == "closed", "With Closed showing");
    const row = await TestUtils.waitForCondition(
      () => section.querySelector(`.whimsy-archive-row[data-closed-id="${entry.closedId}"]`),
      "The archived tab has a row"
    );
    ok(section.querySelector(".whimsy-archive-intro"), "It explains itself");
    is(row.querySelector(".whimsy-archive-reason").dataset.reason, "idle", "The row says why it left");
    const ids = section.filterGroups.map(g => g.id);
    ok(ids.includes("show") && ids.includes("reason") && !ids.includes("source"), "Show, when and why; no Zen source");

    row.click();
    await TestUtils.waitForCondition(
      () => gBrowser.selectedBrowser.currentURI.spec.includes("archive-section"),
      "Clicking the row restores the tab and selects it"
    );
  } finally {
    await library.constructor.animateProgress(0);
    library.activeTab = wasTab;
    Services.prefs.clearUserPref("whimsy.library.history.view");
  }

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.archive-view", false]] });
  ok(!WhimsyArchive.openPanel(window), "View Archive does nothing while it's off");
  await SpecialPowers.popPrefEnv();
});
