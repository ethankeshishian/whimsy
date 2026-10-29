/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Pin or favorite a split: reopening a split with one click instead of
// manually re-splitting two tabs each time. Covers saving a favorite,
// reopening it (reconstructs a fresh split, not a live restore), removing
// one without disturbing a currently-open split made from it, and the
// feature switch.

const { WhimsySplitFavorites } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySplitFavorites.sys.mjs"
);

async function clearFavorites() {
  const favorites = await WhimsySplitFavorites._load();
  favorites.length = 0;
  WhimsySplitFavorites.store.saveSoon();
}

registerCleanupFunction(async () => {
  await clearFavorites();
});

add_task(async function test_open_favorite_recreates_split() {
  await clearFavorites();
  const favorites = await WhimsySplitFavorites._load();
  favorites.push({
    id: "test-favorite",
    name: "Test split",
    urls: ["https://example.com/", "https://example.org/"],
    gridType: "vsep",
  });
  WhimsySplitFavorites.store.saveSoon();

  const before = new Set(gBrowser.tabs);
  await WhimsySplitFavorites.openFavorite(window, favorites[0]);
  await TestUtils.waitForCondition(() => gZenViewSplitter.splitViewActive, "the split activated");
  const splitData = gZenViewSplitter._data[gZenViewSplitter.currentView];
  is(splitData.tabs.length, 2, "both URLs opened as a split");
  is(splitData.gridType, "vsep", "the saved layout was used");

  gZenViewSplitter.unsplitCurrentView();
  for (const tab of gBrowser.tabs.filter(t => !before.has(t))) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_remove_favorite_does_not_touch_open_split() {
  await clearFavorites();
  const favorites = await WhimsySplitFavorites._load();
  favorites.push({ id: "keepme", name: "Keep", urls: ["https://example.com/", "https://example.org/"], gridType: "vsep" });
  WhimsySplitFavorites.store.saveSoon();

  const before = new Set(gBrowser.tabs);
  await WhimsySplitFavorites.openFavorite(window, favorites[0]);
  await TestUtils.waitForCondition(() => gZenViewSplitter.splitViewActive);

  await WhimsySplitFavorites.removeFavorite("keepme");
  const remaining = await WhimsySplitFavorites._load();
  ok(!remaining.some(f => f.id == "keepme"), "the favorite is gone");
  ok(gZenViewSplitter.splitViewActive, "the split that was opened from it is still live");

  gZenViewSplitter.unsplitCurrentView();
  for (const tab of gBrowser.tabs.filter(t => !before.has(t))) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_dead_url_still_opens() {
  await clearFavorites();
  const before = new Set(gBrowser.tabs);
  await WhimsySplitFavorites.openFavorite(window, {
    urls: ["https://example.com/", "https://nonexistent.invalid.whimsy-test/"],
    gridType: "vsep",
  });
  await TestUtils.waitForCondition(() => gZenViewSplitter.splitViewActive, "it still opens as a split");
  gZenViewSplitter.unsplitCurrentView();
  for (const tab of gBrowser.tabs.filter(t => !before.has(t))) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_feature_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.split-favorites", false]] });
  ok(!WhimsySplitFavorites.enabled, "the switch turns the feature off");
  await SpecialPowers.popPrefEnv();
});
