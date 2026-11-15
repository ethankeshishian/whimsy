/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29/newtabopts: New Private Tab in the sidebar foot's + button (Zen's
// Create New menu: Create Space, Create Folder, Add Split View, New Tab),
// right after New Tab. It's the same command as the File menu's own New
// Private Tab and Cmd+Option+T (cmd_whimsyNewPrivateTab): a private tab in
// this window by default.

const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    BrowserTestUtils.removeTab(tab);
  }
});

const NEW_PRIVATE_TAB = ':scope > menuitem[command="cmd_whimsyNewPrivateTab"]';

// The popup's rows: each command id, or the tag name for a separator.
function rows(menu) {
  return [...menu.children].map(node => node.getAttribute("command") || node.localName);
}

async function openCreateNewMenu() {
  const menu = document.getElementById("zenCreateNewPopup");
  const button = document.getElementById("zen-create-new-button");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  menu.openPopup(button, "before_start");
  await shown;
  return menu;
}

async function closeMenu(menu) {
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
}

add_task(async function test_new_private_tab_is_right_after_new_tab() {
  const menu = await openCreateNewMenu();
  const list = rows(menu);
  const newTabIndex = list.indexOf("cmd_newNavigatorTab");
  ok(newTabIndex >= 0, "New Tab is in the menu");
  is(list[newTabIndex + 1], "cmd_whimsyNewPrivateTab", "New Private Tab comes directly after New Tab");

  const item = menu.querySelector(NEW_PRIVATE_TAB);
  ok(item, "The item exists");
  await document.l10n.translateElements([item]);
  is(item.getAttribute("label"), "New Private Tab", "Its label, the same as the File menu's row");
  await closeMenu(menu);
});

add_task(async function test_it_runs_the_shared_command() {
  ok(WhimsyPrivate.inWindow, "Private tabs are in this window by default");
  const command = document.getElementById("cmd_whimsyNewPrivateTab");
  ok(command, "The item's command is the same one the File menu and Cmd+Option+T use");
  const before = gBrowser.tabs.length;
  const opened = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabOpen");
  command.doCommand();
  const { target: tab } = await opened;
  is(gBrowser.tabs.length, before + 1, "A tab was added");
  ok(WhimsyPrivate.isPrivateTab(tab), "It's a private tab, like the existing New Private Tab command");
  is(gBrowser.selectedTab, tab, "It's selected");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_no_duplicate_on_reinit() {
  // initMenus runs once per window at startup; guard against it ever
  // running twice (e.g. a future caller) adding a second row.
  WhimsyPrivate.initMenus(window);
  const menu = document.getElementById("zenCreateNewPopup");
  is(menu.querySelectorAll(NEW_PRIVATE_TAB).length, 1, "Still only one item after re-running init");
});
