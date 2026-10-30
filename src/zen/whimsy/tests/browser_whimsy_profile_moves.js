/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave5/profiles, phase 6: moving a space or a tab into another profile asks
// first (Arc's warning) and then really reopens the pages in the new
// container; saying no changes nothing.

const { WhimsyProfiles } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyProfiles.sys.mjs"
);
const { WhimsyProfileMoves } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyProfileMoves.sys.mjs"
);
const { WhimsyPrivate } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyPrivate.sys.mjs"
);
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
);

const PAGE = "https://example.com/";
let home, work, workSpace, answers, asked;
const realConfirm = WhimsyProfileMoves.confirm;

add_setup(async function () {
  home = gZenWorkspaces.getActiveWorkspace();
  work = WhimsyProfiles.create("Whimsy Moves Work");
  workSpace = await gZenWorkspaces.createAndSaveWorkspace("Moves Work", undefined, true, work);
  WhimsyProfileMoves.wrapMoveTabs(window);
  asked = [];
  WhimsyProfileMoves.confirm = async (win, request) => {
    asked.push(request);
    return answers.shift() ?? false;
  };
  registerCleanupFunction(async () => {
    WhimsyProfileMoves.confirm = realConfirm;
    if (gZenWorkspaces.activeWorkspace != home.uuid) {
      await gZenWorkspaces.changeWorkspace(home);
    }
    await gZenWorkspaces.removeWorkspace(workSpace.uuid);
    ContextualIdentityService.remove(work);
  });
});

function tabsOf(space) {
  return gBrowser.tabs.filter(tab => tab.getAttribute("zen-workspace-id") == space.uuid &&
    !tab.hasAttribute("zen-essential"));
}

add_task(async function moving_a_tab_asks_then_reopens_it() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  is(tab.getAttribute("zen-workspace-id"), home.uuid, "Starts in the Default space");

  answers = [false];
  asked = [];
  gZenWorkspaces.moveTabToWorkspace(tab, workSpace.uuid);
  await TestUtils.waitForCondition(() => asked.length == 1, "Arc's warning");
  is(asked[0].bodyId, "whimsy-profile-move-tab-body", "The tab warning");
  is(asked[0].bodyArgs.profile, "Whimsy Moves Work", "Names the profile");
  await TestUtils.waitForCondition(() => tab.getAttribute("zen-workspace-id") == home.uuid,
    "No: the tab goes back");
  is(tab.userContextId, 0, "…still in Default");

  answers = [true];
  asked = [];
  gZenWorkspaces.moveTabToWorkspace(tab, workSpace.uuid);
  const moved = await TestUtils.waitForCondition(() =>
    tabsOf(workSpace).find(t => t.userContextId == work), "Yes: reopened in Work");
  ok(tab.closing || !tab.isConnected, "The Default copy is closed");
  is(moved.linkedBrowser.currentURI?.spec ?? WhimsyProfileMoves.urlOf(moved), PAGE, "Same page");
  BrowserTestUtils.removeTab(moved);
});

// Security H1: a private tab moved into another profile's space stays
// private (else its page reaches history, the session and Sync).
add_task(async function a_private_tab_stays_private_in_another_profile() {
  const tab = WhimsyPrivate.openPrivateTab(window, { url: PAGE, force: true });
  ok(tab && WhimsyPrivate.isPrivateTab(tab), "A private tab");
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PAGE);
  answers = [true];
  asked = [];
  gZenWorkspaces.moveTabToWorkspace(tab, workSpace.uuid);
  const moved = await TestUtils.waitForCondition(() =>
    tabsOf(workSpace).find(t => t.userContextId == work && t != tab), "Reopened in Work");
  ok(WhimsyPrivate.isPrivateTab(moved), "Still a private tab");
  if (!moved.linkedPanel) {
    gBrowser.selectedTab = moved;
  }
  await TestUtils.waitForCondition(() => moved.linkedBrowser.browsingContext, "Has a browsing context");
  ok(moved.linkedBrowser.browsingContext.usePrivateBrowsing, "…and browses privately");
  BrowserTestUtils.removeTab(moved);

  // Mini's (and the reopen's) principal keeps privateBrowsingId too.
  const principal = Services.scriptSecurityManager.createContentPrincipal(
    Services.io.newURI(PAGE), { privateBrowsingId: 1 });
  const rekeyed = WhimsyProfileMoves.rekey(principal, work, true);
  is(rekeyed.originAttributes.privateBrowsingId, 1, "Private principal stays private");
  is(rekeyed.originAttributes.userContextId, work, "…in the new profile");
});

