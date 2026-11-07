/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

let library;
let space;
const pinned = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

add_setup(async function () {
  library = document.querySelector("zen-library");
  ok(library, "The Library exists");
  const wasOpen = library.constructor.isLibraryOpen;
  const previousSection = library.activeTab;
  const previousSpace = gZenWorkspaces.getWorkspaces().find(
    workspace => workspace.uuid === gZenWorkspaces.activeWorkspace
  );
  const workspace = await gZenWorkspaces.createAndSaveWorkspace("Library idle pins");
  space = gZenWorkspaces.workspaceElement(workspace.uuid);
  registerCleanupFunction(async () => {
    await library.constructor.animateProgress(0);
    space.collapsiblePins.collapsed = false;
    for (const tab of pinned) {
      if (tab.isConnected) {
        BrowserTestUtils.removeTab(tab);
      }
    }
    await gZenWorkspaces.changeWorkspace(previousSpace);
    await gZenWorkspaces.removeWorkspace(workspace.uuid);
    library.activeTab = previousSection;
    await library.constructor.animateProgress(wasOpen ? 1 : 0);
  });
  for (let index = 0; index < 3; index++) {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
    pinned.push(tab);
    gBrowser.pinTab(tab);
  }
  await TestUtils.waitForCondition(
    () => pinned.every(tab => tab.pinned && tab.getAttribute("zen-workspace-id") === space.id),
    "Three real pinned tabs belong to the test space"
  );
});

async function assertIdle(collapsed) {
  await library.constructor.animateProgress(0);
  space.collapsiblePins.collapsed = collapsed;
  is(space.hasCollapsedPinnedTabs, collapsed, "The real pinned section has the requested state");
  library.activeTab = "spaces";
  await library.constructor.animateProgress(1);
  await library.updateComplete;
  await TestUtils.waitForCondition(
    () => library.querySelector(`.zen-library-space[data-uuid="${space.id}"]`),
    "The test space has a card"
  );
  const card = library.querySelector(`.zen-library-space[data-uuid="${space.id}"]`);
  card.scrollIntoView({ block: "nearest", inline: "center", behavior: "instant" });
  const strip = card.querySelector(".zen-library-space-tabs");
  await TestUtils.waitForCondition(
    () => pinned.every(tab => strip.querySelector(`[id="${tab.id}-copy"][zen-library-copy]`)),
    "All three pinned copies are connected in the visible card"
  );
  // Allow the opening animation and the 100 ms refresh debounce to settle.
  await delay(1000);
  let mutations = 0;
  const observer = new MutationObserver(records => {
    mutations += records.filter(record => record.type === "childList").length;
  });
  observer.observe(strip, { childList: true });
  try {
    await delay(2000);
    mutations += observer.takeRecords().length;
    is(mutations, 0, `No idle card rebuilds with pins ${collapsed ? "collapsed" : "expanded"}`);
  } finally {
    observer.disconnect();
  }
}

add_task(async function test_collapsed_pins_do_not_rebuild_idle_cards() {
  await assertIdle(true);
});

add_task(async function test_expanded_pins_do_not_rebuild_idle_cards() {
  await assertIdle(false);
});
