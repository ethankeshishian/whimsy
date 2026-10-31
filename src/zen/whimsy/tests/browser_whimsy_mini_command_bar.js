/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9/mini W8-20: Mini Whimsy's command bar follows Arc's Little Arc.
// One page at a time and no tab strip: whatever the command bar opens
// replaces Mini's page (never a new tab in Mini, never a tab in the main
// window behind it), Cmd+T opens the command bar rather than a tab, a
// "Switch to Tab" pick opens that page in Mini, and Cmd+O still moves the
// page into the current space.

const { WhimsyQuickWindow } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs");
ChromeUtils.defineESModuleGetters(this, {
  UrlbarTestUtils: "resource://testing-common/UrlbarTestUtils.sys.mjs",
});

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.quick-window.size", ""]] });
});

registerCleanupFunction(async () => {
  for (const win of WhimsyQuickWindow.windows()) {
    await WhimsyQuickWindow.whenReady(win);
    await BrowserTestUtils.closeWindow(win);
  }
});

async function openMini(url = "https://example.com/") {
  const win = WhimsyQuickWindow.open(url, { opener: window });
  await WhimsyQuickWindow.whenReady(win);
  await TestUtils.waitForCondition(() => win.gBrowser.selectedBrowser.currentURI.spec == url, "Mini loaded its page");
  await SimpleTest.promiseFocus(win);
  return win;
}

// Types `value` into Mini's command bar and presses Return with `modifiers`.
async function go(win, value, modifiers = {}) {
  WhimsyQuickWindow.openCommandBar(win);
  await TestUtils.waitForCondition(() => win.gURLBar.focused, "Mini's command bar has focus");
  await UrlbarTestUtils.promiseAutocompleteResultPopup({ window: win, waitForFocus: SimpleTest.waitForFocus, value });
  const loaded = BrowserTestUtils.browserLoaded(win.gBrowser.selectedBrowser, false, value);
  EventUtils.synthesizeKey("KEY_Enter", modifiers, win);
  await loaded;
}

function counts(win) {
  return { mini: win.gBrowser.tabs.length, main: gBrowser.tabs.length };
}

add_task(async function test_results_replace_the_page_in_mini() {
  const win = await openMini();
  try {
    const before = counts(win);
    const mainSelected = gBrowser.selectedTab;
    await go(win, "https://example.org/");
    is(win.gBrowser.selectedBrowser.currentURI.spec, "https://example.org/", "The pick replaced Mini's page");
    Assert.deepEqual(counts(win), before, "No tab opened in Mini or in the main window");
    is(gBrowser.selectedTab, mainSelected, "The main window didn't change");
    ok(!win.closed, "Mini stays open");
    // One page at a time, but its history is there: Back returns.
    ok(win.gBrowser.canGoBack, "Back leads to the previous page, as in Arc");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_new_tab_modifiers_stay_in_mini() {
  const win = await openMini();
  try {
    const before = counts(win);
    await go(win, "https://example.org/", { altKey: true });
    is(win.gBrowser.selectedBrowser.currentURI.spec, "https://example.org/", "Alt+Return replaces the page too");
    await go(win, "https://example.net/", { accelKey: true });
    is(win.gBrowser.selectedBrowser.currentURI.spec, "https://example.net/", "So does Cmd+Return");
    Assert.deepEqual(counts(win), before, "Still no new tabs anywhere");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_cmd_t_opens_the_command_bar_not_a_tab() {
  const win = await openMini();
  try {
    const before = counts(win);
    win.gURLBar.blur();
    EventUtils.synthesizeKey("t", { accelKey: true }, win);
    await TestUtils.waitForCondition(() => win.gURLBar.focused, "Cmd+T opens Mini's command bar");
    Assert.deepEqual(counts(win), before, "...without opening a tab");
    await UrlbarTestUtils.promiseAutocompleteResultPopup({ window: win, waitForFocus: SimpleTest.waitForFocus, value: "https://example.org/" });
    const loaded = BrowserTestUtils.browserLoaded(win.gBrowser.selectedBrowser, false, "https://example.org/");
    EventUtils.synthesizeKey("KEY_Enter", {}, win);
    await loaded;
    Assert.deepEqual(counts(win), before, "Its pick replaces the page");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_switch_to_tab_opens_the_page_in_mini() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.net/");
  const win = await openMini();
  try {
    const mainSelected = gBrowser.selectedTab;
    const loaded = BrowserTestUtils.browserLoaded(win.gBrowser.selectedBrowser, false, "https://example.net/");
    // What the command bar calls for a "Switch to Tab" pick.
    win.gURLBar.parentController.switchToTab({ url: "https://example.net/", searchString: "example.net" });
    await loaded;
    is(gBrowser.selectedTab, mainSelected, "No main-window tab was switched to");
    ok(!win.closed, "Mini stays, showing that page");
  } finally {
    await BrowserTestUtils.closeWindow(win);
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_cmd_o_moves_the_navigated_page_to_the_space() {
  const win = await openMini();
  await go(win, "https://example.org/");
  const tabCountBefore = gBrowser.tabs.length;
  EventUtils.synthesizeKey("o", { accelKey: true }, win);
  await TestUtils.waitForCondition(() => win.closed, "Cmd+O moves the page and closes Mini");
  is(gBrowser.tabs.length, tabCountBefore + 1, "The page landed in the current space");
  const adopted = gBrowser.tabs[gBrowser.tabs.length - 1];
  is(adopted.linkedBrowser.currentURI.spec, "https://example.org/", "It's the page the command bar opened");
  BrowserTestUtils.removeTab(adopted);
});

add_task(async function test_main_window_command_bar_unchanged() {
  // The override is Mini's own: a main window still opens new tabs.
  const win = await openMini();
  await BrowserTestUtils.closeWindow(win);
  ok(!gURLBar.controller._whimsyMini, "The main window's command bar keeps Firefox's behaviour");
  // From a page (Firefox reuses an empty tab instead of opening another).
  const page = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const before = gBrowser.tabs.length;
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, "https://example.org/");
  await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, waitForFocus: SimpleTest.waitForFocus, value: "https://example.org/" });
  EventUtils.synthesizeKey("KEY_Enter", { altKey: true });
  const tab = await opened;
  is(gBrowser.tabs.length, before + 1, "Alt+Return opens a tab there");
  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(page);
});
