/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/menus2: the tab menu in Arc's words. Close Tab reads Archive Tab,
// Reopen Closed Tab reads Restore Last Closed Tab, and Archive Tabs Below
// archives only the regular tabs under this one in its space, into the
// Archive as one batch.

const { WhimsyArchive } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyArchive.sys.mjs");
const { BELOW_ID, WhimsyArchiveMenu } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyArchiveMenu.sys.mjs");

const FEATURE = "whimsy.feature.archive-tab-menu";
const BASE = "https://example.com/?below-";

const startTabs = new Set(gBrowser.tabs);
add_setup(async function () {
  WhimsyArchive.clear(window, { confirm: false });
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref(FEATURE);
    for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
      if (tab.pinned) {
        gBrowser.unpinTab(tab);
      }
      BrowserTestUtils.removeTab(tab);
    }
    WhimsyArchive.clear(window, { confirm: false });
  });
});

async function openTabMenu(tab) {
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
  await shown;
  return menu;
}

async function closeMenu(menu) {
  const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
  menu.hidePopup();
  await hidden;
}

async function openTabs(names) {
  const tabs = [];
  for (const name of names) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, BASE + name));
  }
  return tabs;
}

add_task(async function test_labels() {
  const [tab] = await openTabs(["label"]);
  let menu = await openTabMenu(tab);
  is(
    document.getElementById("context_closeTab").getAttribute("data-l10n-id"),
    "whimsy-tab-context-archive-tabs",
    "Close Tab reads Archive Tab"
  );
  is(
    document.getElementById("context_undoCloseTab").getAttribute("data-l10n-id"),
    "whimsy-tab-context-restore-closed-tabs",
    "Reopen Closed Tab reads Restore Last Closed Tab"
  );
  const below = document.getElementById(BELOW_ID);
  ok(below && !below.hidden, "Archive Tabs Below is there");
  is(below.previousElementSibling?.id, "context_closeTab", "right after Archive Tab");
  is(document.getElementById("context_undoCloseTab").getAttribute("command"), "History:UndoCloseTab", "Same command as Shift+Cmd+T");
  await closeMenu(menu);

  Services.prefs.setBoolPref(FEATURE, false);
  menu = await openTabMenu(tab);
  is(
    document.getElementById("context_closeTab").getAttribute("data-l10n-id"),
    "tab-context-close-n-tabs",
    "Switched off: Firefox's Close Tab"
  );
  is(
    document.getElementById("context_undoCloseTab").getAttribute("data-l10n-id"),
    "tab-context-reopen-closed-tabs",
    "and Reopen Closed Tab"
  );
  ok(document.getElementById(BELOW_ID).hidden, "and no Archive Tabs Below");
  await closeMenu(menu);
  Services.prefs.clearUserPref(FEATURE);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_archive_tabs_below() {
  const [a, b, c, d] = await openTabs(["a", "b", "c", "d"]);
  const others = gBrowser.tabs.filter(t => t != a && t != b && t != c && t != d);
  Assert.deepEqual(WhimsyArchiveMenu.tabsBelow(window, b), [c, d], "Below B: C and D");

  // The last tab has nothing below it.
  let menu = await openTabMenu(d);
  ok(document.getElementById(BELOW_ID).disabled, "Disabled on the last tab");
  await closeMenu(menu);

  menu = await openTabMenu(b);
  const item = document.getElementById(BELOW_ID);
  ok(!item.disabled, "Enabled with tabs below");
  const closed = TestUtils.waitForCondition(() => !c.isConnected && !d.isConnected, "The tabs below close");
  menu.activateItem(item);
  await closed;
  ok(a.isConnected && b.isConnected, "The tab and the ones above it stay");
  ok(others.every(t => t.isConnected), "Tabs elsewhere stay");

  await TestUtils.waitForCondition(() => {
    const urls = WhimsyArchive.listEntries(window).map(e => e.url);
    return urls.includes(BASE + "c") && urls.includes(BASE + "d");
  }, "Both are in the Archive");
  const entries = WhimsyArchive.listEntries(window).filter(e => [BASE + "c", BASE + "d"].includes(e.url));
  ok(
    entries.every(e => e.reason == "manual"),
    "Archived by hand"
  );
  ok(!WhimsyArchive.listEntries(window).some(e => [BASE + "a", BASE + "b"].includes(e.url)), "The others aren't");
  BrowserTestUtils.removeTab(a);
  BrowserTestUtils.removeTab(b);
});

add_task(async function test_pinned() {
  const [tab] = await openTabs(["pinned"]);
  gBrowser.pinTab(tab);
  const menu = await openTabMenu(tab);
  ok(document.getElementById(BELOW_ID).hidden, "No Archive Tabs Below on a pinned tab");
  await closeMenu(menu);
  gBrowser.unpinTab(tab);
  BrowserTestUtils.removeTab(tab);
});

// W8-05: an Essential is deleted straight from its menu (Arc's Remove
// Favorite), without taking it out of Essentials first. Zen hides the
// Close row there; Whimsy shows it (as Archive Tab when archiving is on).
add_task(async function test_essential_close_tab() {
  const [tab, other] = await openTabs(["essential", "other"]);
  gZenPinnedTabManager.addToEssentials(tab);
  await TestUtils.waitForCondition(() => tab.hasAttribute("zen-essential"), "An Essential");
  const before = gBrowser._numZenEssentials;
  const menu = await openTabMenu(tab);
  const close = document.getElementById("context_closeTab");
  ok(!close.hidden, "The Essential's menu has a Close row");
  ok(!document.getElementById("context_zen-remove-essential").hidden, "Zen's Remove from Essentials stays beside it");
  const removed = BrowserTestUtils.waitForEvent(tab, "TabClose");
  menu.activateItem(close);
  await removed;
  await TestUtils.waitForCondition(() => !tab.isConnected, "The Essential is gone");
  is(gBrowser._numZenEssentials, before - 1, "One Essential fewer");
  ok(!gBrowser.tabs.some(t => t.linkedBrowser?.currentURI?.spec == BASE + "essential"), "Not left behind as a normal tab");
  BrowserTestUtils.removeTab(other);
});

