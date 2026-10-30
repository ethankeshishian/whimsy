/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// fixB: Delete Space asks inside the window (gDialogBox, Zen's dialog
// style) instead of a separate system alert, with a "Delete Space" button.
// Cancel keeps the space; accept deletes it.

async function openDeleteConfirm() {
  const dialog = BrowserTestUtils.promiseAlertDialogOpen(null);
  const deleting = gZenWorkspaces.contextDeleteWorkspace();
  const win = await dialog;
  return { win, deleting };
}

add_task(async function test_delete_space_confirms_in_window() {
  const space = await gZenWorkspaces.createAndSaveWorkspace("Delete me", undefined, true);
  const original = gZenWorkspaces.activeWorkspace;
  registerCleanupFunction(async () => {
    if (gZenWorkspaces.getWorkspaceFromId(space.uuid)) {
      await gZenWorkspaces.removeWorkspace(space.uuid);
    }
  });
  await gZenWorkspaces.changeWorkspace(space);

  let { win, deleting } = await openDeleteConfirm();
  ok(window.gDialogBox.isOpen, "The confirm opens inside the browser window, not as its own window");
  const dialogEl = win.document.querySelector("dialog");
  is(dialogEl.getButton("accept").label, "Delete Space", "The accept button says what it does");
  dialogEl.getButton("cancel").click();
  await deleting;
  ok(gZenWorkspaces.getWorkspaceFromId(space.uuid), "Cancel keeps the space");

  ({ win, deleting } = await openDeleteConfirm());
  win.document.querySelector("dialog").getButton("accept").click();
  await deleting;
  await TestUtils.waitForCondition(() => !gZenWorkspaces.getWorkspaceFromId(space.uuid), "Accept deletes the space");
  ok(true, "The space is gone");
  if (gZenWorkspaces.activeWorkspace != original && gZenWorkspaces.getWorkspaceFromId(original)) {
    await gZenWorkspaces.changeWorkspace(gZenWorkspaces.getWorkspaceFromId(original));
  }
});
