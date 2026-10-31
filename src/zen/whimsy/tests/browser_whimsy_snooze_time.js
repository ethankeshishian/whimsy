/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave8/snooze (W8-37): where each Snooze preset lands, and what the
// picker's field reads, from a pinned "now".

const T = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySnoozeTime.sys.mjs");

// Wednesday, October 28 2026, 2:10 PM local time.
const NOW = new Date(2026, 9, 28, 14, 10);

function stamp(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

add_task(function presets_land_where_they_say() {
  const at = Object.fromEntries(T.resolvePresets(NOW).map(p => [p.key, p]));
  Assert.deepEqual(Object.keys(at), T.PRESET_KEYS, "Five presets, in order");
  is(stamp(at["later-today"].at), "2026-10-28 17:30", "Later Today: three hours on, to the next half hour");
  is(stamp(at.tonight.at), "2026-10-28 20:00", "Tonight: 8 PM");
  is(stamp(at.tomorrow.at), "2026-10-29 09:00", "Tomorrow: 9 AM");
  is(stamp(at.weekend.at), "2026-10-31 09:00", "This Weekend: Saturday 9 AM");
  is(stamp(at["next-week"].at), "2026-11-02 09:00", "Next Week: Monday 9 AM");
  ok(T.resolvePresets(NOW).every(p => p.available), "All make sense on a Wednesday afternoon");
});

add_task(function late_presets_stay_but_grey_out() {
  const late = new Date(2026, 9, 31, 21, 0); // Saturday 9 PM
  const at = Object.fromEntries(T.resolvePresets(late).map(p => [p.key, p]));
  ok(!at["later-today"].available, "Later Today is too late at 9 PM");
  ok(!at.tonight.available, "So is Tonight");
  ok(at.weekend.nextWeekend, "On a weekend it's the next one");
  is(stamp(at.weekend.at), "2026-11-07 09:00", "...next Saturday");
  is(stamp(at["next-week"].at), "2026-11-02 09:00", "Next Week is still Monday");
  const monday = new Date(2026, 10, 2, 10, 0);
  is(stamp(T.resolvePreset("next-week", monday).at), "2026-11-09 09:00", "On a Monday, next Monday");
});

add_task(function reads_typed_times() {
  const cases = {
    "2h": "2026-10-28 16:10",
    "in 3 days": "2026-10-31 14:10",
    "in an hour": "2026-10-28 15:10",
    "90 min": "2026-10-28 15:40",
    fri: "2026-10-30 09:00",
    "fri 2pm": "2026-10-30 14:00",
    "next fri": "2026-11-06 09:00",
    "tom 3pm": "2026-10-29 15:00",
    "tomorrow morning": "2026-10-29 09:00",
    tonight: "2026-10-28 20:00",
    noon: "2026-10-29 12:00",
    "at 3": "2026-10-28 15:00",
    "9": "2026-10-29 09:00",
    "15:30": "2026-10-28 15:30",
    "3:30 pm": "2026-10-28 15:30",
    "nov 12": "2026-11-12 09:00",
    "12 nov 9am": "2026-11-12 09:00",
    "11/12": "2026-11-12 09:00",
    "dec 25th": "2026-12-25 09:00",
    "oct 1": "2027-10-01 09:00",
    weekend: "2026-10-31 09:00",
    "next week": "2026-11-02 09:00",
    "later today": "2026-10-28 17:30",
    "wed 5pm": "2026-10-28 17:00",
    "wed 1pm": "2026-11-04 13:00",
  };
  for (const [text, want] of Object.entries(cases)) {
    const got = T.parse(text, NOW);
    ok(got, `“${text}” is read`);
    is(got && stamp(got.at), want, `“${text}” → ${want}`);
  }
  for (const text of ["", "banana", "next", "feb 30", "tomorrow fri", "3pm 4pm"]) {
    is(T.parse(text, NOW), null, `“${text}” isn't guessed at`);
  }
  ok(T.parse("today 9am", NOW).past, "A time already gone is flagged, not snoozed");
});

add_task(function words_for_the_toast_and_rows() {
  const locales = ["en-US"];
  Assert.deepEqual(T.whenArgs(new Date(2026, 9, 28, 20), NOW, locales).when, "today");
  Assert.deepEqual(T.whenArgs(new Date(2026, 9, 29, 9), NOW, locales).when, "tomorrow");
  const sat = T.whenArgs(new Date(2026, 9, 31, 9), NOW, locales);
  is(sat.when, "week", "Within a week, by weekday");
  is(sat.day, "Saturday");
  is(sat.time.replace(/\s/g, " "), "9:00 AM");
  is(T.whenArgs(new Date(2026, 10, 9, 9), NOW, locales).when, "later", "Further off, by date");
  is(T.relative(new Date(NOW.getTime() + 3 * 3600 * 1000), NOW, locales), "in 3 hours");
  ok(T.presetMatches("tomorrow", "tom"), "“tom” finds Tomorrow");
  ok(T.presetMatches("tonight", "to"), "“to” finds Tonight too");
  ok(!T.presetMatches("later-today", "fri"), "“fri” doesn't find Later Today");
});
