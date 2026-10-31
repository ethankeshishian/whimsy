/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Notification badges and dots: a pinned tab or Essential whose page title
// carries an unread count ("(3) Chat", "Inbox (12) - Mail") shows it as a
// badge on its icon; a background pinned tab whose title changed shows a dot
// until it's selected. Normal tabs show neither (their title is visible).

const { parseUnreadCount } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTabs.sys.mjs");

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    if (tab.hasAttribute("zen-essential")) {
      gZenPinnedTabManager.removeEssentials(tab);
    }
    BrowserTestUtils.removeTab(tab);
  }
});

function setTitle(tab, title) {
  return SpecialPowers.spawn(tab.linkedBrowser, [title], t => {
    content.document.title = t;
  });
}

function stack(tab) {
  return tab.querySelector(".tab-icon-stack");
}

// The icon-corner mark (Essentials' badge, every pinned tab's dot).
function badge(tab) {
  return window.getComputedStyle(stack(tab), "::after");
}

// The row-end badge of a pinned tab in the expanded list.
function rowBadge(tab) {
  return window.getComputedStyle(tab.querySelector(".tab-content"), "::after");
}

add_task(function test_parse() {
  const cases = {
    "(3) Chat": 3,
    "[12] Discord": 12,
    "(99+) Feed": 99,
    "Inbox (7) - me@example.com - Mail": 7,
    "Notifications (2) | Site": 2,
    "(0) Nothing new": 0,
    "Chat": 0,
    "Release notes (2024)": 0,
    "": 0,
  };
  for (const [title, count] of Object.entries(cases)) {
    is(parseUnreadCount(title), count, `"${title}" has ${count}`);
  }
  is(parseUnreadCount(undefined), 0, "No title: no count");
});

