/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

add_task(async function test_click_selects_full_url() {
  await BrowserTestUtils.withNewTab("https://example.com/a?b", async browser => {
    gURLBar.blur();
    await EventUtils.synthesizeMouseAtCenter(gURLBar.inputField, {});
    await TestUtils.waitForCondition(() => gURLBar.focused);
    is(gURLBar.value, "https://example.com/a?b", "Click untrims to the full URL");
    is(
      gURLBar.inputField.selectionStart,
      0,
      "The full value is selected from the start"
    );
    is(
      gURLBar.inputField.selectionEnd,
      gURLBar.inputField.value.length,
      "...to the end"
    );
  });
});

add_task(async function test_always_full_url_pref_mirrors() {
  const { WhimsyUrlbar } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUrlbar.sys.mjs");
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref("whimsy.urlbar.always-full-url");
    WhimsyUrlbar.applyAlwaysFull();
  });
  Services.prefs.setBoolPref("whimsy.urlbar.always-full-url", true);
  WhimsyUrlbar.applyAlwaysFull();
  ok(!Services.prefs.getBoolPref("browser.urlbar.trimURLs"), "trimURLs turned off");
  ok(!Services.prefs.getBoolPref("zen.urlbar.show-domain-only-in-sidebar"), "domain-only turned off");

  Services.prefs.setBoolPref("whimsy.urlbar.always-full-url", false);
  WhimsyUrlbar.applyAlwaysFull();
  ok(Services.prefs.getBoolPref("browser.urlbar.trimURLs"), "trimURLs restored");
});
