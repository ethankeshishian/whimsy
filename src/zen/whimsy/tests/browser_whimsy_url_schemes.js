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
});

add_task(async function test_typing_settings_navigates() {
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    gURLBar.focus();
    gURLBar.value = "whimsy://settings";
    EventUtils.synthesizeKey("KEY_Enter", {}, window);
    await TestUtils.waitForCondition(
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
