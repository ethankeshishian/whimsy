/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W14-9: a private command bar (the Private Space, a private tab) shows
// nothing from normal browsing: no history, bookmarks, input or form
// history, top sites or normal tabs, and Zen's command ranking learns
// nothing from it (it's saved to prefs). The normal bar still does all that.

const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
const { PlacesTestUtils } = ChromeUtils.importESModule("resource://testing-common/PlacesTestUtils.sys.mjs");
const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");

const LEARNER_PREF = "zen.urlbar.suggestions-learner";
const TOKEN = "whimsynormalonly";
const HISTORY_URL = `https://example.com/browser/?${TOKEN}=history`;
const BOOKMARK_URL = `https://example.org/browser/?${TOKEN}=bookmark`;
const TAB_URL = `https://example.com/browser/?${TOKEN}=tab`;
const PRIVATE_URL = `https://example.com/browser/?${TOKEN}=private`;
const { UrlbarShared } = ChromeUtils.importESModule("chrome://browser/content/urlbar/UrlbarShared.mjs");
const { HISTORY, BOOKMARKS, TABS } = UrlbarShared.RESULT_SOURCE;

let startSpace;
let normalTab;
let bookmark;
const learnerBefore = Services.prefs.prefHasUserValue(LEARNER_PREF)
  ? Services.prefs.getStringPref(LEARNER_PREF)
  : null;

add_setup(async function () {
  startSpace = gZenWorkspaces.activeWorkspace;
  await PlacesTestUtils.addVisits([{ url: HISTORY_URL, title: `${TOKEN} history page` }]);
  bookmark = await PlacesUtils.bookmarks.insert({
    parentGuid: PlacesUtils.bookmarks.unfiledGuid,
    url: BOOKMARK_URL,
    title: `${TOKEN} bookmark`,
  });
  normalTab = await BrowserTestUtils.openNewForegroundTab(gBrowser, TAB_URL);
  registerCleanupFunction(async () => {
    await WhimsyPrivate.closeScratch(window);
    if (gZenWorkspaces.activeWorkspace != startSpace) {
      await gZenWorkspaces.changeWorkspaceWithID(startSpace);
    }
    if (normalTab.isConnected) {
      BrowserTestUtils.removeTab(normalTab);
    }
    await PlacesUtils.bookmarks.remove(bookmark);
    await PlacesUtils.history.clear();
    if (learnerBefore == null) {
      Services.prefs.clearUserPref(LEARNER_PREF);
    } else {
      Services.prefs.setStringPref(LEARNER_PREF, learnerBefore);
    }
  });
});

async function rows(searching = null) {
  await (searching ?? UrlbarTestUtils.promiseSearchComplete(window));
  const out = [];
  for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
    out.push((await UrlbarTestUtils.getDetailsOfResultAt(window, i)).result);
  }
  return out;
}

async function typeInBar(text) {
  const searching = UrlbarTestUtils.promiseSearchComplete(window);
  EventUtils.sendString(text);
  return rows(searching);
}

// The empty bar's own results: type a letter and take it back.
async function emptyBarRows() {
  await typeInBar("x");
  const searching = UrlbarTestUtils.promiseSearchComplete(window);
  EventUtils.synthesizeKey("KEY_Backspace");
  return rows(searching);
}

async function closeBar() {
  if (gURLBar.view.isOpen) {
    await UrlbarTestUtils.promisePopupClose(window, () => EventUtils.synthesizeKey("KEY_Escape"));
  }
  EventUtils.synthesizeKey("KEY_Escape");
  gBrowser.selectedBrowser.focus();
  await TestUtils.waitForTick();
  if (!gURLBar.focused && gURLBar.hasAttribute("zen-newtab")) {
    gURLBar._zenHandleUrlbarClose?.();
  }
  await TestUtils.waitForCondition(() => !gURLBar.view.isOpen, "The bar closed");
}

// Cmd+T as the app has it: Zen opens a real tab for it in automation
// (zen.testing.enabled), which in the Private Space is a private new tab
// page, not the command bar this file checks.
async function pressCmdT() {
  const tabs = gBrowser.tabs.length;
  const testing = gZenUIManager.testingEnabled;
  gZenUIManager.testingEnabled = false;
  try {
    EventUtils.synthesizeKey("t", { accelKey: true });
  } finally {
    gZenUIManager.testingEnabled = testing;
  }
  await TestUtils.waitForCondition(() => gURLBar.focused && gURLBar.hasAttribute("zen-newtab"), "Cmd+T opened the command bar");
  is(gBrowser.tabs.length, tabs, "...and no tab");
}

function normalRows(results) {
  return results.filter(r =>
    r.source == HISTORY ||
    r.source == BOOKMARKS ||
    r.providerName == "UrlbarProviderTopSites" ||
    r.providerName == "UrlbarProviderRemoteTabs" ||
    (r.payload?.url ?? "").includes(`${TOKEN}=history`) ||
    (r.payload?.url ?? "").includes(`${TOKEN}=bookmark`) ||
    (r.payload?.url ?? "").includes(`${TOKEN}=tab`) ||
    (r.payload?.suggestion ?? "").includes(TOKEN)
  );
}

function describe(results) {
  return JSON.stringify(results.map(r => [r.providerName, r.source, r.payload?.url ?? r.payload?.suggestion]));
}

