/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/native1: Whimsy's own unprompted toasts wait while a macOS Focus is
// on (whimsy.feature.macos-focus). The test machine's real Focus is never
// read: the native component (nsIWhimsyFocus) is mocked and Focus's
// database is a temporary directory holding an Assertions.json shaped like
// macOS's. The real component's FSEvents watch is checked in
// browser_whimsy_native_services.js (whimsy-native).

const { WhimsyFocus, focusFromAssertions } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyFocus.sys.mjs"
);
const { WhimsySeasons } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySeasons.sys.mjs");
const { WhimsySeasonToast } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySeasonToast.sys.mjs");
const { WhimsyDelight } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyDelight.sys.mjs");

const APPLE_EPOCH_MS = 978307200000;
const SEEN_PREF = "whimsy.seasons.last-toast";
const DND = "com.apple.donotdisturb.mode.default";
const WORK = "com.apple.focus.work";

const originalNative = WhimsyFocus.native;
const originalNow = WhimsySeasons._now;
let dir;

// One Focus assertion, as Assertions.json stores it.
function record(mode, endMs = null) {
  const details = { assertionDetailsIdentifier: "com.apple.focus.activity-manager", assertionDetailsModeIdentifier: mode };
  if (endMs != null) {
    details.assertionDetailsUserVisibleEndDate = (endMs - APPLE_EPOCH_MS) / 1000;
  }
  return { assertionUUID: Services.uuid.generateUUID().toString(), assertionDetails: details };
}

// What macOS writes: the active assertions, and the ended ones it keeps.
function assertions(records) {
  const ended = [{ invalidationAssertion: record(WORK), invalidationReason: "user-changed-state" }];
  return { data: [{ storeAssertionRecords: records, storeInvalidationRecords: ended }] };
}

async function writeFocus(records) {
  await IOUtils.writeJSON(PathUtils.join(dir, "Assertions.json"), assertions(records));
}

function mockNative(system = "unavailable") {
  return {
    systemFocusStatus: system,
    watched: [],
    stopped: 0,
    startWatching(path) {
      this.watched.push(path);
    },
    stopWatching() {
      this.stopped++;
    },
  };
}

// Starts WhimsyFocus over again with `native` and the test's directory.
async function fresh(native = mockNative()) {
  WhimsyFocus._reset();
  WhimsyFocus.native = () => native;
  WhimsyFocus._databaseDir = dir;
  WhimsyFocus.init();
  await WhimsyFocus.ready;
  return native;
}

// macOS changed Focus: the native watcher's signal.
async function focusChanged() {
  Services.obs.notifyObservers(null, WhimsyFocus.NATIVE_TOPIC, "database");
  // The read is async; wait for the state it lands.
  await WhimsyFocus.refresh();
}

add_setup(async function () {
  dir = PathUtils.join(PathUtils.tempDir, `whimsy-focus-${Date.now()}`);
  await IOUtils.makeDirectory(dir);
  await SpecialPowers.pushPrefEnv({ set: [[WhimsyFocus.FEATURE_PREF, true]] });
  registerCleanupFunction(async () => {
    WhimsyFocus._reset();
    WhimsyFocus.native = originalNative;
    WhimsyFocus._databaseDir = null;
    WhimsyFocus.init();
    WhimsySeasons._now = originalNow;
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
  });
});

add_task(function test_reading_assertions() {
  const now = Date.UTC(2026, 9, 30, 18);
  const empty = { focused: false, mode: null, until: null };
  Assert.deepEqual(focusFromAssertions(assertions([]), now), empty, "No assertions: no Focus");
  Assert.deepEqual(
    focusFromAssertions({ data: [{ storeInvalidationRecords: [] }] }, now),
    empty,
    "Only ended ones (what this machine's file looks like most of the time)"
  );
  Assert.deepEqual(focusFromAssertions(assertions([record(DND)]), now), { focused: true, mode: DND, until: null }, "Do Not Disturb, no end");
  is(focusFromAssertions(assertions([record(DND, now - 1000)]), now).focused, false, "One that has ended doesn't count");
  Assert.deepEqual(
    focusFromAssertions(assertions([record(WORK, now + 7200e3), record(DND, now + 3600e3)]), now),
    { focused: true, mode: WORK, until: now + 3600e3 },
    "Two on: the first one's mode, the soonest end"
  );
  for (const bad of [null, "x", {}, { data: "x" }, { data: [null] }, { data: [{ storeAssertionRecords: [null, 5, "x"] }] }]) {
    Assert.deepEqual(focusFromAssertions(bad, now), empty, `Unexpected shape ${JSON.stringify(bad)}: no Focus`);
  }
});

