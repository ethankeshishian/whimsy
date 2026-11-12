/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W24: keep adult sites out of history (owner-approved, after the Lens
// browser). The page loads normally; its visit never lands in history, the
// address bar's suggestions, Recently Closed, or Whimsy's own stores (the
// meaning index behind Related). Two on-device signals: Firefox's hashed
// list (FilterAdult), decided before the visit is written, and a page that
// labels itself (meta rating or the RTA label), whose visit is taken back
// after load. No real adult domain appears here: example.net stands in,
// through a test hash, and the labelled pages are local stand-ins.

const { WhimsyAdultHistory } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAdultHistory.sys.mjs");
const { WhimsyAIIndex } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIIndex.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { PlacesTestUtils } = ChromeUtils.importESModule("resource://testing-common/PlacesTestUtils.sys.mjs");
const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");
const { TabStateFlusher } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs");
UrlbarTestUtils.init(this);

const DIR = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "");
const url = (name, host) => `https://${host}${DIR}${name}`;
// The stand-in "adult" site (by test hash) and a plain one.
const ADULT = url("whimsy_adult_standin.html", "example.net");
const PLAIN = url("whimsy_adult_standin.html", "example.org");
// Plain hosts whose pages label themselves.
const LABELLED = url("whimsy_adult_labelled.html", "example.com");
const RTA = url("whimsy_adult_rta.html", "example.com");
const SAME_SITE = url("whimsy_adult_standin.html", "example.com");

// Every visit Places is told about while this file runs.
const visited = [];
const onVisit = events => visited.push(...events.filter(e => e.type == "page-visited").map(e => e.url));

function visitWritten(target) {
  return PlacesTestUtils.waitForNotification("page-visited", events => events.some(e => e.url == target));
}

async function load(target) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, target);
  return tab;
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.feature.adult-history", true],
    [WhimsyAdultHistory.PREF, true],
    ["browser.urlbar.suggest.quickactions", false],
  ] });
  await PlacesUtils.history.clear();
  WhimsyAdultHistory._addTestHashForTesting(WhimsyAdultHistory._md5ForTesting("example.net"));
  PlacesUtils.observers.addListener(["page-visited"], onVisit);
  registerCleanupFunction(async () => {
    PlacesUtils.observers.removeListener(["page-visited"], onVisit);
    WhimsyAdultHistory._resetForTesting();
    while (gBrowser.tabs.length > 1) {
      BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
    }
    await PlacesUtils.history.clear();
  });
});

add_task(function test_list_check() {
  ok(WhimsyAdultHistory.isAdultUrl(ADULT), "The stand-in site is on the list (test hash)");
  ok(WhimsyAdultHistory.isAdultUrl("https://www.example.net/a?b#c"), "Any page of its base domain is");
  ok(!WhimsyAdultHistory.isAdultUrl(PLAIN), "A plain site isn't");
  ok(!WhimsyAdultHistory.isAdultUrl("about:blank"), "Only web pages are checked");
  ok(!WhimsyAdultHistory.keeps(ADULT) && WhimsyAdultHistory.keeps(PLAIN), "keeps() follows the list");
});

// A list hit is decided before the visit is written: Places never hears of it.
add_task(async function test_list_visit_never_written() {
  const tab = await load(ADULT);
  is(await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.title), "Whimsy stand-in page",
    "The page itself loads normally");
  ok(!tab.linkedBrowser.browsingContext.useGlobalHistory, "The tab's load stays out of global history");
  // Places writes visits in order: once a later visit lands, an earlier one would have too.
  const plainWritten = visitWritten(PLAIN);
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, PLAIN);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PLAIN);
  await plainWritten;
  ok(tab.linkedBrowser.browsingContext.useGlobalHistory, "A plain page in the same tab is kept again");
  ok(!visited.includes(ADULT), "No visit to the adult site was ever written");
  ok(!(await PlacesUtils.history.fetch(ADULT)), "The adult page isn't in history");
  ok(await PlacesUtils.history.fetch(PLAIN), "The plain page is");
  BrowserTestUtils.removeTab(tab);

  // The address bar has nothing to suggest for it.
  await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, value: "stand-in page" });
  const urls = [];
  for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
    urls.push((await UrlbarTestUtils.getDetailsOfResultAt(window, i)).url);
  }
  await UrlbarTestUtils.promisePopupClose(window);
  ok(urls.includes(PLAIN), "The plain page is suggested");
  ok(!urls.includes(ADULT), "The adult page isn't");
});

