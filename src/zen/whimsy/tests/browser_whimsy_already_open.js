/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave8/isolation: a tab lives in a space of its own profile (container),
// so a container tab is opened the way a user gets one: in a space of
// that container. The tab is moved there by the isolation guard.
async function containerSpace(userContextId) {
  const space = await gZenWorkspaces.createAndSaveWorkspace(`Container ${userContextId}`, undefined, true, userContextId);
  registerCleanupFunction(async () => {
    for (const tab of gZenWorkspaces.allStoredTabs.filter(t => t.getAttribute("zen-workspace-id") == space.uuid &&
      !t.hasAttribute("zen-essential") && !t.hasAttribute("zen-empty-tab"))) {
      BrowserTestUtils.removeTab(tab);
    }
    if (gZenWorkspaces.getWorkspaces().some(w => w.uuid == space.uuid)) {
      await gZenWorkspaces.removeWorkspace(space.uuid);
    }
  });
  return space;
}

// wave6: Already open (Arc). Return on a typed address that's open in another
// tab goes there (switching space) instead of opening a copy. Modifiers, the
// switch, other containers, private tabs and editing the current page's
// address all keep Firefox's behavior.

ChromeUtils.defineESModuleGetters(this, {
  UrlbarTestUtils: "resource://testing-common/UrlbarTestUtils.sys.mjs",
  WhimsyAlreadyOpen: "resource:///modules/whimsy/WhimsyAlreadyOpen.sys.mjs",
  PlacesTestUtils: "resource://testing-common/PlacesTestUtils.sys.mjs",
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
  const home = gZenWorkspaces.getActiveWorkspace();
  await gZenWorkspaces.changeWorkspace(await containerSpace(1));
  const contained = BrowserTestUtils.addTab(gBrowser, URL, { userContextId: 1 });
  await BrowserTestUtils.browserLoaded(contained.linkedBrowser, false, URL);
  await gZenWorkspaces.changeWorkspace(home);
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

// W10-36: a pinned tab had no "Switch to Tab" row in the Cmd+T command bar
// when you were on it, but did from another space. Zen's Cmd+T bar opens
// over the selected tab, so Firefox took that tab as the current page and
// left it out. W11-08: the tab you're on is now listed as an ordinary link,
// as in Arc, and picking it in Cmd+T opens a second copy; from any other
// tab or space it's a Switch to Tab.
const PINNED_URL = "https://example.com/browser/whimsy-switch-pinned";

async function closeCommandBar() {
  EventUtils.synthesizeKey("KEY_Escape");
  if (gURLBar.focused) {
    EventUtils.synthesizeKey("KEY_Escape");
  }
  gBrowser.selectedBrowser.focus();
  await TestUtils.waitForTick();
  if (gURLBar.hasAttribute("zen-newtab") && !gURLBar.matches(":popover-open")) {
    gURLBar._zenHandleUrlbarClose?.();
  }
  await TestUtils.waitForCondition(() => !gURLBar.hasAttribute("zen-newtab") && !gURLBar.view.isOpen, "The command bar closed");
}

// W11-08: the ordinary (URL) row for `url`, not the typed address.
async function linkRowFor(url) {
  const { UrlbarShared } = ChromeUtils.importESModule("chrome://browser/content/urlbar/UrlbarShared.mjs");
  const count = UrlbarTestUtils.getResultCount(window);
  for (let i = 0; i < count; i++) {
    const { result } = await UrlbarTestUtils.getDetailsOfResultAt(window, i);
    if (result.type == UrlbarShared.RESULT_TYPE.URL && !result.heuristic && result.payload.url == url) {
      return i;
    }
  }
  return -1;
}

async function switchRowFor(url) {
  const { UrlbarShared } = ChromeUtils.importESModule("chrome://browser/content/urlbar/UrlbarShared.mjs");
  const count = UrlbarTestUtils.getResultCount(window);
  for (let i = 0; i < count; i++) {
    const { result } = await UrlbarTestUtils.getDetailsOfResultAt(window, i);
    if (result.type == UrlbarShared.RESULT_TYPE.TAB_SWITCH && result.payload.url == url) {
      return i;
    }
  }
  return -1;
}

// Cmd+T, type part of the address, and return the Switch to Tab row's index.
async function newTabBarSwitchRow(search) {
  // Zen opens real tabs for Cmd+T in automation (zen.testing.enabled); the
  // app opens its command bar, which is what this checks.
  const testing = gZenUIManager.testingEnabled;
  gZenUIManager.testingEnabled = false;
  try {
    document.getElementById("cmd_newNavigatorTab").doCommand();
  } finally {
    gZenUIManager.testingEnabled = testing;
  }
  await TestUtils.waitForCondition(() => gURLBar.hasAttribute("zen-newtab"), "Cmd+T opened Zen's command bar");
  gURLBar.search(search);
  await UrlbarTestUtils.promiseSearchComplete(window);
  return switchRowFor(PINNED_URL);
}

add_task(async function test_new_tab_bar_offers_pinned_tab_in_every_space() {
  await PlacesTestUtils.addVisits({ uri: PINNED_URL, title: "Whimsy pinned switch" });
  await gZenWorkspaces.changeWorkspace(firstSpace);
  const pinned = await BrowserTestUtils.openNewForegroundTab(gBrowser, PINNED_URL);
  gBrowser.pinTab(pinned);
  ok(pinned.pinned, "The tab is pinned in the first space");
  const search = "whimsy-switch-pinned";

  // On the pinned tab, in its own space: the bug. W11-08: listed as an
  // ordinary link; picking it opens a second copy, as in Arc.
  gBrowser.selectedTab = pinned;
  is(await newTabBarSwitchRow(search), -1, "On the pinned tab: no Switch to Tab to the tab you're on");
  let index = await linkRowFor(PINNED_URL);
  Assert.greater(index, -1, "Same space, on the pinned tab: the Cmd+T bar lists it as a link");
  EventUtils.synthesizeKey("KEY_ArrowDown", { repeat: index });
  is(UrlbarTestUtils.getSelectedRowIndex(window), index, "The row is selected");
  const copyOpened = BrowserTestUtils.waitForNewTab(gBrowser, PINNED_URL, true);
  EventUtils.synthesizeKey("KEY_Enter");
  const copy = await copyOpened;
  await TestUtils.waitForCondition(() => !gURLBar.hasAttribute("zen-newtab"), "Picking it closes the bar");
  is(gBrowser.selectedTab, copy, "and opens a second copy");
  ok(!copy.pinned && pinned.pinned, "The copy is a new tab; the pinned tab stays");
  BrowserTestUtils.removeTab(copy);
  gBrowser.selectedTab = pinned;

  // Same space, from another tab: unchanged.
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  index = await newTabBarSwitchRow(search);
  Assert.greater(index, -1, "Same space, from another tab: Switch to Tab");
  await closeCommandBar();

  // Another space: unchanged.
  await gZenWorkspaces.changeWorkspace(secondSpace);
  index = await newTabBarSwitchRow(search);
  Assert.greater(index, -1, "Another space: Switch to Tab");
  await closeCommandBar();
  await gZenWorkspaces.changeWorkspace(firstSpace);

  // Editing the pinned tab's own address (Cmd+L): never a Switch to Tab to
  // the page you're on; W11-08: it's listed as a link there too.
  gBrowser.selectedTab = pinned;
  await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, waitForFocus: SimpleTest.waitForFocus, value: search });
  ok(!gURLBar.hasAttribute("zen-newtab"), "Cmd+L edits the current page");
  is(await switchRowFor(PINNED_URL), -1, "Editing the current page doesn't offer switching to it");
  Assert.greater(await linkRowFor(PINNED_URL), -1, "…but lists it as a link");
  await UrlbarTestUtils.promisePopupClose(window, () => gURLBar.blur());

  BrowserTestUtils.removeTab(other);
  gBrowser.unpinTab(pinned);
  BrowserTestUtils.removeTab(pinned);
  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
  await PlacesUtils.history.remove(PINNED_URL);
});

