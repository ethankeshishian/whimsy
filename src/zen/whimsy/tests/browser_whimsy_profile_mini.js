/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave5/profiles, phase 7: Mini Whimsy's profile pill (Little Arc's
// profile switcher). A link opens in the destination space's profile, the
// pill names it and switches it, and "Open in" a space of another profile
// warns, then reopens the page there.

const { WhimsyQuickWindow } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs"
);
const { WhimsyProfiles } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyProfiles.sys.mjs"
);
const { WhimsyProfileMoves } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyProfileMoves.sys.mjs"
);
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
);

const PAGE = "https://example.com/";
let home, work, workSpace;
const realConfirm = WhimsyProfileMoves.confirm;

add_setup(async function () {
  home = gZenWorkspaces.getActiveWorkspace();
  work = WhimsyProfiles.create("Whimsy Mini Work");
  workSpace = await gZenWorkspaces.createAndSaveWorkspace("Mini Work", undefined, true, work);
  registerCleanupFunction(async () => {
    WhimsyProfileMoves.confirm = realConfirm;
    if (gZenWorkspaces.activeWorkspace != home.uuid) {
      await gZenWorkspaces.changeWorkspace(home);
    }
    for (const tab of gBrowser.tabs.filter(t => t.userContextId == work && !t.hasAttribute("zen-essential"))) {
      BrowserTestUtils.removeTab(tab);
    }
    await gZenWorkspaces.removeWorkspace(workSpace.uuid);
    ContextualIdentityService.remove(work);
  });
});

async function openMini(url) {
  const win = WhimsyQuickWindow.open(url, { opener: window });
  await WhimsyQuickWindow.whenReady(win);
  await TestUtils.waitForCondition(() => win.document.getElementById("whimsy-quick-window-profile"),
    "Mini chrome is ready");
  return win;
}

add_task(async function pill_names_and_switches_the_profile() {
  const win = await openMini(PAGE);
  try {
    const pill = win.document.getElementById("whimsy-quick-window-profile");
    await TestUtils.waitForCondition(() => pill.textContent == "Default", "Pill names Default");
    is(pill.getAttribute("aria-label"), "Profile: Default", "Its accessible name says what it is");
    is(pill.getAttribute("aria-haspopup"), "menu", "…and that it opens a list");

    const shown = BrowserTestUtils.waitForEvent(win.document, "popupshown", false,
      e => e.target.id == "whimsy-quick-window-profile-picker");
    pill.click();
    const { target: picker } = await shown;
    const items = [...picker.children];
    is(items[0].getAttribute("label"), "Default", "Default first");
    ok(items[0].hasAttribute("checked"), "…checked");
    const workItem = items.find(item => item.getAttribute("label") == "Whimsy Mini Work");
    picker.activateItem(workItem);
    await TestUtils.waitForCondition(() => win.gBrowser.selectedTab.userContextId == work,
      "The page reopened in Work");
    await BrowserTestUtils.browserLoaded(win.gBrowser.selectedBrowser, false, PAGE).catch(() => {});
    is(win.gBrowser.tabs.length, 1, "Still one page in Mini");
    await TestUtils.waitForCondition(() => pill.textContent == "Whimsy Mini Work", "Pill follows");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function links_open_in_the_destination_profile() {
  await gZenWorkspaces.changeWorkspace(workSpace);
  const win = await openMini(PAGE);
  try {
    await TestUtils.waitForCondition(() => win.gBrowser.selectedTab.userContextId == work &&
      win.gBrowser.selectedBrowser.currentURI?.spec == PAGE, "The link loads straight in Work");
    is(win.gBrowser.tabs.length, 1, "No Default copy left behind");
  } finally {
    await BrowserTestUtils.closeWindow(win);
    await gZenWorkspaces.changeWorkspace(home);
  }
});

add_task(async function open_in_another_profiles_space_warns_then_reopens() {
  const win = await openMini(PAGE);
  await BrowserTestUtils.browserLoaded(win.gBrowser.selectedBrowser, false, PAGE).catch(() => {});
  let asked = null;
  WhimsyProfileMoves.confirm = async (w, request) => {
    asked = request;
    return true;
  };
  const closed = BrowserTestUtils.windowClosed(win);
  is(WhimsyQuickWindow.moveToSpace(win, workSpace.uuid), null, "Adopting waits for the answer");
  await closed;
  is(asked?.bodyArgs?.profile, "Whimsy Mini Work", "Arc's tab warning, naming the profile");
  const tab = await TestUtils.waitForCondition(() =>
    gBrowser.tabs.find(t => t.userContextId == work && t.getAttribute("zen-workspace-id") == workSpace.uuid),
  "The page is in the Work space, in Work's container");
  BrowserTestUtils.removeTab(tab);
  WhimsyProfileMoves.confirm = realConfirm;
  await gZenWorkspaces.changeWorkspace(home);
});

add_task(async function pill_hidden_when_profiles_are_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.space-profiles", false]] });
  const win = await openMini(PAGE);
  try {
    ok(win.document.getElementById("whimsy-quick-window-profile").hidden, "No pill when off");
  } finally {
    await BrowserTestUtils.closeWindow(win);
    await SpecialPowers.popPrefEnv();
  }
});
