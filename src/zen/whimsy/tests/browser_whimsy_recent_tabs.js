/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave3/cmdbar: recent tabs in the empty command bar (WhimsyRecentTabs).

ChromeUtils.defineESModuleGetters(this, {
  UrlbarTestUtils: "resource://testing-common/UrlbarTestUtils.sys.mjs",
  WhimsyRecentTabs: "resource:///modules/whimsy/WhimsyRecentTabs.sys.mjs",
  WhimsyPrivateLock: "resource:///modules/whimsy/WhimsyPrivateLock.sys.mjs",
});

const PREF = "whimsy.feature.command-bar-recent-tabs";
const PROVIDER = "WhimsyRecentTabs";

async function openTabs(count, tag) {
  const tabs = [];
  for (let i = 0; i < count; i++) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, `https://example.com/?${tag}=${i}`));
  }
  return tabs;
}

// Recent-tab rows shown for `value` (the empty string by default).
async function recentRows(value = "") {
  await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, waitForFocus, value });
  return collectRecentRows();
}

async function collectRecentRows() {
  const rows = [];
  for (let index = 0; index < UrlbarTestUtils.getResultCount(window); index++) {
    const { result } = await UrlbarTestUtils.getRowAt(window, index);
    if (result.providerName == PROVIDER && result.payload.kind == "tab") {
      rows.push({ index, result });
    }
  }
  return rows;
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, true]] });
  // Normally done by Whimsy.initWindow; calling it again is a no-op.
  WhimsyRecentTabs.init();
  ok(WhimsyRecentTabs.provider, "Provider registered");
});

add_task(async function test_mru_order_and_boundaries() {
  const tabs = await openTabs(7, "mru");
  try {
    const provider = WhimsyRecentTabs.provider;
    // Stable MRU timestamps, independent of clock resolution: tabs[0] oldest.
    tabs.forEach((tab, i) => Object.defineProperty(tab, "lastAccessed", { configurable: true, value: Date.now() + 1e6 + i }));
    let list = provider.tabs(window);
    is(list.length, 5, "At most five recent tabs");
    ok(!list.includes(gBrowser.selectedTab), "The current tab is never listed");
    is(list[0], tabs[5], "Most recently used tab first");
    is(list[1], tabs[4], "Then in descending order of use");

    tabs[5].setAttribute("whimsy-private", "true");
    ok(!provider.tabs(window).includes(tabs[5]), "A private tab isn't listed from a normal tab");
    tabs[5].removeAttribute("whimsy-private");

    const space = tabs[5].getAttribute("zen-workspace-id");
    if (window.gZenWorkspaces?.activeWorkspace) {
      tabs[5].setAttribute("zen-workspace-id", "whimsy-test-other-space");
      ok(!provider.tabs(window).includes(tabs[5]), "Tabs of other spaces aren't listed");
      tabs[5].setAttribute("zen-workspace-id", space);
    }

    tabs[4].setAttribute("zen-empty-tab", "true");
    ok(!provider.tabs(window).includes(tabs[4]), "Zen's internal empty tab isn't listed");
    tabs[4].removeAttribute("zen-empty-tab");
  } finally {
    tabs.forEach(tab => BrowserTestUtils.removeTab(tab));
  }
});