// W11-08 / W11-09 helpers. Cmd+T over the selected tab, then type.
async function commandBar(text) {
  // Zen opens real tabs for Cmd+T in automation (zen.testing.enabled); the
  // app opens its command bar, which is what these check.
  const testing = gZenUIManager.testingEnabled;
  gZenUIManager.testingEnabled = false;
  try {
    document.getElementById("cmd_newNavigatorTab").doCommand();
  } finally {
    gZenUIManager.testingEnabled = testing;
  }
  await TestUtils.waitForCondition(() => gURLBar.hasAttribute("zen-newtab"), "Cmd+T opened Zen's command bar");
  gURLBar.search(text);
  await UrlbarTestUtils.promiseSearchComplete(window);
}

async function rows() {
  const out = [];
  for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
    out.push(await UrlbarTestUtils.getDetailsOfResultAt(window, i));
  }
  return out;
}

const { UrlbarShared } = ChromeUtils.importESModule("chrome://browser/content/urlbar/UrlbarShared.mjs");
const RANK_WORD = "whimsyrankfirst";
const RANK_URL = `https://example.com/browser/${RANK_WORD}`;

async function openRankTab() {
  await PlacesTestUtils.addVisits({ uri: RANK_URL, title: "Whimsy rank first" });
  await gZenWorkspaces.changeWorkspace(firstSpace);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, RANK_URL);
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  return { tab, other };
}

