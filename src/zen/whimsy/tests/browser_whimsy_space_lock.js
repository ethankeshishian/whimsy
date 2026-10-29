/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// batch9: spaces
//
// Lock a space: switching to a space locked via "Lock This Space" (the
// workspace context menu) prompts OSKeyStore (Touch ID or a password, the
// same gate Firefox's saved-logins UI uses) before it's entered; canceling
// leaves the previous space active. Returning within the grace window
// after leaving a locked space doesn't re-prompt.

const { WhimsySpaceLock } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySpaceLock.sys.mjs");
const { OSKeyStoreTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/OSKeyStoreTestUtils.sys.mjs"
);

const FEATURE = "whimsy.feature.space-lock";

let firstSpace, secondSpace;

add_setup(async function () {
  OSKeyStoreTestUtils.setup();
  firstSpace = gZenWorkspaces.getWorkspaces().find(w => w.uuid == gZenWorkspaces.activeWorkspace);
  secondSpace = await gZenWorkspaces.createAndSaveWorkspace("Banking", undefined, true);
  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref(FEATURE);
    const workspace = gZenWorkspaces.getWorkspaces().find(w => w.uuid == secondSpace.uuid);
    if (workspace) {
      delete workspace.whimsyLocked;
      gZenWorkspaces.saveWorkspace(workspace);
    }
    if (gZenWorkspaces.activeWorkspace != firstSpace.uuid) {
      await gZenWorkspaces.changeWorkspaceWithID(firstSpace.uuid);
    }
    await gZenWorkspaces.removeWorkspace(secondSpace.uuid);
    await OSKeyStoreTestUtils.cleanup();
  });
});

add_task(async function test_locking_and_unlocking_toggles_the_flag() {
  ok(Services.prefs.getBoolPref(FEATURE), "On by default");
  WhimsySpaceLock.toggleLocked(window, secondSpace.uuid);
  ok(
    gZenWorkspaces.getWorkspaces().find(w => w.uuid == secondSpace.uuid).whimsyLocked,
    "Locked"
  );
  WhimsySpaceLock.toggleLocked(window, secondSpace.uuid);
  ok(
    !gZenWorkspaces.getWorkspaces().find(w => w.uuid == secondSpace.uuid).whimsyLocked,
    "Toggling again unlocks it"
  );
});

add_task(async function test_cancelling_the_prompt_blocks_the_switch() {
  if (!OSKeyStoreTestUtils.canTestOSKeyStoreLogin()) {
    return;
  }
  WhimsySpaceLock.toggleLocked(window, secondSpace.uuid);
  is(gZenWorkspaces.activeWorkspace, firstSpace.uuid, "Still on the first space");

  const reauthObserved = OSKeyStoreTestUtils.waitForOSKeyStoreLogin(false);
  await Promise.all([gZenWorkspaces.changeWorkspaceWithID(secondSpace.uuid), reauthObserved]);

  is(gZenWorkspaces.activeWorkspace, firstSpace.uuid, "Canceling the prompt leaves the previous space active");
});

add_task(async function test_succeeding_the_prompt_allows_the_switch() {
  if (!OSKeyStoreTestUtils.canTestOSKeyStoreLogin()) {
    return;
  }
  const reauthObserved = OSKeyStoreTestUtils.waitForOSKeyStoreLogin(true);
  await Promise.all([gZenWorkspaces.changeWorkspaceWithID(secondSpace.uuid), reauthObserved]);

  is(gZenWorkspaces.activeWorkspace, secondSpace.uuid, "Authenticating switches to the locked space");
});

add_task(async function test_returning_within_the_grace_window_skips_the_prompt() {
  if (!OSKeyStoreTestUtils.canTestOSKeyStoreLogin()) {
    return;
  }
  is(gZenWorkspaces.activeWorkspace, secondSpace.uuid, "Starting on the locked space (from the previous task)");

  // Leaving and immediately coming back must not need another prompt: if it
  // did, this would hang waiting for a reauth response nothing supplies.
  await gZenWorkspaces.changeWorkspaceWithID(firstSpace.uuid);
  await gZenWorkspaces.changeWorkspaceWithID(secondSpace.uuid);

  is(gZenWorkspaces.activeWorkspace, secondSpace.uuid, "Returned without a second prompt");

  WhimsySpaceLock.toggleLocked(window, secondSpace.uuid);
  await gZenWorkspaces.changeWorkspaceWithID(firstSpace.uuid);
});

add_task(async function test_feature_switch_off_skips_the_gate() {
  WhimsySpaceLock.toggleLocked(window, secondSpace.uuid);
  Services.prefs.setBoolPref(FEATURE, false);

  // No reauth response is supplied; this must not hang.
  await gZenWorkspaces.changeWorkspaceWithID(secondSpace.uuid);
  is(gZenWorkspaces.activeWorkspace, secondSpace.uuid, "The feature switch bypasses the gate entirely");

  Services.prefs.clearUserPref(FEATURE);
  await gZenWorkspaces.changeWorkspaceWithID(firstSpace.uuid);
  WhimsySpaceLock.toggleLocked(window, secondSpace.uuid);
});

add_task(async function test_context_menu_labels() {
  const popup = document.getElementById("zenWorkspaceMoreActions");
  const button = document.querySelector(
    `#zen-workspaces-button toolbarbutton[zen-workspace-id="${firstSpace.uuid}"]`
  );
  WhimsySpaceLock.updateContextMenu(window, { target: popup, explicitOriginalTarget: button });
  const item = document.getElementById("whimsy-lock-space-menuitem");
  ok(item, "The menu item was injected");
  ok(!item.hidden, "Offered for the active (unlocked) space");
  is(document.l10n.getAttributes(item).id, "whimsy-lock-space", "Offers to lock it");
});
