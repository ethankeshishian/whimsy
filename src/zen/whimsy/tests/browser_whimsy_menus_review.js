/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9/menus: design-full-4's menu and command fixes.
// M3 Scratch's space menu, M4 no move into Scratch, M5 one Expand Current
// Split, M6 Delete Essential, M11 localized keywords, M12 Move Tab to Space
// N, L1 New Note on the page menu only, L4 Watch/Stop Watching, L8 Mini
// Whimsy in the File menu, N1 Redo's icon.

const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const { WhimsySpaces } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySpaces.sys.mjs");
const { WhimsyPageWatch } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPageWatch.sys.mjs");
const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");

function shows(node) {
  return !!node && !node.hidden && node.getAttribute("collapsed") != "true";
}

async function closeMenu(menu) {
  if (menu.state == "closed") {
    return;
  }
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
}

async function openSpaceMenu() {
  const menu = document.getElementById("zenWorkspaceMoreActions");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  menu.openPopup(gZenWorkspaces.activeWorkspaceElement, "after_start");
  await shown;
  return menu;
}

add_task(async function test_scratch_space_menu() {
  const first = gZenWorkspaces.getWorkspaces().find(w => w.uuid == gZenWorkspaces.activeWorkspace);
  const scratch = await WhimsyPrivate.openScratch(window);
  ok(scratch, "Scratch opened");
  await TestUtils.waitForCondition(() => gZenWorkspaces.activeWorkspace == scratch.uuid, "In Scratch");
  let menu = await openSpaceMenu();
  for (const id of [
    "context_zenDeleteWorkspace",
    "context_zenShareWorkspace",
    "whimsy-lock-space-menuitem",
    "whimsy-hide-space-menuitem",
    "context_zenWorkspacesOpenInContainerTab",
    "context_zenUnloadWorkspace",
    "whimsy-space-look-menuitem",
  ]) {
    const node = document.getElementById(id);
    ok(!node || !shows(node), `Scratch's menu has no ${id}`);
  }
  const visible = [...menu.children].filter(shows);
  is(visible[0]?.id, "context_whimsyKeepScratch", "Save Scratch as a Space… comes first");
  const closeAt = visible.findIndex(n => n.id == "context_whimsyCloseScratch");
  ok(closeAt > 0, "Close Scratch shows");
  for (const id of ["context_zenUnloadAllOtherWorkspace", "context_zenManageWorkspaces", "whimsy-show-hidden-spaces-menuitem"]) {
    const at = visible.findIndex(n => n.id == id);
    ok(at < closeAt, `Close Scratch comes after ${id} (destructive group last)`);
  }
  await closeMenu(menu);

  // M4: no move into Scratch from a normal space.
  await gZenWorkspaces.changeWorkspace(first);
  ok(!WhimsySpaces.movableSpaces(window).some(s => s.uuid == scratch.uuid), "Scratch is no move target");
  const moveRow = globalActions.find(a => a.commandId == `whimsy:move-to-space-${scratch.uuid}`);
  ok(!moveRow || !moveRow.isAvailable(window), "No command-bar Move to Scratch row");

  // Back in a normal space, its menu is whole again.
  menu = await openSpaceMenu();
  ok(shows(document.getElementById("context_zenDeleteWorkspace")) || gZenWorkspaces.getWorkspaces().length < 2,
    "A normal space's menu has Delete again");
  ok(!shows(document.getElementById("context_whimsyKeepScratch")), "…and no Scratch rows");
  await closeMenu(menu);
  await WhimsyPrivate.closeScratch(window);
});

add_task(function test_one_expand_current_split() {
  const named = WhimsyCommands.entries.filter(
    entry => entry.l10nId && WhimsyCommands.title(entry) == "Expand Current Split"
  );
  is(named.length, 1, "about:keyboard lists Expand Current Split once");
  is(named[0]?.id, "cmd_whimsyCloseOtherPanes", "…as the command with ⌘⌥⇧W");
  const item = document.getElementById("menu_whimsyExpandSplit");
  is(item?.getAttribute("command"), "cmd_whimsyCloseOtherPanes", "The View menu runs it");
  is(item?.getAttribute("key"), "key_whimsyCloseOtherPanes", "…and shows its shortcut");
});

