/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Next meeting in the sidebar (whimsy.feature.next-meeting). The JS layer
// with a mocked nsIWhimsyCalendar (the real EventKit reader needs a Mac with
// calendars and a permission prompt, so it's verified by hand) and an .ics
// fixture standing in for a Google Calendar secret address.

const {
  WhimsyNextMeeting,
  findJoinLink,
  joinLinkFor,
  parseICS,
  occurrencesBetween,
  wallClockToMs,
  normalizeCalendarUrl,
  labelForCalendarUrl,
} = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyNextMeeting.sys.mjs");

const FEATURE = "whimsy.feature.next-meeting";
const APPLE = "whimsy.next-meeting.apple-calendar";
const GOOGLE = "whimsy.next-meeting.google-calendars";
const CARD = "whimsy.next-meeting.sidebar-card";
const MIN = 60 * 1000;
const FIXTURE =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_calendar.sjs";

function makeAppleMock({ status = "notDetermined", grant = true, events = [] } = {}) {
  return {
    requests: 0,
    reads: 0,
    status,
    get authorizationStatus() {
      return this.status;
    },
    requestAccess(callback) {
      this.requests++;
      if (this.status == "notDetermined") {
        this.status = grant ? "fullAccess" : "denied";
      }
      const ok = this.status == "fullAccess";
      Promise.resolve().then(() => callback(ok, this.status));
    },
    upcomingEvents(hours, callback) {
      this.reads++;
      Promise.resolve().then(() => callback(true, JSON.stringify(events)));
    },
  };
}

function resetAll() {
  for (const pref of [FEATURE, APPLE, GOOGLE, CARD]) {
    Services.prefs.clearUserPref(pref);
  }
  WhimsyNextMeeting.testing.reset();
}

add_setup(async function () {
  resetAll();
  // Normally done by Whimsy.initWindow; idempotent.
  WhimsyNextMeeting.initWindow(window);
  registerCleanupFunction(resetAll);
});

add_task(async function test_join_link_detection() {
  is(findJoinLink("Join: https://meet.google.com/abc-defg-hij.").url, "https://meet.google.com/abc-defg-hij",
    "A Meet link loses trailing punctuation");
  const zoom = findJoinLink('<a href="https://us02web.zoom.us/j/123456?pwd=abc&amp;x=1">Zoom</a>');
  is(zoom.service, "zoom", "A Zoom link inside HTML is found");
  is(zoom.url, "https://us02web.zoom.us/j/123456?pwd=abc&x=1", "HTML entities are decoded and the tag is cut off");
  is(
    findJoinLink("<https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d>").service,
    "teams",
    "A Teams link in angle brackets is found"
  );
  is(
    findJoinLink(
      "https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fteams.microsoft.com%2Fl%2Fmeetup-join%2F19abc&data=05"
    ).url,
    "https://teams.microsoft.com/l/meetup-join/19abc",
    "Outlook safelinks are unwrapped"
  );
  is(findJoinLink("Room 4B, https://example.com/agenda"), null, "Ordinary links aren't join links");
  is(findJoinLink(""), null, "Empty text has no link");
  is(
    findJoinLink("Zoom https://zoom.us/j/1 or Meet https://meet.google.com/aaa-bbbb-ccc").service,
    "zoom",
    "The first link in the text wins"
  );
  is(
    joinLinkFor({
      url: "https://calendar.google.com/event?eid=1",
      location: "https://meet.google.com/aaa-bbbb-ccc",
      notes: "https://zoom.us/j/9",
    }).service,
    "meet",
    "A non-call URL field is skipped; the location comes before the notes"
  );
  is(
    joinLinkFor({ conference: "https://meet.google.com/xyz-abcd-efg", notes: "https://zoom.us/j/9" }).service,
    "meet",
    "Google's conference field comes before the notes"
  );
});

