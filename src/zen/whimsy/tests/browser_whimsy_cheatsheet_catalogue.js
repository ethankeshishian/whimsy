/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave8/cheatsheet: the cheat sheet's catalogue. Every shortcut in the
// window, grouped by menu-bar menu in menu-bar order (then "Other"), with
// its current binding as key caps in the platform's order, its registry
// name, and whether the person customized it. Cleared and disabled keys
// are left out and each key shows once.

const { WhimsyCheatSheet, keyCaps } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCheatSheet.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { ShortcutUtils } = ChromeUtils.importESModule("resource://gre/modules/ShortcutUtils.sys.mjs");

const FREE = { modifiers: "accel,shift", key: "Y" };

function groupOf(catalogue, keyId) {
  return catalogue.find(group => group.rows.some(row => row.keyId == keyId));
}

function addProbeKey({ id, label = null, key = "Q", modifiers = "accel,alt,shift" }) {
  const keyset = document.createXULElement("keyset");
  const keyEl = document.createXULElement("key");
  keyEl.id = id;
  keyEl.setAttribute("key", key);
  keyEl.setAttribute("modifiers", modifiers);
  if (label) {
    keyEl.setAttribute("label", label);
  }
  keyset.append(keyEl);
  document.documentElement.append(keyset);
  registerCleanupFunction(() => keyset.remove());
  return keyEl;
}

add_task(async function test_groups_follow_the_menu_bar() {
  const catalogue = await WhimsyCheatSheet.catalogue(window);
  ok(catalogue.length >= 4, "Several groups");
  const menubar = document.getElementById("main-menubar");
  const menuIds = [...menubar.children].filter(menu => menu.localName == "menu").map(menu => menu.id);
  let last = -1;
  for (const group of catalogue) {
    ok(group.heading && !group.heading.startsWith("customkeys-"), `"${group.heading}" is readable`);
    ok(group.rows.length, `"${group.heading}" isn't empty`);
    if (group.id == "other") {
      is(group, catalogue.at(-1), "Other comes last");
      continue;
    }
    const index = menuIds.indexOf(group.id);
    Assert.greater(index, last, `${group.id} follows the menu bar's order`);
    is(group.heading, document.getElementById(group.id).label, `${group.id} is headed by the menu's name`);
    last = index;
  }

  is(groupOf(catalogue, "key_newNavigatorTab")?.id, "file-menu", "New Tab is under File");
  is(groupOf(catalogue, "key_find")?.id, "edit-menu", "Find is under Edit");
  is(groupOf(catalogue, "key_whimsyCheatsheet")?.id, "helpMenu", "Keyboard Shortcuts is under Help");

  const ids = catalogue.flatMap(group => group.rows.map(row => row.keyId)).filter(Boolean);
  is(new Set(ids).size, ids.length, "Each key appears once");
});

add_task(async function test_registry_is_the_source() {
  const catalogue = await WhimsyCheatSheet.catalogue(window);
  const menubar = document.getElementById("main-menubar");
  let checked = 0;
  for (const group of catalogue) {
    for (const row of group.rows) {
      const entry = WhimsyCommands.forKey(row.keyId);
      if (!entry?.l10nId) {
        continue;
      }
      is(row.title, WhimsyCommands.title(entry), `${row.keyId} has its command's name`);
      const keyEl = document.getElementById(row.keyId);
      const inMenu = menubar.querySelector(`menuitem[key="${row.keyId}"], menuitem[command="${keyEl.getAttribute("command")}"]`);
      const menu = WhimsyCommands.menuOf(row.keyId, entry.id);
      if (!inMenu && menu && document.getElementById(menu)) {
        is(group.id, menu, `${row.keyId} is under the registry's menu`);
      }
      checked++;
    }
  }
  Assert.greater(checked, 3, "Whimsy's own shortcuts are listed");
  is(WhimsyCommands.menuOf("key_whimsyCheatsheet"), "helpMenu", "The registry knows the sheet's menu");
});

