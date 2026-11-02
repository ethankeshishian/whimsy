/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// batch9: spaces
//
// Lock a space: switching to a space locked via "Lock This Space" (the
// workspace context menu) opens behind the lock cover and asks for Touch ID
// or the Mac password (W11-17: WhimsyAuth, Firefox's OSReauthenticator;
// W11-14 d14: the shared cover); cancelling keeps the cover. W13-C2 (11-04):
// leaving covers it again after "Lock after" (right away by default); the
// old one-minute grace window let "switch away and back" skip the lock.
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

function space(uuid) {
  return gZenWorkspaces.getWorkspaces().find(w => w.uuid == uuid);
}

function cover() {
  return document.querySelector(".whimsy-lock-cover");
}

async function changeSpace(uuid) {
  await gZenWorkspaces.changeWorkspace(gZenWorkspaces.getWorkspaceFromId(uuid));
  is(gZenWorkspaces.activeWorkspace, uuid, "Switched space");
}

function stripHidden(uuid) {
  return gZenWorkspaces.workspaceElement(uuid)?.hasAttribute("whimsy-space-covered");
}

// The landing prompt (d6) has been answered.
async function promptSettled(count) {
  await TestUtils.waitForCondition(() => asked.length == count, `Asked ${count} time(s)`);
  await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

// The lock cover is up over the whole page, the address hidden.
function assertCovered(what) {
  const el = cover();
  ok(el?.checkVisibility(), `${what}: the cover shows`);
  is(el?.dataset.kind, "space-lock", `${what}: ...the space's cover`);
  const page = gBrowser.selectedBrowser.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  ok(box.left <= page.left && box.top <= page.top && box.right >= page.right && box.bottom >= page.bottom,
    `${what}: ...over the whole page`);
  ok(document.documentElement.hasAttribute("whimsy-private-selected-locked"), `${what}: the address bar reads Locked`);
  ok(stripHidden(gZenWorkspaces.activeWorkspace), `${what}: its tab list is hidden`);
}

add_task(async function test_locking_and_unlocking_toggles_the_flag() {
  ok(Services.prefs.getBoolPref(FEATURE), "On by default");
  asked.length = 0;
  answer = true;
  ok(await WhimsySpaceLock.toggleLocked(window, secondSpace.uuid), "Locked");
  ok(space(secondSpace.uuid).whimsyLocked, "...flagged");
  ok(WhimsySpaceLock.isCovered(secondSpace.uuid), "A locked space you're not in is covered");
  ok(stripHidden(secondSpace.uuid), "...its tab list hidden even while inactive (swipe previews)");
  is(asked.length, 0, "Locking asks nothing");

  // Removing the lock from a covered space asks first (no side door).
  answer = false;
  ok(!(await WhimsySpaceLock.toggleLocked(window, secondSpace.uuid)), "A cancel keeps the lock");
  ok(space(secondSpace.uuid).whimsyLocked, "...still locked");
  is(asked.length, 1, "Asked");
  answer = true;
  ok(await WhimsySpaceLock.toggleLocked(window, secondSpace.uuid), "Authenticated, Unlock This Space");
  ok(!space(secondSpace.uuid).whimsyLocked, "Toggling again unlocks it");
  ok(!stripHidden(secondSpace.uuid), "...and its tab list is back");
});

// 11-04: Lock Space on the space you're in, switch away and straight back.
add_task(async function test_lock_current_space_then_away_and_back() {
  await changeSpace(secondSpace.uuid);
  asked.length = 0;
  answer = false;
  await WhimsySpaceLock.toggleLocked(window, secondSpace.uuid);
  ok(!WhimsySpaceLock.isCovered(secondSpace.uuid), "Locking the space you're in leaves it showing");
  ok(!cover(), "...no cover yet");

  await changeSpace(firstSpace.uuid);
  ok(WhimsySpaceLock.isCovered(secondSpace.uuid), "Leaving locks it at once (Lock after: right away)");
  ok(stripHidden(secondSpace.uuid), "...its tab list hidden");
  ok(!cover(), "No cover over the space you're in");

  await changeSpace(secondSpace.uuid);
  assertCovered("Straight back");
  await promptSettled(1);
  is(asked[0].prompt, "open the locked space “Banking”", "Asked at once, saying why");
  is(asked[0].parentWindow, window, "...for this window");
  await TestUtils.waitForCondition(() => cover()?.hasAttribute("failed"), "The cancel shows Didn't unlock");
  const title = cover().querySelector(".whimsy-lock-cover-title");
  await TestUtils.waitForCondition(() => title.textContent == "“Banking” is locked", "Its title");
  ok(WhimsySpaceLock.isCovered(secondSpace.uuid), "A cancel keeps it covered");
});

add_task(async function test_unlock_button_opens_it_and_leaving_closes_it_again() {
  answer = true;
  asked.length = 0;
  cover().querySelector(".whimsy-lock-cover-button").doCommand();
  await TestUtils.waitForCondition(() => !cover(), "Unlocking removes the cover");
  is(asked.length, 1, "Asked once");
  ok(!WhimsySpaceLock.isCovered(secondSpace.uuid), "Unlocked");
  ok(!document.documentElement.hasAttribute("whimsy-private-selected-locked"), "The address is back");
  ok(!stripHidden(secondSpace.uuid), "...and the tab list");

  // The old one-minute grace window is gone: away and back covers again.
  answer = false;
  await changeSpace(firstSpace.uuid);
  await changeSpace(secondSpace.uuid);
  assertCovered("Away and back after unlocking");
  await promptSettled(2);
  ok(WhimsySpaceLock.isCovered(secondSpace.uuid), "Only the auth stand-in opens it");
  await changeSpace(firstSpace.uuid);
});

add_task(async function test_lock_after_and_sleep() {
  Services.prefs.setIntPref("whimsy.privateLock.afterSeconds", 60);
  answer = true;
  asked.length = 0;
  await changeSpace(secondSpace.uuid);
  await promptSettled(1);
  await TestUtils.waitForCondition(() => !cover(), "Unlocked");
  await changeSpace(firstSpace.uuid);
  ok(!WhimsySpaceLock.isCovered(secondSpace.uuid), "With Lock after 1 minute, it stays open a while");
  await changeSpace(secondSpace.uuid);
  ok(!cover(), "...so coming back shows it");
  is(asked.length, 1, "...without asking");

  // Mac sleep covers it at once, even in front.
  Services.obs.notifyObservers(null, "sleep_notification");
  ok(WhimsySpaceLock.isCovered(secondSpace.uuid), "Sleep locks it");
  assertCovered("After sleep");
  Services.prefs.clearUserPref("whimsy.privateLock.afterSeconds");
  await changeSpace(firstSpace.uuid);
  answer = true;
  await WhimsySpaceLock.toggleLocked(window, secondSpace.uuid);
  ok(!space(secondSpace.uuid).whimsyLocked, "Unlocked for the next tasks");
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
  await WhimsySpaceLock.toggleLocked(window, secondSpace.uuid);
  Services.prefs.setBoolPref(FEATURE, false);

  asked.length = 0;
  await gZenWorkspaces.changeWorkspaceWithID(secondSpace.uuid);
  is(asked.length, 0, "No prompt with the switch off");
  is(gZenWorkspaces.activeWorkspace, secondSpace.uuid, "The feature switch bypasses the gate entirely");

  Services.prefs.clearUserPref(FEATURE);
  await gZenWorkspaces.changeWorkspaceWithID(firstSpace.uuid);
  answer = true;
  await WhimsySpaceLock.toggleLocked(window, secondSpace.uuid);
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
