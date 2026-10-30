/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { WhimsyProtocol } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyProtocol.sys.mjs");

add_task(function test_route_table() {
  is(WhimsyProtocol.route("whimsy://settings").url, "about:preferences", "settings routes to preferences");
  is(WhimsyProtocol.route("whimsy://downloads").url, "about:downloads", "downloads routes to the downloads page");
  is(WhimsyProtocol.route("whimsy://nonsense"), null, "An unknown page has no route");
  is(WhimsyProtocol.route("not-a-whimsy-url"), null, "A non-whimsy:// value has no route");
  // batch7b: offline game + year in tabs (about:whimsy).
  is(WhimsyProtocol.route("whimsy://game").url, "about:whimsy?game", "game routes to about:whimsy?game");
  is(WhimsyProtocol.route("whimsy://year").url, "about:whimsy?year", "year routes to about:whimsy?year");
});

// batch7b: about:whimsy itself (WhimsyAboutPage.sys.mjs) serves a real
// chrome document per query string, and falls back for an unknown one.
add_task(async function test_about_whimsy_routes_by_query() {
  await BrowserTestUtils.withNewTab("about:whimsy?game", async browser => {
    is(
      browser.contentDocument.location.href,
      "about:whimsy?game",
      "The address bar keeps about:whimsy?game, not the chrome:// URL"
    );
    ok(browser.contentDocument.getElementById("whimsy-game-canvas"), "It served the game page");
  });
  await BrowserTestUtils.withNewTab("about:whimsy?year", async browser => {
    ok(browser.contentDocument.getElementById("whimsy-year-root"), "It served the Year in tabs page");
  });
  await BrowserTestUtils.withNewTab("about:whimsy?nonsense", async browser => {
    ok(browser.contentDocument.getElementById("whimsy-game-canvas"), "An unknown query string falls back to the game");
  });
});

add_task(async function test_typing_settings_navigates() {
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    gURLBar.focus();
    gURLBar.value = "whimsy://settings";
    EventUtils.synthesizeKey("KEY_Enter", {}, window);
    await BrowserTestUtils.waitForCondition(
      () => gBrowser.selectedBrowser.currentURI.spec.startsWith("about:preferences"),
      "Typing whimsy://settings opens about:preferences in the current tab"
    );
  });
});

add_task(async function test_disabled_feature_leaves_the_value_alone() {
  Services.prefs.setBoolPref("whimsy.feature.url-schemes", false);
  registerCleanupFunction(() => Services.prefs.clearUserPref("whimsy.feature.url-schemes"));
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    gURLBar.focus();
    gURLBar.value = "whimsy://settings";
    EventUtils.synthesizeKey("KEY_Enter", {}, window);
    await new Promise(r => window.setTimeout(r, 50));
    ok(
      !gBrowser.selectedBrowser.currentURI.spec.startsWith("about:preferences"),
      "With the feature off, whimsy:// is left to Firefox's own (failing) navigation"
    );
  });
  Services.prefs.clearUserPref("whimsy.feature.url-schemes");
});
