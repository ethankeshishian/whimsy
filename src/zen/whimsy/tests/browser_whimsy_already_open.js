/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave6: Already open (Arc). Return on a typed address that's open in another
// tab goes there (switching space) instead of opening a copy. Modifiers, the
// switch, other containers, private tabs and editing the current page's
// address all keep Firefox's behavior.

ChromeUtils.defineESModuleGetters(this, {
  UrlbarTestUtils: "resource://testing-common/UrlbarTestUtils.sys.mjs",
  WhimsyAlreadyOpen: "resource:///modules/whimsy/WhimsyAlreadyOpen.sys.mjs",
});

const FEATURE = "whimsy.feature.already-open";
const URL = "https://example.com/browser/whimsy-already-open";

let firstSpace, secondSpace;

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, true]] });
  firstSpace = gZenWorkspaces.getWorkspaces().find(w => w.uuid == gZenWorkspaces.activeWorkspace);
  secondSpace = await gZenWorkspaces.createAndSaveWorkspace("Work", "💼", true);
  registerCleanupFunction(async () => {
    await gZenWorkspaces.changeWorkspace(firstSpace);
    await gZenWorkspaces.removeWorkspace(secondSpace.uuid);
  });
});

async function typeAndEnter(win, value, modifiers = {}) {
  await UrlbarTestUtils.promiseAutocompleteResultPopup({ window: win, waitForFocus: SimpleTest.waitForFocus, value });
  const { result } = await UrlbarTestUtils.getDetailsOfResultAt(win, 0);
  ok(result.heuristic, "The typed address is the heuristic result");
  EventUtils.synthesizeKey("KEY_Enter", modifiers, win);
}

function countTabsWith(win, url) {
  return win.gBrowser.tabs.filter(t => t.linkedBrowser.currentURI.spec == url).length;
}

add_task(async function test_key() {
  is(WhimsyAlreadyOpen.key("http://example.com/a#x"), "https://example.com/a", "Fragment and http/https ignored");
  is(WhimsyAlreadyOpen.key("about:blank"), null, "Only web pages match");
  is(WhimsyAlreadyOpen.key("not a url"), null, "Garbage is ignored");
});

add_task(async function test_switches_space() {
  const original = await BrowserTestUtils.openNewForegroundTab(gBrowser, URL);
  is(original.getAttribute("zen-workspace-id"), firstSpace.uuid, "Opened in the first space");
  await gZenWorkspaces.changeWorkspace(secondSpace);
  const empty = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  is(empty.getAttribute("zen-workspace-id"), secondSpace.uuid, "Typing from a tab in Work");

  // gBrowser.tabs only lists the active space's tabs in Zen, so count tab
  // opens instead of comparing lengths across a space switch.
  let opens = 0;
  const onOpen = () => opens++;
  gBrowser.tabContainer.addEventListener("TabOpen", onOpen);
  await typeAndEnter(window, URL);
  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab == original && gZenWorkspaces.activeWorkspace == firstSpace.uuid,
    "Went to the open tab, in its space"
  );
  await TestUtils.waitForCondition(() => !empty.isConnected || empty.closing, "The empty tab closed");
  is(countTabsWith(window, URL), 1, "No duplicate");
  gBrowser.tabContainer.removeEventListener("TabOpen", onOpen);
  is(opens, 0, "No new tab");
  BrowserTestUtils.removeTab(original);
});

add_task(async function test_modifier_and_switch_off_keep_both() {
  const original = await BrowserTestUtils.openNewForegroundTab(gBrowser, URL);
  // Option-Return: Firefox opens a new tab, on purpose. (From a page: in an
  // empty tab Firefox reuses that tab instead, by design.)
  const first = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  let opened = BrowserTestUtils.waitForNewTab(gBrowser, URL, true);
  await typeAndEnter(window, URL, { altKey: true });
  const copy = await opened;
  is(countTabsWith(window, URL), 2, "Option-Return keeps both");
  BrowserTestUtils.removeTab(copy);
  if (first.isConnected) {
    BrowserTestUtils.removeTab(first);
  }

  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
  const blank = gBrowser.selectedTab.isEmpty
    ? gBrowser.selectedTab
    : await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  const loaded = BrowserTestUtils.browserLoaded(blank.linkedBrowser, false, URL);
  await typeAndEnter(window, URL);
  await loaded;
  is(gBrowser.selectedTab, blank, "Switch off: loads where you typed");
  is(countTabsWith(window, URL), 2, "and keeps both");
  await SpecialPowers.popPrefEnv();
  BrowserTestUtils.removeTab(blank);
  BrowserTestUtils.removeTab(original);
});

