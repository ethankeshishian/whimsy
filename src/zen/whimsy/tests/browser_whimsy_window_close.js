/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Closing the only unpinned tab leaves the window open with an empty tab
// (Zen's existing behavior); Cmd+W again, on that lone empty tab, closes
// the window (Arc). With the feature off, Cmd+W never closes the window.

add_task(async function test_close_window_with_last_tab() {
  ok(!Services.prefs.getBoolPref("browser.tabs.closeWindowWithLastTab", true), "Zen keeps the window open by default");

  const win = await BrowserTestUtils.openNewBrowserWindow();
  try {
    const { gBrowser } = win;
    is(gBrowser.tabs.length, 1, "One tab in the fresh window");
    await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
    is(gBrowser.tabs.length, 2, "Two tabs now");

    gBrowser.removeTab(gBrowser.selectedTab.previousElementSibling ?? gBrowser.tabs[0]);
    await TestUtils.waitForCondition(() => gBrowser.tabs.length == 1);
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
  const win = await BrowserTestUtils.openNewBrowserWindow();
  try {
    is(win.gBrowser.tabs.length, 1, "One empty tab");
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