// Recently Closed (and the Archive, a view over it) forgets a closed adult tab.
add_task(async function test_recently_closed() {
  const closedUrls = () => SessionStore.getClosedTabDataForWindow(window).flatMap(t => t.state.entries.map(e => e.url));
  for (const target of [PLAIN, ADULT]) {
    const tab = await load(target);
    await TabStateFlusher.flush(tab.linkedBrowser);
    const changed = TestUtils.topicObserved("sessionstore-closed-objects-changed");
    BrowserTestUtils.removeTab(tab);
    await changed;
  }
  await TestUtils.waitForCondition(() => !closedUrls().includes(ADULT), "The adult tab leaves Recently Closed");
  ok(closedUrls().includes(PLAIN), "The plain tab stays in Recently Closed");
  ok(!closedUrls().includes(ADULT), "The adult tab isn't there");
});

// A page that labels itself is found after load: the visit already written is removed.
add_task(async function test_labelled_pages() {
  for (const [target, label] of [[LABELLED, "meta rating"], [RTA, "RTA label"]]) {
    const written = visitWritten(target);
    const tab = await load(target);
    await written;
    ok(await SpecialPowers.spawn(tab.linkedBrowser, [], () => !!content.document.querySelector("p")),
      `${label}: the page loads normally`);
    await TestUtils.waitForCondition(async () => !(await PlacesUtils.history.fetch(target)),
      `${label}: the visit is taken back out of history`);
    ok(WhimsyAdultHistory.isAdultUrl(target), `${label}: the page is remembered for the session`);
    ok(!tab.linkedBrowser.browsingContext.useGlobalHistory, `${label}: the rest of the load stays out`);
    BrowserTestUtils.removeTab(tab);
  }
  // Only the labelled page: the rest of the site keeps its history.
  ok(!WhimsyAdultHistory.isAdultUrl(SAME_SITE), "Another page of the same site isn't affected");
  const written = visitWritten(SAME_SITE);
  const tab = await load(SAME_SITE);
  await written;
  ok(await PlacesUtils.history.fetch(SAME_SITE), "Another page of the same site is kept");
  BrowserTestUtils.removeTab(tab);
});

// The meaning index (Related) never stores an adult page, and drops one labelled later.
add_task(async function test_meaning_index() {
  const scratch = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "whimsy-adult-index");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-related", true], ["whimsy.ai.enabled", true]] });
  await WhimsyAIStore._resetForTesting(PathUtils.join(scratch, "whimsy-ai"));
  WhimsyAIIndex._resetForTesting();
  WhimsyAIIndex._setTestEmbedder(() => [1, 0, 0]);
  try {
    ok(!(await WhimsyAIIndex.add({ url: ADULT, title: "Stand-in", text: "text" })), "A listed page isn't indexed");
    ok(!(await WhimsyAIIndex.add({ url: LABELLED, title: "Stand-in", text: "text" })), "A labelled page isn't indexed");
    const later = "https://example.org/later-labelled";
    ok(await WhimsyAIIndex.add({ url: PLAIN, title: "Stand-in", text: "text" }), "A plain page is");
    ok(await WhimsyAIIndex.add({ url: later, title: "Later", text: "text" }), "A page not yet labelled is");
    await WhimsyAdultHistory.forgetLabelledPage(null, later);
    const urls = (await WhimsyAIIndex._entriesForTesting()).map(e => e.url);
    ok(urls.includes(PLAIN), "The plain page stays in the index");
    ok(!urls.includes(later), "A page labelled after it was read leaves the index");
  } finally {
    WhimsyAIIndex._setTestEmbedder(null);
    WhimsyAIIndex._resetForTesting();
    await WhimsyAIStore._resetForTesting(null);
    await IOUtils.remove(scratch, { recursive: true });
    await SpecialPowers.popPrefEnv();
  }
});

