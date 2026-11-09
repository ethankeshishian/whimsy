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
    Services.prefs.clearUserPref("whimsy.feature.ai-related");
  });
});

add_task(function bounded_size() {
  is(WhimsyAIIndex.MAX_ENTRIES, 20000, "The index is bounded (oldest dropped first)");
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
  ok(added.every(r => r.payload.whimsyRelated && r.payload.icon), "Tagged Related, with an icon");
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
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  try {
    const url = tab.linkedBrowser.currentURI.spec;
    await TestUtils.waitForCondition(async () => (await WhimsyAIIndex._entriesForTesting()).some(e => e.url == url),
      "A real tab, loaded to a public https page, gets captured passively once its load finishes");
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});
