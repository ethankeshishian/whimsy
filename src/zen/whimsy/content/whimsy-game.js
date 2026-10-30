/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Balloon Hop: Whimsy's offline game (whimsy://game and the net-error
// page's "Play while you wait"). One button, in the spirit of Chrome's
// offline game but original from top to bottom: Whimsy's little hot-air
// balloon hops across a meadow. Tap to hop, hold to hop higher, keep
// holding on the way down to fire the burner and float. Thistles prick,
// paper planes cut across at two heights, ponds open up later on, and
// sparkles are worth a bonus. The world speeds up, the day turns into
// night and back, and a friend drifts by now and then.
//
// Two looks share one simulation: "gradient" (smooth vector art in the app
// icon's colours) and "retro" (a true pixel mode: hand-placed pixel sprites
// on a 300x100 canvas scaled with image-rendering: pixelated, a 3x5 pixel
// font for the score and messages, and square-wave chiptune blips).
//
// This page is loaded with the system principal (about:whimsy, see
// WhimsyAboutPage.sys.mjs), so it can use Services directly, the same way
// about:preferences's own script does.

"use strict";

(() => {
  const FEATURE_PREF = "whimsy.feature.game";
  const STYLE_PREF = "whimsy.game.style";
  const SOUND_PREF = "whimsy.game.chiptune";
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

  const $ = id => document.getElementById(id);
  const canvas = $("whimsy-game-canvas");
  const ctx = canvas.getContext("2d");
  const stage = $("whimsy-game-stage");
  const scoreEl = $("whimsy-game-score");
  const bestEl = $("whimsy-game-best");
  const readyCard = $("whimsy-game-overlay-ready");
  const pausedCard = $("whimsy-game-overlay-paused");
  const overCard = $("whimsy-game-overlay-gameover");
  const deathEl = $("whimsy-game-death");
  const newBestEl = $("whimsy-game-new-best");
  const playAgainBtn = $("whimsy-game-play-again");
  const soundBtn = $("whimsy-game-sound");
  const retroBtn = $("whimsy-game-style-retro");
  const gradientBtn = $("whimsy-game-style-gradient");
  const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

  // ---------------------------------------------------------------------
  // World (all simulation in world units; the canvas is a 3:1 window).
  const W = 480;
  const H = 160;
  const GROUND = 130;
  const PX = 2; // one retro pixel, in world units
  const PLAYER_X = 70;

  const JUMP_V = 430;
  const GRAV_UP = 1500; // rising while the button is held
  const GRAV_CUT = 3200; // rising after an early release: a short hop
  const GRAV_DOWN = 1700;
  const FLOAT_MAX_FALL = 90; // holding on the way down fires the burner
  const FLOAT_FUEL = 0.9; // seconds of burner per hop
  const MAX_FALL = 560;
  const COYOTE = 0.1; // you can still hop just after the ground ends
  const BUFFER = 0.13; // a press just before landing still counts
  const SPEED0 = 200;
  const SPEED_MAX = 440;
  const SPEED_ACCEL = 4.5;
  const SCORE_UNIT = 12; // world units per point
  const DAY_LENGTH = 900; // points per full day -> night -> day
  const SPARKLE_BONUS = 25;
  const RETRY_DELAY = 0.35;

  const game = {
    state: "ready", // ready | running | paused | over
    style: "gradient",
    sound: false,
    score: 0,
    bonus: 0,
    best: 0,
    newBest: false,
    distance: 0,
    speed: SPEED0,
    clock: 0, // always ticks, for idle animation
    runTime: 0,
    player: null,
    obstacles: [],
    particles: [],
    floaters: [],
    clouds: [],
    stars: [],
    spawnIn: 0,
    friendIn: 18,
    shake: 0,
    hitstop: 0,
    lastMilestone: 0,
    deathKind: "",
    overAt: 0,
    autoSpawn: true,
    frozen: false,
  };

  function resetPlayer() {
    game.player = {
      y: GROUND,
      vy: 0,
      onGround: true,
      coyote: 0,
      buffer: 0,
      holding: false,
      fuel: FLOAT_FUEL,
      floating: false,
      sx: 1,
      sy: 1,
      blinkIn: 2.5,
      blink: 0,
      dead: false,
    };
  }

  // A tiny seeded PRNG keeps the scenery stable across restarts.
  function seeded(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const reduced = () => reducedMotionQuery.matches;

  {
    const r = seeded(7);
    for (let i = 0; i < 5; i++) {
      game.clouds.push({ x: r() * W, y: 14 + r() * 44, s: 0.7 + r() * 0.8 });
    }
    for (let i = 0; i < 46; i++) {
      game.stars.push({ x: r() * W, y: r() * (GROUND - 60), tw: r() * 6.28 });
    }
  }

  // ---------------------------------------------------------------------
  // Colour

  const hexCache = new Map();
  function rgb(hex) {
    let v = hexCache.get(hex);
    if (!v) {
      const n = parseInt(hex.slice(1), 16);
      v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      hexCache.set(hex, v);
    }
    return v;
  }
  function mix(a, b, t) {
    const A = rgb(a);
    const B = rgb(b);
    const c = A.map((v, i) => Math.round(v + (B[i] - v) * t));
    if (game.style == "retro") {
      // Retro: snap to a 4-bit-per-channel palette for chunky banding.
      for (let i = 0; i < 3; i++) {
        c[i] = Math.round(c[i] / 17) * 17;
      }
    }
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  const SKY = [
    { at: 0.0, top: "#8fc8ff", bottom: "#f5e6ff", far: "#b9a6f0", near: "#8ccf86" },
    { at: 0.42, top: "#8fc8ff", bottom: "#f5e6ff", far: "#b9a6f0", near: "#8ccf86" },
    { at: 0.52, top: "#7a54d8", bottom: "#ffa7c4", far: "#9a6fc7", near: "#6fae78" },
    { at: 0.62, top: "#140e3a", bottom: "#3a2a78", far: "#2c2160", near: "#1f3b4a" },
    { at: 0.88, top: "#140e3a", bottom: "#3a2a78", far: "#2c2160", near: "#1f3b4a" },
    { at: 0.95, top: "#b08cff", bottom: "#ffd6b3", far: "#b393e0", near: "#7cc283" },
    { at: 1.0, top: "#8fc8ff", bottom: "#f5e6ff", far: "#b9a6f0", near: "#8ccf86" },
  ];

  function dayPhase() {
    return ((game.score % DAY_LENGTH) + DAY_LENGTH) % DAY_LENGTH / DAY_LENGTH;
  }
  function skyAt(phase) {
    let i = 0;
    while (i < SKY.length - 2 && phase > SKY[i + 1].at) {
      i++;
    }
    const a = SKY[i];
    const b = SKY[i + 1];
    const t = clamp((phase - a.at) / (b.at - a.at || 1), 0, 1);
    return {
      top: mix(a.top, b.top, t),
      bottom: mix(a.bottom, b.bottom, t),
      far: mix(a.far, b.far, t),
      near: mix(a.near, b.near, t),
    };
  }
  function nightness(phase) {
    if (phase < 0.52 || phase > 0.95) {
      return 0;
    }
    if (phase < 0.62) {
      return (phase - 0.52) / 0.1;
    }
    if (phase > 0.88) {
      return 1 - (phase - 0.88) / 0.07;
    }
    return 1;
  }

  // ---------------------------------------------------------------------
  // Sound: tiny WebAudio blips, off by default. Square waves in retro,
  // softer triangles in gradient.

  let audio = null;
  let noiseBuffer = null;
  function audioCtx() {
    if (!game.sound) {
      return null;
    }
    try {
      if (!audio) {
        audio = new AudioContext();
        noiseBuffer = audio.createBuffer(1, audio.sampleRate * 0.3, audio.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
          data[i] = Math.random() * 2 - 1;
        }
      }
      if (audio.state == "suspended") {
        audio.resume();
      }
    } catch (e) {
      return null;
    }
    return audio;
  }
  function tone(freq, dur, { to = freq, delay = 0, vol = 0.06 } = {}) {
    const ac = audioCtx();
    if (!ac) {
      return;
    }
    const t0 = ac.currentTime + delay;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = game.style == "retro" ? "square" : "triangle";
    osc.frequency.setValueAtTime(freq, t0);
    osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    const v = game.style == "retro" ? vol * 0.6 : vol * 1.4;
    gain.gain.setValueAtTime(v, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }
  function noise(dur, vol = 0.12) {
    const ac = audioCtx();
    if (!ac) {
      return;
    }
    const src = ac.createBufferSource();
    src.buffer = noiseBuffer;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(vol, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
    src.connect(gain).connect(ac.destination);
    src.start();
    src.stop(ac.currentTime + dur);
  }
  const sfx = {
    hop: () => tone(420, 0.11, { to: 760 }),
    land: () => tone(150, 0.05, { vol: 0.03 }),
    sparkle: () => {
      tone(988, 0.07);
      tone(1319, 0.12, { delay: 0.07 });
    },
    milestone: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.08, { delay: i * 0.06, vol: 0.05 })),
    pop: () => {
      noise(0.16);
      tone(320, 0.28, { to: 70, vol: 0.07 });
    },
    splash: () => {
      noise(0.35, 0.08);
      tone(240, 0.3, { to: 90, vol: 0.04 });
    },
    best: () => [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.1, { delay: 0.3 + i * 0.08, vol: 0.05 })),
  };

  // ---------------------------------------------------------------------
  // Particles

  function burst(x, y, n, opts) {
    const count = reduced() ? Math.ceil(n / 2) : n;
    for (let i = 0; i < count; i++) {
      const a = rand(opts.a0 ?? 0, opts.a1 ?? Math.PI * 2);
      const sp = rand(opts.s0 ?? 30, opts.s1 ?? 120);
      game.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp + (opts.vx ?? 0),
        vy: Math.sin(a) * sp,
        g: opts.g ?? 300,
        life: 0,
        max: rand(opts.l0 ?? 0.3, opts.l1 ?? 0.7),
        size: rand(opts.z0 ?? 1.5, opts.z1 ?? 3),
        color: opts.colors[Math.floor(Math.random() * opts.colors.length)],
        kind: opts.kind ?? "dot",
        rot: rand(0, 6.28),
        vr: rand(-10, 10),
      });
    }
  }
  function floatText(x, y, text, color) {
    game.particles.push({ x, y, vx: 0, vy: -40, g: 0, life: 0, max: 0.8, size: 1, color, kind: "text", text });
  }

  // ---------------------------------------------------------------------
  // Spawning

  function spawnPattern() {
    const s = game.score;
    const r = Math.random();
    const x = W + 24;
    if (s > 350 && r < 0.18) {
      const w = Math.round(rand(44, 44 + Math.min(56, game.speed * 0.12)));
      game.obstacles.push({ kind: "pond", x, w });
    } else if (s > 180 && r < 0.45) {
      const high = Math.random() < 0.4;
      const y = high ? GROUND - 64 : GROUND - 12;
      game.obstacles.push({ kind: "plane", x, y, baseY: y, w: 18, h: 8, phase: rand(0, 6.28) });
    } else {
      const n = 1 + Math.floor(Math.random() * (s > 100 ? 3 : 2));
      const tall = s > 60 && Math.random() < 0.5;
      game.obstacles.push({ kind: "thistle", x, n, w: n * 12 + 2, h: tall ? 26 : 18 });
    }
    if (Math.random() < 0.32) {
      const gap = game.speed * 0.55;
      game.obstacles.push({ kind: "sparkle", x: x + gap, y: GROUND - rand(34, 74), r: 7, spin: 0 });
    }
  }
  function gapFor(speed) {
    return speed * rand(0.95, 1.7) + 40;
  }

  // ---------------------------------------------------------------------
  // Collision

  function circleRect(cx, cy, r, x, y, w, h) {
    const nx = clamp(cx, x, x + w);
    const ny = clamp(cy, y, y + h);
    return (cx - nx) ** 2 + (cy - ny) ** 2 < r * r;
  }
  function hitsPlayer(x, y, w, h) {
    const p = game.player;
    return circleRect(PLAYER_X, p.y - 26, 11, x, y, w, h) ||
      (PLAYER_X - 5 < x + w && PLAYER_X + 5 > x && p.y - 8 < y + h && p.y > y);
  }
  function overPond() {
    return game.obstacles.some(o => o.kind == "pond" && PLAYER_X - 2 > o.x + 4 && PLAYER_X + 2 < o.x + o.w - 4);
  }

  // ---------------------------------------------------------------------
  // Flow

  function setState(state) {
    game.state = state;
    root.dataset.state = state;
    readyCard.hidden = state != "ready";
    pausedCard.hidden = state != "paused";
    overCard.hidden = state != "over";
  }

  function start() {
    resetPlayer();
    game.score = 0;
    game.bonus = 0;
    game.distance = 0;
    game.speed = SPEED0;
    game.runTime = 0;
    game.obstacles = [];
    game.floaters = [];
    game.spawnIn = W * 0.55;
    game.lastMilestone = 0;
    game.newBest = false;
    game.shake = 0;
    game.hitstop = 0;
    scoreEl.textContent = "0";
    setState("running");
  }

  function die(kind) {
    if (game.state != "running") {
      return;
    }
    const p = game.player;
    game.deathKind = kind;
    game.overAt = game.clock;
    game.hitstop = reduced() ? 0 : 0.09;
    game.shake = reduced() ? 0 : 5;
    p.dead = true;
    p.vy = kind == "pond" ? 60 : -150;
    if (kind == "pond") {
      burst(PLAYER_X, GROUND + 2, 18, { a0: -2.6, a1: -0.5, s0: 60, s1: 170, g: 600, colors: ["#bfe8ff", "#7fd0ff", "#ffffff"] });
      floatText(PLAYER_X, GROUND - 46, "SPLASH!", "#3a7bd5");
      sfx.splash();
    } else {
      burst(PLAYER_X, p.y - 27, 22, {
        s0: 60,
        s1: 200,
        g: 380,
        l0: 0.5,
        l1: 1,
        z0: 2,
        z1: 4,
        kind: "shred",
        colors: ["#b5a0ff", "#d995e6", "#f6a5ba", "#efe8ff"],
      });
      game.particles.push({ x: PLAYER_X, y: p.y - 27, vx: 0, vy: 0, g: 0, life: 0, max: 0.35, size: 1, color: "#fff", kind: "ring" });
      floatText(PLAYER_X + 4, p.y - 48, "POP!", "#ff4f8b");
      sfx.pop();
    }
    if (game.score > game.best) {
      game.best = game.score;
      game.newBest = true;
      bestEl.textContent = String(game.best);
      try {
        Services.prefs.setIntPref(HIGH_SCORE_PREF, game.best);
      } catch (e) {}
      sfx.best();
      if (!reduced()) {
        burst(W / 2, 30, 30, { a0: 0.3, a1: 2.8, s0: 40, s1: 160, g: 220, l0: 0.8, l1: 1.4, kind: "shred", colors: ["#ffd86b", "#7fd6c2", "#f6a5ba", "#b5a0ff"] });
      }
    }
    document.l10n.setAttributes(deathEl, `whimsy-game-death-${kind}`);
    newBestEl.hidden = !game.newBest;
    setState("over");
  }

  function setPaused(paused) {
    if (paused && game.state == "running") {
      game.player.holding = false;
      setState("paused");
    } else if (!paused && game.state == "paused") {
      setState("running");
    }
  }

  // The one button.
  function press() {
    if (game.state == "paused") {
      setPaused(false);
      return;
    }
    if (game.state == "over") {
      if (game.clock - game.overAt < RETRY_DELAY) {
        return;
      }
      start();
    } else if (game.state == "ready") {
      start();
    }
    const p = game.player;
    p.holding = true;
    p.buffer = BUFFER;
  }
  function release() {
    if (game.player) {
      game.player.holding = false;
    }
  }

  // ---------------------------------------------------------------------
  // Update

  function updatePlayer(dt) {
    const p = game.player;
    p.buffer -= dt;
    p.coyote -= dt;

    if (p.onGround && overPond()) {
      p.onGround = false;
      p.coyote = COYOTE;
    }
    if (p.buffer > 0 && (p.onGround || p.coyote > 0)) {
      p.vy = -JUMP_V;
      p.onGround = false;
      p.coyote = 0;
      p.buffer = 0;
      p.fuel = FLOAT_FUEL;
      p.sx = 0.82;
      p.sy = 1.22;
      burst(PLAYER_X, p.y - 2, 6, { a0: 2.2, a1: 3.6, s0: 20, s1: 60, g: -40, colors: ["#ffffff", "#f3eaff"], z0: 2, z1: 3.5 });
      sfx.hop();
    }

    p.floating = false;
    if (!p.onGround) {
      const g = p.vy < 0 ? (p.holding ? GRAV_UP : GRAV_CUT) : GRAV_DOWN;
      p.vy = Math.min(MAX_FALL, p.vy + g * dt);
      if (p.vy > 0 && p.holding && p.fuel > 0) {
        p.vy = Math.min(p.vy, FLOAT_MAX_FALL);
        p.fuel -= dt;
        p.floating = true;
        if (Math.random() < 0.5) {
          burst(PLAYER_X, p.y - 12, 1, { a0: 1.2, a1: 1.9, s0: 20, s1: 50, g: 0, l0: 0.15, l1: 0.3, colors: ["#ffd86b", "#ff9b54"] });
        }
      }
      const prevY = p.y;
      p.y += p.vy * dt;
      if (p.vy >= 0 && prevY <= GROUND + 1 && p.y >= GROUND && !overPond()) {
        const impact = clamp(p.vy / MAX_FALL, 0.15, 1);
        p.y = GROUND;
        p.vy = 0;
        p.onGround = true;
        p.sx = 1 + 0.3 * impact;
        p.sy = 1 - 0.3 * impact;
        burst(PLAYER_X, GROUND, 3 + Math.round(impact * 5), { a0: Math.PI, a1: Math.PI * 1.15, s0: 20, s1: 70, g: 80, colors: ["#e9ddc9", "#d8c8b0"], z0: 1.5, z1: 3 });
        burst(PLAYER_X, GROUND, 3 + Math.round(impact * 4), { a0: -0.15, a1: 0, s0: 20, s1: 60, g: 80, colors: ["#e9ddc9", "#d8c8b0"], z0: 1.5, z1: 3 });
        sfx.land();
      }
      if (p.y > GROUND + 26) {
        die("pond");
        return;
      }
    }
    // Ease the squash and stretch back to round.
    const k = 1 - Math.exp(-14 * dt);
    p.sx += (1 - p.sx) * k;
    p.sy += (1 - p.sy) * k;
    if (!p.onGround && p.vy < -120 && !reduced()) {
      p.sx += (0.9 - p.sx) * k * 0.5;
      p.sy += (1.1 - p.sy) * k * 0.5;
    }
  }

  function updateWorld(dt) {
    game.runTime += dt;
    game.speed = Math.min(SPEED_MAX, game.speed + SPEED_ACCEL * dt);
    const dx = game.speed * dt;
    game.distance += dx;
    game.score = Math.floor(game.distance / SCORE_UNIT) + game.bonus;

    if (game.autoSpawn) {
      game.spawnIn -= dx;
      if (game.spawnIn <= 0) {
        spawnPattern();
        game.spawnIn = gapFor(game.speed);
      }
    }

    for (const o of game.obstacles) {
      o.x -= dx;
      if (o.kind == "plane") {
        o.x -= 60 * dt;
        o.phase += dt * 5;
        o.y = o.baseY + Math.sin(o.phase) * 2;
      } else if (o.kind == "sparkle") {
        o.spin += dt * 4;
      }
    }
    game.obstacles = game.obstacles.filter(o => o.x + (o.w ?? 10) > -40 && !o.gone);

    updatePlayer(dt);
    if (game.state != "running") {
      return;
    }

    for (const o of game.obstacles) {
      if (o.kind == "thistle" && hitsPlayer(o.x + 3, GROUND - o.h + 4, o.w - 6, o.h - 4)) {
        die("thistle");
        return;
      }
      if (o.kind == "plane" && hitsPlayer(o.x + 1, o.y + 1, o.w - 2, o.h - 2)) {
        die("plane");
        return;
      }
      if (o.kind == "sparkle" && !o.gone && circleRect(o.x, o.y, o.r + 4, PLAYER_X - 11, game.player.y - 37, 22, 37)) {
        o.gone = true;
        game.bonus += SPARKLE_BONUS;
        burst(o.x, o.y, 10, { s0: 30, s1: 110, g: 0, l0: 0.3, l1: 0.6, colors: ["#ffd86b", "#fff3c4"] });
        floatText(o.x, o.y - 10, `+${SPARKLE_BONUS}`, "#f2b400");
        sfx.sparkle();
      }
    }

    // Milestones every 100 points: a chime and a flash; every 500 a balloon party.
    const milestone = Math.floor(game.score / 100);
    if (milestone > game.lastMilestone) {
      game.lastMilestone = milestone;
      sfx.milestone();
      game.flashUntil = game.clock + 0.8;
      root.classList.remove("whimsy-game-milestone");
      void root.offsetWidth;
      root.classList.add("whimsy-game-milestone");
      setTimeout(() => root.classList.remove("whimsy-game-milestone"), 800);
      if (milestone % 5 == 0) {
        for (let i = 0; i < 9; i++) {
          game.floaters.push({ kind: "party", x: rand(W * 0.35, W - 10), y: H + rand(0, 60), vy: -rand(30, 55), hue: i % 4 });
        }
      }
    }
    if (game.score > game.best && game.best > 0 && !game.newBest) {
      game.newBest = true;
      floatText(PLAYER_X + 40, game.player.y - 50, "BEST!", "#ff9b54");
    }

    // A friend drifts by now and then; shooting stars at night.
    game.friendIn -= dt;
    if (game.friendIn <= 0) {
      game.friendIn = rand(25, 45);
      game.floaters.push({ kind: "friend", x: W + 30, y: rand(22, 40), t: 0, said: false });
    }
    if (nightness(dayPhase()) > 0.8 && Math.random() < dt * 0.12) {
      game.floaters.push({ kind: "star", x: rand(W * 0.3, W), y: rand(5, 40), t: 0 });
    }

    const text = String(game.score);
    if (scoreEl.textContent != text) {
      scoreEl.textContent = text;
    }
  }

  function updateAmbient(dt) {
    const scroll = game.state == "running" ? game.speed : game.state == "ready" ? 30 : 0;
    for (const c of game.clouds) {
      c.x -= (scroll * 0.18 + 6) * dt * c.s;
      if (c.x < -60) {
        c.x = W + 40;
        c.y = 14 + Math.random() * 44;
      }
    }
    for (const f of game.floaters) {
      if (f.kind == "friend") {
        f.t += dt;
        f.x -= (20 + scroll * 0.12) * dt;
        f.y += Math.sin(f.t * 1.4) * 6 * dt;
      } else if (f.kind == "party") {
        f.y += f.vy * dt;
        f.x += Math.sin(f.y * 0.05 + f.hue) * 10 * dt;
      } else if (f.kind == "star") {
        f.t += dt;
        f.x -= 260 * dt;
        f.y += 90 * dt;
      }
    }
    game.floaters = game.floaters.filter(f => f.x > -60 && f.y > -60 && !(f.kind == "star" && f.t > 0.8));

    for (const p of game.particles) {
      p.life += dt;
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.rot !== undefined) {
        p.rot += p.vr * dt;
      }
    }
    game.particles = game.particles.filter(p => p.life < p.max);

    const p = game.player;
    p.blinkIn -= dt;
    if (p.blinkIn <= 0) {
      p.blink = 0.12;
      p.blinkIn = rand(2, 4.5);
    }
    p.blink = Math.max(0, p.blink - dt);
    if (p.dead && game.state == "over") {
      p.vy += 700 * dt;
      p.y = Math.min(H + 60, p.y + p.vy * dt);
    }
    game.shake *= Math.exp(-10 * dt);
  }

  function update(dt) {
    game.clock += dt;
    if (game.hitstop > 0) {
      game.hitstop -= dt;
      return;
    }
    if (game.state == "running") {
      updateWorld(dt);
    }
    updateAmbient(dt);
  }

  // ---------------------------------------------------------------------
  // Pixel art (retro)

  const PIXEL_FONT = {
    A: "010101111101101", B: "110101110101110", C: "011100100100011", D: "110101101101110",
    E: "111100110100111", F: "111100110100100", G: "011100101101011", H: "101101111101101",
    I: "111010010010111", J: "001001001101010", K: "101101110101101", L: "100100100100111",
    M: "101111111101101", N: "110101101101101", O: "010101101101010", P: "110101110100100",
    Q: "010101101110011", R: "110101110101101", S: "011100010001110", T: "111010010010010",
    U: "101101101101111", V: "101101101101010", W: "101101111111101", X: "101101010101101",
    Y: "101101010010010", Z: "111001010100111",
    0: "111101101101111", 1: "010110010010111", 2: "110001010100111", 3: "110001010001110",
    4: "101101111001001", 5: "111100110001110", 6: "011100111101111", 7: "111001010010010",
    8: "111101111101111", 9: "111101111001110",
    "!": "010010010000010", ".": "000000000000010", ",": "000000000010100", "'": "010010000000000",
    ":": "000010000010000", "-": "000000111000000", "?": "110001010000010", "/": "001001010100100",
    "+": "000010111010000",
  };

  function pixelTextWidth(text, scale = 1) {
    return (text.length * 4 - 1) * PX * scale;
  }
  function pixelText(text, x, y, color, scale = 1, shadow = "rgba(29,19,64,0.6)") {
    const u = PX * scale;
    const draw = (ox, oy, fill) => {
      ctx.fillStyle = fill;
      let cx = Math.round(ox / PX) * PX;
      const cy = Math.round(oy / PX) * PX;
      for (const ch of text.toUpperCase().replace(/[’‘]/g, "'")) {
        const glyph = PIXEL_FONT[ch];
        if (glyph) {
          for (let i = 0; i < 15; i++) {
            if (glyph[i] == "1") {
              ctx.fillRect(cx + (i % 3) * u, cy + Math.floor(i / 3) * u, u, u);
            }
          }
        }
        cx += 4 * u;
      }
    };
    if (shadow) {
      // A dark plate behind the text keeps it readable on a bright sky
      // (a drop shadow fills the holes of a 3x5 font).
      ctx.fillStyle = shadow;
      ctx.fillRect(snap(x) - PX * 2, snap(y) - PX * 2, pixelTextWidth(text, scale) + PX * 4, 5 * u + PX * 4);
    }
    draw(x, y, color);
  }
  function pixelTextCentered(text, cx, y, color, scale = 1, plate = undefined) {
    pixelText(text, cx - pixelTextWidth(text, scale) / 2, y, color, scale, plate);
  }

  const spriteCache = new Map();
  function sprite(key, rows, palette) {
    let img = spriteCache.get(key);
    if (img) {
      return img;
    }
    img = document.createElement("canvas");
    img.width = rows[0].length;
    img.height = rows.length;
    const c = img.getContext("2d");
    rows.forEach((row, y) => {
      [...row].forEach((ch, x) => {
        if (palette[ch]) {
          c.fillStyle = palette[ch];
          c.fillRect(x, y, 1, 1);
        }
      });
    });
    spriteCache.set(key, img);
    return img;
  }

  // Whimsy's balloon as a 13x19 pixel sprite, drawn procedurally so the
  // blink, X-eyed and friend variants all share one silhouette.
  function balloonRows(face, stripes) {
    const rows = [];
    const inside = (x, y) => {
      if (y < 0 || y > 13 || x < 0 || x > 12) {
        return false;
      }
      if (y <= 7) {
        return (x - 6) ** 2 + (y - 6) ** 2 <= 6.4 ** 2;
      }
      return Math.abs(x - 6) <= 6.4 - (y - 7) * 0.8;
    };
    for (let y = 0; y < 19; y++) {
      let row = "";
      for (let x = 0; x < 13; x++) {
        let ch = ".";
        if (y <= 13 && inside(x, y)) {
          const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
          const d = Math.abs(x - 6);
          ch = edge ? "k" : stripes && (d <= 1 || d == 4 || d == 5) ? "b" : "a";
          if (!edge && ((x == 3 && (y == 3 || y == 4)) || (x == 4 && y == 2))) {
            ch = "w";
          }
        } else if ((y == 14 || y == 15) && (x == 4 || x == 8)) {
          ch = "r";
        } else if (y >= 16 && x >= 4 && x <= 8) {
          ch = y == 17 && x > 4 && x < 8 ? "y" : "r";
        }
        row += ch;
      }
      rows.push(row);
    }
    const set = (x, y, ch) => {
      rows[y] = rows[y].slice(0, x) + ch + rows[y].slice(x + 1);
    };
    if (face == "dead") {
      // Popped: only the basket, its ropes and a limp scrap of balloon.
      for (let y = 0; y < 14; y++) {
        rows[y] = ".".repeat(13);
      }
      rows[12] = "....kbak.....";
      rows[13] = "...kaabbk....";
    } else {
      for (const ex of [4, 8]) {
        if (face != "blink") {
          set(ex, 7, "k");
        }
        set(ex, 8, "k");
      }
      set(3, 10, "p");
      set(9, 10, "p");
      set(6, 10, "k");
    }
    return rows;
  }
  const BALLOON_PAL = { a: "#b5a0ff", b: "#f09ac8", w: "#f3edff", k: "#3a2462", r: "#7a4a2e", y: "#d9954f", p: "#ff6f9f" };
  const FRIEND_PAL = { a: "#7fd6c2", b: "#ffd86b", w: "#f2fff9", k: "#245a52", r: "#7a4a2e", y: "#d9954f", p: "#ff8fa8" };
  const PARTY_COLORS = ["#ff8fb8", "#ffd86b", "#7fd6c2", "#b5a0ff"];

  const THISTLE_SHORT = [
    ".m.m.m.",
    "m.MMM.m",
    ".MMmMM.",
    "..MMM..",
    "..ggg..",
    "...g...",
    ".g.g.g.",
    "..ggg..",
    "...g...",
  ];
  const THISTLE_TALL = [
    ...THISTLE_SHORT.slice(0, 6),
    ".gg.g..",
    "..ggg..",
    "...g.gg",
    "...ggg.",
    ...THISTLE_SHORT.slice(6),
  ];
  const THISTLE_PAL = { m: "#d58bf0", M: "#9b4dca", g: "#3e8e4e" };
  const PLANE_ROWS = [
    "w........",
    "wwww.....",
    ".lwwwwwww",
    "..llwww..",
    "...ll....",
  ];
  const PLANE_PAL = { w: "#ffffff", l: "#a99fd6" };
  const SPARKLE_ROWS = [
    ["..y..", ".yWy.", "yWWWy", ".yWy.", "..y.."],
    ["..y..", "..y..", "yyWyy", "..y..", "..y.."],
  ];
  const SPARKLE_PAL = { y: "#ffcf4a", W: "#fff6d0" };

  const snap = v => Math.round(v / PX) * PX;
  function drawSprite(img, x, y, sx = 1, sy = 1) {
    const w = img.width * PX * sx;
    const h = img.height * PX * sy;
    ctx.drawImage(img, snap(x), snap(y), snap(w), snap(h));
  }

  // ---------------------------------------------------------------------
  // Rendering: shared scenery maths

  const farHill = wx => 36 + 10 * Math.sin(wx * 0.011) + 6 * Math.sin(wx * 0.027 + 1.3);
  const nearHill = wx => 16 + 7 * Math.sin(wx * 0.017 + 2) + 4 * Math.sin(wx * 0.041);
  const hash = i => {
    const s = Math.sin(i * 127.1) * 43758.5453;
    return s - Math.floor(s);
  };

  function retro() {
    return game.style == "retro";
  }

  function drawSky(sky, night) {
    if (retro()) {
      const bands = 7;
      const bh = snap(GROUND / bands);
      for (let i = 0; i < bands; i++) {
        ctx.fillStyle = mix(rgbHex(sky.top), rgbHex(sky.bottom), i / (bands - 1));
        ctx.fillRect(0, i * bh, W, bh + PX);
      }
    } else {
      const g = ctx.createLinearGradient(0, 0, 0, GROUND);
      g.addColorStop(0, sky.top);
      g.addColorStop(1, sky.bottom);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, GROUND + 2);
    }
    // Stars
    if (night > 0) {
      for (const s of game.stars) {
        const a = night * (0.5 + 0.5 * Math.sin(game.clock * 2 + s.tw));
        ctx.fillStyle = `rgba(255,248,220,${a.toFixed(2)})`;
        if (retro()) {
          ctx.fillRect(snap(s.x), snap(s.y), PX, PX);
        } else {
          ctx.beginPath();
          ctx.arc(s.x, s.y, 0.9, 0, 6.29);
          ctx.fill();
        }
      }
    }
    // Sun by day, moon by night, on a gentle arc.
    const phase = dayPhase();
    const sunT = phase / 0.58;
    if (sunT <= 1) {
      const x = W * (0.85 - sunT * 0.6);
      const y = 60 - Math.sin(sunT * Math.PI) * 34;
      disc(x, y, 13, "#ffe9a8", "#ffcf6b");
    }
    const moonT = (phase - 0.55) / 0.42;
    if (moonT >= 0 && moonT <= 1) {
      const x = W * (0.9 - moonT * 0.7);
      const y = 56 - Math.sin(moonT * Math.PI) * 30;
      disc(x, y, 10, "#fff6dc", "#f1e3b8");
      ctx.fillStyle = mix(rgbHex(sky.top), rgbHex(sky.bottom), 0.3);
      if (retro()) {
        pixelDisc(x + 5, y - 3, 8);
      } else {
        ctx.beginPath();
        ctx.arc(x + 5, y - 3, 8.5, 0, 6.29);
        ctx.fill();
      }
    }
  }
  function rgbHex(c) {
    if (c.startsWith("#")) {
      return c;
    }
    const [r, g, b] = c.match(/\d+/g).map(Number);
    return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }
  function pixelDisc(cx, cy, r) {
    for (let y = -r; y <= r; y += PX) {
      const half = Math.sqrt(Math.max(0, r * r - y * y));
      ctx.fillRect(snap(cx - half), snap(cy + y), snap(half * 2), PX);
    }
  }
  function disc(x, y, r, inner, outer) {
    if (retro()) {
      ctx.fillStyle = outer;
      pixelDisc(x, y, r);
      ctx.fillStyle = inner;
      pixelDisc(x - 2, y - 2, r - 4);
      return;
    }
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 1, x, y, r);
    g.addColorStop(0, inner);
    g.addColorStop(1, outer);
    ctx.save();
    ctx.shadowColor = outer;
    ctx.shadowBlur = 18;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 6.29);
    ctx.fill();
    ctx.restore();
  }

  function drawClouds(night) {
    const a = 0.85 - night * 0.6;
    ctx.fillStyle = `rgba(255,255,255,${a.toFixed(2)})`;
    for (const c of game.clouds) {
      const s = c.s;
      if (retro()) {
        ctx.fillRect(snap(c.x), snap(c.y), snap(34 * s), snap(6 * s));
        ctx.fillRect(snap(c.x + 6 * s), snap(c.y - 6 * s), snap(16 * s), snap(6 * s));
        ctx.fillRect(snap(c.x + 18 * s), snap(c.y - 4 * s), snap(10 * s), snap(4 * s));
      } else {
        ctx.beginPath();
        ctx.ellipse(c.x + 16 * s, c.y, 18 * s, 6 * s, 0, 0, 6.29);
        ctx.arc(c.x + 10 * s, c.y - 3 * s, 7 * s, 0, 6.29);
        ctx.arc(c.x + 21 * s, c.y - 5 * s, 9 * s, 0, 6.29);
        ctx.fill();
      }
    }
  }

  function drawHills(sky) {
    const farScroll = game.distance * 0.15;
    const nearScroll = game.distance * 0.4;
    for (const [fn, scroll, color, base] of [
      [farHill, farScroll, sky.far, GROUND],
      [nearHill, nearScroll, sky.near, GROUND],
    ]) {
      ctx.fillStyle = color;
      if (retro()) {
        for (let x = 0; x < W; x += PX) {
          const h = snap(fn(x + scroll));
          ctx.fillRect(x, base - h, PX, h);
        }
      } else {
        ctx.beginPath();
        ctx.moveTo(0, base);
        for (let x = 0; x <= W; x += 6) {
          ctx.lineTo(x, base - fn(x + scroll));
        }
        ctx.lineTo(W, base);
        ctx.fill();
      }
    }
    // Lollipop trees on the near hills.
    const spacing = 70;
    const first = Math.floor(nearScroll / spacing);
    for (let i = first; i < first + W / spacing + 2; i++) {
      if (hash(i) < 0.45) {
        continue;
      }
      const wx = i * spacing + hash(i + 9) * 30;
      const x = wx - nearScroll;
      const y = GROUND - nearHill(wx) + 2;
      const r = 5 + hash(i + 3) * 4;
      ctx.fillStyle = sky.near;
      if (retro()) {
        ctx.fillRect(snap(x - 1), snap(y - r - 6), PX, snap(r + 6));
        pixelDisc(x, y - r - 6, snap(r));
      } else {
        ctx.fillRect(x - 0.8, y - r - 4, 1.6, r + 4);
        ctx.beginPath();
        ctx.arc(x, y - r - 5, r, 0, 6.29);
        ctx.fill();
      }
    }
  }

  function drawGround(night) {
    const grass = mix("#8fdc8a", "#2f5d58", night);
    const soil = mix("#6b4fa0", "#2a2050", night);
    const dots = mix("#8a6cc0", "#3a2d6a", night);
    ctx.fillStyle = soil;
    ctx.fillRect(0, GROUND, W, H - GROUND);
    ctx.fillStyle = grass;
    ctx.fillRect(0, GROUND, W, retro() ? PX * 2 : 4);
    // Scrolling pebbles so speed reads clearly.
    ctx.fillStyle = dots;
    const step = 26;
    const off = game.distance % step;
    for (let x = -off, i = Math.floor(game.distance / step); x < W; x += step, i++) {
      const y = GROUND + 8 + hash(i) * 22;
      const w = 2 + Math.round(hash(i + 5) * 3) * 2;
      if (retro()) {
        ctx.fillRect(snap(x), snap(y), snap(w), PX);
      } else {
        ctx.beginPath();
        ctx.ellipse(x, y, w / 2, 1.2, 0, 0, 6.29);
        ctx.fill();
      }
    }
    // Ponds cut the ground.
    for (const o of game.obstacles) {
      if (o.kind != "pond") {
        continue;
      }
      const top = mix("#8fd8ff", "#2a4c8a", night);
      const deep = mix("#3a7bd5", "#16244f", night);
      if (retro()) {
        ctx.fillStyle = deep;
        ctx.fillRect(snap(o.x), GROUND, snap(o.w), H - GROUND);
        ctx.fillStyle = top;
        ctx.fillRect(snap(o.x), GROUND + PX * 3, snap(o.w), PX * 2);
        ctx.fillStyle = "#ffffff";
        const wave = snap(o.x + ((game.clock * 20) % Math.max(PX, o.w - 8)));
        ctx.fillRect(wave, GROUND + PX * 3, PX * 3, PX);
      } else {
        const g = ctx.createLinearGradient(0, GROUND, 0, H);
        g.addColorStop(0, top);
        g.addColorStop(1, deep);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.roundRect(o.x, GROUND - 1, o.w, H - GROUND + 4, [0, 0, 6, 6]);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.6)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = o.x + 4; x < o.x + o.w - 4; x += 2) {
          const y = GROUND + 7 + Math.sin(x * 0.4 + game.clock * 4) * 1;
          x == o.x + 4 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
  }

  function drawFloaters(night) {
    for (const f of game.floaters) {
      if (f.kind == "friend") {
        drawBalloon(f.x, f.y + 38, 0.7, 0.7, { friend: true, alpha: 0.85 });
        if (f.x < W * 0.7 && f.x > W * 0.35) {
          if (retro()) {
            pixelText("HI!", f.x + 12, f.y - 4, "#ffffff", 1);
          } else {
            bubble(f.x + 14, f.y - 2, "hi!");
          }
        }
      } else if (f.kind == "party") {
        const color = PARTY_COLORS[f.hue];
        ctx.fillStyle = color;
        if (retro()) {
          ctx.fillRect(snap(f.x - 3), snap(f.y - 8), PX * 3, PX * 4);
          ctx.fillRect(snap(f.x - 1), snap(f.y), PX, PX * 4);
        } else {
          ctx.beginPath();
          ctx.ellipse(f.x, f.y - 6, 4.5, 5.5, 0, 0, 6.29);
          ctx.fill();
          ctx.strokeStyle = "rgba(255,255,255,0.6)";
          ctx.lineWidth = 0.6;
          ctx.beginPath();
          ctx.moveTo(f.x, f.y);
          ctx.quadraticCurveTo(f.x + 3, f.y + 6, f.x, f.y + 12);
          ctx.stroke();
        }
      } else if (f.kind == "star" && night > 0.5) {
        const a = 1 - f.t / 0.8;
        ctx.strokeStyle = `rgba(255,250,230,${a.toFixed(2)})`;
        ctx.fillStyle = ctx.strokeStyle;
        if (retro()) {
          for (let i = 0; i < 5; i++) {
            ctx.fillRect(snap(f.x + i * 6), snap(f.y - i * 2), PX * 2, PX);
          }
        } else {
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(f.x, f.y);
          ctx.lineTo(f.x + 30, f.y - 10);
          ctx.stroke();
        }
      }
    }
  }
  function bubble(x, y, text) {
    ctx.save();
    ctx.font = "600 9px system-ui, sans-serif";
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.beginPath();
    ctx.roundRect(x, y - 12, w, 14, 7);
    ctx.fill();
    ctx.fillStyle = "#3a2462";
    ctx.fillText(text, x + 5, y - 2);
    ctx.restore();
  }

  function drawBalloon(x, y, sx, sy, { friend = false, dead = false, alpha = 1, flame = false } = {}) {
    const p = game.player;
    const blink = !friend && p.blink > 0;
    if (retro()) {
      ctx.save();
      ctx.globalAlpha = alpha;
      const face = dead ? "dead" : blink ? "blink" : "open";
      const key = `balloon-${friend ? "f" : "p"}-${face}`;
      const img = sprite(key, balloonRows(face, true), friend ? FRIEND_PAL : BALLOON_PAL);
      const w = img.width * PX * sx;
      const h = img.height * PX * sy;
      drawSprite(img, x - w / 2, y - h, sx, sy);
      if (flame) {
        ctx.fillStyle = Math.floor(game.clock * 20) % 2 ? "#ffcf4a" : "#ff8a3d";
        ctx.fillRect(snap(x - PX), snap(y - 12 * sy), PX * 2, PX * 2);
      }
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.scale(sx, sy);
    // Ropes and basket.
    ctx.strokeStyle = "#7a5640";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-6, -15);
    ctx.lineTo(-4, -8);
    ctx.moveTo(6, -15);
    ctx.lineTo(4, -8);
    ctx.stroke();
    ctx.fillStyle = "#d9954f";
    ctx.beginPath();
    ctx.roundRect(-5.5, -8, 11, 8, [1, 1, 2.5, 2.5]);
    ctx.fill();
    ctx.fillStyle = "#a8682f";
    ctx.fillRect(-5.5, -8, 11, 1.6);
    ctx.fillRect(-5.5, -4, 11, 0.8);
    if (flame) {
      const f = 1 + Math.sin(game.clock * 40) * 0.2;
      const g = ctx.createLinearGradient(0, -18, 0, -9);
      g.addColorStop(0, "#fff3c4");
      g.addColorStop(1, "#ff8a3d");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(0, -12.5, 2.2, 3.5 * f, 0, 0, 6.29);
      ctx.fill();
    }
    if (!dead) {
      const env = new Path2D();
      env.arc(0, -28, 13, Math.PI * 0.8, Math.PI * 2.2);
      env.lineTo(5, -15);
      env.lineTo(-5, -15);
      env.closePath();
      const g = ctx.createRadialGradient(-4, -33, 1, 0, -26, 17);
      if (friend) {
        g.addColorStop(0, "#e8fff8");
        g.addColorStop(0.5, "#7fd6c2");
        g.addColorStop(1, "#ffd86b");
      } else {
        g.addColorStop(0, "#e2d8ff");
        g.addColorStop(0.45, "#b5a0ff");
        g.addColorStop(0.8, "#d995e6");
        g.addColorStop(1, "#f6a5ba");
      }
      ctx.fillStyle = g;
      ctx.fill(env);
      ctx.save();
      ctx.clip(env);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.ellipse(0, -27, 5, 14, 0, 0, 6.29);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.beginPath();
      ctx.ellipse(-6.5, -34, 2, 3.2, -0.5, 0, 6.29);
      ctx.fill();
      // Face
      const look = !friend && p.vy < -100 ? -1 : !friend && p.floating ? 0.6 : 0;
      ctx.fillStyle = "#2a1a3e";
      ctx.strokeStyle = "#2a1a3e";
      ctx.lineWidth = 1.1;
      ctx.lineCap = "round";
      for (const ex of [-4, 4]) {
        if (blink) {
          ctx.beginPath();
          ctx.moveTo(ex - 1.5, -26 + look);
          ctx.lineTo(ex + 1.5, -26 + look);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.ellipse(ex, -26 + look, 1.3, 1.7, 0, 0, 6.29);
          ctx.fill();
        }
      }
      ctx.fillStyle = "rgba(255,111,159,0.45)";
      for (const bx of [-7.5, 7.5]) {
        ctx.beginPath();
        ctx.ellipse(bx, -22.5, 2.2, 1.4, 0, 0, 6.29);
        ctx.fill();
      }
      ctx.beginPath();
      if (!friend && p.floating) {
        ctx.ellipse(0, -21.8, 1.4, 1.6, 0, 0, 6.29);
        ctx.fillStyle = "#2a1a3e";
        ctx.fill();
      } else {
        ctx.arc(0, -23, 2.2, Math.PI * 0.15, Math.PI * 0.85);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawObstacles() {
    for (const o of game.obstacles) {
      if (o.kind == "thistle") {
        for (let i = 0; i < o.n; i++) {
          const x0 = o.x + 7 + i * 12;
          if (retro()) {
            const img = sprite(o.h > 20 ? "thistle-tall" : "thistle", o.h > 20 ? THISTLE_TALL : THISTLE_SHORT, THISTLE_PAL);
            drawSprite(img, x0 - 7, GROUND - img.height * PX);
          } else {
            drawThistle(x0, o.h, i);
          }
        }
      } else if (o.kind == "plane") {
        if (retro()) {
          drawSprite(sprite("plane", PLANE_ROWS, PLANE_PAL), o.x, o.y - 1);
        } else {
          ctx.fillStyle = "#ffffff";
          ctx.strokeStyle = "#6a5f99";
          ctx.lineWidth = 0.7;
          ctx.lineJoin = "round";
          ctx.beginPath();
          ctx.moveTo(o.x, o.y + 4);
          ctx.lineTo(o.x + 18, o.y);
          ctx.lineTo(o.x + 13, o.y + 5);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = "#d7d0f0";
          ctx.beginPath();
          ctx.moveTo(o.x, o.y + 4);
          ctx.lineTo(o.x + 13, o.y + 5);
          ctx.lineTo(o.x + 16, o.y + 8.5);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.strokeStyle = "rgba(255,255,255,0.55)";
          ctx.beginPath();
          ctx.moveTo(o.x + 22, o.y + 3);
          ctx.lineTo(o.x + 30, o.y + 3);
          ctx.moveTo(o.x + 21, o.y + 6);
          ctx.lineTo(o.x + 27, o.y + 6);
          ctx.stroke();
        }
      } else if (o.kind == "sparkle") {
        const bob = Math.sin(game.clock * 4 + o.x * 0.05) * 2;
        if (retro()) {
          const frame = Math.floor(game.clock * 4) % 2;
          drawSprite(sprite(`sparkle${frame}`, SPARKLE_ROWS[frame], SPARKLE_PAL), o.x - 5, o.y - 5 + snap(bob));
        } else {
          ctx.save();
          ctx.translate(o.x, o.y + bob);
          ctx.rotate(o.spin * 0.3);
          ctx.shadowColor = "#ffd86b";
          ctx.shadowBlur = 10;
          ctx.fillStyle = "#ffd86b";
          ctx.beginPath();
          for (let k = 0; k < 8; k++) {
            const r = k % 2 ? 2.4 : 7;
            const a = (k * Math.PI) / 4;
            ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
          }
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      }
    }
  }
  function drawThistle(x, h, i) {
    const top = GROUND - h;
    ctx.strokeStyle = "#3f8f55";
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x, GROUND);
    ctx.quadraticCurveTo(x + (i % 2 ? 1.5 : -1.5), (GROUND + top) / 2, x, top + 8);
    ctx.stroke();
    ctx.fillStyle = "#4fa35f";
    ctx.beginPath();
    ctx.ellipse(x - 3.5, GROUND - h * 0.35, 3.5, 1.4, -0.6, 0, 6.29);
    ctx.ellipse(x + 3.5, GROUND - h * 0.55, 3.5, 1.4, 0.6, 0, 6.29);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(x, top + 7, 4.2, 3.8, 0, 0, 6.29);
    ctx.fill();
    ctx.strokeStyle = "#2f6e40";
    ctx.lineWidth = 0.7;
    ctx.stroke();
    ctx.strokeStyle = "#a35bd6";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let k = -4; k <= 4; k++) {
      ctx.moveTo(x + k * 0.6, top + 4);
      ctx.lineTo(x + k * 1.2, top - 1 + Math.abs(k) * 0.7);
    }
    ctx.stroke();
  }

  function drawParticles() {
    for (const p of game.particles) {
      const a = clamp(1 - p.life / p.max, 0, 1);
      ctx.globalAlpha = a;
      if (p.kind == "text") {
        if (retro()) {
          pixelTextCentered(p.text, p.x, p.y, p.color, 1, null);
        } else {
          ctx.save();
          ctx.font = "800 12px system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.lineWidth = 3;
          ctx.strokeStyle = "rgba(42,26,62,0.6)";
          ctx.strokeText(p.text, p.x, p.y);
          ctx.fillStyle = p.color;
          ctx.fillText(p.text, p.x, p.y);
          ctx.restore();
        }
      } else if (p.kind == "ring") {
        const r = 6 + (p.life / p.max) * 26;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = retro() ? PX : 2;
        if (retro()) {
          const s = snap(r);
          ctx.strokeRect(snap(p.x - s), snap(p.y - s), s * 2, s * 2);
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, 6.29);
          ctx.stroke();
        }
      } else {
        ctx.fillStyle = p.color;
        if (retro()) {
          ctx.fillRect(snap(p.x), snap(p.y), PX, PX);
        } else if (p.kind == "shred") {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillRect(-p.size, -p.size / 3, p.size * 2, p.size / 1.5);
          ctx.restore();
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, 6.29);
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  // Retro draws its own pixel-font HUD and messages; the DOM copies stay
  // for screen readers (see whimsy-game.css).
  const pixelStrings = {};
  function drawRetroHud() {
    const pad = n => String(n).padStart(5, "0");
    const hi = `HI ${pad(game.best)}`;
    const now = pad(game.score);
    const flash = game.clock < (game.flashUntil ?? 0) && Math.floor(game.clock * 8) % 2;
    pixelText(hi, W - pixelTextWidth(`${hi}  ${now}`) - 8, 8, "rgba(255,255,255,0.7)");
    if (!flash) {
      pixelText(now, W - pixelTextWidth(now) - 8, 8, "#ffffff");
    }
    const mid = W / 2;
    if (game.state == "ready") {
      pixelTextCentered(pixelStrings.title || "", mid, 28, "#ffffff", 3);
      if (Math.floor(game.clock * 2) % 2 == 0) {
        pixelTextCentered(pixelStrings.start || "", mid, 68, "#ffffff", 1);
      }
    } else if (game.state == "paused") {
      pixelTextCentered(pixelStrings.paused || "", mid, 52, "#ffffff", 1);
    } else if (game.state == "over" && game.clock - game.overAt > 0.25) {
      pixelTextCentered(pixelStrings.over || "", mid, 22, "#ffffff", 3);
      pixelTextCentered(pixelStrings[game.deathKind] || "", mid, 58, "#ffffff", 1);
      if (game.newBest) {
        pixelTextCentered(pixelStrings.best || "", mid, 72, "#ffd86b", 1);
      }
      if (Math.floor(game.clock * 2) % 2 == 0) {
        pixelTextCentered(pixelStrings.again || "", mid, 88, "#ffffff", 1);
      }
    }
  }

  function render() {
    const night = nightness(dayPhase());
    const sky = skyAt(dayPhase());
    const shakeOn = !reduced() && game.shake > 0.2;
    const sx = shakeOn ? (Math.random() - 0.5) * game.shake * 2 : 0;
    const sy = shakeOn ? (Math.random() - 0.5) * game.shake * 2 : 0;
    if (retro()) {
      ctx.imageSmoothingEnabled = false;
      ctx.setTransform(1 / PX, 0, 0, 1 / PX, snap(sx) / PX, snap(sy) / PX);
    } else {
      const s = canvas.width / W;
      ctx.setTransform(s, 0, 0, s, sx * s, sy * s);
    }
    ctx.clearRect(-20, -20, W + 40, H + 40);
    drawSky(sky, night);
    drawClouds(night);
    drawFloaters(night);
    drawHills(sky);
    drawGround(night);
    drawObstacles();

    const p = game.player;
    const bob = game.state == "ready" && !reduced() ? Math.sin(game.clock * 3) * 1.5 : 0;
    if (game.state != "over" || p.y < H + 50) {
      drawBalloon(PLAYER_X, p.y + bob, p.sx, p.sy, {
        dead: p.dead && game.deathKind != "pond",
        flame: p.floating || (!p.onGround && p.vy < -200),
      });
    }
    drawParticles();

    // Night: a soft violet dusk over everything except the sky.
    if (night > 0 && !retro()) {
      ctx.fillStyle = `rgba(20,12,58,${(night * 0.18).toFixed(3)})`;
      ctx.fillRect(0, GROUND - 60, W, H - GROUND + 60);
    }
    if (retro()) {
      drawRetroHud();
    }
  }

  // ---------------------------------------------------------------------
  // Loop

  let last = 0;
  function frame(t) {
    const dt = last ? Math.min(0.033, (t - last) / 1000) : 0;
    last = t;
    if (!game.frozen && game.state != "paused") {
      update(dt);
    }
    render();
    requestAnimationFrame(frame);
  }

  function resize() {
    if (retro()) {
      canvas.width = W / PX;
      canvas.height = H / PX;
    } else {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(W, Math.round(rect.width * dpr));
      canvas.height = Math.round((canvas.width * H) / W);
    }
    render();
  }

  // ---------------------------------------------------------------------
  // Controls

  function applyStyle(style) {
    game.style = style == "retro" ? "retro" : "gradient";
    root.dataset.style = game.style;
    retroBtn.setAttribute("aria-pressed", String(game.style == "retro"));
    gradientBtn.setAttribute("aria-pressed", String(game.style == "gradient"));
    resize();
  }
  function setStyle(style) {
    applyStyle(style);
    try {
      Services.prefs.setStringPref(STYLE_PREF, game.style);
    } catch (e) {}
  }
  function setSound(on) {
    game.sound = on;
    soundBtn.setAttribute("aria-pressed", String(on));
    try {
      Services.prefs.setBoolPref(SOUND_PREF, on);
    } catch (e) {}
    if (on) {
      sfx.sparkle();
    }
  }

  retroBtn.addEventListener("click", () => setStyle("retro"));
  gradientBtn.addEventListener("click", () => setStyle("gradient"));
  soundBtn.addEventListener("click", () => setSound(!game.sound));
  playAgainBtn.addEventListener("click", () => {
    press();
    release();
  });

  const JUMP_KEYS = new Set([" ", "ArrowUp", "w", "W"]);
  window.addEventListener("keydown", event => {
    if (JUMP_KEYS.has(event.key)) {
      event.preventDefault();
      if (!event.repeat) {
        press();
      }
    } else if (event.key == "p" || event.key == "P" || (event.key == "Escape" && game.state == "running")) {
      setPaused(game.state == "running");
    }
  });
  window.addEventListener("keyup", event => {
    if (JUMP_KEYS.has(event.key)) {
      event.preventDefault();
      release();
    }
  });
  stage.addEventListener("pointerdown", event => {
    if (event.button != 0 || event.target.closest("button")) {
      return;
    }
    event.preventDefault();
    press();
  });
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
  window.addEventListener("blur", () => setPaused(!game.frozen));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && !game.frozen) {
      setPaused(true);
    }
  });
  new ResizeObserver(() => resize()).observe(canvas);

  // ---------------------------------------------------------------------
  // Boot

  resetPlayer();
  try {
    game.best = Services.prefs.getIntPref(HIGH_SCORE_PREF, 0);
    game.sound = Services.prefs.getBoolPref(SOUND_PREF, false);
    applyStyle(Services.prefs.getStringPref(STYLE_PREF, "gradient"));
  } catch (e) {
    applyStyle("gradient");
  }
  bestEl.textContent = String(game.best);
  soundBtn.setAttribute("aria-pressed", String(game.sound));
  setState("ready");

  document.l10n
    .formatValues([
      "whimsy-game-title",
      "whimsy-game-start-hint",
      "whimsy-game-paused",
      "whimsy-game-over-title",
      "whimsy-game-death-thistle",
      "whimsy-game-death-plane",
      "whimsy-game-death-pond",
      "whimsy-game-new-best",
      "whimsy-game-retry-hint",
    ])
    .then(([title, start, paused, over, thistle, plane, pond, best, again]) => {
      Object.assign(pixelStrings, { title, start, paused, over, thistle, plane, pond, best, again });
    })
    .catch(() => {});

  requestAnimationFrame(frame);

  // Test hooks (mochitests drive the simulation deterministically).
  window.__whimsyGame = {
    get state() {
      return game;
    },
    press,
    release,
    start,
    // Advance the simulation by `seconds` in fixed 1/120 s steps.
    tick(seconds) {
      const steps = Math.max(1, Math.round(seconds * 120));
      for (let i = 0; i < steps; i++) {
        update(1 / 120);
      }
      render();
    },
    // Stop the real-time loop from advancing the world (it still draws).
    freeze(frozen = true) {
      game.frozen = frozen;
    },
    setAutoSpawn(on) {
      game.autoSpawn = on;
    },
    clear() {
      game.obstacles = [];
    },
    spawn(kind, props = {}) {
      const base = {
        thistle: { kind, x: PLAYER_X - 6, n: 1, w: 14, h: 18 },
        plane: { kind, x: PLAYER_X - 6, y: GROUND - 12, baseY: GROUND - 12, w: 18, h: 8, phase: 0 },
        pond: { kind, x: PLAYER_X - 30, w: 60 },
        sparkle: { kind, x: PLAYER_X, y: GROUND - 26, r: 7, spin: 0 },
      }[kind];
      const o = { ...base, ...props };
      if (o.kind == "plane") {
        o.baseY = o.y;
      }
      game.obstacles.push(o);
      return o;
    },
    render,
    constants: { W, H, GROUND, PLAYER_X, COYOTE, BUFFER, SPARKLE_BONUS, RETRY_DELAY },
  };
})();