// The person's switch and the feature switch: off, history works as before.
add_task(async function test_switches_off() {
  for (const pref of [WhimsyAdultHistory.PREF, "whimsy.feature.adult-history"]) {
    await SpecialPowers.pushPrefEnv({ set: [[pref, false]] });
    try {
      ok(WhimsyAdultHistory.keeps(ADULT), `${pref} off: nothing is kept out`);
      const written = visitWritten(ADULT);
      const tab = await load(ADULT);
      await written;
      ok(await PlacesUtils.history.fetch(ADULT), `${pref} off: the visit is in history`);
      BrowserTestUtils.removeTab(tab);
      await PlacesUtils.history.remove(ADULT);
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
});

// The command (an existing icon, no default shortcut) flips the switch.
add_task(async function test_command() {
  const id = "cmd_whimsySetting-adult-history";
  const entry = WhimsyCommands.get(id);
  ok(entry, "The switch has a command");
  is(entry.icon, "chrome://browser/skin/zen-icons/settings.svg", "It uses the settings icon");
  const cmd = document.getElementById(id);
  ok(cmd, "Its <command> exists");
  cmd.doCommand();
  ok(!Services.prefs.getBoolPref(WhimsyAdultHistory.PREF), "The command turns it off");
  cmd.doCommand();
  ok(Services.prefs.getBoolPref(WhimsyAdultHistory.PREF), "And back on");
  Services.prefs.clearUserPref(WhimsyAdultHistory.PREF);
  const name = await document.l10n.formatValue("whimsy-setting-adult-history");
  is(name, "History Filter for Adult Sites", "Its name is Title Case");
});

// Settings › Privacy & Security: the card, on by default, light and dark.
add_task(async function test_settings() {
  await BrowserTestUtils.withNewTab("about:preferences#privacy", async browser => {
    const doc = browser.contentDocument;
    const checkbox = await TestUtils.waitForCondition(() => {
      const el = doc.getElementById("whimsyAdultHistory");
      return el?.checkVisibility() && el;
    }, "The switch shows in Privacy & Security");
    await doc.l10n.translateRoots();
    await TestUtils.waitForCondition(() => checkbox.label, "The switch has its label");
    is(checkbox.label, "Keep adult sites out of history", "The switch says what it does");
    ok(checkbox.checked, "On by default");
    checkbox.click();
    await TestUtils.waitForCondition(() => !Services.prefs.getBoolPref(WhimsyAdultHistory.PREF), "Unchecking turns it off");
    checkbox.click();
    await TestUtils.waitForCondition(() => Services.prefs.getBoolPref(WhimsyAdultHistory.PREF), "Checking turns it on");
    Services.prefs.clearUserPref(WhimsyAdultHistory.PREF);
    for (const dark of [false, true]) {
      await whimsySetScheme(dark);
      try {
        doc.getElementById("whimsyAdultHistoryGroup").scrollIntoView({ block: "center" });
        await whimsySettled(doc);
        await new Promise(r => browser.contentWindow.requestAnimationFrame(() => browser.contentWindow.requestAnimationFrame(r)));
        await whimsyShot(`w24-build-adult-history-settings-${dark ? "dark" : "light"}`, browser.browsingContext.currentWindowGlobal);
        ok(true, `Settings shot, ${dark ? "dark" : "light"}`);
      } finally {
        await SpecialPowers.popPrefEnv();
      }
    }
  });
});