async function cleanupRank(...tabs) {
  if (gURLBar.hasAttribute("zen-newtab") || gURLBar.view.isOpen) {
    await closeCommandBar();
  }
  for (const tab of tabs) {
    if (tab?.isConnected) {
      BrowserTestUtils.removeTab(tab);
    }
  }
  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
  await PlacesUtils.history.remove(RANK_URL);
}

// W11-09: a typed search that matches an open tab: Switch to Tab first,
// selected, and Return goes there; the search is the next row.
add_task(async function test_open_tab_ranks_above_search() {
  const { tab, other } = await openRankTab();
  let opens = 0;
  const onOpen = () => opens++;
  gBrowser.tabContainer.addEventListener("TabOpen", onOpen);
  await commandBar(RANK_WORD);
  const [first, second] = await rows();
  is(first.result.type, UrlbarShared.RESULT_TYPE.TAB_SWITCH, "The open tab is the first row");
  is(first.result.payload.url, RANK_URL, "…for the matching tab");
  ok(first.result.heuristic, "…and is what Return picks");
  is(second.result.type, UrlbarShared.RESULT_TYPE.SEARCH, "The search is the second row");
  ok(!second.result.heuristic, "…as an ordinary row");
  is(second.result.payload.query, RANK_WORD, "…for what you typed");
  is(UrlbarTestUtils.getSelectedRowIndex(window), 0, "The tab row is selected");
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == tab, "Return switched to the tab");
  await TestUtils.waitForCondition(() => !gURLBar.hasAttribute("zen-newtab"), "The bar closed");
  gBrowser.tabContainer.removeEventListener("TabOpen", onOpen);
  is(opens, 0, "No tab was opened");
  await cleanupRank(tab, other);
});

// W11-09, F34: a typed address that's open: Switch to Tab first, and no
// second row for the same page (Option-Return still opens a copy).
add_task(async function test_open_tab_ranks_above_typed_address() {
  const { tab, other } = await openRankTab();
  await commandBar(RANK_URL);
  const all = await rows();
  const [first] = all;
  is(first.result.type, UrlbarShared.RESULT_TYPE.TAB_SWITCH, "Switch to Tab is first");
  is(first.result.payload.url, RANK_URL, "…for the tab showing that address");
  // F34: the typed address of that same page isn't a second row.
  is(all.filter(r => r.result.payload.url == RANK_URL).length, 1, "One row for that page");
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == tab, "Return goes to the tab");
  await cleanupRank(tab, other);
});

