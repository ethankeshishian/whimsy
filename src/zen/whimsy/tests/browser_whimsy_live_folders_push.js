/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// "Push" live-folder refresh: alongside the normal 15-minute-and-up fetch
// intervals, a folder can check every minute using a cheap conditional
// GET (If-None-Match). Unchanged content answers 304 with no body, so
// Push doesn't actually mean "re-fetch and re-render every minute" --
// only a real change does that.

const { WhimsyLiveFolders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLiveFolders.sys.mjs");
const { nsRssLiveFolderProvider } = ChromeUtils.importESModule("resource:///modules/zen/RssLiveFolder.sys.mjs");

const BASE =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") +
  "whimsy_push_rss.sjs";

function makeManager() {
  return { window: null, getFolderForLiveFolder: () => null, saveState: () => {} };
}

async function fullFetchCount() {
  const res = await fetch(`${BASE}?count`);
  return (await res.text()).trim();
}

add_setup(async function () {
  // Idempotent: guaranteed to have run from app startup already, but
  // calling it again here makes the test self-contained either way.
  WhimsyLiveFolders.init();
});

add_task(async function test_push_skips_unchanged_refetch() {
  const folder = new nsRssLiveFolderProvider({
    id: "test-push-rss",
    manager: makeManager(),
    state: { url: BASE, whimsyPush: true },
  });

  const items1 = await folder.fetchItems();
  ok(Array.isArray(items1) && items1.length === 1, "First call: no cache yet, a real fetch");
  is(await fullFetchCount(), "1", "One real fetch so far");

  const items2 = await folder.fetchItems();
  ok(Array.isArray(items2), "Second call: items come back");
  is(await fullFetchCount(), "2", "Second call still refetches once -- no ETag known yet to probe with");

  const items3 = await folder.fetchItems();
  is(await fullFetchCount(), "2", "Third call: the conditional probe alone catches 'unchanged', no real refetch");
  is(items3, items2, "Unchanged content returns the same cached items, not a re-parsed copy (no re-render)");

  await fetch(`${BASE}?bump`);
  const items4 = await folder.fetchItems();
  is(await fullFetchCount(), "3", "Changed content: the probe sees it and triggers a real refetch");
  isnot(items4, items3, "Changed content returns freshly fetched items");
});

add_task(async function test_switch_off_always_refetches() {
  await fetch(`${BASE}?bump`); // settle on a fresh version so counts below start clean
  const before = await fullFetchCount();

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.live-folders-push", false]] });
  const folder = new nsRssLiveFolderProvider({
    id: "test-push-off",
    manager: makeManager(),
    state: { url: BASE, whimsyPush: true },
  });
  await folder.fetchItems();
  await folder.fetchItems();
  is(
    await fullFetchCount(),
    String(Number(before) + 2),
    "With the feature switch off, every call is a real fetch even with whimsyPush set"
  );
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_menu_option_sets_push_mode() {
  const folder = new nsRssLiveFolderProvider({
    id: "test-push-menu",
    manager: makeManager(),
    state: { url: BASE, interval: 30 * 60 * 1000 },
  });
  // A stand-in for the spliced-in "Push" radio: onOptionTrigger only
  // reads its attributes, so a detached element is enough.
  const option = document.createXULElement("menuitem");
  option.setAttribute("option-key", "whimsyPush");
  await folder.onOptionTrigger(option);
  ok(folder.state.whimsyPush, "Picking Push sets push mode");
  is(folder.state.interval, 60 * 1000, "and the 1-minute interval");
  folder.stop();
});
