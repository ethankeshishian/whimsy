/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W8-17/18: Cmd+Option+T opens the command bar in private mode (violet
// ring, "Private" badge) and only Enter makes the private tab; Esc makes
// nothing. Cmd+T is always the normal bar, even over a private tab. Cmd+L on
// a private tab is violet. Nothing typed in the private bar reaches history.

const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
const { PlacesTestUtils } = ChromeUtils.importESModule("resource://testing-common/PlacesTestUtils.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_article.html";
const BADGE_ID = "whimsy-urlbar-private-badge";

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(async () => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    BrowserTestUtils.removeTab(tab);
  }
  await PlacesUtils.history.clear();
});

function uniqueURL(tag) {
  return `${PAGE}?${tag}=${Date.now()}${Math.random().toString(36).slice(2)}`;
}

async function barClosed() {
  // An empty bar in a headless test window never becomes Zen's floating
  // popover, so blurring it doesn't run Zen's close (UrlbarInputBase
  // #closePopover returns early); in the app the empty bar floats and
  // closes on blur. Do what that blur does.
  await TestUtils.waitForTick();
  if (!gURLBar.focused && gURLBar.hasAttribute("zen-newtab") && !gURLBar.matches(":popover-open")) {
    gURLBar._zenHandleUrlbarClose?.();
  }
  await TestUtils.waitForCondition(
    () => !gURLBar.hasAttribute("zen-newtab") && !gURLBar.view.isOpen,
    "The command bar closed"
  );
  await TestUtils.waitForTick();
}

async function openPrivateBar() {
  EventUtils.synthesizeKey("t", { accelKey: true, altKey: true });
  await TestUtils.waitForCondition(
    () => gURLBar.focused && gURLBar.hasAttribute("zen-newtab"),
    "Cmd+Option+T opened the command bar"
  );
}

async function inputHistoryCount(input) {
  const rows = await PlacesUtils.withConnectionWrapper("whimsy-private-bar", db =>
    db.execute("SELECT count(*) AS n FROM moz_inputhistory WHERE input = :input", { input })
  );
  return rows[0].getResultByName("n");
}

add_task(async function setup() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.scratch", true],
      ["whimsy.private.in-window", true],
    ],
  });
  const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  ok(!WhimsyPrivate.isPrivateTab(normal), "Starting on a normal tab");
  gBrowser.selectedBrowser.focus();
});