add_task(async function test_ics_recurrence_and_time_zones() {
  is(wallClockToMs({ y: 2026, m: 7, d: 1, h: 9 }, "America/New_York"), Date.UTC(2026, 6, 1, 13), "EDT");
  is(wallClockToMs({ y: 2026, m: 12, d: 1, h: 9 }, "America/New_York"), Date.UTC(2026, 11, 1, 14), "EST");

  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:w1",
    "DTSTART;TZID=America/Los_Angeles:20260302T100000",
    "DTEND;TZID=America/Los_Angeles:20260302T103000",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE",
    "EXDATE;TZID=America/Los_Angeles:20260311T100000",
    "SUMMARY:Standup\\, team",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:w1",
    "RECURRENCE-ID;TZID=America/Los_Angeles:20260309T100000",
    "DTSTART;TZID=America/Los_Angeles:20260309T140000",
    "DTEND;TZID=America/Los_Angeles:20260309T143000",
    "SUMMARY:Standup moved",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:m1",
    "DTSTART:20260105T150000Z",
    "DTEND:20260105T160000Z",
    "RRULE:FREQ=MONTHLY;BYDAY=2MO;COUNT=12",
    "SUMMARY:Monthly",
    "DESCRIPTION:Long line that is fol",
    " ded https://zoom.us/j/555",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const events = parseICS(ics);
  is(events.length, 3, "Every VEVENT is parsed");
  is(events[0].title, "Standup, team", "Escaped commas are unescaped");
  ok(events[2].notes.includes("folded https://zoom.us/j/555"), "Folded lines are unfolded");

  const week = occurrencesBetween(events, { from: Date.UTC(2026, 2, 8), to: Date.UTC(2026, 2, 12) });
  const at = title => week.filter(e => e.title == title).map(e => new Date(e.start).toISOString());
  Assert.deepEqual(at("Standup moved"), ["2026-03-09T21:00:00.000Z"], "A moved occurrence keeps its new time (PDT)");
  Assert.deepEqual(at("Standup, team"), [], "The moved and excluded occurrences are gone");
  Assert.deepEqual(at("Monthly"), ["2026-03-09T15:00:00.000Z"], "BYDAY=2MO picks the second Monday");

  const before = occurrencesBetween(events, { from: Date.UTC(2026, 2, 1), to: Date.UTC(2026, 2, 6) });
  Assert.deepEqual(
    before.filter(e => e.title == "Standup, team").map(e => new Date(e.start).toISOString()),
    ["2026-03-02T18:00:00.000Z", "2026-03-04T18:00:00.000Z"],
    "Before DST the same wall-clock time is an hour later in UTC"
  );
});

add_task(async function test_calendar_addresses() {
  is(normalizeCalendarUrl("http://calendar.google.com/x/basic.ics"), null, "A secret address is never fetched over http");
  is(normalizeCalendarUrl("not a url"), null, "Garbage is refused");
  const webcal = normalizeCalendarUrl("webcal://calendar.google.com/calendar/ical/a%40b.com/private-x/basic.ics");
  ok(webcal.startsWith("https://"), "webcal:// becomes https://");
  is(labelForCalendarUrl(webcal), "a@b.com", "The account's email labels it");

  ok(!WhimsyNextMeeting.addGoogleCalendar("http://example.com/a.ics"), "Adding an http address fails");
  ok(WhimsyNextMeeting.addGoogleCalendar(webcal), "Adding a secret address works");
  ok(WhimsyNextMeeting.addGoogleCalendar(webcal), "Adding it twice is fine");
  is(WhimsyNextMeeting.googleCalendars.length, 1, "...and doesn't duplicate it");
  WhimsyNextMeeting.removeGoogleCalendar(WhimsyNextMeeting.googleCalendars[0].id);
  is(WhimsyNextMeeting.googleCalendars.length, 0, "Removing it works");
  resetAll();
});

