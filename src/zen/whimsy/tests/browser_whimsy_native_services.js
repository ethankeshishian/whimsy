/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/native1 (whimsy-native): the real macOS calendar component, built
// from src/zen/whimsy/calendar. Nothing here may show a permission prompt or
// touch the person's calendar: access is only read, and events are only
// offered when macOS would refuse them. The front end is tested with mocks
// in browser_whimsy_calendar_write.js.

const STATUSES = ["notDetermined", "restricted", "denied", "fullAccess", "writeOnly"];

function answer(fn) {
  return new Promise(resolve => fn((ok, result) => resolve({ ok, result })));
}

add_task(async function test_calendar_component() {
  ok(Cc["@whimsy/calendar;1"], "The EventKit component is built (calendar/ in moz.build's DIRS)");
  const calendar = Cc["@whimsy/calendar;1"].getService(Ci.nsIWhimsyCalendar);
  const status = calendar.authorizationStatus;
  ok(STATUSES.includes(status), `Authorization status is one of macOS's (${status})`);
  ok(typeof calendar.requestWriteAccess == "function", "requestWriteAccess exists");

  // Bad input is refused before anything else: no prompt, no write.
  for (const bad of ["", "not json", "[]", '{"title":"x"}', '{"title":"x","start":2000,"end":1000}', '{"start":"a","end":"b"}']) {
    const { ok: saved, result } = await answer(cb => calendar.addEvent(bad, cb));
    ok(!saved, `${JSON.stringify(bad)} isn't saved`);
    is(result, "invalid-event", "...as an invalid event");
  }

  if (status == "fullAccess" || status == "writeOnly") {
    // Already allowed on this machine: asking again answers at once, with
    // no prompt. (No event is added: this is someone's real calendar.)
    const { ok: allowed, result } = await answer(cb => calendar.requestWriteAccess(cb));
    ok(allowed, "Write access already granted answers yes");
    is(result, status, "...with the status");
    return;
  }
  const start = Date.now() + 86400e3;
  const event = JSON.stringify({ title: "Whimsy test", start, end: start + 3600e3, allDay: false });
  const { ok: saved, result } = await answer(cb => calendar.addEvent(event, cb));
  ok(!saved, "Without access a valid event isn't saved");
  is(result, "not-authorized", "...because it isn't authorized");
});
