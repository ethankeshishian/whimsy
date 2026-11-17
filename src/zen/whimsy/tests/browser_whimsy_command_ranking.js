/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */
"use strict";

const { rankCommandResults, commandMatchTier, placeCommandResults } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommandRanking.sys.mjs");
const { UrlbarShared } = ChromeUtils.importESModule("chrome://browser/content/urlbar/UrlbarShared.mjs");
const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");
const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");

add_setup(async function () {
  UrlbarTestUtils.init(this);
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.feature.command-bar-ranking", true],
    ["zen.urlbar.suggestions.quick-actions", true],
    ["browser.urlbar.maxRichResults", 20],
    ["browser.urlbar.suggest.history", true],
  ] });
});

function command(name, id, kind = "command") {
  return {
    commandId: kind == "setting" ? `cmd_whimsySetting-${id}` : id,
    // Deliberately conflicting learned hints must be overwritten.
    heuristic: true,
    suggestedIndex: 99,
    payload: {
      dynamicType: kind == "page" ? "whimsy-verb" : "zen-actions",
      title: name,
      ...(kind == "extension" ? { extensionId: id, prettyName: name } : {}),
      whimsyVerb: id,
    },
  };
}

add_task(function tiers_and_stable_source_ties() {
  is(commandMatchTier("Café", "CAFE"), 0, "Exact matching folds case and accents");
  is(commandMatchTier("Café Settings", "cafe"), 1, "Prefix matching folds accents");
  is(commandMatchTier("Open Café Settings", "cafe settings"), 2, "Multiword word prefix");
  is(commandMatchTier("Decafeteria", "cafe"), 3, "Substring is an other match");
  const fixtures = [
    ["Rank Z", "z", "command"], ["Rank A", "a", "command"],
    ["Rank A", "setting", "setting"], ["Rank A", "extension", "extension"],
    ["Rank A", "page", "page"], ["Open Rank", "word", "command"],
    ["Outrank", "other", "command"], ["Ránk", "exact", "command"],
  ];
  const expected = ["exact", "a", "z", "cmd_whimsySetting-setting", "extension", "page", "word", "other"];
  for (let pass = 0; pass < fixtures.length; pass++) {
    const rotated = fixtures.slice(pass).concat(fixtures.slice(0, pass));
    const result = rankCommandResults({ searchString: "RANK", searchMode: { source: UrlbarShared.RESULT_SOURCE.ZEN_ACTIONS } },
      rotated.map(args => command(...args)));
    Assert.deepEqual(result.map(r => r.commandId), expected, "Order is independent of provider arrival and previous learned hints");
    ok(result[0].heuristic, "Exact command takes the heuristic slot");
    ok(result.slice(1).every(r => !r.heuristic), "Other commands cannot override the ranking");
  }
});

add_task(function suggested_index_collisions_preserve_the_rank() {
  const context = { searchString: "rank" };
  const exact = command("Rank", "exact");
  const prefix = command("Rank More", "prefix");
  const word = command("Open Rank", "word");
  const history = { payload: { url: "https://example.com/" } };
  const ask = { payload: { dynamicType: "whimsy-ask" } };
  rankCommandResults(context, [word, history, prefix, ask, exact]);
  // Native suggested-index collisions can put a weaker command before exact.
  const placed = placeCommandResults(context, [ask, prefix, history, exact, word]);
  Assert.deepEqual(placed, [exact, ask, history, prefix, word],
    "Exact precedes history; remaining command slots keep the one computed order");
  Assert.deepEqual(placed.filter(r => r == history || r == ask), [ask, history],
    "Non-command relative order remains unchanged");
});

