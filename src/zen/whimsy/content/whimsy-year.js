/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Year in tabs (whimsy://year): an on-device recap told like Spotify
// Wrapped - a story of full-bleed slides, one at a time. Each slide sets
// up a stat with a teaser line, builds it with a count-up (or a slot-
// machine spin, a clock sweep, a filling ring), lands it, then adds a
// punchline. Click, Space or the arrow keys move on (a press mid-reveal
// finishes the reveal first); Auto-play is optional. A finale card sums
// it all up and can be copied as an image.
//
// The stats come from this profile's own Places history and Whimsy's local
// tab counter (WhimsyStats.sys.mjs); nothing leaves the device.
//
// Loaded with the system principal (about:whimsy, see WhimsyAboutPage.sys.mjs),
// so it can query Places and read Whimsy's own modules directly.

"use strict";

(async () => {
  const FEATURE_PREF = "whimsy.feature.year-in-tabs";
  const AUTO_KEY = "whimsy-year-auto";
  const AUTO_HOLD_MS = 3400;
  const root = document.getElementById("whimsy-year-root");

  if (!Services.prefs.getBoolPref(FEATURE_PREF, true)) {
    root.textContent = "";
    const off = document.createElement("p");
    off.id = "whimsy-year-off";
    off.style.color = "#fff";
    off.style.margin = "auto";
    off.style.fontFamily = "system-ui, sans-serif";
    off.textContent = "Year in tabs is turned off (whimsy.feature.year-in-tabs).";
    root.append(off);
    return;
  }

  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
  const { WhimsyStats } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyStats.sys.mjs");

  const $ = id => document.getElementById(id);
  const deck = $("whimsy-year-deck");
  const emptyEl = $("whimsy-year-empty");
  const cardsEl = $("whimsy-year-cards");
  const dotsEl = $("whimsy-year-dots");
  const statusEl = $("whimsy-year-status");
  const prevBtn = $("whimsy-year-prev");
  const nextBtn = $("whimsy-year-next");
  const autoBtn = $("whimsy-year-auto");
  const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const reduced = () => reducedQuery.matches;
  const locale = Services.locale.appLocaleAsBCP47;
  const formatCount = new Intl.NumberFormat(locale).format;
  const formatDecimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format;

  // One bold palette per slide.
  const THEMES = {
    intro: { bg: "#6c3cf0", ink: "#ffffff", accent: "#ffd86b", accent2: "#ff8fc7" },
    opened: { bg: "#ff4f8b", ink: "#2a0614", accent: "#fff2a8", accent2: "#ffb3cd" },
    topsites: { bg: "#ffd23f", ink: "#2b1a00", accent: "#ff4f8b", accent2: "#fff4c2" },
    busiest: { bg: "#00b894", ink: "#00261d", accent: "#e8fff7", accent2: "#7dffd9" },
    space: { bg: "#3d5afe", ink: "#ffffff", accent: "#9cffe0", accent2: "#8f9dff" },
    longest: { bg: "#ff7a1a", ink: "#2a1000", accent: "#fff1e0", accent2: "#ffb070" },
    nightowl: { bg: "#140c3c", ink: "#f4e9ff", accent: "#ffd86b", accent2: "#3d2a8a" },
    finale: { bg: "#1d1033", ink: "#ffffff", accent: "#ffd86b", accent2: "#b5a0ff" },
  };
  const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  function hourLabel(h) {
    const hour12 = h % 12 == 0 ? 12 : h % 12;
    return `${hour12}${h < 12 ? "am" : "pm"}`;
  }

  function hostFromUrl(url) {
    try {
      return new URL(url).host || url;
    } catch (e) {
      return url;
    }
  }
  const prettyHost = host => String(host || "").replace(/^www\./, "");

  // This calendar year's visits, straight from Places - nothing cached,
  // nothing sent anywhere.
  async function queryYearData() {
    const year = new Date().getFullYear();
    const yearStart = new Date(year, 0, 1).getTime() * 1000; // PRTime (us)
    const yearEnd = new Date(year + 1, 0, 1).getTime() * 1000;
    const db = await PlacesUtils.promiseDBConnection();
    const params = { yearStart, yearEnd };

    const topSitesRows = await db.executeCached(
      `SELECT o.host AS host, COUNT(*) AS cnt
       FROM moz_historyvisits v
       JOIN moz_places p ON p.id = v.place_id
       JOIN moz_origins o ON o.id = p.origin_id
       WHERE v.visit_date >= :yearStart AND v.visit_date < :yearEnd
         AND p.hidden = 0 AND o.host != ''
       GROUP BY o.host ORDER BY cnt DESC LIMIT 5`,
      params
    );
    const busiestRows = await db.executeCached(
      `SELECT CAST(strftime('%w', datetime(v.visit_date/1000000,'unixepoch','localtime')) AS INTEGER) AS dow,
              CAST(strftime('%H', datetime(v.visit_date/1000000,'unixepoch','localtime')) AS INTEGER) AS hr,
              COUNT(*) AS cnt
       FROM moz_historyvisits v
       WHERE v.visit_date >= :yearStart AND v.visit_date < :yearEnd
       GROUP BY dow, hr ORDER BY cnt DESC LIMIT 1`,
      params
    );
    const nightRows = await db.executeCached(
      `SELECT
         SUM(CASE WHEN CAST(strftime('%H', datetime(v.visit_date/1000000,'unixepoch','localtime')) AS INTEGER) >= 22
                   OR CAST(strftime('%H', datetime(v.visit_date/1000000,'unixepoch','localtime')) AS INTEGER) < 4
              THEN 1 ELSE 0 END) AS night,
         COUNT(*) AS total
       FROM moz_historyvisits v
       WHERE v.visit_date >= :yearStart AND v.visit_date < :yearEnd`,
      params
    );

    return {
      // A year is a label, never a number to format ("2026", not "2,026").
      year: String(year),
      topSites: topSitesRows.map(r => ({
        host: prettyHost(r.getResultByName("host")),
        count: r.getResultByName("cnt"),
      })),
      busiest: busiestRows.length
        ? { day: busiestRows[0].getResultByName("dow"), hour: busiestRows[0].getResultByName("hr") }
        : null,
      night: nightRows.length
        ? { night: nightRows[0].getResultByName("night") || 0, total: nightRows[0].getResultByName("total") || 0 }
        : { night: 0, total: 0 },
    };
  }

  // -------------------------------------------------------------------
  // Building blocks

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }
  function l10n(tag, className, id, args) {
    const node = el(tag, className);
    document.l10n.setAttributes(node, id, args);
    return node;
  }
  function svg(tag, attrs = {}) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) {
      node.setAttribute(k, v);
    }
    return node;
  }
  const show = (...nodes) => nodes.forEach(n => n?.classList.add("is-shown"));

  // A slide: theme, decorations, and a list of beats run in order.
  function makeSlide(kind) {
    const theme = THEMES[kind];
    const node = el("section", "whimsy-year-slide");
    node.dataset.kind = kind;
    node.style.setProperty("--bg", theme.bg);
    node.style.setProperty("--ink", theme.ink);
    node.style.setProperty("--accent", theme.accent);
    node.style.setProperty("--accent2", theme.accent2);
    const deco = el("div", "whimsy-year-deco");
    deco.setAttribute("aria-hidden", "true");
    deco.append(el("span", "whimsy-year-blob whimsy-year-blob-a"), el("span", "whimsy-year-blob whimsy-year-blob-b"));
    const inner = el("div", "whimsy-year-inner");
    node.append(deco, inner);
    return { kind, el: node, deco, inner, beats: [], finishers: [], done: false, seen: false };
  }
  function beat(slide, delay, run) {
    slide.beats.push({ delay, run });
  }
  function reveal(slide, node) {
    node.dataset.reveal = "";
    slide.inner.append(node);
    return node;
  }

  // Count from 0 to `target`, easing out, then "land" with a little pop.
  function countUp(slide, node, target, format, duration, fast) {
    const land = () => {
      node.textContent = format(target);
      node.classList.add("is-landed");
    };
    if (fast || reduced()) {
      land();
      return 0;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = now => {
      const t = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      node.textContent = format(target * eased);
      if (t < 1) {
        raf = requestAnimationFrame(step);
      } else {
        land();
      }
    };
    raf = requestAnimationFrame(step);
    slide.finishers.push(() => {
      cancelAnimationFrame(raf);
      land();
    });
    return duration;
  }

  // Spin through names like a slot machine, slowing down onto the winner.
  function slotSpin(slide, node, names, winner, fast) {
    const land = () => {
      node.textContent = winner;
      node.classList.add("is-landed");
    };
    if (fast || reduced() || names.length < 2) {
      land();
      return 0;
    }
    const timers = [];
    let t = 0;
    for (let i = 0; i < 14; i++) {
      t += 40 + i * i * 2.2;
      timers.push(setTimeout(() => {
        node.textContent = names[i % names.length];
      }, t));
    }
    timers.push(setTimeout(land, t + 160));
    slide.finishers.push(() => {
      timers.forEach(clearTimeout);
      land();
    });
    return t + 160;
  }

  // -------------------------------------------------------------------
  // Slides

  function introSlide(year) {
    const s = makeSlide("intro");
    const kicker = reveal(s, l10n("p", "whimsy-year-kicker", "whimsy-year-intro-kicker"));
    const hero = reveal(s, el("div", "whimsy-year-hero whimsy-year-odometer"));
    hero.setAttribute("aria-label", year);
    [...year].forEach((digit, i) => {
      const d = el("span", "whimsy-year-digit", digit);
      d.style.setProperty("--i", i);
      d.setAttribute("aria-hidden", "true");
      hero.append(d);
    });
    const label = reveal(s, l10n("p", "whimsy-year-label", "whimsy-year-intro-label"));
    const punch = reveal(s, l10n("p", "whimsy-year-punch", "whimsy-year-intro-reveal"));
    beat(s, 150, () => show(kicker));
    beat(s, 650, () => show(hero, label));
    beat(s, 1100, () => show(punch));
    return s;
  }

  function openedSlide(total, perDay, spaceName) {
    const s = makeSlide("opened");
    const kicker = reveal(s, l10n("p", "whimsy-year-kicker", "whimsy-year-opened-kicker"));
    const hero = reveal(s, el("div", "whimsy-year-hero"));
    const big = el("span", "whimsy-year-big", formatCount(0));
    big.dataset.value = String(total);
    hero.append(big);
    const label = reveal(s, l10n("p", "whimsy-year-label", "whimsy-year-opened-label"));
    const punch = reveal(s, l10n("p", "whimsy-year-punch", "whimsy-year-opened-reveal", { perDay: formatDecimal(perDay) }));
    const space = spaceName ? reveal(s, l10n("p", "whimsy-year-aside", "whimsy-year-opened-space", { space: spaceName })) : null;
    beat(s, 150, () => show(kicker));
    beat(s, 1000, fast => {
      show(hero, label);
      return countUp(s, big, total, v => formatCount(Math.round(v)), 1500, fast);
    });
    beat(s, 250, () => show(punch, space));
    return s;
  }

  function topSitesSlide(topSites) {
    const s = makeSlide("topsites");
    const [first, ...rest] = topSites;
    const kicker = reveal(s, l10n("p", "whimsy-year-kicker", "whimsy-year-topsites-kicker"));
    const hero = reveal(s, el("div", "whimsy-year-hero whimsy-year-slot"));
    hero.dataset.site = first.host;
    const name = el("span", "whimsy-year-slot-name", " ");
    hero.append(name);
    const label = reveal(s, l10n("p", "whimsy-year-label", "whimsy-year-topsites-label"));
    const visits = reveal(s, l10n("p", "whimsy-year-aside", "whimsy-year-topsites-visits", { count: first.count }));
    let list = null;
    if (rest.length) {
      list = reveal(s, el("div", "whimsy-year-list-wrap"));
      list.append(l10n("p", "whimsy-year-aside", "whimsy-year-topsites-reveal"));
      const ol = el("ol", "whimsy-year-list");
      ol.start = 2;
      rest.forEach((site, i) => {
        const li = el("li");
        li.style.setProperty("--i", i);
        li.append(el("span", "whimsy-year-list-name", site.host), el("span", "whimsy-year-list-count", formatCount(site.count)));
        ol.append(li);
      });
      list.append(ol);
    }
    beat(s, 150, () => show(kicker));
    beat(s, 1000, fast => {
      show(hero);
      const decoys = [...topSites.map(t => t.host), "?", "…"];
      return slotSpin(s, name, decoys, first.host, fast);
    });
    beat(s, 150, () => show(label, visits));
    if (list) {
      beat(s, 900, () => show(list));
    }
    return s;
  }

  function busiestSlide(day, hour) {
    const s = makeSlide("busiest");
    const kicker = reveal(s, l10n("p", "whimsy-year-kicker", "whimsy-year-busiest-kicker"));
    const hero = reveal(s, el("div", "whimsy-year-hero whimsy-year-clock-row"));
    const clock = svg("svg", { viewBox: "0 0 100 100", class: "whimsy-year-clock", "aria-hidden": "true" });
    clock.append(svg("circle", { cx: 50, cy: 50, r: 44, class: "whimsy-year-clock-face" }));
    for (let i = 0; i < 12; i++) {
      const a = (i * Math.PI) / 6;
      clock.append(svg("line", {
        x1: 50 + Math.sin(a) * 36, y1: 50 - Math.cos(a) * 36,
        x2: 50 + Math.sin(a) * 40, y2: 50 - Math.cos(a) * 40,
        class: "whimsy-year-clock-tick",
      }));
    }
    const hand = svg("line", { x1: 50, y1: 50, x2: 50, y2: 18, class: "whimsy-year-clock-hand" });
    clock.append(hand, svg("circle", { cx: 50, cy: 50, r: 4, class: "whimsy-year-clock-pin" }));
    hand.style.setProperty("--angle", `${(hour % 12) * 30 + 720}deg`);
    const dayEl = l10n("span", "whimsy-year-big whimsy-year-day", "whimsy-year-busiest-day", { day: DAY_NAMES[day] ?? "" });
    hero.append(clock, dayEl);
    const label = reveal(s, l10n("p", "whimsy-year-label", "whimsy-year-busiest-hour", { hour: hourLabel(hour) }));
    const punch = reveal(s, l10n("p", "whimsy-year-punch", "whimsy-year-busiest-reveal"));
    beat(s, 150, () => show(kicker));
    beat(s, 1000, fast => {
      show(hero);
      hero.classList.toggle("is-instant", !!fast);
      requestAnimationFrame(() => hero.classList.add("is-landed"));
      return fast ? 0 : 1300;
    });
    beat(s, 100, () => show(label));
    beat(s, 700, () => show(punch));
    return s;
  }

  function spaceSlide(name, percent) {
    const s = makeSlide("space");
    const kicker = reveal(s, l10n("p", "whimsy-year-kicker", "whimsy-year-space-kicker"));
    const hero = reveal(s, el("div", "whimsy-year-hero whimsy-year-ring-row"));
    const ring = svg("svg", { viewBox: "0 0 120 120", class: "whimsy-year-ring", "aria-hidden": "true" });
    ring.append(
      svg("circle", { cx: 60, cy: 60, r: 52, class: "whimsy-year-ring-track" }),
      svg("circle", { cx: 60, cy: 60, r: 52, class: "whimsy-year-ring-fill", pathLength: 100 })
    );
    ring.style.setProperty("--percent", percent);
    const big = el("span", "whimsy-year-big", "0%");
    hero.append(ring, big);
    const label = reveal(s, l10n("p", "whimsy-year-label", "whimsy-year-space-label", { space: name }));
    const punch = reveal(s, l10n("p", "whimsy-year-punch", "whimsy-year-space-reveal"));
    beat(s, 150, () => show(kicker));
    beat(s, 1000, fast => {
      show(hero, label);
      hero.classList.toggle("is-instant", !!fast);
      requestAnimationFrame(() => hero.classList.add("is-landed"));
      return countUp(s, big, percent, v => `${Math.round(v)}%`, 1300, fast);
    });
    beat(s, 250, () => show(punch));
    return s;
  }

  function longestSlide(title, ms) {
    const s = makeSlide("longest");
    const minutes = ms / 60000;
    const [count, unitId] =
      minutes >= 2 * 1440 ? [Math.round(minutes / 1440), "whimsy-year-longest-days"]
        : minutes >= 120 ? [Math.round(minutes / 60), "whimsy-year-longest-hours"]
          : [Math.max(1, Math.round(minutes)), "whimsy-year-longest-minutes"];
    const kicker = reveal(s, l10n("p", "whimsy-year-kicker", "whimsy-year-longest-kicker"));
    const hero = reveal(s, el("div", "whimsy-year-hero"));
    const big = el("span", "whimsy-year-big", formatCount(0));
    hero.append(big);
    const label = reveal(s, l10n("p", "whimsy-year-label", unitId, { count }));
    const chip = reveal(s, el("p", "whimsy-year-chip"));
    chip.append(el("span", "whimsy-year-chip-dot"), el("span", "whimsy-year-chip-title", title));
    const punch = reveal(s, l10n("p", "whimsy-year-punch", "whimsy-year-longest-reveal"));
    beat(s, 150, () => show(kicker));
    beat(s, 1000, fast => {
      show(hero, label);
      return countUp(s, big, count, v => formatCount(Math.round(v)), 1200, fast);
    });
    beat(s, 300, () => show(chip));
    beat(s, 900, () => show(punch));
    return s;
  }

  function nightOwlSlide(percent) {
    const s = makeSlide("nightowl");
    const sky = el("div", "whimsy-year-night-sky");
    for (let i = 0; i < 28; i++) {
      const star = el("span", "whimsy-year-star");
      star.style.setProperty("--x", `${(i * 37) % 100}%`);
      star.style.setProperty("--y", `${(i * 53) % 70}%`);
      star.style.setProperty("--d", `${(i % 7) * 0.4}s`);
      sky.append(star);
    }
    sky.append(el("span", "whimsy-year-moon"));
    s.deco.append(sky);
    const verdict =
      percent >= 40 ? "whimsy-year-nightowl-high" : percent >= 15 ? "whimsy-year-nightowl-mid" : "whimsy-year-nightowl-low";
    const kicker = reveal(s, l10n("p", "whimsy-year-kicker", "whimsy-year-nightowl-kicker"));
    const hero = reveal(s, el("div", "whimsy-year-hero"));
    const big = el("span", "whimsy-year-big", "0%");
    hero.append(big);
    const label = reveal(s, l10n("p", "whimsy-year-label", "whimsy-year-nightowl-label"));
    const punch = reveal(s, l10n("p", "whimsy-year-punch", verdict));
    beat(s, 150, () => {
      show(kicker);
      s.el.classList.add("is-dusk");
    });
    beat(s, 1100, fast => {
      show(hero, label);
      return countUp(s, big, percent, v => `${Math.round(v)}%`, 1300, fast);
    });
    beat(s, 300, () => show(punch));
    return s;
  }

  function finaleSlide(year, stats) {
    const s = makeSlide("finale");
    const kicker = reveal(s, l10n("p", "whimsy-year-kicker", "whimsy-year-finale-kicker"));
    const card = reveal(s, el("div", "whimsy-year-finale-card"));
    const head = el("div", "whimsy-year-finale-head");
    head.append(el("span", "whimsy-year-finale-year", year), l10n("span", "whimsy-year-finale-label", "whimsy-year-finale-label"));
    const grid = el("dl", "whimsy-year-finale-grid");
    stats.forEach((stat, i) => {
      const tile = el("div", "whimsy-year-tile");
      tile.style.setProperty("--i", i);
      tile.style.setProperty("--tile", THEMES[stat.kind].bg);
      tile.style.setProperty("--tile-ink", THEMES[stat.kind].ink);
      const dt = l10n("dt", "", stat.label);
      const dd = stat.valueId ? l10n("dd", "", stat.valueId, stat.valueArgs) : el("dd", "", stat.value);
      tile.append(dt, dd);
      grid.append(tile);
    });
    card.append(head, grid, l10n("p", "whimsy-year-finale-signoff", "whimsy-year-finale-signoff"));
    const actions = reveal(s, el("div", "whimsy-year-actions"));
    const copy = l10n("button", "whimsy-year-action", "whimsy-year-copy-card");
    copy.id = "whimsy-year-copy";
    const replay = l10n("button", "whimsy-year-action", "whimsy-year-replay");
    replay.id = "whimsy-year-replay";
    const done = l10n("button", "whimsy-year-action whimsy-year-action-primary", "whimsy-year-done");
    done.id = "whimsy-year-done";
    for (const b of [copy, replay, done]) {
      b.type = "button";
    }
    copy.addEventListener("click", () => copyCard(card));
    replay.addEventListener("click", () => renderDeck());
    done.addEventListener("click", closeTab);
    actions.append(copy, replay, done);
    beat(s, 150, () => show(kicker));
    beat(s, 500, () => show(card));
    beat(s, 300 + stats.length * 90, () => show(actions));
    return s;
  }

  // -------------------------------------------------------------------
  // The story

  let model = null;
  let slides = [];
  let current = -1;
  let timers = [];
  let autoTimer = 0;
  let auto = false;
  try {
    auto = window.localStorage.getItem(AUTO_KEY) == "1";
  } catch (e) {}

  function clearTimers() {
    timers.forEach(clearTimeout);
    timers = [];
    clearTimeout(autoTimer);
  }

  function finish(s) {
    s.done = true;
    s.el.classList.add("is-done");
    renderNav();
    if (auto && current < slides.length - 1) {
      autoTimer = setTimeout(() => next(), reduced() ? AUTO_HOLD_MS * 1.5 : AUTO_HOLD_MS);
    }
  }

  function play(s, instant) {
    clearTimers();
    s.finishers = [];
    if (instant || reduced()) {
      s.beats.forEach(b => b.run(true));
      finish(s);
      return;
    }
    s.nextBeat = 0;
    // Beats run in order; a count-up or spin pushes the next beat back by
    // its own length.
    const runFrom = (i, wait) => {
      if (i >= s.beats.length) {
        timers.push(setTimeout(() => finish(s), wait + 300));
        return;
      }
      timers.push(setTimeout(() => {
        s.nextBeat = i + 1;
        const extra = s.beats[i].run(false) || 0;
        runFrom(i + 1, extra);
      }, wait + s.beats[i].delay));
    };
    runFrom(0, 0);
  }

  // Finish the current slide's reveal at once (a press mid-reveal).
  function skip(s) {
    clearTimers();
    s.beats.slice(s.nextBeat ?? 0).forEach(b => b.run(true));
    s.finishers.forEach(f => f());
    s.finishers = [];
    s.nextBeat = s.beats.length;
    finish(s);
  }

  function goTo(index, origin) {
    index = Math.max(0, Math.min(slides.length - 1, index));
    if (index == current) {
      return;
    }
    const forward = index > current;
    const leaving = slides[current];
    current = index;
    const s = slides[current];
    clearTimers();
    for (const other of slides) {
      other.el.removeAttribute("data-active");
      other.el.removeAttribute("data-leaving");
    }
    if (leaving) {
      leaving.el.setAttribute("data-leaving", "");
    }
    const rect = cardsEl.getBoundingClientRect();
    const ox = origin ? origin.x - rect.left : forward ? rect.width * 0.85 : rect.width * 0.15;
    const oy = origin ? origin.y - rect.top : rect.height * 0.5;
    s.el.style.setProperty("--ox", `${Math.round(ox)}px`);
    s.el.style.setProperty("--oy", `${Math.round(oy)}px`);
    s.el.setAttribute("data-active", "");
    cardsEl.dataset.card = String(current);
    const instant = s.seen;
    s.seen = true;
    if (!instant) {
      s.el.classList.remove("is-done");
    }
    play(s, instant);
    renderNav();
  }

  function next(origin) {
    const s = slides[current];
    if (!s) {
      return;
    }
    if (!s.done) {
      skip(s);
    } else if (current < slides.length - 1) {
      goTo(current + 1, origin);
    }
  }
  function prev(origin) {
    if (current > 0) {
      goTo(current - 1, origin);
    }
  }

  function renderNav() {
    for (const [i, seg] of Array.from(dotsEl.children).entries()) {
      seg.classList.toggle("is-past", i < current);
      seg.classList.toggle("is-current", i == current);
      seg.classList.toggle("is-full", i < current || (i == current && !!slides[i]?.done));
    }
    prevBtn.disabled = current <= 0;
    nextBtn.disabled = current >= slides.length - 1 && !!slides[current]?.done;
    deck.dataset.kind = slides[current]?.kind ?? "";
    document.l10n.setAttributes(statusEl, "whimsy-year-progress", {
      current: current + 1,
      total: slides.length,
    });
  }

  function setAuto(on) {
    auto = on;
    autoBtn.setAttribute("aria-pressed", String(on));
    try {
      window.localStorage.setItem(AUTO_KEY, on ? "1" : "0");
    } catch (e) {}
    clearTimeout(autoTimer);
    if (on && slides[current]?.done && current < slides.length - 1) {
      autoTimer = setTimeout(() => next(), AUTO_HOLD_MS);
    }
  }

  function buildSlides(m) {
    const { data, counter, topSpace, longest } = m;
    const list = [introSlide(data.year)];
    const stats = [];
    if (counter.total) {
      const days = Math.max(1, (Date.now() - (counter.since || Date.now())) / 86400000);
      list.push(openedSlide(counter.total, counter.total / days, topSpace?.name));
      stats.push({ kind: "opened", label: "whimsy-year-finale-opened", value: formatCount(counter.total) });
    }
    if (data.topSites.length) {
      list.push(topSitesSlide(data.topSites));
      stats.push({ kind: "topsites", label: "whimsy-year-finale-topsite", value: data.topSites[0].host });
    }
    if (data.busiest) {
      const day = DAY_NAMES[data.busiest.day] ?? "";
      list.push(busiestSlide(data.busiest.day, data.busiest.hour));
      stats.push({
        kind: "busiest",
        label: "whimsy-year-finale-peak",
        valueId: "whimsy-year-finale-peak-value",
        valueArgs: { day, hour: hourLabel(data.busiest.hour) },
      });
    }
    if (topSpace) {
      list.push(spaceSlide(topSpace.name, topSpace.percent));
      stats.push({ kind: "space", label: "whimsy-year-finale-space", value: topSpace.name });
    }
    if (longest) {
      list.push(longestSlide(longest.title || hostFromUrl(longest.url), longest.ms));
      stats.push({ kind: "longest", label: "whimsy-year-finale-longest", value: longest.title || hostFromUrl(longest.url) });
    }
    if (data.night.total) {
      const percent = Math.round((data.night.night / data.night.total) * 100);
      list.push(nightOwlSlide(percent));
      stats.push({ kind: "nightowl", label: "whimsy-year-finale-night", value: `${percent}%` });
    }
    list.push(finaleSlide(data.year, stats));
    return list;
  }

  function renderDeck() {
    clearTimers();
    slides = buildSlides(model);
    current = -1;
    cardsEl.textContent = "";
    dotsEl.textContent = "";
    slides.forEach((s, i) => {
      s.el.dataset.card = String(i);
      cardsEl.append(s.el);
      dotsEl.append(el("span", "whimsy-year-seg"));
    });
    goTo(0);
  }

  // -------------------------------------------------------------------
  // Actions

  async function copyCard(cardEl) {
    try {
      const rect = cardEl.getBoundingClientRect();
      const windowGlobal = window.browsingContext.currentWindowGlobal;
      const bitmap = await windowGlobal.drawSnapshot(
        new DOMRect(rect.x, rect.y, rect.width, rect.height),
        window.devicePixelRatio || 1,
        "#1d1033",
        { drawView: true }
      );
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("bitmaprenderer").transferFromImageBitmap(bitmap);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      const { ScreenshotsUtils } = ChromeUtils.importESModule(
        "moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs"
      );
      const browser = window.browsingContext.embedderElement;
      await ScreenshotsUtils.copyScreenshot(blob, browser, "WhimsyYearInTabs");
      browser?.documentGlobal?.gZenUIManager?.showToast?.("whimsy-year-copied-toast", {});
    } catch (e) {
      console.error("Whimsy: Year in tabs - copy card failed", e);
    }
  }

  function closeTab() {
    const browser = window.browsingContext.embedderElement;
    const win = browser?.documentGlobal;
    const tab = win?.gBrowser?.getTabForBrowser?.(browser);
    if (tab) {
      win.gBrowser.removeTab(tab);
    }
  }

  prevBtn.addEventListener("click", () => prev());
  nextBtn.addEventListener("click", () => next());
  autoBtn.addEventListener("click", () => setAuto(!auto));
  cardsEl.addEventListener("click", event => {
    if (event.target.closest("button, a")) {
      return;
    }
    const rect = cardsEl.getBoundingClientRect();
    const origin = { x: event.clientX, y: event.clientY };
    if (event.clientX - rect.left < rect.width * 0.3) {
      prev(origin);
    } else {
      next(origin);
    }
  });
  window.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey) {
      return;
    }
    const onButton = !!event.target.closest?.("button");
    if (event.key == "ArrowRight" || ((event.key == " " || event.key == "Enter") && !onButton)) {
      event.preventDefault();
      next();
    } else if (event.key == "ArrowLeft") {
      event.preventDefault();
      prev();
    } else if (event.key == "Escape") {
      closeTab();
    }
  });

  // -------------------------------------------------------------------
  // Data

  const data = await queryYearData();
  const counter = WhimsyStats.getCounter();
  const win = Services.wm.getMostRecentBrowserWindow();
  const bySpace = Object.entries(counter.bySpace || {}).sort((a, b) => b[1] - a[1]);
  const topSpace = bySpace.length
    ? {
        name: win?.gZenWorkspaces?.getWorkspaceFromId?.(bySpace[0][0])?.name || bySpace[0][0],
        percent: counter.total ? Math.round((bySpace[0][1] / counter.total) * 100) : 0,
      }
    : null;
  const closedLongest = WhimsyStats.getLongestClosedTab();
  const liveLongest = WhimsyStats.getLiveLongestTab();
  const longest = !closedLongest || (liveLongest && liveLongest.ms > closedLongest.ms) ? liveLongest : closedLongest;

  const hasData = !!(data.topSites.length || data.busiest || data.night.total || counter.total || topSpace || longest);
  if (!hasData) {
    deck.hidden = true;
    emptyEl.hidden = false;
    window.__whimsyYear = { cardCount: 0 };
    return;
  }
  deck.hidden = false;
  emptyEl.hidden = true;
  autoBtn.setAttribute("aria-pressed", String(auto));

  model = { data, counter, topSpace, longest };
  renderDeck();

  window.__whimsyYear = {
    get cardIndex() {
      return current;
    },
    get cardCount() {
      return slides.length;
    },
    get kinds() {
      return slides.map(s => s.kind);
    },
    get done() {
      return !!slides[current]?.done;
    },
    goTo,
    next,
    prev,
    skip: () => skip(slides[current]),
    setAuto,
  };
})();
