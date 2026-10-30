/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Balloon Hop (whimsy://game). The page exposes window.__whimsyGame so the
// simulation can be driven deterministically: freeze() stops the real-time
// loop from advancing the world, tick(seconds) steps it by hand, and
// spawn(kind) places an obstacle right at the balloon.

registerCleanupFunction(() => {
  for (const pref of ["whimsy.feature.game", "whimsy.game.style", "whimsy.game.high-score", "whimsy.game.chiptune"]) {
    Services.prefs.clearUserPref(pref);
  }
});

async function withGame(fn) {
  await BrowserTestUtils.withNewTab("about:whimsy?game", async browser => {
    const win = browser.contentWindow;
    await TestUtils.waitForCondition(() => win.__whimsyGame, "The game script has run");
    const game = win.__whimsyGame;
    game.freeze();
    game.setAutoSpawn(false);
    await fn({ browser, win, doc: browser.contentDocument, game });
  });
}

// The lowest point (smallest y) the balloon reaches within `seconds`.
function peak(game, seconds) {
  let top = Infinity;
  for (let i = 0; i < seconds * 120; i++) {
    game.tick(1 / 120);
    top = Math.min(top, game.state.player.y);
  }
  return top;
}

add_task(async function test_loads_ready() {
  await withGame(async ({ doc, game }) => {
    is(doc.getElementById("whimsy-game-score").textContent, "0", "The score starts at 0");
    is(game.state.state, "ready", "The game waits for the first press");
    is(doc.getElementById("whimsy-game-root").dataset.state, "ready", "The root mirrors the state");
    ok(!doc.getElementById("whimsy-game-overlay-ready").hidden, "The start card is shown");
    ok(doc.getElementById("whimsy-game-canvas").getContext("2d"), "The canvas has a 2D context");
  });
});

add_task(async function test_whimsy_url_opens_it() {
  await BrowserTestUtils.withNewTab("https://example.com/", async browser => {
    const win = browser.documentGlobal;
    win.gURLBar.focus();
    win.gURLBar.value = "whimsy://game";
    EventUtils.synthesizeKey("KEY_Enter", {}, win);
    await TestUtils.waitForCondition(
      () => win.gBrowser.selectedBrowser.currentURI.spec == "about:whimsy?game",
      "whimsy://game opens about:whimsy?game in the current tab"
    );
  });
});

add_task(async function test_space_starts_instantly_with_a_hop() {
  await withGame(async ({ win, doc, game }) => {
    win.focus();
    EventUtils.synthesizeKey(" ", {}, win);
    is(game.state.state, "running", "Space starts the run at once");
    ok(doc.getElementById("whimsy-game-overlay-ready").hidden, "The start card goes away");
    game.tick(1 / 120);
    Assert.less(game.state.player.vy, 0, "The first press is also a hop");
  });
});

add_task(async function test_holding_hops_higher_than_a_tap() {
  await withGame(async ({ game }) => {
    const ground = game.constants.GROUND;
    game.press();
    game.release();
    const tap = peak(game, 1);
    is(game.state.player.y, ground, "The tap hop lands again");
    game.press();
    const hold = peak(game, 1);
    game.release();
    Assert.less(hold, tap - 10, `Holding hops higher (${ground - hold}) than a tap (${ground - tap})`);
  });
});

add_task(async function test_holding_on_the_way_down_floats() {
  await withGame(async ({ game }) => {
    game.press();
    game.tick(0.45); // held through the peak of a full hop
    ok(game.state.player.floating, "Holding while falling fires the burner");
    Assert.lessOrEqual(game.state.player.vy, 90, "and caps the fall speed");
    game.release();
  });
});

add_task(async function test_coyote_time() {
  await withGame(async ({ game }) => {
    const { PLAYER_X } = game.constants;
    game.start();
    game.tick(0.05);
    game.spawn("pond", { x: PLAYER_X - 30, w: 140 });
    game.tick(0.04);
    ok(!game.state.player.onGround, "The ground has ended under the balloon");
    game.press();
    game.tick(1 / 120);
    Assert.less(game.state.player.vy, 0, "A press just after the edge still hops (coyote time)");
    game.release();

    game.start();
    game.tick(0.05);
    game.spawn("pond", { x: PLAYER_X - 30, w: 140 });
    game.tick(0.15);
    game.press();
    game.tick(1 / 120);
    Assert.greaterOrEqual(game.state.player.vy, 0, "A press well after the edge doesn't");
    game.release();
  });
});

add_task(async function test_thistle_pops_records_best_and_retries() {
  Services.prefs.clearUserPref("whimsy.game.high-score");
  await withGame(async ({ doc, game }) => {
    game.start();
    game.state.distance = 50 * 12;
    game.spawn("thistle");
    game.tick(1 / 60);
    is(game.state.state, "over", "Touching a thistle pops the balloon");
    is(game.state.deathKind, "thistle", "and says why");
    ok(!doc.getElementById("whimsy-game-overlay-gameover").hidden, "The game-over card shows");
    await TestUtils.waitForCondition(() => doc.getElementById("whimsy-game-death").textContent, "The death line is localized");
    const best = Services.prefs.getIntPref("whimsy.game.high-score");
    Assert.greaterOrEqual(best, 50, "The high score is saved");
    is(doc.getElementById("whimsy-game-best").textContent, String(best), "and shown");
    ok(!doc.getElementById("whimsy-game-new-best").hidden, "A first score is a new best");

    game.press();
    is(game.state.state, "over", "A press in the same instant doesn't restart (no accidental retry)");
    game.tick(0.4);
    game.press();
    game.release();
    is(game.state.state, "running", "A press a moment later restarts at once");
    is(game.state.score, 0, "from zero");
  });
});

add_task(async function test_planes_at_two_heights() {
  await withGame(async ({ game }) => {
    const { GROUND } = game.constants;
    game.start();
    game.spawn("plane", { y: GROUND - 64 });
    game.tick(1 / 60);
    is(game.state.state, "running", "A high plane passes over a balloon that stays down");
    game.clear();
    game.spawn("plane");
    game.tick(1 / 60);
    is(game.state.state, "over", "A low plane has to be hopped over");
    is(game.state.deathKind, "plane", "and says so");
  });
});

add_task(async function test_falling_in_a_pond() {
  await withGame(async ({ game }) => {
    const { PLAYER_X } = game.constants;
    game.start();
    game.spawn("pond", { x: PLAYER_X - 30, w: 400 });
    game.tick(0.5);
    is(game.state.state, "over", "Dropping into a pond ends the run");
    is(game.state.deathKind, "pond", "with a splash");
  });
});

add_task(async function test_sparkle_bonus() {
  await withGame(async ({ game }) => {
    game.start();
    game.spawn("sparkle");
    game.tick(1 / 60);
    is(game.state.bonus, game.constants.SPARKLE_BONUS, "Catching a sparkle adds a bonus");
  });
});

add_task(async function test_speed_and_score_rise() {
  await withGame(async ({ doc, game }) => {
    game.start();
    const speed = game.state.speed;
    game.tick(3);
    Assert.greater(game.state.speed, speed, "The world speeds up");
    Assert.greater(game.state.score, 30, "The score climbs with distance");
    is(doc.getElementById("whimsy-game-score").textContent, String(game.state.score), "The HUD shows it");
  });
});

add_task(async function test_pause() {
  await withGame(async ({ win, game }) => {
    game.start();
    win.focus();
    EventUtils.synthesizeKey("p", {}, win);
    is(game.state.state, "paused", "P pauses");
    EventUtils.synthesizeKey(" ", {}, win);
    is(game.state.state, "running", "Space resumes");
  });
});

add_task(async function test_style_switch_updates_pref_and_attribute() {
  await withGame(async ({ doc, game }) => {
    doc.getElementById("whimsy-game-style-retro").click();
    is(Services.prefs.getStringPref("whimsy.game.style"), "retro", "Clicking Retro sets the pref");
    is(doc.getElementById("whimsy-game-root").dataset.style, "retro", "and the root's data-style");
    const canvas = doc.getElementById("whimsy-game-canvas");
    is(canvas.width, game.constants.W / 2, "Retro draws on a low-resolution canvas");
    is(browserStyle(doc, canvas).imageRendering, "pixelated", "scaled up without smoothing");

    doc.getElementById("whimsy-game-style-gradient").click();
    is(Services.prefs.getStringPref("whimsy.game.style"), "gradient", "Clicking Smooth sets the pref back");
    is(doc.getElementById("whimsy-game-root").dataset.style, "gradient", "and the root's data-style");
    Assert.greaterOrEqual(canvas.width, game.constants.W, "Smooth draws at full resolution");
  });
});

function browserStyle(doc, el) {
  return doc.defaultView.getComputedStyle(el);
}

add_task(async function test_sound_is_off_until_turned_on() {
  Services.prefs.clearUserPref("whimsy.game.chiptune");
  await withGame(async ({ doc }) => {
    const button = doc.getElementById("whimsy-game-sound");
    is(button.getAttribute("aria-pressed"), "false", "Sound starts muted");
    button.click();
    ok(Services.prefs.getBoolPref("whimsy.game.chiptune"), "The toggle turns sound on");
    is(button.getAttribute("aria-pressed"), "true", "and shows it");
    button.click();
    ok(!Services.prefs.getBoolPref("whimsy.game.chiptune"), "and off again");
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
