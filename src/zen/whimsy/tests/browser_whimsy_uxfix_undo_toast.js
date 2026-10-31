/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// wave5/uxfix: reversible actions say what happened in a toast with an Undo
// button bound to that exact action (Cmd+Z still works too).

const { WhimsyUndo } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUndo.sys.mjs");
const { WhimsySpaceArchive } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySpaceArchive.sys.mjs");

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
    await TestUtils.waitForCondition(() => button.getAttribute("label") == "Undo", "...labelled Undo");
    button.doCommand();
    ok(!gZenWorkspaces.getWorkspaces().find(w => w.uuid == space.uuid).whimsyHidden, "Undo shows the space again");
  } finally {
    await gZenWorkspaces.removeWorkspace(space.uuid);
    if (original && gZenWorkspaces.getWorkspaceFromId(original.uuid)) {
      await gZenWorkspaces.changeWorkspace(original);
    }
  }
});