add_task(async function test_apple_access_only_when_turned_on() {
  const mock = makeAppleMock({ status: "notDetermined" });
  WhimsyNextMeeting.testing.setAppleCalendar(mock);
  await WhimsyNextMeeting.refresh({ force: true, apple: true });
  is(mock.requests, 0, "Nothing asks for calendar access while Apple Calendar is off");
  is(WhimsyNextMeeting.appleStatus, "off", "Apple Calendar starts off");

  Services.prefs.setBoolPref(APPLE, true);
  await TestUtils.waitForCondition(() => mock.requests == 1, "Turning it on asks for access once");
  await TestUtils.waitForCondition(() => mock.reads > 0, "...then reads the events");

  // A later refresh (the timer, the Library opening) never asks again.
  await WhimsyNextMeeting.refresh({ force: true, apple: true });
  is(mock.requests, 1, "Refreshing doesn't ask again");
  resetAll();

  // Denied: refreshes stay quiet and the Library offers System Settings.
  const denied = makeAppleMock({ status: "denied" });
  WhimsyNextMeeting.testing.setAppleCalendar(denied);
  Services.prefs.setBoolPref(APPLE, true);
  await TestUtils.waitForCondition(() => denied.requests == 1, "Turning it on asks (macOS answers no at once)");
  await WhimsyNextMeeting.refresh({ force: true, apple: true });
  is(denied.reads, 0, "Nothing is read without access");
  is(WhimsyNextMeeting.appleStatus, "denied", "The status says it was denied");
  resetAll();

  // No native reader at all (another platform): nothing breaks.
  WhimsyNextMeeting.testing.setAppleCalendar(null);
  Services.prefs.setBoolPref(APPLE, true);
  is(WhimsyNextMeeting.appleStatus, "unavailable", "Without the reader Apple Calendar is unavailable");
  Assert.deepEqual(WhimsyNextMeeting.upcoming(), [], "...and lists nothing");
  resetAll();
});

async function setUpSources(anchor) {
  const apple = makeAppleMock({
    status: "fullAccess",
    events: [
      // Also in the Google fixture: listed once.
      {
        id: "a1",
        title: "Shared meeting",
        start: anchor + 240 * MIN,
        end: anchor + 270 * MIN,
        allDay: false,
        cancelled: false,
        declined: false,
        calendar: "Work",
        color: "#3366CC",
      },
      {
        id: "a2",
        title: "Apple first",
        start: anchor + 60 * MIN,
        end: anchor + 90 * MIN,
        url: "https://zoom.us/j/42",
        allDay: false,
        cancelled: false,
        declined: false,
        account: "iCloud",
      },
      {
        id: "a3",
        title: "Declined on the Mac",
        start: anchor + 30 * MIN,
        end: anchor + 60 * MIN,
        allDay: false,
        cancelled: false,
        declined: true,
      },
    ],
  });
  WhimsyNextMeeting.testing.setAppleCalendar(apple);
  Services.prefs.setStringPref(
    GOOGLE,
    JSON.stringify([
      { id: "work", url: `${FIXTURE}?anchor=${anchor}`, label: "me@example.com" },
      { id: "gone", url: `${FIXTURE}?broken`, label: "old@example.com" },
    ])
  );
  Services.prefs.setBoolPref(APPLE, true);
  await TestUtils.waitForCondition(
    () =>
      apple.reads > 0 &&
      WhimsyNextMeeting.sourceState("google:work")?.events?.length &&
      WhimsyNextMeeting.sourceState("google:gone"),
    "Every source has been read"
  );
  return apple;
}

add_task(async function test_multiple_sources_ordering() {
  const anchor = Math.floor(Date.now() / MIN) * MIN;
  await setUpSources(anchor);

  const upcoming = WhimsyNextMeeting.upcoming();
  Assert.deepEqual(
    upcoming.map(e => e.title),
    ["Design review", "Apple first", "Daily standup", "Zoom 1:1", "Shared meeting"],
    "Soonest first across sources; declined, all-day and finished meetings left out; duplicates once"
  );
  Assert.deepEqual(
    upcoming.map(e => e.join?.service ?? null),
    ["meet", "zoom", "teams", "zoom", null],
    "Each meeting's call link is found where its calendar put it"
  );
  is(upcoming[2].start, anchor + 120 * MIN, "A daily repeating meeting shows today's occurrence");
  is(upcoming[4].source, "apple", "The duplicate keeps Apple Calendar's copy");
  is(WhimsyNextMeeting.next().title, "Design review", "The next meeting is the soonest");
  ok(WhimsyNextMeeting.sourceState("google:gone").error, "A broken address records an error");
  ok(!WhimsyNextMeeting.sourceState("google:work").error, "...without affecting the others");

  // Refreshing again within 5 minutes doesn't fetch the Google addresses.
  const fetchedAt = WhimsyNextMeeting.sourceState("google:work").fetchedAt;
  await WhimsyNextMeeting.refresh();
  is(WhimsyNextMeeting.sourceState("google:work").fetchedAt, fetchedAt, "Google is read at most every 5 minutes");

  // Removing a calendar drops its meetings straight away.
  Services.prefs.setStringPref(
    GOOGLE,
    JSON.stringify(JSON.parse(Services.prefs.getStringPref(GOOGLE)).filter(c => c.id != "work"))
  );
  Assert.deepEqual(
    WhimsyNextMeeting.upcoming().map(e => e.title),
    ["Apple first", "Shared meeting"],
    "Only Apple Calendar's meetings remain"
  );
  resetAll();
});

