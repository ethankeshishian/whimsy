/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// W10-39: Rename Space (Zen's cmd_zenChangeWorkspaceName) works from every
// way in: the command bar, a shortcut assigned in Settings → Keyboard
// Shortcuts (about:keyboard), and the menus. It used to hand the space's
// name to Zen's inline renamer at once, which did nothing when the name
// couldn't take focus at that moment (the command bar closing, compact
// mode's hidden sidebar); and a rename that never got focus left the
// renamer stuck, so every later rename (tabs, folders, spaces) did nothing
// until restart (overlay hotfixes tab-renamer-focus, tab-renamer-stale-edit).

const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { WhimsyMenuParity } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMenuParity.sys.mjs");
const { CustomKeys } = ChromeUtils.importESModule("moz-src:///browser/components/customkeys/CustomKeys.sys.mjs");
const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");

const COMMAND = "cmd_zenChangeWorkspaceName";
// Unused on macOS (the command registry's test uses the same one).
const FREE_EVENT = { accelKey: true, shiftKey: true };

let originalName;

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.view.sidebar-expanded", true],
      ["zen.urlbar.suggestions.quick-actions", true],
    ],
  });
  originalName = gZenWorkspaces.getActiveWorkspace().name;
  registerCleanupFunction(async () => {
    cancelRename();
    CustomKeys.resetAll();
    await setSpaceName(originalName);
  });
});

function spaceName() {
  return gZenWorkspaces.activeWorkspaceIndicator.querySelector(".zen-current-workspace-indicator-name");
}

function renameInput() {
  return document.getElementById("tab-label-input");
}

function cancelRename() {
  const input = renameInput();
  if (input) {
    input.focus();
    EventUtils.synthesizeKey("KEY_Escape");
  }
}

async function setSpaceName(name) {
  const space = gZenWorkspaces.getActiveWorkspace();
  if (space.name != name) {
    space.name = name;
    await gZenWorkspaces.saveWorkspace(space);
    spaceName().textContent = name;
  }
}

async function waitForRename(label) {
  const input = await TestUtils.waitForCondition(
    () => renameInput() && document.activeElement == renameInput() && renameInput(),
    `${label}: the space's name turns into a focused text field`
  );
  ok(spaceName().nextElementSibling == input, `${label}: the field is the space's name`);
  is(input.value, gZenWorkspaces.getActiveWorkspace().name, `${label}: it starts with the current name`);
  return input;
}

async function typeNameAndSave(input, name) {
  input.value = name;
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(
    () => gZenWorkspaces.getActiveWorkspace().name == name && !renameInput(),
    `The space is renamed to ${name}`
  );
  is(spaceName().textContent, name, "The sidebar shows the new name");
  ok(!document.documentElement.hasAttribute("zen-renaming-tab"), "The rename is over");
}

async function settle() {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await TestUtils.waitForTick();
}

add_task(async function test_the_command_renames_the_current_space() {
  ok(WhimsyCommands.get(COMMAND)?.keyId, "Rename Space has a <key>, so a shortcut can be assigned");
  document.getElementById(COMMAND).doCommand();
  const input = await waitForRename("Command");
  await typeNameAndSave(input, "Renamed by command");
  await setSpaceName(originalName);
});

add_task(async function test_from_the_command_bar() {
  gURLBar.blur();
  await SimpleTest.promiseFocus(window);
  document.getElementById("Browser:OpenLocation").doCommand();
  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    waitForFocus: SimpleTest.waitForFocus,
    value: "Rename Space",
  });
  let index = -1;
  for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
    const { result } = await UrlbarTestUtils.getRowAt(window, i);
    if (result.payload.zenCommand == COMMAND) {
      index = i;
      break;
    }
  }
  Assert.greaterOrEqual(index, 0, "The command bar offers Rename Space");
  UrlbarTestUtils.setSelectedRowIndex(window, index);
  EventUtils.synthesizeKey("KEY_Enter");

  const input = await waitForRename("Command bar");
  // The bar closes and sends focus back to the page; the rename must not
  // end with it.
  await TestUtils.waitForCondition(() => !gURLBar.hasAttribute("breakout-extend"), "The command bar has closed");
  await settle();
  is(renameInput(), input, "The field is still there once the command bar has closed");
  is(document.activeElement, input, "...and still has focus, ready for typing");
  await typeNameAndSave(input, "Renamed from the bar");
  await setSpaceName(originalName);
});

