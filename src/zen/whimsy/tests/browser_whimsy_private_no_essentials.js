/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W14-8: the Private Space shows no Essentials. They're normal tabs (Zen
// shows container 0's Essentials on every container-0 space, the Private
// Space included), so one picked there browsed with the normal cookie jar
// and history. They're hidden while it's the active space, left out of
// Ctrl+Tab, and picking one anyway takes you to the last normal space.

const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");

const PAGE = "https://example.com/browser/";
let startSpace;
let essential;

function essentialsShown() {
  const strip = document.getElementById("zen-essentials");
  return !!strip?.checkVisibility() && essential.checkVisibility();
}

function noEssentialInScratch() {
  return !(WhimsyPrivate.activeSpaceIsScratch(window) && gBrowser.selectedTab.hasAttribute("zen-essential"));
}

async function settle() {
  await TestUtils.waitForCondition(() => !gZenWorkspaces.isChangingWorkspace, "The space switch finished");
  await new Promise(resolve => setTimeout(resolve, 100));
}

async function openScratchByKey() {
  EventUtils.synthesizeKey("n", { accelKey: true, shiftKey: true });
  await TestUtils.waitForCondition(() => WhimsyPrivate.activeSpaceIsScratch(window), "The Private Space shows");
  await settle();
}

add_setup(async function () {
  startSpace = gZenWorkspaces.activeWorkspace;
  essential = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE + "?essential");
  gZenPinnedTabManager.addToEssentials(essential);
  await TestUtils.waitForCondition(() => essential.hasAttribute("zen-essential"), "An Essential");
  registerCleanupFunction(async () => {
    await WhimsyPrivate.closeScratch(window);
    if (gZenWorkspaces.activeWorkspace != startSpace) {
      await gZenWorkspaces.changeWorkspaceWithID(startSpace);
    }
    if (essential.hasAttribute("zen-essential")) {
      gZenPinnedTabManager.removeEssentials(essential);
    }
    if (essential.isConnected && !essential.closing) {
      BrowserTestUtils.removeTab(essential);
    }
  });
});

add_task(async function hidden_in_the_private_space_shown_elsewhere() {
  await TestUtils.waitForCondition(essentialsShown, "The Essential shows in a normal space");
  ok(!document.documentElement.hasAttribute("whimsy-scratch-active"), "Not marked outside the Private Space");

  await openScratchByKey();
  ok(document.documentElement.hasAttribute("whimsy-scratch-active"), "The window knows the Private Space is active");
  ok(!essentialsShown(), "No Essential shows in the Private Space");
  ok(!document.getElementById("zen-essentials").checkVisibility(), "The Essentials strip is hidden");
  ok(!ctrlTab.tabList.includes(essential), "Ctrl+Tab doesn't list the Essential there");

  await gZenWorkspaces.changeWorkspaceWithID(startSpace);
  await settle();
  ok(!document.documentElement.hasAttribute("whimsy-scratch-active"), "The mark goes once you leave");
  await TestUtils.waitForCondition(essentialsShown, "The Essential shows again");
  ok(ctrlTab.tabList.includes(essential) || !ctrlTab.isOpen, "Ctrl+Tab may list it again");
});

add_task(async function picking_an_essential_leaves_the_private_space() {
  await openScratchByKey();
  const tab = WhimsyPrivate.openPrivateTab(window, { url: PAGE + "?private" });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PAGE + "?private");
  ok(WhimsyPrivate.activeSpaceIsScratch(window), "Still in the Private Space");

  gBrowser.selectedTab = essential;
  await TestUtils.waitForCondition(() => !WhimsyPrivate.activeSpaceIsScratch(window), "Picking it left the Private Space");
  await settle();
  is(gZenWorkspaces.activeWorkspace, startSpace, "…for the normal space you came from");
  is(gBrowser.selectedTab, essential, "…where the Essential is selected");
  ok(noEssentialInScratch(), "No Essential is selected in the Private Space");
  ok(WhimsyPrivate.getScratch(window), "The Private Space with a tab stays");

  // Back, then the keyboard's previous-tab from its first tab.
  gBrowser.selectedTab = tab;
  await TestUtils.waitForCondition(() => WhimsyPrivate.activeSpaceIsScratch(window), "Back in the Private Space");
  await settle();
  for (let i = 0; i < 3; i++) {
    EventUtils.synthesizeKey("KEY_PageUp", { ctrlKey: true });
    await settle();
    ok(noEssentialInScratch(), `Ctrl+PageUp ${i + 1} never lands on an Essential in the Private Space`);
  }
  for (let i = 0; i < 3; i++) {
    EventUtils.synthesizeKey("KEY_PageDown", { ctrlKey: true });
    await settle();
    ok(noEssentialInScratch(), `Ctrl+PageDown ${i + 1} never lands on an Essential in the Private Space`);
  }

  if (!WhimsyPrivate.activeSpaceIsScratch(window)) {
    gBrowser.selectedTab = tab;
    await TestUtils.waitForCondition(() => WhimsyPrivate.activeSpaceIsScratch(window), "Back in the Private Space");
    await settle();
  }
  // Closing its last tab keeps you in the Private Space, on its empty state.
  BrowserTestUtils.removeTab(tab);
  await TestUtils.waitForCondition(() => gBrowser.selectedTab.hasAttribute("zen-empty-tab"), "The empty tab is selected");
  await settle();
  ok(WhimsyPrivate.activeSpaceIsScratch(window), "Closing the last private tab stays in the Private Space");
  ok(!essentialsShown(), "…with no Essentials");
  await gZenWorkspaces.changeWorkspaceWithID(startSpace);
  await TestUtils.waitForCondition(() => !WhimsyPrivate.getScratch(window), "Leaving it empty closes it", 100, 300);
});

