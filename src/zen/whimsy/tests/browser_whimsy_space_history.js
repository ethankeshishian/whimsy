/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

const { WhimsySpaceHistory: SpaceHistory } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySpaceHistory.sys.mjs"
);
const { PlacesUtils: HistoryPlaces } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs"
);

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.feature.space-history", true], ["places.history.enabled", true],
  ] });
  SpaceHistory.initWindow(window);
  registerCleanupFunction(async () => {
    SpaceHistory._candidates = [];
    await HistoryPlaces.history.removeByFilter({ host: "space-history.example.com" });
    await SpaceHistory.enqueue(() => SpaceHistory.prune());
  });
});

async function historyVisit(spaceId, spaceName, offset = 0, path = "same") {
  const url = `https://space-history.example.com/${path}`;
  const date = new Date(Date.now() - 10000 + offset);
  await HistoryPlaces.history.insert({ url, title: "Space history fixture",
    visits: [{ date, transition: HistoryPlaces.history.TRANSITION_LINK }] });
  const db = await HistoryPlaces.promiseDBConnection();
  const rows = await db.execute(`SELECT v.id, p.guid FROM moz_historyvisits v
    JOIN moz_places p ON p.id = v.place_id WHERE p.url = :url AND v.visit_date = :time`,
  { url, time: date.getTime() * 1000 });
  const visit = { id: rows[0].getResultByName("id"),
    guid: rows[0].getResultByName("guid"), time: date.getTime(), url };
  SpaceHistory._candidates = spaceId ? [{ url, time: visit.time, spaceId, spaceName }] : [];
  await SpaceHistory.enqueue(() => SpaceHistory.recordVisit(visit));
  return visit;
}

add_task(async function real_navigation_records_the_owning_space() {
  const first = gZenWorkspaces.getWorkspaces().find(w => w.uuid === gZenWorkspaces.activeWorkspace);
  const second = await gZenWorkspaces.createAndSaveWorkspace("History test", undefined, true);
  const url = "https://example.com/?whimsy-space-history";
  let tab;
  try {
    await gZenWorkspaces.changeWorkspace(first);
    tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
    await TestUtils.waitForCondition(async () => {
      const rows = await SpaceHistory.query({ spaceId: first.uuid, search: url });
      return rows.length > 0;
    }, "A real navigation is associated with the tab's space");
    BrowserTestUtils.removeTab(tab);
    tab = null;
    await gZenWorkspaces.changeWorkspace(second);
    tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
    await TestUtils.waitForCondition(async () => {
      const rows = await SpaceHistory.query({ spaceId: second.uuid, search: url });
      return rows.length > 0;
    }, "The same URL visited in a different space has its own association");
  } finally {
    if (tab) {
      BrowserTestUtils.removeTab(tab);
    }
    await gZenWorkspaces.changeWorkspace(first);
    await gZenWorkspaces.removeWorkspace(second.uuid);
    await HistoryPlaces.history.remove(url);
    await SpaceHistory.enqueue(() => SpaceHistory.prune());
  }
});

add_task(async function visit_identity_and_filter_before_pagination() {
  const first = await historyVisit("hist-work", "Work");
  const second = await historyVisit("hist-home", "Home", 100);
  const work = await SpaceHistory.query({ spaceId: "hist-work", limit: 1 });
  is(work.length, 1, "Filtering precedes the limit");
  is(work[0].visitId, first.id, "The older visit in Work is found");
  is(work[0].spaceName, "Work", "Visit-time name is retained");
  // Flush the JSONFile directly to exercise persistence without waiting its timer.
  await (await SpaceHistory.file())._save();
  const saved = await IOUtils.readJSON(PathUtils.join(PathUtils.profileDir, "whimsy-space-history.json"));
  is(saved.visits[first.id].spaceName, "Work", "Visit-space metadata survives on disk");
  ok(!("url" in saved.visits[first.id]), "The sidecar does not duplicate browsing URLs");
  const home = await SpaceHistory.query({ spaceId: "hist-home" });
  is(home[0].visitId, second.id, "The same URL has independent visits in two spaces");
  is((await SpaceHistory.query({ spaceId: "hist-work", search: "missing" })).length,
    0, "Space and text filters compose, including the empty state");

  await historyVisit(null, null, 200, "old");
  const unknown = await SpaceHistory.query({ spaceId: "unknown", search: "space-history.example.com/old" });
  is(unknown.length, 1, "Untagged history remains accessible as Unknown space");
});

add_task(async function switches_privacy_and_ambiguous_navigation() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.space-history", false]] });
  const off = await historyVisit("hist-off", "Off", 300, "off");
  ok(!(await SpaceHistory.file()).data.visits[off.id], "Feature off does not write metadata");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.pushPrefEnv({ set: [["places.history.enabled", false]] });
  ok(!SpaceHistory.recording, "Disabling Firefox history disables the recorder");
  await SpecialPowers.popPrefEnv();

  const visit = await historyVisit(null, null, 400, "ambiguous");
  SpaceHistory._candidates = ["hist-work", "hist-home"].map(spaceId => ({
    url: visit.url, time: visit.time, spaceId, spaceName: spaceId,
  }));
  await SpaceHistory.enqueue(() => SpaceHistory.recordVisit(visit));
  ok(!(await SpaceHistory.file()).data.visits[visit.id],
    "Overlapping same-URL visits in different spaces are never guessed");

  const browser = gBrowser.selectedBrowser;
  const tab = gBrowser.selectedTab;
  const before = SpaceHistory._candidates.length;
  const hadMark = tab.hasAttribute("whimsy-private");
  tab.setAttribute("whimsy-private", "true");
  try {
    SpaceHistory.capture(window, browser, Services.io.newURI("https://space-history.example.com/private"));
    is(SpaceHistory._candidates.length, before, "Private tabs never enter the candidate queue");
  } finally {
    if (!hadMark) {
      tab.removeAttribute("whimsy-private");
    }
  }
  const privateWindow = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    SpaceHistory.capture(privateWindow, privateWindow.gBrowser.selectedBrowser,
      Services.io.newURI("https://space-history.example.com/private-window"));
    is(SpaceHistory._candidates.length, before, "Private windows never enter the queue");
  } finally {
    await BrowserTestUtils.closeWindow(privateWindow);
  }
});

