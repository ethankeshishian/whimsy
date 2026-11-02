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
  // Whimsy hears drags on the window in the capture phase. A capture
  // listener added after Whimsy's stops the synthetic events there, so
  // Firefox's own tab drag (which wants a real drag session and opens a
  // drag window) never starts.
  const stop = event => event.stopPropagation();
  const types = ["dragstart", "dragenter", "dragover", "dragend"];
  for (const type of types) {
    window.addEventListener(type, stop, true);
  }
  registerCleanupFunction(() => {
    for (const type of types) {
      window.removeEventListener(type, stop, true);
    }
  });
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
  // Whimsy hears drags on the window in the capture phase. The synthetic
  // events stop at the tab strip, so Firefox's own tab drag (which wants a
  // real drag session and opens a drag window) never starts.
  const container = gBrowser.tabContainer;
  const stop = event => event.stopPropagation();
  for (const type of ["dragstart", "dragenter", "dragover", "dragend"]) {
    container.addEventListener(type, stop, true);
  }
  registerCleanupFunction(() => {
    for (const type of ["dragstart", "dragenter", "dragover", "dragend"]) {
      container.removeEventListener(type, stop, true);
    }
  });
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

  // A link or file dragged in from elsewhere never sends this window a dragend,
  // so it must not show the switcher.
  tab.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: new DataTransfer() }));
  tab.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: new DataTransfer() }));
  ok(!document.documentElement.hasAttribute("whimsy-tab-dragging"), "An outside drag over a tab isn't a tab drag");

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

// B2: hiding the switcher, then showing it again, gives back the same row of
// icons. Zen sizes the icons from the switcher's width on a window resize;
// a resize while it was hidden measured 0 and folded every icon but the
// current one into a dot.
add_task(async function test_icons_come_back_the_same() {
  const third = (await gZenWorkspaces.createAndSaveWorkspace("Third", undefined, true)).uuid;
  try {
    await TestUtils.waitForCondition(shown, "Shown");
    const icons = () => document.getElementById("zen-workspaces-button");
    const look = () => ({
      overflow: icons().hasAttribute("icons-overflow"),
      widths: [...icons().children].filter(i => i.localName == "toolbarbutton").map(i => Math.round(i.getBoundingClientRect().width)),
    });
    gZenWorkspaces.onWindowResize();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const before = look();
    Services.prefs.setBoolPref(OPTION, true);
    await TestUtils.waitForCondition(() => !shown(), "Hidden");
    // The window is resized while it's hidden.
    gZenWorkspaces.onWindowResize();
    Services.prefs.setBoolPref(OPTION, false);
    await TestUtils.waitForCondition(shown, "Shown again");
    await TestUtils.waitForCondition(() => JSON.stringify(look()) == JSON.stringify(before),
      `The icons look as before (${JSON.stringify(look())} vs ${JSON.stringify(before)})`);
    ok(!look().overflow, "No dots");
  } finally {
    Services.prefs.clearUserPref(OPTION);
    await gZenWorkspaces.removeWorkspace(third);
  }
});