// W11-09: Option-Return on the ranked tab still means what you typed (a new
// tab with that address), as before the tab ranked first.
add_task(async function test_modified_return_means_the_typed_address() {
  const { tab, other } = await openRankTab();
  await commandBar(RANK_URL);
  is((await UrlbarTestUtils.getDetailsOfResultAt(window, 0)).result.type, UrlbarShared.RESULT_TYPE.TAB_SWITCH, "Tab first");
  const copyOpened = BrowserTestUtils.waitForNewTab(gBrowser, RANK_URL, true);
  EventUtils.synthesizeKey("KEY_Enter", { altKey: true });
  const copy = await copyOpened;
  isnot(copy, tab, "Option-Return opened the address in a new tab");
  BrowserTestUtils.removeTab(copy);
  await cleanupRank(tab, other);
});

// W11-09: nothing open matches: Firefox's order, and Return goes to the
// typed address.
add_task(async function test_no_open_tab_keeps_the_typed_address_first() {
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  const typed = "https://example.com/browser/whimsy-not-open-anywhere";
  await commandBar(typed);
  const [first] = await rows();
  ok(first.result.heuristic, "The typed address is the heuristic");
  is(first.result.type, UrlbarShared.RESULT_TYPE.URL, "…and the first row");
  ok(!(await rows()).some(r => r.result.whimsyOwnHeuristic !== undefined), "Nothing was re-ranked");
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, typed, true);
  EventUtils.synthesizeKey("KEY_Enter");
  const page = await opened;
  is(gBrowser.selectedTab, page, "Return opened the typed address");
  BrowserTestUtils.removeTab(page);
  BrowserTestUtils.removeTab(other);
});

// W11-09: Cmd+L (editing a page's address) and the switch off keep
// Firefox's order: the typed address stays first.
add_task(async function test_cmd_l_and_switch_off_keep_order() {
  const { tab, other } = await openRankTab();
  await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, waitForFocus: SimpleTest.waitForFocus, value: RANK_URL });
  let first = (await UrlbarTestUtils.getDetailsOfResultAt(window, 0)).result;
  ok(!gURLBar.hasAttribute("zen-newtab"), "Cmd+L edits the page");
  isnot(first.type, UrlbarShared.RESULT_TYPE.TAB_SWITCH, "Cmd+L: the typed address stays first");
  await UrlbarTestUtils.promisePopupClose(window, () => gURLBar.blur());

  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
  await commandBar(RANK_WORD);
  first = (await UrlbarTestUtils.getDetailsOfResultAt(window, 0)).result;
  is(first.type, UrlbarShared.RESULT_TYPE.SEARCH, "Switch off: the search stays first");
  await closeCommandBar();
  await SpecialPowers.popPrefEnv();
  await cleanupRank(tab, other);
});

// W11-08: Cmd+T on a tab and type it: as in Arc, the tab is listed as an
// ordinary link (title and address, no Switch to Tab), and picking it opens
// a second copy.
add_task(async function test_tab_you_are_on_is_a_link_in_cmd_t() {
  const { tab, other } = await openRankTab();
  gBrowser.selectedTab = tab;
  await commandBar(RANK_WORD);
  const all = await rows();
  ok(all[0].result.heuristic && all[0].result.type == UrlbarShared.RESULT_TYPE.SEARCH, "The search stays first");
  ok(!all.some(r => r.result.type == UrlbarShared.RESULT_TYPE.TAB_SWITCH && r.result.payload.url == RANK_URL), "No Switch to Tab for the tab you're on");
  const index = await linkRowFor(RANK_URL);
  Assert.greater(index, 0, "The tab you're on is listed as a link");
  isnot(all[index].displayed.action, "Switch to Tab", "…with no Switch to Tab label");
  EventUtils.synthesizeKey("KEY_ArrowDown", { repeat: index });
  const copyOpened = BrowserTestUtils.waitForNewTab(gBrowser, RANK_URL, true);
  EventUtils.synthesizeKey("KEY_Enter");
  const copy = await copyOpened;
  is(gBrowser.selectedTab, copy, "Picking it opened a second copy");
  ok(tab.isConnected && copy != tab, "…and kept the tab you were on");
  BrowserTestUtils.removeTab(copy);
  await cleanupRank(tab, other);
});

