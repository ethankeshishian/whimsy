/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9/secfix (security-full-1 H2): the Archive (whimsy-archive.json) and
// the Snooze list keep closed tabs in their own files. Fire Everywhere,
// Firefox's Clear History and Forget About This Site must reach them too,
// or a "burned" tab can still be restored from View Archive or wake up from
// Snooze. Forget About This Site only takes that site's entries.

const { WhimsyArchive } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyArchive.sys.mjs");
const { WhimsySnooze } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySnooze.sys.mjs");
const { WhimsyFireButton } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFireButton.sys.mjs");

const ORG = "https://example.org/?secfix-h2-org";
const COM = "https://example.com/?secfix-h2-com";

function archived(url) {
  return WhimsyArchive.storedEntries.some(e => e.url == url);
}

async function snoozed(url) {
  return (await WhimsySnooze.list()).some(r => r.url == url);
}

async function archiveFile() {
  const path = PathUtils.join(PathUtils.profileDir, "whimsy-archive.json");
  return (await IOUtils.exists(path)) ? IOUtils.readUTF8(path) : "";
}

async function openAndClose(url) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  BrowserTestUtils.removeTab(tab);
  await TestUtils.waitForCondition(() => archived(url), `${url} is in the Archive`);
}

// A pending snooze, with its wake timer armed, as WhimsySnooze.snooze leaves it.
async function addSnooze(url) {
  const record = {
    closedId: WhimsyArchive.storedEntries.find(e => e.url == url)?.id ?? null,
    wakeAt: Date.now() + 3600 * 1000,
    title: url,
    url,
    zenWorkspace: "",
    userContextId: 0,
    snoozedAt: Date.now(),
  };
  WhimsySnooze.schedule(window, record);
  await WhimsySnooze.persist(record);
  return record;
}

function timerArmed(record) {
  return [...WhimsySnooze._timers.keys()].some(r => WhimsySnooze._sameRecord(r, record));
}

async function reset() {
  WhimsyArchive.clear(window, { confirm: false });
  const store = await WhimsySnooze.store();
  for (const record of store.data.snoozed) {
    WhimsySnooze._stopTimer(record);
  }
  store.data.snoozed = [];
}

add_setup(async function () {
  await reset();
  registerCleanupFunction(reset);
});

add_task(async function forget_about_this_site_takes_only_that_site() {
  await openAndClose(ORG);
  await openAndClose(COM);
  const orgSnooze = await addSnooze(ORG);
  await addSnooze(COM);

  // What ForgetAboutSite (and Clear History's per-site path) sends.
  Services.obs.notifyObservers(null, "browser:purge-session-history-for-domain", "example.org");
  await TestUtils.waitForCondition(async () => !archived(ORG) && !(await snoozed(ORG)),
    "example.org leaves the Archive and the Snooze list");
  ok(archived(COM), "example.com stays in the Archive");
  ok(await snoozed(COM), "…and stays snoozed");
  ok(!timerArmed(orgSnooze), "The forgotten snooze never wakes");
  ok(!(await archiveFile()).includes("secfix-h2-org"), "whimsy-archive.json no longer has it");
  await reset();
});

add_task(async function clear_history_empties_both_stores() {
  await openAndClose(ORG);
  await addSnooze(ORG);
  Services.obs.notifyObservers(null, "browser:purge-session-history");
  await TestUtils.waitForCondition(async () => !WhimsyArchive.storedEntries.length && !(await WhimsySnooze.list()).length,
    "Clear History empties the Archive and the Snooze list");
  await reset();
});

add_task(async function fire_everywhere_empties_both_stores() {
  await openAndClose(ORG);
  await openAndClose(COM);
  const record = await addSnooze(COM);
  // Only the purge is real; closing tabs and clearing site data are
  // covered by browser_whimsy_fire_button.js.
  const originals = {
    tabsOfSpaces: WhimsyFireButton.tabsOfSpaces,
    sanitize: WhimsyFireButton.sanitize,
    clearHistory: WhimsyFireButton.clearHistory,
  };
  WhimsyFireButton.tabsOfSpaces = () => [];
  WhimsyFireButton.sanitize = async () => {};
  WhimsyFireButton.clearHistory = async () => {};
  try {
    // Fire, every space, all time, with Closed tabs and Archive ticked
    // (the W23 surface's Fire Everywhere).
    await WhimsyFireButton.burn(window, { range: "all", allSpaces: true, spaceIds: null, items: { tabs: true, history: true, closed: true } });
  } finally {
    Object.assign(WhimsyFireButton, originals);
  }
  // No waiting: Fire writes the stores before it returns.
  is(WhimsyArchive.storedEntries.length, 0, "Nothing is left in the Archive");
  is(WhimsyArchive.listEntries(window).filter(e => /secfix-h2/.test(e.url)).length, 0, "…or in View Archive");
  is((await WhimsySnooze.list()).length, 0, "Nothing is left snoozed");
  ok(!timerArmed(record), "…and no snooze will wake");
  const text = await archiveFile();
  ok(!text.includes("secfix-h2"), "whimsy-archive.json on disk has neither URL");
});

// Fire in This Profile's matcher (profile and the last hour) leaves older
// entries alone.
add_task(async function fire_profile_purge_respects_its_scope() {
  await openAndClose(ORG);
  const old = WhimsyArchive.storedEntries.find(e => e.url == ORG);
  old.closedAt = Date.now() - 2 * 3600 * 1000;
  await openAndClose(COM);
  const since = Date.now() - 3600 * 1000;
  await WhimsyFireButton.purgeClosed((tab, closedAt) => (tab.userContextId || 0) == 0 && closedAt >= since);
  ok(archived(ORG), "A tab closed two hours ago stays");
  ok(!archived(COM), "A tab closed in the last hour goes");
  await reset();
});
