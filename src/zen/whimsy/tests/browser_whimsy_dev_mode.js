/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// http://localhost:PORT -> the tab has whimsy-devmode and the top bar is
// visible. example.org -> no. Turning it on for that site sets and saves
// the permission.

add_task(async function test_localhost_is_dev_mode_example_org_is_not() {
  await BrowserTestUtils.withNewTab("http://mochi.test:8888/", async (browser, tab) => {
    // mochi.test:8888 has an explicit port, so it counts as a dev host.
    await TestUtils.waitForCondition(() => tab.hasAttribute("whimsy-devmode"));
    ok(tab.hasAttribute("whimsy-devmode"), "A host with an explicit port is Developer Mode");
    const bar = window.document.getElementById("whimsy-devmode-bar");
    ok(bar && !bar.hidden, "The top bar is visible for the selected dev-mode tab");
  });

  await BrowserTestUtils.withNewTab("https://example.org/", async (browser, tab) => {
    ok(!tab.hasAttribute("whimsy-devmode"), "A plain https host is not Developer Mode");
  });
});

add_task(async function test_manual_toggle_persists() {
  const { WhimsyDevMode } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyDevMode.sys.mjs");
  const uri = Services.io.newURI("https://example.com/");
  registerCleanupFunction(() => {
    if (WhimsyDevMode.isDevMode(uri)) {
      WhimsyDevMode.toggleSite(uri);
    }
  });

  ok(!WhimsyDevMode.isDevMode(uri), "example.com starts out of Developer Mode");
  WhimsyDevMode.toggleSite(uri);
  ok(WhimsyDevMode.isDevMode(uri), "Toggling on sets and saves the permission");
  WhimsyDevMode.toggleSite(uri);
  ok(!WhimsyDevMode.isDevMode(uri), "Toggling again clears it");
});
