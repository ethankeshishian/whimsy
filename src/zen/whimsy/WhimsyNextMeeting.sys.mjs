/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// meeting: Next meeting in the sidebar (Arc's meeting chip, Dia's "Tab
// Groups for Meetings"). People use it to skip the trip to a calendar app
// five minutes before a call: the next event shows in the sidebar with a
// Join button that opens its Meet/Zoom/Teams link in a tab (or switches to
// the tab already on it), plus how long until it starts.
//
// Sources, any number of each:
// - Apple Calendar (EventKit, every account macOS Calendar holds, so a
//   Google or Exchange account added in System Settings → Internet Accounts
//   is covered too, in near real time). Read through Whimsy's native
//   nsIWhimsyCalendar (calendar/). Access is asked for only when the person
//   turns Apple Calendar on, never at startup.
// - Google Calendar accounts, each through its "Secret address in iCal
//   format" (Google Calendar → Settings → the calendar → Integrate
//   calendar). Why not the signed-in session: calendar.google.com's own
//   web endpoints (sync.prefetcheventrange and friends) are undocumented,
//   protobuf-shaped arrays behind per-session XSRF tokens that change
//   without notice, so a browser reading them breaks silently; there is no
//   cookie-authenticated .ics. The secret address is documented
//   (support.google.com/calendar/answer/37648), stable, needs no OAuth
//   client, and serves the calendar's current state (the "up to 12 hours"
//   delay people mention is Google *importing* other feeds, not this one).
//   Limits: Workspace admins can turn the address off (then use Apple
//   Calendar), and it is one calendar per address (add each one).
//
// Refreshing: at most every 5 minutes per Google calendar, and only while a
// browser window is open. Apple Calendar is local, so it is also re-read
// when calendar Settings opens. A 30 s tick (no network) keeps "in 4 min"
// and the sidebar card current.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.next-meeting";
const APPLE_PREF = "whimsy.next-meeting.apple-calendar";
const GOOGLE_PREF = "whimsy.next-meeting.google-calendars";
const CARD_PREF = "whimsy.next-meeting.sidebar-card";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const GOOGLE_REFRESH_MS = 5 * MINUTE;
const APPLE_REFRESH_MS = 5 * MINUTE;
const TICK_MS = 30 * 1000;
const LOOKAHEAD_HOURS = 24;
// The sidebar card shows from this long before a meeting starts...
export const CARD_LEAD_MS = 15 * MINUTE;
// ...until this long after (or the meeting's end, if sooner).
export const CARD_TRAIL_MS = 10 * MINUTE;
const MAX_ICS_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Join links

// Each match stops at whitespace, quotes, angle brackets and closing
// brackets, so links inside HTML descriptions and "<https://...>" wrappers
// come out clean.
const END = String.raw`[^\s<>"'\])]`;
const JOIN_PATTERNS = [
  { service: "meet", re: new RegExp(String.raw`https?://meet\.google\.com/(?:lookup/${END}+|[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}${END}*)`, "i") },
  { service: "zoom", re: new RegExp(String.raw`https?://(?:[\w-]+\.)*zoom(?:gov)?\.(?:us|com)/(?:j|my|s|w|wc/join)/${END}+`, "i") },
  { service: "teams", re: new RegExp(String.raw`https?://teams\.(?:microsoft|live)\.com/(?:l/meetup-join|meet)/${END}+`, "i") },
  { service: "webex", re: new RegExp(String.raw`https?://(?:[\w-]+\.)*webex\.com/(?:meet/|join/|[\w-]+/j\.php)${END}*`, "i") },
];

function unwrapSafeLinks(text) {
  // Outlook rewrites links as safelinks.protection.outlook.com/?url=<encoded>.
  return text.replace(
    /https?:\/\/[\w.-]*safelinks\.protection\.outlook\.com\/\?[^\s<>"']*?\burl=([^&\s<>"']+)[^\s<>"']*/gi,
    (whole, encoded) => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return whole;
      }
    }
  );
}

/**
 * Finds a video-call link in one piece of text.
 *
 * @returns {{url: string, service: string}|null}
 */
export function findJoinLink(text) {
  if (!text || typeof text != "string") {
    return null;
  }
  const source = unwrapSafeLinks(text.replace(/&amp;/g, "&"));
  let best = null;
  for (const { service, re } of JOIN_PATTERNS) {
    const match = re.exec(source);
    if (match && (!best || match.index < best.index)) {
      best = { index: match.index, url: match[0], service };
    }
  }
  if (!best) {
    return null;
  }
  const url = best.url.replace(/[.,;:!?]+$/, "");
  return { url, service: best.service };
}

