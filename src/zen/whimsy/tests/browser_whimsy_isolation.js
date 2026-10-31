/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave8/isolation: a tab never lives in a space whose profile (container)
// differs from its own userContextId, whatever path moves it, and a moved
// page never carries its old profile's cookies across. dev.580 report:
// "When I move a tab to another container, the accounts remain signed in."

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
const { WhimsyPrivate } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyPrivate.sys.mjs"
);
const { WhimsySnooze } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySnooze.sys.mjs"
);
const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
);

const PAGE = "https://example.com/";
const ATTR = "zen-workspace-id";
let home, work, workSpace, answers, asked;
const realConfirm = WhimsyProfileMoves.confirm;

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.space-profiles", true]] });
  home = gZenWorkspaces.getActiveWorkspace();
  work = WhimsyProfiles.create("Whimsy Isolation Work");
  workSpace = await gZenWorkspaces.createAndSaveWorkspace("Isolation Work", undefined, true, work);
  WhimsyIsolation.initWindow(window);
  asked = [];
  answers = [];
  WhimsyProfileMoves.confirm = async (win, request) => {
    asked.push(request);
    return answers.shift() ?? false;
  };
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

// The invariant, checked over every tab of the window.
function assertNoTabCrosses(when) {
  const crossing = gZenWorkspaces.allStoredTabs.filter(tab => WhimsyIsolation.violates(window, tab));
  is(crossing.length, 0, `${when}: no tab sits in a space of another profile`);
}

async function openHomeTab(url = PAGE) {
  if (gZenWorkspaces.activeWorkspace != home.uuid) {
    await gZenWorkspaces.changeWorkspace(home);
  }
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  is(tab.getAttribute(ATTR), home.uuid, "Starts in the home space");
  is(tab.userContextId, 0, "…in Default");
  return tab;
}

async function reopenedInWork(old) {
  const moved = await TestUtils.waitForCondition(() =>
    tabsOf(workSpace).find(t => t != old && t.userContextId == work), "Reopened in the Work profile");
  ok(old.closing || !old.isConnected, "The Default copy is gone");
  is(moved.userContextId, work, "Its container is the Work space's");
  return moved;
}

async function cleanup() {
  for (const tab of tabsOf(workSpace)) {
    BrowserTestUtils.removeTab(tab);
  }
  if (gZenWorkspaces.activeWorkspace != home.uuid) {
    await gZenWorkspaces.changeWorkspace(home);
  }
  assertNoTabCrosses("After the case");
}

// Move to Space / Move to New Space / Claude / Mini / split row / undo /
// archive: everything through Zen's moveTabsToWorkspace.
add_task(async function move_api_never_lets_the_tab_cross() {
  const tab = await openHomeTab();
  answers = [false];
  asked = [];
  gZenWorkspaces.moveTabToWorkspace(tab, workSpace.uuid);
  is(tab.getAttribute(ATTR), home.uuid, "Held back synchronously: never in Work, not even while asking");
  assertNoTabCrosses("While Arc's warning is up");
  await TestUtils.waitForCondition(() => asked.length == 1, "Arc's warning");
  await TestUtils.waitForTick();
  is(tab.getAttribute(ATTR), home.uuid, "No: it stays home");
  is(tab.userContextId, 0, "…in Default");

  answers = [true];
  gZenWorkspaces.moveTabToWorkspace(tab, workSpace.uuid);
  is(tab.getAttribute(ATTR), home.uuid, "Held back again");
  await reopenedInWork(tab);
  await cleanup();
});

// The Move to menu's own command (Zen's changeTabWorkspace) and the space
// icon drop (WhimsySpaces.moveToSpace) end in the same API.
add_task(async function space_icon_drop_reopens_in_the_destination() {
  const tab = await openHomeTab();
  answers = [true];
  asked = [];
  await WhimsySpaces.moveToSpace(window, tab, workSpace.uuid);
  await reopenedInWork(tab);
  is(asked.length, 1, "Asked once");
  await cleanup();
});

