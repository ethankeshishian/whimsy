/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// The meaning index: a local, on-device record of pages read on this Mac
// (title + reader text), so the command bar can offer up to 3 "Related"
// rows by meaning rather than words. Vectors come from a stub embedder in
// tests (nsIWhimsyEmbedding is real hardware, macOS-only). Never indexes a
// private, hidden, or locked tab, nor a page that isn't on the public
// internet (a local or intranet address can't be told apart, here, from
// one that needs a sign-in); nothing happens with AI or the Related
// feature off; Fire clears it.

const { WhimsyAIIndex } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIIndex.sys.mjs");
const { WhimsyAIContext } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIContext.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyAIReader } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIReader.sys.mjs");
const { ProvidersManager } = ChromeUtils.importESModule("moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs");

const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_chat_article.html";

let scratch;

// A fake embedder: a short bag-of-words vector so cosine similarity does
// something meaningful without a real on-device model.
const VOCAB = ["coffee", "espresso", "python", "snake", "whimsy", "browser"];
function vectorFor(text) {
  const lower = String(text).toLowerCase();
  return VOCAB.map(w => (lower.includes(w) ? 1 : 0));
}

add_setup(async function () {
  // browser.toml's [DEFAULT] keeps Related off so other tests' pages never
  // fill the index; this file owns it.
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-related", true]] });
  scratch = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "whimsy-ai-index");
  await WhimsyAIStore._resetForTesting(PathUtils.join(scratch, "whimsy-ai"));
  WhimsyAIIndex._resetForTesting();
  WhimsyAIIndex._setTestEmbedder(vectorFor);
  registerCleanupFunction(async () => {
    WhimsyAIIndex._setTestEmbedder(null);
    WhimsyAIIndex._resetForTesting();
    await WhimsyAIStore._resetForTesting(null);
    await IOUtils.remove(scratch, { recursive: true });
    Services.prefs.setBoolPref("whimsy.ai.enabled", true);
  });
});

add_task(function bounded_size() {
  is(WhimsyAIIndex.MAX_ENTRIES, 20000, "The index is bounded (oldest dropped first)");
});

// W23 secfix2 P2-L3: a huge page title never reaches the main-thread embedder.
add_task(async function embedder_input_is_capped() {
  const seen = [];
  WhimsyAIIndex._setTestEmbedder(text => (seen.push(text.length), vectorFor(text)));
  try {
    await WhimsyAIIndex.add({ url: "https://example.com/huge-title", title: "coffee ".repeat(400000), text: "espresso ".repeat(1000) });
    ok(seen.length && seen.every(n => n <= 512 + 1 + 2000), `The embedder got at most 2,513 characters (${seen})`);
  } finally {
    WhimsyAIIndex._setTestEmbedder(vectorFor);
    WhimsyAIIndex._resetForTesting();
  }
});

add_task(async function related_after_matches_max_three() {
  await WhimsyAIIndex.clear({});
  await WhimsyAIIndex.add({ url: "https://example.com/1", title: "Espresso machines", text: "coffee espresso beans" });
  await WhimsyAIIndex.add({ url: "https://example.com/2", title: "Coffee roasting", text: "coffee beans roast" });
  await WhimsyAIIndex.add({ url: "https://example.com/3", title: "Cold brew", text: "coffee ice cold" });
  await WhimsyAIIndex.add({ url: "https://example.com/4", title: "Python snakes", text: "python snake reptile" });
  await WhimsyAIIndex.add({ url: "https://example.com/5", title: "Decaf coffee", text: "coffee decaf" });
  const results = await WhimsyAIIndex.query("coffee", 3);
  Assert.lessOrEqual(results.length, 3, "At most 3 results, even with more matches available");
  ok(results.every(r => r.score > 0), "Every result actually matched by meaning");
  ok(!results.some(r => r.url == "https://example.com/4"), "The unrelated (python) page isn't among them");

  // The urlbar provider: tagged Related, capped the same way.
  WhimsyAIIndex.initWindow(window);
  const provider = ProvidersManager.getInstanceForSap("urlbar").getProvider("WhimsyRelated");
  ok(provider, "The Related provider registers");
  const context = { searchString: "coffee", searchMode: null, restrictSource: null, isPrivate: false };
  ok(await provider.isActive(context), "Active for a plain query with AI and the index on, outside private");
  const added = [];
  await provider.startQuery(context, (p, result) => added.push(result));
  Assert.lessOrEqual(added.length, 3, "At most 3 rows");
  ok(added.every(r => r.payload.tags?.[0] == "Related" && r.payload.icon), "Tagged Related, with an icon");
  ok(added.every(r => r.suggestedIndex < 0), "Negative suggestedIndex: after word matches and the Ask row");
});

