/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave5/profiles, phase 3: history per profile. Visits remember the
// profile they happened in (not the URL: the sidecar never copies URLs);
// the Library query and the address bar only show the current profile's
// pages; history from before profiles is Default's. A view filter, not
// isolation: "All Profiles" still shows everything.

const { WhimsySpaceHistory: SpaceHistory } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySpaceHistory.sys.mjs"
);
const { WhimsyProfiles } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyProfiles.sys.mjs"
);
const { WhimsyProfileHistory } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyProfileHistory.sys.mjs"
);
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
);
const { PlacesUtils: HistoryPlaces } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs"
);
const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);

const HOST = "profile-history.example.com";
let work, workKey;

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.feature.space-history", true], ["places.history.enabled", true],
    ["browser.urlbar.suggest.searches", false], ["browser.urlbar.autoFill", false],
  ] });
  SpaceHistory.initWindow(window);
  WhimsyProfileHistory.init();
  work = WhimsyProfiles.create("Whimsy History Work");
  workKey = WhimsyProfiles.keyFor(work);
  registerCleanupFunction(async () => {
    SpaceHistory._candidates = [];
    await HistoryPlaces.history.removeByFilter({ host: HOST });
    await SpaceHistory.enqueue(() => SpaceHistory.prune());
    ContextualIdentityService.remove(work);
  });
});

async function visitIn(path, profile, offset) {
  const url = `https://${HOST}/${path}`;
  const date = new Date(Date.now() - 10000 + offset);
  await HistoryPlaces.history.insert({ url, title: `Profile history ${path}`,
    visits: [{ date, transition: HistoryPlaces.history.TRANSITION_TYPED }] });
  const db = await HistoryPlaces.promiseDBConnection();
  const rows = await db.execute(`SELECT v.id, p.guid FROM moz_historyvisits v
    JOIN moz_places p ON p.id = v.place_id WHERE p.url = :url AND v.visit_date = :time`,
  { url, time: date.getTime() * 1000 });
  const visit = { id: rows[0].getResultByName("id"),
    guid: rows[0].getResultByName("guid"), time: date.getTime(), url };
  SpaceHistory._candidates = profile ? [{ url, time: visit.time, spaceId: `space-${profile}`,
    spaceName: "Space", profile }] : [];
  await SpaceHistory.enqueue(() => SpaceHistory.recordVisit(visit));
  return visit;
}

add_task(async function visits_remember_their_profile() {
  const workVisit = await visitIn("work", workKey, 0);
  await visitIn("home", "default", 100);
  await visitIn("old", null, 200);
  const record = (await SpaceHistory.file()).data.visits[workVisit.id];
  is(record.profile, workKey, "The visit carries the profile key");
  ok(!("url" in record), "…and still no copy of the URL");

  const inWork = await SpaceHistory.query({ profile: workKey, search: HOST });
  Assert.deepEqual(inWork.map(v => v.url), [`https://${HOST}/work`], "Work sees only its own page");
  const inDefault = (await SpaceHistory.query({ profile: "default", search: HOST })).map(v => v.url);
  ok(inDefault.includes(`https://${HOST}/home`) && inDefault.includes(`https://${HOST}/old`),
    "Default sees its pages and history from before profiles");
  ok(!inDefault.includes(`https://${HOST}/work`), "…but not Work's");
  is((await SpaceHistory.query({ search: HOST })).length, 3, "All Profiles shows everything");
});

add_task(async function two_spaces_one_profile_still_attributed() {
  const url = `https://${HOST}/shared`;
  const date = new Date();
  await HistoryPlaces.history.insert({ url, title: "Shared",
    visits: [{ date, transition: HistoryPlaces.history.TRANSITION_LINK }] });
  const db = await HistoryPlaces.promiseDBConnection();
  const [row] = await db.execute(`SELECT v.id, p.guid FROM moz_historyvisits v
    JOIN moz_places p ON p.id = v.place_id WHERE p.url = :url`, { url });
  const visit = { id: row.getResultByName("id"), guid: row.getResultByName("guid"),
    time: date.getTime(), url };
  SpaceHistory._candidates = ["a", "b"].map(spaceId => ({ url, time: visit.time, spaceId,
    spaceName: spaceId, profile: workKey }));
  await SpaceHistory.enqueue(() => SpaceHistory.recordVisit(visit));
  const record = (await SpaceHistory.file()).data.visits[visit.id];
  is(record?.spaceId, null, "The space stays unknown");
  is(record?.profile, workKey, "The profile is still known");
});

add_task(async function index_rules() {
  await SpaceHistory.enqueue(() => SpaceHistory.prune());
  ok(WhimsyProfileHistory.visibleIn(workKey, `https://${HOST}/work`), "Work page in Work");
  ok(!WhimsyProfileHistory.visibleIn("default", `https://${HOST}/work`), "…not in Default");
  ok(WhimsyProfileHistory.visibleIn("default", `https://${HOST}/old`), "Unattributed → Default");
  ok(!WhimsyProfileHistory.visibleIn(workKey, `https://${HOST}/old`), "…never in another profile");
  ok(WhimsyProfileHistory.visibleIn(workKey, `https://${HOST}/`, { origin: true }),
    "Autofill: the origin was visited in Work");
});

add_task(async function address_bar_filters_by_the_tab_profile() {
  const urls = async () => {
    const out = [];
    for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
      out.push((await UrlbarTestUtils.getDetailsOfResultAt(window, i)).url);
    }
    await UrlbarTestUtils.promisePopupClose(window);
    return out;
  };
  // openNewForegroundTab has no userContextId option: add the tab in Work.
  const tab = BrowserTestUtils.addTab(gBrowser, "about:blank", { userContextId: work });
  gBrowser.selectedTab = tab;
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, { wantLoad: "about:blank" }).catch(() => {});
  is(gBrowser.selectedBrowser.getAttribute("usercontextid"), String(work), "Typing in a Work tab");
  try {
    await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, waitForFocus: SimpleTest.waitForFocus,
      value: "Profile history" });
    const inWork = await urls();
    ok(inWork.includes(`https://${HOST}/work`), "Work's page is suggested in a Work tab");
    ok(!inWork.includes(`https://${HOST}/home`), "Default's page is not");
    ok(!inWork.includes(`https://${HOST}/old`), "Nor history from before profiles");
  } finally {
    BrowserTestUtils.removeTab(tab);
  }

  const plain = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  try {
    await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, waitForFocus: SimpleTest.waitForFocus,
      value: "Profile history" });
    const inDefault = await urls();
    ok(inDefault.includes(`https://${HOST}/home`) && inDefault.includes(`https://${HOST}/old`),
      "Default suggests its own and older pages");
    ok(!inDefault.includes(`https://${HOST}/work`), "…not Work's");

    await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.space-profiles", false]] });
    await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, waitForFocus: SimpleTest.waitForFocus,
      value: "Profile history" });
    ok((await urls()).includes(`https://${HOST}/work`), "Feature off: no filtering");
    await SpecialPowers.popPrefEnv();
  } finally {
    BrowserTestUtils.removeTab(plain);
  }
});
