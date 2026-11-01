/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Seasonal touches: one calendar for every seasonal surface (loading
// colors, balloon costumes, the command bar's trim, Balloon Dash, the
// changelog). Space colors stay the user's own. Both switches restore
// native styling everywhere.

const FEATURE_PREF = "whimsy.feature.seasonal-themes";
const ENABLED_PREF = "whimsy.seasons.enabled";
const ATTR = "whimsy-season";
// The finer look (an occasion when one is on, else the season), for
// surfaces that have art for occasions: the command bar's trim.
const DECOR_ATTR = "whimsy-season-decor";
const TRIM_CLASS = "whimsy-season-trim";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

// The trim's art for each look (whimsy-browser.css draws the same files).
// Loaded and decoded when a window takes the look, so the first time the
// command bar opens its art is already there (W10-08/W10-32).
const ART_BASE = "chrome://browser/content/whimsy/season/";
export const TRIM_ART = {
  halloween: ["trim-halloween.svg"],
  autumn: ["trim-autumn.svg"],
  winter: ["trim-winter.svg"],
  spring: ["trim-spring.svg"],
  summer: ["trim-summer.svg"],
  holidays: ["trim-lights.svg", "trim-lights-a.svg", "trim-lights-b.svg"],
};

// Window → { look, images, ready }: keeps the decoded images alive (and so
// in the image cache) for as long as the window shows that look.
const preloaded = new WeakMap();

// The one table. Northern hemisphere, local calendar, MMDD inclusive; a
// range may wrap across the year boundary. Occasions are short windows
// inside a season and win over it where a surface has art for them;
// surfaces without occasion art fall back to the occasion's season.
export const CALENDAR = [
  // Occasions first: the first match wins.
  { id: "halloween", kind: "occasion", season: "autumn", from: 1020, to: 1031 },
  { id: "holidays", kind: "occasion", season: "winter", from: 1201, to: 101 },
  // Seasons cover every day of the year.
  { id: "autumn", kind: "season", from: 922, to: 1130 },
  { id: "winter", kind: "season", from: 1201, to: 229 }, // Include leap day.
  { id: "spring", kind: "season", from: 301, to: 531 },
  { id: "summer", kind: "season", from: 601, to: 921 },
];
const SEASONS = CALENDAR.filter(entry => entry.kind == "season");
const OCCASIONS = CALENDAR.filter(entry => entry.kind == "occasion");

function inRange({ from, to }, key) {
  return from <= to ? key >= from && key <= to : key >= from || key <= to;
}

function dateKey(date) {
  return (date.getMonth() + 1) * 100 + date.getDate();
}

// What a date looks like, ignoring the switches: { season, occasion, id }
// where id is the occasion when there is one, else the season.
export function lookForDate(date) {
  const key = dateKey(date);
  const season = SEASONS.find(entry => inRange(entry, key))?.id ?? null;
  const occasion = OCCASIONS.find(entry => inRange(entry, key))?.id ?? null;
  return season ? { season, occasion, id: occasion ?? season } : null;
}

export const WhimsySeasons = {
  // Overridable in tests.
  _now() {
    return new Date();
  },

  get enabled() {
    return (
      Services.prefs.getBoolPref(FEATURE_PREF, true) && Services.prefs.getBoolPref(ENABLED_PREF, true)
    );
  },

  current() {
    if (!this.enabled) {
      return null;
    }
    const key = dateKey(this._now());
    return SEASONS.find(entry => inRange(entry, key)) ?? null;
  },

  // { season, occasion, id } for today, or null when the switches are off.
  look() {
    return this.enabled ? lookForDate(this._now()) : null;
  },

  initWindow(win) {
    const update = () => this.apply(win);
    // Recheck on focus and navigation so windows left open across a season
    // boundary update without a polling timer.
    const onTabChange = event => {
      if (event.detail.changed.includes("busy")) {
        update();
      }
    };
    win.addEventListener("focus", update);
    win.gBrowser.tabContainer.addEventListener("TabAttrModified", onTabChange);
    Services.prefs.addObserver(FEATURE_PREF, update);
    Services.prefs.addObserver(ENABLED_PREF, update);
    win.addEventListener(
      "unload",
      () => {
        win.removeEventListener("focus", update);
        win.gBrowser.tabContainer.removeEventListener("TabAttrModified", onTabChange);
        Services.prefs.removeObserver(FEATURE_PREF, update);
        Services.prefs.removeObserver(ENABLED_PREF, update);
      },
      { once: true }
    );
    update();
  },

  apply(win) {
    const root = win.document.documentElement;
    const look = this.look();
    if (look) {
      root.setAttribute(ATTR, look.season);
      root.setAttribute(DECOR_ATTR, look.id);
      this.preloadArt(win, look.id);
      this.ensureTrim(win);
    } else {
      root.removeAttribute(ATTR);
      root.removeAttribute(DECOR_ATTR);
      preloaded.delete(win);
      this.trim(win)?.remove();
    }
  },

  // Loads and decodes the trim's art for a look in this window. Idempotent
  // per look; apply() runs on every focus.
  preloadArt(win, lookId) {
    const current = preloaded.get(win);
    if (current?.look == lookId) {
      return current.ready;
    }
    const images = (TRIM_ART[lookId] ?? []).map(file => {
      const image = new win.Image();
      image.src = ART_BASE + file;
      return image;
    });
    const ready = Promise.all(
      images.map(image =>
        image.decode().catch(e => console.error(`Whimsy: season art ${image.src}`, e))
      )
    ).then(() => images.every(image => image.complete));
    preloaded.set(win, { look: lookId, images, ready });
    return ready;
  },

  // Resolves (true) once this window's trim art is decoded; for tests.
  artReady(win) {
    return preloaded.get(win)?.ready ?? Promise.resolve(false);
  },

  trim(win) {
    return win.document.getElementById("urlbar")?.querySelector(`:scope > .${TRIM_CLASS}`) ?? null;
  },

  // The command bar's seasonal trim: an empty, aria-hidden overlay inside
  // the URL bar whose two strips sit just outside its top and bottom edges
  // (whimsy-browser.css draws the art and shows it only while the bar
  // floats open). It never takes pointer events or changes the bar's size.
  ensureTrim(win) {
    const urlbar = win.document.getElementById("urlbar");
    if (!urlbar || this.trim(win)) {
      return;
    }
    const doc = win.document;
    const trim = doc.createElementNS(XHTML_NS, "div");
    trim.className = TRIM_CLASS;
    trim.setAttribute("aria-hidden", "true");
    for (const edge of ["top", "bottom"]) {
      const strip = doc.createElementNS(XHTML_NS, "div");
      strip.className = `${TRIM_CLASS}-${edge}`;
      trim.append(strip);
    }
    const background = urlbar.querySelector(":scope > .urlbar-background");
    if (background) {
      background.after(trim);
    } else {
      urlbar.prepend(trim);
    }
  },
};
