/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Balloon Drift: an original, one-button Balloon-Fight-style game for
// Whimsy's offline/net-error page and whimsy://game. Flap to rise and
// drift, steer with the arrow keys, land on an enemy from above to pop it
// (and your own balloon can be popped the same way); touch the water, or a
// lurking fish, and you lose a balloon. All original code and art - no
// Nintendo sprites, sounds, names or level layouts.
//
// This page is loaded with the system principal (about:whimsy, see
// WhimsyAboutPage.sys.mjs), so it can use Services/ChromeUtils directly,
// the same way about:preferences's own script does.

"use strict";

(() => {
  const FEATURE_PREF = "whimsy.feature.game";
  const STYLE_PREF = "whimsy.game.style";
  const CHIPTUNE_PREF = "whimsy.game.chiptune";
  const HIGH_SCORE_PREF = "whimsy.game.high-score";

  const root = document.getElementById("whimsy-game-root");

  if (!Services.prefs.getBoolPref(FEATURE_PREF, true)) {
    root.textContent = "";
    const off = document.createElement("p");
    off.id = "whimsy-game-off";
    off.style.color = "#fff";
    off.style.margin = "auto";
    off.style.fontFamily = "system-ui, sans-serif";
    off.textContent = "The offline game is turned off (whimsy.feature.game).";
    root.append(off);
    return;
  }

  const canvas = document.getElementById("whimsy-game-canvas");
  const ctx = canvas.getContext("2d");
  const scoreEl = document.getElementById("whimsy-game-score");
  const bestEl = document.getElementById("whimsy-game-best");
  const overlay = document.getElementById("whimsy-game-overlay");
  const overlayPaused = document.getElementById("whimsy-game-overlay-paused");
  const overlayGameOver = document.getElementById("whimsy-game-overlay-gameover");
  const playAgainBtn = document.getElementById("whimsy-game-play-again");
  const retroBtn = document.getElementById("whimsy-game-style-retro");
  const gradientBtn = document.getElementById("whimsy-game-style-gradient");

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const GRAVITY = 420; // px/s^2
  const FLAP_IMPULSE = 230; // px/s, instantaneous
  const MAX_VY = 260;
  const STEER_ACCEL = 320;
  const MAX_VX = 180;
  const DRAG = 0.992;
  const PLAYER_R = 16;
  const ENEMY_R = 14;
  const START_LIVES = 3;

  const game = {
    width: 0,
    height: 0,
    style: "gradient",
    chiptune: false,
    player: { x: 0, y: 0, vx: 0, vy: 0, invuln: 0 },
    enemies: [],
    fish: { x: 0, y: 0, phase: 0, active: false, timer: 2 },
    clouds: [],
    keys: { left: false, right: false },
    score: 0,
    best: 0,
    lives: START_LIVES,
    paused: false,
    over: false,
    started: false,
  };

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    game.width = rect.width;
    game.height = rect.height;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function waterLine() {
    return game.height - 36;
  }

  function spawnEnemy() {
    return {
      x: Math.random() * game.width,
      y: 60 + Math.random() * (waterLine() - 140),
      vx: (Math.random() < 0.5 ? -1 : 1) * (20 + Math.random() * 30),
      vy: 0,
      phase: Math.random() * Math.PI * 2,
      popped: false,
    };
  }

  function resetPlayer() {
    game.player.x = game.width / 2;
    game.player.y = game.height / 2;
    game.player.vx = 0;
    game.player.vy = 0;
    game.player.invuln = 1.2;
  }

  function resetRound() {
    game.enemies = [spawnEnemy(), spawnEnemy(), spawnEnemy()];
    game.clouds = reducedMotion
      ? []
      : Array.from({ length: 4 }, () => ({
          x: Math.random() * 400,
          y: 20 + Math.random() * 100,
          speed: 6 + Math.random() * 10,
        }));
    game.fish = { x: game.width / 2, y: waterLine() + 20, phase: 0, active: false, timer: 2 + Math.random() * 3 };
    resetPlayer();
    game.score = 0;
    game.lives = START_LIVES;
    game.paused = false;
    game.over = false;
    game.started = true;
    overlay.hidden = true;
    updateHud();
  }

  function updateHud() {
    scoreEl.textContent = String(game.score);
    bestEl.textContent = String(game.best);
  }

  function beep(freq, durationMs) {
    if (!game.chiptune) {
      return;
    }
    try {
      game._audioCtx ??= new AudioContext();
      const ctxA = game._audioCtx;
      const osc = ctxA.createOscillator();
      const gain = ctxA.createGain();
      osc.type = "square";
      osc.frequency.value = freq;
      gain.gain.value = 0.05;
      osc.connect(gain).connect(ctxA.destination);
      osc.start();
      osc.stop(ctxA.currentTime + durationMs / 1000);
    } catch (e) {
      // Audio isn't available (or blocked); the game is silent, not broken.
    }
  }

  function flap() {
    if (!game.started) {
      resetRound();
      return;
    }
    if (game.over) {
      resetRound();
      return;
    }
    if (game.paused) {
      setPaused(false);
      return;
    }
    game.player.vy = -FLAP_IMPULSE;
    beep(620, 70);
  }

  function setPaused(paused) {
    if (game.over || !game.started) {
      return;
    }
    game.paused = paused;
    overlay.hidden = !paused;
    overlayPaused.hidden = !paused;
    overlayGameOver.hidden = true;
    playAgainBtn.hidden = true;
  }

  function loseLife() {
    if (game.player.invuln > 0) {
      return;
    }
    game.lives--;
    beep(140, 160);
    if (game.lives <= 0) {
      gameOver();
    } else {
      resetPlayer();
    }
  }

  function popEnemy(enemy) {
    enemy.popped = true;
    game.score++;
    beep(880, 90);
    updateHud();
    const index = game.enemies.indexOf(enemy);
    if (index >= 0) {
      game.enemies[index] = spawnEnemy();
    }
  }

  function gameOver() {
    game.over = true;
    game.paused = true;
    if (game.score > game.best) {
      game.best = game.score;
      Services.prefs.setIntPref(HIGH_SCORE_PREF, game.best);
      updateHud();
    }
    overlay.hidden = false;
    overlayPaused.hidden = true;
    overlayGameOver.hidden = false;
    playAgainBtn.hidden = false;
  }

  function tick(dt) {
    if (!game.started || game.paused || game.over) {
      return;
    }
    const p = game.player;
    p.invuln = Math.max(0, p.invuln - dt);

    if (game.keys.left) {
      p.vx -= STEER_ACCEL * dt;
    }
    if (game.keys.right) {
      p.vx += STEER_ACCEL * dt;
    }
    p.vx = clamp(p.vx * DRAG, -MAX_VX, MAX_VX);
    p.vy = clamp(p.vy + GRAVITY * dt, -MAX_VY, MAX_VY);

    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.x < -PLAYER_R) {
      p.x = game.width + PLAYER_R;
    } else if (p.x > game.width + PLAYER_R) {
      p.x = -PLAYER_R;
    }
    p.y = clamp(p.y, PLAYER_R, game.height);

    if (p.y >= waterLine() - PLAYER_R * 0.4) {
      loseLife();
    }

    for (const enemy of game.enemies) {
      enemy.phase += dt;
      enemy.x += enemy.vx * dt;
      enemy.y += Math.sin(enemy.phase) * 10 * dt;
      if (enemy.x < -ENEMY_R) {
        enemy.x = game.width + ENEMY_R;
      } else if (enemy.x > game.width + ENEMY_R) {
        enemy.x = -ENEMY_R;
      }
      enemy.y = clamp(enemy.y, 40, waterLine() - 60);
      resolveCollision(enemy);
    }

    game.fish.timer -= dt;
    if (!game.fish.active && game.fish.timer <= 0) {
      game.fish.active = true;
      game.fish.x = Math.random() * game.width;
      game.fish.phase = 0;
    }
    if (game.fish.active) {
      game.fish.phase += dt;
      const rise = Math.max(0, Math.sin(game.fish.phase) * 70);
      game.fish.y = waterLine() + 16 - rise;
      if (game.fish.phase > Math.PI) {
        game.fish.active = false;
        game.fish.timer = 3 + Math.random() * 4;
      }
      const dx = p.x - game.fish.x;
      const dy = p.y - game.fish.y;
      if (p.y > waterLine() - 50 && Math.hypot(dx, dy) < PLAYER_R + 18) {
        loseLife();
      }
    }

    if (!reducedMotion) {
      for (const cloud of game.clouds) {
        cloud.x += cloud.speed * dt;
        if (cloud.x > game.width + 60) {
          cloud.x = -60;
        }
      }
    }
  }

  // Landing on an enemy from above (descending, overlapping, mostly above
  // it) pops it; any other overlap costs a life.
  function resolveCollision(enemy) {
    if (enemy.popped) {
      return;
    }
    const p = game.player;
    const dx = p.x - enemy.x;
    const dy = p.y - enemy.y;
    const dist = Math.hypot(dx, dy);
    if (dist > PLAYER_R + ENEMY_R) {
      return;
    }
    const stomp = p.vy > 0 && p.y < enemy.y;
    if (stomp) {
      popEnemy(enemy);
      p.vy = -FLAP_IMPULSE * 0.6;
    } else {
      loseLife();
    }
  }

  function palette() {
    return game.style == "retro"
      ? { sky: "#0f0f23", water: "#123b5e", player: "#ffd166", enemy: "#ef476f", fish: "#118ab2", cloud: "#2a2a4a" }
      : { sky: null, water: "#2a7fb3", player: "#ffe29a", enemy: "#ff8fb1", fish: "#7fd4ff", cloud: "#ffffff" };
  }

  function draw() {
    ctx.imageSmoothingEnabled = game.style != "retro";
    const pal = palette();
    ctx.clearRect(0, 0, game.width, game.height);

    if (!reducedMotion) {
      ctx.fillStyle = pal.cloud;
      ctx.globalAlpha = game.style == "retro" ? 1 : 0.5;
      for (const cloud of game.clouds) {
        ctx.beginPath();
        ctx.ellipse(cloud.x, cloud.y, 26, 10, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = pal.water;
    ctx.fillRect(0, waterLine(), game.width, game.height - waterLine());

    if (game.fish.active) {
      ctx.fillStyle = pal.fish;
      ctx.beginPath();
      ctx.ellipse(game.fish.x, game.fish.y, 16, 8, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const enemy of game.enemies) {
      drawBalloon(enemy.x, enemy.y, ENEMY_R, pal.enemy);
    }

    if (game.started) {
      const flash = game.player.invuln > 0 && Math.floor(game.player.invuln * 10) % 2 == 0;
      if (!flash) {
        drawBalloon(game.player.x, game.player.y, PLAYER_R, pal.player);
      }
    }
  }

  function drawBalloon(x, y, r, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y + r);
    ctx.lineTo(x, y + r + 10);
    ctx.stroke();
  }

  let lastTime = null;
  function loop(timestamp) {
    if (lastTime == null) {
      lastTime = timestamp;
    }
    const dt = Math.min(0.05, (timestamp - lastTime) / 1000);
    lastTime = timestamp;
    tick(dt);
    draw();
    window.requestAnimationFrame(loop);
  }

  function setStyle(style) {
    game.style = style == "retro" ? "retro" : "gradient";
    root.setAttribute("data-style", game.style);
    retroBtn.setAttribute("aria-pressed", String(game.style == "retro"));
    gradientBtn.setAttribute("aria-pressed", String(game.style == "gradient"));
    Services.prefs.setStringPref(STYLE_PREF, game.style);
  }

  // --- wiring ---
  window.addEventListener("resize", resize);
  resize();

  game.style = Services.prefs.getStringPref(STYLE_PREF, "gradient");
  game.chiptune = Services.prefs.getBoolPref(CHIPTUNE_PREF, false);
  game.best = Services.prefs.getIntPref(HIGH_SCORE_PREF, 0);
  setStyle(game.style);
  updateHud();

  retroBtn.addEventListener("click", () => setStyle("retro"));
  gradientBtn.addEventListener("click", () => setStyle("gradient"));
  playAgainBtn.addEventListener("click", resetRound);
  canvas.addEventListener("pointerdown", flap);

  window.addEventListener("keydown", event => {
    if (event.repeat && (event.code == "Space" || event.code == "ArrowUp")) {
      return;
    }
    switch (event.code) {
      case "Space":
      case "ArrowUp":
        event.preventDefault();
        flap();
        break;
      case "ArrowLeft":
        game.keys.left = true;
        break;
      case "ArrowRight":
        game.keys.right = true;
        break;
      case "KeyP":
        setPaused(!game.paused);
        break;
    }
  });
  window.addEventListener("keyup", event => {
    if (event.code == "ArrowLeft") {
      game.keys.left = false;
    } else if (event.code == "ArrowRight") {
      game.keys.right = false;
    }
  });
  window.addEventListener("blur", () => setPaused(true));

  window.requestAnimationFrame(loop);

  // Test hook (mochitest only): a deterministic stomp, so the score can be
  // checked without relying on physics timing.
  window.__whimsyGame = {
    get state() {
      return { score: game.score, best: game.best, lives: game.lives, style: game.style, over: game.over };
    },
    step() {
      if (!game.started) {
        resetRound();
      }
      const enemy = game.enemies.find(e => !e.popped);
      if (!enemy) {
        return;
      }
      game.player.x = enemy.x;
      game.player.y = enemy.y - PLAYER_R - ENEMY_R + 2;
      game.player.vy = FLAP_IMPULSE;
      game.player.invuln = 0;
      resolveCollision(enemy);
      draw();
    },
    setStyle,
  };
})();
