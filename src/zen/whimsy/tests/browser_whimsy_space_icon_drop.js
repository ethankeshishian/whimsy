/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Drop tabs on space icons (Arc): dropping a tab on a space's icon in the
// switcher moves it (and the other selected tabs) into that space and
// switches there; the icon is a highlighted drop target meanwhile.
// Essentials never move, and the feature switch turns it off.

const FEATURE = "whimsy.feature.space-icon-drop";

let firstSpace, secondSpace;

add_setup(async function () {
  firstSpace = gZenWorkspaces.activeWorkspace;
  secondSpace = (await gZenWorkspaces.createAndSaveWorkspace("Drop target", "🚀", true)).uuid;
  await TestUtils.waitForCondition(() => iconFor(secondSpace), "The new space has an icon");
  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref(FEATURE);
    await gZenWorkspaces.removeWorkspace(secondSpace);
  });
});

function iconFor(uuid) {
  return document.querySelector(`#zen-workspaces-button toolbarbutton[zen-workspace-id="${uuid}"]`);
}

async function backToFirst() {
  if (gZenWorkspaces.activeWorkspace != firstSpace) {
    await gZenWorkspaces.changeWorkspace(gZenWorkspaces.getWorkspaces().find(w => w.uuid == firstSpace));
  }
}

async function addTabHere(url = "data:text/plain,drop") {
  const tab = BrowserTestUtils.addTab(gBrowser, url, { skipAnimation: true });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  return tab;
}

add_task(async function test_drop_moves_tab() {
  ok(Services.prefs.getBoolPref(FEATURE), "The feature switch is on");
  await backToFirst();
  const tab = await addTabHere();
  gBrowser.selectedTab = tab;
  const target = iconFor(secondSpace);

  // The icon becomes a drop target while a tab is over it.
  const dt = new DataTransfer();
  dt.mozSetDataAt("application/x-moz-tabbrowser-tab", tab, 0);
  const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt });
  target.dispatchEvent(over);
  ok(over.defaultPrevented, "The icon accepts the drop");
  ok(target.hasAttribute("whimsy-drop-target"), "The icon is highlighted");
  target.dispatchEvent(new DragEvent("dragleave", { bubbles: true, dataTransfer: dt }));
  ok(!target.hasAttribute("whimsy-drop-target"), "The highlight goes away on leave");
  await backToFirst();

  // A drop on the icon. (A synthesized native drag carries no tab data in
  // automation, so the events are built by hand.)
  const dropDt = new DataTransfer();
  dropDt.mozSetDataAt("application/x-moz-tabbrowser-tab", tab, 0);
  target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dropDt }));
  const dropEvent = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dropDt });
  target.dispatchEvent(dropEvent);
  ok(dropEvent.defaultPrevented, "The drop is handled");
  await TestUtils.waitForCondition(
    () => tab.getAttribute("zen-workspace-id") == secondSpace && gZenWorkspaces.activeWorkspace == secondSpace,
    "The tab moved to the space and that space is active"
  );
  ok(!target.hasAttribute("whimsy-drop-target"), "No highlight is left behind");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_drop_moves_selected_tabs() {
  await backToFirst();
  const one = await addTabHere("data:text/plain,one");
  const two = await addTabHere("data:text/plain,two");
  gBrowser.selectedTab = one;
  gBrowser.addToMultiSelectedTabs(two);
  const { WhimsySpaces } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySpaces.sys.mjs");
  await WhimsySpaces.moveToSpace(window, one, secondSpace);
  is(one.getAttribute("zen-workspace-id"), secondSpace, "The first selected tab moved");
  is(two.getAttribute("zen-workspace-id"), secondSpace, "The second selected tab moved too");
  is(gZenWorkspaces.activeWorkspace, secondSpace, "Now in that space");
  gBrowser.clearMultiSelectedTabs();
  BrowserTestUtils.removeTab(one);
  BrowserTestUtils.removeTab(two);
});

add_task(async function test_essentials_and_switch_off() {
  await backToFirst();
  const essential = await addTabHere("data:text/plain,essential");
  gZenPinnedTabManager.addToEssentials(essential);
  await TestUtils.waitForCondition(() => essential.hasAttribute("zen-essential"), "It's an Essential");
  const dt = new DataTransfer();
  dt.mozSetDataAt("application/x-moz-tabbrowser-tab", essential, 0);
  const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt });
  iconFor(secondSpace).dispatchEvent(over);
  ok(!over.defaultPrevented, "An Essential can't be dropped on a space");
  gZenPinnedTabManager.removeEssentials(essential);
  BrowserTestUtils.removeTab(essential);
  await backToFirst();

  Services.prefs.setBoolPref(FEATURE, false);
  const tab = await addTabHere();
  const dt2 = new DataTransfer();
  dt2.mozSetDataAt("application/x-moz-tabbrowser-tab", tab, 0);
  const over2 = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt2 });
  const target = iconFor(secondSpace);
  // Zen's own handler may switch spaces on hover; only ours accepts a drop.
  target.dispatchEvent(over2);
  ok(!target.hasAttribute("whimsy-drop-target"), "No highlight with the switch off");
  const dropEvent = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt2 });
  target.dispatchEvent(dropEvent);
  await new Promise(r => setTimeout(r, 300));
  is(tab.getAttribute("zen-workspace-id"), firstSpace, "With the switch off, a drop on the icon moves nothing");
  Services.prefs.clearUserPref(FEATURE);
  await backToFirst();
  BrowserTestUtils.removeTab(tab);
});
