/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W10-02 (hand test I1/I2): moving a tab to a space of another profile used
// to switch to that space while Arc's warning was still up, and once you
// said Yes the reopened tab sat unfocused there. Arc asks first: No stays
// put, Yes takes you to the space with the moved tab selected. Moving it
// back brings its old profile's sign-in (cookies) back with it.

const { WhimsyIsolation } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyIsolation.sys.mjs"
);
const { WhimsyProfiles } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyProfiles.sys.mjs"
);
const { WhimsyProfileMoves } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyProfileMoves.sys.mjs"
);
const { WhimsySpaces } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySpaces.sys.mjs"
);
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
);

const PAGE = "https://example.com/browser/";
const ATTR = "zen-workspace-id";
const realConfirm = WhimsyProfileMoves.confirm;
let home, work, workSpace;
// Each question waits here until the test answers it.
let pending = [];

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.space-profiles", true]] });
  home = gZenWorkspaces.getActiveWorkspace();
  work = WhimsyProfiles.create("Whimsy Follow Work");
  workSpace = await gZenWorkspaces.createAndSaveWorkspace("Follow Work", undefined, true, work);
  WhimsyIsolation.initWindow(window);
  WhimsyProfileMoves.wrapMoveTabs(window);
  WhimsyProfileMoves.wrapChangeTabWorkspace(window);
  WhimsyProfileMoves.wrapChangeFolderToSpace(window);
  WhimsyProfileMoves.confirm = () => new Promise(resolve => pending.push(resolve));
  registerCleanupFunction(async () => {
    WhimsyProfileMoves.confirm = realConfirm;
    if (gZenWorkspaces.activeWorkspace != home.uuid) {
      await gZenWorkspaces.changeWorkspace(home);
    }
    for (const tab of tabsOf(workSpace)) {
      BrowserTestUtils.removeTab(tab);
    }
    await gZenWorkspaces.removeWorkspace(workSpace.uuid);
    ContextualIdentityService.remove(work);
    Services.cookies.removeAll();
  });
});

function tabsOf(space) {
  return gZenWorkspaces.allStoredTabs.filter(tab => tab.getAttribute(ATTR) == space.uuid &&
    !tab.hasAttribute("zen-essential") && !tab.closing);
}

async function showHome() {
  if (gZenWorkspaces.activeWorkspace != home.uuid) {
    await gZenWorkspaces.changeWorkspace(home);
  }
}

async function openHomeTab() {
  await showHome();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  is(tab.getAttribute(ATTR), home.uuid, "Starts in the home space");
  return tab;
}

async function answer(value) {
  await TestUtils.waitForCondition(() => pending.length, "Arc's warning is up");
  // A switch begun with the warning up has had time to start by now.
  await new Promise(resolve => setTimeout(resolve, 300));
  is(gZenWorkspaces.activeWorkspace, home.uuid, "Still in the home space while asking");
  ok(!gZenWorkspaces._animatingChange, "…and no switch under way");
  pending.shift()(value);
}

// Zen's Move to ▸ space command, from the tab's menu.
function moveWithMenu(tab, spaceId) {
  TabContextMenu.contextTab = tab;
  return gZenWorkspaces.changeTabWorkspace(spaceId);
}

async function cleanup() {
  await showHome();
  for (const tab of tabsOf(workSpace)) {
    BrowserTestUtils.removeTab(tab);
  }
  pending = [];
}

add_task(async function move_to_switches_only_after_yes_and_selects_the_tab() {
  const tab = await openHomeTab();
  const done = moveWithMenu(tab, workSpace.uuid);
  await answer(true);
  await done;
  is(gZenWorkspaces.activeWorkspace, workSpace.uuid, "Yes: now showing the Work space");
  const moved = WhimsyProfileMoves.replacementOf(tab);
  isnot(moved, tab, "The tab was reopened");
  is(moved.userContextId, work, "…in Work's profile");
  is(gBrowser.selectedTab, moved, "…and it is the selected tab");
  await cleanup();
});

add_task(async function no_stays_in_place() {
  const tab = await openHomeTab();
  const done = moveWithMenu(tab, workSpace.uuid);
  await answer(false);
  await done;
  is(gZenWorkspaces.activeWorkspace, home.uuid, "No: still in the home space");
  is(gBrowser.selectedTab, tab, "…with the same tab selected");
  is(tab.userContextId, 0, "…still in Default");
  BrowserTestUtils.removeTab(tab);
  await cleanup();
});

