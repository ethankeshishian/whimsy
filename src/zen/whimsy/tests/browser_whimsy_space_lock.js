/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// batch9: spaces
//
// Lock a space: switching to a space locked via "Lock This Space" (the
// workspace context menu) opens behind the lock cover and asks for Touch ID
// or the Mac password (W11-17: WhimsyAuth, Firefox's OSReauthenticator;
// W11-14 d14: the shared cover); cancelling keeps the cover. Returning
// within the grace window after leaving a locked space doesn't re-prompt.
//
// W11-17: it used OSKeyStore.ensureLoggedIn(true), which throws on `true`,
// so a locked space never opened; these tasks were skipped wherever
// OSKeyStore's test login wasn't available, which hid that. The OS prompt
// is now a stand-in that answers yes or no, so they always run.

const { WhimsySpaceLock } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySpaceLock.sys.mjs");
const { WhimsyAuth } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAuth.sys.mjs");

const FEATURE = "whimsy.feature.space-lock";

let firstSpace, secondSpace;
// What the stand-in OS prompt answers, and what it was asked.
let answer = true;
const asked = [];

add_setup(async function () {
  WhimsyAuth._reauthenticator = {
    async asyncReauthenticateUser(prompt, caption, parentWindow) {
      asked.push({ prompt, caption, parentWindow });
      return [answer, false];
    },
  };
  firstSpace = gZenWorkspaces.getWorkspaces().find(w => w.uuid == gZenWorkspaces.activeWorkspace);
  secondSpace = await gZenWorkspaces.createAndSaveWorkspace("Banking", undefined, true);
  registerCleanupFunction(async () => {
    WhimsyAuth._reauthenticator = null;
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

function cover() {
  return document.querySelector(".whimsy-lock-cover");
}

// d14: a locked space opens behind the shared lock cover; Touch ID is asked
// for at once, and a cancel leaves the cover (with "Didn't unlock").
add_task(async function test_cancelling_the_prompt_keeps_the_cover() {
  WhimsySpaceLock.toggleLocked(window, secondSpace.uuid);
  is(gZenWorkspaces.activeWorkspace, firstSpace.uuid, "Still on the first space");
  answer = false;
  asked.length = 0;
  await gZenWorkspaces.changeWorkspaceWithID(secondSpace.uuid);
  await TestUtils.waitForCondition(() => asked.length == 1, "Asked at once on landing");
  is(asked[0].prompt, "open the locked space “Banking”", "...saying why");
  is(asked[0].parentWindow, window, "...for this window");
  is(gZenWorkspaces.activeWorkspace, secondSpace.uuid, "The space is entered");
  ok(cover()?.checkVisibility(), "...behind the lock cover");
  is(cover().dataset.kind, "space-lock", "The space's cover");
  await TestUtils.waitForCondition(() => cover().hasAttribute("failed"), "The cancel shows Didn't unlock");
  const title = cover().querySelector(".whimsy-lock-cover-title");
  await TestUtils.waitForCondition(() => title.textContent == "“Banking” is locked", "Its title");
  const section = gZenWorkspaces.workspaceElement(secondSpace.uuid)?.querySelector(".zen-workspace-normal-tabs-section");
  if (section) {
    ok(!section.checkVisibility({ visibilityProperty: true }), "Its tab list is hidden");
  }
  ok(WhimsySpaceLock.isCovered(secondSpace.uuid), "Still locked");
});

add_task(async function test_unlock_button_opens_it() {
  answer = true;
  asked.length = 0;
  cover().querySelector(".whimsy-lock-cover-button").doCommand();
  await TestUtils.waitForCondition(() => !cover(), "Unlocking removes the cover");
  is(asked.length, 1, "Asked once");
  ok(!WhimsySpaceLock.isCovered(secondSpace.uuid), "Unlocked");
  is(gZenWorkspaces.activeWorkspace, secondSpace.uuid, "On the space");
});

add_task(async function test_returning_within_the_grace_window_skips_the_prompt() {
  is(gZenWorkspaces.activeWorkspace, secondSpace.uuid, "Starting on the unlocked space (from the previous task)");
  asked.length = 0;
  await gZenWorkspaces.changeWorkspaceWithID(firstSpace.uuid);
  await gZenWorkspaces.changeWorkspaceWithID(secondSpace.uuid);
  is(asked.length, 0, "Returned without a second prompt");
  ok(!cover(), "...and no cover");

  WhimsySpaceLock.toggleLocked(window, secondSpace.uuid);
  await gZenWorkspaces.changeWorkspaceWithID(firstSpace.uuid);
});

// Two switches while the prompt is up share one prompt.
add_task(async function test_concurrent_unlocks_share_one_prompt() {
  let release;
  const gate = new Promise(resolve => (release = resolve));
  const saved = WhimsyAuth._reauthenticator;
  let calls = 0;
  WhimsyAuth._reauthenticator = {
    async asyncReauthenticateUser() {
      calls++;
      await gate;
      return [true, false];
    },
  };
  const a = WhimsyAuth.unlock(window, "whimsy-auth-reason-space", { space: "A" });
  const b = WhimsyAuth.unlock(window, "whimsy-auth-reason-space", { space: "A" });
  release();
  Assert.deepEqual(await Promise.all([a, b]), ["ok", "ok"], "Both resolve");
  is(calls, 1, "One prompt");
  WhimsyAuth._reauthenticator = {
    async asyncReauthenticateUser() {
      throw new Error("cancelled (Windows rejects)");
    },
  };
  is(await WhimsyAuth.unlock(window, "whimsy-auth-reason-space", { space: "A" }), "cancel", "A rejection is a cancel");
  WhimsyAuth._reauthenticator = saved;
});

add_task(async function test_feature_switch_off_skips_the_gate() {
  WhimsySpaceLock.toggleLocked(window, secondSpace.uuid);
  Services.prefs.setBoolPref(FEATURE, false);

  asked.length = 0;
  await gZenWorkspaces.changeWorkspaceWithID(secondSpace.uuid);
  is(asked.length, 0, "No prompt with the switch off");
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