add_task(async function test_badge_on_pinned_and_essentials() {
  ok(Services.prefs.getBoolPref("whimsy.feature.tab-badges"), "The feature switch is on");
  ok(Services.prefs.getBoolPref("whimsy.tabs.badges"), "On by default");
  const pinned = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?pinned");
  gBrowser.pinTab(pinned);
  const essential = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?essential");
  gZenPinnedTabManager.addToEssentials(essential);
  await TestUtils.waitForCondition(() => essential.hasAttribute("zen-essential"), "An Essential");
  const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?normal");

  await setTitle(pinned, "(3) Chat");
  await TestUtils.waitForCondition(() => stack(pinned).getAttribute("whimsy-unread") == "3", "The pinned tab gets a 3");
  is(rowBadge(pinned).content, '"3"', "drawn at the end of its row in the expanded list");
  is(badge(pinned).content, "none", "not on its icon there (it would cover the title)");
  await setTitle(essential, "Inbox (150) - Mail");
  await TestUtils.waitForCondition(() => stack(essential).getAttribute("whimsy-unread") == "99+", "An Essential shows 99+ for 150");
  is(badge(essential).content, '"99+"', "on its tile");
  // W8-06: RSS live folders' unread dot used the same attribute and drew a
  // space-coloured dot beside the badge, right of the favicon.
  is(rowBadge(essential).content, "none", "No dot beside an Essential's badge");
  // fix7/tabs: on the tile's corner like Arc's Favorites, not on the
  // favicon (where Gmail draws its own count): the icon stack is no longer
  // the anchor, and the badge sits inside the tile's top end corner.
  is(getComputedStyle(stack(essential)).position, "static", "The favicon isn't the badge's anchor");
  const tile = essential.querySelector(".tab-content").getBoundingClientRect();
  const icon = stack(essential).getBoundingClientRect();
  const top = parseFloat(badge(essential).top);
  const end = parseFloat(badge(essential).right);
  Assert.greaterOrEqual(top, 0, "The badge stays inside the tile's top edge");
  Assert.greaterOrEqual(end, 0, "...and its end edge (not clipped by the Essentials grid)");
  Assert.less(end, tile.right - icon.right, "...out at the corner, clear of the favicon");
  await setTitle(normal, "(5) Feed");
  await TestUtils.waitForCondition(() => normal.label == "(5) Feed", "Normal tab retitled");
  ok(!stack(normal).hasAttribute("whimsy-unread"), "A normal tab gets no badge");

  // Read everything: the count goes.
  await setTitle(pinned, "Chat");
  await TestUtils.waitForCondition(() => !stack(pinned).hasAttribute("whimsy-unread"), "No count, no badge");

  // Unpinning drops it; pinning again brings it back.
  await setTitle(pinned, "(4) Chat");
  await TestUtils.waitForCondition(() => stack(pinned).hasAttribute("whimsy-unread"), "Badge again");
  gBrowser.unpinTab(pinned);
  await TestUtils.waitForCondition(() => !stack(pinned).hasAttribute("whimsy-unread"), "Unpinned: no badge");
  gBrowser.pinTab(pinned);
  await TestUtils.waitForCondition(() => stack(pinned).hasAttribute("whimsy-unread"), "Pinned again: badge back");

  // Switched off: no badges.
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.tabs.badges", false]] });
  ok(!stack(pinned).hasAttribute("whimsy-unread"), "Turned off, the badge goes");
  is(rowBadge(pinned).content, "none", "and nothing is drawn");
  await SpecialPowers.popPrefEnv();
  ok(stack(pinned).hasAttribute("whimsy-unread"), "On again");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.tab-badges", false]] });
  ok(!stack(essential).hasAttribute("whimsy-unread"), "The feature switch turns it off too");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_dot_when_background_title_changes() {
  const pinned = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/?dot");
  gBrowser.pinTab(pinned);
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/?other");
  ok(!pinned.selected, "The pinned tab is in the background");
  await setTitle(pinned, "Something new happened");
  await TestUtils.waitForCondition(() => pinned.hasAttribute("titlechanged"), "Firefox marks the title change");
  is(badge(pinned).content, '""', "A dot shows on the pinned tab");
  is(badge(pinned).width, "7px", "a small round dot");
  gBrowser.selectedTab = pinned;
  await TestUtils.waitForCondition(() => !pinned.hasAttribute("titlechanged"), "Selecting it clears the mark");
  is(badge(pinned).content, "none", "and the dot");
  gBrowser.selectedTab = other;
  await setTitle(pinned, "(2) Something new");
  await TestUtils.waitForCondition(() => stack(pinned).hasAttribute("whimsy-unread"), "A count");
  is(rowBadge(pinned).content, '"2"', "shows instead of the dot");
  is(badge(pinned).content, "none", "and the dot goes");
});

// wave5/uxfix: the badge passes 4.5:1, an Essential draws only its icon
// badge (no second empty disc on its row), and the count is read out.
add_task(async function test_badge_contrast_single_disc_and_description() {
  const essential = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?essential-a11y");
  gZenPinnedTabManager.addToEssentials(essential);
  await TestUtils.waitForCondition(() => essential.hasAttribute("zen-essential"), "An Essential");
  await setTitle(essential, "(128) Inbox");
  await TestUtils.waitForCondition(() => stack(essential).getAttribute("whimsy-unread") == "99+", "Badge shows");

  const lum = rgb => {
    const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(c => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const style = badge(essential);
  const [hi, lo] = [lum(style.color), lum(style.backgroundColor)].sort((a, b) => b - a);
  Assert.greaterOrEqual((hi + 0.05) / (lo + 0.05), 4.5, "Badge text passes 4.5:1");
  Assert.greaterOrEqual(parseFloat(style.fontSize), 10, "Badge text is at least 10px");
  isnot(rowBadge(essential).backgroundColor, style.backgroundColor,
    "The Essential's row draws no second badge disc");
  await TestUtils.waitForCondition(() => essential.getAttribute("aria-description") == "128 unread",
    "The count is read out with the tab");
  await setTitle(essential, "Inbox");
  await TestUtils.waitForCondition(() => !essential.hasAttribute("aria-description"), "...and cleared with it");
  BrowserTestUtils.removeTab(essential);
});

// batch8: W8-06: Tab badges dot exclusion and Gmail count persistence
add_task(async function test_tab_badges_gmail_persistence() {
  const { WhimsyTabs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTabs.sys.mjs");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?gmail#inbox"); // Gmail by its titles (tests stay offline)
  gBrowser.pinTab(tab);

  await setTitle(tab, "Inbox (5) - test@gmail.com - Gmail");
  await TestUtils.waitForCondition(() => stack(tab).getAttribute("whimsy-unread") == "5", "Inbox badge shows 5");

  // Opening an email thread: title has subject and Gmail but no count
  await setTitle(tab, "Project Review - test@gmail.com - Gmail");
  await TestUtils.waitForCondition(() => tab.linkedBrowser.contentTitle == "Project Review - test@gmail.com - Gmail",
    "The thread's title arrived");
  WhimsyTabs.updateBadge(tab);
  is(stack(tab).getAttribute("whimsy-unread"), "5", "Count persists when opening an email");

  // Returning to Inbox with 0 unread
  await setTitle(tab, "Inbox - test@gmail.com - Gmail");
  await TestUtils.waitForCondition(() => tab.linkedBrowser.contentTitle == "Inbox - test@gmail.com - Gmail",
    "The inbox's title arrived");
  WhimsyTabs.updateBadge(tab);
  is(stack(tab).getAttribute("whimsy-unread"), null, "Count cleared when in Inbox with 0 unread");

  gBrowser.unpinTab(tab);
  BrowserTestUtils.removeTab(tab);
});