add_task(async function a_background_tab_is_selected_after_the_move() {
  const tab = await openHomeTab();
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE + "?other");
  is(gBrowser.selectedTab, other, "The tab being moved isn't the selected one");
  const done = moveWithMenu(tab, workSpace.uuid);
  await answer(true);
  await done;
  const moved = WhimsyProfileMoves.replacementOf(tab);
  is(gZenWorkspaces.activeWorkspace, workSpace.uuid, "Showing Work");
  is(gBrowser.selectedTab, moved, "The moved tab is selected");
  BrowserTestUtils.removeTab(other);
  await cleanup();
});

add_task(async function a_space_icon_drop_waits_for_the_answer() {
  const tab = await openHomeTab();
  const done = WhimsySpaces.moveToSpace(window, tab, workSpace.uuid);
  await answer(true);
  await done;
  const moved = WhimsyProfileMoves.replacementOf(tab);
  is(gZenWorkspaces.activeWorkspace, workSpace.uuid, "Showing Work after Yes");
  is(gBrowser.selectedTab, moved, "The moved tab is selected");

  const back = await openHomeTab();
  const declined = WhimsySpaces.moveToSpace(window, back, workSpace.uuid);
  await answer(false);
  await declined;
  is(gZenWorkspaces.activeWorkspace, home.uuid, "No: no switch");
  BrowserTestUtils.removeTab(back);
  await cleanup();
});

add_task(async function a_folder_move_waits_for_the_answer() {
  const tab = await openHomeTab();
  gBrowser.pinTab(tab);
  const folder = gZenFolders.createFolder([tab], { label: "Follow", renameFolder: false, workspaceId: home.uuid });
  const done = gZenFolders.changeFolderToSpace(folder, workSpace.uuid);
  await answer(true);
  await done;
  is(gZenWorkspaces.activeWorkspace, workSpace.uuid, "Showing Work after Yes");
  is(folder.getAttribute(ATTR), workSpace.uuid, "The folder is in Work");
  await showHome();
  await folder.delete();
  await cleanup();
});

// I1: "Yes I was logged out" in the other profile (expected); moving back
// must bring the original profile's sign-in back.
add_task(async function moving_back_restores_the_original_sign_in() {
  const tab = await openHomeTab();
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.cookie = "whimsy_follow=signed-in; path=/";
  });
  let done = moveWithMenu(tab, workSpace.uuid);
  await answer(true);
  await done;
  const inWork = WhimsyProfileMoves.replacementOf(tab);
  await TestUtils.waitForCondition(() => inWork.linkedBrowser.currentURI?.spec == PAGE, "Loaded in Work");
  const workCookie = await SpecialPowers.spawn(inWork.linkedBrowser, [], async () => {
    await ContentTaskUtils.waitForCondition(() => content.document.readyState == "complete", "loaded");
    return content.document.cookie;
  });
  ok(!workCookie.includes("whimsy_follow"), "Signed out in Work");

  // Back home, from the Work space.
  TabContextMenu.contextTab = inWork;
  done = gZenWorkspaces.changeTabWorkspace(home.uuid);
  await TestUtils.waitForCondition(() => pending.length, "Asked again");
  is(gZenWorkspaces.activeWorkspace, workSpace.uuid, "Still in Work while asking");
  pending.shift()(true);
  await done;
  const backHome = WhimsyProfileMoves.replacementOf(tab);
  isnot(backHome, inWork, "Reopened once more");
  is(gZenWorkspaces.activeWorkspace, home.uuid, "Showing home");
  is(gBrowser.selectedTab, backHome, "The tab is selected");
  is(backHome.userContextId, 0, "Back in Default");
  await TestUtils.waitForCondition(() => backHome.linkedBrowser.currentURI?.spec == PAGE, "Loaded at home");
  const homeCookie = await SpecialPowers.spawn(backHome.linkedBrowser, [], async () => {
    await ContentTaskUtils.waitForCondition(() => content.document.readyState == "complete", "loaded");
    return content.document.cookie;
  });
  ok(homeCookie.includes("whimsy_follow=signed-in"), "Signed in again: Default's cookie is back");
  BrowserTestUtils.removeTab(backHome);
  await cleanup();
});
