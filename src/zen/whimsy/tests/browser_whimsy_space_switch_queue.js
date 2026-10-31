/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/spaceanim: space switches play one at a time (Arc). A switch asked
// for while a slide plays waits for it instead of snapping it to its end:
// keyboard/click bursts coalesce to the last space asked for, trackpad
// swipes step one space per slide (coalesce with reduced motion), and a
// swipe that starts mid-slide is claimed and deferred.

const { WhimsySpaceSwitchQueue } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySpaceSwitchQueue.sys.mjs"
);

const FEATURE = "whimsy.feature.space-switch-queue";
let spaces = [];
let originalSpace;
let starts = [];
let concurrent = 0;
let overlapped = false;

function onStart(event) {
  concurrent++;
  if (concurrent > 1 || gZenWorkspaces.isChangingWorkspace || gZenWorkspaces._animatingChange) {
    overlapped = true;
  }
  starts.push(event.detail.uuid);
}

function onEnd() {
  concurrent--;
}

function nameOf(uuid) {
  return gZenWorkspaces.getWorkspaces().find(w => w.uuid == uuid)?.name ?? uuid;
}

async function settle() {
  await TestUtils.waitForCondition(
    () => !WhimsySpaceSwitchQueue.isSwitching(window) && !gZenWorkspaces.isChangingWorkspace,
    "Switch queue drained"
  );
}

async function resetTo(space) {
  await settle();
  if (gZenWorkspaces.activeWorkspace != space.uuid) {
    await gZenWorkspaces.changeWorkspaceWithID(space.uuid);
  }
  await settle();
  starts = [];
  overlapped = false;
}

function gestureEvent(type, direction = 0) {
  const event = document.createEvent("SimpleGestureEvent");
  event.initSimpleGestureEvent(
    type,
    true /* canBubble */,
    true /* cancelable */,
    window,
    0,
    0,
    0,
    0,
    0,
    false,
    false,
    false,
    false,
    0,
    null,
    0 /* allowedDirections */,
    direction,
    1 /* delta */
  );
  return event;
}

add_setup(async function () {
  await TestUtils.waitForCondition(() => WhimsySpaceSwitchQueue.debugState(window), "Queue installed");
  originalSpace = gZenWorkspaces.getActiveWorkspace();
  for (const name of ["Queue A", "Queue B", "Queue C", "Queue D"]) {
    spaces.push(await gZenWorkspaces.createAndSaveWorkspace(name, undefined, true));
  }
  window.addEventListener(WhimsySpaceSwitchQueue.START_EVENT, onStart);
  window.addEventListener(WhimsySpaceSwitchQueue.END_EVENT, onEnd);
  registerCleanupFunction(async () => {
    window.removeEventListener(WhimsySpaceSwitchQueue.START_EVENT, onStart);
    window.removeEventListener(WhimsySpaceSwitchQueue.END_EVENT, onEnd);
    Services.prefs.clearUserPref(FEATURE);
    window.gReduceMotionOverride = undefined;
    await settle();
    await gZenWorkspaces.changeWorkspaceWithID(originalSpace.uuid);
    for (const space of spaces) {
      await gZenWorkspaces.removeWorkspace(space.uuid);
    }
  });
  const ids = gZenWorkspaces.getWorkspaces().map(w => w.uuid);
  const first = ids.indexOf(spaces[0].uuid);
  Assert.deepEqual(
    ids.slice(first, first + 4),
    spaces.map(s => s.uuid),
    "Test spaces sit next to each other"
  );
});

add_task(async function test_rapid_keyboard_triple_lands_on_last_space() {
  ok(Services.prefs.getBoolPref(FEATURE), "On by default");
  await resetTo(spaces[0]);
  const calls = [
    gZenWorkspaces.changeWorkspaceShortcut(1),
    gZenWorkspaces.changeWorkspaceShortcut(1),
    gZenWorkspaces.changeWorkspaceShortcut(1),
  ];
  ok(WhimsySpaceSwitchQueue.isSwitching(window), "The first switch is playing");
  Assert.deepEqual(
    WhimsySpaceSwitchQueue.debugState(window).pending,
    [spaces[3].uuid],
    "The two switches asked for mid-slide coalesce into one, counted from where the queue lands"
  );
  await Promise.all(calls);
  await settle();
  is(nameOf(gZenWorkspaces.activeWorkspace), "Queue D", "Ends on the third space over");
  Assert.deepEqual(starts.map(nameOf), ["Queue B", "Queue D"], "One slide, then one slide to the final space");
  ok(!overlapped, "A slide never started while another was running");
  is(WhimsySpaceSwitchQueue.debugState(window).maxConcurrent, 1, "Never two switches at once");
});

