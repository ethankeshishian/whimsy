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
      icon: "chrome://custom/icon.png",
    },
  };
  attachSearchFavicons([customResult]);
  is(customResult.payload.icon, "chrome://custom/icon.png", "Custom icon is not overwritten");

  // URL result with missing icon for known domain
  const urlResult = {
    type: UrlbarShared.RESULT_TYPE.URL,
    payload: { url: "https://www.youtube.com/watch?v=123" },
  };
  attachSearchFavicons([urlResult]);
  is(urlResult.payload.icon, YT_FAVICON, "URL result for YouTube receives YouTube favicon when missing");
});

add_task(async function test_search_favicons_pref_switch() {
  await SpecialPowers.pushPrefEnv({ set: [[SEARCH_FAVICONS_FEATURE_PREF, false]] });
  const ytResult = {
    type: UrlbarShared.RESULT_TYPE.SEARCH,
    payload: {
      engine: "YouTube",
      icon: UrlbarShared.ICON.SEARCH_GLASS,
    },
  };
  const controller = window.gURLBar?.controller;
  if (controller) {
    WhimsyCommandBar.initResultsHook(window);
    const fakeContext = { results: [ytResult] };
    controller.receiveResults(fakeContext);
    is(ytResult.payload.icon, UrlbarShared.ICON.SEARCH_GLASS, "Pref disabled: icon remains search glass");
  }
  await SpecialPowers.popPrefEnv();
});
