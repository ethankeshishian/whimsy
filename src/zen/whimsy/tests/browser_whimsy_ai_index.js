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

// W30 (owner screenshot, "opencode artif"): three "Temporal Cloud" rows
// (/login/callback, /login, and a schedules page) for a query with nothing
// to do with Temporal. The stub below reproduces the real model's numbers
// (measured with Apple's sentence embedding, logged by the real-model task
// below): a query of words the model doesn't know gets a generic vector,
// and a page stored with its title and no text sits closest to it.
const HUB = [1, 0, 0, 0];
const W30_VECTORS = {
  "Temporal Cloud": [0.56, 0.83, 0, 0], // title only: 0.56 to the generic vector
  "Temporal Cloud\nWorkflows": [0.3, 0.95, 0, 0],
  "OpenCode | The AI coding agent": [0.25, 0, 0, 0.97],
  "temporal schedules": [0.56, 0.83, 0, 0], // closest to the title-only page
  "artifacts": [0.1, 0, 0.3, 0.95],
};
const W30_KNOWN = new Set(["temporal", "schedules", "artifacts", "the", "and", "how", "bread"]);
const w30Embedded = [];
function w30Vector(text) {
  w30Embedded.push(text);
  return W30_VECTORS[text] ?? HUB;
}
const W30_STORED = [
  // Stored before W30 (no `chars`): two sign-in hops and a title-only app page.
  { url: "https://cloud.temporal.io/login/callback", title: "Temporal Cloud", vector: W30_VECTORS["Temporal Cloud"], date: 1 },
  { url: "https://cloud.temporal.io/login", title: "Temporal Cloud", vector: W30_VECTORS["Temporal Cloud"], date: 2 },
  { url: "https://cloud.temporal.io/namespaces/production.a1b2/schedules/ProcessIncomingEmails", title: "Temporal Cloud", vector: W30_VECTORS["Temporal Cloud"], date: 3 },
  // Pages with real text.
  { url: "https://cloud.temporal.io/namespaces/production.a1b2/workflows", title: "Temporal Cloud", vector: W30_VECTORS["Temporal Cloud\nWorkflows"], date: 4, chars: 900 },
  { url: "https://cloud.temporal.io/namespaces/production.a1b2/workflows/run-1", title: "Temporal Cloud", vector: W30_VECTORS["Temporal Cloud\nWorkflows"], date: 5, chars: 900 },
  { url: "https://docs.temporal.io/schedules", title: "Schedules | Temporal Platform Documentation", vector: [0.2, 0.98, 0, 0], date: 6, chars: 3000 },
  { url: "https://opencode.ai/", title: "OpenCode | The AI coding agent", vector: W30_VECTORS["OpenCode | The AI coding agent"], date: 7, chars: 1200 },
];

async function w30Index() {
  const file = PathUtils.join(await WhimsyAIStore.folder("index"), "index.bin");
  await IOUtils.writeJSON(file, { entries: W30_STORED });
  WhimsyAIIndex._resetForTesting();
  WhimsyAIIndex._setTestEmbedder(w30Vector, { knows: w => W30_KNOWN.has(w) });
  return file;
}

add_task(async function related_drops_sign_in_pages_on_load() {
  const file = await w30Index();
  try {
    const urls = (await WhimsyAIIndex._entriesForTesting()).map(e => e.url);
    ok(!urls.some(u => /\/login/.test(u)), `Stored login and OAuth callback pages leave the index on load (${urls.length} left)`);
    is(urls.length, W30_STORED.length - 2, "...and nothing else does");
    const onDisk = (await WhimsyAIIndex._readFileForTesting()).map(e => e.url);
    ok(!onDisk.some(u => /\/login/.test(u)), "...on disk too");
  } finally {
    WhimsyAIIndex._setTestEmbedder(vectorFor);
    await WhimsyAIIndex.clear({});
  }
});