add_task(async function test_sidebar_card_and_join() {
  const anchor = Math.floor(Date.now() / MIN) * MIN;
  await setUpSources(anchor);
  is(WhimsyNextMeeting.cardMeeting()?.title, "Design review", "A meeting 10 minutes away gets the card");

  const card = document.getElementById("whimsy-meeting-card");
  if (!card) {
    ok(!document.getElementById("zen-sidebar-top-buttons"), "No card only when the sidebar has no top");
    resetAll();
    return;
  }
  await TestUtils.waitForCondition(() => !card.hidden, "The card shows near the top of the sidebar");
  is(card.querySelector(".whimsy-meeting-card-title").textContent, "Design review", "It names the meeting");
  ok(card.querySelector(".whimsy-meeting-card-when").textContent.length, "It says how long until it starts");
  ok(!card.querySelector(".whimsy-meeting-card-join").hidden, "It has a Join button");

  const opened = [];
  const original = window.switchToTabHavingURI;
  window.switchToTabHavingURI = url => opened.push(String(url));
  try {
    card.querySelector(".whimsy-meeting-card-join").click();
  } finally {
    window.switchToTabHavingURI = original;
  }
  Assert.deepEqual(opened, ["https://meet.google.com/abc-defg-hij"], "Join opens the call (or its tab)");

  card.querySelector(".whimsy-meeting-card-close").click();
  ok(card.hidden, "Hiding it lasts until the next meeting");
  delete window._whimsyMeetingDismissed;

  Services.prefs.setBoolPref(CARD, false);
  is(WhimsyNextMeeting.cardMeeting(), null, "With the card setting off there's no card");
  ok(card.hidden, "...and none shows");
  Services.prefs.clearUserPref(CARD);
  await TestUtils.waitForCondition(() => !card.hidden, "Turning it back on shows it again");
  resetAll();
  await TestUtils.waitForCondition(() => card.hidden, "No calendars, no card");
});

add_task(async function test_library_section() {
  const lib = document.querySelector("zen-library");
  if (!lib?.zenLibrarySections) {
    ok(true, "No <zen-library> in this window; nothing to check");
    return;
  }
  ok("whimsy-next-meeting" in lib.zenLibrarySections, "Meetings is in the Library rail by default");
});

add_task(async function test_switch_off() {
  const anchor = Math.floor(Date.now() / MIN) * MIN;
  await setUpSources(anchor);
  ok(WhimsyNextMeeting.upcoming().length, "Meetings are listed");

  Services.prefs.setBoolPref(FEATURE, false);
  Assert.deepEqual(WhimsyNextMeeting.upcoming(), [], "With the switch off nothing is listed");
  is(WhimsyNextMeeting.cardMeeting(), null, "...and there's no card");
  const card = document.getElementById("whimsy-meeting-card");
  ok(!card || card.hidden, "The card is hidden");
  const lib = document.querySelector("zen-library");
  if (lib?.zenLibrarySections) {
    await TestUtils.waitForCondition(
      () => !("whimsy-next-meeting" in lib.zenLibrarySections),
      "The Meetings tab leaves the Library"
    );
  }
  Services.prefs.clearUserPref(FEATURE);
  if (lib?.zenLibrarySections) {
    await TestUtils.waitForCondition(
      () => "whimsy-next-meeting" in lib.zenLibrarySections,
      "Turning it back on restores the tab"
    );
  }
  resetAll();
});
