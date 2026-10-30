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

add_task(async function restored_and_already_open_tabs_capture_new_visits() {
  const url = "https://example.com/?whimsy-history-restored";
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  const spaceId = tab.getAttribute("zen-workspace-id");
  try {
    SpaceHistory._candidates = [];
    tab.dispatchEvent(new Event("SSTabRestored", { bubbles: true }));
    is(SpaceHistory._candidates[0]?.spaceId, spaceId || gZenWorkspaces.activeWorkspace,
      "A restored tab supplies a navigation snapshot");
    SpaceHistory._candidates = [];
    tab.removeAttribute("zen-workspace-id");
    SpaceHistory.captureOpenVisit({ url, time: Date.now() });
    is(SpaceHistory._candidates[0]?.spaceId, gZenWorkspaces.activeWorkspace,
      "A new visit from an already-open tab inherits the window's space");
    is(SpaceHistory._candidates[0]?.url, url, "The snapshot belongs to the visited URL");
    // The tab's own (earlier) visit may be recorded after a later visit's
    // snapshot was taken; it must not take that snapshot.
    const db0 = await HistoryPlaces.promiseDBConnection();
    const [opened] = await db0.execute(`SELECT v.id, v.visit_date, p.guid FROM moz_historyvisits v
      JOIN moz_places p ON p.id = v.place_id WHERE p.url = :url ORDER BY v.visit_date DESC LIMIT 1`, { url });
    const openedVisit = { id: opened.getResultByName("id"), guid: opened.getResultByName("guid"),
      time: Math.floor(opened.getResultByName("visit_date") / 1000), url };
    SpaceHistory._candidates = [];
    SpaceHistory.captureOpenVisit({ id: openedVisit.id + 1000, url, time: Date.now() });
    await SpaceHistory.enqueue(() => SpaceHistory.recordVisit(openedVisit));
    is(SpaceHistory._candidates.length, 1, "An earlier visit doesn't consume a later visit's snapshot");
    SpaceHistory._candidates = [];
    const date = new Date();
    await HistoryPlaces.history.insert({ url, title: "Restored tab",
      visits: [{ date, transition: HistoryPlaces.history.TRANSITION_LINK }] });
    const db = await HistoryPlaces.promiseDBConnection();
    const rows = await db.execute(`SELECT v.id FROM moz_historyvisits v
      JOIN moz_places p ON p.id = v.place_id WHERE p.url = :url AND v.visit_date = :time`,
    { url, time: date.getTime() * 1000 });
    const id = rows[0].getResultByName("id");
    await TestUtils.waitForCondition(async () =>
      (await SpaceHistory.file()).data.visits[id]?.spaceId === gZenWorkspaces.activeWorkspace,
    "A visit without a location notification records the inherited space");
    SpaceHistory._candidates = [];
    SpaceHistory.captureOpenVisit({ url: `${url}-missing`, time: Date.now() });
    is(SpaceHistory._candidates.length, 0, "Unrelated visits are not assigned to the selected tab");
  } finally {
    if (spaceId) {
      tab.setAttribute("zen-workspace-id", spaceId);
    }
    BrowserTestUtils.removeTab(tab);
    SpaceHistory._candidates = [];
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

  is((await SpaceHistory.query({ spaceId: "hist-work", search: "fixture Space" })).length,
    1, "History search matches words in either order like native Places search");
  await historyVisit(null, null, 200, "old");
  const unknown = await SpaceHistory.query({ search: "space-history.example.com/old" });
  is(unknown.length, 1, "Older history without a space shows in All spaces");
  is(unknown[0].spaceId, null, "unlabeled");
  is((await SpaceHistory.query({ spaceId: "hist-work", search: "space-history.example.com/old" })).length,
    0, "and in no single space");
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
    tab.removeAttribute("zen-workspace-id");
    SpaceHistory.capture(window, tab.linkedBrowser, uri);
    is(SpaceHistory._candidates.at(-1)?.spaceId, gZenWorkspaces.activeWorkspace,
      "Tabs without their own space use the window's active space");
    tab.setAttribute("zen-workspace-id", space.uuid);
    tab.dispatchEvent(new Event("SSTabRestored", { bubbles: true }));
    // An about:blank restored browser must not fabricate a history entry.
    ok(!SpaceHistory._candidates.some(item => item.url === "about:blank"),
      "Restoration only captures URLs Places can visit");
    SpaceHistory._candidates = SpaceHistory._candidates.slice(0, 1);
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
  await historyVisit(null, null, 550, "old-ui");
  library.activeTab = "history";
  await library.constructor.animateProgress(1);
  // animateProgress starts a spring; content ignores the pointer until it settles.
  await TestUtils.waitForCondition(() => !library.hasAttribute("transitioning"), "The Library finished opening");
  try {
    await TestUtils.waitForCondition(() => library.querySelector("whimsy-space-history-section"));
    const section = library.querySelector("whimsy-space-history-section");
    await section.refresh();
    await section.updateComplete;
    section.filtersOpen = true;
    await section.updateComplete;
    const group = [...section.querySelectorAll(".zen-library-filter-group")].find(
      item => item.querySelector('[data-l10n-id="whimsy-history-space-filter"]'));
    ok(group, "Space shares the native date and sort filter panel");
    // A Places notification can start a newer refresh that supersedes the
    // one awaited above; the space list arrives with whichever finishes last.
    await TestUtils.waitForCondition(() => [...group.querySelectorAll(".zen-library-filter-chip")]
      .some(item => item.textContent.trim() === "Design"), "The Design space chip renders");
    const filter = [...group.querySelectorAll(".zen-library-filter-chip")].find(
      item => item.textContent.trim() === "Design");
    ok(filter, "Spaces use the same chips as the other filters");
    filter.click();
    await TestUtils.waitForCondition(() => section._flatVisits?.length === 1 &&
      section._flatVisits[0].spaceId === "hist-ui");
    section.filtersOpen = false;
    await section.updateComplete;
    is(section.querySelectorAll(".zen-library-row").length, 1, "Space filter renders one matching visit");
    ok(section.querySelector(".whimsy-history-space-name"), "A visit has its space label");
    const row = section.querySelector(".zen-library-row");
    const rowURL = row.querySelector(".zen-library-visit-url");
    const rowDate = row.querySelector(".zen-library-visit-date");
    EventUtils.synthesizeMouseAtCenter(section.querySelector('input[type="search"]'), { type: "mousemove" });
    await TestUtils.waitForCondition(() => !row.matches(":hover"), "Pointer is outside the row");
    is(getComputedStyle(rowDate).display, "none", "The date does not run into the URL");
    isnot(getComputedStyle(rowURL).display, "none", "The URL is visible at rest");
    EventUtils.synthesizeMouseAtCenter(row, { type: "mousemove" });
    await TestUtils.waitForCondition(() => row.matches(":hover"), "Hovering the history row");
    is(getComputedStyle(rowURL).display, "none", "Hover replaces the URL");
    is(getComputedStyle(rowDate).display, "inline", "with the visit date, matching Zen");
    EventUtils.synthesizeMouseAtCenter(section.querySelector('input[type="search"]'), { type: "mousemove" });
    ok(section.querySelector('[data-l10n-id="library-history-forget-button"]'),
      "Native Forget action is preserved");

    const input = section.querySelector('input[type="search"]');
    const search = async (value, count) => {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await TestUtils.waitForCondition(() => section.searchQuery === value &&
        section._flatVisits?.length === count, `Search for ${value} updates the visible visits`);
      await section.updateComplete;
    };
    await search("fixture Space", 1);
    await search("no-such-visit", 0);
    ok(section.querySelector(".zen-library-empty"), "No matches show the native empty state");
    await search("", 1);
    section.activeFilters.delete("space:hist-ui");
    section.onFiltersChanged();
    await section.refresh();
    await section.updateComplete;
    const old = [...section.querySelectorAll(".zen-library-row")].find(
      row => row.whimsyVisit?.url.endsWith("/old-ui"));
    ok(old, "Older untagged visits remain in All Spaces");
    ok(!old.querySelector(".whimsy-history-space-name"), "An unknown visit has no space label");
    ok(!section.filterGroups.find(group => group.id === "space").options.some(option => option.id === "unknown"),
      "No Unknown space chip: unresolved visits fold into All spaces");
    ok(!section.querySelector('[data-l10n-id="whimsy-history-unknown-space"]'),
      "The History filter panel shows no Unknown space chip");

    section.activeFilters.delete("source:history");
    section.activeFilters.add("source:closed");
    section.onFiltersChanged();
    await section.updateComplete;
    ok(!section.filterGroups.some(item => item.id === "space"),
      "Closed tabs do not offer a visit-space filter");

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

add_task(async function each_visit_consumes_one_snapshot() {
  const visit = await historyVisit(null, null, 900, "repeat");
  const candidate = { url: visit.url, time: visit.time,
    spaceId: "hist-repeat", spaceName: "Repeat" };
  SpaceHistory._candidates = [{ ...candidate }, { ...candidate, time: visit.time + 1 }];
  await SpaceHistory.enqueue(() => SpaceHistory.recordVisit(visit));
  is((await SpaceHistory.file()).data.visits[visit.id]?.spaceId, "hist-repeat",
    "The first visit is recorded");
  is(SpaceHistory._candidates.length, 1, "The next visit's snapshot remains available");
  SpaceHistory._candidates = [];
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

// The ways a visit used to end up with no space: essentials (shared by
// every space), Glance, a stale space id, a window without spaces (Mini
// Whimsy, a site's popup), and session restore before spaces load.
add_task(async function every_surface_resolves_to_a_space() {
  const active = gZenWorkspaces.activeWorkspace;
  const other = await gZenWorkspaces.createAndSaveWorkspace("History other", undefined, true);
  await gZenWorkspaces.changeWorkspace(gZenWorkspaces.getWorkspaceFromId(active));
  // Stand-in tabs: only their attributes matter, and the real tab strip
  // isn't disturbed.
  const fakeTab = attrs => ({
    hasAttribute: name => name in attrs,
    getAttribute: name => attrs[name] ?? null,
  });
  const browser = gBrowser.selectedBrowser;
  try {
    is(SpaceHistory.spaceIdFor(window, browser, fakeTab({ "zen-workspace-id": other.uuid })),
      other.uuid, "A normal tab keeps its own space");
    is(SpaceHistory.spaceIdFor(window, browser,
      fakeTab({ "zen-workspace-id": other.uuid, "zen-essential": "true" })), active,
    "An essential belongs to the space showing it, not its stale id");
    is(SpaceHistory.spaceIdFor(window, browser,
      fakeTab({ "zen-workspace-id": other.uuid, "zen-glance-tab": "true" })), active,
    "A Glance belongs to the active space");
    is(SpaceHistory.spaceIdFor(window, browser, fakeTab({ "zen-workspace-id": "no-such-space" })),
      active, "A stale space id falls back to the active space");

    // A window without spaces (a site's popup) inherits the space of the
    // page that opened it.
    const openerTab = gBrowser.selectedTab;
    const openerSpace = SpaceHistory.spaceIdFor(window, browser, openerTab);
    ok(openerSpace, "The opener tab has a space");
    const popupBrowser = { browsingContext: { opener: { top: { embedderElement: browser } } } };
    const popupWin = { gZenWorkspaces: { workspaceEnabled: false } };
    is(SpaceHistory.spaceIdFor(popupWin, popupBrowser, fakeTab({})), openerSpace,
      "A popup's visit belongs to its opener tab's space");
    // Mini Whimsy, opened on its own: the space Move to Space would pick.
    const mini = { _whimsyQuickWindow: true, opener: window, gZenWorkspaces: { workspaceEnabled: true } };
    is(SpaceHistory.spaceIdFor(mini, { browsingContext: null }, fakeTab({})), active,
      "A Mini Whimsy visit belongs to the opener window's active space");

    // At startup a tab's space can be restored before the window's spaces
    // load: the id is kept and named when the visit is recorded.
    const url = "https://space-history.example.com/early";
    const date = new Date(Date.now() - 5000);
    await HistoryPlaces.history.insert({ url, title: "Early",
      visits: [{ date, transition: HistoryPlaces.history.TRANSITION_LINK }] });
    const db = await HistoryPlaces.promiseDBConnection();
    const [row] = await db.execute(`SELECT v.id, p.guid FROM moz_historyvisits v
      JOIN moz_places p ON p.id = v.place_id WHERE p.url = :url AND v.visit_date = :time`,
    { url, time: date.getTime() * 1000 });
    const visit = { id: row.getResultByName("id"), guid: row.getResultByName("guid"), time: date.getTime(), url };
    SpaceHistory._candidates = [{ url, time: visit.time, spaceId: other.uuid, spaceName: "" }];
    await SpaceHistory.enqueue(() => SpaceHistory.recordVisit(visit));
    const file = await SpaceHistory.file();
    is(file.data.visits[visit.id]?.spaceName, "History other",
      "A snapshot taken before spaces loaded is named when recorded");
    delete file.data.visits[visit.id];
    SpaceHistory._candidates = [{ url, time: visit.time, spaceId: "gone-space", spaceName: "" }];
    await SpaceHistory.enqueue(() => SpaceHistory.recordVisit(visit));
    ok(!file.data.visits[visit.id], "A space that never turns up leaves the visit unlabeled");
    await HistoryPlaces.history.remove(url);
  } finally {
    SpaceHistory._candidates = [];
    await gZenWorkspaces.removeWorkspace(other.uuid);
    await SpaceHistory.enqueue(() => SpaceHistory.prune());
  }
});

// "Where was the tab?" lists spaces in the user's own order (Zen's space
// strip), not by name; spaces that only survive in older visits go last.
add_task(async function space_filter_follows_space_order() {
  const zulu = await gZenWorkspaces.createAndSaveWorkspace("Zulu order", undefined, true);
  const alpha = await gZenWorkspaces.createAndSaveWorkspace("Alpha order", undefined, true);
  await historyVisit("hist-gone", "Gone space", 600, "gone");
  const library = document.querySelector("zen-library");
  const wasTab = library.activeTab;
  library.activeTab = "history";
  await library.constructor.animateProgress(1);
  const ids = () => section._spaceOptions.map(([id]) => id);
  let section;
  try {
    await TestUtils.waitForCondition(() => library.querySelector("whimsy-space-history-section"));
    section = library.querySelector("whimsy-space-history-section");
    const expected = () => [...gZenWorkspaces.getWorkspaces().filter(s => !s.whimsyScratch).map(s => s.uuid),
      "hist-gone"];
    await section.refresh();
    Assert.deepEqual(ids().filter(id => expected().includes(id)), expected(),
      "Spaces follow the space strip, then spaces only older visits remember");
    ok(ids().indexOf(zulu.uuid) < ids().indexOf(alpha.uuid), "Not alphabetical: Zulu was made first");
    await gZenWorkspaces.reorderWorkspace(alpha.uuid, 0);
    await section.refresh();
    is(ids()[0], alpha.uuid, "Moving a space to the front moves it to the front of the filter");
    const current = gZenWorkspaces.getWorkspaces().map(s => s.uuid);
    ok(ids().indexOf("hist-gone") > Math.max(...current.map(id => ids().indexOf(id))),
      "A deleted space stays after every current one");
  } finally {
    await library.constructor.animateProgress(0);
    library.activeTab = wasTab;
    await gZenWorkspaces.removeWorkspace(alpha.uuid);
    await gZenWorkspaces.removeWorkspace(zulu.uuid);
  }
});
