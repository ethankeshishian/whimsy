/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W10-62 (Arc parity): each Essential's context menu has "Show Unread
// Badge" (a checkbox, on by default), and a command does the same for the
// current Essential. Off hides that Essential's unread count and update dot
// only; other Essentials and pinned tabs keep theirs. It's saved with the
// tab and follows it into every window.

const { WhimsyTabs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTabs.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
const MENU_ID = "context_whimsyUnreadBadge";

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  for (const tab of [...gBrowser.tabs, ...(gZenWorkspaces.allStoredTabs ?? [])].filter(t => !startTabs.has(t))) {
    if (tab.hasAttribute("zen-essential")) {
      gZenPinnedTabManager.removeEssentials(tab);
    }
    if (!tab.closing && tab.isConnected) {
      BrowserTestUtils.removeTab(tab);
    }
  }
});

function setTitle(tab, title) {
  return SpecialPowers.spawn(tab.linkedBrowser, [title], t => {
    content.document.title = t;
  });
}

const stack = tab => tab.querySelector(".tab-icon-stack");

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

async function makeEssential(url, title) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  gZenPinnedTabManager.addToEssentials(tab);
  await TestUtils.waitForCondition(() => tab.hasAttribute("zen-essential"), "An Essential");
  await setTitle(tab, title);
  return tab;
}

add_task(async function test_menu_toggles_one_essential() {
  const mail = await makeEssential("https://example.com/?mail", "Inbox (4) - Mail");
  const chat = await makeEssential("https://example.com/?chat", "(2) Chat");
  // Select something else so both are background tiles.
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?other");
  await TestUtils.waitForCondition(() => stack(mail).getAttribute("whimsy-unread") == "4", "Mail shows 4");
  await TestUtils.waitForCondition(() => stack(chat).getAttribute("whimsy-unread") == "2", "Chat shows 2");

  let menu = await openTabMenu(mail);
  let item = document.getElementById(MENU_ID);
  ok(item && !item.hidden, "An Essential's menu has Show Unread Badge");
  is(item.getAttribute("type"), "checkbox", "as a checkbox");
  is(item.getAttribute("checked"), "true", "on by default");
  await TestUtils.waitForCondition(() => item.label == "Show Unread Badge", "Arc's name");
  menu.activateItem(item);
  await BrowserTestUtils.waitForEvent(menu, "popuphidden");

  ok(!WhimsyTabs.badgeShown(mail), "Mail's badge is off");
  await TestUtils.waitForCondition(() => !stack(mail).hasAttribute("whimsy-unread"), "Mail's count is gone");
  is(stack(chat).getAttribute("whimsy-unread"), "2", "Chat keeps its count");
  is(SessionStore.getCustomTabValue(mail, "whimsy-hide-unread-badge"), "true", "Saved with the tab");

  // New counts stay hidden, and so does the update dot.
  await setTitle(mail, "Inbox (9) - Mail");
  await new Promise(r => setTimeout(r, 200));
  ok(!stack(mail).hasAttribute("whimsy-unread"), "A new count stays hidden");
  mail.setAttribute("titlechanged", "true");
  await setTitle(mail, "Mail");
  is(window.getComputedStyle(stack(mail), "::after").content, "none", "No update dot either");

  menu = await openTabMenu(mail);
  item = document.getElementById(MENU_ID);
  ok(!item.hasAttribute("checked"), "The menu shows it off");
  menu.activateItem(item);
  await BrowserTestUtils.waitForEvent(menu, "popuphidden");
  await setTitle(mail, "Inbox (9) - Mail");
  await TestUtils.waitForCondition(() => stack(mail).getAttribute("whimsy-unread") == "9", "Back on: the count shows");
  ok(!SessionStore.getCustomTabValue(mail, "whimsy-hide-unread-badge"), "Nothing saved when on");

  // Not on normal tabs or pinned tabs.
  menu = await openTabMenu(other);
  ok(document.getElementById(MENU_ID)?.hidden !== false, "A normal tab's menu doesn't have it");
  await closeMenu(menu);

  BrowserTestUtils.removeTab(other);
});

add_task(async function test_command_for_current_essential() {
  const entry = WhimsyCommands.get("cmd_whimsyToggleUnreadBadge");
  ok(entry, "Registered as a command");
  is(entry.l10nId, "whimsy-action-toggle-unread-badge", "with a name in the command bar and about:keyboard");
  ok(entry.keyId, "and a key that can be assigned");
  ok(document.getElementById(entry.keyId), "in this window");

  const essential = await makeEssential("https://example.com/?cmd", "(5) Feed");
  await TestUtils.waitForCondition(() => stack(essential).getAttribute("whimsy-unread") == "5", "Badge");
  gBrowser.selectedTab = essential;
  document.getElementById("cmd_whimsyToggleUnreadBadge").doCommand();
  ok(!WhimsyTabs.badgeShown(essential), "The command hides the current Essential's badge");
  await TestUtils.waitForCondition(() => !stack(essential).hasAttribute("whimsy-unread"), "Count gone");
  document.getElementById("cmd_whimsyToggleUnreadBadge").doCommand();
  ok(WhimsyTabs.badgeShown(essential), "and shows it again");

  // On a normal tab the command does nothing.
  const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?normal");
  document.getElementById("cmd_whimsyToggleUnreadBadge").doCommand();
  ok(!normal.hasAttribute("whimsy-hide-badge"), "Not for a normal tab");
  BrowserTestUtils.removeTab(normal);

  // Taken out of Essentials, the tab shows its badge again as a pinned tab.
  WhimsyTabs.toggleBadge(essential, false);
  gZenPinnedTabManager.removeEssentials(essential);
  await TestUtils.waitForCondition(() => !essential.hasAttribute("zen-essential"), "No longer an Essential");
  ok(WhimsyTabs.badgeShown(essential), "Only an Essential's setting counts");
});
