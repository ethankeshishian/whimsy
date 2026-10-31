/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/native1 (whimsy-native): the real macOS components, built from
// src/zen/whimsy/calendar and src/zen/whimsy/focus. Nothing here may show
// a permission prompt or touch the person's calendar: access is only read,
// events are only offered when macOS would refuse them, and the Focus
// watch runs on a temporary directory. The front ends are tested with
// mocks in browser_whimsy_calendar_write.js and browser_whimsy_macos_focus.js.

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

add_task(async function test_focus_component() {
  ok(Cc["@whimsy/focus;1"], "The Focus component is built (focus/ in moz.build's DIRS)");
  const focus = Cc["@whimsy/focus;1"].getService(Ci.nsIWhimsyFocus);
  const entitled = focus.hasFocusEntitlement;
  is(typeof entitled, "boolean", "Knows whether it has the Communication Notifications entitlement");
  ok(["focused", "notFocused", "unavailable"].includes(focus.systemFocusStatus), "INFocusStatusCenter answer");
  if (!entitled) {
    // Whimsy's ad-hoc signature can't carry the entitlement: Apple's API is
    // left alone.
    is(focus.systemFocusStatus, "unavailable", "No entitlement: no system answer");
    is(focus.authorizationStatus, "unavailable", "...and no authorization to ask for");
    const answered = TestUtils.topicObserved("whimsy-focus-changed", (subject, data) => data == "system");
    focus.requestAuthorization();
    await answered;
    ok(true, "requestAuthorization answers without a prompt");
  }
});

add_task(async function test_focus_watch() {
  const focus = Cc["@whimsy/focus;1"].getService(Ci.nsIWhimsyFocus);
  const dir = PathUtils.join(PathUtils.tempDir, `whimsy-focus-watch-${Date.now()}`);
  await IOUtils.makeDirectory(dir);
  let changes = 0;
  const observer = (subject, topic, data) => {
    if (data == "database") {
      changes++;
    }
  };
  Services.obs.addObserver(observer, "whimsy-focus-changed");
  try {
    // NS_ERROR_INVALID_ARG shares 0x80070057 with NS_ERROR_ILLEGAL_VALUE, whose
    // name XPConnect prints, so compare the result code, not the message.
    Assert.throws(() => focus.startWatching(""), e => e.result == Cr.NS_ERROR_INVALID_ARG, "An empty path is refused");
    focus.startWatching(dir);
    ok(focus.watching, "Watching the directory");
    // FSEvents takes a moment to start; write until it reports.
    let n = 0;
    await TestUtils.waitForCondition(async () => {
      if (!changes) {
        await IOUtils.writeJSON(PathUtils.join(dir, "Assertions.json"), { data: [{ storeAssertionRecords: [], n: n++ }] });
      }
      return changes > 0;
    }, "A change in the directory notifies whimsy-focus-changed (database)");

    focus.stopWatching();
    ok(!focus.watching, "Stopped");
    focus.stopWatching();
    ok(true, "Stopping twice is fine");
  } finally {
    focus.stopWatching();
    Services.obs.removeObserver(observer, "whimsy-focus-changed");
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
  }
});
