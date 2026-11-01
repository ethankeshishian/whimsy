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

// W10-16: the command bar's Pretend to Be opens This Site in the site
// panel with its dropdown focused (the separate sheet is gone).
add_task(async function test_pretend_command_opens_this_site() {
  const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
  ok(!("openPicker" in WhimsyUserAgent), "No separate Pretend to Be sheet");
  await BrowserTestUtils.withNewTab(`https://${HOST}/`, async () => {
    gNavToolbox.setAttribute("zen-has-implicit-hover", "true");
    const panel = document.getElementById("zen-unified-site-data-panel");
    const shown = BrowserTestUtils.waitForPopupEvent(panel, "shown");
    WhimsyCommands.get("whimsy-useragent-picker").run(window);
    await shown;
    await TestUtils.waitForCondition(() => document.activeElement?.id == "whimsy-site-settings-useragent-button",
      "Pretend to Be's dropdown has the keyboard");
    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    panel.hidePopup(true);
    await hidden;
    gNavToolbox.removeAttribute("zen-has-implicit-hover");
  });
});

// W8-49: Per-site user agent is partitioned per profile and private browsing.
add_task(async function test_w8_49_user_agent_per_profile() {
  const host = "profile-ua.example";
  registerCleanupFunction(() => {
    WhimsyUserAgent.clear(host, "work");
    WhimsyUserAgent.clear(host, "default");
  });

  WhimsyUserAgent.set(host, "safari-iphone", null, "work");
  is(WhimsyUserAgent.uaFor(host, "work"), PRESETS["safari-iphone"], "Work profile has iPhone UA");
  is(WhimsyUserAgent.uaFor(host, "default"), null, "Default profile does not have override");

  // Private browsing choice is in-memory only and cleared on exit
  WhimsyUserAgent.set(host, "chrome-mac", null, { isPrivate: true });
  is(WhimsyUserAgent.uaFor(host, { isPrivate: true }), PRESETS["chrome-mac"], "Private has Chrome");
  is(WhimsyUserAgent.uaFor(host, "default"), null, "Normal default still has no override");

  Services.obs.notifyObservers(null, "last-pb-context-exited");
  is(WhimsyUserAgent.uaFor(host, { isPrivate: true }), null, "Private choice cleared on exit");

  // Removing profile removes its overrides
  WhimsyUserAgent.removeProfile("work");
  is(WhimsyUserAgent.uaFor(host, "work"), null, "Removed profile overrides cleared");
});
