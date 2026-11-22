/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W30 Mini Window (ideas-inventory 6a, mockup 9.1-9.2): Open as Popover on
// any tab. On a tab that isn't an Essential it floats once: the tab keeps
// its window, space, folder, and place in the sidebar, and unchecking it,
// Expand, chat taking the popover, or closing the window leave it there.

const { TabStateFlusher } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs");

const chatEl = () => document.getElementById("whimsy-chat");

// Where a tab is: what session restore would put back.
function placeOf(tab) {
  return {
    window: tab.documentGlobal,
    space: tab.getAttribute("zen-workspace-id"),
    folder: tab.group?.id ?? null,
    index: tab._tPos,
    pinned: tab.pinned,
  };
}

function samePlace(tab, before, what) {
  const now = placeOf(tab);
  ok(tab.isConnected && !tab.closing, `${what}: the tab is still open`);
  is(now.window, before.window, `${what}: same window`);
  is(now.space, before.space, `${what}: same space`);
  is(now.folder, before.folder, `${what}: same folder`);
  is(now.index, before.index, `${what}: same place in the sidebar`);
  is(now.pinned, before.pinned, `${what}: still ${before.pinned ? "pinned" : "unpinned"}`);
}

async function floatFromMenu(tab) {
  const menu = await openTabMenu(tab);
  const item = document.getElementById("context_whimsySidePanel");
  ok(item.checkVisibility(), "Open as Popover is in a normal tab's menu");
  await TestUtils.waitForCondition(() => item.label == "Open as Popover", "under its name");
  ok(!item.hasAttribute("checked"), "unchecked");
  menu.activateItem(item);
  await BrowserTestUtils.waitForEvent(menu, "popuphidden");
  await TestUtils.waitForCondition(() => shown(tab), "The tab floats in the popover");
  await settle(tab);
}

async function settleChat() {
  await TestUtils.waitForCondition(
    () => !chatEl() || chatEl().getAnimations({ subtree: true }).every(a => a.playState != "running"),
    "Chat's motion has finished"
  );
}

addPanelTask(async function float_a_normal_tab_and_uncheck() {
  const maps = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/?maps");
  const linear = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.net/?linear");
  const before = placeOf(maps);

  // From the background: the page stays the page.
  await floatFromMenu(maps);
  is(gBrowser.selectedTab, linear, "The page you're on stays");
  ok(maps.undiscardable, "Kept alive while it floats");
  samePlace(maps, before, "Floating");

  const menu = await openTabMenu(maps);
  const item = document.getElementById("context_whimsySidePanel");
  is(item.getAttribute("checked"), "true", "Checked while it floats");
  menu.activateItem(item);
  await BrowserTestUtils.waitForEvent(menu, "popuphidden");
  await hidden(maps, "Unchecking it puts it back");
  samePlace(maps, before, "Unchecked");
  ok(!maps.undiscardable, "and Firefox's rules apply again");
  is(gBrowser.selectedTab, linear, "The page is unchanged");

  // From the page itself: the tab you were on comes back.
  gBrowser.selectedTab = maps;
  await floatFromMenu(maps);
  isnot(gBrowser.selectedTab, maps, "Another page shows under it");
  samePlace(maps, before, "Floating the page");
  ok(!maps.hasAttribute("zen-essential"), "It isn't made an Essential");
  ok(!maps.hasAttribute(WhimsySidePanel.OFF_ATTR), "and no preference is saved");

  // Selecting it in the sidebar makes it the page again, in place.
  EventUtils.synthesizeMouseAtCenter(maps, {});
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == maps, "Its row selects it");
  await hidden(maps, "and the popover lets it go");
  samePlace(maps, before, "Selected");
});

addPanelTask(async function expand_returns_it_in_its_folder() {
  const one = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/?trip-one");
  const two = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/?trip-two");
  const folder = await gZenFolders.createFolder([one, two], { renameFolder: false, label: "Trip planning" });
  try {
    gBrowser.selectedTab = home;
    const before = placeOf(two);
    is(before.folder, folder.id, "In the folder");
    await floatFromMenu(two);
    samePlace(two, before, "Floating from a folder");

    EventUtils.synthesizeMouseAtCenter(box(two).querySelector(".whimsy-side-panel-expand"), {});
    await TestUtils.waitForCondition(() => gBrowser.selectedTab == two && !sp().tab, "Expand makes it the page");
    await settle(two);
    samePlace(two, before, "Expanded");
    ok(!sp().expanded, "Nothing waits to shrink it back: it was a one-time float");
    ok(!two.undiscardable, "and it's a normal tab again");
  } finally {
    if (folder.isConnected) {
      const removed = BrowserTestUtils.waitForEvent(folder, "TabGroupRemoved");
      folder.delete();
      await removed;
    }
  }
});