// W11-08: Cmd+T and Return on the exact address of the tab you're on opens
// a second copy (wave 6 used to just close the bar).
add_task(async function test_return_on_own_address_opens_a_copy() {
  const { tab, other } = await openRankTab();
  gBrowser.selectedTab = tab;
  await commandBar(RANK_URL);
  const { result } = await UrlbarTestUtils.getDetailsOfResultAt(window, 0);
  ok(result.heuristic && result.type == UrlbarShared.RESULT_TYPE.URL, "The typed address is first: there's no other tab to switch to");
  const copyOpened = BrowserTestUtils.waitForNewTab(gBrowser, RANK_URL, true);
  EventUtils.synthesizeKey("KEY_Enter");
  const copy = await copyOpened;
  is(gBrowser.selectedTab, copy, "Return opened a second copy");
  ok(tab.isConnected, "…and kept the tab you were on");
  BrowserTestUtils.removeTab(copy);
  await cleanupRank(tab, other);
});

// W11-08: Cmd+L lists the tab you're on as a link too; picking it loads the
// page again in that tab, and opens nothing.
add_task(async function test_tab_you_are_on_is_a_link_in_cmd_l() {
  const { tab, other } = await openRankTab();
  gBrowser.selectedTab = tab;
  await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, waitForFocus: SimpleTest.waitForFocus, value: RANK_WORD });
  ok(!gURLBar.hasAttribute("zen-newtab"), "Cmd+L edits the page");
  const index = await linkRowFor(RANK_URL);
  Assert.greater(index, -1, "The tab you're on is listed as a link");
  let opens = 0;
  const onOpen = () => opens++;
  gBrowser.tabContainer.addEventListener("TabOpen", onOpen);
  const reloaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, RANK_URL);
  EventUtils.synthesizeKey("KEY_ArrowDown", { repeat: index });
  EventUtils.synthesizeKey("KEY_Enter");
  await reloaded;
  gBrowser.tabContainer.removeEventListener("TabOpen", onOpen);
  is(gBrowser.selectedTab, tab, "The page loaded again in its own tab");
  is(opens, 0, "No tab was opened");
  await cleanupRank(tab, other);
});

// W11-09: the bar waits for the open-tab providers, so the first results it
// shows already have the tab first: no row jumps under the pointer.
add_task(async function test_tab_row_never_jumps() {
  const { tab, other } = await openRankTab();
  const firsts = [];
  const listener = {
    onQueryResults(queryContext) {
      if (queryContext.searchString == RANK_WORD) {
        firsts.push(queryContext.results[0]?.type);
      }
    },
  };
  gURLBar.controller.addListener(listener);
  try {
    await commandBar(RANK_WORD);
  } finally {
    gURLBar.controller.removeListener(listener);
  }
  Assert.greater(firsts.length, 0, "Results were shown");
  ok(
    firsts.every(type => type == UrlbarShared.RESULT_TYPE.TAB_SWITCH),
    `Every update had the tab first, the first paint included (${firsts})`
  );
  await cleanupRank(tab, other);
});

// W11-08: Open Again in New Tab is a command with an assignable shortcut,
// and does nothing on an empty tab.
add_task(async function test_open_again_command() {
  const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
  const entry = WhimsyCommands.get("cmd_whimsyOpenAgainInNewTab");
  ok(entry, "Open Again in New Tab is a registered command");
  is(WhimsyCommands.title(entry), "Open Again in New Tab", "…with that name");
  is(entry.defaultKey, null, "…no default shortcut");
  ok(document.getElementById(entry.keyId), "…and a <key> to assign one to");

  const { tab, other } = await openRankTab();
  gBrowser.selectedTab = tab;
  const copyOpened = BrowserTestUtils.waitForNewTab(gBrowser, RANK_URL, true);
  document.getElementById("cmd_whimsyOpenAgainInNewTab").doCommand();
  const copy = await copyOpened;
  is(gBrowser.selectedTab, copy, "The command opened the tab again, in front");
  BrowserTestUtils.removeTab(copy);

  const blank = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  is(WhimsyAlreadyOpen.openAgainUrl(window), null, "An empty tab has nothing to open again");
  ok(!WhimsyAlreadyOpen.openAgain(window), "…so the command does nothing");
  BrowserTestUtils.removeTab(blank);
  await cleanupRank(tab, other);
});

