/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// wave5/uxfix: reversible actions say what happened in a toast with an Undo
// button bound to that exact action (Cmd+Z still works too).

const { WhimsyUndo } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUndo.sys.mjs");
const { WhimsySpaceArchive } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySpaceArchive.sys.mjs");
function clearToast() {
  closeToasts();
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
    ok(button.closest(".zen-toast"), "It's Zen's toast, with the one Undo button");
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
// wave13/toast: it's Zen's toast (gZenUIManager.toasts), extended.
add_task(async function undo_toast_component() {
  clearToast();
  const ran = [];
  const entry = { type: "test", undo: () => ran.push("undone"), redo: null };
  const toast = WhimsyUndo.showToast(window, "whimsy-hide-space-toast", entry, { space: "Work" }, { detail: "A second line" });
  ok(toast, "A toast shows");
  ok(toast.element.classList.contains("zen-toast"), "Zen's toast");
  await document.l10n.translateFragment(toast.element);
  is(toast.element.getAttribute("role"), "status", "role=status");
  ok(toast.element.querySelector("label").textContent, "It has a message");
  is(toast.element.querySelector(".description").textContent, "A second line", "...and the second line");
  const button = toast.element.querySelector("button.whimsy-toast-button");
  is(button.querySelector(".whimsy-toast-button-label").textContent, "Undo", "The button says Undo");
  ok(button.querySelector(".whimsy-toast-button-label").checkVisibility(), "...and the word shows");
  is(button.querySelector(".whimsy-toast-keys").textContent, WhimsyUndo.undoKeys(), "...with the shortcut");
  ok(button.getAttribute("aria-keyshortcuts"), "The shortcut is announced too");
  Assert.greaterOrEqual(button.getBoundingClientRect().height, 24, "The button is a real target");
  Assert.greater(button.getBoundingClientRect().width, 40, "...wide enough for its word");

  // Focus pauses it (and hovering does the same).
  button.focus();
  is(document.activeElement, button, "The button can take keyboard focus");
  ok(toast.paused, "Focus keeps it on screen");
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  await TestUtils.waitForCondition(() => toast.closed, "Esc dismisses it");
  Assert.deepEqual(ran, [], "...without undoing anything");
  ok(WhimsyUndo.canUndo(window), "Cmd+Z still can");
  WhimsyUndo.undo(window);
  Assert.deepEqual(ran, ["undone"], "Cmd+Z undid it");

  // One at a time: a new undo toast replaces the old one, in place.
  const a = WhimsyUndo.showToast(window, "whimsy-hide-space-toast", { type: "a", undo() {}, redo: null }, { space: "A" });
  const element = a.element;
  const b = WhimsyUndo.showToast(window, "whimsy-hide-space-toast", { type: "b", undo() {}, redo: null }, { space: "B" });
  is(b, a, "The newer one takes the older one's place");
  is(b.element, element, "...without a second toast");
  Assert.deepEqual(document.l10n.getAttributes(b.element.querySelector("label")).args, { space: "B" }, "It says the newer one");
  is(gZenUIManager.toasts.getToasts().filter(t => t.key == "whimsy-undo").length, 1, "Only the newest shows");
  is(document.querySelectorAll("#whimsy-undo-toast-button").length, 1, "One Undo button");
  b.element.dispatchEvent(new MouseEvent("mouseover"));
  ok(b.paused, "Pointing at it keeps it on screen");
  b.element.dispatchEvent(new MouseEvent("mouseout"));
  if (Services.focus.activeWindow == window) {
    ok(!b.paused, "...and it carries on after");
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
  ok(!toast.element.querySelector(".whimsy-toast-button"), "...but offers no Undo when undo is off");
  clearToast();
  await SpecialPowers.popPrefEnv();
});
