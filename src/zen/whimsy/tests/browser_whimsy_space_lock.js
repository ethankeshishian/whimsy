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
  // These tasks check "Lock when navigating away from private" (W13-C2); it is on by default
  // (on by default); test_leaving_keeps_it_open_when_the_setting_is_off turns it off.
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.privateLock.onLeave", true]] });
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

add_task(async function test_leaving_keeps_it_open_when_the_setting_is_off() {
  // "Lock when navigating away from private" off. W16-13 (D2): with "Lock
  // after" Right away, leaving locks it anyway; with a longer "Lock after",
  // leaving inside Whimsy keeps it open, and only Whimsy being away that
  // long, or the Mac sleeping, locks it.
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.privateLock.onLeave", false]] });
  answer = true;
  asked.length = 0;
  await changeSpace(secondSpace.uuid);
  await promptSettled(1);
  await TestUtils.waitForCondition(() => !cover(), "Unlocked");
  Services.prefs.setIntPref("whimsy.privateLock.afterSeconds", 60);
  await changeSpace(firstSpace.uuid);
  ok(!WhimsySpaceLock.isCovered(secondSpace.uuid), "Lock after 60s: leaving keeps it open");
  await changeSpace(secondSpace.uuid);
  ok(!cover(), "...so coming back shows it");
  is(asked.length, 1, "...without asking again");
  // Whimsy back in front after being away longer than "Lock after".
  Services.prefs.setIntPref("whimsy.privateLock.afterSeconds", 0);
  WhimsySpaceLock._testInactiveSince(Date.now() - 1000);
  WhimsySpaceLock.onAppActive();
  ok(WhimsySpaceLock.isCovered(secondSpace.uuid), "Away from Whimsy for Lock after: locked");
  answer = true;
  await WhimsySpaceLock.unlockCovered(window, space(secondSpace.uuid));
  await TestUtils.waitForCondition(() => !cover(), "Unlocked again");

  // Mac sleep covers it at once, even in front.
  Services.obs.notifyObservers(null, "sleep_notification");
  ok(WhimsySpaceLock.isCovered(secondSpace.uuid), "Sleep locks it");
  assertCovered("After sleep");
  Services.prefs.clearUserPref("whimsy.privateLock.afterSeconds");
  await SpecialPowers.popPrefEnv();
  await changeSpace(firstSpace.uuid);
  answer = true;
  await WhimsySpaceLock.toggleLocked(window, secondSpace.uuid);
  ok(!space(secondSpace.uuid).whimsyLocked, "Unlocked for the next tasks");
});

// W16-13 (D2): "Lock when navigating away from private" off and "Lock after" Right away
// (both defaults): Lock This Space keeps the space you're in open, and
// switching away locks it. Its folders and their tabs hide with the rest.
add_task(async function test_right_away_locks_on_leaving() {
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.privateLock.onLeave", false],
    ["whimsy.privateLock.afterSeconds", 0],
  ] });
  await changeSpace(secondSpace.uuid);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?locked-folder");
  const folder = await gZenFolders.createFolder([tab], { renameFolder: false, label: "Statements" });
  const loose = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?locked-loose");
  try {
    answer = true;
    asked.length = 0;
    await WhimsySpaceLock.toggleLocked(window, secondSpace.uuid);
    ok(space(secondSpace.uuid).whimsyLocked, "Locked");
    ok(!WhimsySpaceLock.isCovered(secondSpace.uuid), "The space you're in stays open");
    ok(!stripHidden(secondSpace.uuid), "...with its tab list");

    await changeSpace(firstSpace.uuid);
    ok(WhimsySpaceLock.isCovered(secondSpace.uuid), "Switching away locks it");
    answer = false;
    await changeSpace(secondSpace.uuid);
    assertCovered("Back");
    await promptSettled(1);
    const hidden = el => !el.checkVisibility({ visibilityProperty: true });
    ok(hidden(folder), "The folder is hidden");
    ok(hidden(tab.querySelector(".tab-label") ?? tab), "...and its tab's name");
    ok(hidden(loose.querySelector(".tab-label") ?? loose), "A loose tab's name too");
  } finally {
    answer = true;
    await WhimsySpaceLock.unlockCovered(window, space(secondSpace.uuid)).catch(() => {});
    await changeSpace(firstSpace.uuid);
    await WhimsySpaceLock.toggleLocked(window, secondSpace.uuid);
    ok(!space(secondSpace.uuid).whimsyLocked, "Unlocked for the next tasks");
    for (const t of [tab, loose]) {
      if (t.isConnected) {
        BrowserTestUtils.removeTab(t);
      }
    }
    folder?.isConnected && folder.delete?.();
    await SpecialPowers.popPrefEnv();
  }
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

add_task(async function test_lock_badge_sits_on_the_icon_inside_the_button() {
  answer = true;
  ok(await WhimsySpaceLock.toggleLocked(window, secondSpace.uuid), "Locked");
  const strip = document.getElementById("zen-workspaces-button");
  const button = strip.querySelector(`toolbarbutton[zen-workspace-id="${secondSpace.uuid}"]`);
  await TestUtils.waitForCondition(() => button.hasAttribute("whimsy-locked-space"), "Badge attribute set");
  const hadOverflow = strip.hasAttribute("icons-overflow");
  strip.removeAttribute("icons-overflow");
  try {
    const badge = getComputedStyle(button, "::after");
    const top = parseFloat(badge.insetBlockStart);
    const start = parseFloat(badge.insetInlineStart);
    const size = parseFloat(badge.width);
    const box = button.getBoundingClientRect();
    ok(top >= 0 && top + size <= box.height, `Badge is inside the button vertically (${top}+${size} <= ${box.height})`);
    ok(start >= 0 && start + size <= box.width, `...and horizontally (${start}+${size} <= ${box.width})`);
    const icon = button.querySelector(".zen-workspace-icon");
    const iconBox = icon.getBoundingClientRect();
    const left = box.left + start;
    const topEdge = box.top + top;
    ok(
      left < iconBox.right && left + size > iconBox.left && topEdge < iconBox.bottom && topEdge + size > iconBox.top,
      "The badge overlaps the space icon"
    );
    isnot(badge.backgroundImage, "none", "The badge draws its lock");

    strip.setAttribute("icons-overflow", "true");
    is(getComputedStyle(button, "::after").backgroundImage, "none", "While the strip overflows, Zen's dot owns the ::after");
  } finally {
    if (hadOverflow) {
      strip.setAttribute("icons-overflow", "true");
    } else {
      strip.removeAttribute("icons-overflow");
    }
  }
  ok(await WhimsySpaceLock.toggleLocked(window, secondSpace.uuid), "Unlocked");
});