/**
 * The event's join link: its own URL field first, then a conference link
 * (Google's X-GOOGLE-CONFERENCE), the location, and finally the notes.
 */
export function joinLinkFor(event) {
  for (const field of [event.url, event.conference, event.location, event.notes]) {
    const link = findJoinLink(field);
    if (link) {
      return link;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// iCalendar

const tzFormatters = new Map();

function tzOffset(ms, timeZone) {
  let format = tzFormatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    tzFormatters.set(timeZone, format);
  }
  const parts = {};
  for (const { type, value } of format.formatToParts(new Date(ms))) {
    parts[type] = +value;
  }
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return asUTC - Math.floor(ms / 1000) * 1000;
}

/**
 * Turns a wall-clock time in an IANA time zone into ms since the epoch.
 * null time zone = floating (the computer's own zone); "UTC" = UTC.
 */
export function wallClockToMs({ y, m, d, h = 0, mi = 0, s = 0 }, timeZone) {
  if (timeZone == "UTC") {
    return Date.UTC(y, m - 1, d, h, mi, s);
  }
  if (timeZone) {
    try {
      const guess = Date.UTC(y, m - 1, d, h, mi, s);
      let result = guess - tzOffset(guess, timeZone);
      // Once more, in case the guess landed across a DST change.
      result = guess - tzOffset(result, timeZone);
      return result;
    } catch {
      // Not an IANA zone (Outlook writes Windows names): treat as local.
    }
  }
  return new Date(y, m - 1, d, h, mi, s).getTime();
}

function unescapeText(value) {
  return value.replace(/\\([\\;,nN])/g, (_, c) => (c == "n" || c == "N" ? "\n" : c));
}

function parseLine(line) {
  // NAME;PARAM=VALUE;PARAM="QUOTED;VALUE":the value
  let i = 0;
  let inQuote = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c == '"') {
      inQuote = !inQuote;
    } else if (c == ":" && !inQuote) {
      break;
    }
  }
  if (i >= line.length) {
    return null;
  }
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const pieces = head.match(/(?:[^;"]+|"[^"]*")+/g) || [];
  const name = (pieces.shift() || "").toUpperCase();
  const params = {};
  for (const piece of pieces) {
    const eq = piece.indexOf("=");
    if (eq > 0) {
      params[piece.slice(0, eq).toUpperCase()] = piece.slice(eq + 1).replace(/^"|"$/g, "");
    }
  }
  return { name, params, value };
}

/**
 * Parses an iCalendar date or date-time value.
 *
 * @returns {{y, m, d, h, mi, s, tz: string|null, date: boolean}|null}
 */
export function parseICalDate(value, params = {}) {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec((value || "").trim());
  if (!match) {
    return null;
  }
  const [, y, m, d, h, mi, s, z] = match;
  const date = params.VALUE == "DATE" || h === undefined;
  return {
    y: +y,
    m: +m,
    d: +d,
    h: date ? 0 : +h,
    mi: date ? 0 : +mi,
    s: date ? 0 : +(s || 0),
    tz: z ? "UTC" : date ? null : params.TZID || null,
    date,
  };
}

function parseDuration(value) {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec((value || "").trim());
  if (!match) {
    return null;
  }
  const [, sign, w, d, h, m, s] = match;
  const ms = ((+w || 0) * 7 * 24 * 3600 + (+d || 0) * 24 * 3600 + (+h || 0) * 3600 + (+m || 0) * 60 + (+s || 0)) * 1000;
  return sign == "-" ? -ms : ms;
}

/**
 * Splits an .ics file into its events (VEVENTs only; alarms and time zone
 * definitions are skipped: zones are resolved by their IANA TZID).
 */
export function parseICS(text) {
  const lines = String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
  const events = [];
  const stack = [];
  let current = null;
  for (const raw of lines) {
    if (!raw) {
      continue;
    }
    const line = parseLine(raw);
    if (!line) {
      continue;
    }
    if (line.name == "BEGIN") {
      stack.push(line.value.toUpperCase());
      if (line.value.toUpperCase() == "VEVENT") {
        current = { attendees: [], exdates: [] };
      }
      continue;
    }
    if (line.name == "END") {
      const ended = stack.pop();
      if (ended == "VEVENT" && current) {
        events.push(current);
        current = null;
      }
      continue;
    }
    if (!current || stack[stack.length - 1] != "VEVENT") {
      continue;
    }
    const { name, params, value } = line;
    switch (name) {
      case "UID":
        current.uid = value;
        break;
      case "SUMMARY":
        current.title = unescapeText(value);
        break;
      case "DESCRIPTION":
        current.notes = unescapeText(value);
        break;
      case "LOCATION":
        current.location = unescapeText(value);
        break;
      case "URL":
        current.url = value;
        break;
      case "X-GOOGLE-CONFERENCE":
        current.conference = value;
        break;
      case "STATUS":
        current.status = value.toUpperCase();
        break;
      case "DTSTART":
        current.dtstart = parseICalDate(value, params);
        break;
      case "DTEND":
        current.dtend = parseICalDate(value, params);
        break;
      case "DURATION":
        current.duration = parseDuration(value);
        break;
      case "RRULE":
        current.rrule = value;
        break;
      case "RECURRENCE-ID":
        current.recurrenceId = parseICalDate(value, params);
        break;
      case "EXDATE":
        for (const part of value.split(",")) {
          const date = parseICalDate(part, params);
          if (date) {
            current.exdates.push(date);
          }
        }
        break;
      case "ATTENDEE":
        current.attendees.push({
          email: value.replace(/^mailto:/i, "").toLowerCase(),
          partstat: (params.PARTSTAT || "").toUpperCase(),
        });
        break;
    }
  }
  return events;
}

function parseRRule(value) {
  const rule = {};
  for (const part of String(value || "").split(";")) {
    const [key, val] = part.split("=");
    if (key && val !== undefined) {
      rule[key.toUpperCase()] = val;
    }
  }
  return rule;
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

// Pure date arithmetic on wall-clock dates (no time zones involved).
function addDays({ y, m, d }, days) {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
function weekday({ y, m, d }) {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// The days of one month a MONTHLY rule picks (BYDAY with optional ordinals
// such as 1MO or -1FR, or BYMONTHDAY), defaulting to DTSTART's day.
function monthlyDays(y, m, rule, startDay) {
  const count = daysInMonth(y, m);
  if (rule.BYMONTHDAY) {
    return rule.BYMONTHDAY.split(",")
      .map(n => +n)
      .map(n => (n < 0 ? count + 1 + n : n))
      .filter(n => n >= 1 && n <= count)
      .sort((a, b) => a - b);
  }
  if (rule.BYDAY) {
    const days = [];
    for (const spec of rule.BYDAY.split(",")) {
      const match = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(spec.trim().toUpperCase());
      if (!match) {
        continue;
      }
      const wd = WEEKDAYS.indexOf(match[2]);
      const matching = [];
      for (let d = 1; d <= count; d++) {
        if (weekday({ y, m, d }) == wd) {
          matching.push(d);
        }
      }
      if (match[1]) {
        const n = +match[1];
        const pick = n > 0 ? matching[n - 1] : matching[matching.length + n];
        if (pick) {
          days.push(pick);
        }
      } else {
        days.push(...matching);
      }
    }
    return [...new Set(days)].sort((a, b) => a - b);
  }
  return startDay <= count ? [startDay] : [];
}

/**
 * The start times (ms) of a recurring event's occurrences up to `to`.
 * Covers DAILY, WEEKLY (BYDAY), MONTHLY (BYDAY with ordinals, BYMONTHDAY)
 * and YEARLY, with INTERVAL, COUNT and UNTIL, expanded in the event's own
 * time zone so DST moves with it.
 */
export function expandRecurrence(start, rruleValue, to) {
  const rule = parseRRule(rruleValue);
  const freq = (rule.FREQ || "").toUpperCase();
  const interval = Math.max(1, +rule.INTERVAL || 1);
  const maxCount = rule.COUNT ? +rule.COUNT : Infinity;
  const untilDate = rule.UNTIL ? parseICalDate(rule.UNTIL) : null;
  const until = untilDate ? wallClockToMs(untilDate, untilDate.tz || start.tz) : Infinity;
  const time = { h: start.h, mi: start.mi, s: start.s };
  const toMs = date => wallClockToMs({ ...date, ...time }, start.date ? null : start.tz);
  const startMs = toMs(start);
  const out = [];
  let produced = 0;
  // Returns false once nothing further can come.
  const emit = date => {
    const ms = toMs(date);
    if (ms < startMs) {
      return true;
    }
    if (ms > until || ms > to || produced >= maxCount) {
      return false;
    }
    produced++;
    out.push(ms);
    return true;
  };

  const SAFETY = 5000;
  if (freq == "DAILY") {
    for (let i = 0, date = start; i < SAFETY * 4; i++, date = addDays(date, interval)) {
      if (!emit(date)) {
        break;
      }
    }
  } else if (freq == "WEEKLY") {
    const days = rule.BYDAY
      ? rule.BYDAY.split(",")
          .map(s => WEEKDAYS.indexOf(s.trim().toUpperCase().slice(-2)))
          .filter(n => n >= 0)
      : [weekday(start)];
    const wkst = Math.max(0, WEEKDAYS.indexOf((rule.WKST || "MO").toUpperCase()));
    const offsetOf = wd => (wd - wkst + 7) % 7;
    days.sort((a, b) => offsetOf(a) - offsetOf(b));
    let weekStart = addDays(start, -offsetOf(weekday(start)));
    outer: for (let i = 0; i < SAFETY; i++, weekStart = addDays(weekStart, 7 * interval)) {
      for (const wd of days) {
        if (!emit(addDays(weekStart, offsetOf(wd)))) {
          break outer;
        }
      }
    }
  } else if (freq == "MONTHLY") {
    let { y, m } = start;
    outer: for (let i = 0; i < SAFETY; i++) {
      for (const d of monthlyDays(y, m, rule, start.d)) {
        if (!emit({ y, m, d })) {
          break outer;
        }
      }
      m += interval;
      while (m > 12) {
        m -= 12;
        y++;
      }
    }
  } else if (freq == "YEARLY") {
    for (let i = 0, y = start.y; i < SAFETY; i++, y += interval) {
      if (start.d > daysInMonth(y, start.m)) {
        continue;
      }
      if (!emit({ y, m: start.m, d: start.d })) {
        break;
      }
    }
  } else {
    out.push(startMs);
  }
  return out;
}

/**
 * Turns parsed VEVENTs into concrete occurrences overlapping [from, to].
 *
 * @param {object[]} vevents - from parseICS
 * @param {{from: number, to: number, selfEmail?: string}} options
 */
export function occurrencesBetween(vevents, { from, to, selfEmail = "" }) {
  const self = selfEmail.toLowerCase();
  const overridden = new Map();
  for (const ev of vevents) {
    if (ev.uid && ev.recurrenceId) {
      const set = overridden.get(ev.uid) ?? new Set();
      set.add(wallClockToMs(ev.recurrenceId, ev.recurrenceId.tz ?? ev.dtstart?.tz ?? null));
      overridden.set(ev.uid, set);
    }
  }
  const out = [];
  for (const ev of vevents) {
    const start = ev.dtstart;
    if (!start || ev.status == "CANCELLED") {
      continue;
    }
    const zone = start.date ? null : start.tz;
    const startMs = wallClockToMs(start, zone);
    let duration;
    if (ev.dtend) {
      duration = wallClockToMs(ev.dtend, ev.dtend.date ? null : ev.dtend.tz) - startMs;
    } else if (ev.duration != null) {
      duration = ev.duration;
    } else {
      duration = start.date ? 24 * HOUR : 0;
    }
    duration = Math.max(0, duration);
    const declined = !!self && ev.attendees.some(a => a.email == self && a.partstat == "DECLINED");

    let starts = [startMs];
    if (ev.rrule && !ev.recurrenceId) {
      const skip = new Set(ev.exdates.map(x => wallClockToMs(x, x.date ? null : x.tz ?? zone)));
      const moved = overridden.get(ev.uid) ?? new Set();
      starts = expandRecurrence(start, ev.rrule, to).filter(ms => !skip.has(ms) && !moved.has(ms));
    }
    for (const s of starts) {
      const e = s + duration;
      if (e <= from || s >= to) {
        continue;
      }
      out.push({
        id: `${ev.uid || ev.title || ""}@${s}`,
        title: ev.title || "",
        start: s,
        end: e,
        allDay: !!start.date,
        location: ev.location,
        notes: ev.notes,
        url: ev.url,
        conference: ev.conference,
        declined,
        cancelled: false,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Google Calendar accounts (secret iCal addresses)

/** Normalises a pasted secret address; null if it can't be one. */
export function normalizeCalendarUrl(input) {
  let text = String(input || "").trim();
  if (/^webcals?:\/\//i.test(text)) {
    text = text.replace(/^webcals?:\/\//i, "https://");
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  // The address is a secret: only ever fetch it over https.
  if (url.protocol != "https:") {
    return null;
  }
  return url.href;
}

/** A readable name for a calendar address: the account's email if present. */
export function labelForCalendarUrl(href) {
  try {
    const url = new URL(href);
    const match = /\/ical\/([^/]+)\//.exec(url.pathname);
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (id.includes("@")) {
        return id;
      }
    }
    return url.hostname;
  } catch {
    return "";
  }
}

function readGoogleCalendars() {
  try {
    const list = JSON.parse(Services.prefs.getStringPref(GOOGLE_PREF, "") || "[]");
    return Array.isArray(list) ? list.filter(c => c && typeof c.url == "string" && c.id) : [];
  } catch {
    return [];
  }
}

function writeGoogleCalendars(list) {
  Services.prefs.setStringPref(GOOGLE_PREF, JSON.stringify(list));
}

// ---------------------------------------------------------------------------
// The service

function realAppleCalendar() {
  try {
    if (!Cc["@whimsy/calendar;1"]) {
      return null;
    }
    return Cc["@whimsy/calendar;1"].getService(Ci.nsIWhimsyCalendar);
  } catch {
    return null;
  }
}

export const WhimsyNextMeeting = {
  _windows: new Set(),
  _listeners: new Set(),
  _tick: null,
  _prefsObserved: false,
  _appleOverride: undefined,
  // source id → { events, fetchedAt, status, error }
  _sources: new Map(),
  _refreshing: null,
  // Bumped whenever sources are reset, so a read still in flight from
  // before can't put back what was just removed.
  _generation: 0,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },
  get appleEnabled() {
    return Services.prefs.getBoolPref(APPLE_PREF, false);
  },
  get cardEnabled() {
    return Services.prefs.getBoolPref(CARD_PREF, true);
  },
  get apple() {
    return this._appleOverride !== undefined ? this._appleOverride : realAppleCalendar();
  },
  get appleAvailable() {
    return !!this.apple;
  },
  get googleCalendars() {
    return readGoogleCalendars();
  },
  get hasSources() {
    return this.appleEnabled || this.googleCalendars.length > 0;
  },

  /** "off", "unavailable", "notDetermined", "denied", "restricted", "fullAccess", ... */
  get appleStatus() {
    if (!this.appleEnabled) {
      return "off";
    }
    const apple = this.apple;
    if (!apple) {
      return "unavailable";
    }
    const error = this._sources.get("apple")?.error;
    if (error == "missing-usage-description") {
      return error;
    }
    try {
      return apple.authorizationStatus;
    } catch {
      return "unavailable";
    }
  },

  sourceState(id) {
    return this._sources.get(id) ?? null;
  },

  // ---- windows and timers ------------------------------------------------

  initWindow(win) {
    this._observePrefs();
    this._registerJoinAction();
    if (this._windows.has(win)) {
      return;
    }
    this._windows.add(win);
    win.addEventListener(
      "unload",
      () => {
        this._windows.delete(win);
        this._updateTimer();
      },
      { once: true }
    );
    if (!win._whimsyQuickWindow) {
      WhimsyNextMeetingCard.attach(win, this);
    }
    this._updateTimer();
  },

  _observePrefs() {
    if (this._prefsObserved) {
      return;
    }
    this._prefsObserved = true;
    this._prefObserver = (subject, topic, pref) => this._onPrefChanged(pref);
    for (const pref of [FEATURE_PREF, APPLE_PREF, GOOGLE_PREF, CARD_PREF]) {
      Services.prefs.addObserver(pref, this._prefObserver);
    }
  },

  _onPrefChanged(pref) {
    if (pref == APPLE_PREF) {
      if (this.appleEnabled) {
        // Turned on by the person (Settings): the one moment
        // Whimsy asks macOS for access.
        this.requestAppleAccess();
      } else {
        this._generation++;
        this._sources.delete("apple");
        this._notify();
      }
    } else if (pref == GOOGLE_PREF) {
      const ids = new Set(this.googleCalendars.map(c => `google:${c.id}`));
      for (const id of [...this._sources.keys()]) {
        if (id.startsWith("google:") && !ids.has(id)) {
          this._sources.delete(id);
        }
      }
      this._notify();
      this.refresh();
    } else if (pref == FEATURE_PREF && this.enabled) {
      this.refresh();
      this._notify();
    } else {
      this._notify();
    }
    this._updateTimer();
  },

  _updateTimer() {
    const want = this._windows.size > 0 && this.enabled && this.hasSources;
    if (want && !this._tick) {
      this._tick = lazy.setInterval(() => this._onTick(), TICK_MS);
      this.refresh();
    } else if (!want && this._tick) {
      lazy.clearInterval(this._tick);
      this._tick = null;
    }
  },

  _onTick() {
    this.refresh();
    this._notify();
  },

  // ---- listeners -----------------------------------------------------------

  addListener(fn) {
    this._listeners.add(fn);
  },
  removeListener(fn) {
    this._listeners.delete(fn);
  },
  _notify() {
    for (const fn of this._listeners) {
      try {
        fn();
      } catch (e) {
        console.error("Whimsy: next meeting listener", e);
      }
    }
  },

  // ---- sources -------------------------------------------------------------

  /**
   * Asks macOS for calendar access (its prompt shows the first time), then
   * reads events. Only called from a person's action.
   */
  requestAppleAccess() {
    const apple = this.apple;
    if (!apple) {
      this._notify();
      return Promise.resolve(false);
    }
    return new Promise(resolve => {
      try {
        const generation = this._generation;
        apple.requestAccess((success, result) => {
          if (generation != this._generation || !this.appleEnabled) {
            resolve(false);
            return;
          }
          this._sources.set("apple", {
            events: [],
            fetchedAt: 0,
            error: success ? null : result,
          });
          this._notify();
          if (success) {
            this.refresh({ force: true });
          }
          resolve(success);
        });
      } catch (e) {
        console.error("Whimsy: calendar access", e);
        resolve(false);
      }
    });
  },

  setAppleEnabled(on) {
    Services.prefs.setBoolPref(APPLE_PREF, !!on);
  },

  /** @returns {boolean} false if the address isn't usable */
  addGoogleCalendar(input) {
    const url = normalizeCalendarUrl(input);
    if (!url) {
      return false;
    }
    const list = this.googleCalendars;
    if (list.some(c => c.url == url)) {
      return true;
    }
    list.push({ id: Services.uuid.generateUUID().toString().slice(1, 9), url, label: labelForCalendarUrl(url) });
    writeGoogleCalendars(list);
    return true;
  },

  removeGoogleCalendar(id) {
    writeGoogleCalendars(this.googleCalendars.filter(c => c.id != id));
  },

  /**
   * Re-reads whatever is due. Google calendars at most every 5 minutes
   * (unless never fetched); Apple Calendar on the same cadence, or with
   * `apple: true` (it's local) and `force: true`.
   */
  refresh({ force = false, apple = false } = {}) {
    if (!this.enabled || !this._windows.size) {
      return Promise.resolve();
    }
    if (this._refreshing) {
      // Run again once the current pass is done; only what's due is read.
      return this._refreshing.then(() => this.refresh({ force, apple }));
    }
    const now = Date.now();
    const jobs = [];
    if (this.appleEnabled && this.apple) {
      const state = this._sources.get("apple");
      if (force || apple || !state || now - state.fetchedAt >= APPLE_REFRESH_MS) {
        jobs.push(this._refreshApple());
      }
    }
    for (const calendar of this.googleCalendars) {
      const state = this._sources.get(`google:${calendar.id}`);
      if (!state || now - state.fetchedAt >= GOOGLE_REFRESH_MS) {
        jobs.push(this._refreshGoogle(calendar));
      }
    }
    if (!jobs.length) {
      return Promise.resolve();
    }
    this._refreshing = Promise.allSettled(jobs).then(() => {
      this._refreshing = null;
      this._notify();
    });
    return this._refreshing;
  },

  _refreshApple() {
    const apple = this.apple;
    const fetchedAt = Date.now();
    let status;
    try {
      status = apple.authorizationStatus;
    } catch {
      status = "unavailable";
    }
    if (status != "fullAccess") {
      // Never prompt from here: Settings shows "Allow access" instead.
      const previous = this._sources.get("apple");
      this._sources.set("apple", { events: [], fetchedAt, error: previous?.error ?? status });
      return Promise.resolve();
    }
    return new Promise(resolve => {
      try {
        const generation = this._generation;
        apple.upcomingEvents(LOOKAHEAD_HOURS, (success, result) => {
          if (generation != this._generation || !this.appleEnabled) {
            resolve();
            return;
          }
          let events = [];
          let error = success ? null : result;
          if (success) {
            try {
              events = JSON.parse(result).map(ev => ({
                ...ev,
                source: "apple",
                sourceLabel: ev.account || ev.calendar || "",
              }));
            } catch {
              error = "bad-json";
            }
          }
          this._sources.set("apple", { events, fetchedAt, error });
          resolve();
        });
      } catch (e) {
        this._sources.set("apple", { events: [], fetchedAt, error: String(e) });
        resolve();
      }
    });
  },

  async _refreshGoogle(calendar) {
    const id = `google:${calendar.id}`;
    const fetchedAt = Date.now();
    const previous = this._sources.get(id);
    const generation = this._generation;
    const stillWanted = () =>
      generation == this._generation && this.googleCalendars.some(c => c.id == calendar.id);
    try {
      const response = await fetch(calendar.url, { credentials: "omit", cache: "no-cache" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await response.text();
      if (text.length > MAX_ICS_BYTES || !/BEGIN:VCALENDAR/i.test(text)) {
        throw new Error("not-a-calendar");
      }
      const now = Date.now();
      const events = occurrencesBetween(parseICS(text), {
        from: now - 12 * HOUR,
        to: now + LOOKAHEAD_HOURS * HOUR,
        selfEmail: calendar.label?.includes("@") ? calendar.label : "",
      }).map(ev => ({ ...ev, source: id, sourceLabel: calendar.label || "", color: calendar.color }));
      if (stillWanted()) {
        this._sources.set(id, { events, fetchedAt, error: null });
      }
    } catch (e) {
      if (!stillWanted()) {
        return;
      }
      // Keep what we had, so a blip doesn't empty the sidebar.
      this._sources.set(id, { events: previous?.events ?? [], fetchedAt, error: String(e?.message || e) });
    }
  },

  // ---- reading -------------------------------------------------------------

  /**
   * Upcoming and ongoing meetings, soonest first: not all-day, not
   * cancelled, not declined, not over. The same meeting seen through two
   * sources (a Google account in macOS Calendar and its iCal address) is
   * listed once.
   */
  upcoming(now = Date.now()) {
    if (!this.enabled) {
      return [];
    }
    const seen = new Set();
    const out = [];
    const ordered = [...this._sources.entries()].sort(([a], [b]) => (a == "apple" ? -1 : b == "apple" ? 1 : 0));
    for (const [, state] of ordered) {
      for (const ev of state.events ?? []) {
        if (ev.allDay || ev.cancelled || ev.declined || ev.end <= now) {
          continue;
        }
        const key = `${(ev.title || "").trim().toLowerCase()}@${Math.round(ev.start / MINUTE)}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        out.push({ ...ev, join: joinLinkFor(ev) });
      }
    }
    out.sort((a, b) => a.start - b.start || a.end - b.end || a.title.localeCompare(b.title));
    return out;
  },

  /** The next meeting: one in progress, or else the soonest to start. */
  next(now = Date.now()) {
    return this.upcoming(now)[0] ?? null;
  },

  /** One timing window shared by the sidebar and command bar. */
  soonMeeting(now = Date.now(), { joinable = false } = {}) {
    return this.upcoming(now).find(ev =>
      ev.start - now <= CARD_LEAD_MS && now - ev.start <= CARD_TRAIL_MS &&
      (!joinable || ev.join)
    ) ?? null;
  },

  cardMeeting(now = Date.now()) {
    return this.cardEnabled ? this.soonMeeting(now) : null;
  },

  _registerJoinAction() {
    const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
    const l10nId = "whimsy-action-join-meeting";
    if (globalActions.some(action => action.l10nId == l10nId)) {
      return;
    }
    const service = this;
    const l10n = new Localization(["browser/whimsy.ftl"], true);
    globalActions.push({
      l10nId,
      commandId: "whimsy:join-meeting",
      extraPayload: {},
      icon: "chrome://browser/skin/zen-icons/video-fill.svg",
      get label() {
        const meeting = service.soonMeeting(Date.now(), { joinable: true });
        return l10n.formatValueSync(l10nId, {
          meeting: meeting?.title || l10n.formatValueSync("whimsy-meeting-untitled"),
        });
      },
      isAvailable: win => !win?._whimsyQuickWindow && !!service.soonMeeting(Date.now(), { joinable: true }),
      command: win => service.join(win, service.soonMeeting(Date.now(), { joinable: true })),
    });
  },

  /** Opens the meeting's call in a tab, or switches to the tab already on it. */
  join(win, event) {
    const url = event?.join?.url;
    if (!url || !win) {
      return false;
    }
    if (typeof win.switchToTabHavingURI == "function") {
      win.switchToTabHavingURI(url, true, { inBackground: false, ignoreFragment: "whenComparing" });
    } else {
      win.openTrustedLinkIn(url, "tab");
    }
    return true;
  },

  // ---- formatting ----------------------------------------------------------

  /** "in 12 min", "in 2 hr" style, from Intl (no strings to translate). */
  formatUntil(event, now = Date.now()) {
    const locale = Services.locale.appLocaleAsBCP47;
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "short" });
    const diff = event.start - now;
    if (diff <= 0) {
      return null;
    }
    const minutes = Math.ceil(diff / MINUTE);
    if (minutes < 60) {
      return rtf.format(minutes, "minute");
    }
    const hours = Math.round(diff / HOUR);
    return rtf.format(hours, "hour");
  },

  formatRange(event) {
    const locale = Services.locale.appLocaleAsBCP47;
    const format = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" });
    try {
      return format.formatRange(new Date(event.start), new Date(event.end));
    } catch {
      return `${format.format(new Date(event.start))}–${format.format(new Date(event.end))}`;
    }
  },

  // ---- tests -----------------------------------------------------------------

  testing: {
    /** Replaces the native reader (null = none available; undefined = real). */
    setAppleCalendar(mock) {
      WhimsyNextMeeting._appleOverride = mock;
      WhimsyNextMeeting._generation++;
      WhimsyNextMeeting._sources.delete("apple");
    },
    reset() {
      WhimsyNextMeeting._appleOverride = undefined;
      WhimsyNextMeeting._generation++;
      WhimsyNextMeeting._sources.clear();
      WhimsyNextMeeting._refreshing = null;
    },
  },
};

// ---------------------------------------------------------------------------
// The compact sidebar card (near the top, only while a meeting is close)

const CARD_ID = "whimsy-meeting-card";

const WhimsyNextMeetingCard = {
  attach(win, service) {
    const update = () => this.update(win, service);
    service.addListener(update);
    win.addEventListener("unload", () => service.removeListener(update), { once: true });
    update();
  },

  _ensure(win, service) {
    const doc = win.document;
    let card = doc.getElementById(CARD_ID);
    if (card) {
      return card;
    }
    const anchor = doc.getElementById("zen-sidebar-top-buttons");
    const fallback = doc.getElementById("zen-essentials");
    if (!anchor && !fallback) {
      return null;
    }
    const el = (tag, className, l10nId) => {
      const node = doc.createElement(tag);
      node.className = className;
      if (l10nId) {
        node.setAttribute("data-l10n-id", l10nId);
      }
      return node;
    };
    card = el("div", "", "whimsy-meeting-card");
    card.id = CARD_ID;
    card.setAttribute("role", "group");
    card.hidden = true;
    const text = el("div", "whimsy-meeting-card-text zen-library-row-text");
    text.append(
      el("span", "whimsy-meeting-card-title zen-library-row-title"),
      el("span", "whimsy-meeting-card-when zen-library-row-subtitle"),
      el("span", "whimsy-meeting-card-now zen-library-row-subtitle", "whimsy-meeting-now")
    );
    const join = el("button", "whimsy-meeting-card-join zen-library-filter-button", "whimsy-meeting-join");
    join.addEventListener("click", () => service.join(win, card._event));
    const close = el("button", "whimsy-meeting-card-close", "whimsy-meeting-card-dismiss");
    close.addEventListener("click", () => {
      win._whimsyMeetingDismissed = card._event?.id;
      this.update(win, service);
    });
    card.append(text, join, close);
    if (anchor) {
      anchor.after(card);
    } else {
      fallback.before(card);
    }
    return card;
  },

  update(win, service) {
    if (win.closed) {
      return;
    }
    const doc = win.document;
    const event = service.enabled ? service.cardMeeting() : null;
    const show = !!event && win._whimsyMeetingDismissed != event.id;
    let card = doc.getElementById(CARD_ID);
    if (!show) {
      if (card && !card.hidden) {
        card.hidden = true;
      }
      return;
    }
    card ??= this._ensure(win, service);
    if (!card) {
      return;
    }
    card._event = event;
    const until = service.formatUntil(event);
    const title = card.querySelector(".whimsy-meeting-card-title");
    if (event.title) {
      title.removeAttribute("data-l10n-id");
      title.textContent = event.title;
    } else {
      title.textContent = "";
      doc.l10n.setAttributes(title, "whimsy-meeting-untitled");
    }
    title.title = event.title || "";
    card.querySelector(".whimsy-meeting-card-when").textContent = until || "";
    card.querySelector(".whimsy-meeting-card-when").hidden = !until;
    card.querySelector(".whimsy-meeting-card-now").hidden = !!until;
    card.querySelector(".whimsy-meeting-card-join").hidden = !event.join;
    card.toggleAttribute("whimsy-meeting-live", !until);
    if (card.hidden) {
      card.hidden = false;
    }
  },
};
