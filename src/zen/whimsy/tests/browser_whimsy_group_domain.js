/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Group by domain: the tab context menu's "Group N Tabs from site" gathers
// the space's loose tabs from the right-clicked tab's site into a new folder
// named after the site, keeps the current tab selected and says so in a
// toast. It only shows for two or more such tabs.

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(async () => {
  for (const folder of gBrowser.tabGroups.filter(g => g.isZenFolder && g.label.startsWith("example."))) {
    const removed = BrowserTestUtils.waitForEvent(folder, "TabGroupRemoved");
    folder.delete();
    await removed;
  }
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    BrowserTestUtils.removeTab(tab);
  }
});

async function openMenu(tab) {
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
  await shown;
  return menu;
}

async function closeMenu(menu) {
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
}

function item() {
  return document.getElementById("context_whimsyGroupByDomain");
}

add_task(async function test_group() {
  ok(Services.prefs.getBoolPref("whimsy.feature.group-domain"), "The feature switch is on");
  const open = url => BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  const a1 = await open("https://example.com/one");
  const other = await open("https://example.org/");
  const a2 = await open("https://www.example.com/two");
  const a3 = await open("https://example.com/three");
  const pinned = await open("https://example.com/pinned");
  gBrowser.pinTab(pinned);
  gBrowser.selectedTab = other;

  let menu = await openMenu(a1);
  ok(item() && !item().hidden, "The menu offers to group the site's tabs");
  await TestUtils.waitForCondition(() => item().getAttribute("label"), "labelled");
  is(item().getAttribute("label"), "Group 3 Tabs from example.com", "counting the loose example.com tabs (www included)");
  is(item().previousElementSibling?.id, "context_zenMoveToFolder", "next to Move to Folder");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(item());
  await hidden;

  const folder = await TestUtils.waitForCondition(() => a1.group?.isZenFolder && a1.group, "The tabs went into a folder");
  is(folder.label, "example.com", "named after the site");
  for (const tab of [a2, a3]) {
    is(tab.group, folder, "every same-site tab is in it");
  }
  ok(!other.group, "another site's tab stays put");
  ok(!pinned.group, "a pinned tab stays put");
  is(gBrowser.selectedTab, other, "the current tab stays selected");
  const order = folder.tabs.filter(t => !t.hasAttribute("zen-empty-tab"));
  Assert.deepEqual(order, [a1, a2, a3], "in the order they were in");
  await TestUtils.waitForCondition(
    () => [...document.getElementById("zen-toast-container")?.children ?? []].some(t => t._messageId == "whimsy-group-domain-toast"),
    "A toast confirms it"
  );

  // Now in a folder: nothing left to group.
  menu = await openMenu(a1);
  ok(item().hidden, "Tabs already in a folder don't offer it");
  await closeMenu(menu);
});

add_task(async function test_hidden_when_nothing_to_group() {
  const lone = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.net/lonely");
  let menu = await openMenu(lone);
  ok(!item() || item().hidden, "One tab from a site: no item");
  await closeMenu(menu);

  const blank = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:robots");
  const blank2 = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:robots");
  menu = await openMenu(blank);
  ok(!item() || item().hidden, "Pages without a site: no item");
  await closeMenu(menu);
  BrowserTestUtils.removeTab(blank);
  BrowserTestUtils.removeTab(blank2);

  const twin = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.net/twin");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.group-domain", false]] });
  menu = await openMenu(twin);
  ok(!item() || item().hidden, "Feature switch off: no item");
  await closeMenu(menu);
  await SpecialPowers.popPrefEnv();
  menu = await openMenu(twin);
  ok(!item().hidden, "On again, two example.net tabs offer it");
  await closeMenu(menu);
  BrowserTestUtils.removeTab(lone);
  BrowserTestUtils.removeTab(twin);
});
