/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Notification badges and dots: a pinned tab or Essential whose page title
// carries an unread count ("(3) Chat", "Inbox (12) - Mail") shows it as a
// badge on its icon; a background pinned tab whose title changed shows a dot
// until it's selected. Normal tabs show neither (their title is visible).

const { parseUnreadCount, WhimsyTabs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTabs.sys.mjs");

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    if (tab.hasAttribute("zen-essential")) {
      gZenPinnedTabManager.removeEssentials(tab);
    }
    BrowserTestUtils.removeTab(tab);
  }
});

// The page's title as the parent process knows it (what the badge reads).
function titleArrived(tab, title) {
  return TestUtils.waitForCondition(() => tab.linkedBrowser.contentTitle == title,
    `The page's title "${title}" reached the browser`, 100, 300);
}

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
  pinned._whimsyLoadFinishedAt = WhimsyTabs.now() - 6000;
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


// W10-11: Essentials' badges stay live while you're elsewhere, like Arc's
// Favorites. An Essential restored at launch was left unloaded (pinned tabs
// restore on demand) and, with Zen's window sync, took no title updates
// until shown, so its count froze at last session's.
function loadedAt(tab, query) {
  return !tab.hasAttribute("pending") && !tab.hasAttribute("busy") &&
    tab.linkedBrowser.currentURI.spec.includes(query);
}

// What an Essential looks like right after launch: no page yet, never shown.
// The session store records a tab's page a moment after it loads; a tab
// unloaded before then has nothing to restore when it's woken (Firefox's own
// tests flush before discarding, too).
async function discard(tab) {
  const { TabStateFlusher } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs");
  await TabStateFlusher.flush(tab.linkedBrowser);
  return gBrowser.discardBrowser(tab, true);
}

async function asAtLaunch(tab) {
  // Already unloaded (pending) stays so; discarding it again would fail.
  ok(tab.hasAttribute("pending") || await discard(tab), "Unloaded");
  await TestUtils.waitForCondition(() => tab.hasAttribute("pending"), "Pending");
  delete tab._whimsyUnloaded;
  delete tab._zenContentsVisible;
  tab.removeAttribute("discarded");
}

