/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// wave5/uxfix: reversible actions say what happened in a toast with an Undo
// button bound to that exact action (Cmd+Z still works too).

const { WhimsyUndo } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUndo.sys.mjs");
const { WhimsySpaceArchive } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySpaceArchive.sys.mjs");
const { WhimsyToast } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyToast.sys.mjs");

function clearToast() {
  const toast = WhimsyToast.current(window);
  if (toast) {
    WhimsyToast._dismissNow(toast);
  }
}

add_task(function undo_entry_undoes_that_one_action() {
  const ran = [];
  const a = { type: "a", undo: () => ran.push("a"), redo: null };
  const b = { type: "b", undo: () => ran.push("b"), redo: null };
  WhimsyUndo.push(window, a);
  WhimsyUndo.push(window, b);
  ok(WhimsyUndo.undoEntry(window, a), "An older entry can be undone from its toast");
  Assert.deepEqual(ran, ["a"], "Only that action was undone");
  ok(!WhimsyUndo.undoEntry(window, a), "...and only once");
  ok(WhimsyUndo.undo(window), "Cmd+Z then takes the newer one");
  Assert.deepEqual(ran, ["a", "b"], "In order");
});

add_task(async function hide_space_toast_offers_undo() {
  const original = gZenWorkspaces.getActiveWorkspace();
  await gZenWorkspaces.createAndSaveWorkspace("Hide me", undefined, true);
  const space = gZenWorkspaces.getActiveWorkspace();
  try {
    await WhimsySpaceArchive.toggleHidden(window, space.uuid);
    ok(space.whimsyHidden, "The space is hidden");
    const button = await TestUtils.waitForCondition(
      () => document.getElementById("whimsy-undo-toast-button"), "The toast has an Undo button");
    // wave8/snooze: the word shows (Zen's toast hid its buttons' text).
    await TestUtils.waitForCondition(() => button.textContent.includes("Undo"), "...that says Undo");
    ok(button.closest(".whimsy-toast"), "It's Whimsy's one undo toast");
    button.click();
    ok(!gZenWorkspaces.getWorkspaces().find(w => w.uuid == space.uuid).whimsyHidden, "Undo shows the space again");
  } finally {
    await gZenWorkspaces.removeWorkspace(space.uuid);
    if (original && gZenWorkspaces.getWorkspaceFromId(original.uuid)) {
      await gZenWorkspaces.changeWorkspace(original);
    }
  }
});

// wave8/snooze (W8-37): one toast for every undoable action. It says what
// happened, offers Undo in words with the shortcut beside it, is read out,
// waits while you point at it or tab to it, and Esc dismisses it.
add_task(async function undo_toast_component() {
  clearToast();
  const ran = [];
  const entry = { type: "test", undo: () => ran.push("undone"), redo: null };
  const toast = WhimsyUndo.showToast(window, "whimsy-hide-space-toast", entry, { space: "Work" }, { detail: "A second line" });
  ok(toast, "A toast shows");
  await document.l10n.translateFragment(toast);
  is(toast.getAttribute("role"), "status", "role=status");
  ok(toast.querySelector(".whimsy-toast-message").textContent, "It has a message");
  is(toast.querySelector(".whimsy-toast-detail").textContent, "A second line", "...and the second line");
  const button = toast.querySelector("button.whimsy-toast-action");
  is(button.querySelector(".whimsy-toast-action-label").textContent, "Undo", "The button says Undo");
  is(button.querySelector(".whimsy-toast-keys").textContent, WhimsyToast.undoKeys(), "...with the shortcut");
  ok(button.getAttribute("aria-keyshortcuts"), "The shortcut is announced too");
  Assert.greaterOrEqual(button.getBoundingClientRect().height, 24, "The button is a real target");
  Assert.greater(button.getBoundingClientRect().width, 40, "...wide enough for its word");

  // Focus pauses it (and hovering does the same).
  button.focus();
  is(document.activeElement, button, "The button can take keyboard focus");
  ok(WhimsyToast.isPaused(toast), "Focus keeps it on screen");
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  await TestUtils.waitForCondition(() => !toast.isConnected, "Esc dismisses it");
  Assert.deepEqual(ran, [], "...without undoing anything");
  ok(WhimsyUndo.canUndo(window), "Cmd+Z still can");
  WhimsyUndo.undo(window);
  Assert.deepEqual(ran, ["undone"], "Cmd+Z undid it");

  // One at a time: a new toast replaces the old one.
  const a = WhimsyUndo.showToast(window, "whimsy-hide-space-toast", { type: "a", undo() {}, redo: null }, { space: "A" });
  const b = WhimsyUndo.showToast(window, "whimsy-hide-space-toast", { type: "b", undo() {}, redo: null }, { space: "B" });
  ok(!a.isConnected, "The older toast is gone");
  is(WhimsyToast.current(window), b, "Only the newest shows");
  is(document.querySelectorAll("#whimsy-undo-toast-button").length, 1, "One Undo button");
  b.dispatchEvent(new MouseEvent("mouseenter"));
  ok(WhimsyToast.isPaused(b), "Pointing at it keeps it on screen");
  b.dispatchEvent(new MouseEvent("mouseleave"));
  if (Services.focus.activeWindow == window) {
    ok(!WhimsyToast.isPaused(b), "...and it carries on after");
  }
  clearToast();
  WhimsyUndo.undo(window);
  WhimsyUndo.undo(window);
});

add_task(async function plain_toast_without_the_switch() {
  clearToast();
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.undo-tab-actions", false]] });
  const toast = WhimsyUndo.showToast(window, "whimsy-hide-space-toast", { type: "x", undo() {}, redo: null }, { space: "X" });
  ok(toast, "Still says what happened");
  ok(!toast.querySelector(".whimsy-toast-action"), "...but offers no Undo when undo is off");
  clearToast();
  await SpecialPowers.popPrefEnv();
});