// Sidebar drag across spaces (ZenDragAndDrop #handle_dropSwitchSpace), Zen's
// share and anything else that only writes the attribute.
add_task(async function a_direct_attribute_move_is_put_back_and_asked() {
  const tab = await openHomeTab();
  answers = [false];
  asked = [];
  workSpaceElement().tabsContainer.appendChild(tab);
  tab.setAttribute(ATTR, workSpace.uuid);
  await TestUtils.waitForCondition(() => tab.getAttribute(ATTR) == home.uuid, "Put back at once");
  ok(gZenWorkspaces.workspaceElement(home.uuid).tabsContainer.contains(tab), "…in the home space's strip");
  await TestUtils.waitForCondition(() => asked.length == 1, "Then Arc's warning");
  is(tab.userContextId, 0, "No: still Default, still home");

  answers = [true];
  workSpaceElement().tabsContainer.appendChild(tab);
  tab.setAttribute(ATTR, workSpace.uuid);
  await reopenedInWork(tab);
  await cleanup();
});

function workSpaceElement() {
  return gZenWorkspaces.workspaceElement(workSpace.uuid);
}

// Folders moved to a space (Zen's changeFolderToSpace, a folder dropped on a
// space icon) carry their tabs with them.
add_task(async function a_folder_moved_across_profiles_reopens_its_tabs() {
  const tab = await openHomeTab();
  gBrowser.pinTab(tab);
  const folder = gZenFolders.createFolder([tab], { label: "Isolation", renameFolder: false, workspaceId: home.uuid });
  ok(folder, "A folder");
  answers = [true];
  asked = [];
  gZenFolders.changeFolderToSpace(folder, workSpace.uuid);
  await TestUtils.waitForCondition(() => asked.length == 1, "Arc's warning");
  const moved = await reopenedInWork(tab);
  is(moved.group, folder, "The reopened tab is in its folder");
  is(folder.getAttribute(ATTR), workSpace.uuid, "…and the folder is in Work");
  await folder.delete();
  await cleanup();
});

// A cookie of Default is never readable from the tab once it's in Work.
add_task(async function a_moved_tab_does_not_keep_its_old_cookies() {
  const tab = await openHomeTab();
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.cookie = "whimsy_isolation=signed-in; path=/";
  });
  ok(Services.cookies.getCookiesFromHost("example.com", { userContextId: 0 })
    .some(c => c.name == "whimsy_isolation"), "Default has the sign-in cookie");

  answers = [true];
  gZenWorkspaces.moveTabToWorkspace(tab, workSpace.uuid);
  const moved = await reopenedInWork(tab);
  if (!moved.linkedPanel) {
    await gZenWorkspaces.changeWorkspace(workSpace);
    gBrowser.selectedTab = moved;
  }
  await TestUtils.waitForCondition(() => moved.linkedBrowser.currentURI?.spec == PAGE, "Loaded in Work");
  await BrowserTestUtils.browserLoaded(moved.linkedBrowser, false, PAGE).catch(() => {});
  const seen = await SpecialPowers.spawn(moved.linkedBrowser, [], () => content.document.cookie);
  ok(!seen.includes("whimsy_isolation"), "The Work tab can't read Default's cookie");
  is(moved.linkedBrowser.contentPrincipal.originAttributes.userContextId, work, "Its page runs as Work");
  ok(!Services.cookies.getCookiesFromHost("example.com", { userContextId: work })
    .some(c => c.name == "whimsy_isolation"), "Work's jar never got it");
  // And the other way: a cookie Work sets stays in Work.
  await SpecialPowers.spawn(moved.linkedBrowser, [], () => {
    content.document.cookie = "whimsy_work=only-work; path=/";
  });
  ok(!Services.cookies.getCookiesFromHost("example.com", { userContextId: 0 })
    .some(c => c.name == "whimsy_work"), "Default never sees Work's cookie");
  await cleanup();
});

// A new tab in a container that isn't its space's (an explicit container
// tab, a route, a tab adopted from another window) goes to a space of its
// own profile.
add_task(async function a_new_tab_lands_in_its_own_profile_space() {
  if (gZenWorkspaces.activeWorkspace != home.uuid) {
    await gZenWorkspaces.changeWorkspace(home);
  }
  const tab = gBrowser.addTrustedTab(PAGE + "?fresh", { userContextId: work, inBackground: true });
  await TestUtils.waitForCondition(() => tab.getAttribute(ATTR) == workSpace.uuid, "Sorted into Work");
  is(tab.userContextId, work, "Same tab, same container: nothing crossed");
  assertNoTabCrosses("After a new container tab");
  await cleanup();
});