add_task(async function the_normal_bar_still_suggests() {
  gBrowser.selectedTab = normalTab;
  EventUtils.synthesizeKey("l", { accelKey: true });
  await TestUtils.waitForCondition(() => gURLBar.focused, "Cmd+L focused the bar");
  ok(!gURLBar.isPrivate, "A normal bar");
  const results = await typeInBar(TOKEN);
  ok(results.some(r => (r.payload?.url ?? "").includes(`${TOKEN}=history`)), `History shows in the normal bar: ${describe(results)}`);
  ok(results.some(r => (r.payload?.url ?? "").includes(`${TOKEN}=bookmark`)), "…and the bookmark");
  await closeBar();
});

add_task(async function the_private_space_bar_shows_nothing_from_normal_browsing() {
  EventUtils.synthesizeKey("n", { accelKey: true, shiftKey: true });
  await TestUtils.waitForCondition(() => WhimsyPrivate.activeSpaceIsScratch(window), "The Private Space shows");
  await TestUtils.waitForCondition(() => !gZenWorkspaces.isChangingWorkspace, "Settled");

  // The empty bar over the Private Space's empty state.
  await pressCmdT();
  ok(gURLBar.isPrivate, "The bar is private");
  let results = await emptyBarRows();
  is(normalRows(results).length, 0, `The empty private bar lists no top sites, history or normal tabs: ${describe(results)}`);
  ok(!results.some(r => r.providerName == "WhimsyRecentTabs"), "…and no recent normal tabs");

  gURLBar.select();
  results = await typeInBar(TOKEN);
  is(normalRows(results).length, 0, `Typing lists no history, bookmark or normal tab: ${describe(results)}`);
  ok(!gURLBar.value.includes("example."), "Nothing was autofilled from history");
  await closeBar();

  // Restricted to history or bookmarks: still nothing.
  await pressCmdT();
  for (const restrict of ["^", "*", "%"]) {
    gURLBar.select();
    results = await typeInBar(`${restrict} ${TOKEN}`);
    is(normalRows(results).length, 0, `"${restrict}" lists nothing from normal browsing: ${describe(results)}`);
  }
  await closeBar();
});

add_task(async function a_private_tab_bar_lists_private_tabs_only() {
  const priv = WhimsyPrivate.openPrivateTab(window, { url: PRIVATE_URL });
  await BrowserTestUtils.browserLoaded(priv.linkedBrowser, false, PRIVATE_URL);
  const other = WhimsyPrivate.openPrivateTab(window, { url: PRIVATE_URL + "2" });
  await BrowserTestUtils.browserLoaded(other.linkedBrowser, false, PRIVATE_URL + "2");
  ok(WhimsyPrivate.activeSpaceIsScratch(window), "In the Private Space");

  await pressCmdT();
  let results = await emptyBarRows();
  const recent = results.filter(r => r.providerName == "WhimsyRecentTabs");
  ok(recent.length >= 1, `The empty private bar lists recent private tabs: ${describe(results)}`);
  const privateURLs = new Set(gZenWorkspaces.allStoredTabs.filter(t => WhimsyPrivate.isPrivateTab(t))
    .map(t => t.linkedBrowser.currentURI.spec));
  ok(recent.every(r => privateURLs.has(r.payload.url) && r.payload.url != TAB_URL), "…and only private ones");
  gURLBar.select();
  results = await typeInBar(TOKEN);
  is(normalRows(results).length, 0, `Typing still lists nothing from normal browsing: ${describe(results)}`);
  ok(results.some(r => r.source == TABS && r.payload?.url?.includes(`${TOKEN}=private`)),
    "An open private tab can still be switched to");
  await closeBar();
  BrowserTestUtils.removeTab(other);
  gBrowser.selectedTab = priv;
});

add_task(async function a_private_session_teaches_the_ranking_nothing() {
  const pickReload = async () => {
    EventUtils.synthesizeKey("l", { accelKey: true });
    await TestUtils.waitForCondition(() => gURLBar.focused, "Cmd+L focused the bar");
    const results = await typeInBar("reload tab");
    const index = results.findIndex(r => r.commandId == "Browser:Reload" || r.payload?.zenCommand == "Browser:Reload");
    Assert.greaterOrEqual(index, 0, `Reload Tab is listed: ${describe(results)}`);
    const loaded = BrowserTestUtils.browserLoaded(gBrowser.selectedBrowser);
    UrlbarTestUtils.setSelectedRowIndex(window, index);
    EventUtils.synthesizeKey("KEY_Enter");
    await loaded;
    await TestUtils.waitForCondition(() => !gURLBar.view.isOpen, "The bar closed");
  };

  ok(WhimsyPrivate.isPrivateTab(gBrowser.selectedTab), "On a private tab");
  Services.prefs.setStringPref(LEARNER_PREF, "{}");
  await pickReload();
  is(Services.prefs.getStringPref(LEARNER_PREF), "{}", "A private session left the learner alone");

  // The normal bar still learns (the same pick, on a normal tab).
  await WhimsyPrivate.closeScratch(window);
  ok(!WhimsyPrivate.getScratch(window), "The Private Space closed");
  if (gZenWorkspaces.activeWorkspace != startSpace) {
    await gZenWorkspaces.changeWorkspaceWithID(startSpace);
  }
  gBrowser.selectedTab = normalTab;
  await pickReload();
  isnot(Services.prefs.getStringPref(LEARNER_PREF), "{}", "A normal session still teaches it");
});