addPanelTask(async function chat_takes_the_popover() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", true], ["whimsy.feature.ai-hints", false], ["whimsy.chat.popover", true]] });
  try {
    await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, "whimsy-any-tab-" + Date.now()));
    WhimsyAIProviders.setTestProvider(async function* () {
      yield { type: "text", delta: "Hello." };
    });
    WhimsyAIProviders.setOrder(["claude"]);
    const maps = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/?maps-chat");
    gBrowser.selectedTab = home;
    const before = placeOf(maps);
    await floatFromMenu(maps);

    await SimpleTest.promiseFocus(window);
    gBrowser.selectedBrowser.focus();
    EventUtils.synthesizeKey("e", { accelKey: true });
    await TestUtils.waitForCondition(() => chat().isOpen, "Chat opens");
    await hidden(maps, "Chat in the popover puts the tab back");
    await settleChat();
    samePlace(maps, before, "Chat took the popover");
    ok(!maps.undiscardable, "It's a normal tab again");
    is(gBrowser.selectedTab, home, "The page is unchanged");
    chat().close({ reason: "key" });
    await settleChat();
  } finally {
    await WhimsyAIStore._resetForTesting(null);
    await SpecialPowers.popPrefEnv();
  }
});

addPanelTask(async function essentials_unchanged() {
  const maps = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/?maps-ess");
  const ess = await makeEssential("https://example.net/?ess");
  const before = placeOf(maps);
  await floatFromMenu(maps);

  // An Essential takes the popover: the floated tab goes back.
  await clickTile(ess, true);
  await TestUtils.waitForCondition(() => !box(maps).hasAttribute("whimsy-popover"), "The floated tab's panel goes back");
  samePlace(maps, before, "An Essential took the popover");
  ok(!maps.undiscardable, "and it's a normal tab again");

  // The Essential's row is still its routing preference.
  const menu = await openTabMenu(ess);
  const item = document.getElementById("context_whimsySidePanel");
  is(item.getAttribute("checked"), "true", "An Essential's row shows its preference");
  await closeMenu(menu);
  await clickTile(ess, false);
  ok(!ess.hasAttribute(WhimsySidePanel.OFF_ATTR), "and it still floats from its tile");
});

addPanelTask(async function closing_the_window_keeps_it() {
  const win = await BrowserTestUtils.openNewBrowserWindow();
  try {
    const panel = WhimsySidePanel.forWindow(win);
    const maps = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, "https://example.org/?maps-window");
    const page = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, "https://example.net/?page-window");
    await TabStateFlusher.flush(maps.linkedBrowser);
    const saved = () => SessionStore.getWindowState(win).windows[0].tabs.map(t => t.entries.at(-1)?.url);
    const order = saved();
    const index = maps._tPos;

    panel.float(maps);
    await TestUtils.waitForCondition(() => panel.tab == maps, "It floats");
    is(win.gBrowser.selectedTab, page, "over the page");
    await TabStateFlusher.flush(maps.linkedBrowser);
    Assert.deepEqual(saved(), order, "Session restore sees the same tabs in the same order while it floats");

    const id = maps.id;
    const url = maps.linkedBrowser.currentURI.spec;
    await BrowserTestUtils.closeWindow(win);
    // With Zen's window sync the tab lives on here; without it, the closed
    // window keeps it, in its place.
    const copy = document.getElementById(id);
    const closed = SessionStore.getClosedWindowData()[0];
    ok(copy?.isConnected || closed?.tabs[index]?.entries.at(-1)?.url == url, "Closing the window while it floats loses nothing");
    if (copy?.isConnected) {
      BrowserTestUtils.removeTab(copy);
    }
  } finally {
    if (!win.closed) {
      await BrowserTestUtils.closeWindow(win);
    }
  }
});