// A space whose profile changed (Set Profile from another device, Zen's own
// Set Container) or a session saved crossed by an older build: the tabs
// reopen in place.
add_task(async function the_sweep_reopens_crossed_tabs_in_place() {
  const tab = await openHomeTab();
  gBrowser.selectedTab = gBrowser.visibleTabs.find(t => t != tab) ?? gBrowser.selectedTab;
  WhimsyIsolation.quietly(window, () => {
    workSpaceElement().tabsContainer.appendChild(tab);
    tab.setAttribute(ATTR, workSpace.uuid);
  });
  ok(WhimsyIsolation.violates(window, tab), "Crossed, as dev.580 left it");
  WhimsyIsolation.sweep(window);
  await reopenedInWork(tab);
  await cleanup();
});

// Set Profile with the Profiles switch off still reopens (Zen's own Set
// Container left every tab in the old cookie jar).
add_task(async function set_profile_reopens_with_the_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.space-profiles", false]] });
  const other = await gZenWorkspaces.createAndSaveWorkspace("Isolation Other", undefined, true, 0);
  const tab = gBrowser.addTrustedTab(PAGE + "?other", { inBackground: true, userContextId: 0 });
  gZenWorkspaces.moveTabToWorkspace(tab, other.uuid);
  is(tab.getAttribute(ATTR), other.uuid, "In the other space");
  answers = [true];
  await WhimsyProfileMoves.moveSpace(window, other, work);
  const moved = await TestUtils.waitForCondition(() =>
    tabsOf(other).find(t => t.userContextId == work), "Reopened in the space's new profile");
  ok(moved, "Reopened");
  assertNoTabCrosses("After Set Profile");
  await gZenWorkspaces.removeWorkspace(other.uuid);
  await SpecialPowers.popPrefEnv();
});

// Private → normal: a private tab's pages never reach normal history, not
// when it moves to another profile, and it can't be snoozed (a snooze is
// saved to disk and comes back as a normal tab).
add_task(async function private_pages_never_reach_normal_history() {
  if (gZenWorkspaces.activeWorkspace != home.uuid) {
    await gZenWorkspaces.changeWorkspace(home);
  }
  const url = `${PAGE}?whimsy-private-${Date.now()}`;
  const tab = WhimsyPrivate.openPrivateTab(window, { url, force: true });
  ok(tab && WhimsyPrivate.isPrivateTab(tab), "A private tab");
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  ok(!(await PlacesUtils.history.hasVisits(url)), "Its page isn't in history");

  await WhimsySnooze.snooze(window, tab, Date.now() + 3600e3);
  ok(tab.isConnected && !tab.closing, "Snooze refuses a private tab");
  ok(!(await WhimsySnooze.list()).some(record => record.url == url), "…and saves nothing");

  answers = [true];
  gZenWorkspaces.moveTabToWorkspace(tab, workSpace.uuid);
  const moved = await reopenedInWork(tab);
  ok(WhimsyPrivate.isPrivateTab(moved), "Still private in Work");
  if (!moved.linkedPanel) {
    await gZenWorkspaces.changeWorkspace(workSpace);
    gBrowser.selectedTab = moved;
  }
  await TestUtils.waitForCondition(() => moved.linkedBrowser.browsingContext?.usePrivateBrowsing,
    "Browses privately");
  await TestUtils.waitForCondition(() => moved.linkedBrowser.currentURI?.spec == url, "Same page");
  await TestUtils.waitForTick();
  ok(!(await PlacesUtils.history.hasVisits(url)), "Still not in history after the move");
  await cleanup();
});

// Normal → private: a normal tab moved into Scratch goes back (it would
// keep writing history and normal cookies there).
add_task(async function a_normal_tab_never_moves_into_scratch() {
  const tab = await openHomeTab(PAGE + "?scratch");
  const scratch = await WhimsyPrivate.openScratch(window);
  ok(scratch, "Scratch is open");
  await gZenWorkspaces.changeWorkspace(home);
  gZenWorkspaces.workspaceElement(scratch.uuid).tabsContainer.appendChild(tab);
  tab.setAttribute(ATTR, scratch.uuid);
  await TestUtils.waitForCondition(() => tab.getAttribute(ATTR) == home.uuid, "Back home");
  ok(!WhimsyPrivate.isPrivateTab(tab), "Still the same normal tab");
  await WhimsyPrivate.closeScratch(window);
  BrowserTestUtils.removeTab(tab);
  await cleanup();
});
