/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Folder colors: the folder context menu's Color submenu tints that folder's
// icon (and only its own: subfolders keep theirs), Default goes back to the
// space's color, the choice is saved by folder id, and the feature switch
// hides the menu and the colors.

const COLORS = "whimsy.folders.colors";

registerCleanupFunction(() => Services.prefs.clearUserPref(COLORS));

async function openMenu(folder) {
  const popup = document.getElementById("zenFolderActions");
  const shown = BrowserTestUtils.waitForEvent(popup, "popupshown");
  EventUtils.synthesizeMouseAtCenter(folder.labelElement, { type: "contextmenu" });
  await shown;
  return popup;
}

async function closeMenu() {
  const popup = document.getElementById("zenFolderActions");
  const hidden = BrowserTestUtils.waitForEvent(popup, "popuphidden");
  popup.hidePopup();
  await hidden;
}

function stroke(folder) {
  const container = folder.querySelector(":scope > .tab-group-label-container");
  return window.getComputedStyle(container).getPropertyValue("--zen-folder-stroke");
}

function tint(folder) {
  const container = folder.querySelector(":scope > .tab-group-label-container");
  return window.getComputedStyle(container).getPropertyValue("--whimsy-folder-color").trim();
}

// Folder menu > Color > <value>.
async function chooseColor(folder, value) {
  await openMenu(folder);
  const menu = document.getElementById("context_whimsyFolderColor");
  const popup = menu.menupopup;
  const shown = BrowserTestUtils.waitForEvent(popup, "popupshown");
  menu.openMenu(true);
  await shown;
  const hidden = BrowserTestUtils.waitForEvent(document.getElementById("zenFolderActions"), "popuphidden");
  popup.activateItem(menu.querySelector(`menuitem[value="${value}"]`));
  await hidden;
}

async function removeFolder(folder) {
  const removed = BrowserTestUtils.waitForEvent(folder, "TabGroupRemoved");
  folder.delete();
  await removed;
}

add_task(async function test_pick_a_color() {
  ok(Services.prefs.getBoolPref("whimsy.feature.folder-colors"), "The feature switch is on");
  const tab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  const folder = await gZenFolders.createFolder([tab], { renameFolder: false, label: "Colors" });
  const sub = await gZenFolders.createFolder([], { renameFolder: false, label: "Sub" });
  const defaultStroke = stroke(folder);
  is(tint(folder), "", "A new folder has no color of its own");

  await openMenu(folder);
  const menu = document.getElementById("context_whimsyFolderColor");
  ok(menu && !menu.hidden, "The folder menu has Color");
  is(menu.previousElementSibling?.id, "context_zenFolderChangeIcon", "right after Change Icon");
  const options = [...menu.querySelectorAll("menuitem")];
  is(options.length, 10, "Default plus nine colors");
  ok(options[0].hasAttribute("checked"), "Default is checked");
  await TestUtils.waitForCondition(() => options.every(o => o.getAttribute("label")), "Every option is labelled");

  await closeMenu();

  await chooseColor(folder, "blue");
  is(JSON.parse(Services.prefs.getStringPref(COLORS))[folder.id], "blue", "Saved by folder id");
  await TestUtils.waitForCondition(() => tint(folder) == "#4a8ff7", "The folder's icon turns blue");
  isnot(stroke(folder), defaultStroke, "Its outline color changed");
  is(tint(sub), "", "Another folder keeps its own color");

  // The menu shows the current color, and Default resets it.
  await openMenu(folder);
  ok(menu.querySelector('[value="blue"]').hasAttribute("checked"), "Blue is checked now");
  await closeMenu();
  await chooseColor(folder, "default");
  ok(!(folder.id in JSON.parse(Services.prefs.getStringPref(COLORS))), "Default removes the saved color");
  await TestUtils.waitForCondition(() => tint(folder) == "", "Default: back to the space's color");
  is(stroke(folder), defaultStroke, "and Zen's outline again");

  // Feature switch off: no menu, no colors.
  Services.prefs.setStringPref(COLORS, JSON.stringify({ [folder.id]: "red" }));
  await TestUtils.waitForCondition(() => tint(folder) == "#f0524f", "Red");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.folder-colors", false]] });
  await TestUtils.waitForCondition(() => tint(folder) == "", "Switched off, the color goes");
  await openMenu(folder);
  ok(menu.hidden, "and the menu hides Color");
  await closeMenu();
  await SpecialPowers.popPrefEnv();
  await TestUtils.waitForCondition(() => tint(folder) == "#f0524f", "Switched on again, it's back");

  // Junk in the pref doesn't break anything.
  Services.prefs.setStringPref(COLORS, "not json");
  await TestUtils.waitForCondition(() => tint(folder) == "", "Unreadable pref: no colors");
  Services.prefs.setStringPref(COLORS, JSON.stringify({ [folder.id]: "chartreuse" }));
  is(tint(folder), "", "An unknown color is ignored");

  await removeFolder(sub);
  await removeFolder(folder);
});
