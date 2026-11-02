/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W10-03 (Arc): Next Space past the last space opens New Space; Previous
// Space stops at the first. Zen's wrap-around setting went round to the
// other end. Only Next/Previous Space (their keys, the Spaces menu, the
// command bar); a burst of presses stops at the last space rather than
// making one.

const { WhimsySpaceSwitchQueue } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySpaceSwitchQueue.sys.mjs"
);

const EDGES = "whimsy.feature.space-edges";
let created = [];
let originalSpace;
let creations = 0;

async function settle() {
  await TestUtils.waitForCondition(
    () => !WhimsySpaceSwitchQueue.isSwitching(window) && !gZenWorkspaces.isChangingWorkspace,
    "Switches done"
  );
}

async function goTo(space) {
  await settle();
  if (gZenWorkspaces.activeWorkspace != space.uuid) {
    await gZenWorkspaces.changeWorkspaceWithID(space.uuid);
  }
  await settle();
}

function command(id) {
  document.getElementById(id).doCommand();
}


add_setup(async function () {
  await TestUtils.waitForCondition(() => WhimsySpaceSwitchQueue.debugState(window), "Space switching set up");
  await SpecialPowers.pushPrefEnv({ set: [["zen.workspaces.wrap-around-navigation", true]] });
  originalSpace = gZenWorkspaces.getActiveWorkspace();
  for (const name of ["Edge A", "Edge B", "Edge C"]) {
    created.push(await gZenWorkspaces.createAndSaveWorkspace(name, undefined, true));
  }
  // Count New Space instead of opening its form.
  gZenWorkspaces.openWorkspaceCreation = async () => {
    creations++;
  };
  registerCleanupFunction(async () => {
    delete gZenWorkspaces.openWorkspaceCreation;
    await settle();
    await gZenWorkspaces.changeWorkspaceWithID(originalSpace.uuid);
    for (const space of created) {
      await gZenWorkspaces.removeWorkspace(space.uuid);
    }
    created = [];
  });
  ok(gZenWorkspaces.getWorkspaces().length >= 3, "At least three spaces");
});

add_task(async function test_next_past_last_makes_a_space() {
  ok(Services.prefs.getBoolPref(EDGES), "On by default");
  const all = gZenWorkspaces.getWorkspaces();
  await goTo(all.at(-1));
  creations = 0;
  command("cmd_zenWorkspaceForward");
  await TestUtils.waitForCondition(() => creations == 1, "Next Space on the last space opens New Space");
  await settle();
  is(gZenWorkspaces.activeWorkspace, all.at(-1).uuid, "It didn't wrap to the first space");
});

add_task(async function test_previous_stops_at_first() {
  const all = gZenWorkspaces.getWorkspaces();
  await goTo(all[0]);
  creations = 0;
  command("cmd_zenWorkspaceBackward");
  await new Promise(r => setTimeout(r, 300));
  await settle();
  is(gZenWorkspaces.activeWorkspace, all[0].uuid, "Previous Space on the first space stays there");
  is(creations, 0, "and makes nothing");
});

add_task(async function test_middle_steps_normally() {
  const all = gZenWorkspaces.getWorkspaces();
  await goTo(all.at(-2));
  command("cmd_zenWorkspaceForward");
  await TestUtils.waitForCondition(() => gZenWorkspaces.activeWorkspace == all.at(-1).uuid, "Next Space goes to the next one");
  await settle();
  command("cmd_zenWorkspaceBackward");
  await TestUtils.waitForCondition(() => gZenWorkspaces.activeWorkspace == all.at(-2).uuid, "Previous Space goes back");
  await settle();
});

