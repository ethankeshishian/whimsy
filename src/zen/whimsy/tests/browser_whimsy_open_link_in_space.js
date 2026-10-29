/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Open Link in Space (Arc): the link context menu lists the other spaces;
// picking one opens the link there and switches to it. Hidden with a single
// space, off links, and with the feature switch off. Zen's tab menu still
// has Move To for existing tabs.

const FEATURE = "whimsy.feature.open-link-in-space";
const LINK = "https://example.com/browser/whimsy-target";
const PAGE = `data:text/html,<a id="l" href="${LINK}" style="display:block;padding:40px">go</a><p id="p">text</p>`;

let firstSpace, secondSpace;

add_setup(async function () {
  firstSpace = gZenWorkspaces.getWorkspaces().find(w => w.uuid == gZenWorkspaces.activeWorkspace);
  secondSpace = await gZenWorkspaces.createAndSaveWorkspace("Work", "💼", true);
  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref(FEATURE);
    await gZenWorkspaces.removeWorkspace(secondSpace.uuid);
  });
});

async function openMenuOn(browser, selector) {
  const menu = document.getElementById("contentAreaContextMenu");
  const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
  await BrowserTestUtils.synthesizeMouseAtCenter(selector, { type: "contextmenu", button: 2 }, browser);
  await shown;
  return menu;
}

async function closeMenu(menu) {
  const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
  menu.hidePopup();
  await hidden;
}

add_task(async function test_open_link_in_space() {
  ok(Services.prefs.getBoolPref(FEATURE), "The feature switch is on");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const menu = await openMenuOn(tab.linkedBrowser, "#l");
  const item = document.getElementById("context-whimsyOpenLinkInSpace");
  ok(item && !item.hidden, "The link menu has Open Link in Space");
  const options = [...item.menupopup.children];
  Assert.deepEqual(
    options.map(o => o.getAttribute("zen-workspace-id")),
    [secondSpace.uuid],
    "It lists the other spaces only"
  );
  ok(options[0].getAttribute("label").includes("Work"), "by name");

  const subShown = BrowserTestUtils.waitForEvent(item.menupopup, "popupshown");
  item.openMenu(true);
  await subShown;
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, LINK, true);
  item.menupopup.activateItem(options[0]);
  const newTab = await opened;
  await TestUtils.waitForCondition(
    () => gZenWorkspaces.activeWorkspace == secondSpace.uuid && gBrowser.selectedTab == newTab,
    "Now in that space, on the new tab"
  );
  is(newTab.getAttribute("zen-workspace-id"), secondSpace.uuid, "The link opened in that space");
  isnot(menu.state, "open", "The menu closed");

  BrowserTestUtils.removeTab(newTab);
  await gZenWorkspaces.changeWorkspace(firstSpace);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_hidden_off_links_and_switch_off() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  let menu = await openMenuOn(tab.linkedBrowser, "#p");
  let item = document.getElementById("context-whimsyOpenLinkInSpace");
  ok(!item || item.hidden, "Not on plain text");
  await closeMenu(menu);

  Services.prefs.setBoolPref(FEATURE, false);
  menu = await openMenuOn(tab.linkedBrowser, "#l");
  item = document.getElementById("context-whimsyOpenLinkInSpace");
  ok(!item || item.hidden, "Hidden with the switch off");
  await closeMenu(menu);
  Services.prefs.clearUserPref(FEATURE);
  BrowserTestUtils.removeTab(tab);
});