add_task(async function exclusions_and_switch_off() {
  for (const query of ["!rank", ":rank", ""]) {
    const rows = [command("Rank", "one")];
    is(rankCommandResults({ searchString: query }, rows), rows, "Special/empty mode keeps its original rows and hints");
  }
  const rows = [command("Rank", "one")];
  is(rankCommandResults({ searchString: "rank", searchMode: { source: UrlbarShared.RESULT_SOURCE.WORKSPACES } }, rows), rows, "Workspace mode retains its order");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.command-bar-ranking", false]] });
  try {
    is(rankCommandResults({ searchString: "rank" }, rows), rows, "Feature off preserves native ranking");
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function exact_before_history_and_tabs_in_real_queries() {
  const { PlacesTestUtils } = ChromeUtils.importESModule("resource://testing-common/PlacesTestUtils.sys.mjs");
  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
  const url = "https://example.com/?cmdrank-history";
  const title = "Cmdrank Cafe";
  const originalTab = gBrowser.selectedTab;
  const fixture = { label: "Cmdrank Café", commandId: "cmdrank-exact", command() {}, isAvailable: () => true, extraPayload: {} };
  const fixtures = [fixture, ...[
    ["Cmdrank Cafe Z", "cmdrank-z"],
    ["Cmdrank Cafe A", "cmdrank-a"],
    ["Open Cmdrank Cafe", "cmdrank-word"],
  ].map(([label, commandId]) => ({ label, commandId, command() {}, isAvailable: () => true, extraPayload: {} }))];
  const removeFixtures = () => {
    for (const item of fixtures) {
      const index = globalActions.indexOf(item);
      if (index >= 0) globalActions.splice(index, 1);
    }
  };
  globalActions.push(...fixtures);
  let tab;
  try {
    await PlacesTestUtils.addVisits({ uri: url, title });
    tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?cmdrank-tab");
    await SpecialPowers.spawn(tab.linkedBrowser, [title], text => { content.document.title = text; });
    await TestUtils.waitForCondition(() => tab.label == title, "Matching tab title reached the parent");
    await PlacesTestUtils.addVisits({ uri: "https://example.com/?cmdrank-tab", title });
    gBrowser.selectedTab = originalTab;
    let previous;
    for (let pass = 0; pass < 3; pass++) {
      gURLBar.searchMode = null;
      await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, value: "cmdrank cafe" });
      // Read via the public test utility rather than depend on controller internals.
      const results = [];
      for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
        results.push((await UrlbarTestUtils.getDetailsOfResultAt(window, i)).result);
      }
      const exact = results.findIndex(r => r.commandId == fixture.commandId);
      is(exact, 0, "Accent-insensitive exact command precedes every history and tab row");
      ok(results.some(r => r.payload.url == url), "Matching history is present in the same query");
      ok(results.some(r => r.type == UrlbarShared.RESULT_TYPE.TAB_SWITCH), "A matching tab is present in the same query");
      const ids = results.filter(r => r.payload.dynamicType == "zen-actions").map(r => r.commandId);
      Assert.deepEqual(ids, ["cmdrank-exact", "cmdrank-a", "cmdrank-z", "cmdrank-word"],
        "Real queries apply exact, alphabetical prefix, and word-prefix tiers");
      if (previous) Assert.deepEqual(ids, previous, "Repeated real queries retain command tie order");
      previous = ids;
      await UrlbarTestUtils.promisePopupClose(window, () => gURLBar.view.close());
    }
    // Query without accents also has a matching history row in the control query.
    removeFixtures();
    await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, value: "cmdrank" });
    const results = [];
    for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
      results.push((await UrlbarTestUtils.getDetailsOfResultAt(window, i)).result);
    }
    ok(results.some(r => r.payload.url == url), "The history fixture is offered by the real history provider");
  } finally {
    removeFixtures();
    await UrlbarTestUtils.promisePopupClose(window, () => gURLBar.view.close());
    gURLBar.searchMode = null;
    gURLBar.blur();
    if (tab) await BrowserTestUtils.removeTab(tab);
    await PlacesUtils.history.remove([url, "https://example.com/?cmdrank-tab"]);
  }
});