add_task(async function test_editing_current_page_navigates() {
  const original = await BrowserTestUtils.openNewForegroundTab(gBrowser, URL);
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  const loaded = BrowserTestUtils.browserLoaded(other.linkedBrowser, false, URL);
  await typeAndEnter(window, URL);
  await loaded;
  is(gBrowser.selectedTab, other, "Editing a page's address navigates that page (Cmd+L)");
  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(original);
});

add_task(async function test_containers_and_private_never_match() {
  const contained = BrowserTestUtils.addTab(gBrowser, URL, { userContextId: 1 });
  await BrowserTestUtils.browserLoaded(contained.linkedBrowser, false, URL);
  const blank = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  const loaded = BrowserTestUtils.browserLoaded(blank.linkedBrowser, false, URL);
  await typeAndEnter(window, URL);
  await loaded;
  is(gBrowser.selectedTab, blank, "A tab in another container is not this page");
  BrowserTestUtils.removeTab(blank);

  const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, URL);
  const privateWin = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    const tab = privateWin.gBrowser.selectedTab;
    const privLoaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, URL);
    await typeAndEnter(privateWin, URL);
    await privLoaded;
    is(privateWin.gBrowser.selectedTab, tab, "Private: never jumps to a normal tab");
    is(
      WhimsyAlreadyOpen.findTab(privateWin, URL, { userContextId: 0, isPrivate: false })?.tab,
      normal,
      "and a normal search finds the normal tab, never the private one"
    );
    is(
      WhimsyAlreadyOpen.findTab(window, URL, { userContextId: 0, isPrivate: true })?.tab,
      tab,
      "while a private search only finds the private tab"
    );
  } finally {
    await BrowserTestUtils.closeWindow(privateWin);
  }
  BrowserTestUtils.removeTab(normal);
  BrowserTestUtils.removeTab(contained);
});

add_task(async function test_promote_open_tabs() {
  const dummyHeuristic = { heuristic: true, type: 2, payload: {} };
  const dummyHistory = { heuristic: false, type: 3, payload: { url: "https://example.com/hist" } };
  const dummyTabSwitch1 = { heuristic: false, type: 1, payload: { url: "https://example.com/tab1" } };
  const dummyTabSwitch2 = { heuristic: false, source: 4, payload: { url: "https://example.com/tab2" } };

  // 1: tab switch results are promoted right below heuristic
  const qc1 = {
    results: [dummyHeuristic, dummyHistory, dummyTabSwitch1, dummyTabSwitch2],
  };
  WhimsyAlreadyOpen.promoteOpenTabs(qc1);
  Assert.deepEqual(
    qc1.results,
    [dummyHeuristic, dummyTabSwitch1, dummyTabSwitch2, dummyHistory],
    "Tab switch results promoted to index 1 below heuristic"
  );

  // 2: non-heuristic query promotes tab switch to index 0
  const qc2 = {
    results: [dummyHistory, dummyTabSwitch1],
  };
  WhimsyAlreadyOpen.promoteOpenTabs(qc2);
  Assert.deepEqual(
    qc2.results,
    [dummyTabSwitch1, dummyHistory],
    "Tab switch result promoted to index 0 when no heuristic"
  );

  // 3: disabled pref leaves order intact
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
  const qc3 = {
    results: [dummyHeuristic, dummyHistory, dummyTabSwitch1],
  };
  WhimsyAlreadyOpen.promoteOpenTabs(qc3);
  Assert.deepEqual(
    qc3.results,
    [dummyHeuristic, dummyHistory, dummyTabSwitch1],
    "When disabled, result order is unchanged"
  );
  await SpecialPowers.popPrefEnv();

  // 4: view hook in window is active
  WhimsyAlreadyOpen.initWindow(window);
  if (window.gURLBar.view) {
    ok(window.gURLBar.view._whimsyRankHooked, "UrlbarView onQueryResults is hooked");
  }
});