add_task(async function test_private_tab_only_after_enter() {
  const before = gBrowser.tabs.length;
  let opened = null;
  const onOpen = event => (opened = event.target);
  gBrowser.tabContainer.addEventListener("TabOpen", onOpen);

  await openPrivateBar();
  is(gBrowser.tabs.length, before, "No tab yet: only the bar opened");
  ok(!opened, "No TabOpen before Enter");
  ok(gURLBar.hasAttribute("whimsy-private"), "The bar is in private mode (violet ring)");
  ok(gURLBar.isPrivate, "The bar's queries are private");
  ok(gURLBar.parentController.isPrivate, "... and so is its controller (form and input history)");

  const badge = document.getElementById(BADGE_ID);
  ok(badge, "The Private badge exists");
  await TestUtils.waitForCondition(() => badge.textContent.trim() == "Private", "The badge reads Private");
  await TestUtils.waitForCondition(
    () => gURLBar.hasAttribute("breakout-extend") && getComputedStyle(badge).display != "none",
    "The badge shows while the bar is open"
  );
  ok(
    gURLBar.inputField.getAttribute("aria-describedby")?.split(" ").includes(BADGE_ID),
    "The input is described by the badge, so Private is announced"
  );

  const url = uniqueURL("enter");
  EventUtils.sendString(url);
  const newTab = BrowserTestUtils.waitForNewTab(gBrowser, url, true);
  EventUtils.synthesizeKey("KEY_Enter");
  const tab = await newTab;
  gBrowser.tabContainer.removeEventListener("TabOpen", onOpen);

  ok(WhimsyPrivate.isPrivateTab(tab), "Enter opened a private tab");
  ok(tab.linkedBrowser.browsingContext.usePrivateBrowsing, "... that browses privately");
  is(gBrowser.selectedTab, tab, "It's selected");
  is(gBrowser.tabs.length, before + 1, "Exactly one tab was created");
  await barClosed();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_esc_creates_nothing() {
  const before = [...gBrowser.tabs];
  const selected = gBrowser.selectedTab;
  let opened = 0;
  const onOpen = () => opened++;
  gBrowser.tabContainer.addEventListener("TabOpen", onOpen);

  await openPrivateBar();
  EventUtils.sendString("never opened");
  EventUtils.synthesizeKey("KEY_Escape");
  if (gURLBar.focused) {
    EventUtils.synthesizeKey("KEY_Escape");
  }
  gBrowser.selectedBrowser.focus();
  await barClosed();
  gBrowser.tabContainer.removeEventListener("TabOpen", onOpen);

  is(opened, 0, "Esc opened no tab");
  Assert.deepEqual([...gBrowser.tabs], before, "The tab strip is unchanged");
  is(gBrowser.selectedTab, selected, "The same tab is selected");
  ok(!gURLBar.hasAttribute("whimsy-private"), "The bar is back to normal");
  ok(!gURLBar.isPrivate, "... and so are its queries");

  // Private text isn't carried into the next normal bar.
  ok(gZenUIManager.handleNewTab(false, false, "tab", true), "A normal command bar opens");
  await TestUtils.waitForCondition(() => gURLBar.focused, "It has focus");
  isnot(gURLBar.value, "never opened", "The private bar's text didn't carry over");
  ok(!gURLBar.hasAttribute("whimsy-private"), "The normal bar has no violet");
  EventUtils.synthesizeKey("KEY_Escape");
  if (gURLBar.focused) {
    EventUtils.synthesizeKey("KEY_Escape");
  }
  gBrowser.selectedBrowser.focus();
  await barClosed();
});

add_task(async function test_cmd_t_from_private_tab_is_normal() {
  const source = WhimsyPrivate.openPrivateTab(window, { url: uniqueURL("source"), force: true });
  await BrowserTestUtils.browserLoaded(source.linkedBrowser);
  gBrowser.selectedTab = source;
  ok(gURLBar.hasAttribute("whimsy-private"), "On a private tab the address bar is violet");

  // Cmd+T's bar (tests skip Zen's Cmd+T replacement unless asked, hence
  // the override, as in browser_whimsy_new_tabs.js).
  ok(gZenUIManager.handleNewTab(false, false, "tab", true), "Cmd+T's command bar opens");
  await TestUtils.waitForCondition(() => gURLBar.focused, "It has focus");
  ok(!gURLBar.hasAttribute("whimsy-private"), "Cmd+T's bar has no violet ring");
  ok(!gURLBar.isPrivate, "Its queries aren't private");
  const badge = document.getElementById(BADGE_ID);
  ok(!badge || getComputedStyle(badge).display == "none", "No Private badge");

  const url = uniqueURL("cmdt");
  EventUtils.sendString(url);
  const newTab = BrowserTestUtils.waitForNewTab(gBrowser, url, true);
  EventUtils.synthesizeKey("KEY_Enter");
  const tab = await newTab;
  ok(!WhimsyPrivate.isPrivateTab(tab), "Cmd+T from a private tab opens a normal tab");
  ok(!tab.linkedBrowser.browsingContext.usePrivateBrowsing, "... that doesn't browse privately");
  await barClosed();
  ok(!gURLBar.hasAttribute("whimsy-private"), "On the new normal tab the bar is normal");

  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(source);
});

add_task(async function test_cmd_l_on_private_tab_is_purple() {
  const url = uniqueURL("cmdl");
  const tab = WhimsyPrivate.openPrivateTab(window, { url, force: true });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  gBrowser.selectedTab = tab;
  gBrowser.selectedBrowser.focus();

  EventUtils.synthesizeKey("l", { accelKey: true });
  await TestUtils.waitForCondition(() => gURLBar.focused, "Cmd+L focused the address bar");
  ok(gURLBar.hasAttribute("whimsy-private"), "Cmd+L on a private tab is violet");
  ok(gURLBar.isPrivate, "... and its queries are private");
  const badge = document.getElementById(BADGE_ID);
  ok(badge, "The Private badge exists");
  await TestUtils.waitForCondition(
    () => !gURLBar.hasAttribute("breakout-extend") || getComputedStyle(badge).display != "none",
    "When the bar is open, the badge shows"
  );

  // Alt+Enter (a new tab) from a private tab's bar stays private.
  const other = uniqueURL("altenter");
  gURLBar.select();
  EventUtils.sendString(other);
  const newTab = BrowserTestUtils.waitForNewTab(gBrowser, other, true);
  EventUtils.synthesizeKey("KEY_Enter", { altKey: true });
  const opened = await newTab;
  ok(WhimsyPrivate.isPrivateTab(opened), "A new tab from a private tab's bar is private");

  BrowserTestUtils.removeTab(opened);
  BrowserTestUtils.removeTab(tab);
  await TestUtils.waitForTick();
});

add_task(async function test_no_history_written() {
  await PlacesUtils.history.clear();
  const typed = `whimsyprivatebar${Date.now()}`;
  const url = `${PAGE}?${typed}`;

  await openPrivateBar();
  EventUtils.sendString(url);
  const newTab = BrowserTestUtils.waitForNewTab(gBrowser, url, true);
  EventUtils.synthesizeKey("KEY_Enter");
  const tab = await newTab;
  ok(WhimsyPrivate.isPrivateTab(tab), "The page opened privately");
  await barClosed();
  // Give Places a moment to (not) record anything.
  await PlacesTestUtils.promiseAsyncUpdates();
  await TestUtils.waitForTick();

  ok(!(await PlacesUtils.history.hasVisits(url)), "No history visit for the page");
  ok(!(await PlacesUtils.history.fetch(url)), "The page isn't in Places at all");
  is(await inputHistoryCount(url), 0, "No input history for what was typed");
  is(await inputHistoryCount(typed), 0, "... in any form");

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_scratch_still_works() {
  const opened = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabOpen");
  EventUtils.synthesizeKey("n", { accelKey: true, shiftKey: true });
  const { target: tab } = await opened;
  ok(WhimsyPrivate.isPrivateTab(tab), "Cmd+Shift+N still opens Scratch's private tab");
  await TestUtils.waitForCondition(() => WhimsyPrivate.getScratch(window), "Scratch exists");
  await TestUtils.waitForCondition(() => WhimsyPrivate.activeSpaceIsScratch(window), "Scratch is the active space");

  // Every new tab in Scratch is private, so Cmd+T's bar there is the
  // private one.
  gBrowser.selectedBrowser.focus();
  ok(gZenUIManager.handleNewTab(false, false, "tab", true), "Cmd+T's bar opens in Scratch");
  await TestUtils.waitForCondition(() => gURLBar.focused, "It has focus");
  ok(gURLBar.hasAttribute("whimsy-private"), "In Scratch, Cmd+T's bar is violet");
  ok(gURLBar.isPrivate, "... and private");
  EventUtils.synthesizeKey("KEY_Escape");
  if (gURLBar.focused) {
    EventUtils.synthesizeKey("KEY_Escape");
  }
  gBrowser.selectedBrowser.focus();
  await barClosed();
  await WhimsyPrivate.closeScratch(window);
  await TestUtils.waitForCondition(() => !WhimsyPrivate.getScratch(window), "Scratch closed");
});
