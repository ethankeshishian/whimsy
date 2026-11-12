/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave6/parity: Arc's command bar dedupes results by title and host on its
// 10 hosts. W10-37: Arc's command bar displays search engine favicons on
// search results (e.g. YouTube, Google, DuckDuckGo) rather than a generic
// search glass.

const {
  dedupResults,
  DEDUP_HOSTS,
  attachSearchFavicons,
  getEngineFavicon,
  getSearchFavicon,
  KNOWN_ENGINE_FAVICONS,
  SEARCH_FAVICONS_FEATURE_PREF,
  WhimsyCommandBar,
} = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommandBar.sys.mjs");
const { UrlbarShared } = ChromeUtils.importESModule("chrome://browser/content/urlbar/UrlbarShared.mjs");

const row = (url, title, heuristic = false) => ({ payload: { url, title }, heuristic });

add_task(function test_dedup() {
  is(DEDUP_HOSTS.size, 10, "Arc's 10 hosts");
  const results = [
    row("https://www.figma.com/file/a?node=1", "Design", true),
    row("https://www.figma.com/file/a?node=1", "Design"),
    row("https://www.figma.com/file/a?node=2", "Design"),
    row("https://github.com/a/b/issues", "a/b"),
    row("https://github.com/a/b/pulls", "a/b"),
    row("https://example.com/1", "Same"),
    row("https://example.com/2", "Same"),
    row("https://figma.com/file/b", "Other"),
  ];
  const out = dedupResults(results);
  is(out[0], results[0], "The heuristic result stays");
  is(out.filter(r => r.payload.title == "Design").length, 2, "One Design row besides the heuristic");
  is(out.filter(r => r.payload.title == "a/b").length, 1, "One GitHub row per title");
  is(out.filter(r => r.payload.title == "Same").length, 2, "Other sites keep every row");
  ok(out.some(r => r.payload.title == "Other"), "Different titles stay");
  ok(dedupResults([row(null, "x"), row("not a url", "x")]).length == 2, "Rows without a URL are left alone");
});

add_task(function test_search_favicons_known_engines() {
  const YT_FAVICON = "chrome://activity-stream/content/data/content/tippytop/favicons/youtube-com.png";
  const GOOGLE_FAVICON = "chrome://activity-stream/content/data/content/tippytop/favicons/google-com.ico";
  const DDG_FAVICON = "chrome://activity-stream/content/data/content/tippytop/favicons/duckduckgo-com.ico";
  const WIKI_FAVICON = "chrome://activity-stream/content/data/content/tippytop/favicons/wikipedia-org.ico";

  // W10-37: YouTube search result gets YouTube favicon instead of search glass
  const ytResult = {
    type: UrlbarShared.RESULT_TYPE.SEARCH,
    payload: {
      engine: "YouTube",
      icon: UrlbarShared.ICON.SEARCH_GLASS,
      query: "cats",
    },
  };
  attachSearchFavicons([ytResult]);
  is(ytResult.payload.icon, YT_FAVICON, "YouTube search result receives YouTube favicon");

  // Tab-to-search result for YouTube domain
  const ttsResult = {
    type: UrlbarShared.RESULT_TYPE.SEARCH,
    payload: {
      engine: "YouTube",
      searchUrlDomainWithoutSuffix: "youtube.com",
      icon: UrlbarShared.ICON.SEARCH_GLASS,
      providesSearchMode: true,
    },
  };
  attachSearchFavicons([ttsResult]);
  is(ttsResult.payload.icon, YT_FAVICON, "Tab-to-search YouTube result receives YouTube favicon");

  // Other known engines
  const googleResult = {
    type: UrlbarShared.RESULT_TYPE.SEARCH,
    payload: { engine: "Google", query: "test" },
  };
  const ddgResult = {
    type: UrlbarShared.RESULT_TYPE.SEARCH,
    payload: { engine: "DuckDuckGo", icon: UrlbarShared.ICON.SEARCH_GLASS },
  };
  const wikiResult = {
    type: UrlbarShared.RESULT_TYPE.SEARCH,
    payload: { engine: "Wikipedia (en)" },
  };
  attachSearchFavicons([googleResult, ddgResult, wikiResult]);
  is(googleResult.payload.icon, GOOGLE_FAVICON, "Google search result receives Google favicon");
  is(ddgResult.payload.icon, DDG_FAVICON, "DuckDuckGo search result receives DDG favicon");
  is(wikiResult.payload.icon, WIKI_FAVICON, "Wikipedia search result receives Wikipedia favicon");

  // Custom icon is preserved
  const customResult = {
    type: UrlbarShared.RESULT_TYPE.SEARCH,
    payload: {
      engine: "YouTube",
      icon: "chrome://custom/icon.png", // precheck: ignore-url (never loaded)
    },
  };
  attachSearchFavicons([customResult]);
  is(customResult.payload.icon, "chrome://custom/icon.png", "Custom icon is not overwritten"); // precheck: ignore-url

  // URL result with missing icon for known domain
  const urlResult = {
    type: UrlbarShared.RESULT_TYPE.URL,
    payload: { url: "https://www.youtube.com/watch?v=123" },
  };
  attachSearchFavicons([urlResult]);
  is(urlResult.payload.icon, YT_FAVICON, "URL result for YouTube receives YouTube favicon when missing");
});

add_task(async function test_search_favicons_pref_switch() {
  // A stand-in controller, so the real address bar isn't fed a fake query.
  const controller = {
    receiveResults(context) {
      this.received = context;
    },
  };
  WhimsyCommandBar.initResultsHook({ gURLBar: { controller } });
  const ytRow = () => ({
    type: UrlbarShared.RESULT_TYPE.SEARCH,
    payload: { engine: "YouTube", icon: UrlbarShared.ICON.SEARCH_GLASS },
  });

  await SpecialPowers.pushPrefEnv({ set: [[SEARCH_FAVICONS_FEATURE_PREF, false]] });
  controller.receiveResults({ results: [ytRow()] });
  is(controller.received.results[0].payload.icon, UrlbarShared.ICON.SEARCH_GLASS, "switch off: the search glass stays");
  await SpecialPowers.popPrefEnv();

  await SpecialPowers.pushPrefEnv({ set: [[SEARCH_FAVICONS_FEATURE_PREF, true]] });
  controller.receiveResults({ results: [ytRow()] });
  is(controller.received.results[0].payload.icon, KNOWN_ENGINE_FAVICONS.get("youtube"), "switch on: YouTube's icon");
  await SpecialPowers.popPrefEnv();
});

add_task(function test_engine_names_match_whole_words() {
  is(getSearchFavicon("SearXNG"), null, "an engine merely containing a known name gets no borrowed icon");
  is(getEngineFavicon("No Such Engine"), null, "an unknown engine keeps the search glass (no page-icon guess)");
});

// W10-37 (lane): "!yt cats" in the real command bar shows YouTube's icon.
// It was page-icon:https://www.youtube.com/, which is the blank globe unless
// YouTube's home page is in history with an icon.
add_task(async function test_bang_row_shows_site_icon() {
  const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.offline-bangs", true]] });
  await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, waitForFocus: SimpleTest.waitForFocus, value: "!yt cats" });
  const details = await UrlbarTestUtils.getDetailsOfResultAt(window, 0);
  is(details.result.payload.keyword, "!yt", "the bang row is first");
  is(details.image, KNOWN_ENGINE_FAVICONS.get("youtube"), "it shows YouTube's icon");
  await UrlbarTestUtils.promisePopupClose(window, () => gURLBar.blur());
  await SpecialPowers.popPrefEnv();
});
