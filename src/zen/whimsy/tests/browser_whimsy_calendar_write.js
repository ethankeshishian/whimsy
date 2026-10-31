/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/native1: Cmd+K's "Add to Calendar" saves the event straight into
// macOS Calendar through the EventKit component (nsIWhimsyCalendar
// requestWriteAccess/addEvent), asking for write-only access the first
// time, and falls back to an .ics file when access is denied, the component
// is missing or saving fails. The OS permission can't be granted on a test
// machine, so nsIWhimsyCalendar is mocked here; the real component's
// checks are in browser_whimsy_native_services.js (whimsy-native).

const { WhimsyVerbs, parseEvent } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVerbs.sys.mjs");

const NOW = new Date(2026, 9, 30, 9, 0);
const TEXT = "Team sync Nov 3 at 3pm";

function subject(text = TEXT) {
  return {
    kind: "selection",
    text,
    markdown: text,
    url: "https://example.com/invite",
    title: "Invite",
    event: parseEvent(text, NOW),
  };
}

// A stand-in for nsIWhimsyCalendar: `status` as macOS would report it,
// `grant` what the permission prompt answers, `save` what saving answers.
function mockCalendar({ status = "notDetermined", grant = "writeOnly", save = [true, "EVENT-1"] } = {}) {
  const calls = [];
  return {
    calls,
    get authorizationStatus() {
      return status;
    },
    requestWriteAccess(callback) {
      calls.push({ what: "request" });
      Promise.resolve().then(() => {
        if (grant) {
          status = grant;
          callback(true, grant);
        } else {
          status = "denied";
          callback(false, "denied");
        }
      });
    },
    addEvent(json, callback) {
      calls.push({ what: "add", event: JSON.parse(json) });
      Promise.resolve().then(() => callback(...save));
    },
  };
}

// Records files launched and toasts shown; `service` stands in for the
// component (null: not built).
function stub(service) {
  const effects = { files: [], toasts: [] };
  const originals = {
    launchFile: WhimsyVerbs.launchFile,
    calendarService: WhimsyVerbs.calendarService,
    showToast: gZenUIManager.showToast,
  };
  WhimsyVerbs.launchFile = path => effects.files.push(path);
  WhimsyVerbs.calendarService = () => service;
  gZenUIManager.showToast = id => effects.toasts.push(id);
  effects.restore = async () => {
    WhimsyVerbs.launchFile = originals.launchFile;
    WhimsyVerbs.calendarService = originals.calendarService;
    gZenUIManager.showToast = originals.showToast;
    for (const path of effects.files) {
      await IOUtils.remove(path, { ignoreAbsent: true });
    }
  };
  return effects;
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.selection-verbs", true]] });
});

add_task(async function test_first_use_asks_then_saves() {
  const calendar = mockCalendar();
  const effects = stub(calendar);
  try {
    ok(await WhimsyVerbs.runVerb(window, "calendar", subject()), "The verb ran");
    Assert.deepEqual(
      calendar.calls.map(c => c.what),
      ["request", "add"],
      "Asked for write access once, then added the event"
    );
    const { event } = calendar.calls[1];
    is(event.title, "Team sync", "Titled from the selection");
    is(event.allDay, false, "A timed event");
    const start = new Date(event.start);
    is(start.getMonth(), 10, "Starts in November");
    is(start.getDate(), 3, "...on the 3rd");
    is(start.getHours(), 15, "...at 3pm");
    is(event.end - event.start, 3600 * 1000, "An hour long by default");
    ok(event.notes.includes(TEXT) && event.notes.includes("https://example.com/invite"), "Notes hold the text and page");
    is(event.url, "https://example.com/invite", "The page is the event's link");
    Assert.deepEqual(effects.toasts, ["whimsy-verb-calendar-added-toast"], "A toast confirms it");
    is(effects.files.length, 0, "No .ics file");
  } finally {
    await effects.restore();
  }
});

add_task(async function test_already_allowed() {
  for (const status of ["writeOnly", "fullAccess"]) {
    const calendar = mockCalendar({ status });
    const effects = stub(calendar);
    try {
      await WhimsyVerbs.runVerb(window, "calendar", subject());
      Assert.deepEqual(calendar.calls.map(c => c.what), ["add"], `${status}: no prompt, straight to saving`);
      is(effects.files.length, 0, `${status}: no .ics file`);
    } finally {
      await effects.restore();
    }
  }
});

add_task(async function test_all_day() {
  const calendar = mockCalendar({ status: "writeOnly" });
  const effects = stub(calendar);
  try {
    await WhimsyVerbs.runVerb(window, "calendar", subject("Offsite Nov 12"));
    const { event } = calendar.calls[0];
    ok(event.allDay, "No time: an all-day event");
    is(new Date(event.end).getDate(), 13, "Ends the next day, as iCalendar does (the component makes it inclusive)");
  } finally {
    await effects.restore();
  }
});

add_task(async function test_falls_back_to_ics() {
  const cases = [
    ["denied now", mockCalendar({ grant: null }), ["request"]],
    ["denied before", mockCalendar({ status: "denied" }), []],
    ["restricted", mockCalendar({ status: "restricted" }), []],
    ["saving failed", mockCalendar({ status: "fullAccess", save: [false, "save-failed"] }), ["add"]],
    ["no component", null, null],
  ];
  for (const [name, calendar, expected] of cases) {
    const effects = stub(calendar);
    try {
      ok(await WhimsyVerbs.runVerb(window, "calendar", subject()), `${name}: the verb still ran`);
      if (expected) {
        Assert.deepEqual(calendar.calls.map(c => c.what), expected, `${name}: calls`);
      }
      is(effects.files.length, 1, `${name}: an .ics file opens instead`);
      const ics = await IOUtils.readUTF8(effects.files[0]);
      ok(ics.includes("SUMMARY:Team sync"), `${name}: the file holds the event`);
      Assert.deepEqual(effects.toasts, [], `${name}: no "Added" toast`);
    } finally {
      await effects.restore();
    }
  }
});

add_task(async function test_component_errors_fall_back() {
  const effects = stub({
    get authorizationStatus() {
      throw new Error("boom");
    },
  });
  try {
    ok(!(await WhimsyVerbs.addToSystemCalendar(subject().event)), "An error answers false");
    await WhimsyVerbs.runVerb(window, "calendar", subject());
    is(effects.files.length, 1, "...and the verb opens an .ics");
  } finally {
    await effects.restore();
  }
});
