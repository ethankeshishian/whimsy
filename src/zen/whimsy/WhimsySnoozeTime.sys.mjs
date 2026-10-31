/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave8/snooze (W8-37): when a snoozed tab comes back. Pure functions of
// `now`, so the tests can pin the clock.
//
// The presets follow Gmail, Superhuman and macOS Reminders: Later Today,
// Tonight, Tomorrow, This Weekend, Next Week, each at a fixed position (and
// shown greyed out when it no longer makes sense today, so nothing moves).
// The picker's field also reads what people type the way Superhuman's
// snooze box does: "2h", "in 3 days", "fri 2pm", "next mon", "nov 12 9am",
// "11/12", "tonight", "noon". English words only; anything it can't read
// fully is refused rather than guessed.

const HOUR = 3600 * 1000;
const MINUTE = 60 * 1000;
const DAY_START = 9; // a day without a time means 9:00 AM
const TONIGHT = 20; // 8:00 PM
const LATER_HOURS = 3;
const LAST_LATER_HOUR = 22; // "Later Today" past 10 PM is really tonight/tomorrow

export const PRESET_KEYS = ["later-today", "tonight", "tomorrow", "weekend", "next-week"];

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const UNITS = {
  m: MINUTE, min: MINUTE, mins: MINUTE, minute: MINUTE, minutes: MINUTE,
  h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR,
  d: 24 * HOUR, day: 24 * HOUR, days: 24 * HOUR,
  w: 7 * 24 * HOUR, wk: 7 * 24 * HOUR, wks: 7 * 24 * HOUR, week: 7 * 24 * HOUR, weeks: 7 * 24 * HOUR,
};
const PARTS_OF_DAY = { morning: 9, noon: 12, afternoon: 14, evening: 18, night: TONIGHT, tonight: TONIGHT, midnight: 0 };
const TOMORROW_WORDS = ["tomorrow", "tmrw", "tmr", "tmw", "tom", "tomo"];
const FILLER = new Set(["at", "on", "the", "until", "till", "til", "by", "this"]);