add_task(async function same_profile_moves_dont_ask() {
  const other = await gZenWorkspaces.createAndSaveWorkspace("Moves Default 2", undefined, true, 0);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  asked = [];
  gZenWorkspaces.moveTabToWorkspace(tab, other.uuid);
  await new Promise(resolve => setTimeout(resolve, 100));
  is(asked.length, 0, "Default → Default: no warning");
  is(tab.getAttribute("zen-workspace-id"), other.uuid, "Moved as usual");
  BrowserTestUtils.removeTab(tab);
  await gZenWorkspaces.removeWorkspace(other.uuid);
});

add_task(async function moving_a_space_reopens_its_tabs() {
  const space = await gZenWorkspaces.createAndSaveWorkspace("Moves Space", undefined, false, 0);
  await gZenWorkspaces.changeWorkspace(space);
  const first = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const second = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE + "?second");
  gBrowser.selectedTab = first;
  try {
    answers = [false];
    asked = [];
    ok(!(await WhimsyProfiles.moveSpaceToProfile(window, space, work)), "No: nothing moves");
    is(asked[0].bodyId, "whimsy-profile-move-space-body", "Arc's space warning");
    is(WhimsyProfiles.profileIdOfSpace(space), 0, "Still Default");
    ok(!first.closing && !second.closing, "Tabs untouched");

    answers = [true];
    ok(await WhimsyProfiles.moveSpaceToProfile(window, space, work), "Yes: moved");
    is(WhimsyProfiles.profileIdOfSpace(space), work, "The space is Work's");
    const tabs = tabsOf(space);
    ok(tabs.length >= 2 && tabs.every(t => t.userContextId == work), "Every tab reopened in Work");
    is(gBrowser.selectedTab.userContextId, work, "The selected tab stayed selected, now in Work");
    ok(first.closing || !first.isConnected, "Old tabs closed");
  } finally {
    for (const tab of tabsOf(space)) {
      BrowserTestUtils.removeTab(tab);
    }
    await gZenWorkspaces.changeWorkspace(home);
    await gZenWorkspaces.removeWorkspace(space.uuid);
  }
});

add_task(async function set_profile_menu_goes_through_the_warning() {
  const popup = document.querySelector("#context_zenWorkspacesOpenInContainerTab > menupopup");
  window._whimsyProfileMenuSpace = home.uuid;
  popup.dispatchEvent(new Event("popupshowing", { bubbles: true }));
  const item = popup.querySelector(`[data-usercontextid="${work}"]`);
  ok(item, "Zen lists the Work profile");
  answers = [false];
  asked = [];
  item.doCommand();
  await TestUtils.waitForCondition(() => asked.length == 1, "Set Profile asks first");
  is(WhimsyProfiles.profileIdOfSpace(gZenWorkspaces.getActiveWorkspace()), 0,
    "Declined: the space keeps its profile (Zen's own handler didn't run)");
  window._whimsyProfileMenuSpace = null;
});

add_task(async function feature_off_is_zen_behaviour() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.space-profiles", false]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  asked = [];
  gZenWorkspaces.moveTabToWorkspace(tab, workSpace.uuid);
  await new Promise(resolve => setTimeout(resolve, 100));
  is(asked.length, 0, "No warning when off");
  is(tab.userContextId, 0, "Zen's move: container unchanged");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
