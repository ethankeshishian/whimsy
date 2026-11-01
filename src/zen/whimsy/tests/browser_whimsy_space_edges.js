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
  for (const name of ["Edge A", "Edge B"]) {
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