add_task(async function test_key_caps() {
  const isMac = AppConstants.platform == "macosx";
  Assert.deepEqual(keyCaps({ modifiers: "accel,shift", key: "d" }), isMac ? ["⇧", "⌘", "D"] : ["Ctrl", "Shift", "D"],
    "Caps come one per key, modifiers in the platform's order");
  if (isMac) {
    Assert.deepEqual(keyCaps({ modifiers: "shift,alt,control,accel", key: "k" }), ["⌃", "⌥", "⇧", "⌘", "K"],
      "Apple's order: Control, Option, Shift, Command");
  }
  Assert.deepEqual(keyCaps({}), [], "Nothing bound, no caps");

  const rows = await WhimsyCheatSheet.rows(window);
  const newTab = rows.find(row => row.keyId == "key_newNavigatorTab");
  is(newTab.label, ShortcutUtils.prettifyShortcut(document.getElementById("key_newNavigatorTab")),
    "The label is the platform's formatting");
  is(newTab.caps.at(-1), "T", "The last cap is the key");
});

add_task(async function test_live_keys() {
  const keyEl = addProbeKey({ id: "key_whimsyCatalogueProbe", label: "Catalogue probe" });
  const unnamed = addProbeKey({ id: "key_whimsyUnnamedProbe", key: "J" });

  let rows = await WhimsyCheatSheet.rows(window);
  let row = rows.find(r => r.keyId == keyEl.id);
  ok(row, "A key added at runtime is found in its keyset");
  is(row.group, (await WhimsyCheatSheet.catalogue(window)).at(-1).heading, "...under Other, last");
  is(row.label, ShortcutUtils.prettifyShortcut(keyEl), "...with its binding");
  ok(!rows.some(r => r.keyId == unnamed.id), "A key with no readable name outside Whimsy's keyset is skipped");

  keyEl.setAttribute("key", "W");
  row = (await WhimsyCheatSheet.rows(window)).find(r => r.keyId == keyEl.id);
  is(row.caps.at(-1), "W", "A rebinding shows the new binding");

  keyEl.setAttribute("disabled", "true");
  ok(!(await WhimsyCheatSheet.rows(window)).some(r => r.keyId == keyEl.id), "Disabled keys are left out");
  keyEl.removeAttribute("disabled");
  keyEl.removeAttribute("key");
  ok(!(await WhimsyCheatSheet.rows(window)).some(r => r.keyId == keyEl.id), "Cleared keys are left out");
});

add_task(async function test_customized_shortcuts() {
  registerCleanupFunction(() => {
    WhimsyCommands.reset("whimsy-cheatsheet");
    WhimsyCommands.reset("whimsy-focus-sidebar");
  });
  let row = (await WhimsyCheatSheet.rows(window)).find(r => r.keyId == "key_whimsyCheatsheet");
  ok(!row.customized, "A default shortcut isn't marked");

  ok(WhimsyCommands.rebind("whimsy-cheatsheet", FREE).ok, "Keyboard Shortcuts moves to a free key");
  row = (await WhimsyCheatSheet.rows(window)).find(r => r.keyId == "key_whimsyCheatsheet");
  ok(row.customized, "A changed shortcut is marked custom");
  Assert.deepEqual(row.caps, keyCaps(FREE), "...showing the new keys");
  is(row.defaultLabel, keyCaps({ key: "/", modifiers: "accel" }).join(AppConstants.platform == "macosx" ? "" : "+"),
    "...and remembering the default");

  ok(WhimsyCommands.rebind("whimsy-focus-sidebar", { modifiers: "accel,alt,shift", key: "U" }).ok,
    "Focus Sidebar (no default) gets a shortcut");
  row = (await WhimsyCheatSheet.rows(window)).find(r => r.keyId == "key_whimsyFocusSidebar");
  ok(row?.customized, "An added shortcut is listed and marked custom");
  is(row.defaultLabel, "", "...with no default");

  WhimsyCommands.reset("whimsy-cheatsheet");
  WhimsyCommands.reset("whimsy-focus-sidebar");
  row = (await WhimsyCheatSheet.rows(window)).find(r => r.keyId == "key_whimsyCheatsheet");
  ok(!row.customized, "Reset clears the mark");
  ok(!(await WhimsyCheatSheet.rows(window)).some(r => r.keyId == "key_whimsyFocusSidebar"),
    "An unbound command isn't on the sheet");
});
