/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Whimsy: guards against a build without Zen's en-US strings
// (scripts/copy_language_pack.py en-US). Without them the window's whole
// Fluent bundle fails, so menus render blank and <key>s have no keys.

add_task(async function test_window_strings_resolve() {
  const [tab, zenLibrary] = await document.l10n.formatMessages([
    { id: "menu-bookmark-tab" },
    { id: "zen-library-button" },
  ]);
  ok(tab?.attributes?.length, "Firefox menubar strings resolve");
  ok(zenLibrary, "Zen strings resolve too");

  const menuItem = document.getElementById("context_reloadTab");
  await document.l10n.translateElements([menuItem]);
  ok(menuItem.getAttribute("label"), "Tab context menu items have a label");
});

// One bad string (missing id, or a null argument) makes Fluent reject the
// whole batch it was in, leaving every label in that batch blank.
async function untranslatable(elements) {
  const bad = [];
  for (const el of elements) {
    try {
      await document.l10n.translateElements([el]);
    } catch (e) {
      bad.push(`#${el.id || el.localName} ${el.getAttribute("data-l10n-id")}: ${e.message}`);
    }
  }
  return bad;
}

add_task(async function test_every_window_string_translates() {
  const bad = await untranslatable(document.querySelectorAll("[data-l10n-id]"));
  Assert.deepEqual(bad, [], "Every labelled element in the window translates");
});

add_task(async function test_tab_context_menu_strings_translate() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
  await shown;
  const bad = await untranslatable(menu.querySelectorAll("[data-l10n-id]"));
  Assert.deepEqual(bad, [], "Every tab context menu item translates");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_shortcut_keys_are_bound() {
  const startTabs = new Set(gBrowser.tabs);
  const newTabKey = document.getElementById("key_newNavigatorTab");
  ok(
    newTabKey.getAttribute("key") || newTabKey.getAttribute("keycode"),
    "Cmd+T has a key"
  );

  // Zen's default: Cmd+T opens the floating URL bar.
  EventUtils.synthesizeKey("t", { accelKey: true });
  await TestUtils.waitForCondition(() => gURLBar.focused, "Cmd+T opens the URL bar");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");

  // With the URL bar replacement off, Cmd+T opens a tab.
  await SpecialPowers.pushPrefEnv({ set: [["zen.urlbar.replace-newtab", false]] });
  const before = gBrowser.tabs.length;
  const onOpen = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabOpen");
  EventUtils.synthesizeKey("t", { accelKey: true });
  const { target: tab } = await onOpen;
  is(gBrowser.tabs.length, before + 1, "Cmd+T opens a tab");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
  for (const extra of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    BrowserTestUtils.removeTab(extra);
  }
});