add_task(async function test_unloaded_essential_loads_in_background_and_stays_live() {
  const { WhimsyTabs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTabs.sys.mjs");
  const essential = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?live-essential");
  gZenPinnedTabManager.addToEssentials(essential);
  await TestUtils.waitForCondition(() => essential.hasAttribute("zen-essential"), "An Essential");
  await setTitle(essential, "(2) Chat");
  await TestUtils.waitForCondition(() => stack(essential).getAttribute("whimsy-unread") == "2", "Badge 2");
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?live-other");

  // Unloaded on purpose: it stays unloaded.
  ok(await discard(essential), "Unloaded by hand");
  await TestUtils.waitForCondition(() => essential.hasAttribute("pending"), "Pending");
  ok(essential._whimsyUnloaded, "An unload on purpose is remembered");
  let woken = await WhimsyTabs.keepEssentialsLive(window);
  ok(!woken.includes(essential), "and isn't undone");
  ok(essential.hasAttribute("pending"), "Still unloaded");

  // Badges off: nothing is loaded for them.
  delete essential._whimsyUnloaded;
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.tabs.badges", false]] });
  woken = await WhimsyTabs.keepEssentialsLive(window);
  ok(!woken.includes(essential), "Badges off: the Essential stays unloaded");
  await SpecialPowers.popPrefEnv();

  // As restored at launch: it loads in the background.
  await asAtLaunch(essential);
  woken = await WhimsyTabs.keepEssentialsLive(window);
  ok(woken.includes(essential), "The launch-time Essential is loaded");
  ok(other.selected, "in the background (the selected tab doesn't change)");
  await TestUtils.waitForCondition(() => loadedAt(essential, "live-essential"), "Its saved page loads");
  ok(essential._zenContentsVisible, "This copy holds the page (window sync moves it, not reloads it)");
  await setTitle(essential, "(5) Chat");
  // The new title crosses from the background page's process to this one,
  // which can take seconds on a loaded machine (a background tab's process
  // runs at low priority); once it's here, the badge must follow at once.
  await titleArrived(essential, "(5) Chat");
  await TestUtils.waitForCondition(() => stack(essential).getAttribute("whimsy-unread") == "5",
    "The count updates without opening it");
  ok(other.selected, "Still in the background");

  // A tab whose label doesn't follow its page (with window sync, one never
  // shown in this window) still gets its count from the page's title.
  delete essential._zenContentsVisible;
  await setTitle(essential, "(7) Chat");
  await titleArrived(essential, "(7) Chat");
  await TestUtils.waitForCondition(() => stack(essential).getAttribute("whimsy-unread") == "7",
    "Counted from the page's title, not the label");
  essential._zenContentsVisible = true;

  // A renamed Essential: the label stays its name, the count still moves,
  // and a title change without a count shows the update dot.
  essential.zenStaticLabel = "Team";
  gBrowser._setTabLabel(essential, "Team", { _zenChangeLabelFlag: true });
  await setTitle(essential, "(4) Chat");
  await TestUtils.waitForCondition(() => stack(essential).getAttribute("whimsy-unread") == "4", "Renamed: badge 4");
  is(essential.label, "Team", "The name stays");
  essential.removeAttribute("titlechanged");
  essential._whimsyLoadFinishedAt = WhimsyTabs.now() - 6000;
  await setTitle(essential, "Chat - new thread");
  await TestUtils.waitForCondition(() => !stack(essential).hasAttribute("whimsy-unread"), "Count read");
  await TestUtils.waitForCondition(() => essential.hasAttribute("titlechanged"), "Renamed: the update dot shows");
  gBrowser.selectedTab = essential;
  await TestUtils.waitForCondition(() => !essential.hasAttribute("titlechanged"), "Opening it clears the dot");
  delete essential.zenStaticLabel;
  gBrowser.selectedTab = other;
  BrowserTestUtils.removeTab(other);
});

add_task(async function test_pending_tab_made_essential_loads() {
  const pending = BrowserTestUtils.addTab(gBrowser, "https://example.com/?made-essential");
  await BrowserTestUtils.browserLoaded(pending.linkedBrowser);
  ok(!pending.selected, "A background tab");
  ok(await discard(pending), "Unloaded");
  await TestUtils.waitForCondition(() => pending.hasAttribute("pending"), "Pending");
  gZenPinnedTabManager.addToEssentials(pending);
  await TestUtils.waitForCondition(() => pending.hasAttribute("zen-essential"), "Made an Essential");
  await TestUtils.waitForCondition(() => loadedAt(pending, "made-essential"),
    "A new Essential loads, so its badge is live");
  ok(!pending.selected, "without being opened");
});

// W11-11: title change dot settle trigger, placement on Essentials and pinned tabs.
add_task(async function test_w11_essential_dot_settle_trigger_and_placement() {
  // 1. Restore + background load sets no dot
  const bgTab = BrowserTestUtils.addTab(gBrowser, "https://example.com/?restore-bg");
  gZenPinnedTabManager.addToEssentials(bgTab);
  await TestUtils.waitForCondition(() => bgTab.hasAttribute("zen-essential"), "An Essential");
  ok(!bgTab.selected, "The Essential is in the background");
  await BrowserTestUtils.browserLoaded(bgTab.linkedBrowser);
  // Give any immediate post-load title a moment
  await setTitle(bgTab, "Example Domain");
  await new Promise(r => setTimeout(r, 100));
  ok(!bgTab.hasAttribute("titlechanged"), "Restore + background load sets no dot");
  is(badge(bgTab).content, "none", "No dot drawn during initial load");

  // Immediate title change within 5s of load finishing also sets no dot:
  await setTitle(bgTab, "Quick Change");
  await new Promise(r => setTimeout(r, 100));
  ok(!bgTab.hasAttribute("titlechanged"), "Title change within 5s sets no dot");
  is(badge(bgTab).content, "none", "No dot within 5s of load");

  // 2. A real later title change on a background Essential sets one
  bgTab._whimsyLoadFinishedAt = WhimsyTabs.now() - 6000;
  await setTitle(bgTab, "A Real Later Update");
  await TestUtils.waitForCondition(() => bgTab.hasAttribute("titlechanged"), "Later title change sets the dot");
  is(badge(bgTab).content, '""', "The dot is rendered on the Essential");
  is(badge(bgTab).width, "7px", "Dot width is 7px");
  // Check placement inside the tile's top-right corner:
  // The tile (its background) starts --tab-margin-block below the tab's box.
  const margin = parseFloat(getComputedStyle(bgTab).getPropertyValue("--tab-margin-block")) || 0;
  is(parseFloat(badge(bgTab).top), margin + 6, "Anchored 6px below the tile's top");
  is(badge(bgTab).right, "6px", "Anchored 6px from tile's end");

  // 3. Selecting clears it
  gBrowser.selectedTab = bgTab;
  await TestUtils.waitForCondition(() => !bgTab.hasAttribute("titlechanged"), "Selecting the Essential clears the dot");
  is(badge(bgTab).content, "none", "The dot disappears on selection");

  // 4. An Essential with a count shows the badge, not a dot
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?other-foreground");
  ok(!bgTab.selected, "Essential in background again");
  bgTab._whimsyLoadFinishedAt = WhimsyTabs.now() - 6000;
  await setTitle(bgTab, "(3) Messages");
  await TestUtils.waitForCondition(() => stack(bgTab).getAttribute("whimsy-unread") == "3", "Unread count 3 shows");
  ok(!bgTab.hasAttribute("titlechanged"), "Essential with a count does not have titlechanged");
  is(badge(bgTab).content, '"3"', "Shows the unread badge, not a dot");

  // Cleanup
  gZenPinnedTabManager.removeEssentials(bgTab);
  BrowserTestUtils.removeTab(bgTab);
  BrowserTestUtils.removeTab(other);
});

add_task(async function test_w11_navigation_sets_no_dot() {
  const essential = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?nav-start");
  gZenPinnedTabManager.addToEssentials(essential);
  await TestUtils.waitForCondition(() => essential.hasAttribute("zen-essential"), "An Essential");
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?nav-other");
  ok(!essential.selected, "In background");

  // Navigate to a new page in background
  BrowserTestUtils.startLoadingURIString(essential.linkedBrowser, "https://example.org/?nav-dest");
  await BrowserTestUtils.browserLoaded(essential.linkedBrowser);
  await new Promise(r => setTimeout(r, 100));
  ok(!essential.hasAttribute("titlechanged"), "Title change caused by navigation sets no dot");

  gZenPinnedTabManager.removeEssentials(essential);
  BrowserTestUtils.removeTab(essential);
  BrowserTestUtils.removeTab(other);
});
