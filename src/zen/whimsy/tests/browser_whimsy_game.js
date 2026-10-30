/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

registerCleanupFunction(() => {
  Services.prefs.clearUserPref("whimsy.feature.game");
  Services.prefs.clearUserPref("whimsy.game.style");
  Services.prefs.clearUserPref("whimsy.game.high-score");
});

add_task(async function test_loads_and_renders() {
  await BrowserTestUtils.withNewTab("about:whimsy?game", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => browser.contentWindow.__whimsyGame, "The game script has run");
    is(doc.getElementById("whimsy-game-score").textContent, "0", "The score starts at 0");
    ok(doc.getElementById("whimsy-game-canvas").getContext("2d"), "The canvas has a 2D context");
  });
});

add_task(async function test_whimsy_url_opens_it() {
  await BrowserTestUtils.withNewTab("https://example.com/", async browser => {
    const win = browser.ownerGlobal;
    win.gURLBar.focus();
    win.gURLBar.value = "whimsy://game";
    EventUtils.synthesizeKey("KEY_Enter", {}, win);
    await BrowserTestUtils.waitForCondition(
      () => win.gBrowser.selectedBrowser.currentURI.spec == "about:whimsy?game",
      "whimsy://game opens about:whimsy?game in the current tab"
    );
  });
});

add_task(async function test_style_switch_updates_pref_and_attribute() {
  await BrowserTestUtils.withNewTab("about:whimsy?game", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => browser.contentWindow.__whimsyGame);

    doc.getElementById("whimsy-game-style-retro").click();
    is(Services.prefs.getStringPref("whimsy.game.style"), "retro", "Clicking Retro sets the pref");
    is(doc.getElementById("whimsy-game-root").dataset.style, "retro", "and the root's data-style");

    doc.getElementById("whimsy-game-style-gradient").click();
    is(Services.prefs.getStringPref("whimsy.game.style"), "gradient", "Clicking Gradient sets the pref back");
    is(doc.getElementById("whimsy-game-root").dataset.style, "gradient", "and the root's data-style");
  });
});

add_task(async function test_stomp_increases_score() {
  await BrowserTestUtils.withNewTab("about:whimsy?game", async browser => {
    const win = browser.contentWindow;
    await TestUtils.waitForCondition(() => win.__whimsyGame);
    is(win.__whimsyGame.state.score, 0, "Score starts at 0");
    win.__whimsyGame.step();
    is(win.__whimsyGame.state.score, 1, "A simulated stomp increases the score");
  });
});

add_task(async function test_feature_off_shows_nothing_to_play() {
  Services.prefs.setBoolPref("whimsy.feature.game", false);
  await BrowserTestUtils.withNewTab("about:whimsy?game", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.getElementById("whimsy-game-off"));
    ok(!browser.contentWindow.__whimsyGame, "With the feature off, the game never starts");
  });
  Services.prefs.clearUserPref("whimsy.feature.game");
});
