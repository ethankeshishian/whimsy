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
registerCleanupFunction(async () => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    BrowserTestUtils.removeTab(tab);
  }
  await SpecialPowers.popPrefEnv();
});

add_task(async function setup() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.scratch", true],
      ["whimsy.private.in-window", true],
    ],
  });
});

// Like browser_whimsy_private_command_bar.js's own openPrivateBar/barClosed:
// the command doesn't open a tab by itself, it opens the command bar in
// private mode (violet ring, "Private" badge); a tab only exists once
// something is picked there. A headless test window's empty bar never
// becomes Zen's floating popover, so closing it needs the same nudge that
// file uses.
async function barClosed() {
  await TestUtils.waitForTick();
  if (!gURLBar.focused && gURLBar.hasAttribute("zen-newtab") && !gURLBar.matches(":popover-open")) {
    gURLBar._zenHandleUrlbarClose?.();
  }
  await TestUtils.waitForCondition(
    () => !gURLBar.hasAttribute("zen-newtab") && !gURLBar.view.isOpen,
    "The command bar closed"
  );
  await TestUtils.waitForTick();
}

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
  gBrowser.selectedBrowser.focus();
  command.doCommand();
  await TestUtils.waitForCondition(
    () => gURLBar.focused && gURLBar.hasAttribute("zen-newtab"),
    "Running the command opened the command bar, exactly like Cmd+Option+T"
  );
  is(gBrowser.tabs.length, before, "No tab yet: only the bar opened (the private tab only exists once something is picked)");
  ok(gURLBar.hasAttribute("whimsy-private"), "The bar is in private mode (violet ring), like Cmd+Option+T's");
  ok(gURLBar.isPrivate, "...and its queries are private");

  // Esc leaves nothing behind, same as the command bar's own test.
  EventUtils.synthesizeKey("KEY_Escape");
  if (gURLBar.focused) {
    EventUtils.synthesizeKey("KEY_Escape");
  }
  gBrowser.selectedBrowser.focus();
  await barClosed();
  is(gBrowser.tabs.length, before, "Esc created no tab");
});

add_task(async function test_no_duplicate_on_reinit() {
  // initMenus runs once per window at startup; guard against it ever
  // running twice (e.g. a future caller) adding a second row.
  WhimsyPrivate.initMenus(window);
  const menu = document.getElementById("zenCreateNewPopup");
  is(menu.querySelectorAll(NEW_PRIVATE_TAB).length, 1, "Still only one item after re-running init");
});