// W16-11: in the Private Space, Cmd+1 to Cmd+8 pick its own tabs and Cmd+9
// its last; they never leave it, and with no tabs they do nothing.
add_task(async function cmd_numbers_pick_the_private_spaces_own_tabs() {
  await openScratchByKey();
  ok(gBrowser.selectedTab.hasAttribute("zen-empty-tab") || !gBrowser.selectedTab.hasAttribute("zen-essential"),
    "In the empty Private Space");
  const before = gBrowser.selectedTab;
  EventUtils.synthesizeKey("1", { accelKey: true });
  await settle();
  ok(WhimsyPrivate.activeSpaceIsScratch(window), "Empty: Cmd+1 stays in the Private Space");
  is(gBrowser.selectedTab, before, "…and changes nothing");

  const tabs = [];
  for (const n of [1, 2, 3]) {
    const tab = WhimsyPrivate.openPrivateTab(window, { url: PAGE + "?cmd" + n });
    await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PAGE + "?cmd" + n);
    tabs.push(tab);
  }
  gBrowser.selectedTab = tabs[2];
  await settle();
  for (const [key, want, what] of [["1", tabs[0], "the first"], ["2", tabs[1], "the second"], ["9", tabs[2], "the last"]]) {
    EventUtils.synthesizeKey(key, { accelKey: true });
    await settle();
    is(gBrowser.selectedTab, want, `Cmd+${key} picks ${what} private tab`);
    ok(WhimsyPrivate.activeSpaceIsScratch(window), "…in the Private Space");
  }
  for (const tab of tabs) {
    BrowserTestUtils.removeTab(tab);
  }
  await settle();
  await gZenWorkspaces.changeWorkspaceWithID(startSpace);
  await TestUtils.waitForCondition(() => !WhimsyPrivate.getScratch(window), "Leaving it empty closes it", 100, 300);
});

// W16-11: with separate Essentials, a space with a profile doesn't show a
// container-0 Essential, so picking one from the Private Space lands in a
// space that does.
add_task(async function an_essential_opens_in_a_space_that_shows_it() {
  const profiled = await gZenWorkspaces.createAndSaveWorkspace("Work profile", undefined, true, 2);
  try {
    await gZenWorkspaces.changeWorkspaceWithID(profiled.uuid);
    await settle();
    await openScratchByKey();
    const tab = WhimsyPrivate.openPrivateTab(window, { url: PAGE + "?profiled" });
    await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PAGE + "?profiled");
    gBrowser.selectedTab = essential;
    await TestUtils.waitForCondition(() => !WhimsyPrivate.activeSpaceIsScratch(window), "Picking it left the Private Space");
    await settle();
    const landed = gZenWorkspaces.getWorkspaces().find(w => w.uuid == gZenWorkspaces.activeWorkspace);
    is(landed.containerTabId || 0, 0, "…for a space without a profile, which shows it");
    is(gBrowser.selectedTab, essential, "…where the Essential is selected");
    gBrowser.selectedTab = tab;
    await TestUtils.waitForCondition(() => WhimsyPrivate.activeSpaceIsScratch(window), "Back in the Private Space");
    await settle();
    BrowserTestUtils.removeTab(tab);
    await settle();
  } finally {
    await gZenWorkspaces.changeWorkspaceWithID(startSpace);
    await settle();
    await WhimsyPrivate.closeScratch(window);
    await gZenWorkspaces.removeWorkspace(profiled.uuid);
  }
});
