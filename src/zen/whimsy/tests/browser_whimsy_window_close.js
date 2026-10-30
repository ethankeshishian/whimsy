/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Last user tab: honor Firefox's keep-window setting in unsynced windows too.
// Cmd+W on the resulting empty sentinel closes the window. Feature off:
// defer to Zen, whose separate empty-window pref can allow or prevent closing.

function userTabs(win) {
  return win.gBrowser.tabs.filter(tab => tab.isOpen && !tab.hasAttribute("zen-empty-tab"));
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.window-close", true],
      ["browser.tabs.closeWindowWithLastTab", false],
      ["zen.tabs.close-window-with-empty", false],
      ["zen.urlbar.replace-newtab", true],
    ],
  });
});

async function openEmptyWindow() {
  const win = await BrowserTestUtils.openNewBrowserWindow({
    zenSyncedWindow: Services.prefs.getBoolPref("zen.window-sync.prefer-unsynced-windows", false),
  });
  // Register before any setup that could fail so a failed fixture can't leak.
  registerCleanupFunction(async () => {
    if (!win.closed) {
      await BrowserTestUtils.closeWindow(win);
    }
  });
  await win.gZenWorkspaces.promiseInitialized;
  ok(win.gZenWorkspaces.privateWindowOrDisabled, "Exercise Zen's unsynced-window close policy");
  // selectEmptyTab() is a no-op in testing mode. Exercise production's real
  // sentinel selection rather than waiting for a path the harness disables.
  win.gZenUIManager.testingEnabled = false;
  ok(win.gZenVerticalTabsManager._canReplaceNewTab, "Zen will reuse its empty sentinel");
  for (const tab of userTabs(win)) {
    // Fixture cleanup must work even when the feature is off and Zen would
    // ordinarily close an unsynced window's last tab.
    win.gBrowser.removeTab(tab, { animate: false, closeWindowWithLastTab: false });
  }
  await TestUtils.waitForCondition(
    () => !win.closed && !userTabs(win).length && win.gBrowser.selectedTab.hasAttribute("zen-empty-tab"),
    "Startup pages closed and the empty tab selected"
  );
  return win;
}

async function assertWindowStaysOpen(win, message) {
  // Zen can schedule cmd_closeWindow after 100ms. Use the harness window's
  // timer: a timer owned by win disappears if the regression closes it.
  await new Promise(resolve => setTimeout(resolve, 200));
  ok(!win.closed, message);
}

add_task(async function test_close_window_with_last_tab() {
  const win = await openEmptyWindow();
  try {
    const { gBrowser } = win;
    is(userTabs(win).length, 0, "No user tabs in the empty window");
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
    is(userTabs(win).length, 1, "One user tab now");

    gBrowser.removeTab(tab, { animate: false });
    await TestUtils.waitForCondition(
      () => win.closed || (!userTabs(win).length && gBrowser.selectedTab.hasAttribute("zen-empty-tab")),
      "Last user tab removed"
    );
    await assertWindowStaysOpen(win, "Closing the last user tab keeps the window open");
    if (win.closed) {
      return;
    }
    ok(gBrowser.selectedTab.hasAttribute("zen-empty-tab"), "An empty tab replaced the closed one");

    const closed = BrowserTestUtils.windowClosed(win);
    win.document.getElementById("cmd_close").doCommand();
    await closed;
  } finally {
    if (!win.closed) {
      await BrowserTestUtils.closeWindow(win);
    }
  }
});

add_task(async function test_empty_tab_does_not_close_other_user_tabs() {
  const win = await openEmptyWindow();
  try {
    const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, "https://example.com/?keep");
    win.gBrowser.pinTab(tab);
    win.gZenWorkspaces.selectEmptyTab();
    await SpecialPowers.pushPrefEnv({ set: [["zen.tabs.close-window-with-empty", true]] });
    try {
      win.document.getElementById("cmd_close").doCommand();
      await assertWindowStaysOpen(win, "A pinned user tab blocks empty-window closing, even when Zen would close");
      ok(tab.isConnected && !tab.closing, "The user tab remains open");
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  } finally {
    if (!win.closed) {
      await BrowserTestUtils.closeWindow(win);
    }
  }
});

add_task(async function test_disabled_feature_never_closes() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.window-close", false]] });
  try {
    const win = await openEmptyWindow();
    try {
      is(userTabs(win).length, 0, "No user tabs in the empty window");
      ok(win.gBrowser.selectedTab.hasAttribute("zen-empty-tab"));
      win.document.getElementById("cmd_close").doCommand();
      await assertWindowStaysOpen(win, "Feature off honors Zen's disabled empty-window close pref");
    } finally {
      if (!win.closed) {
        await BrowserTestUtils.closeWindow(win);
      }
    }
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_disabled_feature_allows_zen_close() {
  await SpecialPowers.pushPrefEnv({
    set: [["whimsy.feature.window-close", false], ["zen.tabs.close-window-with-empty", true]],
  });
  try {
    const win = await openEmptyWindow();
    const closed = BrowserTestUtils.windowClosed(win);
    win.document.getElementById("cmd_close").doCommand();
    await closed;
    ok(win.closed, "Feature off preserves Zen's enabled empty-window close pref");
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_close_window_pref_still_closes_last_tab() {
  const win = await openEmptyWindow();
  await SpecialPowers.pushPrefEnv({ set: [["browser.tabs.closeWindowWithLastTab", true]] });
  try {
    const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, "https://example.com/?last");
    const closed = BrowserTestUtils.windowClosed(win);
    win.gBrowser.removeTab(tab, { animate: false });
    await closed;
    ok(win.closed, "The explicit close-window setting still closes on the last user tab");
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});
