/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Reading RSS live folders: an unread count on the folder and a dot on each
// unopened item (whimsy.feature.live-folders-unread), and items that open
// in Reader View (whimsy.feature.live-folders-rss-reader).

const { WhimsyLiveFolderReading } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyLiveFolderReading.sys.mjs"
);
const { nsRssLiveFolderProvider } = ChromeUtils.importESModule("resource:///modules/zen/RssLiveFolder.sys.mjs");
const { ZenLiveFoldersManager } = ChromeUtils.importESModule("resource:///modules/zen/ZenLiveFoldersManager.sys.mjs");

function makeRss(id, state = {}) {
  return new nsRssLiveFolderProvider({
    id,
    manager: { window: null, getFolderForLiveFolder: () => null, saveState: () => {} },
    state: { url: "https://example.com/feed.xml", ...state },
  });
}

function fakeOption(key) {
  return { getAttribute: name => (name == "option-key" ? key : null) };
}

add_setup(function () {
  WhimsyLiveFolderReading.init();
});

add_task(function test_reader_view_urls() {
  ok(Services.prefs.getBoolPref("whimsy.feature.live-folders-rss-reader"), "The switch is on");
  const rss = makeRss("test-reader");
  const items = [{ id: "a", title: "A", url: "https://example.com/post?x=1&y=2" }];

  const [item] = WhimsyLiveFolderReading.maybeReaderItems(rss, items);
  is(
    item.url,
    "about:reader?url=" + encodeURIComponent("https://example.com/post?x=1&y=2"),
    "An RSS item opens in Reader View"
  );
  is(item.id, "a", "Its id is unchanged");
  is(items[0].url, "https://example.com/post?x=1&y=2", "The provider's own item isn't modified");
  is(
    WhimsyLiveFolderReading.readerURL(item.url),
    item.url,
    "A Reader View URL isn't wrapped twice"
  );

  // The per-folder option.
  const reader = rss.options.find(o => o.key == "whimsyReader");
  ok(reader, "The folder's options offer Open in Reader View");
  ok(reader.checked, "... checked by default");
  rss.onOptionTrigger(fakeOption("whimsyReader"));
  is(rss.state.whimsyReader, false, "Unchecking it is saved on the folder");
  is(WhimsyLiveFolderReading.maybeReaderItems(rss, items)[0].url, items[0].url, "Off: items open normally");
  rss.onOptionTrigger(fakeOption("whimsyReader"));
  ok(rss.state.whimsyReader, "Checking it again turns it back on");

  // Other providers and the switch.
  const notRss = { constructor: { type: "github" }, state: {} };
  is(WhimsyLiveFolderReading.maybeReaderItems(notRss, items)[0].url, items[0].url, "Only RSS folders");
  Services.prefs.setBoolPref("whimsy.feature.live-folders-rss-reader", false);
  is(WhimsyLiveFolderReading.maybeReaderItems(rss, items)[0].url, items[0].url, "Switch off: items open normally");
  ok(!rss.options.some(o => o.key == "whimsyReader"), "Switch off: no option");
  Services.prefs.clearUserPref("whimsy.feature.live-folders-rss-reader");
  is(WhimsyLiveFolderReading.maybeReaderItems("not items", items), "not items", "Fetch errors pass through");
});

add_task(async function test_unread_counts() {
  ok(Services.prefs.getBoolPref("whimsy.feature.live-folders-unread"), "The switch is on");
  const keep = BrowserTestUtils.addTab(gBrowser, "about:blank");
  gBrowser.selectedTab = keep;
  const folder = await gZenFolders.createFolder([], { renameFolder: false, label: "Feed" });
  const rss = makeRss(folder.id);
  ZenLiveFoldersManager.liveFolders.set(folder.id, rss);

  const tabs = [];
  for (const name of ["one", "two", "three"]) {
    const tab = BrowserTestUtils.addTab(gBrowser, "about:blank", { skipAnimation: true });
    tab.setAttribute("zen-live-folder-item-id", `${folder.id}:${name}`);
    tabs.push(tab);
  }
  folder.addTabs(tabs);
  await TestUtils.waitForCondition(() => tabs.every(t => t.group == folder), "The items are in the folder");

  WhimsyLiveFolderReading.updateWindow(window, folder.id);
  const badge = () => folder.querySelector(".whimsy-live-unread");
  is(badge()?.textContent, "3", "Three unread items");
  ok(tabs.every(t => t.hasAttribute("whimsy-unread")), "Each unopened item has a dot");
  await TestUtils.waitForCondition(() => badge().getAttribute("aria-label"), "The count is labelled");
  is(badge().getAttribute("aria-label"), "3 unread items", "... for screen readers");

  // Opening an item reads it.
  gBrowser.selectedTab = tabs[0];
  is(badge()?.textContent, "2", "Opening one leaves two");
  ok(!tabs[0].hasAttribute("whimsy-unread"), "The opened item lost its dot");
  ok(rss.state.whimsyRead.includes(`${folder.id}:one`), "Read state is saved on the folder");

  // A later fetch prunes items the feed no longer lists.
  WhimsyLiveFolderReading.pruneRead(rss, [{ id: "two" }, { id: "three" }]);
  ok(!rss.state.whimsyRead.includes(`${folder.id}:one`), "Gone items leave the read list");

  // Mark All as Read.
  ok(rss.options.some(o => o.key == "whimsyMarkAllRead"), "The folder's options offer Mark All as Read");
  rss.onOptionTrigger(fakeOption("whimsyMarkAllRead"));
  ok(!badge(), "No count when everything is read");
  ok(tabs.every(t => !t.hasAttribute("whimsy-unread")), "No dots either");

  // Switch off: no counts at all.
  rss.state.whimsyRead = [];
  rss._whimsyRead = null;
  Services.prefs.setBoolPref("whimsy.feature.live-folders-unread", false);
  WhimsyLiveFolderReading.updateWindow(window, folder.id);
  ok(!badge(), "Switch off: no count");
  ok(tabs.every(t => !t.hasAttribute("whimsy-unread")), "Switch off: no dots");
  Services.prefs.clearUserPref("whimsy.feature.live-folders-unread");

  gBrowser.selectedTab = keep;
  ZenLiveFoldersManager.liveFolders.delete(folder.id);
  const removed = BrowserTestUtils.waitForEvent(folder, "TabGroupRemoved");
  folder.delete();
  await removed;
  BrowserTestUtils.removeTab(keep);
});
