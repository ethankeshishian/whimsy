/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave6: the Archive keeps every tab (not just SessionStore's newest 25)
// in its own store, until Clear Archive. Restoring by any route takes the
// tab out of the Archive.

const { WhimsyArchive, ID_KEY } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyArchive.sys.mjs");
const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");

const BASE = "https://example.com/?archive-store-";

async function openAndClose(n) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, BASE + n);
  BrowserTestUtils.removeTab(tab);
  await TestUtils.waitForCondition(() => WhimsyArchive.listEntries(window).some(e => e.url == BASE + n), `Tab ${n} is archived`);
}

add_setup(async function () {
  WhimsyArchive.clear(window, { confirm: false });
  registerCleanupFunction(() => WhimsyArchive.clear(window, { confirm: false }));
});

add_task(async function test_keeps_more_than_sessionstore() {
  await SpecialPowers.pushPrefEnv({ set: [["browser.sessionstore.max_tabs_undo", 2]] });
  for (let i = 0; i < 4; i++) {
    await openAndClose(i);
  }
  ok(SessionStore.getClosedTabDataForWindow(window).length <= 2, "SessionStore keeps only its cap");
  const urls = WhimsyArchive.listEntries(window).map(e => e.url);
  for (let i = 0; i < 4; i++) {
    ok(urls.includes(BASE + i), `The Archive still has tab ${i}`);
  }
  is(urls[0], BASE + 3, "Newest first");
  ok(WhimsyArchive.listEntries(window, { query: "store-2" }).every(e => e.url == BASE + 2), "Search filters by URL");

  // Tab 0 fell out of SessionStore's list; it comes back from the store.
  const oldest = WhimsyArchive.listEntries(window).find(e => e.url == BASE + 0);
  is(typeof oldest.closedId, "string", "Stored entries use the archive id");
  const tab = WhimsyArchive.restore(window, oldest.closedId);
  ok(tab, "Restored from the store");
  await TestUtils.waitForCondition(() => tab.linkedBrowser.currentURI.spec == BASE + 0, "With its page");
  is(gBrowser.selectedTab, tab, "Selected");
  ok(!WhimsyArchive.listEntries(window).some(e => e.url == BASE + 0), "It left the Archive");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_reopen_closed_tab_leaves_archive() {
  await openAndClose("undo");
  const closed = SessionStore.getClosedTabDataForWindow(window)[0];
  ok(closed.state.extData?.[ID_KEY], "SessionStore's copy carries the archive id");
  const tab = SessionStore.undoCloseTab(window, 0);
  await TestUtils.waitForCondition(
    () => !WhimsyArchive.listEntries(window).some(e => e.url == BASE + "undo"),
    "Cmd+Shift+T takes it out of the Archive"
  );
  ok(!SessionStore.getCustomTabValue(tab, ID_KEY), "The reopened tab drops the id");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_persists_to_profile() {
  await openAndClose("disk");
  await WhimsyArchive.store._save();
  const data = await IOUtils.readJSON(PathUtils.join(PathUtils.profileDir, "whimsy-archive.json"));
  ok(data.entries.some(e => e.url == BASE + "disk" && e.state?.entries?.length), "Saved with its history");
  ok(!data.entries.some(e => "formdata" in e.state || "storage" in e.state), "No form data or session storage");
});

add_task(async function test_clear_archive() {
  await openAndClose("clear");
  const menuItem = document.getElementById("menu_whimsyClearArchive");
  ok(menuItem, "History menu has Clear Archive");
  ok(document.getElementById("menu_whimsyViewArchive"), "and View Archive…");
  is(menuItem.getAttribute("command"), "cmd_whimsyClearArchive", "Runs the command");
  ok(WhimsyArchive.clear(window, { confirm: false }), "Cleared");
  is(WhimsyArchive.listEntries(window).length, 0, "The Archive is empty");
  is(SessionStore.getClosedTabDataForWindow(window).length, 0, "So is Reopen Closed Tab's list");
});

add_task(async function test_switch_off_stops_recording() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.archive-view", false]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, BASE + "off");
  BrowserTestUtils.removeTab(tab);
  ok(!WhimsyArchive.storedEntries.some(e => e.url == BASE + "off"), "Nothing stored with the switch off");
  await SpecialPowers.popPrefEnv();
});
