/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W14-14: a covered tab (the locked Private Space, or a space behind Lock
// Space) can't be moved out without unlocking. Every way out asks to unlock
// and moves nothing when that's cancelled; a tab that left anyway (a path no
// guard knows) stays covered until you unlock. The OS prompt is a stand-in
// (WhimsyAuth._reauthenticator) that answers no.

const { WhimsyPrivateLock } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivateLock.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const { WhimsySpaceLock } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySpaceLock.sys.mjs");
const { WhimsyAuth } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAuth.sys.mjs");
const { WhimsySurface } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySurface.sys.mjs");
const { WhimsyPrivateMove } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivateMove.sys.mjs");

let answer = false;
let asked = 0;
let startSpace;
let scratch;
let tabA;
let tabB;

function uniqueURL(tag) {
  return `https://example.com/browser/?${tag}=${Date.now()}${Math.random().toString(36).slice(2)}`;
}

async function openPrivateTab(tag) {
  const url = uniqueURL(tag);
  const tab = WhimsyPrivate.openPrivateTab(window, { url });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  return tab;
}

const settle = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 50)));

function browserWindows() {
  return [...Services.wm.getEnumerator("navigator:browser")].filter(w => !w.closed);
}

// The tab is where it was, private and covered.
function assertStayed(tab, what) {
  ok(tab.isConnected && !tab.closing, `${what}: the tab is still open`);
  is(tab.documentGlobal, window, `${what}: …in this window`);
  is(tab.getAttribute("zen-workspace-id"), scratch.uuid, `${what}: …in the Private Space`);
  ok(tab.linkedBrowser.browsingContext.usePrivateBrowsing, `${what}: …private`);
  ok(WhimsyPrivateLock.isTabHidden(window, tab), `${what}: …and covered`);
}

async function expectAsked(before, what) {
  await TestUtils.waitForCondition(() => asked > before, `${what}: asked to unlock`);
  await settle();
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.privateLock.space", 1]] });
  WhimsyAuth._reauthenticator = {
    async asyncReauthenticateUser() {
      asked++;
      return [answer, false];
    },
  };
  startSpace = gZenWorkspaces.activeWorkspace;
  registerCleanupFunction(async () => {
      answer = true;
    WhimsyAuth._reauthenticator = null;
    WhimsyPrivateLock.unlockAll();
    for (const w of browserWindows()) {
      if (w != window) {
        await BrowserTestUtils.closeWindow(w);
      }
    }
    await WhimsyPrivate.closeScratch(window);
    if (gZenWorkspaces.activeWorkspace != startSpace) {
      await gZenWorkspaces.changeWorkspaceWithID(startSpace);
    }
    await SpecialPowers.flushPrefEnv();
  });

  EventUtils.synthesizeKey("n", { accelKey: true, shiftKey: true });
  await TestUtils.waitForCondition(() => WhimsyPrivate.activeSpaceIsScratch(window), "The Private Space shows");
  scratch = WhimsyPrivate.getScratch(window);
  tabA = await openPrivateTab("a");
  tabB = await openPrivateTab("b");
  document.getElementById("cmd_whimsyLockPrivateNow").doCommand();
  ok(WhimsyPrivateLock.isLocked("space"), "The Private Space is locked");
  await settle();
  assertStayed(tabA, "Locked");
  assertStayed(tabB, "Locked");
});

add_task(async function move_out_of_private() {
  gBrowser.selectedTab = tabB;
  await settle();
  const before = asked;
  document.getElementById("cmd_whimsyMoveOutOfPrivate").doCommand();
  await expectAsked(before, "Move Out of Private");
  ok(!WhimsySurface.isOpen(window, WhimsyPrivateMove.PANEL_ID), "No picker opened");
  ok(!(await WhimsyPrivateMove.move(window, [tabB], startSpace)), "The move itself refuses too");
  assertStayed(tabB, "Move Out of Private");
  ok(!gZenWorkspaces.allStoredTabs.some(t => t.getAttribute("zen-workspace-id") == startSpace &&
    t.linkedBrowser?.currentURI?.spec == tabB.linkedBrowser.currentURI.spec), "Nothing reopened outside");
});