// W11-09: the view's open-tab grouping keeps the typed row right below a
// tab ranked first.
add_task(function test_promote_keeps_typed_row_second() {
  const ranked = { heuristic: true, whimsyOwnHeuristic: false, type: 1, payload: { url: "https://example.com/a" } };
  const typed = { heuristic: false, whimsyOwnHeuristic: true, type: 2, payload: {} };
  const history = { heuristic: false, type: 3, payload: { url: "https://example.com/hist" } };
  const otherTab = { heuristic: false, type: 1, payload: { url: "https://example.com/b" } };
  const qc = { results: [ranked, typed, history, otherTab] };
  WhimsyAlreadyOpen.promoteOpenTabs(qc);
  Assert.deepEqual(qc.results, [ranked, typed, otherTab, history], "Ranked tab, typed row, then the other tabs");
  ok(WhimsyAlreadyOpen.isRankedTab(ranked) && WhimsyAlreadyOpen.isTypedRow(typed), "The rows are told apart");
});

// F34: an Essential on an address with a #fragment, as Gmail's
// https://mail.google.com/mail/u/1/#inbox. Typing that exact address in
// Cmd+T lists it once (plus nothing that both switches and searches), and
// Return opens a second copy in a new tab, as for any tab you're on.
add_task(async function test_essential_with_fragment_one_row() {
  const url = "https://example.com/browser/whimsyessential/#inbox";
  await PlacesTestUtils.addVisits({ uri: url, title: "Whimsy essential inbox" });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  gZenPinnedTabManager.addToEssentials(tab);
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/?f34");
  try {
    gBrowser.selectedTab = tab;
    await commandBar(url);
    const all = await rows();
    info(all.map(r => `${r.type}/${r.result.providerName}/${r.result.heuristic}/${r.url}/${r.displayed.action}`).join("\n"));
    const same = all.filter(r => r.result.payload.url && r.result.payload.url.replace(/#.*/, "") == url.replace(/#.*/, ""));
    is(same.length, 1, "One row for the address");
    ok(!all.some(r => r.result.type == UrlbarShared.RESULT_TYPE.TAB_SWITCH), "No Switch to Tab to the tab you're on");
    const copyOpened = BrowserTestUtils.waitForNewTab(gBrowser, url, true);
    EventUtils.synthesizeKey("KEY_Enter");
    const copy = await copyOpened;
    is(gBrowser.selectedTab, copy, "Return opened a second copy");
    ok(tab.isConnected && copy != tab, "…and kept the Essential");
    BrowserTestUtils.removeTab(copy);

    // From another tab, the Essential's row switches to it, once.
    gBrowser.selectedTab = other;
    await commandBar(url);
    const fromOther = await rows();
    info(fromOther.map(r => `${r.type}/${r.result.providerName}/${r.result.heuristic}/${r.url}/${r.displayed.action}`).join("\n"));
    is(fromOther.filter(r => r.result.type == UrlbarShared.RESULT_TYPE.TAB_SWITCH).length, 1, "One Switch to Tab row");
    is(fromOther.filter(r => r.result.payload.url == url).length, 1, "…and no other row for that address");
    ok(!fromOther.slice(1).some(r => r.displayed.action == "Switch to Tab"), "Only the first row says Switch to Tab");
    EventUtils.synthesizeKey("KEY_Enter");
    await TestUtils.waitForCondition(() => gBrowser.selectedTab == tab, "Return goes to the Essential");
  } finally {
    if (gURLBar.hasAttribute("zen-newtab") || gURLBar.view.isOpen) {
      await closeCommandBar();
    }
    gZenPinnedTabManager.removeEssentials(tab);
    BrowserTestUtils.removeTab(other);
    BrowserTestUtils.removeTab(tab);
    const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
    await PlacesUtils.history.remove(url);
  }
});
