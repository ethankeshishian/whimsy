/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// New tab button fixed at the bottom: whimsy.tabs.newtab-button-bottom moves
// each space's "+ New Tab" button into a dock at the bottom of the space, where
// it stays visible however many tabs there are. It excludes Zen's "move it to
// the top" option, and goes back into the list when turned off.

const BOTTOM = "whimsy.tabs.newtab-button-bottom";
const TOP = "zen.view.show-newtab-button-top";

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    BrowserTestUtils.removeTab(tab);
  }
  Services.prefs.clearUserPref(BOTTOM);
  Services.prefs.clearUserPref(TOP);
});

function space() {
  return gZenWorkspaces.activeWorkspaceElement;
}

function button() {
  return space().querySelector("#tabs-newtab-button");
}

function inDock() {
  return !!button().closest(".whimsy-newtab-dock");
}

const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

add_task(async function test_bottom() {
  ok(Services.prefs.getBoolPref("whimsy.feature.newtab-bottom"), "The feature switch is on");
  ok(!Services.prefs.getBoolPref(BOTTOM), "Off by default (Arc keeps New Tab at the top)");
  ok(!inDock(), "The button starts in the tab list");
  const listRect = button().getBoundingClientRect();

  Services.prefs.setBoolPref(BOTTOM, true);
  ok(inDock(), "Turned on, the button moves into the bottom dock");
  ok(!Services.prefs.getBoolPref(TOP), "and Zen's top placement is turned off");
  await frame();
  const spaceRect = space().getBoundingClientRect();
  const rect = button().getBoundingClientRect();
  Assert.greater(rect.height, 0, "The button is shown");
  Assert.lessOrEqual(spaceRect.bottom - rect.bottom, 12, "It sits at the bottom of the space");
  is(Math.round(rect.left), Math.round(listRect.left), "lined up with the tab list");
  is(Math.round(rect.width), Math.round(listRect.width), "and as wide as it was there");

  // Many tabs: the list scrolls, the button stays where it is.
  const tabs = [];
  for (let i = 0; i < 30; i++) {
    tabs.push(BrowserTestUtils.addTab(gBrowser, "about:blank", { skipAnimation: true }));
  }
  await frame();
  const after = button().getBoundingClientRect();
  is(Math.round(after.bottom), Math.round(rect.bottom), "With many tabs, the button doesn't move");
  Assert.lessOrEqual(after.bottom, window.innerHeight, "and is still on screen");

  // Clicking it still opens a new tab (Zen's command and listeners).
  const count = gBrowser.tabs.length;
  button().doCommand();
  await TestUtils.waitForCondition(() => gBrowser.tabs.length > count || gURLBar.focused, "New tab opened");
  if (gURLBar.focused) {
    // Zen's new tab may open the URL bar first; leave it.
    EventUtils.synthesizeKey("KEY_Escape");
  }
  for (const tab of tabs) {
    BrowserTestUtils.removeTab(tab);
  }

  // Zen's "move to top" turns this off and puts the button back.
  Services.prefs.setBoolPref(TOP, true);
  ok(!Services.prefs.getBoolPref(BOTTOM), "Turning on Zen's top option turns this off");
  ok(!inDock(), "and the button is back in the list");
  is(space().querySelector(".whimsy-newtab-dock"), null, "The dock is gone");
  ok(button().closest("#tabbrowser-arrowscrollbox-periphery"), "The button is in Zen's periphery again");
});

add_task(async function test_new_space_and_switch() {
  Services.prefs.setBoolPref(BOTTOM, true);
  const created = await gZenWorkspaces.createAndSaveWorkspace("Whimsy dock test", undefined, true);
  await TestUtils.waitForCondition(
    () => gZenWorkspaces.workspaceElement(created.uuid)?.querySelector(".whimsy-newtab-dock #tabs-newtab-button"),
    "A new space gets its button in the dock too"
  );
  await gZenWorkspaces.removeWorkspace(created.uuid);

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.newtab-bottom", false]] });
  ok(!inDock(), "With the feature switch off, the button goes back into the list");
  await SpecialPowers.popPrefEnv();
  ok(inDock(), "and returns when it's on again");
  Services.prefs.clearUserPref(BOTTOM);
  ok(!inDock(), "Off again: back in the list");
});

add_task(async function test_settings() {
  await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
    const doc = browser.contentDocument;
    const checkbox = await TestUtils.waitForCondition(() => doc.getElementById("whimsyNewTabBottom"), "Checkbox shown");
    ok(!checkbox.checked, "Unchecked by default");
    checkbox.click();
    await TestUtils.waitForCondition(() => Services.prefs.getBoolPref(BOTTOM), "Checking it sets the pref");
  });
  Services.prefs.clearUserPref(BOTTOM);
  Services.prefs.clearUserPref(TOP);
});