add_task(async function move_tab_to_a_space() {
  let before = asked;
  document.getElementById("cmd_whimsyMoveTabToSpace1").doCommand();
  await expectAsked(before, "Move Tab to Space 1");
  assertStayed(tabB, "Move Tab to Space 1");
  // Next/Prev never move a tab out of the Private Space.
  for (const id of ["cmd_whimsyMoveTabToNextSpace", "cmd_whimsyMoveTabToPrevSpace"]) {
    document.getElementById(id).doCommand();
    await settle();
    assertStayed(tabB, id);
  }
  // Zen's own move (Move Tab ▸ space, a split row, the command bar).
  before = asked;
  gZenWorkspaces.moveTabsToWorkspace([tabB], startSpace);
  await expectAsked(before, "moveTabsToWorkspace");
  assertStayed(tabB, "moveTabsToWorkspace");
  gZenWorkspaces.moveTabToWorkspace(tabA, startSpace);
  await settle();
  assertStayed(tabA, "moveTabToWorkspace");
});

add_task(async function move_to_a_new_space_or_save_as_space() {
  let before = asked;
  document.getElementById("cmd_whimsyMoveToNewSpace").doCommand();
  await expectAsked(before, "Move to New Space");
  ok(!document.documentElement.hasAttribute("zen-creating-workspace"), "No New Space form");
  assertStayed(tabB, "Move to New Space");

  before = asked;
  await WhimsyPrivate.saveScratch(window);
  ok(asked > before, "Save as Space asked to unlock");
  ok(!document.documentElement.hasAttribute("zen-creating-workspace"), "No form");
  ok(WhimsyPrivate.getScratch(window)?.whimsyScratch, "Still the Private Space");
  assertStayed(tabA, "Save as Space");
  ok(!(await WhimsyPrivate.keepScratch(window)), "Keeping it refuses too");
  assertStayed(tabA, "Keep");
});