add_task(async function related_none_for_words_the_model_does_not_know() {
  await w30Index();
  try {
    w30Embedded.length = 0;
    const raw = W30_STORED.map(e => [e.url, cosineForTest(HUB, e.vector).toFixed(2)]);
    info(`Scores "opencode artif" would have had against each page (cut-off ${WhimsyAIIndex.MIN_SCORE}): ${JSON.stringify(raw)}`);
    Assert.greaterOrEqual(cosineForTest(HUB, W30_VECTORS["Temporal Cloud"]), WhimsyAIIndex.MIN_SCORE,
      "Sanity: the title-only page clears the cut-off for a generic vector, as in the screenshot");
    Assert.deepEqual(await WhimsyAIIndex.query("opencode artif", 3), [], "No Related rows for \"opencode artif\"");
    ok(!w30Embedded.includes("opencode artif"), "...the unknown words never even reach the embedder");
    is(WhimsyAIIndex._meaningfulTextForTesting("opencode artif"), null, "Neither word means anything to the model");
    is(WhimsyAIIndex._meaningfulTextForTesting("the and"), null, "Nor do words that say nothing");
    is(WhimsyAIIndex._meaningfulTextForTesting("opencode artifacts"), "artifacts", "Only the known words are embedded");
    Assert.deepEqual(await WhimsyAIIndex.query("op", 3), [], "Nor for a query under three characters");
  } finally {
    WhimsyAIIndex._setTestEmbedder(vectorFor);
    await WhimsyAIIndex.clear({});
  }
});

add_task(async function related_one_row_per_site_never_title_only() {
  await w30Index();
  try {
    const results = await WhimsyAIIndex.query("temporal schedules", 3);
    info(`"temporal schedules": ${JSON.stringify(results.map(r => [r.url, r.score.toFixed(2)]))}`);
    const sites = results.map(r => new URL(r.url).host);
    is(new Set(sites).size, sites.length, "At most one row per site");
    ok(results.some(r => r.url == "https://docs.temporal.io/schedules"), "The docs page about schedules is offered");
    ok(results.some(r => r.url.includes("/workflows")), "...and one Temporal Cloud page with real text");
    ok(!results.some(r => r.url.includes("/schedules/ProcessIncomingEmails")), "A stored title-only page isn't offered");
    ok(!results.some(r => /login|callback/.test(r.url)), "Nor a sign-in page");
  } finally {
    WhimsyAIIndex._setTestEmbedder(vectorFor);
    await WhimsyAIIndex.clear({});
  }
});

add_task(async function related_never_indexes_sign_in_or_empty_pages() {
  const auth = [
    ["https://cloud.temporal.io/login/callback", "Temporal Cloud"],
    ["https://cloud.temporal.io/login", "Temporal Cloud"],
    ["https://example.com/oauth2/authorize", "Example"],
    ["https://example.com/sso/start", "Example"],
    ["https://example.com/u/signin/identifier", "Example"],
    ["https://accounts.example.com/", "Example"],
    ["https://example.com/", "Sign in to GitHub · GitHub"],
    ["https://example.com/", "Log in | Example"],
  ];
  for (const [url, title] of auth) {
    ok(WhimsyAIIndex._isAuthPageForTesting(url, title), `A sign-in page: ${url} "${title}"`);
  }
  const fine = [
    ["https://example.com/blog/oauth-explained", "OAuth explained"],
    ["https://example.com/authors/jane", "Jane's posts"],
    ["https://cloud.temporal.io/namespaces/p/workflows", "Temporal Cloud"],
    ["https://example.com/", "Login Required: why sites ask"],
  ];
  for (const [url, title] of fine) {
    ok(!WhimsyAIIndex._isAuthPageForTesting(url, title), `Not a sign-in page: ${url} "${title}"`);
  }
  await WhimsyAIIndex.clear({});
  ok(!(await WhimsyAIIndex.add({ url: "https://cloud.temporal.io/login/callback", title: "Temporal Cloud", text: "coffee ".repeat(100) })),
    "add() refuses a sign-in page");

  // Capture: a page with almost no text (a login form, a redirect) isn't indexed.
  const original = { readTab: WhimsyAIReader.readTab, isOffLimits: WhimsyAIContext.isOffLimits };
  const fakeBrowser = { currentURI: Services.io.newURI("https://example.com/app/loading"), contentTitle: "Coffee app" };
  const fakeWin = { gBrowser: { getTabForBrowser: () => ({}) } };
  WhimsyAIContext.isOffLimits = () => false;
  try {
    WhimsyAIReader.readTab = async () => "Loading…";
    await WhimsyAIIndex._captureVisit(fakeWin, fakeBrowser);
    is(await WhimsyAIIndex.count(), 0, `A page under ${WhimsyAIIndex.MIN_TEXT_CHARS} characters of text isn't indexed`);
    WhimsyAIReader.readTab = async () => "Coffee beans from Ethiopia and Colombia, roasted light for espresso, ground fine, brewed hot, and served with steamed milk and sugar in small cups. ".repeat(3);
    await WhimsyAIIndex._captureVisit(fakeWin, fakeBrowser);
    is(await WhimsyAIIndex.count(), 1, "...one with real text is");
  } finally {
    WhimsyAIReader.readTab = original.readTab;
    WhimsyAIContext.isOffLimits = original.isOffLimits;
    await WhimsyAIIndex.clear({});
  }
});