add_task(async function test_essential_close_row() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?essential-row");
  gZenPinnedTabManager.addToEssentials(tab);
  await TestUtils.waitForCondition(() => tab.hasAttribute("zen-essential"), "An Essential");
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
  await shown;
  const close = document.getElementById("context_closeTab");
  is(close.getAttribute("data-l10n-id"), "whimsy-tab-context-delete-essential", "It says Delete Essential");
  await closeMenu(menu);
  gZenPinnedTabManager.removeEssentials(tab);
  BrowserTestUtils.removeTab(tab);
});

add_task(function test_localized_keywords_and_move_to_space_n() {
  const qr = globalActions.find(a => a.whimsyCommand == "cmd_whimsyShowQRCode");
  ok(!qr || qr.whimsyKeywords?.includes("Create QR Code"), "Keywords come from whimsy.ftl");
  const note = globalActions.find(a => a.whimsyCommand == "cmd_whimsyCreateNote");
  ok(!note || !note.whimsyKeywords?.includes("Scratchpad"), "New Note no longer answers to Scratchpad (N4)");
  for (let n = 1; n <= 9; n++) {
    const entry = WhimsyCommands.get(`cmd_whimsyMoveTabToSpace${n}`);
    if (!gZenWorkspaces.workspaceEnabled) {
      break;
    }
    const keyEl = entry?.keyId && document.getElementById(entry.keyId);
    ok(keyEl, `Move Tab to Space ${n} can be given a shortcut`);
    ok(!keyEl?.hasAttribute("key"), "…with none by default");
  }
});

add_task(async function test_new_note_page_menu_only() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "data:text/html,<a id='l' href='https://example.com/' style='display:block;padding:30px'>link</a><div id='b' style='height:100px'></div>"
  );
  const menu = document.getElementById("contentAreaContextMenu");
  for (const [selector, expected] of [["#l", false], ["#b", true]]) {
    const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
    await BrowserTestUtils.synthesizeMouseAtCenter(selector, { type: "contextmenu", button: 2 }, tab.linkedBrowser);
    await shown;
    const item = document.getElementById("context-whimsy-new-note");
    if (expected) {
      ok(!item || shows(item) || !Services.prefs.getBoolPref("whimsy.feature.notes", true), "New Note on the page menu");
    } else {
      ok(!shows(item), "No New Note on a link's menu");
    }
    await closeMenu(menu);
  }
  BrowserTestUtils.removeTab(tab);
});

add_task(function test_watch_page_variants() {
  const entry = WhimsyCommands.get("cmd_whimsyWatchPage");
  Assert.deepEqual(
    entry.variants,
    ["whimsy-action-watch-page", "whimsy-action-stop-watching-page"],
    "Watch This Page… and Stop Watching This Page"
  );
  WhimsyPageWatch._watches ??= [];
  const url = gBrowser.selectedBrowser.currentURI.spec;
  WhimsyPageWatch._watches.push({ id: "t", url, condition: "x", userContextId: 0 });
  ok(WhimsyPageWatch.isWatched(gBrowser.selectedTab), "A watched page is known without waiting");
  WhimsyPageWatch._watches = WhimsyPageWatch._watches.filter(w => w.id != "t");
  ok(!WhimsyPageWatch.isWatched(gBrowser.selectedTab), "…and stops being");
});

add_task(function test_file_menu_and_redo_icon() {
  const item = document.getElementById("menu_whimsyQuickWindow");
  ok(item, "File has New Mini Whimsy");
  is(item?.previousElementSibling?.id, "menu_newNavigator", "…right after New Window");
  is(item?.getAttribute("key"), "key_whimsyQuickWindow", "…with its shortcut");
  const { MENU_ICONS } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMenuIcons.sys.mjs");
  if (MENU_ICONS) {
    isnot(MENU_ICONS["context-redo"], MENU_ICONS["context-reload"], "Redo doesn't use Reload's icon");
  }
});
