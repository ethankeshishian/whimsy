/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Reorder spaces: Zen already lets you drag a space's icon along the
// switcher to move it (ZenSpaceIcons.mjs). This checks the drag reorders
// both the icons and the saved order, and that a plain click still just
// switches.

let created = [];

add_setup(async function () {
  for (const name of ["Second", "Third"]) {
    created.push((await gZenWorkspaces.createAndSaveWorkspace(name, undefined, true)).uuid);
  }
  registerCleanupFunction(async () => {
    for (const uuid of created) {
      await gZenWorkspaces.removeWorkspace(uuid);
    }
  });
});

function icons() {
  return [...document.querySelectorAll("#zen-workspaces-button > toolbarbutton[zen-workspace-id]")];
}

add_task(async function test_drag_icon_reorders() {
  await TestUtils.waitForCondition(() => icons().length == 3, "Three space icons");
  const [first, , third] = icons();
  const movedId = third.getAttribute("zen-workspace-id");
  const vertical = document.documentElement.getAttribute("zen-sidebar-expanded") != "true";
  const target = first.getBoundingClientRect();
  const from = third.getBoundingClientRect();

  // Press on the third icon, drag it over the first icon's leading half,
  // let go.
  EventUtils.synthesizeMouseAtCenter(third, { type: "mousedown" });
  const x = vertical ? target.left + target.width / 2 : target.left + 2;
  const y = vertical ? target.top + 2 : target.top + target.height / 2;
  EventUtils.synthesizeMouseAtPoint((x + from.left) / 2, (y + from.top) / 2, { type: "mousemove" });
  EventUtils.synthesizeMouseAtPoint(x, y, { type: "mousemove" });
  EventUtils.synthesizeMouseAtPoint(x, y, { type: "mouseup" });

  await TestUtils.waitForCondition(
    () => gZenWorkspaces.getWorkspaces()[0]?.uuid == movedId,
    "The dragged space is now first in the saved order"
  );
  is(icons()[0].getAttribute("zen-workspace-id"), movedId, "and its icon leads the switcher");
});

add_task(async function test_click_switches() {
  const target = icons().find(b => b.getAttribute("zen-workspace-id") != gZenWorkspaces.activeWorkspace);
  const uuid = target.getAttribute("zen-workspace-id");
  const before = gZenWorkspaces.getWorkspaces().map(w => w.uuid);
  EventUtils.synthesizeMouseAtCenter(target, {});
  await TestUtils.waitForCondition(() => gZenWorkspaces.activeWorkspace == uuid, "A click switches spaces");
  Assert.deepEqual(
    gZenWorkspaces.getWorkspaces().map(w => w.uuid),
    before,
    "A click leaves the order alone"
  );
});
