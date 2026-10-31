/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave6/search: Instant result (Arc Max Instant Links: Shift+Enter on a
// search in the command bar opens the top result) and the Search Deck
// (result 1 in a Glance over the results page; the next/previous space keys
// and a swipe over the card flip; Cmd+Enter keeps the card; cards you flip
// past never reach history). A fake engine serves a local results page.

const { WhimsySearchDeck } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySearchDeck.sys.mjs");
const { extractResults, unwrapResultUrl } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySearchDeckChild.sys.mjs"
);
const { SearchTestUtils } = ChromeUtils.importESModule("resource://testing-common/SearchTestUtils.sys.mjs");
const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");
const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
const { BrowserWindowTracker } = ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");

SearchTestUtils.init(this);
UrlbarTestUtils.init(this);

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const CARD_ROOT = ROOT.replace("https://example.com", "https://example.org");
const SERP = ROOT + "whimsy_search_results.html";
const card = n => `${CARD_ROOT}whimsy_search_card.html?n=${n}`;
const INSTANT_PREF = "whimsy.feature.instant-result";
const DECK_PREF = "whimsy.feature.search-deck";

add_setup(async function () {
  await SearchTestUtils.installSearchExtension(
    { name: "Whimsy Fake Search", search_url: SERP, search_url_get_params: "q={searchTerms}" },
    { setAsDefault: true }
  );
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.urlbar.suggest.searches", false],
      [INSTANT_PREF, true],
      [DECK_PREF, true],
    ],
  });
  registerCleanupFunction(async () => {
    gURLBar.searchMode = null;
    gURLBar.value = "";
    gURLBar.blur();
    await PlacesUtils.history.clear();
  });
});

async function closeDeck() {
  const deck = WhimsySearchDeck.deckFor(window);
  if (deck?.tab.hasAttribute("zen-glance-tab")) {
    await gZenGlanceManager.closeGlance({ onTabClose: true });
  }
  await TestUtils.waitForCondition(() => !WhimsySearchDeck.deckFor(window), "Deck closed");
}

async function typeSearch(text) {
  gURLBar.focus();
  gURLBar.select();
  EventUtils.sendString(text);
  await UrlbarTestUtils.promiseSearchComplete(window);
}

function deckUrl() {
  return WhimsySearchDeck.deckFor(window)?.tab.linkedBrowser.currentURI?.spec;
}

async function waitForCard(n, message) {
  await TestUtils.waitForCondition(() => deckUrl() == card(n), message);
}

add_task(async function test_reads_results_from_the_page() {
  const results = await WhimsySearchDeck.readResults(SERP + "?q=cats");
  Assert.deepEqual(
    results.map(r => r.url),
    [card(1), card(2), card(3)],
    "Result links in order: the wrapped one unwrapped, the repeat dropped, the page's own links left out"
  );
  is(results[0].title, "Card one", "Titles come from the result heading");

  const late = await WhimsySearchDeck.readResults(SERP + "?q=cats&late=1");
  is(late.length, 3, "Results drawn after load are waited for");

  is(
    unwrapResultUrl("https://www.google.com/url?q=https%3A%2F%2Fexample.org%2Fa", "https://www.google.com/search?q=a"),
    "https://example.org/a",
    "Google's /url?q= wrapper"
  );
  is(
    unwrapResultUrl(
      "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb",
      "https://html.duckduckgo.com/html/?q=b"
    ),
    "https://example.org/b",
    "DuckDuckGo's uddg wrapper"
  );
  is(
    unwrapResultUrl("https://www.google.com/search?q=related", "https://www.google.com/search?q=a"),
    null,
    "The engine's own pages aren't results"
  );
  ok(typeof extractResults == "function", "The extractor is shared with the child");
});

add_task(async function test_shift_enter_only_takes_searches() {
  gURLBar.focus();
  gURLBar.value = "whimsy cats";
  const target = WhimsySearchDeck.instantQuery(window);
  is(target?.engine.name, "Whimsy Fake Search", "A search uses the engine Enter would");
  is(target?.query, "whimsy cats", "with the typed words");
  ok(target?.url.startsWith(SERP), "and its results page");

  gURLBar.value = "example.com/page";
  is(WhimsySearchDeck.instantQuery(window), null, "A URL keeps Firefox's Shift+Enter (new window)");

  gURLBar.value = "!w cats";
  is(WhimsySearchDeck.instantQuery(window), null, "A bang goes where the bang says");

  await SpecialPowers.pushPrefEnv({ set: [[INSTANT_PREF, false]] });
  gURLBar.value = "whimsy cats";
  is(WhimsySearchDeck.instantQuery(window), null, "Switch off: Shift+Enter is Firefox's again");
  await SpecialPowers.popPrefEnv();
  gURLBar.value = "";
  gURLBar.blur();

  const privateWin = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  privateWin.gURLBar.focus();
  privateWin.gURLBar.value = "whimsy cats";
  is(WhimsySearchDeck.instantQuery(privateWin), null, "Never in private windows");
  await BrowserTestUtils.closeWindow(privateWin);
});

