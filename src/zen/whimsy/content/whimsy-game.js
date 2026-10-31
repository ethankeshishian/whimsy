/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Balloon Dash: Whimsy's offline game (whimsy://game and the net-error
// page). An original dodge-and-collect arcade game: Whimsy's balloon
// floats in an open sky. Steer with the arrow keys/WASD or let it follow
// your pointer; Space or a click dashes (short cooldown, brief
// invulnerability). Thistle seeds, paper planes, grumpy thunderclouds and
// spiralling birds drift in from the edges - always telegraphed first,
// never on top of you. Sparkles collected in quick succession build a
// combo; shields, magnets and slow-mo turn up now and then; skimming past
// a hazard is a "close call" bonus. The day turns to night and back.
//
// Two looks share one simulation: "gradient" (smooth vector art in the app
// icon's colours) and "retro" (a true pixel mode: pixel sprites on a
// 240x80 canvas scaled with image-rendering: pixelated, a 3x5 pixel font,
// square-wave blips).
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

  // On whimsy://game the page has system privileges and reads prefs
  // directly. Embedded in the offline error page (WhimsyNetErrorChild), the
  // actor hands over a small host: pref reads, pref writes via the parent,
  // and "autostart" when the page was turned into the game by a key press.
  const host = window.WhimsyGameHost ?? null;
  const embedded = !!host;
  const prefs = host ?? {
    get(name, fallback) {
      const P = Services.prefs;
      return typeof fallback == "boolean" ? P.getBoolPref(name, fallback)
        : typeof fallback == "number" ? P.getIntPref(name, fallback)
          : P.getStringPref(name, fallback);
    },
    set(name, value) {
      const P = Services.prefs;
      typeof value == "boolean" ? P.setBoolPref(name, value)
        : typeof value == "number" ? P.setIntPref(name, value)
          : P.setStringPref(name, value);
    },
  };
  // The same markup as whimsy-game.html, for the embedded case.
  const MARKUP = '<div id="whimsy-game-root" data-style="gradient" data-state="ready"><header id="whimsy-game-hud"><h1 id="whimsy-game-name" data-l10n-id="whimsy-game-title"></h1><div id="whimsy-game-scores"><span class="whimsy-game-stat"><span id="whimsy-game-best-label" data-l10n-id="whimsy-game-best"></span><span id="whimsy-game-best">0</span></span><span class="whimsy-game-stat"><span id="whimsy-game-score-label" data-l10n-id="whimsy-game-score"></span><span id="whimsy-game-score">0</span></span></div><div id="whimsy-game-controls"><button id="whimsy-game-sound" type="button" aria-pressed="false" data-l10n-id="whimsy-game-sound"></button><span id="whimsy-game-style-switch" role="group" data-l10n-id="whimsy-game-style-group"><button id="whimsy-game-style-gradient" type="button" data-l10n-id="whimsy-game-style-gradient"></button><button id="whimsy-game-style-retro" type="button" data-l10n-id="whimsy-game-style-retro"></button></span></div></header><main id="whimsy-game-stage"><canvas id="whimsy-game-canvas"></canvas><div id="whimsy-game-online-notice" class="whimsy-game-online-notice" hidden><span class="whimsy-game-online-dot"></span><span data-l10n-id="whimsy-game-back-online"></span><button id="whimsy-game-reload-btn" type="button" data-l10n-id="whimsy-game-reload-page"></button></div><div id="whimsy-game-overlay" aria-live="polite"><div id="whimsy-game-overlay-ready" class="whimsy-game-card"><p class="whimsy-game-card-title" data-l10n-id="whimsy-game-start-title"></p><p class="whimsy-game-card-body" data-l10n-id="whimsy-game-start-hint"></p></div><div id="whimsy-game-overlay-paused" class="whimsy-game-card" hidden><p class="whimsy-game-card-title" data-l10n-id="whimsy-game-paused"></p></div><div id="whimsy-game-overlay-gameover" class="whimsy-game-card" hidden><p class="whimsy-game-card-title" data-l10n-id="whimsy-game-over-title"></p><p id="whimsy-game-death" class="whimsy-game-card-body"></p><p id="whimsy-game-new-best" class="whimsy-game-badge" data-l10n-id="whimsy-game-new-best" hidden></p><button id="whimsy-game-play-again" type="button" data-l10n-id="whimsy-game-play-again"></button></div></div></main><p id="whimsy-game-hint" data-l10n-id="whimsy-game-hint"></p></div>';
  if (host && !document.getElementById("whimsy-game-root")) {
    const mount = document.createElement("div");
    mount.id = "whimsy-game-embed";
    mount.innerHTML = MARKUP;
    document.body.prepend(mount);
    document.l10n?.translateFragment?.(mount)?.catch?.(() => {});
  }
  const root = document.getElementById("whimsy-game-root");

  if (!prefs.get(FEATURE_PREF, true)) {
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
  const onlineNotice = $("whimsy-game-online-notice");
  const reloadBtn = $("whimsy-game-reload-btn");
  const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

  // ---------------------------------------------------------------------
  // World (all simulation in world units; the canvas is a 3:1 window).
  const W = 480;
  const H = 160;
  const GROUND = 130;
  const PX = 2; // one retro pixel, in world units

  const START_X = 120;
  const START_Y = 96; // the basket's bottom
  const BODY = 37; // basket bottom to envelope top
  const TOP = 4;
  const ACCEL = 900;
  const MAX_V = 140;
  const DRAG = 4;
  const DASH_V = 330;
  const DASH_TIME = 0.18;
  const DASH_COOLDOWN = 1.2;
  const DASH_INVULN = 0.32;
  const HIT_R = 9; // generous: the envelope is drawn with r 13
  const SAFE_SPAWN = 90; // nothing appears closer than this to the balloon
  const TELEGRAPH = 0.8; // seconds of warning at the edge first
  const CLOSE_PAD = 12;
  const CLOSE_BONUS = 5;
  const SPARKLE_POINTS = 10;
  const COMBO_WINDOW = 2;
  const MAX_COMBO = 5;
  const DAY_LENGTH = 600; // points per full day -> night -> day
  const SLOW_TIME = 5; // seconds of slow-mo per pickup
  const SLOW_SCALE = 0.4; // the world's speed during slow-mo
  const SLOW_EASE = 10; // how fast the world eases into and out of it
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
    speed: 30, // scenery drift
    clock: 0, // always ticks, for idle animation
    runTime: 0,
    player: null,
    particles: [],
    floaters: [],
    ambient: [], // seasonal snow, petals or leaves behind the hills
    clouds: [],
    stars: [],
    spawnIn: 0,
    itemIn: 0,
    powerIn: 0,
    warnings: [],
    items: [],
    combo: 0,
    comboAt: -10,
    slowT: 0,
    timeScale: 1, // the world's speed (the balloon always runs at 1)
    worldClock: 0, // game.clock at the world's speed, for hazard animation
    input: { x: 0, y: 0 },
    pointer: null,
    stats: { minSpawn: Infinity, launched: 0 },
    friendIn: 18,
    shake: 0,
    hitstop: 0,
    hazards: [],
    lastMilestone: 0,
    deathKind: "",
    overAt: 0,
    autoSpawn: true,
    frozen: false,
  };

  function resetPlayer() {
    game.player = {
      x: START_X,
      y: START_Y,
      vx: 0,
      vy: 0,
      sx: 1,
      sy: 1,
      flame: 0,
      dashT: 0,
      dashCd: 0,
      invuln: 0,
      shield: 0,
      magnet: 0,
      trail: [],
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

  // ---------------------------------------------------------------------
  // Seasons: the same game in a seasonal costume, from Whimsy's calendar
  // (WhimsySeasons; the seasonal switch turns it off). Art only: hitboxes,
  // speeds, telegraphs and power-up colours never change, so a run plays
  // the same in any month and nothing new has to be learned.
  const DAY = { top: "#8fc8ff", bottom: "#f5e6ff", far: "#b9a6f0", near: "#8ccf86" };
  const DUSK = { top: "#7a54d8", bottom: "#ffa7c4", far: "#9a6fc7", near: "#6fae78" };
  const GROUND_DAY = { grass: "#8fdc8a", soil: "#6b4fa0", dots: "#8a6cc0" };
  const COSTUMES = {
    autumn: {
      day: { top: "#8fbfe8", bottom: "#ffe4cc", far: "#c99ad8", near: "#e3a256" },
      dusk: { top: "#7a54d8", bottom: "#ffb08a", far: "#a0679f", near: "#b9783f" },
      ground: { grass: "#e6a64e", soil: "#6b4fa0", dots: "#d9774a" },
      seed: "leaf",
      bird: { k: "#6e4a5e", K: "#3a2230", o: "#ffb04a" },
      plane: "#f0c9a0",
      sparkle: { y: "#ffb347", W: "#fff0c8" },
    },
    winter: {
      day: { top: "#a6d2ff", bottom: "#f6ecff", far: "#c3c2ee", near: "#e4eefc" },
      dusk: { top: "#6f62d0", bottom: "#ffc0d8", far: "#9a8cd0", near: "#b9c4e8" },
      ground: { grass: "#f4f8ff", soil: "#7d74b8", dots: "#a59ad6" },
      seed: "snow",
      bird: { k: "#c8364f", K: "#7a1f35", o: "#ffb04a" },
      sparkle: { y: "#9fdcff", W: "#ffffff" },
    },
    spring: {
      day: { top: "#9fd3ff", bottom: "#ffe6f2", far: "#c2b0f2", near: "#93d987" },
      ground: { grass: "#a3e88f", soil: "#6b4fa0", dots: "#ff9fc8" },
      seed: "bee",
      bird: { k: "#4f7fd6", K: "#2a3f80", o: "#ff9b54" },
      sparkle: { y: "#ff8fbf", W: "#ffd86b" },
      blossom: true,
    },
    summer: {
      day: { top: "#72c0ff", bottom: "#fff0d9", far: "#b9a6f0", near: "#7fcf7a" },
      seed: "seed",
      bird: { k: "#3e4660", K: "#8a93ab", o: "#ff9b54" },
    },
  };
  // wave7/season: occasions (WhimsySeasons' calendar) dress up their season
  // a little further: still art only. The balloon keeps its season's
  // costume; the sky, the bird and the sparkle change.
  COSTUMES.autumn.ambient = "leaves";
  COSTUMES.winter.ambient = "snow";
  COSTUMES.spring.ambient = "petals";
  // Halloween: a dusky pumpkin sky, bats for birds, sweets for sparkles.
  COSTUMES.halloween = {
    ...COSTUMES.autumn,
    base: "autumn",
    day: { top: "#9a86e0", bottom: "#ffcf9e", far: "#8f6fb0", near: "#c9803e" },
    dusk: { top: "#4b2f9a", bottom: "#ff9a5a", far: "#6a3f7f", near: "#8f5a2f" },
    bat: true,
    bird: { k: "#4a2f5a", K: "#24152e", o: "#ffcf4a" },
    sparkle: { y: "#ff9a3c", W: "#fff1d6" },
    candy: true,
  };
  // Winter holidays: snow, and presents for sparkles.
  COSTUMES.holidays = {
    ...COSTUMES.winter,
    base: "winter",
    sparkle: { y: "#e5485f", W: "#ffd86b" },
    present: true,
  };
  function readSeason() {
    // Embedded in the error page, the actor passes the look along.
    if (host) {
      const id = host.look ?? host.season;
      return id in COSTUMES ? id : null;
    }
    try {
      const { WhimsySeasons } = ChromeUtils.importESModule(
        "resource:///modules/whimsy/WhimsySeasons.sys.mjs"
      );
      return WhimsySeasons.look()?.id ?? null;
    } catch (e) {
      return null;
    }
  }
  // season: the balloon's costume (autumn, winter, spring, summer); look:
  // the season or an occasion within it (halloween, holidays).
  let season = null;
  let look = null;
  let costume = {};
  let SKY = [];
  function setSeason(id) {
    look = id in COSTUMES ? id : null;
    costume = look ? COSTUMES[look] : {};
    season = look ? costume.base ?? look : null;
    game.ambient = [];
    game.ambientSeeded = false;
    if (season) {
      root.dataset.season = season;
      root.dataset.look = look;
    } else {
      delete root.dataset.season;
      delete root.dataset.look;
    }
    const day = { ...DAY, ...costume.day };
    const dusk = { ...DUSK, ...costume.dusk };
    SKY = [
      { at: 0.0, ...day },
      { at: 0.42, ...day },
      { at: 0.52, ...dusk },
      { at: 0.62, top: "#140e3a", bottom: "#3a2a78", far: "#2c2160", near: "#1f3b4a" },
      { at: 0.88, top: "#140e3a", bottom: "#3a2a78", far: "#2c2160", near: "#1f3b4a" },
      { at: 0.95, top: "#b08cff", bottom: "#ffd6b3", far: "#b393e0", near: "#7cc283" },
      { at: 1.0, ...day },
    ];
  }
  setSeason(readSeason());

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
        // A pending autoplay resume rejects when this document is closed.
        audio.resume().catch(() => {});
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

  const HAZARDS = {
    seed: { r: 5, speed: [30, 50], after: 0, weight: 3 },
    plane: { r: 6, speed: [110, 145], after: 12, weight: 2 },
    zap: { after: 25, weight: 1 },
    bird: { r: 6, speed: [45, 65], after: 40, weight: 1 },
  };
  const POWERS = ["shield", "magnet", "slow"];
  const center = () => ({ x: game.player.x, y: game.player.y - 24 });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function pickKind() {
    const kinds = Object.keys(HAZARDS).filter(k => game.runTime >= HAZARDS[k].after);
    let r = Math.random() * kinds.reduce((sum, k) => sum + HAZARDS[k].weight, 0);
    return kinds.find(k => (r -= HAZARDS[k].weight) < 0) ?? "seed";
  }

  // Every hazard is announced at the edge it will come from, aimed across
  // the arena, and never starts within SAFE_SPAWN of the balloon.
  function warn(kind) {
    const c = center();
    if (kind == "zap") {
      let x = rand(24, W - 24);
      for (let i = 0; i < 8 && Math.abs(x - c.x) < 60; i++) {
        x = rand(24, W - 24);
      }
      game.hazards.push({ kind, x, t: 0, seed: Math.random() * 1000 });
      game.stats.launched++;
      return;
    }
    let pos;
    for (let i = 0; i < 12; i++) {
      const edge = Math.floor(Math.random() * 3);
      pos = edge == 0 ? { x: -12, y: rand(14, GROUND - 14) }
        : edge == 1 ? { x: W + 12, y: rand(14, GROUND - 14) }
          : { x: rand(20, W - 20), y: -12 };
      if (dist(pos, c) >= SAFE_SPAWN + 20) {
        break;
      }
    }
    const aim = kind == "plane"
      ? { x: c.x + rand(-60, 60), y: c.y + rand(-30, 30) }
      : { x: rand(W * 0.25, W * 0.75), y: rand(20, GROUND - 20) };
    const len = Math.hypot(aim.x - pos.x, aim.y - pos.y) || 1;
    game.warnings.push({ kind, x: pos.x, y: pos.y, dx: (aim.x - pos.x) / len, dy: (aim.y - pos.y) / len, t: 0 });
  }

  function launch(w) {
    const c = center();
    if (dist(w, c) < SAFE_SPAWN) {
      w.t -= 0.3; // the balloon is right there: wait a moment
      return false;
    }
    const def = HAZARDS[w.kind];
    const v = rand(...def.speed);
    const h = { kind: w.kind, x: w.x, y: w.y, vx: w.dx * v, vy: w.dy * v, r: def.r, t: 0, phase: rand(0, 6.28) };
    if (w.kind == "bird") {
      Object.assign(h, { cx: w.x, cy: w.y, a: 0, R: 18 });
    }
    game.hazards.push(h);
    game.stats.launched++;
    game.stats.minSpawn = Math.min(game.stats.minSpawn, dist(w, c));
    return true;
  }

  function spawnItem(kind) {
    const c = center();
    let pos;
    for (let i = 0; i < 12; i++) {
      pos = { x: rand(24, W - 24), y: rand(20, GROUND - 16) };
      if (dist(pos, c) > 50) {
        break;
      }
    }
    game.items.push({ kind, x: pos.x, y: pos.y, t: 0, life: kind == "sparkle" ? 7 : 8, spin: 0 });
  }

  // ---------------------------------------------------------------------
  // Collision

  function circleRect(cx, cy, r, x, y, w, h) {
    const nx = clamp(cx, x, x + w);
    const ny = clamp(cy, y, y + h);
    return (cx - nx) ** 2 + (cy - ny) ** 2 < r * r;
  }
  // Distance from the balloon's hit circle to a hazard's edge (< 0: a hit).
  function gap(h) {
    const c = center();
    if (h.kind == "zap") {
      return h.t >= 1 && h.t < 1.35 ? Math.abs(c.x - h.x) - 5 - HIT_R : Infinity;
    }
    return dist(h, c) - HIT_R - h.r * 0.8;
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
    game.runTime = 0;
    game.hazards = [];
    game.warnings = [];
    game.items = [];
    game.floaters = [];
    game.combo = 0;
    game.comboAt = -10;
    game.slowT = 0;
    game.timeScale = 1;
    game.spawnIn = 1.2;
    game.itemIn = 0.4;
    game.powerIn = 9;
    game.lastMilestone = 0;
    game.newBest = false;
    game.shake = 0;
    game.hitstop = 0;
    game.stats = { minSpawn: Infinity, launched: 0 };
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
    p.vy = -120;
    burst(p.x, p.y - 27, 22, {
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
    game.particles.push({ x: p.x, y: p.y - 27, vx: 0, vy: 0, g: 0, life: 0, max: 0.35, size: 1, color: "#fff", kind: "ring" });
    floatText(p.x + 4, p.y - 48, "POP!", "#ff4f8b");
    sfx.pop();
    if (game.score > game.best) {
      game.best = game.score;
      game.newBest = true;
      bestEl.textContent = String(game.best);
      try {
        prefs.set(HIGH_SCORE_PREF, game.best);
      } catch (e) {}
      sfx.best();
      if (!reduced()) {
        burst(W / 2, 30, 30, { a0: 0.3, a1: 2.8, s0: 40, s1: 160, g: 220, l0: 0.8, l1: 1.4, kind: "shred", colors: ["#ffd86b", "#7fd6c2", "#f6a5ba", "#b5a0ff"] });
      }
    }
    scoreEl.textContent = String(game.score);
    document.l10n.setAttributes(deathEl, deathId(kind));
    newBestEl.hidden = !game.newBest;
    setState("over");
  }

  // The seed hazard wears the season's costume, so its line does too.
  function deathId(kind) {
    if (kind == "bird" && costume.bat) {
      return "whimsy-game-death-bird-halloween";
    }
    return kind == "seed" && costume.seed && costume.seed != "seed"
      ? `whimsy-game-death-seed-${season}`
      : `whimsy-game-death-${kind}`;
  }

  function setPaused(paused) {
    if (paused && game.state == "running") {
      setState("paused");
    } else if (!paused && game.state == "paused") {
      setState("running");
    }
  }

  // Space or a click: starts, retries, and otherwise dashes.
  function press() {
    if (game.state == "paused") {
      setPaused(false);
      return;
    }
    if (game.state == "over") {
      if (game.clock - game.overAt >= RETRY_DELAY) {
        start();
      }
      return;
    }
    if (game.state == "ready") {
      start();
      return;
    }
    dash();
  }
  function dash() {
    const p = game.player;
    if (p.dashCd > 0) {
      return false;
    }
    let dx = game.input.x;
    let dy = game.input.y;
    if (!dx && !dy && game.pointer) {
      dx = game.pointer.x - p.x;
      dy = game.pointer.y - (p.y - 24);
    }
    if (!dx && !dy) {
      dx = p.vx || 1;
      dy = p.vy;
    }
    const len = Math.hypot(dx, dy) || 1;
    p.vx = (dx / len) * DASH_V;
    p.vy = (dy / len) * DASH_V;
    p.dashT = DASH_TIME;
    p.dashCd = DASH_COOLDOWN;
    p.invuln = Math.max(p.invuln, DASH_INVULN);
    p.flame = 0.25;
    p.sx = Math.abs(dx) > Math.abs(dy) ? 1.25 : 0.8;
    p.sy = Math.abs(dx) > Math.abs(dy) ? 0.8 : 1.25;
    burst(p.x, p.y - 24, 8, { s0: 40, s1: 100, g: 0, l0: 0.2, l1: 0.4, colors: ["#ffffff", "#f3eaff", "#ffd86b"] });
    tone(300, 0.14, { to: 900, vol: 0.05 });
    return true;
  }
  function release() {}

  // ---------------------------------------------------------------------
  // Update

  function updatePlayer(dt) {
    const p = game.player;
    for (const k of ["dashT", "dashCd", "invuln", "shield", "magnet", "flame"]) {
      p[k] = Math.max(0, p[k] - dt);
    }
    let ax = 0;
    let ay = 0;
    const steering = game.input.x || game.input.y;
    if (steering) {
      ax = game.input.x * ACCEL;
      ay = game.input.y * ACCEL;
    } else if (game.pointer) {
      const tx = clamp((game.pointer.x - p.x) * 5, -MAX_V, MAX_V);
      const ty = clamp((game.pointer.y - (p.y - 24)) * 5, -MAX_V, MAX_V);
      ax = (tx - p.vx) * 8;
      ay = (ty - p.vy) * 8;
    }
    if (p.dashT <= 0) {
      p.vx += ax * dt;
      p.vy += ay * dt;
      if (!steering && !game.pointer) {
        const d = Math.exp(-DRAG * dt);
        p.vx *= d;
        p.vy *= d;
      }
      const speed = Math.hypot(p.vx, p.vy);
      if (speed > MAX_V) {
        const k = MAX_V + (speed - MAX_V) * Math.exp(-10 * dt);
        p.vx *= k / speed;
        p.vy *= k / speed;
      }
    }
    if (ay < -100) {
      p.flame = Math.max(p.flame, 0.05);
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    // Soft edges: a gentle bounce, never a death.
    let bump = false;
    if (p.x < 14 || p.x > W - 14) {
      p.x = clamp(p.x, 14, W - 14);
      p.vx = -p.vx * 0.3;
      bump = true;
    }
    if (p.y - BODY < TOP || p.y > GROUND - 1) {
      p.y = clamp(p.y, TOP + BODY, GROUND - 1);
      p.vy = -p.vy * 0.3;
      bump = true;
    }
    if (bump) {
      p.sx = 1.12;
      p.sy = 0.9;
    }
    const k = 1 - Math.exp(-12 * dt);
    p.sx += (1 - p.sx) * k;
    p.sy += (1 - p.sy) * k;
    if (p.dashT > 0 || Math.hypot(p.vx, p.vy) > MAX_V * 0.9) {
      p.trail.unshift({ x: p.x, y: p.y, t: game.clock });
    }
    p.trail = p.trail.filter(q => game.clock - q.t < 0.18).slice(0, 6);
  }

  function hit(h) {
    const p = game.player;
    if (p.invuln > 0) {
      return;
    }
    if (p.shield > 0) {
      p.shield = 0;
      p.invuln = 1;
      h.gone = true;
      burst(p.x, p.y - 22, 16, { s0: 40, s1: 140, g: 0, colors: ["#7fd6ff", "#ffffff"] });
      game.shake = reduced() ? 0 : 3;
      tone(880, 0.2, { to: 220 });
      return;
    }
    die(h.kind);
  }

  function collect(item) {
    const p = game.player;
    item.gone = true;
    if (item.kind == "sparkle") {
      game.combo = game.clock - game.comboAt < COMBO_WINDOW ? Math.min(MAX_COMBO, game.combo + 1) : 1;
      game.comboAt = game.clock;
      const points = SPARKLE_POINTS * game.combo;
      game.bonus += points;
      burst(item.x, item.y, 10, { s0: 30, s1: 110, g: 0, l0: 0.3, l1: 0.6, colors: ["#ffd86b", "#fff3c4"] });
      floatText(item.x, item.y - 10, game.combo > 1 ? `+${points} X${game.combo}` : `+${points}`, "#f2b400");
      tone(988 * (1 + (game.combo - 1) * 0.12), 0.07);
      tone(1319 * (1 + (game.combo - 1) * 0.12), 0.12, { delay: 0.07 });
      return;
    }
    if (item.kind == "shield") {
      p.shield = 8;
    } else if (item.kind == "magnet") {
      p.magnet = 6;
    } else {
      game.slowT = SLOW_TIME;
    }
    floatText(item.x, item.y - 12, { shield: "SHIELD!", magnet: "MAGNET!", slow: "SLOW-MO!" }[item.kind], "#ffffff");
    burst(item.x, item.y, 14, { s0: 40, s1: 120, g: 0, colors: ["#ffffff", POWER_COLORS[item.kind]] });
    sfx.milestone();
  }

  function updateWorld(dt) {
    game.runTime += dt;
    // Slow-mo slows the whole world - hazards, their telegraphs, the spawn
    // timers, items and scenery - while the balloon keeps full speed. (It
    // used to scale hazard motion only: warnings and spawns kept real time,
    // so slow-mo packed the sky with more hazards and nothing else looked
    // slower.) The scale eases in and out instead of snapping.
    game.slowT = Math.max(0, game.slowT - dt);
    const target = game.slowT > 0 ? SLOW_SCALE : 1;
    game.timeScale += (target - game.timeScale) * (1 - Math.exp(-SLOW_EASE * dt));
    if (Math.abs(game.timeScale - target) < 0.002) {
      game.timeScale = target;
    }
    const sf = game.timeScale;
    const wdt = dt * sf;
    game.worldClock += wdt;
    game.distance += game.speed * wdt;
    updatePlayer(dt);

    if (game.autoSpawn) {
      game.spawnIn -= wdt;
      if (game.spawnIn <= 0) {
        warn(pickKind());
        game.spawnIn = Math.max(0.5, 1.7 - game.runTime * 0.02) * rand(0.8, 1.2);
      }
      game.itemIn -= wdt;
      if (game.itemIn <= 0) {
        if (game.items.filter(i => i.kind == "sparkle").length < 4) {
          spawnItem("sparkle");
        }
        game.itemIn = rand(1, 1.8);
      }
      game.powerIn -= wdt;
      if (game.powerIn <= 0) {
        if (!game.items.some(i => i.kind != "sparkle")) {
          spawnItem(POWERS[Math.floor(Math.random() * POWERS.length)]);
        }
        game.powerIn = rand(14, 20);
      }
    }

    for (const w of game.warnings) {
      w.t += wdt;
      if (w.t >= TELEGRAPH && launch(w)) {
        w.gone = true;
      }
    }
    game.warnings = game.warnings.filter(w => !w.gone);

    for (const h of game.hazards) {
      h.t += wdt;
      if (h.kind == "zap") {
        if (h.t > 1.7) {
          h.gone = true;
        } else if (h.t >= 1 && !h.struck) {
          h.struck = true;
          game.shake = reduced() ? 0 : Math.max(game.shake, 2);
          noise(0.2, 0.06);
        }
      } else if (h.kind == "bird") {
        h.cx += h.vx * dt * sf;
        h.cy += h.vy * dt * sf;
        h.a += dt * sf * 3;
        h.x = h.cx + Math.cos(h.a) * h.R;
        h.y = h.cy + Math.sin(h.a) * h.R;
      } else {
        h.x += h.vx * dt * sf;
        h.y += h.vy * dt * sf + (h.kind == "seed" ? Math.sin(h.t * 2 + h.phase) * 8 * dt * sf : 0);
      }
      if (h.kind != "zap" && (h.x < -40 || h.x > W + 40 || h.y < -40 || h.y > H + 20) && h.t > 1) {
        h.gone = true;
      }
    }

    for (const it of game.items) {
      it.t += wdt;
      it.spin += wdt * 4;
      if (it.t > it.life) {
        it.gone = true;
      }
      if (game.player.magnet > 0 && it.kind == "sparkle") {
        const c = center();
        const d = dist(it, c);
        if (d < 150 && d > 1) {
          it.x += ((c.x - it.x) / d) * 170 * dt;
          it.y += ((c.y - it.y) / d) * 170 * dt;
        }
      }
    }

    game.score = Math.floor(game.runTime * 2) + game.bonus;
    for (const h of game.hazards) {
      if (h.gone) {
        continue;
      }
      const g = gap(h);
      if (g < 0) {
        hit(h);
        if (game.state != "running") {
          return;
        }
      } else if (g < CLOSE_PAD) {
        h.grazing = true;
      } else if (h.grazing && !h.closeCall) {
        // Skimmed past without a scratch: a close call.
        h.closeCall = true;
        const bonus = CLOSE_BONUS * (game.player.dashT > 0 || game.player.invuln > 0 ? 2 : 1);
        game.bonus += bonus;
        floatText(game.player.x, game.player.y - 46, `CLOSE! +${bonus}`, "#7fd6ff");
        tone(1175, 0.06, { vol: 0.04 });
      }
    }
    for (const it of game.items) {
      if (!it.gone && dist(it, center()) < HIT_R + 9) {
        collect(it);
      }
    }
    game.hazards = game.hazards.filter(h => !h.gone);
    game.items = game.items.filter(i => !i.gone);
    game.score = Math.floor(game.runTime * 2) + game.bonus;

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
      if (!reduced() && milestone % 5 == 0) {
        for (let i = 0; i < 9; i++) {
          game.floaters.push({ kind: "party", x: rand(W * 0.35, W - 10), y: H + rand(0, 60), vy: -rand(30, 55), hue: i % 4 });
        }
      }
    }
    if (game.score > game.best && game.best > 0 && !game.newBest) {
      game.newBest = true;
      floatText(game.player.x, game.player.y - 50, "BEST!", "#ff9b54");
    }

    // A friend drifts by now and then; shooting stars at night.
    game.friendIn -= dt;
    if (!reduced() && game.friendIn <= 0) {
      game.friendIn = rand(25, 45);
      game.floaters.push({ kind: "friend", x: W + 30, y: rand(22, 40), t: 0, said: false });
    }
    if (!reduced() && nightness(dayPhase()) > 0.8 && Math.random() < dt * 0.12) {
      game.floaters.push({ kind: "star", x: rand(W * 0.3, W), y: rand(5, 40), t: 0 });
    }

    const text = String(game.score);
    if (scoreEl.textContent != text) {
      scoreEl.textContent = text;
    }
  }

  function updateAmbient(realDt) {
    // Scenery and particles follow the world's speed (slow-mo); the
    // balloon's own blink and fall don't.
    const dt = realDt * (game.state == "running" ? game.timeScale : 1);
    const scroll = game.state == "running" ? game.speed : game.state == "ready" ? 30 : 0;
    updateSeasonAmbient(dt, scroll);
    for (const c of reduced() ? [] : game.clouds) {
      c.x -= (scroll * 0.18 + 6) * dt * c.s;
      if (c.x < -60) {
        c.x = W + 40;
        c.y = 14 + Math.random() * 44;
      }
    }
    if (reduced()) {
      game.floaters = game.floaters.filter(f => !["friend", "party", "star"].includes(f.kind));
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
    p.blinkIn -= realDt;
    if (p.blinkIn <= 0) {
      p.blink = 0.12;
      p.blinkIn = rand(2, 4.5);
    }
    p.blink = Math.max(0, p.blink - realDt);
    if (p.dead && game.state == "over") {
      p.vy += 700 * realDt;
      p.y = Math.min(GROUND, p.y + p.vy * realDt);
    }
    game.shake *= Math.exp(-10 * realDt);
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
  // Seasonal accessories on the pixel balloon, in the same 13x19 grid: a
  // leaf and a pumpkin basket, a snow cap and scarf, a flower crown, or
  // sunglasses. The basket keeps its costume when the balloon pops.
  function costumeRows(rows, face) {
    const set = (x, y, ch) => {
      rows[y] = rows[y].slice(0, x) + ch + rows[y].slice(x + 1);
    };
    if (season == "autumn") {
      for (let y = 16; y <= 18; y++) {
        for (let x = 4; x <= 8; x++) {
          set(x, y, x == 4 || x == 6 || x == 8 ? "O" : "o");
        }
      }
      set(6, 15, "g");
    }
    if (face == "dead") {
      return rows;
    }
    if (season == "autumn") {
      set(7, 0, "o");
      set(8, 0, "o");
      set(8, 1, "O");
    } else if (season == "winter") {
      for (let x = 4; x <= 8; x++) {
        set(x, 0, "W");
      }
      for (let x = 2; x <= 10; x++) {
        set(x, 1, "W");
      }
      for (const x of [2, 3, 5, 7, 9, 10]) {
        set(x, 2, "W");
      }
      for (let x = 4; x <= 8; x++) {
        set(x, 14, "s");
      }
      set(9, 15, "s");
      set(9, 16, "s");
    } else if (season == "spring") {
      for (const [x, y, ch] of [[4, 0, "f"], [5, 0, "Y"], [6, 0, "f"], [7, 0, "Y"], [8, 0, "f"], [2, 1, "f"], [10, 1, "f"]]) {
        set(x, y, ch);
      }
    } else if (season == "summer") {
      for (let x = 3; x <= 9; x++) {
        set(x, 7, "k");
      }
      for (const x of [3, 4, 5, 7, 8, 9]) {
        set(x, 8, "k");
      }
      set(4, 7, "w");
      set(8, 7, "w");
    }
    return rows;
  }
  const COSTUME_PAL = { o: "#f08a3c", O: "#b8541f", g: "#5d9b4a", W: "#ffffff", s: "#2fa3b5", f: "#ff8fbf", Y: "#ffd86b" };
  const BALLOON_PAL = { a: "#b5a0ff", b: "#f09ac8", w: "#f3edff", k: "#3a2462", r: "#7a4a2e", y: "#d9954f", p: "#ff6f9f" };
  const FRIEND_PAL = { a: "#7fd6c2", b: "#ffd86b", w: "#f2fff9", k: "#245a52", r: "#7a4a2e", y: "#d9954f", p: "#ff8fa8" };
  const PARTY_COLORS = ["#ff8fb8", "#ffd86b", "#7fd6c2", "#b5a0ff"];

  const SEED_ROWS = [
    "w..w..w",
    ".w.w.w.",
    "..www..",
    "wwwbwww",
    "..wbw..",
    "...b...",
    "...b...",
  ];
  const SEED_PAL = { w: "#ffffff", b: "#8a5a3c" };
  const BIRD_ROWS = [
    ["k.....k", ".k...k.", "..kKk..", "...Ko..", "......."],
    [".......", "...Ko..", "..kKk..", ".k...k.", "k.....k"],
  ];
  const BIRD_PAL = { k: "#5a4a8a", K: "#2a1a3e", o: "#ff9b54" };
  const POWER_ROWS = {
    shield: ["..ccc..", ".c...c.", "c.....c", "c.....c", "c.....c", ".c...c.", "..ccc.."],
    magnet: ["ww...ww", "rr...rr", "rr...rr", "rr...rr", ".rr.rr.", "..rrr..", "......."],
    slow: [".......", ".yyyyy.", "..y.y..", "...y...", "..y.y..", ".yyyyy.", "......."],
  };
  const POWER_PAL = { c: "#7fd6ff", w: "#ffffff", r: "#ff4f8b", y: "#ffd86b" };
  const POWER_COLORS = { shield: "#7fd6ff", magnet: "#ff6f9f", slow: "#ffd86b" };
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
  const BLOSSOM_ROWS = [".fff.", "ffYff", "fYYYf", "ffYff", ".fff."];
  const LEAF_ROWS = [
    "....oo.",
    "..oooo.",
    ".ooOoo.",
    ".oOoo..",
    ".Ooo...",
    "O......",
    ".......",
  ];
  const LEAF_PAL = { o: "#f08a3c", O: "#a8431f" };
  const SNOW_ROWS = [
    "b..w..b",
    ".w.w.w.",
    "..www..",
    "wwwWwww",
    "..www..",
    ".w.w.w.",
    "b..w..b",
  ];
  const SNOW_PAL = { w: "#ffffff", W: "#bfe8ff", b: "#8fc3ee" };
  const BEE_ROWS = [
    "..w.w..",
    "..www..",
    ".ykyky.",
    "ykykykk",
    ".ykyky.",
  ];
  const BEE_PAL = { w: "#f3edff", y: "#ffcf4a", k: "#3a2462" };
  // wave7/season: Halloween bats (the bird's frames and hitbox) and the
  // occasions' sparkles: a wrapped sweet, a present.
  const BAT_ROWS = [
    ["k.....k", "kkK.Kkk", ".kKKKk.", "..oKo..", "...K..."],
    [".......", "..K.K..", "kkKKKkk", "k.oKo.k", "...K..."],
  ];
  const CANDY_ROWS = ["e.....e", "eecccee", ".cscsc.", "eecccee", "e.....e"];
  const CANDY_PAL = { e: "#b5a0ff", c: "#ff9a3c", s: "#fff1d6" };
  const PRESENT_ROWS = [".Y.Y.", "rrYrr", "YYYYY", "rrYrr", "rrYrr"];
  const PRESENT_PAL = { r: "#e5485f", Y: "#ffd86b" };

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
        const a = night * (0.5 + 0.5 * Math.sin((reduced() ? 0 : game.clock * 2) + s.tw));
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
    const day = costume.ground ?? GROUND_DAY;
    const grass = mix(day.grass, "#2f5d58", night);
    const soil = mix(day.soil, "#2a2050", night);
    const dots = mix(day.dots, "#3a2d6a", night);
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
  }

  function drawFloaters(night) {
    if (reduced()) {
      game.floaters = game.floaters.filter(f => !["friend", "party", "star"].includes(f.kind));
    }
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
      const dressed = !friend && season;
      const key = `balloon-${friend ? "f" : "p"}-${face}-${dressed || ""}`;
      const rows = dressed ? costumeRows(balloonRows(face, true), face) : balloonRows(face, true);
      const img = sprite(key, rows, friend ? FRIEND_PAL : { ...BALLOON_PAL, ...COSTUME_PAL });
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
    if (!friend && season == "autumn") {
      drawPumpkinBasket();
    }
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
      const look = !friend && p.vy < -60 ? -1 : !friend && p.vy > 60 ? 0.8 : 0;
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
      if (!friend && p.dashT > 0) {
        ctx.ellipse(0, -21.8, 1.4, 1.6, 0, 0, 6.29);
        ctx.fillStyle = "#2a1a3e";
        ctx.fill();
      } else {
        ctx.arc(0, -23, 2.2, Math.PI * 0.15, Math.PI * 0.85);
        ctx.stroke();
      }
      if (!friend && season) {
        drawCostume();
      }
    }
    ctx.restore();
  }

  // Gradient accessories, in the balloon's own space (envelope centre
  // 0,-28, radius 13): small, flat and soft-shaded like the balloon.
  function drawPumpkinBasket() {
    ctx.fillStyle = "#f08a3c";
    ctx.beginPath();
    ctx.ellipse(0, -4, 6.5, 4.4, 0, 0, 6.29);
    ctx.fill();
    ctx.strokeStyle = "#b8541f";
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.ellipse(0, -4, 2.6, 4.4, 0, 0, 6.29);
    ctx.stroke();
    ctx.fillStyle = "#5d9b4a";
    ctx.fillRect(-0.6, -9.6, 1.2, 1.8);
  }
  function petals(x, y, r, color, center) {
    ctx.fillStyle = color;
    for (let k = 0; k < 5; k++) {
      const a = (k * Math.PI * 2) / 5 - Math.PI / 2;
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * r, y + Math.sin(a) * r, r * 0.75, 0, 6.29);
      ctx.fill();
    }
    ctx.fillStyle = center;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.6, 0, 6.29);
    ctx.fill();
  }
  function drawCostume() {
    if (season == "autumn") {
      // A leaf that landed on top.
      ctx.save();
      ctx.translate(4, -41);
      ctx.rotate(0.5);
      const g = ctx.createLinearGradient(0, -4, 0, 4);
      g.addColorStop(0, "#ffb347");
      g.addColorStop(1, "#d9542b");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, -4.5);
      ctx.quadraticCurveTo(4, -1, 0, 4.5);
      ctx.quadraticCurveTo(-4, -1, 0, -4.5);
      ctx.fill();
      ctx.strokeStyle = "rgba(168,67,31,0.7)";
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(0, -3.5);
      ctx.lineTo(0, 5.5);
      ctx.stroke();
      ctx.restore();
    } else if (season == "winter") {
      // Snow cap with a soft scalloped edge, and a teal scarf at the neck.
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(0, -28, 13.6, Math.PI * 1.13, Math.PI * 1.87);
      for (let k = 0; k <= 6; k++) {
        const x = 11 - k * (22 / 6);
        ctx.quadraticCurveTo(x + 1.8, -33 + (k % 2 ? 2.2 : 0), x, -34 + (k % 2 ? 0 : 1));
      }
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(127,184,230,0.35)";
      ctx.fillRect(-8, -35.2, 16, 0.8);
      ctx.fillStyle = "#2fa3b5";
      ctx.beginPath();
      ctx.roundRect(-6, -17.4, 12, 3, 1.5);
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(2.6, -15.6, 2.6, 6, 1);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.fillRect(-2.5, -17.4, 1, 3);
      ctx.fillRect(1.5, -17.4, 1, 3);
    } else if (season == "spring") {
      // A flower crown along the top of the envelope.
      ctx.strokeStyle = "#5d9b4a";
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.arc(0, -28, 12.6, Math.PI * 1.2, Math.PI * 1.8);
      ctx.stroke();
      const colors = ["#ffffff", "#ff8fbf", "#ffe08a", "#ff8fbf", "#ffffff"];
      for (let k = 0; k < 5; k++) {
        const a = Math.PI * (1.22 + k * 0.14);
        petals(Math.cos(a) * 12.6, -28 + Math.sin(a) * 12.6, 1.5, colors[k], k == 2 ? "#ff8fbf" : "#ffd86b");
      }
    } else if (season == "summer") {
      // Sunglasses over the eyes.
      ctx.fillStyle = "#2a1a3e";
      for (const ex of [-4, 4]) {
        ctx.beginPath();
        ctx.roundRect(ex - 3, -28, 6, 4, [1, 1, 2.4, 2.4]);
        ctx.fill();
      }
      ctx.strokeStyle = "#2a1a3e";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-1, -27.4);
      ctx.lineTo(1, -27.4);
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.lineWidth = 0.7;
      for (const ex of [-4, 4]) {
        ctx.beginPath();
        ctx.moveTo(ex - 1.8, -26.6);
        ctx.lineTo(ex - 0.4, -27.4);
        ctx.stroke();
      }
    }
  }

  function drawPlane(x, y, angle) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    if (retro()) {
      const pal = costume.plane ? { ...PLANE_PAL, l: costume.plane } : PLANE_PAL;
      ctx.drawImage(sprite(`plane-${costume.plane ?? ""}`, PLANE_ROWS, pal), -9 * PX, -2 * PX, 9 * PX, 5 * PX);
      ctx.restore();
      return;
    }
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#6a5f99";
    ctx.lineWidth = 0.7;
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(-9, 0);
    ctx.lineTo(9, -4);
    ctx.lineTo(4, 1);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = costume.plane ?? "#d7d0f0";
    ctx.beginPath();
    ctx.moveTo(-9, 0);
    ctx.lineTo(4, 1);
    ctx.lineTo(7, 4.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function drawSeed(h) {
    const look = costume.seed ?? "seed";
    if (look == "leaf") {
      drawLeaf(h);
      return;
    }
    if (look == "snow") {
      drawSnowflake(h);
      return;
    }
    if (look == "bee") {
      drawBee(h);
      return;
    }
    if (retro()) {
      drawSprite(sprite("seed", SEED_ROWS, SEED_PAL), h.x - 7, h.y - 7);
      return;
    }
    ctx.save();
    ctx.translate(h.x, h.y);
    ctx.rotate(Math.sin(h.t * 2 + h.phase) * 0.4);
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = 0.8;
    for (let k = 0; k < 9; k++) {
      const a = -Math.PI + (k * Math.PI) / 8;
      ctx.beginPath();
      ctx.moveTo(0, 1);
      ctx.lineTo(Math.cos(a) * 7, Math.sin(a) * 7);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(Math.cos(a) * 7, Math.sin(a) * 7, 0.9, 0, 6.29);
      ctx.fill();
    }
    ctx.fillStyle = "#8a5a3c";
    ctx.beginPath();
    ctx.ellipse(0, 4, 1.5, 3, 0, 0, 6.29);
    ctx.fill();
    ctx.restore();
  }

  // Seasonal stand-ins for the seed: the same size, path and hitbox.
  function drawLeaf(h) {
    if (retro()) {
      drawSprite(sprite("leaf", LEAF_ROWS, LEAF_PAL), h.x - 7, h.y - 7);
      return;
    }
    ctx.save();
    ctx.translate(h.x, h.y);
    ctx.rotate(Math.sin(h.t * 2 + h.phase) * 0.9);
    const g = ctx.createLinearGradient(0, -7, 0, 7);
    g.addColorStop(0, "#ffb347");
    g.addColorStop(1, "#d9542b");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.quadraticCurveTo(7, -2, 0, 7);
    ctx.quadraticCurveTo(-7, -2, 0, -7);
    ctx.fill();
    ctx.strokeStyle = "#a8431f";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(0, -5);
    ctx.lineTo(0, 9);
    ctx.moveTo(0, -1);
    ctx.lineTo(2.6, -3);
    ctx.moveTo(0, 2);
    ctx.lineTo(-2.6, 0);
    ctx.stroke();
    ctx.restore();
  }
  function drawSnowflake(h) {
    if (retro()) {
      drawSprite(sprite("snow", SNOW_ROWS, SNOW_PAL), h.x - 7, h.y - 7);
      return;
    }
    ctx.save();
    ctx.translate(h.x, h.y);
    ctx.rotate(h.t * 0.6 + h.phase);
    ctx.shadowColor = "#5f9fd6";
    ctx.shadowBlur = 3;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.2;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3;
      const c = Math.cos(a);
      const s = Math.sin(a);
      ctx.moveTo(0, 0);
      ctx.lineTo(c * 7, s * 7);
      for (const side of [-1, 1]) {
        ctx.moveTo(c * 4.2, s * 4.2);
        ctx.lineTo(c * 4.2 + Math.cos(a + side * 0.8) * 2.4, s * 4.2 + Math.sin(a + side * 0.8) * 2.4);
      }
    }
    ctx.stroke();
    ctx.restore();
  }
  function drawBee(h) {
    if (retro()) {
      drawSprite(sprite("bee", BEE_ROWS, BEE_PAL), h.x - 7, h.y - 5);
      return;
    }
    const flap = reduced() ? 0 : Math.sin(game.worldClock * 30) * 0.35;
    ctx.save();
    ctx.translate(h.x, h.y);
    ctx.rotate(Math.sin(h.t * 2 + h.phase) * 0.25);
    ctx.fillStyle = "rgba(243,237,255,0.85)";
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(side * 2.2, -4, 2.2, 3.4, side * (0.5 + flap), 0, 6.29);
      ctx.fill();
    }
    const body = new Path2D();
    body.ellipse(0, 0, 6, 4.2, 0, 0, 6.29);
    ctx.fillStyle = "#ffcf4a";
    ctx.fill(body);
    ctx.save();
    ctx.clip(body);
    ctx.fillStyle = "#3a2462";
    ctx.fillRect(-2.6, -5, 1.8, 10);
    ctx.fillRect(1, -5, 1.8, 10);
    ctx.restore();
    ctx.fillStyle = "#3a2462";
    ctx.beginPath();
    ctx.arc(-4, -0.8, 0.8, 0, 6.29);
    ctx.fill();
    ctx.restore();
  }

  function drawBird(h) {
    const flap = Math.floor(game.worldClock * 8) % 2;
    if (retro()) {
      drawSprite(sprite(`bird${flap}-${look ?? ""}`, (costume.bat ? BAT_ROWS : BIRD_ROWS)[flap], costume.bird ?? BIRD_PAL), h.x - 7, h.y - 5);
      return;
    }
    const pal = costume.bird ?? BIRD_PAL;
    if (costume.bat) {
      drawBat(h, flap, pal);
      return;
    }
    const w = flap ? -4 : 3;
    ctx.strokeStyle = pal.k;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(h.x - 8, h.y + w);
    ctx.quadraticCurveTo(h.x - 3, h.y - 2, h.x, h.y);
    ctx.quadraticCurveTo(h.x + 3, h.y - 2, h.x + 8, h.y + w);
    ctx.stroke();
    ctx.fillStyle = pal.K;
    ctx.beginPath();
    ctx.ellipse(h.x, h.y + 1, 3.5, 2.6, 0, 0, 6.29);
    ctx.fill();
    ctx.fillStyle = pal.o;
    ctx.beginPath();
    ctx.moveTo(h.x + (h.vx < 0 ? -3 : 3), h.y);
    ctx.lineTo(h.x + (h.vx < 0 ? -6 : 6), h.y + 1);
    ctx.lineTo(h.x + (h.vx < 0 ? -3 : 3), h.y + 2);
    ctx.fill();
  }

  // Halloween's bird: a small round bat with scalloped wings, the same
  // size, path and hitbox.
  function drawBat(h, flap, pal) {
    const lift = flap ? -3 : 2;
    ctx.fillStyle = pal.k;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(h.x + dir * 2, h.y - 1);
      ctx.quadraticCurveTo(h.x + dir * 6, h.y - 4 + lift, h.x + dir * 9, h.y - 2 + lift);
      ctx.quadraticCurveTo(h.x + dir * 7.5, h.y + 1 + lift * 0.5, h.x + dir * 6, h.y + 1);
      ctx.quadraticCurveTo(h.x + dir * 4.5, h.y + 2, h.x + dir * 3, h.y + 1);
      ctx.quadraticCurveTo(h.x + dir * 2.5, h.y + 2.5, h.x + dir * 1.5, h.y + 2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = pal.K;
    ctx.beginPath();
    ctx.ellipse(h.x, h.y + 0.5, 3, 3.2, 0, 0, 6.29);
    ctx.moveTo(h.x - 2.6, h.y - 1.6);
    ctx.lineTo(h.x - 1.8, h.y - 4.4);
    ctx.lineTo(h.x - 0.6, h.y - 2.4);
    ctx.moveTo(h.x + 2.6, h.y - 1.6);
    ctx.lineTo(h.x + 1.8, h.y - 4.4);
    ctx.lineTo(h.x + 0.6, h.y - 2.4);
    ctx.fill();
    ctx.fillStyle = pal.o;
    ctx.fillRect(h.x - 1.6, h.y - 0.4, 1.1, 1.1);
    ctx.fillRect(h.x + 0.5, h.y - 0.4, 1.1, 1.1);
  }

  // The occasions' sparkle: a wrapped sweet at Halloween, a present over
  // the winter holidays. Same spot, glow and pickup radius as the sparkle.
  function drawTreat(it, bob) {
    if (retro()) {
      const [rows, pal, w] = costume.candy ? [CANDY_ROWS, CANDY_PAL, 7] : [PRESENT_ROWS, PRESENT_PAL, 5];
      drawSprite(sprite(costume.candy ? "candy" : "present", rows, pal), it.x - w, it.y - 5 + snap(bob));
      return;
    }
    ctx.save();
    ctx.translate(it.x, it.y + bob);
    ctx.rotate(Math.sin(it.spin * 0.6) * 0.2);
    ctx.shadowColor = costume.sparkle.y;
    ctx.shadowBlur = 10;
    if (costume.candy) {
      ctx.fillStyle = CANDY_PAL.e;
      for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(dir * 4, 0);
        ctx.lineTo(dir * 8.5, -3.6);
        ctx.quadraticCurveTo(dir * 7.4, 0, dir * 8.5, 3.6);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = CANDY_PAL.c;
      ctx.beginPath();
      ctx.ellipse(0, 0, 5, 3.8, 0, 0, 6.29);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = CANDY_PAL.s;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(-2.4, -3.2);
      ctx.quadraticCurveTo(-0.6, 0, -2.4, 3.2);
      ctx.moveTo(1.4, -3.4);
      ctx.quadraticCurveTo(3.2, 0, 1.4, 3.4);
      ctx.stroke();
    } else {
      ctx.fillStyle = PRESENT_PAL.r;
      ctx.beginPath();
      ctx.roundRect(-5, -3.5, 10, 9, 1.6);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = PRESENT_PAL.Y;
      ctx.fillRect(-1, -3.5, 2, 9);
      ctx.fillRect(-5, 0, 10, 1.8);
      ctx.strokeStyle = PRESENT_PAL.Y;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.ellipse(-2.4, -5, 2.4, 1.5, -0.4, 0, 6.29);
      ctx.moveTo(4.8, -5);
      ctx.ellipse(2.4, -5, 2.4, 1.5, 0.4, 0, 6.29);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Seasonal weather behind the hills: tiny, pale and slow, so it never
  // reads as a hazard (the winter snowflake hazard is many times larger).
  // None under reduced motion.
  const AMBIENT_COLORS = {
    snow: ["#ffffff"],
    petals: ["#ffc2dc", "#fff2c4", "#ffffff"],
    leaves: ["#f0a052", "#e0703c", "#e6b85e"],
  };
  // Its own seeded generator, so the weather never shifts the random
  // sequence the hazards and sparkles are drawn from.
  const ambientRandom = seeded(2026);
  const arand = (lo, hi) => lo + ambientRandom() * (hi - lo);
  function updateSeasonAmbient(dt, scroll) {
    if (reduced() || !costume.ambient) {
      game.ambient = [];
      return;
    }
    const kind = costume.ambient;
    const want = kind == "snow" ? 26 : 12;
    while (game.ambient.length < want) {
      const colors = AMBIENT_COLORS[kind];
      game.ambient.push({
        x: arand(0, W + 40),
        y: game.ambient.length < want / 2 && !game.ambientSeeded ? arand(0, GROUND - 30) : arand(-20, -4),
        r: kind == "snow" ? arand(0.8, 1.7) : arand(1.2, 2),
        vy: kind == "snow" ? arand(9, 18) : arand(7, 13),
        sway: arand(0, 6.28),
        color: colors[Math.floor(arand(0, colors.length))],
      });
    }
    game.ambientSeeded = true;
    for (const a of game.ambient) {
      a.sway += dt * 1.3;
      a.y += a.vy * dt;
      a.x += (Math.sin(a.sway) * 6 - scroll * 0.08 - 4) * dt;
    }
    game.ambient = game.ambient.filter(a => a.y < GROUND - 10 && a.x > -10);
  }

  function drawSeasonAmbient(night) {
    if (!game.ambient.length) {
      return;
    }
    ctx.save();
    ctx.globalAlpha = 0.7 - night * 0.3;
    for (const a of game.ambient) {
      ctx.fillStyle = a.color;
      if (retro()) {
        ctx.fillRect(snap(a.x), snap(a.y), PX, PX);
      } else if (costume.ambient == "snow") {
        ctx.beginPath();
        ctx.arc(a.x, a.y, a.r, 0, 6.29);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.ellipse(a.x, a.y, a.r * 1.4, a.r * 0.8, a.sway, 0, 6.29);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // A grumpy cloud gathers for a second (the telegraph), then strikes.
  function drawZap(h) {
    const gather = clamp(h.t, 0, 1);
    const striking = h.t >= 1 && h.t < 1.35;
    const cloud = mix("#cfc8e8", "#4b4466", gather);
    if (retro()) {
      ctx.fillStyle = cloud;
      ctx.fillRect(snap(h.x - 16), 12, 32, 8);
      ctx.fillRect(snap(h.x - 10), 6, 20, 6);
      if (!striking && Math.floor(game.worldClock * 6) % 2 && gather > 0.4) {
        ctx.fillStyle = "#ffd86b";
        ctx.fillRect(snap(h.x - 1), 22, PX, PX * 2);
      }
      if (striking) {
        ctx.fillStyle = "#ffe36b";
        for (let y = 20, i = 0; y < GROUND; y += 8, i++) {
          ctx.fillRect(snap(h.x + (i % 2 ? 2 : -2)) - PX, y, PX * 2, 8);
        }
      }
      return;
    }
    ctx.save();
    ctx.globalAlpha = 0.4 + gather * 0.6;
    ctx.fillStyle = cloud;
    ctx.beginPath();
    ctx.ellipse(h.x, 16, 18, 7, 0, 0, 6.29);
    ctx.arc(h.x - 7, 11, 7, 0, 6.29);
    ctx.arc(h.x + 6, 9, 8, 0, 6.29);
    ctx.fill();
    // Brows: it's grumpy.
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(h.x - 7, 13);
    ctx.lineTo(h.x - 3, 15);
    ctx.moveTo(h.x + 7, 13);
    ctx.lineTo(h.x + 3, 15);
    ctx.stroke();
    ctx.restore();
    if (!striking && gather > 0.5) {
      ctx.fillStyle = `rgba(255,216,107,${((gather - 0.5) * 1.2).toFixed(2)})`;
      ctx.fillRect(h.x - 1, 24, 2, GROUND - 24);
    }
    if (striking) {
      const r = seeded(Math.floor(h.seed + game.worldClock * 20));
      ctx.save();
      ctx.shadowColor = "#ffe36b";
      ctx.shadowBlur = 10;
      ctx.strokeStyle = "#ffe36b";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(h.x, 22);
      for (let y = 30; y <= GROUND; y += 10) {
        ctx.lineTo(h.x + (r() - 0.5) * 8, y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  // Edge telegraph: a pulsing arrow where a hazard is about to come in.
  function drawWarning(w) {
    const x = clamp(w.x, 10, W - 10);
    const y = clamp(w.y, 10, GROUND - 10);
    const on = Math.floor(w.t * 8) % 2 == 0;
    if (retro()) {
      if (on) {
        pixelTextCentered("!", x, y - 5, "#ffd86b", 1);
      }
      return;
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.atan2(w.dy, w.dx));
    ctx.globalAlpha = on ? 1 : 0.5;
    ctx.fillStyle = "#ff4f8b";
    ctx.beginPath();
    ctx.moveTo(7, 0);
    ctx.lineTo(-4, -6);
    ctx.lineTo(-4, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawItem(it) {
    const fading = it.life - it.t < 1.5 && Math.floor(it.t * 8) % 2;
    if (fading) {
      return;
    }
    const bob = Math.sin(game.clock * 4 + it.x * 0.05) * 2;
    if (it.kind == "sparkle" && (costume.candy || costume.present)) {
      drawTreat(it, bob);
      return;
    }
    if (it.kind == "sparkle") {
      if (retro()) {
        const frame = Math.floor(game.clock * 4) % 2;
        const pal = costume.sparkle ?? SPARKLE_PAL;
        const rows = costume.blossom ? BLOSSOM_ROWS : SPARKLE_ROWS[frame];
        const key = costume.blossom ? `blossom-${look}` : `sparkle${frame}-${look ?? ""}`;
        drawSprite(sprite(key, rows, { ...pal, f: pal.y, Y: pal.W }), it.x - 5, it.y - 5 + snap(bob));
        return;
      }
      ctx.save();
      ctx.translate(it.x, it.y + bob);
      ctx.rotate(it.spin * 0.3);
      const glow = costume.sparkle?.y ?? "#ffd86b";
      ctx.shadowColor = glow;
      ctx.shadowBlur = 10;
      if (costume.blossom) {
        petals(0, 0, 3.4, glow, costume.sparkle.W);
        ctx.restore();
        return;
      }
      ctx.fillStyle = glow;
      ctx.beginPath();
      for (let k = 0; k < 8; k++) {
        const r = k % 2 ? 2.4 : 7;
        const a = (k * Math.PI) / 4;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      return;
    }
    const color = POWER_COLORS[it.kind];
    if (retro()) {
      ctx.fillStyle = "#2a1a3e";
      pixelDisc(it.x, it.y + bob, 10);
      drawSprite(sprite(`power-${it.kind}`, POWER_ROWS[it.kind], POWER_PAL), it.x - 7, it.y - 7 + snap(bob));
      return;
    }
    ctx.save();
    ctx.translate(it.x, it.y + bob);
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    ctx.fillStyle = "rgba(42,26,62,0.85)";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 9, 0, 6.29);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    if (it.kind == "shield") {
      ctx.arc(0, 0, 4.5, 0, 6.29);
    } else if (it.kind == "magnet") {
      ctx.moveTo(-3.5, -4);
      ctx.lineTo(-3.5, 0);
      ctx.arc(0, 0, 3.5, Math.PI, 0, true);
      ctx.lineTo(3.5, -4);
    } else {
      ctx.moveTo(-3.5, -4.5);
      ctx.lineTo(3.5, -4.5);
      ctx.lineTo(-3.5, 4.5);
      ctx.lineTo(3.5, 4.5);
      ctx.closePath();
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawObstacles() {
    for (const it of game.items) {
      drawItem(it);
    }
    for (const w of game.warnings) {
      drawWarning(w);
    }
    for (const h of game.hazards) {
      if (h.kind == "seed") {
        drawSeed(h);
      } else if (h.kind == "plane") {
        drawPlane(h.x, h.y, Math.atan2(h.vy, h.vx) - Math.PI);
      } else if (h.kind == "bird") {
        drawBird(h);
      } else if (h.kind == "zap") {
        drawZap(h);
      }
    }
  }

  // Shield bubble, magnet ring and the dash trail around the balloon.
  function drawPlayer(bob) {
    const p = game.player;
    for (const [i, q] of p.trail.entries()) {
      if (i % 2 == 0 && !retro()) {
        drawBalloon(q.x, q.y, 1, 1, { alpha: 0.18 - i * 0.025 });
      }
    }
    const flicker = p.invuln > 0 && !p.dead && game.state == "running" && Math.floor(game.clock * 20) % 2;
    if (game.state != "over" || p.y < H + 50) {
      drawBalloon(p.x, p.y + bob, p.sx, p.sy, { dead: p.dead, flame: p.flame > 0, alpha: flicker ? 0.45 : 1 });
    }
    const cx = p.x;
    const cy = p.y - 20;
    if (p.shield > 0 && (p.shield > 1.5 || Math.floor(game.clock * 8) % 2)) {
      if (retro()) {
        ctx.strokeStyle = "#7fd6ff";
        ctx.lineWidth = PX;
        ctx.strokeRect(snap(cx - 22), snap(cy - 22), 44, 44);
      } else {
        ctx.fillStyle = "rgba(127,214,255,0.14)";
        ctx.strokeStyle = "rgba(127,214,255,0.8)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, 24, 0, 6.29);
        ctx.fill();
        ctx.stroke();
      }
    }
    if (p.magnet > 0 && !retro()) {
      ctx.strokeStyle = `rgba(255,111,159,${(0.25 + 0.2 * Math.sin(game.clock * 6)).toFixed(2)})`;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.arc(cx, cy, 34 + Math.sin(game.clock * 4) * 3, 0, 6.29);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function drawCombo() {
    if (game.state != "running" || game.combo < 2 || game.clock - game.comboAt > COMBO_WINDOW) {
      return;
    }
    const left = 1 - (game.clock - game.comboAt) / COMBO_WINDOW;
    if (retro()) {
      pixelText(`X${game.combo}`, 8, 8, "#ffd86b", 2);
      ctx.fillStyle = "#ffd86b";
      ctx.fillRect(8, 24, snap(30 * left), PX);
      return;
    }
    ctx.save();
    ctx.font = "900 14px system-ui, sans-serif";
    ctx.fillStyle = "#ffd86b";
    ctx.strokeStyle = "rgba(42,26,62,0.6)";
    ctx.lineWidth = 3;
    ctx.strokeText(`×${game.combo}`, 10, 20);
    ctx.fillText(`×${game.combo}`, 10, 20);
    ctx.fillRect(10, 25, 30 * left, 2);
    ctx.restore();
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
      pixelTextCentered(pixelStrings[deathId(game.deathKind)] || pixelStrings[game.deathKind] || "", mid, 58, "#ffffff", 1);
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
    drawSeasonAmbient(night);
    drawClouds(night);
    drawFloaters(night);
    drawHills(sky);
    drawGround(night);
    drawObstacles();

    const bob = game.state == "ready" && !reduced() ? Math.sin(game.clock * 3) * 1.5 : 0;
    drawPlayer(bob);
    drawParticles();
    drawCombo();
    // Slow-mo: a cool wash that fades with the time scale, and a bar
    // along the top that drains as it runs out (both looks).
    const slow = (1 - game.timeScale) / (1 - SLOW_SCALE);
    if (slow > 0 && game.state == "running") {
      if (!retro()) {
        ctx.fillStyle = `rgba(127,214,255,${(0.16 * slow).toFixed(3)})`;
        ctx.fillRect(0, 0, W, H);
      }
      const left = snap((W - 16) * Math.min(1, game.slowT / SLOW_TIME));
      ctx.fillStyle = "rgba(29,19,64,0.35)";
      ctx.fillRect(8, 2, W - 16, PX * 2);
      ctx.fillStyle = POWER_COLORS.slow;
      ctx.fillRect(8, 2, left, PX * 2);
    }

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
      prefs.set(STYLE_PREF, game.style);
    } catch (e) {}
  }
  function setSound(on) {
    game.sound = on;
    soundBtn.setAttribute("aria-pressed", String(on));
    try {
      prefs.set(SOUND_PREF, on);
    } catch (e) {}
    if (on) {
      sfx.sparkle();
    }
  }

  retroBtn.addEventListener("click", () => setStyle("retro"));
  gradientBtn.addEventListener("click", () => setStyle("gradient"));
  soundBtn.addEventListener("click", () => setSound(!game.sound));
  playAgainBtn.addEventListener("click", () => press());

  const DIR_KEYS = {
    ArrowLeft: [-1, 0], a: [-1, 0], A: [-1, 0],
    ArrowRight: [1, 0], d: [1, 0], D: [1, 0],
    ArrowUp: [0, -1], w: [0, -1], W: [0, -1],
    ArrowDown: [0, 1], s: [0, 1], S: [0, 1],
  };
  const held = new Set();
  function setInput(x, y) {
    const len = Math.hypot(x, y) || 1;
    game.input = { x: x / len, y: y / len };
    if (x || y) {
      game.pointer = null;
    }
  }
  function syncHeld() {
    let x = 0;
    let y = 0;
    for (const key of held) {
      x += DIR_KEYS[key][0];
      y += DIR_KEYS[key][1];
    }
    setInput(clamp(x, -1, 1), clamp(y, -1, 1));
  }
  window.addEventListener("keydown", event => {
    // Browser shortcuts (Cmd+W, Cmd+T, Ctrl+Tab...) are never the game's:
    // "w" is a steering key, and swallowing Cmd+W left the tab unclosable.
    if (event.metaKey || event.ctrlKey || event.altKey || !shown()) {
      return;
    }
    if (embedded && event.key == "Escape") {
      showEmbedded(false);
      return;
    }
    if (event.target.closest?.("button") && (event.key == " " || event.key == "Enter")) {
      return;
    }
    if (DIR_KEYS[event.key]) {
      event.preventDefault();
      held.add(event.key);
      syncHeld();
      if (game.state == "ready") {
        start();
      }
    } else if (event.key == " ") {
      event.preventDefault();
      if (!event.repeat) {
        press();
      }
    } else if (event.key == "p" || event.key == "P" || (event.key == "Escape" && game.state == "running")) {
      setPaused(game.state == "running");
    }
  });
  window.addEventListener("keyup", event => {
    if (held.has(event.key)) {
      held.delete(event.key);
      syncHeld();
    } else if (event.key == " " && shown()) {
      event.preventDefault();
    }
  });

  // Embedded in the offline error page the game fills the page while it's
  // played, like Chrome's dino: the error text and buttons step aside. Esc
  // (or a reload) brings the error page and Try Again back, paused; the
  // error page's own key/tap (WhimsyNetErrorChild) shows the game again.
  function shown() {
    return !embedded || document.body.classList.contains("whimsy-game-embedded");
  }
  function showEmbedded(on) {
    document.body.classList.toggle("whimsy-game-embedded", on);
    document.querySelector("net-error-card")?.shadowRoot
      ?.querySelector(".felt-privacy-container")?.classList.toggle("whimsy-game-embedded", on);
    held.clear();
    syncHeld();
    if (on) {
      if (game.state == "paused") {
        setPaused(false);
      } else if (game.state == "ready") {
        start();
      }
      resize();
    } else {
      setPaused(true);
      document.activeElement?.blur?.();
    }
  }
  if (embedded) {
    document.addEventListener("WhimsyGame:Show", () => showEmbedded(true));
    document.l10n.setAttributes($("whimsy-game-hint"), "whimsy-game-hint-embedded");
    if (onlineNotice) {
      onlineNotice.addEventListener("pointerdown", event => {
        event.stopPropagation();
      });
      window.addEventListener("online", () => {
        onlineNotice.hidden = false;
      });
      window.addEventListener("offline", () => {
        onlineNotice.hidden = true;
      });
      reloadBtn?.addEventListener("click", event => {
        event.stopPropagation();
        window.location.reload();
      });
      onlineNotice.addEventListener("click", () => {
        window.location.reload();
      });
    }
  } else {
    // When opened for fun (whimsy://game), never show the back-online notice.
    onlineNotice?.remove();
  }
  function toWorld(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * W,
      y: ((event.clientY - rect.top) / rect.height) * H,
    };
  }
  stage.addEventListener("pointermove", event => {
    if (game.state == "running" && !game.input.x && !game.input.y) {
      game.pointer = toWorld(event);
    }
  });
  stage.addEventListener("pointerleave", () => {
    game.pointer = null;
  });
  stage.addEventListener("pointerdown", event => {
    if (event.button != 0 || event.target.closest("button")) {
      return;
    }
    event.preventDefault();
    if (game.state == "running") {
      game.pointer = toWorld(event);
    }
    press();
  });
  window.addEventListener("blur", () => {
    held.clear();
    syncHeld();
  });
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
    game.best = prefs.get(HIGH_SCORE_PREF, 0);
    game.sound = prefs.get(SOUND_PREF, false);
    applyStyle(prefs.get(STYLE_PREF, "gradient"));
  } catch (e) {
    applyStyle("gradient");
  }
  bestEl.textContent = String(game.best);
  soundBtn.setAttribute("aria-pressed", String(game.sound));
  setState("ready");
  if (host?.autostart) {
    start();
  }

  document.l10n
    .formatValues([
      "whimsy-game-title",
      "whimsy-game-start-short",
      "whimsy-game-paused",
      "whimsy-game-over-title",
      "whimsy-game-death-seed",
      "whimsy-game-death-plane",
      "whimsy-game-death-zap",
      "whimsy-game-death-bird",
      "whimsy-game-new-best",
      "whimsy-game-retry-hint",
      "whimsy-game-death-seed-autumn",
      "whimsy-game-death-seed-winter",
      "whimsy-game-death-seed-spring",
      "whimsy-game-death-bird-halloween",
    ])
    .then(([title, start, paused, over, seed, plane, zap, bird, best, again, autumn, winter, spring, bat]) => {
      Object.assign(pixelStrings, { title, start, paused, over, seed, plane, zap, bird, best, again });
      Object.assign(pixelStrings, {
        "whimsy-game-death-seed-autumn": autumn,
        "whimsy-game-death-seed-winter": winter,
        "whimsy-game-death-seed-spring": spring,
        "whimsy-game-death-bird-halloween": bat,
      });
    })
    .catch(() => {});

  requestAnimationFrame(frame);

  // Test hooks (mochitests drive the simulation deterministically).
  window.__whimsyGame = {
    get state() {
      return game;
    },
    get onlineNotice() {
      return onlineNotice;
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
      game.hazards = [];
      game.warnings = [];
      game.items = [];
    },
    // A hazard (seed, plane, bird, zap) or item (sparkle, shield, magnet,
    // slow), by default right on the balloon.
    spawn(kind, props = {}) {
      const c = center();
      if (kind in HAZARDS) {
        const h = kind == "zap"
          ? { kind, x: c.x, t: 1, seed: 1 }
          : { kind, x: c.x, y: c.y, vx: 0, vy: 0, r: HAZARDS[kind].r, t: 0, phase: 0, cx: c.x, cy: c.y, a: 0, R: 0 };
        Object.assign(h, props);
        game.hazards.push(h);
        return h;
      }
      const it = { kind, x: c.x, y: c.y, t: 0, life: 8, spin: 0, ...props };
      game.items.push(it);
      return it;
    },
    warn,
    dash,
    setInput,
    pointer(x, y) {
      game.pointer = x === null ? null : { x, y };
    },
    render,
    get season() {
      return season;
    },
    // The season or an occasion within it (halloween, holidays).
    get look() {
      return look;
    },
    // Dress the game for a season (null: no costume) without a date mock.
    setSeason(id) {
      setSeason(id);
      render();
    },
    constants: { W, H, GROUND, HIT_R, SAFE_SPAWN, TELEGRAPH, CLOSE_PAD, CLOSE_BONUS, SPARKLE_POINTS, COMBO_WINDOW, DASH_COOLDOWN, RETRY_DELAY },
  };
})();
