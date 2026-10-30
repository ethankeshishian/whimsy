/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Closing the only unpinned tab leaves the window open with an empty tab
// (Zen's existing behavior); Cmd+W again, on that lone empty tab, closes
// the window (Arc). With the feature off, Cmd+W never closes the window.

function userTabs(win) {
  return win.gBrowser.tabs.filter(tab => !tab.hasAttribute("zen-empty-tab"));
}

async function openEmptyWindow() {
  // Use an unsynced window so another window's tabs aren't part of this
  // fixture. Workspace startup finishes after Firefox's delayed startup.
  const win = await BrowserTestUtils.openNewBrowserWindow({
    zenSyncedWindow: Services.prefs.getBoolPref("zen.window-sync.prefer-unsynced-windows", false),
  });
  await win.gZenWorkspaces.promiseInitialized;
  // A fresh window may have a startup page as well as Zen's empty sentinel.
  // Explicitly close startup pages; never try to remove the sentinel itself.
  for (const tab of userTabs(win)) {
    await BrowserTestUtils.removeTab(tab, { animate: false });
  }
  await TestUtils.waitForCondition(
    () => !userTabs(win).length && win.gBrowser.selectedTab.hasAttribute("zen-empty-tab"),
    "Startup pages closed and the empty tab selected"
  );
  return win;
}

add_task(async function test_close_window_with_last_tab() {
  ok(!Services.prefs.getBoolPref("browser.tabs.closeWindowWithLastTab", true), "Zen keeps the window open by default");

  const win = await openEmptyWindow();
  try {
    const { gBrowser } = win;
    is(userTabs(win).length, 0, "No user tabs in the empty window");
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
    is(userTabs(win).length, 1, "One user tab now");

    await BrowserTestUtils.removeTab(tab, { animate: false });
    await TestUtils.waitForCondition(() => !userTabs(win).length && gBrowser.selectedTab.hasAttribute("zen-empty-tab"));
    ok(!win.closed, "Closing the last user tab keeps the window open");
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

add_task(async function test_disabled_feature_never_closes() {
  Services.prefs.setBoolPref("whimsy.feature.window-close", false);
  const win = await openEmptyWindow();
  try {
    is(userTabs(win).length, 0, "No user tabs in the empty window");
    ok(win.gBrowser.selectedTab.hasAttribute("zen-empty-tab"));
    win.document.getElementById("cmd_close").doCommand();
    // Give any async close a tick to (not) happen.
    await new Promise(r => win.setTimeout(r, 50));
    ok(!win.closed, "The window stays open with the feature off");
  } finally {
    Services.prefs.clearUserPref("whimsy.feature.window-close");
    if (!win.closed) {
      await BrowserTestUtils.closeWindow(win);
    }
  }
});