add_task(async function test_empty_bar_lists_and_switches() {
  const [target, anchor] = await openTabs(2, "switch");
  try {
    Object.defineProperty(target, "lastAccessed", { configurable: true, value: Date.now() + 1e6 });
    const tabCount = gBrowser.tabs.length;
    const innerWindowID = target.linkedBrowser.innerWindowID;
    EventUtils.synthesizeKey("l", { accelKey: true });
    await TestUtils.waitForCondition(() => gURLBar.focused, "Cmd+L focused the bar");
    gURLBar.value = "";
    const rows = await recentRows();
    ok(rows.length >= 1, "Recent tabs fill the empty bar");
    is(rows[0].index, 0, "They come first");
    ok(!rows[0].result.heuristic, "Nothing preselected: Enter keeps its usual meaning");
    is(rows[0].result.payload.tabUrl, target.linkedBrowser.currentURI.spec, "Previous tab is the first row");
    ok(!("url" in rows[0].result.payload), "A tab switch carries no URL to load");
    is(UrlbarTestUtils.getSelectedRowIndex(window), -1, "No row selected until arrowing");

    const details = await UrlbarTestUtils.getDetailsOfResultAt(window, 0);
    is(details.displayed.action, "Switch to Tab", "Row is labelled as a tab switch");

    EventUtils.synthesizeKey("KEY_ArrowDown");
    EventUtils.synthesizeKey("KEY_Enter");
    await TestUtils.waitForCondition(() => gBrowser.selectedTab == target, "Down, Enter returns to that exact tab");
    await TestUtils.waitForCondition(() => !gURLBar.view.isOpen, "Picking the row closed the bar");
    await TestUtils.waitForTick();
    is(gBrowser.tabs.length, tabCount, "Enter did not open a duplicate tab");
    is(target.linkedBrowser.innerWindowID, innerWindowID, "Enter did not reload the target");
    ok(target != anchor, "Switched away from the tab the bar was opened on");
  } finally {
    await UrlbarTestUtils.promisePopupClose(window);
    BrowserTestUtils.removeTab(target);
    BrowserTestUtils.removeTab(anchor);
  }
});

add_task(async function test_new_tab_bar_click_switches_without_loading() {
  const [target, anchor] = await openTabs(2, "new-tab-switch");
  try {
    Object.defineProperty(target, "lastAccessed", { configurable: true, value: Date.now() + 1e6 });
    const tabCount = gBrowser.tabs.length;
    const innerWindowID = target.linkedBrowser.innerWindowID;
    // Automation normally makes Cmd+T create a real tab. Exercise the
    // command bar that people actually use, with its new-tab destination.
    const testing = gZenUIManager.testingEnabled;
    gZenUIManager.testingEnabled = false;
    try {
      EventUtils.synthesizeKey("t", { accelKey: true });
    } finally {
      gZenUIManager.testingEnabled = testing;
    }
    await TestUtils.waitForCondition(
      () => gURLBar.focused && gURLBar.hasAttribute("zen-newtab"),
      "Cmd+T opened the new-tab command bar"
    );
    // Refresh the empty query without reopening the bar in Cmd+L mode.
    let searching = UrlbarTestUtils.promiseSearchComplete(window);
    EventUtils.sendString("x");
    await searching;
    searching = UrlbarTestUtils.promiseSearchComplete(window);
    EventUtils.synthesizeKey("KEY_Backspace");
    await searching;
    const rows = await collectRecentRows();
    ok(rows.length >= 1, "Cmd+T lists recent tabs");
    is(rows[0].result.payload.tabUrl, target.linkedBrowser.currentURI.spec, "First recent row targets the existing tab");
    is(gBrowser.tabs.length, tabCount, "Opening the command bar created no tab");
    const row = await UrlbarTestUtils.getRowAt(window, rows[0].index);
    EventUtils.synthesizeMouseAtCenter(row, {});
    await TestUtils.waitForCondition(() => gBrowser.selectedTab == target, "Click selected the existing tab");
    await TestUtils.waitForCondition(() => !gURLBar.view.isOpen, "Click closed the bar");
    await TestUtils.waitForTick();
    is(gBrowser.tabs.length, tabCount, "Click did not open a duplicate tab");
    is(target.linkedBrowser.innerWindowID, innerWindowID, "Click did not reload the target");
  } finally {
    await UrlbarTestUtils.promisePopupClose(window);
    [target, anchor].forEach(tab => BrowserTestUtils.removeTab(tab));
  }
});