add_task(async function new_window_and_other_windows() {
  const windowsBefore = browserWindows().length;
  let before = asked;
  is(gBrowser.replaceTabWithWindow(tabB), null, "Move to New Window refuses");
  is(gBrowser.replaceTabsWithWindow(tabA), null, "…for several tabs too");
  await expectAsked(before, "Move to New Window");
  is(browserWindows().length, windowsBefore, "No window opened");
  assertStayed(tabB, "Move to New Window");

  const startTabs = new Set(gZenWorkspaces.allStoredTabs);
  const other = await BrowserTestUtils.openNewBrowserWindow();
  before = asked;
  is(other.gBrowser.adoptTab(tabB), null, "Another window can't adopt it");
  await expectAsked(before, "adoptTab");
  assertStayed(tabB, "adoptTab");
  const blank = BrowserTestUtils.addTab(other.gBrowser, "about:blank");
  ok(!other.gBrowser.swapBrowsersAndCloseOther(blank, tabB), "…or swap its page in");
  assertStayed(tabB, "swapBrowsersAndCloseOther");
  await BrowserTestUtils.closeWindow(other);
  // Zen's window sync mirrored the other window's tabs here.
  for (const tab of gZenWorkspaces.allStoredTabs.filter(t => !startTabs.has(t) && !t.hasAttribute("zen-empty-tab"))) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function drag_split_and_menu() {
  // Every drag (to a space icon, another window, the desktop) starts here.
  const drag = new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
  const before = asked;
  tabA.dispatchEvent(drag);
  ok(drag.defaultPrevented, "A covered tab's drag never starts");
  await expectAsked(before, "Drag");

  is(gZenViewSplitter.splitTabs([tabA, tabB]), undefined, "No split with a covered tab");
  ok(!tabA.splitView && !tabB.splitView, "…none made");

  // The tab menu on the "N private tabs" row: only closing works.
  gBrowser.selectedTab = tabA;
  await settle();
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
  EventUtils.synthesizeMouseAtCenter(tabA, { type: "contextmenu", button: 2 });
  await shown;
  const enabled = [...menu.querySelectorAll(":scope > menuitem, :scope > menu")]
    .filter(item => !item.hidden && !item.disabled).map(item => item.id);
  ok(enabled.length && enabled.every(id => /close/i.test(id)), `Only closing is offered: ${enabled.join(", ")}`);
  for (const id of ["context_moveTabOptions", "context_sendTabToDevice", "context_duplicateTab", "context_whimsyMoveOutOfPrivate"]) {
    const item = document.getElementById(id);
    ok(!item || item.hidden || item.disabled, `${id} isn't offered`);
  }
  const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
  menu.hidePopup();
  await hidden;
  ok(!document.getElementById("context_duplicateTab").hidden, "The menu's items come back once it closes");
});

add_task(async function a_tab_that_left_anyway_stays_covered() {
  // What Zen's drop on another space does: set the space directly.
  tabB.setAttribute("zen-workspace-id", startSpace);
  ok(WhimsyPrivateLock.isTabHidden(window, tabB), "The page is still covered where it landed");
  ok(WhimsyPrivateLock.hiddenPages().has(tabB.linkedBrowser.currentURI.spec), "…and kept out of the command bar");
  tabB.setAttribute("zen-workspace-id", scratch.uuid);
});

add_task(async function unlocked_it_moves() {
  answer = true;
  ok(await WhimsyPrivateLock.unlock(window), "Unlocked");
  ok(!WhimsyPrivateLock.isTabHidden(window, tabB), "Nothing covered");
  gZenWorkspaces.moveTabsToWorkspace([tabB], startSpace);
  await settle();
  is(tabB.getAttribute("zen-workspace-id"), startSpace, "Unlocked, the tab moves");
  ok(tabB.linkedBrowser.browsingContext.usePrivateBrowsing, "…and stays private");
  BrowserTestUtils.removeTab(tabB);
  answer = false;
});

add_task(async function a_locked_space_keeps_its_tabs() {
  answer = true;
  const bank = await gZenWorkspaces.createAndSaveWorkspace("Bank", undefined, true);
  const tab = BrowserTestUtils.addTab(gBrowser, "https://example.com/browser/?bank", { skipAnimation: true });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  gZenWorkspaces.moveTabsToWorkspace([tab], bank.uuid);
  await gZenWorkspaces.changeWorkspaceWithID(bank.uuid);
  gBrowser.selectedTab = tab;
  ok(await WhimsySpaceLock.toggleLocked(window, bank.uuid), "Lock Space");
  answer = false;
  WhimsySpaceLock.lockAll();
  await settle();
  ok(WhimsySpaceLock.isCovered(bank.uuid), "The space is covered");
  ok(WhimsyPrivateLock.isTabHidden(window, tab), "…and its tab");

  for (const id of ["cmd_whimsyMoveTabToNextSpace", "cmd_whimsyMoveTabToPrevSpace"]) {
    const before = asked;
    document.getElementById(id).doCommand();
    await TestUtils.waitForCondition(() => asked > before, `${id} asked to unlock`);
    await settle();
    is(tab.getAttribute("zen-workspace-id"), bank.uuid, `${id}: the tab stayed in the locked space`);
  }
  is(gBrowser.replaceTabWithWindow(tab), null, "Move to New Window refuses");
  tab.setAttribute("zen-workspace-id", startSpace);
  await settle();
  WhimsyPrivateLock.renderAll();
  ok(WhimsyPrivateLock.isTabHidden(window, tab), "A tab that left the covered space stays covered");

  answer = true;
  ok(await WhimsySpaceLock.ensureUnlocked(window, WhimsySpaceLock.space(bank.uuid)), "Unlocked");
  ok(!WhimsyPrivateLock.isTabHidden(window, tab), "…then it shows");
  const workspace = gZenWorkspaces.getWorkspaces().find(w => w.uuid == bank.uuid);
  delete workspace.whimsyLocked;
  gZenWorkspaces.saveWorkspace(workspace);
  BrowserTestUtils.removeTab(tab);
  await gZenWorkspaces.changeWorkspaceWithID(startSpace);
  await gZenWorkspaces.removeWorkspace(bank.uuid);
});