add_task(async function test_burst_stops_at_last() {
  const all = gZenWorkspaces.getWorkspaces();
  await goTo(all.at(-2));
  creations = 0;
  window.gReduceMotionOverride = false;
  command("cmd_zenWorkspaceForward");
  ok(WhimsySpaceSwitchQueue.isSwitching(window), "The first slide is playing");
  command("cmd_zenWorkspaceForward");
  command("cmd_zenWorkspaceForward");
  await settle();
  window.gReduceMotionOverride = undefined;
  is(gZenWorkspaces.activeWorkspace, all.at(-1).uuid, "A burst lands on the last space");
  is(creations, 0, "without making a new one");
});

add_task(async function test_switch_off_keeps_zen_wrap() {
  await SpecialPowers.pushPrefEnv({ set: [[EDGES, false]] });
  const all = gZenWorkspaces.getWorkspaces();
  await goTo(all.at(-1));
  creations = 0;
  command("cmd_zenWorkspaceForward");
  await TestUtils.waitForCondition(() => gZenWorkspaces.activeWorkspace == all[0].uuid, "Off: Zen wraps to the first space");
  await settle();
  is(creations, 0, "and makes nothing");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_swipe_burst_skips_hidden_and_stops_at_edges() {
  const all = gZenWorkspaces.getWorkspaces();
  const hiddenSpace = all[1];
  hiddenSpace.whimsyHidden = true;
  gZenWorkspaces.saveWorkspace(hiddenSpace);
  window.dispatchEvent(new CustomEvent("ZenWorkspaceDataChanged"));

  const visible = all.filter(s => !s.whimsyHidden);
  ok(visible.length >= 3, "At least 3 visible spaces");

  // Start at the first visible space
  await goTo(visible[0]);
  creations = 0;
  window.gReduceMotionOverride = false;

  // A fast burst of forward swipes (more swipes than spaces). Each swipe
  // ends in Zen's ZenSpacesSwipe#handleSwipeEnd, which calls
  // changeWorkspaceShortcut(direction, true); synthetic gesture events
  // don't carry the deltas Zen's swipe needs, so the burst calls that.
  const swipes = [];
  swipes.push(gZenWorkspaces.changeWorkspaceShortcut(1, true));
  ok(WhimsySpaceSwitchQueue.isSwitching(window), "Forward slide in flight");
  for (let i = 0; i < visible.length + 1; i++) {
    swipes.push(gZenWorkspaces.changeWorkspaceShortcut(1, true));
  }
  await Promise.all(swipes);
  await settle();

  is(
    gZenWorkspaces.activeWorkspace,
    visible.at(-1).uuid,
    "Fast forward swipe burst lands on the last visible space, skipping hidden space and without wrapping"
  );
  is(creations, 0, "Fast burst did not create a new space at the edge");

  // Now a fast burst of backward swipes from the last space
  const back = [];
  back.push(gZenWorkspaces.changeWorkspaceShortcut(-1, true));
  ok(WhimsySpaceSwitchQueue.isSwitching(window), "Backward slide in flight");
  for (let i = 0; i < visible.length + 1; i++) {
    back.push(gZenWorkspaces.changeWorkspaceShortcut(-1, true));
  }
  await Promise.all(back);
  await settle();

  is(
    gZenWorkspaces.activeWorkspace,
    visible[0].uuid,
    "Fast backward swipe burst lands on the first visible space, skipping hidden space and without wrapping"
  );
  is(creations, 0, "Backward burst did not create a new space");

  window.gReduceMotionOverride = undefined;
  delete hiddenSpace.whimsyHidden;
  gZenWorkspaces.saveWorkspace(hiddenSpace);
  window.dispatchEvent(new CustomEvent("ZenWorkspaceDataChanged"));
  await settle();
});

add_task(async function test_switcher_arrows_skip_hidden_and_enforce_edges() {
  const all = gZenWorkspaces.getWorkspaces();
  const hiddenSpace = all[1];
  hiddenSpace.whimsyHidden = true;
  gZenWorkspaces.saveWorkspace(hiddenSpace);
  window.dispatchEvent(new CustomEvent("ZenWorkspaceDataChanged"));

  const visible = all.filter(s => !s.whimsyHidden);
  await goTo(visible[0]);
  creations = 0;

  const icons = document.getElementById("zen-workspaces-button");
  const firstButton = icons.querySelector(`toolbarbutton[zen-workspace-id="${visible[0].uuid}"]`);
  firstButton.focus();

  // Backward arrow from first space: stops at first space
  firstButton.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  await settle();
  is(gZenWorkspaces.activeWorkspace, visible[0].uuid, "ArrowLeft on first space stays at first space");
  is(creations, 0, "No new space made");

  // Forward arrow: steps to visible[1], skipping hiddenSpace (all[1])
  firstButton.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await settle();
  is(gZenWorkspaces.activeWorkspace, visible[1].uuid, "ArrowRight skipped hidden space");

  // Move to the last visible space
  await goTo(visible.at(-1));
  creations = 0;
  const lastButton = icons.querySelector(`toolbarbutton[zen-workspace-id="${visible.at(-1).uuid}"]`);
  lastButton.focus();

  // Forward arrow past the last space: opens New Space
  lastButton.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await TestUtils.waitForCondition(() => creations == 1, "ArrowRight past last space opens New Space");
  await settle();
  is(gZenWorkspaces.activeWorkspace, visible.at(-1).uuid, "ArrowRight did not wrap to first space");

  delete hiddenSpace.whimsyHidden;
  gZenWorkspaces.saveWorkspace(hiddenSpace);
  window.dispatchEvent(new CustomEvent("ZenWorkspaceDataChanged"));
  await settle();
});

// W11-16: Zen's swipe edge actions (New Space past the last space, the
// Library past the first) count the visible spaces, so a hidden space at an
// end doesn't take them away. They are the window's own module instances
// (Zen loads them with global "current").
add_task(async function test_edge_actions_count_visible_spaces() {
  await SpecialPowers.pushPrefEnv({ set: [["zen.library.enabled", true]] });
  const { ZenLibrary } = window.ChromeUtils.importESModule("moz-src:///zen/library/ZenLibrary.mjs", { global: "current" });
  const { ZenSpaceAddSwipe } = window.ChromeUtils.importESModule("resource:///modules/zen/ZenSpaceAddSwipe.mjs", { global: "current" });
  ok(ZenLibrary.readySwipeOpenLibrary._whimsyVisible, "The window's ZenLibrary is wrapped");
  ok(ZenSpaceAddSwipe.prototype.readySwipeAddSpace._whimsyVisible, "...and its ZenSpaceAddSwipe");
  if (!gZenWorkspaces.shouldSwipeEdgeActions) {
    info("Swipe edge actions are off in this build; the wrappers were checked");
    await SpecialPowers.popPrefEnv();
    return;
  }
  const all = gZenWorkspaces.getWorkspaces();
  const [first, second] = all;
  const last = all.at(-1);
  const beforeLast = all.at(-2);
  first.whimsyHidden = true;
  last.whimsyHidden = true;
  gZenWorkspaces.saveWorkspace(first);
  gZenWorkspaces.saveWorkspace(last);
  try {
    const libraryAtStart = !ZenLibrary.libraryOnRight;
    await gZenWorkspaces.changeWorkspaceWithID((libraryAtStart ? second : beforeLast).uuid);
    ok(ZenLibrary.readySwipeOpenLibrary(), "At the first visible space, a swipe can open the Library");
    await gZenWorkspaces.changeWorkspaceWithID((libraryAtStart ? beforeLast : second).uuid);
    ok(ZenSpaceAddSwipe.prototype.readySwipeAddSpace.call(null), "At the last visible space, a swipe can add a space");
  } finally {
    delete first.whimsyHidden;
    delete last.whimsyHidden;
    gZenWorkspaces.saveWorkspace(first);
    gZenWorkspaces.saveWorkspace(last);
    await SpecialPowers.popPrefEnv();
  }
});
