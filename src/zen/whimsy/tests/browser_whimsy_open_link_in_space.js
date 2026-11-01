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

// A space with its own container: the link opens in that container, marked
// as the space's default (zenDefaultUserContextId), so Zen hides the
// container's colour line like on its own new tabs (it showed as a border).
add_task(async function test_space_container_has_no_stray_border() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["privacy.userContext.enabled", true],
      ["zen.workspaces.hide-default-container-indicator", true],
    ],
  });
  gZenWorkspaces.saveWorkspace({ ...secondSpace, containerTabId: 1 });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const menu = await openMenuOn(tab.linkedBrowser, "#l");
  const item = document.getElementById("context-whimsyOpenLinkInSpace");
  const subShown = BrowserTestUtils.waitForEvent(item.menupopup, "popupshown");
  item.openMenu(true);
  await subShown;
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, LINK, true);
  item.menupopup.activateItem(item.menupopup.children[0]);
  const newTab = await opened;
  isnot(menu.state, "open", "The menu closed");
  is(newTab.userContextId, 1, "The link opened in the space's container");
  is(newTab.getAttribute("zenDefaultUserContextId"), "true", "...marked as the space's default container");
  const line = newTab.querySelector(".tab-context-line");
  ok(!line || getComputedStyle(line).display == "none", "No container colour line on the tab");

  BrowserTestUtils.removeTab(newTab);
  await gZenWorkspaces.changeWorkspace(firstSpace);
  gZenWorkspaces.saveWorkspace({ ...secondSpace, containerTabId: 0 });
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

// W10-42: in a space with its own container, Firefox swaps "Open Link in
// New Tab" for "Open Link in New <Container> Tab". Open Link in Space used
// to wait for the first row, so it never showed there; the swapped row now
// reads "Open Link in New Tab" (it is a new tab in this space), and
// Firefox's container submenus are off for good (not a setting any more).
add_task(async function test_space_with_container_shows_open_link_in_space() {
  const { WhimsyMenuPrefs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMenuPrefs.sys.mjs");
  await SpecialPowers.pushPrefEnv({ set: [["privacy.userContext.enabled", true]] });
  gZenWorkspaces.saveWorkspace({ ...firstSpace, containerTabId: 1 });
  const tab = BrowserTestUtils.addTab(gBrowser, PAGE, { userContextId: 1 });
  gBrowser.selectedTab = tab;
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  is(tab.userContextId, 1, "The tab is in the space's container");

  const menu = await openMenuOn(tab.linkedBrowser, "#l");
  ok(document.getElementById("context-openlinkintab").hidden, "Firefox hid Open Link in New Tab (the tab is in a container)");
  const containerRow = document.getElementById("context-openlinkincontainertab");
  ok(!containerRow.hidden && containerRow.getAttribute("collapsed") != "true", "Its container twin shows");
  is(document.l10n.getAttributes(containerRow).id, "main-context-menu-open-link-new-tab", "…labelled Open Link in New Tab");
  const item = document.getElementById("context-whimsyOpenLinkInSpace");
  ok(item && !item.hidden && item.getAttribute("collapsed") != "true", "Open Link in Space shows in a container space");
  is(
    document.getElementById("context-openlinkinusercontext-menu").getAttribute("collapsed"),
    "true",
    "Firefox's Open Link in New Container Tab ▸ stays off"
  );
  await closeMenu(menu);

  const tabMenu = document.getElementById("tabContextMenu");
  const tabShown = BrowserTestUtils.waitForEvent(tabMenu, "popupshown");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
  await tabShown;
  const reopen = document.getElementById("context_reopenInContainer");
  ok(!reopen || reopen.getAttribute("collapsed") == "true", "The tab menu's Open in New Container Tab stays off");
  await closeMenu(tabMenu);

  for (const menuId of ["tab", "essential", "link"]) {
    const ids = WhimsyMenuPrefs.items(menuId).map(entry => entry.id);
    ok(!ids.includes("reopen-in-container") && !ids.includes("open-in-container"), `${menuId}: no container row in Settings → Menus`);
  }

  BrowserTestUtils.removeTab(tab);
  gZenWorkspaces.saveWorkspace({ ...firstSpace, containerTabId: 0 });
  await SpecialPowers.popPrefEnv();
});
