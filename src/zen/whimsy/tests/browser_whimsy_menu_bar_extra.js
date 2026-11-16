/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Menu bar extra (Arc parity, macOS only): a status bar icon with "New
// Quick Window" and recent tabs, built on nsISystemStatusBar. Covers the
// main flow, the Settings toggle, that toggling off-then-on recreates
// the element rather than reusing a stale one removeItem already forgot,
// and that the popup's two real menu commands (New Mini Whimsy, a
// recently-closed tab) actually do something when invoked.

const { WhimsyMenuBarExtra } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyMenuBarExtra.sys.mjs"
);
const { WhimsyQuickWindow } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs"
);
const { SessionStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs"
);

function forgetAllClosedTabs(win) {
  while (SessionStore.getClosedTabCountForWindow(win) > 0) {
    SessionStore.forgetClosedTab(win, 0);
  }
}

add_task(async function test_show_pref_adds_and_removes() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.menu-bar-extra", true],
      ["whimsy.menu-bar-extra.show", true],
    ],
  });
  WhimsyMenuBarExtra.init();
  ok(WhimsyMenuBarExtra.enabled, "enabled with both prefs on");

  await TestUtils.waitForCondition(() => document.getElementById("whimsyMenuBarExtra"), "status item added");
  const first = document.getElementById("whimsyMenuBarExtra");
  ok(first, "menu element exists");
  is(first.localName, "menu", "it's a <menu>, as nsISystemStatusBar expects");

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.menu-bar-extra.show", false]] });
  ok(!WhimsyMenuBarExtra.enabled, "disabled once the setting is off");
  await TestUtils.waitForCondition(() => !document.getElementById("whimsyMenuBarExtra"), "status item removed");

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.menu-bar-extra.show", true]] });
  await TestUtils.waitForCondition(() => document.getElementById("whimsyMenuBarExtra"), "status item recreated");
  isnot(document.getElementById("whimsyMenuBarExtra"), first, "a fresh element, not the one removeItem already forgot");

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.menu-bar-extra", false]] });
  await TestUtils.waitForCondition(() => !document.getElementById("whimsyMenuBarExtra"), "cleaned up with the feature switch off");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_popup_contents() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.menu-bar-extra", true],
      ["whimsy.menu-bar-extra.show", true],
    ],
  });
  WhimsyMenuBarExtra.init();
  await TestUtils.waitForCondition(() => document.getElementById("whimsyMenuBarExtraPopup"));
  const popup = document.getElementById("whimsyMenuBarExtraPopup");
  WhimsyMenuBarExtra._populate(popup, window);
  const items = [...popup.children];
  ok(items.length >= 1, "the popup has at least the quick window entry");
  is(items[0].getAttribute("data-l10n-id"), "whimsy-menu-bar-extra-quick-window", "first entry is New Quick Window");

  await SpecialPowers.popPrefEnv();
});

// Dispatching `command` on the "New Mini Whimsy" entry is the real path a
// click on the status bar menu takes (RecentlyClosedTabsAndWindowsMenuUtils'
// own entries also wire up plain "command" listeners, not XUL oncommand
// attributes, so a synthetic Event("command") exercises the same listener
// a real click would).
add_task(async function test_quick_window_entry_opens_mini_whimsy() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.menu-bar-extra", true],
      ["whimsy.menu-bar-extra.show", true],
      ["whimsy.feature.quick-window", true],
    ],
  });
  WhimsyMenuBarExtra.init();
  await TestUtils.waitForCondition(() => document.getElementById("whimsyMenuBarExtraPopup"));
  const popup = document.getElementById("whimsyMenuBarExtraPopup");
  WhimsyMenuBarExtra._populate(popup, window);
  const quickWindowItem = popup.firstChild;
  is(quickWindowItem.getAttribute("data-l10n-id"), "whimsy-menu-bar-extra-quick-window", "New Mini Whimsy entry");

  const before = new Set(WhimsyQuickWindow.windows());
  quickWindowItem.dispatchEvent(new window.Event("command", { bubbles: true }));
  await TestUtils.waitForCondition(
    () => WhimsyQuickWindow.windows().some(win => !before.has(win)),
    "A Mini Whimsy window opened"
  );
  const mini = WhimsyQuickWindow.windows().find(win => !before.has(win));
  ok(mini._whimsyQuickWindow, "It's a Mini Whimsy (WhimsyQuickWindow) window");
  await WhimsyQuickWindow.whenReady(mini);
  await BrowserTestUtils.closeWindow(mini);

  await SpecialPowers.popPrefEnv();
});

// A tab closed in this window shows up as a menuitem (its target URI on
// `targetURI`, same attribute Firefox's own Recently Closed menu reads for
// its tooltip), and dispatching `command` on it reopens that tab.
add_task(async function test_recently_closed_tab_entry_reopens_it() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.menu-bar-extra", true],
      ["whimsy.menu-bar-extra.show", true],
      ["browser.sessionstore.closedTabsFromAllWindows", false],
      ["browser.sessionstore.closedTabsFromClosedWindows", false],
    ],
  });
  forgetAllClosedTabs(window);
  WhimsyMenuBarExtra.init();
  await TestUtils.waitForCondition(() => document.getElementById("whimsyMenuBarExtraPopup"));
  const popup = document.getElementById("whimsyMenuBarExtraPopup");

  const url = "https://example.com/menu-bar-extra-recent-tab";
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  await BrowserTestUtils.removeTab(tab);
  await TestUtils.waitForCondition(
    () => SessionStore.getClosedTabDataForWindow(window).some(t => t.state.entries.at(-1)?.url == url),
    "The tab is recently closed"
  );

  WhimsyMenuBarExtra._populate(popup, window);
  const entry = [...popup.children].find(item => item.getAttribute("targetURI") == url);
  ok(entry, "The popup lists the closed tab, with its URL on targetURI");
  ok(!entry.disabled, "...and it's a real, enabled entry");

  const reopened = BrowserTestUtils.waitForNewTab(gBrowser, url, true);
  entry.dispatchEvent(new window.Event("command", { bubbles: true }));
  const reopenedTab = await reopened;
  is(reopenedTab.linkedBrowser.currentURI.spec, url, "The tab reopened with the right URL");

  BrowserTestUtils.removeTab(reopenedTab);
  await SpecialPowers.popPrefEnv();
});

// Nothing closed: the popup falls back to the disabled placeholder row
// instead of an empty "Recently Closed" section.
add_task(async function test_no_recently_closed_tabs_row() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.menu-bar-extra", true],
      ["whimsy.menu-bar-extra.show", true],
      ["browser.sessionstore.closedTabsFromAllWindows", false],
      ["browser.sessionstore.closedTabsFromClosedWindows", false],
    ],
  });
  forgetAllClosedTabs(window);
  is(SessionStore.getClosedTabCountForWindow(window), 0, "Nothing closed, to start");

  WhimsyMenuBarExtra.init();
  await TestUtils.waitForCondition(() => document.getElementById("whimsyMenuBarExtraPopup"));
  const popup = document.getElementById("whimsyMenuBarExtraPopup");
  WhimsyMenuBarExtra._populate(popup, window);
  const items = [...popup.children];
  const none = items.at(-1);
  is(none.getAttribute("data-l10n-id"), "whimsy-menu-bar-extra-no-recent-tabs", "The disabled placeholder row");
  is(none.getAttribute("disabled"), "true", "...disabled, since there's nothing to reopen");

  await SpecialPowers.popPrefEnv();
});

registerCleanupFunction(() => {
  WhimsyMenuBarExtra.apply();
});
