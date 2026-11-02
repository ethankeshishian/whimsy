/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Hide the space switcher: off by default; on, the row of space icons goes
// away (but comes back while a tab is dragged, for dropping on a space);
// the feature switch overrides the option.

const FEATURE = "whimsy.feature.hide-switcher";
const OPTION = "whimsy.spaces.hide-switcher";

let secondSpace;

add_setup(async function () {
  // Zen hides the switcher itself with a single space.
  secondSpace = (await gZenWorkspaces.createAndSaveWorkspace("Second", undefined, true)).uuid;
  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref(FEATURE);
    Services.prefs.clearUserPref(OPTION);
    await gZenWorkspaces.removeWorkspace(secondSpace);
  });
});

function shown() {
  const switcher = document.getElementById("zen-workspaces-button");
  return window.getComputedStyle(switcher).display != "none";
}

add_task(async function test_hide_switcher() {
  ok(!Services.prefs.getBoolPref(OPTION), "Off by default");
  await TestUtils.waitForCondition(shown, "The switcher shows with two spaces");

  Services.prefs.setBoolPref(OPTION, true);
  await TestUtils.waitForCondition(() => !shown(), "The option hides it");

  document.documentElement.setAttribute("whimsy-tab-dragging", "");
  ok(shown(), "It comes back while a tab is dragged");
  document.documentElement.removeAttribute("whimsy-tab-dragging");
  ok(!shown(), "and hides again after the drag");

  Services.prefs.setBoolPref(FEATURE, false);
  await TestUtils.waitForCondition(shown, "The feature switch overrides the option");
  Services.prefs.clearUserPref(FEATURE);
  Services.prefs.clearUserPref(OPTION);
  await TestUtils.waitForCondition(shown, "Shows again when the option is off");
});

add_task(async function test_drag_sets_attribute() {
  const tab = BrowserTestUtils.addTab(gBrowser, "about:blank", { skipAnimation: true });
  const dt = new DataTransfer();
  dt.mozSetDataAt("application/x-moz-tabbrowser-tab", tab, 0);
  // Sent to the switcher, not the tab, so Firefox's own tab drag code
  // stays out of it; Whimsy listens on the window.
  const target = document.getElementById("zen-workspaces-button");
  target.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
  ok(document.documentElement.hasAttribute("whimsy-tab-dragging"), "A tab drag is noticed");
  target.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
  ok(!document.documentElement.hasAttribute("whimsy-tab-dragging"), "and its end");
  BrowserTestUtils.removeTab(tab);
});

// F18: dragging a tab with the space switcher hidden must show the spaces to drop on.
add_task(async function test_tab_drag_shows_hidden_switcher() {
  Services.prefs.setBoolPref(OPTION, true);
  await TestUtils.waitForCondition(() => !shown(), "Switcher is hidden with hide-switcher option");

  const tab = BrowserTestUtils.addTab(gBrowser, "about:blank", { skipAnimation: true });
  // Drag start originating on the tab element itself
  const dt = new DataTransfer();
  tab.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
  ok(document.documentElement.hasAttribute("whimsy-tab-dragging"), "whimsy-tab-dragging set on tab dragstart");
  ok(shown(), "Switcher becomes visible during tab drag so spaces can be dropped on (F18)");

  // Drag over window maintains switcher visibility
  window.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: dt }));
  ok(shown(), "Switcher stays visible during dragover");

  // Drag end hides the switcher again
  tab.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
  await TestUtils.waitForCondition(() => !shown(), "Switcher hides again when drag ends");
  ok(!document.documentElement.hasAttribute("whimsy-tab-dragging"), "whimsy-tab-dragging cleared");

  BrowserTestUtils.removeTab(tab);
  Services.prefs.clearUserPref(OPTION);
});

add_task(async function test_settings_checkbox() {
  await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
    const doc = browser.contentDocument;
    const box = await TestUtils.waitForCondition(() => doc.getElementById("whimsyHideSpaceSwitcher"));
    ok(box, "Settings → Tab Management has the checkbox");
    box.click();
    ok(Services.prefs.getBoolPref(OPTION), "which turns the option on");
    box.click();
    ok(!Services.prefs.getBoolPref(OPTION), "and off");
  });
});
