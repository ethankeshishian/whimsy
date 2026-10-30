/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave3: Cmd+1-9 skip hidden spaces. The numbered space shortcuts count the
// spaces visible in the switcher, so hiding a space shifts the ones after it
// down, the way Arc's numbering follows the sidebar. Goes through Zen's real
// command path (cmd_zenWorkspaceSwitchN → gZenWorkspaces.shortcutSwitchTo).

const { WhimsySpaceArchive } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySpaceArchive.sys.mjs"
);

const FEATURE = "whimsy.feature.archive-space";

let created = [];
let selected = [];
let originalChange;

add_setup(async function () {
  // Three spaces so a hidden one sits between two visible ones.
  for (const name of ["Shortcut A", "Shortcut B"]) {
    created.push(await gZenWorkspaces.createAndSaveWorkspace(name, undefined, true));
  }
  originalChange = gZenWorkspaces.changeWorkspace;
  gZenWorkspaces.changeWorkspace = async space => {
    selected.push(space.uuid);
  };
  registerCleanupFunction(async () => {
    gZenWorkspaces.changeWorkspace = originalChange;
    Services.prefs.clearUserPref(FEATURE);
    for (const space of gZenWorkspaces.getWorkspaces()) {
      delete space.whimsyHidden;
    }
    WhimsySpaceArchive.applyHidden(window);
    for (const space of created) {
      await gZenWorkspaces.removeWorkspace(space.uuid);
    }
  });
});

async function press(n) {
  selected = [];
  document.getElementById(`cmd_zenWorkspaceSwitch${n}`).doCommand();
  // shortcutSwitchTo is async; let it reach changeWorkspace.
  await TestUtils.waitForTick();
  return selected;
}

add_task(async function test_numbering_skips_hidden() {
  const spaces = gZenWorkspaces.getWorkspaces();
  ok(spaces.length >= 3, "At least three spaces");
  Assert.deepEqual(await press(2), [spaces[1].uuid], "Cmd+2 is the second space while nothing is hidden");

  spaces[1].whimsyHidden = true;
  const visible = spaces.filter(s => !s.whimsyHidden);
  for (let n = 1; n <= 9; n++) {
    Assert.deepEqual(
      await press(n),
      visible[n - 1] ? [visible[n - 1].uuid] : [],
      `Cmd+${n} counts only visible spaces`
    );
  }
  Assert.deepEqual(await press(2), [spaces[2].uuid], "The space after a hidden one moves up a number");
  Assert.deepEqual(await press(10), visible[9] ? [visible[9].uuid] : [], "The tenth shortcut follows too");

  delete spaces[1].whimsyHidden;
  Assert.deepEqual(await press(2), [spaces[1].uuid], "Restoring a space gives its number back at once");
});

add_task(async function test_edges() {
  const spaces = gZenWorkspaces.getWorkspaces();
  for (const index of [-1, 100, NaN, undefined]) {
    selected = [];
    await gZenWorkspaces.shortcutSwitchTo(index);
    is(selected.length, 0, `Index ${index} does nothing`);
  }
  for (const space of spaces) {
    space.whimsyHidden = true;
  }
  Assert.deepEqual(await press(1), [], "With every space hidden there is no target");
  for (const space of spaces) {
    delete space.whimsyHidden;
  }
});

add_task(async function test_feature_off_keeps_zen_numbering() {
  const spaces = gZenWorkspaces.getWorkspaces();
  spaces[1].whimsyHidden = true;
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
  Assert.deepEqual(await press(2), [spaces[1].uuid], "Feature off: Cmd+2 is Zen's second space");
  await SpecialPowers.popPrefEnv();
  Assert.deepEqual(await press(2), [spaces[2].uuid], "Feature back on: hidden spaces are skipped again");
  delete spaces[1].whimsyHidden;
});