function at(base, hour, minute = 0) {
  const d = new Date(base);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function addDays(base, days) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

function sameDay(a, b) {
  return a.getFullYear() == b.getFullYear() && a.getMonth() == b.getMonth() && a.getDate() == b.getDate();
}

// A weekday name or its abbreviation ("tue", "tues", "thurs").
function weekdayOf(word) {
  if (!word || word.length < 3) {
    return -1;
  }
  return WEEKDAYS.findIndex(name => name.startsWith(word) || (word.endsWith("s") && name.startsWith(word.slice(0, -1))));
}

function monthOf(word) {
  if (!word || word.length < 3) {
    return -1;
  }
  return MONTHS.findIndex(name => name.startsWith(word.replace(/\.$/, "")));
}

/**
 * Where a preset lands from `now`, and whether it still makes sense.
 *
 * @param {string} key - one of PRESET_KEYS
 * @param {Date} [now]
 * @returns {{ key: string, at: Date, available: boolean, nextWeekend?: boolean }}
 */
export function resolvePreset(key, now = new Date()) {
  switch (key) {
    case "later-today": {
      // Three hours on, rounded up to the next half hour.
      const d = new Date(now.getTime() + LATER_HOURS * HOUR);
      const minutes = d.getMinutes();
      d.setSeconds(0, 0);
      if (minutes % 30) {
        d.setMinutes(minutes + (30 - (minutes % 30)));
      }
      const available = sameDay(d, now) && d.getHours() + d.getMinutes() / 60 <= LAST_LATER_HOUR;
      return { key, at: d, available };
    }
    case "tonight": {
      const d = at(now, TONIGHT);
      // Under an hour away (or gone), it isn't worth a snooze.
      return { key, at: d, available: d.getTime() - now.getTime() >= HOUR };
    }
    case "tomorrow":
      return { key, at: at(addDays(now, 1), DAY_START), available: true };
    case "weekend": {
      // The coming Saturday morning; on a weekend, the next one.
      const day = now.getDay();
      const nextWeekend = day == 6 || day == 0;
      const ahead = (6 - day + 7) % 7 || 7;
      return { key, at: at(addDays(now, ahead), DAY_START), available: true, nextWeekend };
    }
    case "next-week": {
      // The coming Monday morning (a week on, when today is Monday).
      const ahead = (1 - now.getDay() + 7) % 7 || 7;
      return { key, at: at(addDays(now, ahead), DAY_START), available: true };
    }
  }
  throw new Error(`Unknown snooze preset ${key}`);
}

export function resolvePresets(now = new Date()) {
  return PRESET_KEYS.map(key => resolvePreset(key, now));
}

// "3", "3pm", "3:30", "3:30pm", "15:30", "3 pm" (pm as its own token).
function readClock(token, next) {
  const m = /^(\d{1,2})(?::(\d{2}))?(am|pm|a|p)?$/.exec(token);
  if (!m) {
    return null;
  }
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  let suffix = m[3];
  let used = 1;
  if (!suffix && ["am", "pm", "a", "p", "a.m.", "p.m."].includes(next)) {
    suffix = next;
    used = 2;
  }
  if (minute > 59 || hour > 23) {
    return null;
  }
  if (suffix) {
    if (hour < 1 || hour > 12) {
      return null;
    }
    const pm = suffix.startsWith("p");
    hour = (hour % 12) + (pm ? 12 : 0);
  } else if (!m[2] && hour >= 1 && hour <= 6) {
    // A bare "at 3" means the afternoon, as people say it.
    hour += 12;
  }
  return { hour, minute, used };
}

/**
 * Reads a typed snooze time.
 *
 * @param {string} text
 * @param {Date} [now]
 * @returns {null | { at: Date, past: boolean }} null when it can't be read.
 */
export function parse(text, now = new Date()) {
  const clean = String(text ?? "")
    .toLowerCase()
    .replace(/[,@]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) {
    return null;
  }

  // "2h", "in 3 days", "in an hour", "90 min"
  const rel = /^(?:in )?(an?|\d+(?:\.\d+)?) ?([a-z]+)$/.exec(clean);
  if (rel && UNITS[rel[2]]) {
    const n = rel[1].startsWith("a") ? 1 : Number(rel[1]);
    if (n > 0) {
      return { at: new Date(now.getTime() + n * UNITS[rel[2]]), past: false };
    }
  }

  const tokens = clean.split(" ");
  let day = null; // a Date at midnight
  let time = null; // { hour, minute }
  let weekdayToday = false; // "fri" said on a Friday: today if the time is still ahead
  let next = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const following = tokens[i + 1];
    if (FILLER.has(token)) {
      continue;
    }
    if (token == "next") {
      next = true;
      continue;
    }
    if (token == "today" && tokens[i - 1] == "later") {
      continue;
    }
    if (token == "later") {
      if (day || time) {
        return null;
      }
      day = "later";
      continue;
    }
    if (token == "today") {
      if (day) {
        return null;
      }
      day = at(now, 0);
      continue;
    }
    if (TOMORROW_WORDS.includes(token)) {
      if (day) {
        return null;
      }
      day = at(addDays(now, 1), 0);
      continue;
    }
    if (token == "weekend" || token == "wknd") {
      if (day) {
        return null;
      }
      const preset = resolvePreset("weekend", now);
      day = at(next && !preset.nextWeekend ? addDays(preset.at, 7) : preset.at, 0);
      next = false;
      continue;
    }
    if (token == "week" && next) {
      if (day) {
        return null;
      }
      day = at(resolvePreset("next-week", now).at, 0);
      next = false;
      continue;
    }
    if (token in PARTS_OF_DAY) {
      if (time) {
        return null;
      }
      time = { hour: PARTS_OF_DAY[token], minute: 0 };
      if (token == "tonight" && !day) {
        day = at(now, 0);
      }
      if (token == "midnight" && !day) {
        day = at(addDays(now, 1), 0);
      }
      continue;
    }
    const weekday = weekdayOf(token);
    if (weekday >= 0) {
      if (day) {
        return null;
      }
      let ahead = (weekday - now.getDay() + 7) % 7;
      if (ahead == 0) {
        weekdayToday = !next;
        ahead = 7;
      }
      if (next) {
        ahead += ahead < 7 ? 7 : 0;
        next = false;
      }
      day = at(addDays(now, ahead), 0);
      continue;
    }
    // "nov 12", "november 12th", "12 nov"
    const month = monthOf(token);
    if (month >= 0 && /^\d{1,2}(st|nd|rd|th)?$/.test(following ?? "")) {
      if (day) {
        return null;
      }
      day = dateIn(month, parseInt(following, 10), null, now);
      if (!day) {
        return null;
      }
      i++;
      continue;
    }
    if (/^\d{1,2}(st|nd|rd|th)?$/.test(token) && monthOf(following) >= 0 && !time) {
      if (day) {
        return null;
      }
      day = dateIn(monthOf(following), parseInt(token, 10), null, now);
      if (!day) {
        return null;
      }
      i++;
      continue;
    }
    // "11/12", "11/12/2027", "2026-11-12"
    let m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(token);
    if (m) {
      if (day) {
        return null;
      }
      const year = m[3] ? (m[3].length == 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
      day = dateIn(Number(m[1]) - 1, Number(m[2]), year, now);
      if (!day) {
        return null;
      }
      continue;
    }
    m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(token);
    if (m) {
      if (day) {
        return null;
      }
      day = dateIn(Number(m[2]) - 1, Number(m[3]), Number(m[1]), now);
      if (!day) {
        return null;
      }
      continue;
    }
    const clock = readClock(token, following);
    if (clock) {
      if (time) {
        return null;
      }
      time = { hour: clock.hour, minute: clock.minute };
      i += clock.used - 1;
      continue;
    }
    // Anything else: not a time we understand.
    return null;
  }

  if (next) {
    return null; // "next" on its own, or before a word it can't apply to
  }
  if (day == "later") {
    if (time) {
      return null;
    }
    const preset = resolvePreset("later-today", now);
    return { at: preset.at, past: false };
  }
  if (!day && !time) {
    return null;
  }
  let result;
  if (!day) {
    // A time alone: today, or tomorrow once it has passed.
    result = at(now, time.hour, time.minute);
    if (result.getTime() <= now.getTime()) {
      result = addDays(result, 1);
    }
  } else {
    if (weekdayToday && time) {
      const today = at(now, time.hour, time.minute);
      if (today.getTime() > now.getTime()) {
        day = at(now, 0);
      }
    }
    result = at(day, time?.hour ?? DAY_START, time?.minute ?? 0);
  }
  return { at: result, past: result.getTime() <= now.getTime() };
}

// A calendar date; without a year, the next time it comes round.
function dateIn(month, date, year, now) {
  if (month < 0 || month > 11 || date < 1 || date > 31) {
    return null;
  }
  const y = year ?? now.getFullYear();
  const d = new Date(y, month, date);
  if (d.getMonth() != month) {
    return null; // Feb 30
  }
  if (year == null && d.getTime() < at(now, 0).getTime()) {
    d.setFullYear(y + 1);
  }
  return d;
}

/**
 * Fluent arguments describing a wake time relative to now, for
 * whimsy-snooze-when and whimsy-snooze-undo-toast:
 * { when: "today" | "tomorrow" | "week" | "later", time, day }.
 */
export function whenArgs(wakeAt, now = new Date(), locales = undefined) {
  const date = new Date(wakeAt);
  const time = new Intl.DateTimeFormat(locales, { hour: "numeric", minute: "2-digit" }).format(date);
  const days = Math.round((at(date, 0).getTime() - at(now, 0).getTime()) / (24 * HOUR));
  if (days <= 0) {
    return { when: "today", time, day: "" };
  }
  if (days == 1) {
    return { when: "tomorrow", time, day: "" };
  }
  if (days < 7) {
    return { when: "week", time, day: new Intl.DateTimeFormat(locales, { weekday: "long" }).format(date) };
  }
  const options = { weekday: "short", month: "short", day: "numeric" };
  if (date.getFullYear() != now.getFullYear()) {
    options.year = "numeric";
  }
  return { when: "later", time, day: new Intl.DateTimeFormat(locales, options).format(date) };
}

// "in 3 hours", "in 2 days": how far off a typed time is, so the person can
// check the picker read it the way they meant.
export function relative(wakeAt, now = new Date(), locales = undefined) {
  const ms = new Date(wakeAt).getTime() - now.getTime();
  const rtf = new Intl.RelativeTimeFormat(locales, { numeric: "always" });
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) {
    return rtf.format(Math.max(1, minutes), "minute");
  }
  const hours = Math.round(ms / HOUR);
  if (hours < 36) {
    return rtf.format(hours, "hour");
  }
  return rtf.format(Math.round(ms / (24 * HOUR)), "day");
}

// The words each preset answers to in the picker's field.
export const PRESET_WORDS = {
  "later-today": ["later", "today"],
  tonight: ["tonight", "evening"],
  tomorrow: ["tomorrow"],
  weekend: ["weekend", "saturday"],
  "next-week": ["next", "week", "monday"],
};

export function presetMatches(key, text) {
  const words = String(text ?? "").toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) {
    return true;
  }
  return words.every(word => PRESET_WORDS[key].some(k => k.startsWith(word)));
}
