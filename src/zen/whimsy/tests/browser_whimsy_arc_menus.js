/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave6/parity: Arc's menu bar items and names (WhimsyArcMenus).

const { WhimsyArcMenus, undoAction } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyArcMenus.sys.mjs");
const { WhimsyUndo } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUndo.sys.mjs");
const { WhimsyPage } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPage.sys.mjs");

function firePopup(id) {
  const popup = document.getElementById(id);
  popup.dispatchEvent(new MouseEvent("popupshowing", { bubbles: true }));
  return popup;
}

add_task(function test_items_exist() {
  WhimsyArcMenus.ensureMenus(window);
  for (const id of [
    "menu_whimsyToggleSidebar",
    "menu_whimsyToggleToolbar",
    "whimsy-tabs-menubar",
    "menu_whimsyTabsReveal",
    "menu_whimsyTabsClearToday",
    "menu_whimsyOpenLibrary",
    "menu_whimsyViewDownloads",
    "menu_whimsyKeyboardShortcuts",
    "menu_whimsyCapturePortrait",
    "menu_whimsyTabsResetSpace",
    "menu_whimsyViewMedia",
    "menu_whimsyViewBoosts",
  ]) {
    ok(document.getElementById(id), `${id} is in the menu bar`);
  }
  is(document.getElementById("menu_whimsyKeyboardShortcuts").parentElement.firstElementChild.id,
    "menu_whimsyKeyboardShortcuts", "Essential Keyboard Shortcuts heads the Help menu");
  is(document.getElementById("menu_whimsyTabsClearToday").getAttribute("command"), "cmd_zenCloseUnpinnedTabs", "Clear Today is Zen's command");
  const blank = document.getElementById("menu_new_zen_unsynced_window");
  if (blank) {
    is(blank.getAttribute("data-l10n-id"), "whimsy-menu-blank-window", "Blank Window, Arc's name");
  }
  const spaces = document.querySelector("#zen-spaces-menubar > menupopup");
  if (spaces) {
    ok(spaces.querySelector('[data-l10n-id="whimsy-menu-new-space"]'), "New Space…");
    ok(spaces.querySelector('[data-l10n-id="whimsy-menu-rename-space"]'), "Rename Space");
  }
});

add_task(async function test_toggle_toolbar() {
  await SpecialPowers.pushPrefEnv({ set: [["zen.view.use-single-toolbar", true]] });
  firePopup("menu_viewPopup");
  is(document.getElementById("menu_whimsyToggleToolbar").getAttribute("data-l10n-id"), "whimsy-menu-show-toolbar", "Show Toolbar");
  document.getElementById("cmd_whimsyToggleToolbar").doCommand();
  ok(!Services.prefs.getBoolPref("zen.view.use-single-toolbar"), "The toolbar shows");
  firePopup("menu_viewPopup");
  is(document.getElementById("menu_whimsyToggleToolbar").getAttribute("data-l10n-id"), "whimsy-menu-hide-toolbar", "then Hide Toolbar");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_undo_label() {
  is(undoAction("close"), "archive", "Closing archives, as in Arc");
  is(undoAction("archive:idle"), "archive", "Auto-archive too");
  is(undoAction(null), null, "Nothing pending");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?undo-label");
  gURLBar.blur();
  gBrowser.removeTab(tab);
  const undo = document.getElementById("menu_undo");
  if (WhimsyUndo.pendingUndo(window)) {
    firePopup("menu_EditPopup");
    is(undo.getAttribute("data-l10n-id"), "whimsy-menu-undo-action", "Edit → Undo names the tab action");
    is(undo.getAttribute("command"), "cmd_whimsyUndoTabAction", "and runs it");
    WhimsyUndo.undo(window);
  }
  firePopup("menu_EditPopup");
  if (!WhimsyUndo.pendingUndo(window)) {
    is(undo.getAttribute("command"), "cmd_undo", "Plain Undo again once nothing is pending");
  }
  for (const t of gBrowser.tabs.filter(t => t.linkedBrowser.currentURI.spec.includes("undo-label"))) {
    BrowserTestUtils.removeTab(t);
  }
});

add_task(async function test_reveal_tab() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?reveal");
  document.getElementById("cmd_whimsyRevealTab").doCommand();
  ok(tab.hasAttribute("whimsy-revealed"), "The tab is marked");
  await TestUtils.waitForCondition(() => !tab.hasAttribute("whimsy-revealed"), "briefly");
  BrowserTestUtils.removeTab(tab);
});

add_task(function test_portrait_rect() {
  const wide = WhimsyPage.portraitRect({ left: 0, top: 0, width: 1600, height: 900, devicePixelRatio: 2 });
  is(Math.round((wide.width / wide.height) * 16), 9, "A 9:16 frame");
  is(wide.height, 900, "Full height on a wide page");
  is(wide.left, Math.round((1600 - wide.width) / 2), "Centred");
  const tall = WhimsyPage.portraitRect({ left: 0, top: 0, width: 360, height: 2000 });
  is(tall.width, 360, "Full width on a tall page");
  is(tall.height, 640, "cropped to 9:16");
});

add_task(async function test_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.arc-menus", false]] });
  const pin = document.getElementById("menu_whimsyTabsPin");
  const before = pin.getAttribute("data-l10n-id");
  firePopup("whimsy-tabs-menubar-popup");
  is(pin.getAttribute("data-l10n-id"), before, "Nothing updates with the switch off");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_reset_space_tabs() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?pinned-home");
  gBrowser.pinTab(tab);
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, "https://example.com/?wandered");
  await loaded;
  ok(WhimsyArcMenus.resetSpaceTabs(window) >= 1, "Resets this space's pinned tabs");
  await TestUtils.waitForCondition(
    () => tab.linkedBrowser.currentURI.spec.includes("pinned-home"),
    "Back on its pinned page"
  );
  gBrowser.unpinTab(tab);
  BrowserTestUtils.removeTab(tab);
});