add_task(async function test_going_back_mid_slide_cancels_the_queued_switch() {
  await resetTo(spaces[0]);
  const calls = [
    gZenWorkspaces.changeWorkspaceShortcut(1),
    gZenWorkspaces.changeWorkspaceShortcut(1),
    gZenWorkspaces.changeWorkspaceShortcut(-1),
  ];
  Assert.deepEqual(WhimsySpaceSwitchQueue.debugState(window).pending, [], "Back to the playing target: nothing queued");
  await Promise.all(calls);
  await settle();
  is(nameOf(gZenWorkspaces.activeWorkspace), "Queue B", "Lands where the playing slide was heading");
  Assert.deepEqual(starts.map(nameOf), ["Queue B"], "Only the one slide played");
});

add_task(async function test_swipes_step_one_space_per_slide() {
  window.gReduceMotionOverride = false;
  await resetTo(spaces[0]);
  const calls = [
    gZenWorkspaces.changeWorkspaceShortcut(1, true),
    gZenWorkspaces.changeWorkspaceShortcut(1, true),
    gZenWorkspaces.changeWorkspaceShortcut(1, true),
  ];
  await Promise.all(calls);
  await settle();
  is(nameOf(gZenWorkspaces.activeWorkspace), "Queue D", "Three swipes, three spaces over");
  Assert.deepEqual(starts.map(nameOf), ["Queue B", "Queue C", "Queue D"], "Each swipe plays its own full slide");
  ok(!overlapped, "Slides never overlap");
});

add_task(async function test_swipes_coalesce_with_reduced_motion() {
  window.gReduceMotionOverride = true;
  await resetTo(spaces[0]);
  await Promise.all([
    gZenWorkspaces.changeWorkspaceShortcut(1, true),
    gZenWorkspaces.changeWorkspaceShortcut(1, true),
    gZenWorkspaces.changeWorkspaceShortcut(1, true),
  ]);
  await settle();
  is(nameOf(gZenWorkspaces.activeWorkspace), "Queue D", "Still lands three spaces over");
  Assert.deepEqual(starts.map(nameOf), ["Queue B", "Queue D"], "No stepping through spaces with reduced motion");
  window.gReduceMotionOverride = undefined;
});

add_task(async function test_swipe_during_slide_is_deferred() {
  window.gReduceMotionOverride = false;
  await resetTo(spaces[1]);
  const first = gZenWorkspaces.changeWorkspaceShortcut(1);
  ok(WhimsySpaceSwitchQueue.isSwitching(window), "A slide is playing");

  const mayStart = gestureEvent("MozSwipeGestureMayStart", SimpleGestureEvent.DIRECTION_RIGHT);
  gNavToolbox.dispatchEvent(mayStart);
  ok(mayStart.defaultPrevented, "The swipe is claimed, not left to page back/forward");
  ok(WhimsySpaceSwitchQueue.debugState(window).deferredGesture, "and held as a deferred gesture");

  gNavToolbox.dispatchEvent(gestureEvent("MozSwipeGestureStart"));
  gNavToolbox.dispatchEvent(gestureEvent("MozSwipeGestureUpdate"));
  gNavToolbox.dispatchEvent(gestureEvent("MozSwipeGesture", SimpleGestureEvent.DIRECTION_RIGHT));
  Assert.deepEqual(starts.map(nameOf), ["Queue C"], "The swipe didn't start a slide over the playing one");
  is(WhimsySpaceSwitchQueue.debugState(window).pending.length, 1, "It waits in the queue");
  gNavToolbox.dispatchEvent(gestureEvent("MozSwipeGestureEnd"));
  ok(!WhimsySpaceSwitchQueue.debugState(window).deferredGesture, "Gesture over");

  await first;
  await settle();
  const expected = gZenWorkspaces.naturalScroll ? "Queue B" : "Queue D";
  is(nameOf(gZenWorkspaces.activeWorkspace), expected, "The deferred swipe played after the slide finished");
  Assert.deepEqual(starts.map(nameOf), ["Queue C", expected], "Two slides, one after the other");
  ok(!overlapped, "Slides never overlap");
  window.gReduceMotionOverride = undefined;
});

add_task(async function test_swipe_while_idle_is_left_to_zen() {
  await resetTo(spaces[0]);
  const mayStart = gestureEvent("MozSwipeGestureMayStart", SimpleGestureEvent.DIRECTION_RIGHT);
  gNavToolbox.dispatchEvent(mayStart);
  ok(!WhimsySpaceSwitchQueue.debugState(window).deferredGesture, "No slide playing: Zen's own swipe handles it");
});

add_task(async function test_switch_off_leaves_zen_alone() {
  Services.prefs.setBoolPref(FEATURE, false);
  await resetTo(spaces[0]);
  await Promise.all([gZenWorkspaces.changeWorkspaceShortcut(1), gZenWorkspaces.changeWorkspaceShortcut(1)]);
  await settle();
  Assert.deepEqual(starts, [], "Nothing queued with the switch off");
  Services.prefs.clearUserPref(FEATURE);
});
