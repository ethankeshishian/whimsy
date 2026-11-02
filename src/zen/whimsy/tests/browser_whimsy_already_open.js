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

// C1 (F34's ask, without reordering): an Essential open on an address with
// a #fragment (Gmail's .../#inbox). Typing that address in the Cmd+T bar
// lists it once: the typed address, whose Return goes to the Essential;
// no second "Switch to Tab" row for the same page. Every other result keeps
// Firefox's order (the same as with the feature off).
add_task(async function test_open_page_is_one_row_and_order_is_firefoxs() {
  const page = "https://example.com/browser/whimsyessential/#inbox";
  await PlacesTestUtils.addVisits([
    { uri: page, title: "Whimsy essential inbox" },
    { uri: "https://example.com/browser/whimsyessential/other", title: "Whimsy essential other" },
  ]);
  const essential = await BrowserTestUtils.openNewForegroundTab(gBrowser, page);
  gZenPinnedTabManager.addToEssentials(essential);
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/?c1");
  const urls = async () => (await rows()).map(r => `${r.result.type}:${r.result.payload.url ?? r.result.payload.query}`);
  try {
    await commandBar(page);
    const all = await rows();
    const samePage = all.filter(r => (r.result.payload.url ?? "").replace(/#.*/, "") == page.replace(/#.*/, ""));
    is(samePage.length, 1, "One row for the open page");
    ok(samePage[0].result.heuristic, "...the typed address, first");
    ok(!all.some(r => r.result.type == UrlbarShared.RESULT_TYPE.TAB_SWITCH && r.result.payload.url == page),
      "No Switch to Tab row repeating it");
    EventUtils.synthesizeKey("KEY_Enter");
    await TestUtils.waitForCondition(() => gBrowser.selectedTab == essential, "Return goes to the Essential");

    // A search: Firefox's order, with the feature on or off.
    gBrowser.selectedTab = other;
    await commandBar("whimsyessential");
    const on = await urls();
    await closeCommandBar();
    await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
    await commandBar("whimsyessential");
    const off = await urls();
    await closeCommandBar();
    await SpecialPowers.popPrefEnv();
    Assert.deepEqual(on, off, "Open tabs aren't moved up: the order is Firefox's");
  } finally {
    if (gURLBar.hasAttribute("zen-newtab") || gURLBar.view.isOpen) {
      await closeCommandBar();
    }
    gZenPinnedTabManager.removeEssentials(essential);
    BrowserTestUtils.removeTab(other);
    BrowserTestUtils.removeTab(essential);
    const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
    await PlacesUtils.history.remove([page, "https://example.com/browser/whimsyessential/other"]);
  }
});

// W10-36: a pinned tab had no "Switch to Tab" row in the Cmd+T command bar
// when you were on it, but did from another space. Zen's Cmd+T bar opens
// over the selected tab, so Firefox took that tab as the current page and
// left it out, so in the new-tab bar every open tab is offered.
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

  // On the pinned tab, in its own space: the bug.
  gBrowser.selectedTab = pinned;
  let opens = 0;
  const onOpen = () => opens++;
  gBrowser.tabContainer.addEventListener("TabOpen", onOpen);
  let index = await newTabBarSwitchRow(search);
  Assert.greater(index, -1, "Same space, on the pinned tab: the Cmd+T bar shows Switch to Tab");
  EventUtils.synthesizeKey("KEY_ArrowDown", { repeat: index });
  is(UrlbarTestUtils.getSelectedRowIndex(window), index, "The Switch to Tab row is selected");
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(() => !gURLBar.hasAttribute("zen-newtab"), "Picking it closes the bar");
  is(gBrowser.selectedTab, pinned, "and you stay on the pinned tab");
  gBrowser.tabContainer.removeEventListener("TabOpen", onOpen);
  is(opens, 0, "No tab was opened");

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

  // Editing the pinned tab's own address (Cmd+L) keeps Firefox's rule: the
  // page you're editing isn't offered as a tab to switch to.
  gBrowser.selectedTab = pinned;
  await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, waitForFocus: SimpleTest.waitForFocus, value: search });
  ok(!gURLBar.hasAttribute("zen-newtab"), "Cmd+L edits the current page");
  is(await switchRowFor(PINNED_URL), -1, "Editing the current page doesn't offer switching to it");
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
