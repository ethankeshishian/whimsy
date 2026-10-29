/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// batch9: spaces
//
// Archive (hide) a space (Arc parity): "Hide This Space" in the workspace
// context menu drops a space out of the switcher without closing its tabs
// or losing its position; it's restored from Settings → Tab Management →
// Spaces. Covers the main flow, the feature switch off, the "can't hide
// your only space" edge case, and that tabs survive.

const { WhimsySpaceArchive } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySpaceArchive.sys.mjs"
);

const FEATURE = "whimsy.feature.archive-space";

let firstSpace, secondSpace;

add_setup(async function () {
  firstSpace = gZenWorkspaces.getWorkspaces().find(w => w.uuid == gZenWorkspaces.activeWorkspace);
  secondSpace = await gZenWorkspaces.createAndSaveWorkspace("Taxes 2026", undefined, true);
  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref(FEATURE);
    const workspace = gZenWorkspaces.getWorkspaces().find(w => w.uuid == secondSpace.uuid);
    if (workspace) {
      delete workspace.whimsyHidden;
      gZenWorkspaces.saveWorkspace(workspace);
    }
    await gZenWorkspaces.removeWorkspace(secondSpace.uuid);
  });
});

function switcherButton(uuid) {
  return document.querySelector(`#zen-workspaces-button toolbarbutton[zen-workspace-id="${uuid}"]`);
}

add_task(async function test_hide_keeps_tabs_and_position() {
  ok(Services.prefs.getBoolPref(FEATURE), "On by default");
  const before = gZenWorkspaces.getWorkspaces().map(w => w.uuid);
  const tabCountBefore = gBrowser.tabs.length;

  await WhimsySpaceArchive.toggleHidden(window, secondSpace.uuid);

  const workspace = gZenWorkspaces.getWorkspaces().find(w => w.uuid == secondSpace.uuid);
  ok(workspace.whimsyHidden, "The space is marked hidden");
  is(gBrowser.tabs.length, tabCountBefore, "No tabs were closed");
  await TestUtils.waitForCondition(
    () => switcherButton(secondSpace.uuid)?.hidden,
    "Its switcher icon is hidden"
  );
  Assert.deepEqual(
    gZenWorkspaces.getWorkspaces().map(w => w.uuid),
    before,
    "The workspace list order (its position) is unchanged"
  );
});

add_task(async function test_restore_shows_it_again() {
  WhimsySpaceArchive.restore(window, secondSpace.uuid);

  const workspace = gZenWorkspaces.getWorkspaces().find(w => w.uuid == secondSpace.uuid);
  ok(!workspace.whimsyHidden, "No longer marked hidden");
  await TestUtils.waitForCondition(
    () => !switcherButton(secondSpace.uuid)?.hidden,
    "Its switcher icon shows again"
  );
});

add_task(async function test_cannot_hide_the_only_space() {
  // Hide everything but firstSpace, then try to hide that too.
  await WhimsySpaceArchive.toggleHidden(window, secondSpace.uuid);
  await WhimsySpaceArchive.toggleHidden(window, firstSpace.uuid);

  const workspace = gZenWorkspaces.getWorkspaces().find(w => w.uuid == firstSpace.uuid);
  ok(!workspace.whimsyHidden, "The only remaining visible space refuses to hide");

  WhimsySpaceArchive.restore(window, secondSpace.uuid);
});

add_task(async function test_hiding_the_active_space_switches_away() {
  await gZenWorkspaces.changeWorkspaceWithID(secondSpace.uuid);
  is(gZenWorkspaces.activeWorkspace, secondSpace.uuid, "Second space is active");

  await WhimsySpaceArchive.toggleHidden(window, secondSpace.uuid);

  isnot(gZenWorkspaces.activeWorkspace, secondSpace.uuid, "Switched away before hiding the active space");
  WhimsySpaceArchive.restore(window, secondSpace.uuid);
});

add_task(async function test_feature_switch_off_shows_everything() {
  await WhimsySpaceArchive.toggleHidden(window, secondSpace.uuid);
  await TestUtils.waitForCondition(() => switcherButton(secondSpace.uuid)?.hidden);

  Services.prefs.setBoolPref(FEATURE, false);
  await TestUtils.waitForCondition(
    () => !switcherButton(secondSpace.uuid)?.hidden,
    "The feature switch overrides whimsyHidden"
  );

  Services.prefs.clearUserPref(FEATURE);
  await TestUtils.waitForCondition(() => switcherButton(secondSpace.uuid)?.hidden);
  WhimsySpaceArchive.restore(window, secondSpace.uuid);
});

add_task(async function test_context_menu_item() {
  // Exercises the same code the real popupshowing listener runs, with a
  // constructed event (opening the real popup needs a native contextmenu
  // event to set explicitOriginalTarget, which automation can't fake).
  const popup = document.getElementById("zenWorkspaceMoreActions");
  const button = switcherButton(firstSpace.uuid);
  WhimsySpaceArchive.updateContextMenu(window, { target: popup, explicitOriginalTarget: button });
  const item = document.getElementById("whimsy-hide-space-menuitem");
  ok(item, "The menu item was injected");
  ok(!item.hidden, "Offered for a visible space");

  await WhimsySpaceArchive.toggleHidden(window, secondSpace.uuid);
  WhimsySpaceArchive.updateContextMenu(window, { target: popup, explicitOriginalTarget: button });
  ok(!item.hidden, "Still offered for the active (different, still visible) space");
  WhimsySpaceArchive.restore(window, secondSpace.uuid);
});

add_task(async function test_settings_hidden_list() {
  await WhimsySpaceArchive.toggleHidden(window, secondSpace.uuid);
  await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
    const doc = browser.contentDocument;
    const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsySpacesGroup"));
    ok(group, "Settings → Tab Management has the Spaces group");
    const list = doc.getElementById("whimsyHiddenSpacesList");
    await TestUtils.waitForCondition(() => list.children.length == 1);
    is(
      list.querySelector("label").textContent,
      "Taxes 2026",
      "The hidden space is listed by name"
    );
    list.querySelector("button").doCommand();
    await TestUtils.waitForCondition(() => list.children.length == 0, "Restoring from Settings empties the list");
  });
  const workspace = gZenWorkspaces.getWorkspaces().find(w => w.uuid == secondSpace.uuid);
  ok(!workspace.whimsyHidden, "Restored");
});
