/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Rename tabs: Zen already has it (double-click the title, or the tab
// context menu's "Change Label…", ZenTabRenamer). This checks the menu flow,
// that the name sticks when the page retitles, and that it survives a
// restart (saved as zenStaticLabel in the session and restored from it).

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    if (tab.hasAttribute("zen-essential")) {
      gZenPinnedTabManager.removeEssentials(tab);
    }
    BrowserTestUtils.removeTab(tab);
  }
});

async function openContextMenu(tab) {
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
  await shown;
  return menu;
}

async function renameFromMenu(tab, name) {
  const menu = await openContextMenu(tab);
  const item = document.getElementById("context_zen-edit-tab-title");
  ok(!item.hidden, "The menu has Change Label…");
  await TestUtils.waitForCondition(() => item.getAttribute("label"), "and it's labelled");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(item);
  await hidden;
  const input = await TestUtils.waitForCondition(() => document.getElementById("tab-label-input"), "An input replaces the title");
  is(document.activeElement, input, "focused, ready to type");
  input.value = name;
  EventUtils.synthesizeKey("KEY_Enter", {}, window);
  await TestUtils.waitForCondition(() => !document.getElementById("tab-label-input"), "Enter saves");
}

async function restartTab(tab) {
  // What a restart does: write the tab to the session, restore it.
  const state = SessionStore.getTabState(tab);
  const restored = BrowserTestUtils.addTab(gBrowser, "about:blank");
  const ready = BrowserTestUtils.waitForEvent(restored, "SSTabRestoring");
  SessionStore.setTabState(restored, state);
  await ready;
  return { restored, state: JSON.parse(state) };
}

add_task(async function test_rename_from_menu_persists() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  await renameFromMenu(tab, "  My   renamed tab ");
  is(tab.label, "My renamed tab", "The tab takes the new name (spaces tidied)");
  is(tab.zenStaticLabel, "My renamed tab", "kept as its fixed label");

  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.title = "The page changed its title";
  });
  await new Promise(resolve => requestAnimationFrame(resolve));
  is(tab.label, "My renamed tab", "The page retitling doesn't undo the name");

  const { restored, state } = await restartTab(tab);
  is(state.zenStaticLabel, "My renamed tab", "The name is saved in the session");
  is(restored.label, "My renamed tab", "and comes back after a restart");
  BrowserTestUtils.removeTab(restored);

  // Clearing the name gives the page title back.
  await renameFromMenu(tab, "");
  ok(!tab.zenStaticLabel, "An empty name clears the fixed label");
  is(tab.label, "The page changed its title", "and shows the page title again");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_pinned_and_essentials() {
  const pinned = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  gBrowser.pinTab(pinned);
  await renameFromMenu(pinned, "Pinned name");
  is(pinned.label, "Pinned name", "Pinned tabs can be renamed");
  const { restored } = await restartTab(pinned);
  is(restored.label, "Pinned name", "and keep it after a restart");
  BrowserTestUtils.removeTab(restored);

  const essential = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.net/");
  gZenPinnedTabManager.addToEssentials(essential);
  await TestUtils.waitForCondition(() => essential.hasAttribute("zen-essential"), "An Essential");
  const menu = await openContextMenu(essential);
  ok(document.getElementById("context_zen-edit-tab-title").hidden, "Essentials (icon tiles, no title) have no Change Label");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
});

add_task(async function test_pref_off() {
  await SpecialPowers.pushPrefEnv({ set: [["zen.tabs.rename-tabs", false]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?off");
  const menu = await openContextMenu(tab);
  ok(document.getElementById("context_zen-edit-tab-title").hidden, "With zen.tabs.rename-tabs off, the item hides");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
