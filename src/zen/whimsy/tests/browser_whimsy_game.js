/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Balloon Dash (whimsy://game). The page exposes window.__whimsyGame so the
// simulation can be driven deterministically: freeze() stops the real-time
// loop from advancing the world, tick(seconds) steps it by hand, and
// spawn(kind) places a hazard or item right on the balloon.

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

add_task(async function test_first_key_starts_instantly() {
  for (const key of [" ", "KEY_ArrowRight"]) {
    await withGame(async ({ win, doc, game }) => {
      win.focus();
      EventUtils.synthesizeKey(key, {}, win);
      is(game.state.state, "running", `${key} starts the run at once`);
      ok(doc.getElementById("whimsy-game-overlay-ready").hidden, "No start card left");
    });
  }
});

add_task(async function test_arrow_keys_steer() {
  await withGame(async ({ win, game }) => {
    game.start();
    const x = game.state.player.x;
    win.focus();
    EventUtils.synthesizeKey("KEY_ArrowRight", { type: "keydown" }, win);
    game.tick(0.5);
    EventUtils.synthesizeKey("KEY_ArrowRight", { type: "keyup" }, win);
    Assert.greater(game.state.player.x, x + 20, "Holding → moves the balloon right");
    const y = game.state.player.y;
    EventUtils.synthesizeKey("w", { type: "keydown" }, win);
    game.tick(0.3);
    EventUtils.synthesizeKey("w", { type: "keyup" }, win);
    Assert.less(game.state.player.y, y - 5, "W moves it up");
  });
});

add_task(async function test_pointer_steers() {
  await withGame(async ({ game }) => {
    game.start();
    const p = game.state.player;
    game.pointer(400, 40);
    const before = Math.hypot(400 - p.x, 40 - (p.y - 24));
    game.tick(2.5);
    const after = Math.hypot(400 - p.x, 40 - (p.y - 24));
    Assert.less(after, Math.min(20, before / 4), "The balloon follows the pointer there");
    game.pointer(null);
  });
});

add_task(async function test_soft_edges() {
  await withGame(async ({ game }) => {
    game.start();
    game.setInput(-1, 1);
    game.tick(4);
    game.setInput(0, 0);
    is(game.state.state, "running", "Running into the edges never ends the run");
    Assert.greaterOrEqual(game.state.player.x, 0, "The balloon stays in the arena");
    Assert.lessOrEqual(game.state.player.y, game.constants.GROUND, "and above the meadow");
  });
});

add_task(async function test_hazard_pops_records_best_and_retries() {
  Services.prefs.clearUserPref("whimsy.game.high-score");
  await withGame(async ({ doc, game }) => {
    game.start();
    game.state.bonus = 50;
    game.spawn("seed");
    game.tick(1 / 60);
    is(game.state.state, "over", "A thistle seed pops the balloon");
    is(game.state.deathKind, "seed", "and says why");
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
    is(game.state.state, "running", "A press a moment later restarts at once");
    is(game.state.score, 0, "from zero");
  });
});

add_task(async function test_every_hazard_kind_hits() {
  for (const kind of ["plane", "bird", "zap"]) {
    await withGame(async ({ game }) => {
      game.start();
      game.spawn(kind);
      game.tick(1 / 60);
      is(game.state.deathKind, kind, `A ${kind} on the balloon pops it`);
    });
  }
});

add_task(async function test_dash_cooldown_and_invulnerability() {
  await withGame(async ({ game }) => {
    game.start();
    ok(game.dash(), "Dash is ready at the start");
    game.spawn("seed");
    game.tick(1 / 60);
    is(game.state.state, "running", "A dash is briefly invulnerable");
    game.clear();
    ok(!game.dash(), "and then has a cooldown");
    game.tick(game.constants.DASH_COOLDOWN + 0.05);
    ok(game.dash(), "until it's ready again");
  });
});

add_task(async function test_close_call_bonus() {
  await withGame(async ({ game }) => {
    const { HIT_R, CLOSE_PAD, CLOSE_BONUS } = game.constants;
    game.start();
    const p = game.state.player;
    // A seed skimming past just outside the hit circle, then moving away.
    game.spawn("seed", { x: p.x + HIT_R + 4 + CLOSE_PAD / 2, vx: 0, vy: 0 });
    game.tick(1 / 60);
    game.state.hazards[0].x += 40;
    game.tick(1 / 60);
    is(game.state.state, "running", "A near miss is a miss");
    is(game.state.bonus, CLOSE_BONUS, "and earns a close-call bonus");
  });
});

add_task(async function test_sparkle_combo() {
  await withGame(async ({ game }) => {
    const { SPARKLE_POINTS } = game.constants;
    game.start();
    game.spawn("sparkle");
    game.tick(1 / 60);
    is(game.state.bonus, SPARKLE_POINTS, "A sparkle scores");
    game.spawn("sparkle");
    game.tick(1 / 60);
    is(game.state.combo, 2, "A quick second one builds a combo");
    is(game.state.bonus, SPARKLE_POINTS * 3, "worth double");
    game.tick(game.constants.COMBO_WINDOW + 0.1);
    game.spawn("sparkle");
    game.tick(1 / 60);
    is(game.state.combo, 1, "A slow one starts the combo over");
  });
});

add_task(async function test_power_ups() {
  await withGame(async ({ game }) => {
    game.start();
    game.spawn("shield");
    game.tick(1 / 60);
    Assert.greater(game.state.player.shield, 0, "Shield picked up");
    game.spawn("seed");
    game.tick(1 / 60);
    is(game.state.state, "running", "The shield absorbs one hit");
    is(game.state.player.shield, 0, "and is used up");

    game.spawn("slow");
    game.tick(1 / 60);
    Assert.greater(game.state.slowT, 0, "Slow-mo picked up");
    const plane = game.spawn("plane", { x: 300, y: 30, vx: -100, vy: 0 });
    game.tick(0.5);
    Assert.greater(plane.x, 300 - 50 + 20, "Hazards move slower in slow-mo");

    game.spawn("magnet");
    game.tick(1 / 60);
    const p = game.state.player;
    const far = game.spawn("sparkle", { x: p.x + 100, y: p.y - 24 });
    game.tick(0.2);
    Assert.less(far.x, p.x + 100 - 20, "The magnet pulls sparkles in");
  });
});

add_task(async function test_spawns_are_telegraphed_and_never_on_the_balloon() {
  await withGame(async ({ game }) => {
    const { SAFE_SPAWN, TELEGRAPH } = game.constants;
    game.start();
    game.warn("seed");
    is(game.state.warnings.length, 1, "A hazard is announced at the edge first");
    is(game.state.hazards.length, 0, "before it appears");
    game.tick(TELEGRAPH + 0.05);
    is(game.state.hazards.length, 1, "and arrives after the warning");

    game.setAutoSpawn(true);
    game.start();
    game.state.player.invuln = 1e6; // survive, so we can watch 40 s of spawns
    for (let i = 0; i < 40 * 4; i++) {
      game.setInput(Math.sin(i / 7), Math.cos(i / 5));
      game.tick(0.25);
    }
    game.setInput(0, 0);
    Assert.greater(game.state.stats.launched, 20, "Plenty of hazards came");
    Assert.greaterOrEqual(game.state.stats.minSpawn, SAFE_SPAWN, "none of them appeared next to the balloon");
    game.setAutoSpawn(false);
  });
});

add_task(async function test_score_rises_over_time() {
  await withGame(async ({ doc, game }) => {
    game.start();
    game.tick(3);
    Assert.greaterOrEqual(game.state.score, 5, "Surviving scores");
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

add_task(async function reduced_motion_freezes_ambient_scenery() {
  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 1]] });
  try {
    await withGame(async ({ game }) => {
      const positions = () => game.state.clouds.map(c => [c.x, c.y]);
      const before = positions();
      game.tick(2);
      Assert.deepEqual(positions(), before, "Ready clouds stay still");
      game.start();
      game.state.bonus = 500;
      game.state.friendIn = 0;
      game.tick(2);
      Assert.deepEqual(positions(), before, "Gameplay clouds stay still");
      ok(!game.state.floaters.some(f => ["friend", "party", "star"].includes(f.kind)), "No moving decorative objects spawn");
      ok(game.state.runTime > 0, "Gameplay continues under reduced motion");
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

// wave5: seasonal costumes are art only - every hazard still hits the same
// way in every season, and the costume can be taken off again.
add_task(async function test_costumes_keep_the_rules() {
  await withGame(async ({ doc, game }) => {
    for (const season of ["autumn", "winter", "spring", "summer", null]) {
      game.setSeason(season);
      is(game.season, season, `Wearing ${season}`);
      is(doc.getElementById("whimsy-game-root").dataset.season, season ?? undefined, "Root reflects it");
      for (const kind of ["seed", "plane", "bird", "zap"]) {
        game.start();
        game.clear();
        game.state.player.invuln = 0;
        game.state.player.shield = 0;
        game.spawn(kind);
        game.tick(1 / 60);
        is(game.state.deathKind, kind, `${season}: a ${kind} still pops the balloon`);
      }
    }
    game.setSeason("nonsense");
    is(game.season, null, "Unknown seasons fall back to no costume");
  });
});
