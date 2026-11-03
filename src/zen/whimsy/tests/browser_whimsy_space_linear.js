/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// B3: the space strip is a line, not a ring (see
// whimsy-handoff/wave13/b3-linear-design.md). Zen normalised the
// space-index distance "the short way round", so switching into the last
// space (where the Private Space sits) animated as if it were adjacent to
// the first one. With Whimsy's edges feature on (stop-at-the-ends), the
// strip must be linear even if zen.workspaces.wrap-around-navigation asks
// to wrap.

const EDGES = "whimsy.feature.space-edges";
let created = [];
let originalSpace;

async function settle() {
  await TestUtils.waitForCondition(
    () => !gZenWorkspaces.isChangingWorkspace,
    "Switch done"
  );
}

async function goTo(space) {
  await settle();
  if (gZenWorkspaces.activeWorkspace != space.uuid) {
    await gZenWorkspaces.changeWorkspaceWithID(space.uuid);
  }
  await settle();
}

function transformOf(space) {
  const el = gZenWorkspaces.workspaceElement(space.uuid);
  return el ? el.style.transform : null;
}

function offsetOf(space) {
  // "translateX(N%)" -> N. No transform yet (just created) reads as 0.
  const t = transformOf(space);
  const m = t && t.match(/-?[\d.]+/);
  return m ? parseFloat(m[0]) : 0;
}

add_setup(async function () {
  ok(Services.prefs.getBoolPref(EDGES), "Edges feature is on by default");
  originalSpace = gZenWorkspaces.getActiveWorkspace();
  for (const name of ["Lin A", "Lin B", "Lin C", "Lin D"]) {
    created.push(await gZenWorkspaces.createAndSaveWorkspace(name, undefined, true));
  }
  registerCleanupFunction(async () => {
    await settle();
    await gZenWorkspaces.changeWorkspaceWithID(originalSpace.uuid);
    for (const space of created) {
      await gZenWorkspaces.removeWorkspace(space.uuid);
    }
    created = [];
  });
  ok(gZenWorkspaces.getWorkspaces().length >= 4, "At least four spaces");
});

// Ask Zen to wrap; Whimsy's edges feature must override it anyway, so this
// exercises the actual bug condition rather than a setting nobody sets.
add_task(async function test_resting_layout_is_linear_not_a_ring() {
  await SpecialPowers.pushPrefEnv({ set: [[ "zen.workspaces.wrap-around-navigation", true ]] });
  const all = gZenWorkspaces.getWorkspaces();
  const first = all[0];
  const last = all.at(-1);
  await goTo(first);
  gZenWorkspaces._organizeWorkspaceStripLocations(first);

  // Requirement: every strip's offset equals index minus the active
  // index, with no wrapping -- the last space sits far to the right of
  // the first, not parked at -100% next to it (the ring bug).
  for (const space of all) {
    const expected = (all.indexOf(space) - all.indexOf(first)) * 100;
    is(offsetOf(space), expected, `${space.name ?? space.uuid}: linear resting offset`);
  }
  ok(offsetOf(last) > 0, "Last space rests to the right of the first, not wrapped to the left");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_swipe_right_on_first_reveals_nothing_on_left() {
  await SpecialPowers.pushPrefEnv({ set: [[ "zen.workspaces.wrap-around-navigation", true ]] });
  const all = gZenWorkspaces.getWorkspaces();
  const first = all[0];
  const last = all.at(-1);
  await goTo(first);
  // offsetPixels > 0 previews a swipe right (towards the previous space).
  gZenWorkspaces._organizeWorkspaceStripLocations(first, true, 40);
  ok(
    offsetOf(last) > 0,
    "The last space (where the Private Space sits) is not previewed on the left of the first"
  );
  gZenWorkspaces._organizeWorkspaceStripLocations(first, true, 0);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_first_to_last_slides_right_and_ends_linear() {
  await SpecialPowers.pushPrefEnv({ set: [[ "zen.workspaces.wrap-around-navigation", true ]] });
  const all = gZenWorkspaces.getWorkspaces();
  const first = all[0];
  const last = all.at(-1);
  await goTo(first);

  // Start of the slide: the incoming (last) strip already rests on the
  // side its sidebar order says -- positive translateX, i.e. to the
  // right, which is where a rightward ("not going left") slide starts
  // from. Under the ring bug this was negative (wrapped to the left).
  const startOffset = offsetOf(last);
  ok(startOffset > 0, "Incoming last space starts to the right (isGoingLeft would be false)");

  await goTo(last);

  // End of the slide: every strip, including the one we left, lands at
  // (index - active) * 100, no wrap.
  const allAfter = gZenWorkspaces.getWorkspaces();
  for (const space of allAfter) {
    const expected = (allAfter.indexOf(space) - allAfter.indexOf(last)) * 100;
    is(offsetOf(space), expected, `${space.name ?? space.uuid}: linear end offset after first-to-last switch`);
  }
  ok(offsetOf(first) < 0, "First space ends to the left of the last, not wrapped to the right");
  await SpecialPowers.popPrefEnv();
});

// No behaviour lost for the setting itself: with the edges feature off,
// Zen's own wrap-around-navigation rule still rings.
add_task(async function test_ring_returns_with_edges_off() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [ "zen.workspaces.wrap-around-navigation", true ],
      [ EDGES, false ],
    ],
  });
  const all = gZenWorkspaces.getWorkspaces();
  const first = all[0];
  const last = all.at(-1);
  await goTo(first);
  gZenWorkspaces._organizeWorkspaceStripLocations(first);
  is(
    offsetOf(last),
    -100,
    "With edges off, the last space still parks at -100% next to the first (Zen's ring, unchanged)"
  );
  await SpecialPowers.popPrefEnv();
});