add_task(async function capture_uses_tab_space_and_excludes_scratch() {
  const tab = gBrowser.selectedTab;
  const originalId = tab.getAttribute("zen-workspace-id");
  const spaces = gZenWorkspaces.getWorkspaces();
  const space = spaces.find(item => !item.whimsyScratch);
  ok(space, "There is a normal space");
  const oldScratch = space.whimsyScratch;
  try {
    tab.setAttribute("zen-workspace-id", space.uuid);
    SpaceHistory._candidates = [];
    const uri = Services.io.newURI("https://space-history.example.com/capture");
    SpaceHistory.capture(window, tab.linkedBrowser, uri);
    is(SpaceHistory._candidates[0]?.spaceId, space.uuid, "Snapshot uses tab's space");
    is(SpaceHistory._candidates[0]?.spaceName, space.name, "Snapshot includes its name");
    space.whimsyScratch = true;
    SpaceHistory.capture(window, tab.linkedBrowser, uri);
    is(SpaceHistory._candidates.length, 1, "Scratch contributes no navigation snapshots");
  } finally {
    if (oldScratch === undefined) {
      delete space.whimsyScratch;
    } else {
      space.whimsyScratch = oldScratch;
    }
    if (originalId) {
      tab.setAttribute("zen-workspace-id", originalId);
    } else {
      tab.removeAttribute("zen-workspace-id");
    }
    SpaceHistory._candidates = [];
  }
});

add_task(async function library_preserves_native_history_and_actions() {
  const library = document.querySelector("zen-library");
  const wasTab = library.activeTab;
  const originalClosed = Services.prefs.getBoolPref("zen.library.history.closed-tabs", false);
  await SpecialPowers.pushPrefEnv({ set: [["zen.library.history.closed-tabs", false]] });
  await historyVisit("hist-ui", "Design", 500, "ui");
  library.activeTab = "history";
  await library.constructor.animateProgress(1);
  try {
    await TestUtils.waitForCondition(() => library.querySelector("whimsy-space-history-section"));
    const section = library.querySelector("whimsy-space-history-section");
    await section.refresh();
    await section.updateComplete;
    const filter = section.querySelector(".whimsy-history-space");
    ok(filter, "Space filter sits next to Zen's existing filter");
    filter.value = "hist-ui";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
    await TestUtils.waitForCondition(() => section._flatVisits?.length === 1 &&
      section._flatVisits[0].spaceId === "hist-ui");
    await section.updateComplete;
    is(section.querySelectorAll(".zen-library-row").length, 1, "Space filter renders one matching visit");
    ok(section.querySelector(".whimsy-history-space-name"), "A visit has its space label");
    ok(section.querySelector('[data-l10n-id="library-history-forget-button"]'),
      "Native Forget action is preserved");

    section.activeFilters.delete("source:history");
    section.activeFilters.add("source:closed");
    section.onFiltersChanged();
    await section.updateComplete;
    ok(section.querySelector(".whimsy-history-space").disabled,
      "Space filtering does not pretend closed tabs are recorded visits");

    await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.space-history", false]] });
    await TestUtils.waitForCondition(() => !library.querySelector("whimsy-space-history-section"));
    ok(library.querySelector("zen-library-history-section"), "Switch off restores Zen's native History");
    await SpecialPowers.popPrefEnv();
  } finally {
    await library.constructor.animateProgress(0);
    library.activeTab = wasTab;
    Services.prefs.setBoolPref("zen.library.history.closed-tabs", originalClosed);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function deletion_prunes_only_deleted_visits() {
  const deleted = await historyVisit("hist-delete", "Delete", 600, "delete");
  const kept = await historyVisit("hist-keep", "Keep", 700, "keep");
  await HistoryPlaces.history.removeVisitsByFilter({
    beginDate: new Date(deleted.time), endDate: new Date(deleted.time),
  });
  await SpaceHistory.enqueue(() => SpaceHistory.prune());
  const file = await SpaceHistory.file();
  ok(!file.data.visits[deleted.id], "Removing visits removes their metadata");
  ok(file.data.visits[kept.id], "A surviving visit retains its space");
  await HistoryPlaces.history.remove(kept.url);
  await SpaceHistory.enqueue(() => SpaceHistory.prune());
  ok(!file.data.visits[kept.id], "Forget URL also removes metadata");
});

add_task(async function clear_all_history_removes_space_metadata() {
  await historyVisit("hist-clear", "Clear", 800, "clear");
  await HistoryPlaces.history.clear();
  await SpaceHistory.enqueue(() => SpaceHistory.prune());
  is(Object.keys((await SpaceHistory.file()).data.visits).length, 0,
    "Clearing all Places visits also clears all space metadata");
});