// The real model, when this Mac has it: the numbers behind the stub above.
add_task(async function real_model_unknown_words_and_title_only_pages() {
  WhimsyAIIndex._setTestEmbedder(null);
  try {
    const known = ["opencode", "artif", "artifacts", "temporal", "schedules", "github"].map(w => [w, WhimsyAIIndex._knowsWordForTesting(w)]);
    info(`real word list: ${JSON.stringify(known)}`);
    const pairs = [
      ["opencode artif", "Temporal Cloud"],
      ["opencode artif", "OpenCode | The AI coding agent built for the terminal\nOpenCode is an open source AI coding agent. Install it in your terminal, IDE, or desktop app and use any model."],
      ["github", "Temporal Cloud"],
      ["temporal schedules", "Temporal Cloud"],
    ];
    info(`real model scores: ${JSON.stringify(pairs.map(([a, b]) => [a, b.slice(0, 30), WhimsyAIIndex._similarityForTesting(a, b)]))}`);
    if (known.some(([, k]) => k == null)) {
      ok(true, "No on-device word list here; nothing to check");
      return;
    }
    is(WhimsyAIIndex._knowsWordForTesting("opencode"), false, "The model doesn't know \"opencode\"");
    is(WhimsyAIIndex._knowsWordForTesting("artif"), false, "...nor a half-typed \"artif\"");
    is(WhimsyAIIndex._knowsWordForTesting("artifacts"), true, "...but knows \"artifacts\"");
    is(WhimsyAIIndex._meaningfulTextForTesting("opencode artif"), null, "So \"opencode artif\" offers no Related rows");
  } finally {
    WhimsyAIIndex._setTestEmbedder(vectorFor);
  }
});

