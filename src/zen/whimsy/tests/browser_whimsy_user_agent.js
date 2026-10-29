/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { WhimsyUserAgent, PRESETS } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyUserAgent.sys.mjs"
);

const HOST = "example.com";

add_task(async function test_set_clear_round_trip() {
  registerCleanupFunction(() => WhimsyUserAgent.clear(HOST));
  is(WhimsyUserAgent.uaFor(HOST), null, "No override by default");

  WhimsyUserAgent.set(HOST, "chrome-mac");
  is(WhimsyUserAgent.uaFor(HOST), PRESETS["chrome-mac"], "Chrome preset stored");

  WhimsyUserAgent.set(HOST, "custom", "MyCustomAgent/1.0");
  is(WhimsyUserAgent.uaFor(HOST), "MyCustomAgent/1.0", "Custom string stored");

  WhimsyUserAgent.clear(HOST);
  is(WhimsyUserAgent.uaFor(HOST), null, "Cleared");
});

add_task(async function test_reload_applies_the_user_agent() {
  registerCleanupFunction(() => WhimsyUserAgent.clear(HOST));
  const url = `https://${HOST}/`;
  WhimsyUserAgent.set(HOST, "chrome-mac");

  await BrowserTestUtils.withNewTab(url, async browser => {
    WhimsyUserAgent.applyTo(browser.browsingContext, HOST);
    const loaded = BrowserTestUtils.browserLoaded(browser);
    browser.reload();
    await loaded;
    const ua = await SpecialPowers.spawn(browser, [], () => content.navigator.userAgent);
    ok(ua.includes("Chrome"), `User agent includes Chrome: ${ua}`);
  });

  WhimsyUserAgent.clear(HOST);
  await BrowserTestUtils.withNewTab("https://example.org/", async browser => {
    WhimsyUserAgent.applyTo(browser.browsingContext, "example.org");
    const ua = await SpecialPowers.spawn(browser, [], () => content.navigator.userAgent);
    ok(!ua.includes("Chrome"), "An unrelated host keeps the default user agent");
  });
});