add_task(async function test_instant_opens_the_top_result() {
  await SpecialPowers.pushPrefEnv({ set: [[DECK_PREF, false]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  const windows = BrowserWindowTracker.orderedWindows.length;
  await typeSearch("whimsy instant");
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, card(1));
  EventUtils.synthesizeKey("KEY_Enter", { shiftKey: true });
  await loaded;
  is(gBrowser.selectedTab, tab, "The top result opens where Enter would have");
  is(BrowserWindowTracker.orderedWindows.length, windows, "No new window (Firefox's Shift+Enter)");
  ok(
    !(await PlacesUtils.history.hasVisits(SERP + "?q=whimsy+instant")),
    "The results page was never shown, so it isn't in history"
  );
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_deck_flips_and_promotes() {
  await PlacesUtils.history.clear();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  const space = gZenWorkspaces.activeWorkspace;
  await typeSearch("whimsy deck");
  EventUtils.synthesizeKey("KEY_Enter", { shiftKey: true });
  await waitForCard(1, "Result 1 opens in a Glance");
  const deck = WhimsySearchDeck.deckFor(window);
  is(deck.parentTab, tab, "over the tab Enter would have used");
  await TestUtils.waitForCondition(
    () => tab.linkedBrowser.currentURI.spec.startsWith(SERP),
    "which shows the results page underneath"
  );
  ok(deck.tab.hasAttribute("zen-glance-tab"), "The card is a Glance");
  await TestUtils.waitForCondition(() => deck.bar, "Deck dots appear once the Glance has opened");
  is(deck.bar.querySelectorAll(".whimsy-search-deck-dot").length, 3, "One dot per result");

  // Zen's next-space command (Cmd+Opt+→) flips instead while the deck shows.
  document.getElementById("cmd_zenWorkspaceForward").doCommand();
  await waitForCard(2, "Next space key: result 2");
  is(gZenWorkspaces.activeWorkspace, space, "The space didn't change");
  is(
    deck.bar.querySelectorAll(".whimsy-search-deck-dot")[1].getAttribute("aria-current"),
    "true",
    "The second dot is current"
  );

  EventUtils.synthesizeKey("KEY_ArrowRight", { accelKey: true, altKey: true });
  await waitForCard(3, "Cmd+Opt+→: result 3");
  document.getElementById("cmd_zenWorkspaceForward").doCommand();
  is(deck.index, 2, "Past the last card it stays put");
  ok(deck.bar.querySelector(".whimsy-search-deck-next").disabled, "Next is disabled on the last card");

  // A two-finger swipe over the card (left is Firefox's "back").
  const browser = deck.tab.linkedBrowser;
  ok(WhimsySearchDeck.ownsSwipe(window, browser), "Swipes over the card belong to the deck");
  ok(!WhimsySearchDeck.ownsSwipe(window, gNavToolbox), "Swipes over the sidebar stay Zen's space swipe");
  const rect = browser.getBoundingClientRect();
  window.windowUtils.sendSimpleGestureEvent(
    "MozSwipeGesture",
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
    SimpleGestureEvent.DIRECTION_LEFT,
    0,
    0
  );
  await waitForCard(2, "Swipe back: result 2");

  // Cmd+Enter keeps the card as a real tab.
  browser.focus();
  EventUtils.synthesizeKey("KEY_Enter", { accelKey: true });
  await TestUtils.waitForCondition(() => !deck.tab.hasAttribute("zen-glance-tab"), "Cmd+Enter promotes the card");
  await TestUtils.waitForCondition(() => !WhimsySearchDeck.deckFor(window), "The deck is done");
  ok(!deck.tab.linkedBrowser.canGoBack, "The kept tab has no rejected cards in its back list");
  await TestUtils.waitForCondition(() => PlacesUtils.history.hasVisits(card(2)), "The kept card is in history");
  ok(!(await PlacesUtils.history.hasVisits(card(1))), "Card 1, flipped past, never reached history");
  ok(!(await PlacesUtils.history.hasVisits(card(3))), "Card 3, flipped past, never reached history");

  // With the deck gone, the space keys are Zen's again.
  ok(!WhimsySearchDeck.isShowing(window), "Nothing intercepts the space keys now");
  BrowserTestUtils.removeTab(deck.tab);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_deck_from_a_results_page_leaves_no_trace() {
  await PlacesUtils.history.clear();
  // Earlier tasks close real tabs on the same cards; start from an empty
  // Recently Closed list so only this deck's cards are judged.
  while (SessionStore.getClosedTabCountForWindow(window)) {
    SessionStore.forgetClosedTab(window, 0);
  }
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, SERP + "?q=whimsy+again");
  ok(WhimsySearchDeck.searchPageOf(tab.linkedBrowser), "A results page of a known engine is recognized");
  await WhimsySearchDeck.startFromPage(window);
  await waitForCard(1, "Flip Through Results opens result 1");
  document.getElementById("cmd_zenWorkspaceForward").doCommand();
  await waitForCard(2, "and flips");
  document.getElementById("cmd_zenWorkspaceBackward").doCommand();
  await waitForCard(1, "and flips back");

  await closeDeck();
  is(gBrowser.selectedTab, tab, "Closing lands on the results page");
  ok(!(await PlacesUtils.history.hasVisits(card(1))), "Rejected card 1 isn't in history");
  ok(!(await PlacesUtils.history.hasVisits(card(2))), "Rejected card 2 isn't in history");
  await TestUtils.waitForCondition(
    () =>
      !SessionStore.getClosedTabDataForWindow(window).some(item =>
        (item.state?.entries ?? []).some(entry => entry.url.startsWith(CARD_ROOT))
      ),
    "nor in Recently Closed Tabs"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_deck_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [[DECK_PREF, false]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, SERP + "?q=whimsy+off");
  await WhimsySearchDeck.startFromPage(window);
  ok(!WhimsySearchDeck.deckFor(window), "Switch off: no deck");
  ok(!tab.hasAttribute("glance-id"), "and no Glance");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