add_task(async function test_database_and_held_toast() {
  await writeFocus([record(DND)]);
  const native = await fresh();
  Assert.deepEqual(native.watched, [dir], "Watches Focus's database directory");
  ok(WhimsyFocus.focused && WhimsyFocus.quiet, "Focus is on");
  is(WhimsyFocus.state.source, "database", "...read from the database");
  is(WhimsyFocus.state.mode, DND, "...Do Not Disturb");

  const shown = [];
  ok(WhimsyFocus.holdToast(window, "test", w => shown.push(w)), "A toast waits");
  ok(WhimsyFocus.holdToast(window, "test", w => shown.push(w)), "Asking twice...");
  is(shown.length, 0, "Nothing shown yet");

  const state = TestUtils.topicObserved(WhimsyFocus.STATE_TOPIC);
  await writeFocus([]);
  await focusChanged();
  const [, data] = await state;
  is(data, "off", "whimsy-focus-state says off");
  Assert.deepEqual(shown, [window], "...the held toast shows once, in its window");
  ok(!WhimsyFocus.holdToast(window, "test", () => ok(false, "not held")), "Without Focus, toasts don't wait");
});

add_task(async function test_switch_off() {
  await writeFocus([record(WORK)]);
  const native = await fresh();
  ok(WhimsyFocus.quiet, "Focus is on");
  const shown = [];
  WhimsyFocus.holdToast(window, "test", w => shown.push(w));

  await SpecialPowers.pushPrefEnv({ set: [[WhimsyFocus.FEATURE_PREF, false]] });
  ok(!WhimsyFocus.quiet, "Switch off: toasts don't wait");
  is(shown.length, 1, "...and the waiting one shows");
  ok(native.stopped > 0, "...and the watch stops");
  ok(!WhimsyFocus.holdToast(window, "test", () => {}), "Nothing waits with the switch off");

  await SpecialPowers.popPrefEnv();
  await TestUtils.waitForCondition(() => WhimsyFocus.quiet, "Switch back on: Focus is read again");
  is(native.watched.length, 2, "...and watched again");
});

add_task(async function test_system_answer_wins() {
  await writeFocus([]);
  await fresh(mockNative("focused"));
  ok(WhimsyFocus.focused, "INFocusStatusCenter says focused");
  is(WhimsyFocus.state.source, "system", "...and is used first");

  await writeFocus([record(DND)]);
  await fresh(mockNative("notFocused"));
  ok(!WhimsyFocus.focused, "INFocusStatusCenter's no beats the database");

  await fresh(null);
  ok(WhimsyFocus.focused, "No native component: the database alone still works");
});

add_task(async function test_unreadable() {
  await IOUtils.remove(PathUtils.join(dir, "Assertions.json"), { ignoreAbsent: true });
  await fresh();
  ok(!WhimsyFocus.focused, "No file: no Focus");
  is(WhimsyFocus.state.source, "unreadable", "...noted as unreadable");

  await IOUtils.writeUTF8(PathUtils.join(dir, "Assertions.json"), "{ not json");
  await focusChanged();
  ok(!WhimsyFocus.focused, "Not JSON: no Focus");
  ok(!WhimsyFocus.holdToast(window, "test", () => {}), "...so toasts behave as before");
});

add_task(async function test_ends_on_time() {
  await writeFocus([record(DND, Date.now() + 1000)]);
  await fresh();
  ok(WhimsyFocus.focused, "A Focus that ends in a second");
  // macOS may not touch the file when it ends; Whimsy reads again then.
  await TestUtils.waitForCondition(() => !WhimsyFocus.focused, "It ends on time, without a change event");
});

add_task(async function test_season_toast_waits() {
  WhimsySeasons._now = () => new Date(2026, 9, 15, 12);
  await SpecialPowers.pushPrefEnv({ set: [[SEEN_PREF, ""]] });
  await writeFocus([record(DND)]);
  await fresh();

  is(WhimsySeasonToast.maybeShow(window), null, "No season toast during Focus");
  is(Services.prefs.getStringPref(SEEN_PREF), "", "...and the season isn't marked seen");

  await writeFocus([]);
  await focusChanged();
  is(Services.prefs.getStringPref(SEEN_PREF), "2026-autumn", "Focus ended: the toast showed");
  ok(window.document.querySelector(".whimsy-season-toast-balloon"), "...in this window");
  WhimsySeasons._now = originalNow;
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_no_celebration_during_focus() {
  await writeFocus([record(DND)]);
  await fresh();
  const toasts = [];
  const original = gZenUIManager.showToast;
  gZenUIManager.showToast = id => toasts.push(id);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  try {
    WhimsyDelight.celebrate(window, tab);
    Assert.deepEqual(toasts, [], "No inbox-zero toast during Focus");
    ok(!document.querySelector(".whimsy-balloons"), "...and no balloons");
  } finally {
    gZenUIManager.showToast = original;
    BrowserTestUtils.removeTab(tab);
  }
});