add_task(async function none_with_ai_off() {
  await WhimsyAIIndex.clear({});
  await WhimsyAIIndex.add({ url: "https://example.com/off", title: "Coffee", text: "coffee" });
  const before = await WhimsyAIIndex.count();
  Services.prefs.setBoolPref("whimsy.ai.enabled", false);
  try {
    ok(!WhimsyAIIndex.on, "The index is off when AI is off");
    is((await WhimsyAIIndex.query("coffee")).length, 0, "...query() answers nothing");
    const added = await WhimsyAIIndex.add({ url: "https://example.com/off2", title: "Coffee 2", text: "coffee" });
    is(added, false, "...and add() records nothing new");
    is(await WhimsyAIIndex.count(), before, "The count didn't change");
  } finally {
    Services.prefs.setBoolPref("whimsy.ai.enabled", true);
  }
});

add_task(async function fire_clears_index() {
  await WhimsyAIIndex.add({ url: "https://example.com/clearme", title: "Coffee", text: "coffee" });
  Assert.greater(await WhimsyAIIndex.count(), 0, "Something is indexed");
  await WhimsyAIStore.clear({ kinds: ["index"] });
  is(await WhimsyAIIndex.count(), 0, "Fire's full clear empties the index");
});

add_task(async function index_never_records_private_hidden_or_locked_tab() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?index-off-limits-check");
  const original = WhimsyAIContext.isOffLimits;
  WhimsyAIContext.isOffLimits = t => (t == tab ? "private" : original(t));
  try {
    const before = await WhimsyAIIndex.count();
    await WhimsyAIIndex._captureVisit(window, tab.linkedBrowser);
    is(await WhimsyAIIndex.count(), before, "An off-limits tab (private, hidden, or locked) is never captured");
  } finally {
    WhimsyAIContext.isOffLimits = original;
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function index_never_records_a_private_window() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    WhimsyAIIndex._initCapture(win);
    ok(!WhimsyAIIndex._captureWindows.has(win), "A private window is never even watched for capture");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function index_never_records_a_non_public_address() {
  const before = await WhimsyAIIndex.count();
  ok(!WhimsyAIReader.isPublicUrl("http://192.168.1.5/admin"), "Sanity: a local-network address isn't public");
  const fakeBrowser = { currentURI: { spec: "http://192.168.1.5/admin" }, contentTitle: "Router admin" };
  const fakeTab = {};
  const fakeWin = { gBrowser: { getTabForBrowser: () => fakeTab } };
  const original = WhimsyAIContext.isOffLimits;
  WhimsyAIContext.isOffLimits = () => false;
  try {
    await WhimsyAIIndex._captureVisit(fakeWin, fakeBrowser);
    is(await WhimsyAIIndex.count(), before,
      "A local or intranet address is never indexed (the only check this Mac has for 'needs a sign-in')");
  } finally {
    WhimsyAIContext.isOffLimits = original;
  }
});

add_task(async function captures_a_real_public_tab_visit() {
  await WhimsyAIIndex.clear({});
  WhimsyAIIndex.initWindow(window);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  try {
    const url = tab.linkedBrowser.currentURI.spec;
    await TestUtils.waitForCondition(async () => (await WhimsyAIIndex._entriesForTesting()).some(e => e.url == url),
      "A real tab, loaded to a public https page, gets captured passively once its load finishes");
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

// The listener installs once at window start regardless of the pref
// (_initCapture has no feature check); only `on` gates each visit, read
// fresh every time. So flipping the pref mid-session, same window, no
// restart, should start and stop capture immediately.
add_task(async function related_capture_starts_and_stops_live_without_restart() {
  await WhimsyAIIndex.clear({});
  WhimsyAIIndex.initWindow(window);
  const was = Services.prefs.getBoolPref("whimsy.feature.ai-related");
  const tabs = [];
  try {
    Services.prefs.setBoolPref("whimsy.feature.ai-related", false);
    // waitForStateStop: the passive listener decides whether to capture
    // inside the same STATE_STOP notification this waits for (synchronous,
    // before any awaited readTab/add work); waitForLoad alone (the default)
    // only waits for the content "load" event, which can resolve before
    // that notification fires, letting it land after the *next* pref flip
    // below and leak this page in under the wrong setting.
    let tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE + "?live-off", true, true);
    tabs.push(tab);
    await WhimsyAIIndex._captureVisit(window, tab.linkedBrowser);
    is(await WhimsyAIIndex.count(), 0, "Off when the page finishes: nothing captured");

    // No restart, no re-init: turning it on mid-session captures the very next visit.
    Services.prefs.setBoolPref("whimsy.feature.ai-related", true);
    tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE + "?live-on", true, true);
    tabs.push(tab);
    await WhimsyAIIndex._captureVisit(window, tab.linkedBrowser);
    is(await WhimsyAIIndex.count(), 1, "Turned on live: captured right away, no restart");

    // And turning it off again stops it just as fast.
    Services.prefs.setBoolPref("whimsy.feature.ai-related", false);
    tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE + "?live-off-again", true, true);
    tabs.push(tab);
    await WhimsyAIIndex._captureVisit(window, tab.linkedBrowser);
    is(await WhimsyAIIndex.count(), 1, "Turned off live: the next visit after that isn't captured either");
  } finally {
    Services.prefs.setBoolPref("whimsy.feature.ai-related", was);
    tabs.forEach(t => BrowserTestUtils.removeTab(t));
  }
});

// The real on-device model (when this Mac has it): an unrelated page must
// score under the Related cut-off and a page on the same topic over it.
add_task(async function real_model_scores_unrelated_below_cutoff() {
  WhimsyAIIndex._setTestEmbedder(null);
  try {
    const pairs = [
      ["caffeine and sleep", "Why your afternoon coffee wrecks your night"],
      ["caffeine and sleep", "How long caffeine stays in your body"],
      ["which macbook air is the lightest", "Why your afternoon coffee wrecks your night"],
      ["which macbook air is the lightest", "Python snakes: care and feeding"],
      ["caffeine and sleep", "Quarterly tax filing deadlines for freelancers"],
      ["Tell me about this article", "Whimsy test article about national housing trends"],
    ];
    const scores = pairs.map(([a, b]) => WhimsyAIIndex._similarityForTesting(a, b));
    info(`real model scores: ${JSON.stringify(pairs.map((p, i) => [p[0], p[1], scores[i]]))}`);
    if (scores.some(x => x == null)) {
      ok(true, "No on-device sentence model here; nothing to calibrate");
      return;
    }
    Assert.greaterOrEqual(scores[1], WhimsyAIIndex.MIN_SCORE, "A clearly same-topic page scores over the cut-off");
    Assert.less(Math.max(scores[2], scores[3], scores[4]), WhimsyAIIndex.MIN_SCORE, "Unrelated topics score under it");
  } finally {
    WhimsyAIIndex._setTestEmbedder(vectorFor);
  }
});