function cosineForTest(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

// W30 (owner screenshot 2): "how much fat to eat per day", a clear question
// in plain words, showed two "HOW TO BATTLESTATION" rows (one site's thin
// /lander page and a page stored with little more than its title). The
// real model scores the title alone 0.46 for that question, on "how to"
// (logged below); the site's real guide scores 0.04. The stub keeps those
// numbers: Q is the question, T the title alone, T2 a thin page that's
// mostly its title (0.86 to T), F a real article on dietary fat.
const FAT_Q = [1, 0, 0, 0];
const FAT_T = [0.46, 0.888, 0, 0];
const FAT_T2 = [0.5, 0.7, 0.5, 0];
const FAT_F = [0.55, 0, 0.835, 0];
const FAT_KNOWN = new Set(["how", "much", "fat", "to", "eat", "per", "day"]);
function fatVector(text) {
  return {
    "how much fat to eat per day": FAT_Q,
    "HOW TO BATTLESTATION": FAT_T,
    "How much fat should you eat per day?": [0.2, 0, 0.98, 0],
  }[text] ?? (text.startsWith("HOW TO BATTLESTATION\n") ? FAT_T2 : text.startsWith("How much fat") ? FAT_F : [0, 0, 0, 1]);
}

add_task(async function related_none_for_a_question_matching_only_a_thin_title() {
  const file = PathUtils.join(await WhimsyAIStore.folder("index"), "index.bin");
  await IOUtils.writeJSON(file, { entries: [
    { url: "https://pcbattlestations.com/lander", title: "HOW TO BATTLESTATION", vector: FAT_T, date: 1 },
    { url: "https://pcbattlestations.com/how-to-battlestation/", title: "HOW TO BATTLESTATION", vector: FAT_T2, date: 2 },
  ] });
  WhimsyAIIndex._resetForTesting();
  WhimsyAIIndex._setTestEmbedder(fatVector, { knows: w => FAT_KNOWN.has(w) });
  try {
    info(`"how much fat to eat per day" vs /lander ${cosineForTest(FAT_Q, FAT_T).toFixed(2)}, vs /how-to-battlestation/ ` +
      `${cosineForTest(FAT_Q, FAT_T2).toFixed(2)}; title share of the second ${cosineForTest(FAT_T, FAT_T2).toFixed(2)} (cut-off ${WhimsyAIIndex.MIN_SCORE})`);
    Assert.greaterOrEqual(Math.min(cosineForTest(FAT_Q, FAT_T), cosineForTest(FAT_Q, FAT_T2)), WhimsyAIIndex.MIN_SCORE,
      "Sanity: both pages clear the cut-off, as in the screenshot");
    Assert.deepEqual(await WhimsyAIIndex.query("how much fat to eat per day", 3), [], "No Related rows for the fat question");

    // Capture: a page that's mostly its title isn't indexed, even with enough text.
    const original = { readTab: WhimsyAIReader.readTab, isOffLimits: WhimsyAIContext.isOffLimits };
    const fakeWin = { gBrowser: { getTabForBrowser: () => ({}) } };
    WhimsyAIContext.isOffLimits = () => false;
    WhimsyAIReader.readTab = async () => "Get started. ".repeat(20);
    try {
      await WhimsyAIIndex._captureVisit(fakeWin, { currentURI: Services.io.newURI("https://pcbattlestations.com/lander"), contentTitle: "HOW TO BATTLESTATION" });
      ok(!(await WhimsyAIIndex._entriesForTesting()).some(e => e.date > 2), "A thin landing page isn't indexed");
    } finally {
      WhimsyAIReader.readTab = original.readTab;
      WhimsyAIContext.isOffLimits = original.isOffLimits;
    }

    // A real article on the question still is offered.
    ok(await WhimsyAIIndex.add({ url: "https://example.org/dietary-fat", title: "How much fat should you eat per day?",
      text: "Dietary guidelines recommend 20 to 35 percent of daily calories from fat. ".repeat(4) }), "A real article is indexed");
    const results = await WhimsyAIIndex.query("how much fat to eat per day", 3);
    Assert.deepEqual(results.map(r => r.url), ["https://example.org/dietary-fat"], "...and it's the only Related row");
  } finally {
    WhimsyAIIndex._setTestEmbedder(vectorFor);
    await WhimsyAIIndex.clear({});
  }
});

add_task(async function real_model_question_vs_thin_title() {
  WhimsyAIIndex._setTestEmbedder(null);
  try {
    if (!WhimsyAIIndex.available()) {
      ok(true, "No on-device word list here; nothing to calibrate");
      return;
    }
    const q = "how much fat to eat per day";
    const scores = [
      ["HOW TO BATTLESTATION", WhimsyAIIndex._similarityForTesting(q, "HOW TO BATTLESTATION")],
      ["HOW TO BATTLESTATION + guide text", WhimsyAIIndex._similarityForTesting(q, "HOW TO BATTLESTATION\nBuild the PC battlestation of your dreams. Our guide covers desks, monitors, lighting, cable management, and chairs for gaming setups.")],
    ];
    info(`real model scores: ${JSON.stringify(scores)}`);
    ok(scores.every(([, x]) => x == null || x < WhimsyAIIndex.MIN_SCORE), "The question never matches a page on its title's form words");
    ok(!(await WhimsyAIIndex.add({ url: "https://pcbattlestations.com/lander", title: "HOW TO BATTLESTATION", text: "Get started. ".repeat(20), thin: true })),
      "A page that's mostly its title isn't indexed");
    ok(await WhimsyAIIndex.add({ url: "https://example.org/sourdough", title: "Sourdough bread recipe", thin: true,
      text: "Feed your starter the night before, then mix flour, water, and salt into a shaggy dough. Rest it, fold it every half hour, shape the loaf, proof it overnight in the fridge, and bake in a hot covered pot until the crust is deep brown." }),
    "A real page is");
  } finally {
    WhimsyAIIndex._setTestEmbedder(vectorFor);
    await WhimsyAIIndex.clear({});
  }
});

// W31 (aievals related-01, related-02): the sentence model lost a long
// page's topic, so the laptop review below scored 0.03 for "thin laptop
// battery life" and the recipe 0.29 for "pasta recipe for dinner", both
// under the cut-off. The text is the eval fixtures' own (laptops.html,
// recipe_en.html, as read for the index).
const LAPTOPS_TEXT = [
  "Gadget Ledger · By Priya Natarajan · 7 min read",
  "We spent three weeks with the three thin laptops people ask us about most. All three have good keyboards and all-day batteries, so the choice comes down to weight, screen size, and price.",
  "Model · Screen · Weight · Battery (our test) · Price",
  "Aero 13 · 13.6 inch · 2.7 lb (1.24 kg) · 14 h 10 min · $1,099",
  "Aero 15 · 15.3 inch · 3.3 lb (1.51 kg) · 15 h 40 min · $1,299",
  "Slate Pro · 14.2 inch · 3.4 lb (1.55 kg) · 12 h 05 min · $1,599",
  "The Aero 13 is the lightest of the three and the cheapest. Its 13.6-inch screen is the smallest, but it is bright enough for a sunny cafe table.",
  "The Aero 15 lasted longest in our battery test, more than fifteen and a half hours of mixed web browsing and video calls. It is the one to get if the screen matters more than the weight.",
  "The Slate Pro is the fastest for heavy work like video export, but it ran hot under load and is the most expensive. It has the only fan of the three.",
  "Our pick for most people is the Aero 13. Students who travel a lot will like the weight; anyone who edits video should look at the Slate Pro instead.",
].join("\n");
const RECIPE_TEXT = [
  "This pasta takes twenty minutes and uses six ingredients. It serves four people.",
  "Ingredients", "400 g spaghetti", "4 cloves of garlic, thinly sliced", "1 lemon, zest and juice", "60 ml olive oil", "50 g grated parmesan", "A handful of parsley, chopped",
  "Method",
  "Boil the spaghetti in salted water until just tender, about nine minutes. Keep a cup of the cooking water.",
  "Warm the olive oil in a wide pan over low heat and cook the garlic until it is golden, not brown. This takes about three minutes.",
  "Add the drained pasta, the lemon zest and juice, and half a cup of the cooking water. Toss until the sauce coats the pasta.",
  "Turn off the heat, add the parmesan and parsley, and toss again. Add more cooking water if it looks dry.",
  "Serve at once with black pepper. Leftovers keep for two days in the fridge.",
].join("\n");
const LAPTOPS_PAGE = `Three thin laptops compared: Aero 13, Aero 15, and Slate Pro\n${LAPTOPS_TEXT}`;
const RECIPE_PAGE = `Weeknight lemon garlic pasta\n${RECIPE_TEXT}`;

add_task(async function real_model_long_pages_keep_their_topic() {
  WhimsyAIIndex._setTestEmbedder(null);
  try {
    if (!WhimsyAIIndex.available()) {
      ok(true, "No on-device word list here; nothing to calibrate");
      return;
    }
    const laptop = "thin laptop battery life";
    const pasta = "pasta recipe for dinner";
    const scores = {
      laptopVsLaptops: WhimsyAIIndex._similarityForTesting(laptop, LAPTOPS_PAGE),
      laptopVsRecipe: WhimsyAIIndex._similarityForTesting(laptop, RECIPE_PAGE),
      pastaVsRecipe: WhimsyAIIndex._similarityForTesting(pasta, RECIPE_PAGE),
      pastaVsLaptops: WhimsyAIIndex._similarityForTesting(pasta, LAPTOPS_PAGE),
      physicsVsLaptops: WhimsyAIIndex._similarityForTesting("lattice quantum chromodynamics", LAPTOPS_PAGE),
    };
    info(`real model scores (cut-off ${WhimsyAIIndex.MIN_SCORE}): ${JSON.stringify(scores)}`);
    Assert.greaterOrEqual(scores.laptopVsLaptops, WhimsyAIIndex.MIN_SCORE, "A long laptop review scores over the cut-off for a laptop question");
    Assert.greaterOrEqual(scores.pastaVsRecipe, WhimsyAIIndex.MIN_SCORE, "...and a long recipe for a pasta one");
    Assert.less(Math.max(scores.laptopVsRecipe, scores.pastaVsLaptops, scores.physicsVsLaptops), WhimsyAIIndex.MIN_SCORE, "Off-topic pages stay under it");
  } finally {
    WhimsyAIIndex._setTestEmbedder(vectorFor);
  }
});

// The same, with stub word vectors under the real averaging: a topic's few
// words among many everyday ones still decide what a page is about (one
// vector for the whole text, the sentence model's, gave the review 0.03).
const TOPIC_WORDS = {
  laptop: 0, laptops: 0, battery: 0, batteries: 0, screen: 1, keyboards: 0, thin: 0, inch: 0, weight: 0, video: 1,
  pasta: 2, recipe: 2, spaghetti: 2, garlic: 2, lemon: 2, parmesan: 2, parsley: 2, dinner: 2, cooking: 2, ingredients: 2,
};
function stubWordVector(word) {
  if (/^\d|^(?:aero|slate|natarajan|priya|zzqxvbn)$/.test(word)) {
    return null; // Not in the word list.
  }
  const v = new Array(12).fill(0);
  if (word in TOPIC_WORDS) {
    v[TOPIC_WORDS[word]] = 1;
  } else {
    // An everyday word: one of nine shared directions, by spelling.
    v[3 + ([...word].reduce((h, c) => h * 31 + c.charCodeAt(0), 7) % 9)] = 1;
  }
  return v;
}

add_task(async function related_long_pages_keep_their_topic() {
  WhimsyAIIndex._setTestEmbedder(null);
  WhimsyAIIndex._setTestWordVectors(stubWordVector);
  try {
    await WhimsyAIIndex.clear({});
    ok(await WhimsyAIIndex.add({ url: "https://gadgetledger.example/laptops", title: "Three thin laptops compared", text: LAPTOPS_TEXT, thin: true }), "The laptop review is indexed");
    ok(await WhimsyAIIndex.add({ url: "https://cooking.example/pasta", title: "Weeknight lemon garlic pasta", text: RECIPE_TEXT, thin: true }), "...and the recipe");
    const scores = await WhimsyAIIndex._scoresForTesting("thin laptop battery life");
    info(`"thin laptop battery life": ${JSON.stringify(scores)}`);
    Assert.deepEqual((await WhimsyAIIndex.query("thin laptop battery life", 3)).map(r => r.url), ["https://gadgetledger.example/laptops"],
      "A laptop question finds the long review, and only it");
    Assert.deepEqual((await WhimsyAIIndex.query("pasta recipe for dinner", 3)).map(r => r.url), ["https://cooking.example/pasta"],
      "A pasta question finds the recipe, and only it");
    Assert.deepEqual(await WhimsyAIIndex.query("zzqxvbn", 3), [], "An unknown word finds nothing");
    ok(!(await WhimsyAIIndex.add({ url: "https://cooking.example/lander", title: "Weeknight pasta", text: "Get started with pasta. ".repeat(20), thin: true })),
      "A landing page that says little beyond its title still isn't indexed");
  } finally {
    WhimsyAIIndex._setTestWordVectors(null);
    WhimsyAIIndex._setTestEmbedder(vectorFor);
    await WhimsyAIIndex.clear({});
  }
});

// Vectors from before W31 (the sentence model, another length) mean nothing
// next to a word mean: they leave the index at the first query.
add_task(async function related_drops_vectors_from_the_old_model() {
  const file = PathUtils.join(await WhimsyAIStore.folder("index"), "index.bin");
  await IOUtils.writeJSON(file, { entries: [
    { url: "https://old.example/coffee", title: "Coffee", vector: new Array(512).fill(0.1), date: 1, chars: 900 },
    { url: "https://new.example/coffee", title: "Coffee", vector: vectorFor("coffee"), date: 2, chars: 900 },
  ] });
  WhimsyAIIndex._resetForTesting();
  try {
    Assert.deepEqual((await WhimsyAIIndex.query("coffee", 3)).map(r => r.url), ["https://new.example/coffee"], "Only the comparable entry answers");
    Assert.deepEqual((await WhimsyAIIndex._readFileForTesting()).map(e => e.url), ["https://new.example/coffee"], "...and the old one is gone from disk");
  } finally {
    await WhimsyAIIndex.clear({});
  }
});

// W32 perf: a finished page load is read, then embedded in idle time; the
// load itself never runs the embedder.
add_task(async function w32_capture_embeds_in_idle_time_not_during_the_load() {
  await WhimsyAIIndex.clear({});
  const original = { readTab: WhimsyAIReader.readTab, isOffLimits: WhimsyAIContext.isOffLimits };
  const fakeBrowser = { currentURI: Services.io.newURI("https://example.com/w32/idle"), contentTitle: "Coffee notes" };
  const fakeWin = { gBrowser: { getTabForBrowser: () => ({}) } };
  const waiting = [];
  let embeds = 0;
  WhimsyAIContext.isOffLimits = () => false;
  WhimsyAIReader.readTab = async () => "Coffee beans from Ethiopia and Colombia, roasted light for espresso, ground fine, brewed hot, and served with steamed milk and sugar in small cups. ".repeat(3);
  WhimsyAIIndex._setTestEmbedder(text => (embeds++, vectorFor(text)));
  WhimsyAIIndex._setIdleSchedulerForTesting(() => new Promise(resolve => waiting.push(resolve)));
  try {
    const captured = WhimsyAIIndex._captureVisit(fakeWin, fakeBrowser);
    await TestUtils.waitForCondition(() => waiting.length, "The capture asks for idle time");
    is(embeds, 0, "Nothing is embedded until the browser is idle");
    is(await WhimsyAIIndex.count(), 0, "...and nothing is indexed yet");
    WhimsyAIIndex._setIdleSchedulerForTesting(async () => ({ didTimeout: false, timeRemaining: () => 50 }));
    waiting.shift()({ didTimeout: false, timeRemaining: () => 50 });
    ok(await captured, "Once idle, the page is added");
    is(embeds, 1, "...embedded once");
    is(await WhimsyAIIndex.count(), 1, "...and indexed");
  } finally {
    WhimsyAIIndex._setIdleSchedulerForTesting(null);
    WhimsyAIIndex._setTestEmbedder(vectorFor);
    WhimsyAIReader.readTab = original.readTab;
    WhimsyAIContext.isOffLimits = original.isOffLimits;
    await WhimsyAIIndex.clear({});
  }
});

// A clear while a captured page waits for idle time wins: it never comes back.
add_task(async function w32_a_clear_drops_pages_waiting_for_idle_time() {
  await WhimsyAIIndex.clear({});
  const original = { readTab: WhimsyAIReader.readTab, isOffLimits: WhimsyAIContext.isOffLimits };
  const fakeBrowser = { currentURI: Services.io.newURI("https://example.com/w32/cleared"), contentTitle: "Coffee notes" };
  const fakeWin = { gBrowser: { getTabForBrowser: () => ({}) } };
  const waiting = [];
  WhimsyAIContext.isOffLimits = () => false;
  WhimsyAIReader.readTab = async () => "Coffee beans from Ethiopia and Colombia, roasted light for espresso, ground fine, brewed hot, and served with steamed milk and sugar in small cups. ".repeat(3);
  WhimsyAIIndex._setIdleSchedulerForTesting(() => new Promise(resolve => waiting.push(resolve)));
  try {
    const captured = WhimsyAIIndex._captureVisit(fakeWin, fakeBrowser);
    await TestUtils.waitForCondition(() => waiting.length, "The capture asks for idle time");
    await WhimsyAIStore.clear({ kinds: ["index"] });
    waiting.shift()({ didTimeout: false, timeRemaining: () => 50 });
    ok(!(await captured), "A page read before Fire isn't added after it");
    is(await WhimsyAIIndex.count(), 0, "...the index stays empty");
  } finally {
    WhimsyAIIndex._setIdleSchedulerForTesting(null);
    WhimsyAIReader.readTab = original.readTab;
    WhimsyAIContext.isOffLimits = original.isOffLimits;
    await WhimsyAIIndex.clear({});
  }
});

// The idle embedder is the same arithmetic as the direct one, word for word,
// however often it stops for idle time.
add_task(async function w32_idle_embedding_gives_the_same_vectors() {
  WhimsyAIIndex._setTestEmbedder(null);
  WhimsyAIIndex._setTestWordVectors(stubWordVector);
  try {
    let yields = 0;
    const everyWord = { spent: () => true, next: async () => { yields++; } };
    for (const text of [LAPTOPS_TEXT, RECIPE_TEXT, "thin laptop battery life", "pasta recipe for dinner"]) {
      // A fresh word list each time, so the idle path also works out the center.
      WhimsyAIIndex._setTestWordVectors(stubWordVector);
      const idle = await WhimsyAIIndex._embedIdleForTesting(text, everyWord);
      const direct = WhimsyAIIndex._embedForTesting(text);
      ok(direct?.length, `"${text.slice(0, 24)}…" embeds`);
      Assert.deepEqual(idle, direct, "...to the very same vector in idle slices");
    }
    Assert.greater(yields, 100, "The idle path stopped between words");
  } finally {
    WhimsyAIIndex._setTestWordVectors(null);
    WhimsyAIIndex._setTestEmbedder(vectorFor);
  }
});

// Adds are written together, not one file write per page.
add_task(async function w32_saves_are_batched() {
  await WhimsyAIIndex.clear({});
  try {
    is((await WhimsyAIIndex._readFileForTesting()).length, 0, "A clear writes at once");
    for (const name of ["coffee", "espresso", "python"]) {
      ok(await WhimsyAIIndex.add({ url: `https://example.com/w32/${name}`, title: name, text: name }), `${name} added`);
    }
    is((await WhimsyAIIndex._readFileForTesting()).length, 0, "Three adds: nothing written yet");
    ok(WhimsyAIIndex._savePendingForTesting, "...a save is waiting");
    await WhimsyAIIndex.flush();
    is((await WhimsyAIIndex._readFileForTesting()).length, 3, "One flush writes all three");
    ok(!WhimsyAIIndex._savePendingForTesting, "...and nothing waits after it");

    WhimsyAIIndex._setSaveDelayForTesting(50);
    ok(await WhimsyAIIndex.add({ url: "https://example.com/w32/snake", title: "snake", text: "snake" }), "A fourth add");
    await TestUtils.waitForCondition(async () => (await WhimsyAIIndex._readFileForTesting()).length == 4,
      "...is written by itself once the save delay passes");
  } finally {
    WhimsyAIIndex._setSaveDelayForTesting(null);
    await WhimsyAIIndex.clear({});
  }
});

// What's added survives a restart: the shutdown blocker writes it.
add_task(async function w32_index_survives_a_restart() {
  const { AsyncShutdown } = ChromeUtils.importESModule("resource://gre/modules/AsyncShutdown.sys.mjs");
  await WhimsyAIIndex.clear({});
  try {
    ok(AsyncShutdown.profileBeforeChange.removeBlocker(WhimsyAIIndex._saveAtShutdown), "The index has a shutdown blocker");
    AsyncShutdown.profileBeforeChange.addBlocker("WhimsyAIIndex: save the Related index", WhimsyAIIndex._saveAtShutdown);
    ok(await WhimsyAIIndex.add({ url: "https://example.com/w32/kept", title: "Coffee", text: "coffee espresso" }), "A page added");
    is((await WhimsyAIIndex._readFileForTesting()).length, 0, "...not on disk yet");
    await WhimsyAIIndex._saveAtShutdown();
    WhimsyAIIndex._resetForTesting(); // As at the next start: nothing in memory.
    Assert.deepEqual((await WhimsyAIIndex._entriesForTesting()).map(e => e.url), ["https://example.com/w32/kept"],
      "After the shutdown save and a restart, the page is still there");
    Assert.deepEqual((await WhimsyAIIndex.query("coffee", 3)).map(r => r.url), ["https://example.com/w32/kept"], "...and answers");
  } finally {
    await WhimsyAIIndex.clear({});
  }
});

// The JSON index older builds wrote is read, then rewritten in the binary
// format, with the same entries and the same answers.
add_task(async function w32_the_old_index_file_migrates() {
  const file = PathUtils.join(await WhimsyAIStore.folder("index"), "index.bin");
  const old = [
    { url: "https://example.com/w32/coffee", title: "Coffee", vector: [0.1, 1 / 3, 0, Math.PI, 0, 1e-12], date: 1, chars: 900 },
    { url: "https://example.com/w32/espresso", title: "Espresso", vector: [0.7, 0.2, 0, 0, 0, 0.5], date: 2, chars: 1200 },
    { url: "https://example.com/w32/python", title: "Python", vector: vectorFor("python"), date: 3, chars: 600 },
  ];
  await IOUtils.writeJSON(file, { entries: old });
  WhimsyAIIndex._resetForTesting();
  try {
    const before = await WhimsyAIIndex._scoresForTesting("coffee espresso");
    is(await WhimsyAIIndex.count(), 3, "The old file loads");
    const bytes = await IOUtils.read(file);
    is(new TextDecoder().decode(bytes.subarray(0, 4)), "WAIX", "...and is rewritten in the new format at once");
    Assert.deepEqual(await WhimsyAIIndex._readFileForTesting(), old.map(({ vector, ...rest }) => ({ ...rest, vector })),
      "...with every entry and every vector bit for bit");
    WhimsyAIIndex._resetForTesting();
    Assert.deepEqual(await WhimsyAIIndex._scoresForTesting("coffee espresso"), before, "Read back from the new file, the scores are the same");
  } finally {
    await WhimsyAIIndex.clear({});
  }
});