add_task(async function test_locked_tab_is_not_a_recent_result() {
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.feature.private-lock", true],
    ["whimsy.privateLock.tabs", 1],
    ["whimsy.privateLock.onLeave", false],
  ] });
  const [locked, unlocked, anchor] = await openTabs(3, "locked-recent");
  try {
    // Both tabs show the same page; only the private tab is covered.
    const loaded = BrowserTestUtils.browserLoaded(unlocked.linkedBrowser);
    BrowserTestUtils.startLoadingURIString(unlocked.linkedBrowser, locked.linkedBrowser.currentURI.spec);
    await loaded;
    locked.setAttribute("whimsy-private", "true");
    Object.defineProperty(unlocked, "lastAccessed", { configurable: true, value: Date.now() + 1e6 });
    ok(WhimsyRecentTabs.provider.tabs(window, true).includes(locked), "The private tab is eligible before locking");
    ok(WhimsyPrivateLock.lock("tabs"), "Locked the private tab");
    ok(WhimsyPrivateLock.isTabHidden(window, locked), "The lock covers that tab");
    ok(!WhimsyRecentTabs.provider.tabs(window, true).includes(locked), "The provider filters the locked tab itself");
    const privateResults = [];
    await WhimsyRecentTabs.provider.startQuery(
      { searchString: "", isPrivate: true, maxResults: 10 },
      (_, result) => privateResults.push(result)
    );
    ok(!privateResults.some(result => result.payload.kind == "tab"), "An empty private query has no locked recent rows");
    const rows = await recentRows();
    is(rows.filter(({ result }) => result.payload.tabUrl == unlocked.linkedBrowser.currentURI.spec).length,
      1, "The empty bar still lists the unlocked tab on the same page exactly once");
  } finally {
    await UrlbarTestUtils.promisePopupClose(window);
    WhimsyPrivateLock.unlockAll();
    locked.removeAttribute("whimsy-private");
    [locked, unlocked, anchor].forEach(tab => BrowserTestUtils.removeTab(tab));
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_recent_action_is_separated_from_title() {
  const [target, anchor] = await openTabs(2, "layout");
  try {
    target.label = "Recent target";
    Object.defineProperty(target, "lastAccessed", { configurable: true, value: Date.now() + 1e6 });
    const rows = await recentRows();
    const row = await UrlbarTestUtils.getRowAt(window, rows[0].index);
    await document.l10n.translateFragment(row);
    const title = row.querySelector(".urlbarView-title").getBoundingClientRect();
    const action = row.querySelector(".urlbarView-action").getBoundingClientRect();
    ok(action.left > title.right + 100, "Switch to Tab sits well to the right of the title");
  } finally {
    await UrlbarTestUtils.promisePopupClose(window);
    [target, anchor].forEach(tab => BrowserTestUtils.removeTab(tab));
  }
});

add_task(async function test_duplicate_urls_keep_identity() {
  const first = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?same");
  const second = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?same");
  const anchor = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  try {
    Object.defineProperty(first, "lastAccessed", { configurable: true, value: Date.now() + 2e6 });
    Object.defineProperty(second, "lastAccessed", { configurable: true, value: Date.now() + 1e6 });
    gURLBar.value = "";
    await recentRows();
    EventUtils.synthesizeKey("KEY_ArrowDown");
    EventUtils.synthesizeKey("KEY_Enter");
    await TestUtils.waitForCondition(() => gBrowser.selectedTab == first, "Picks the tab itself, not the first tab with that URL");
  } finally {
    await UrlbarTestUtils.promisePopupClose(window);
    [first, second, anchor].forEach(tab => BrowserTestUtils.removeTab(tab));
  }
});

add_task(async function test_typing_and_switch_off() {
  const tabs = await openTabs(2, "off");
  try {
    is((await recentRows("example")).length, 0, "Typing hands the bar back to normal results");
    await UrlbarTestUtils.promisePopupClose(window);

    await SpecialPowers.pushPrefEnv({ set: [[PREF, false]] });
    gURLBar.value = "";
    is((await recentRows()).length, 0, "Switch off: the empty bar is Firefox's again");
    await UrlbarTestUtils.promisePopupClose(window);
    await SpecialPowers.popPrefEnv();
  } finally {
    tabs.forEach(tab => BrowserTestUtils.removeTab(tab));
  }
});

add_task(async function test_closed_tab_is_ignored() {
  const [gone, anchor] = await openTabs(2, "closed");
  try {
    Object.defineProperty(gone, "lastAccessed", { configurable: true, value: Date.now() + 1e6 });
    const results = [];
    await WhimsyRecentTabs.provider.startQuery({ searchString: "", maxResults: 10 }, (_, result) => results.push(result));
    const row = results.find(result => result.payload.tabUrl == gone.linkedBrowser.currentURI.spec);
    ok(row, "Row for the tab");
    BrowserTestUtils.removeTab(gone);
    WhimsyRecentTabs.provider.onEngagement(null, null, { result: row });
    is(gBrowser.selectedTab, anchor, "Picking a row whose tab closed does nothing");
  } finally {
    BrowserTestUtils.removeTab(anchor);
  }
});