add_task(async function test_an_assigned_shortcut_renames_the_space() {
  const keyId = WhimsyCommands.get(COMMAND).keyId;
  // Assign it the way a person does: Settings → Keyboard Shortcuts.
  await BrowserTestUtils.withNewTab("about:keyboard", async browser => {
    await SpecialPowers.spawn(browser, [keyId], async id => {
      if (!content.document.getElementById("table").firstElementChild) {
        await ContentTaskUtils.waitForEvent(content, "CustomKeysUpdate", false, null, true);
      }
      const row = content.document.querySelector(`.key[data-id="${id}"]`);
      ok(row, "about:keyboard lists Rename Space");
      const card = row.closest(".category").wrappedJSObject;
      card.expanded = true;
      await card.updateComplete;
      content.row = row;
      const input = row.querySelector(".newKey").wrappedJSObject;
      const focused = ContentTaskUtils.waitForEvent(input, "focus");
      row.querySelector(".change").click();
      await focused;
      content.changeFocused = ContentTaskUtils.waitForEvent(row.querySelector(".change"), "focus");
    });
    EventUtils.synthesizeKey("Y", FREE_EVENT, window);
    await SpecialPowers.spawn(browser, [], async () => {
      await content.changeFocused;
      ok(content.row.classList.contains("customized"), "The new shortcut is saved for Rename Space");
      ok(content.row.querySelector(".currentShortcut").wrappedJSObject.value, "...and shown");
    });
  });
  const keyEl = document.getElementById(keyId);
  is(keyEl.getAttribute("key"), "Y", "The window's key for Rename Space takes it");

  // Press it from a web page.
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  tab.linkedBrowser.focus();
  EventUtils.synthesizeKey("Y", FREE_EVENT, window);
  const input = await waitForRename("Shortcut");
  await typeNameAndSave(input, "Renamed by shortcut");
  await setSpaceName(originalName);
  BrowserTestUtils.removeTab(tab);
  CustomKeys.resetKey(keyId);
  ok(!keyEl.hasAttribute("key"), "Reset: no shortcut again");
});

add_task(async function test_a_rename_that_cannot_take_focus_blocks_nothing() {
  // The name has no box (here: hidden), so its field can't take focus.
  const indicator = gZenWorkspaces.activeWorkspaceIndicator;
  indicator.style.display = "none";
  try {
    gZenTabRenamer.start({ target: spaceName() });
    ok(!renameInput(), "No orphan field is left behind");
    ok(!document.documentElement.hasAttribute("zen-renaming-tab"), "The window isn't left marked as renaming");
    ok(!spaceName().classList.contains("tab-label-container-editing"), "The name isn't left hidden");
    is(await WhimsyMenuParity.renameSpace(window), false, "Rename Space reports it couldn't start");
    ok(!document.documentElement.hasAttribute("zen-renaming-tab"), "...and cleans up after itself");
  } finally {
    indicator.style.removeProperty("display");
  }

  // Everything still renames afterwards.
  document.getElementById(COMMAND).doCommand();
  let input = await waitForRename("After a failed rename");
  await typeNameAndSave(input, "Still renames");
  await setSpaceName(originalName);

  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  document.getElementById("cmd_whimsyRenameTab").doCommand();
  input = await TestUtils.waitForCondition(
    () => tab.querySelector("#tab-label-input"),
    "Rename Tab still works too"
  );
  is(document.activeElement, input, "...with focus in its field");
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(() => !renameInput(), "Escape ends it");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_an_edit_whose_field_vanished_blocks_nothing() {
  document.getElementById(COMMAND).doCommand();
  await waitForRename("Before");
  // Something removes the field without a blur (no blur ends the rename).
  renameInput().remove();
  ok(!renameInput(), "The field is gone");
  document.getElementById(COMMAND).doCommand();
  const input = await waitForRename("After the field vanished");
  await typeNameAndSave(input, "Renamed again");
  await setSpaceName(originalName);
});

add_task(async function test_in_compact_mode_the_sidebar_comes_out_first() {
  const wasCompact = gZenCompactModeManager.preference;
  try {
    gZenCompactModeManager.preference = true;
    await TestUtils.waitForCondition(
      () =>
        document.documentElement.getAttribute("zen-compact-mode") == "true" &&
        !document.documentElement.hasAttribute("zen-compact-animating"),
      "Compact mode is on"
    );
    gBrowser.selectedBrowser.focus();
    await settle();
    document.getElementById(COMMAND).doCommand();
    const input = await waitForRename("Compact mode");
    ok(input.checkVisibility({ visibilityProperty: true }), "The field is on screen: the sidebar slid out for it");
    await typeNameAndSave(input, "Renamed in compact mode");
    await setSpaceName(originalName);
  } finally {
    cancelRename();
    gZenCompactModeManager.preference = wasCompact;
    await TestUtils.waitForCondition(
      () => !document.documentElement.hasAttribute("zen-compact-animating"),
      "Compact mode settled"
    );
  }
});

add_task(async function test_not_offered_in_a_collapsed_sidebar() {
  const action = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs").globalActions.find(
    a => a.l10nId == "whimsy-action-rename-space"
  );
  ok(action.isAvailable(window), "Offered with the sidebar expanded");
  await SpecialPowers.pushPrefEnv({ set: [["zen.view.sidebar-expanded", false]] });
  await TestUtils.waitForCondition(() => !gZenVerticalTabsManager._prefsSidebarExpanded, "Sidebar collapsed");
  ok(!action.isAvailable(window), "Not offered with the sidebar collapsed (no name to edit), like Rename Tab");
  await SpecialPowers.popPrefEnv();
  await TestUtils.waitForCondition(() => gZenVerticalTabsManager._prefsSidebarExpanded, "Sidebar expanded again");
});
