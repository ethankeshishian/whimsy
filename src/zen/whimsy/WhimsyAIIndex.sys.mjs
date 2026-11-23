/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 memory-fire: a local index of what you've read, by meaning rather
// than words, so the command bar can offer "Related" results (cmd-4.1).
// Vectors come from nsIWhimsyEmbedding (Apple's NaturalLanguage framework,
// on-device, macOS only); nothing here ever reaches a network. Stored as
// one file, <profile>/whimsy-ai/index/index.bin (WhimsyAIStore, 0600),
// capped at 20,000 entries (oldest dropped first), cleared by Fire. Never
// indexes or answers for a private tab, and nothing happens with AI off.

import { UrlbarProvider } from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import { UrlbarShared } from "chrome://browser/content/urlbar/UrlbarShared.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  ProvidersManager: "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
  Whimsy: "resource:///modules/whimsy/Whimsy.sys.mjs",
  WhimsyAdultHistory: "resource:///modules/whimsy/WhimsyAdultHistory.sys.mjs",
  WhimsyAI: "resource:///modules/whimsy/WhimsyAI.sys.mjs",
  WhimsyAIContext: "resource:///modules/whimsy/WhimsyAIContext.sys.mjs",
  WhimsyAIReader: "resource:///modules/whimsy/WhimsyAIReader.sys.mjs",
  WhimsyAIStore: "resource:///modules/whimsy/WhimsyAIStore.sys.mjs",
});

// W23 secfix M4: what a signed-in page shows or carries.
const SIGNED_IN_TEXT = /\b(?:sign|log)\s?out\b|\bswitch accounts?\b/i;
const ACCOUNT_TITLE = /\b(?:inbox|my account|your account|account settings|dashboard|statements?|billing)\b|[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const AUTH_COOKIE = /sess|^sid$|auth|token|login|logged|jwt|remember|user_?id|account|^__Host-|^__Secure-/i;
// W30: a sign-in step (a login form, an OAuth or SSO hop, a callback that
// only redirects) is never "about" anything: it's never indexed, a stored
// one is dropped on load, and none is ever offered. By path segment, host,
// or title.
const AUTH_PATH = /(?:^|[\/_])(?:log[-_]?(?:in|on|out)|sign[-_]?(?:in|on|up|out)|sso|oauth2?|openid|saml2?|callback|authori[sz]e|auth|2fa|mfa)(?:$|[\/._])/i;
const AUTH_HOST = /^(?:login|logon|signin|auth|sso|accounts?|id|idp|oauth)\./i;
const AUTH_TITLE = /^\s*(?:log\s?in|sign\s?(?:in|on|up)|single sign-on|authoriz(?:e|ation)|redirecting)\s*(?:$|[|·–—:.…-])|\b(?:log|sign)\s?in (?:to|with)\b|[|·–—-]\s*(?:log\s?in|sign\s?(?:in|up))\s*$/i;
const RELATED_ICON = "chrome://browser/skin/zen-icons/search-page.svg";
const MAX_RESULTS = 3;
// Below this cosine similarity a page isn't "about" the query. Apple's
// sentence vectors score unrelated text 0.28-0.36 and same-topic text
// 0.39-0.51 (browser_whimsy_ai_index.js logs them), so > 0 alone offered a
// Related row for nearly every query; 0.45 keeps only clear matches.
const MIN_SCORE = 0.45;
// W30: the sentence model gives a word outside its vocabulary (a product
// name like "opencode", a half-typed word like "artif") no meaning: such a
// query lands on the same generic vector as gibberish, which sits closest
// to pages with little or no text (a title-only "Temporal Cloud" login
// page scored 0.56 for "opencode artif", 0.46-0.49 for "github" and
// "netflix", while the real OpenCode page scored 0.25; logged by
// browser_whimsy_ai_index.js). So a query is embedded from its known words
// only, and needs at least one that says something.
const MIN_QUERY_CHARS = 3;
const MIN_WORD_CHARS = 3;
const STOP_WORDS = new Set(["the", "and", "for", "with", "from", "that", "this", "what", "how", "why", "who", "are", "was", "you", "your"]);
// ...and a page whose reader text is this short (a login form, a redirect,
// an app shell still loading) is mostly its title, which is that same kind
// of catch-all vector: it isn't indexed. An entry stored before W30 carries
// no `chars`; one whose vector is its title's alone is skipped at query time.
const MIN_TEXT_CHARS = 200;
const TITLE_ONLY = 0.999;

const FOLDER_KIND = "index";
const FILE_NAME = "index.bin";
const FEATURE = "ai-related";
const MAX_ENTRIES = 20000;
const TEXT_CHARS = 2000;
// P2-L3: the native embedder runs on the main thread; a page title is
// capped, and so is anything else handed to it.
const TITLE_CHARS = 512;
const EMBED_CHARS = TITLE_CHARS + 1 + TEXT_CHARS;
const VECTOR_DIM_GUARD = 4; // Below this a "vector" is treated as unusable.

let embedder = null;
let embedderChecked = false;
let state = null; // { entries: [{url, title, vector, date}] }
let loading = null;
let testEmbedder = null;
let testKnows = null;

function service() {
  if (!embedderChecked) {
    embedderChecked = true;
    try {
      embedder = Cc["@whimsy/embedding;1"]?.getService(Ci.nsIWhimsyEmbedding) ?? null;
    } catch {
      embedder = null;
    }
  }
  return embedder;
}

function locale() {
  return Services.locale.appLocalesAsBCP47[0] ?? "en-US";
}

function embed(input) {
  const text = String(input ?? "").slice(0, EMBED_CHARS);
  if (testEmbedder) {
    return testEmbedder(text);
  }
  const svc = service();
  if (!svc) {
    return null;
  }
  try {
    if (!svc.available(locale())) {
      return null;
    }
    const vector = svc.embed(text, locale());
    return vector && vector.length >= VECTOR_DIM_GUARD ? Array.from(vector) : null;
  } catch {
    return null;
  }
}

// Whether the on-device word list knows `word`; with no word list for this
// language it can't tell, so every word counts.
function knows(word) {
  if (testKnows) {
    return testKnows(word);
  }
  try {
    return service()?.knowsWord(word, locale()) ?? true;
  } catch {
    return true;
  }
}

/** The words of `text` the model gives a meaning, or null when none says anything. */
function meaningfulText(text) {
  const words = (String(text ?? "").toLowerCase().match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) ?? []).filter(knows);
  return words.some(w => w.length >= MIN_WORD_CHARS && !STOP_WORDS.has(w)) ? words.join(" ") : null;
}

function isAuthPage(url, title = "") {
  if (AUTH_TITLE.test(String(title ?? ""))) {
    return true;
  }
  try {
    const uri = Services.io.newURI(String(url));
    return AUTH_HOST.test(uri.host) || AUTH_PATH.test(uri.filePath);
  } catch {
    return false;
  }
}

function siteOf(url) {
  try {
    return Services.io.newURI(String(url)).host.replace(/^www\./, "");
  } catch {
    return String(url);
  }
}

function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) {
    return 0;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function path() {
  const dir = await lazy.WhimsyAIStore.folder(FOLDER_KIND);
  return PathUtils.join(dir, FILE_NAME);
}

async function load() {
  if (state) {
    return state;
  }
  loading ??= (async () => {
    const saved = await IOUtils.readJSON(await path()).catch(() => null);
    const entries = Array.isArray(saved?.entries) ? saved.entries : [];
    state = { entries: entries.filter(e => !isAuthPage(e.url, e.title)) };
    loading = null;
    if (state.entries.length != entries.length) {
      await save().catch(() => {});
    }
    return state;
  })();
  return loading;
}

async function save() {
  await lazy.WhimsyAIStore.writeFile(await path(), state);
}

export const WhimsyAIIndex = {
  MIN_SCORE,
  MIN_TEXT_CHARS,
  FEATURE,
  MAX_ENTRIES,

  get on() {
    return lazy.Whimsy.featureEnabled(FEATURE) && lazy.WhimsyAI.enabled;
  },

  /** Whether an on-device embedding model is available on this Mac at all. */
  available() {
    return testEmbedder ? true : !!embed("x");
  },

  init() {
    // N1: Fire's range applies here too ("Last hour" clears the last hour).
    lazy.WhimsyAIStore.registerClearer("index", async ({ since = null } = {}) => {
      const s = since == null ? (state = { entries: [] }) : await load();
      s.entries = since == null ? [] : s.entries.filter(e => (e.date ?? 0) < since);
      await save().catch(() => {});
    });
  },

  /** @param {{url, title, text}} page. Never for a private tab (callers check). */
  async add({ url, title = "", text = "", date = Date.now() } = {}) {
    // W24: never an adult site's page (WhimsyAdultHistory).
    if (!this.on || !url || !lazy.WhimsyAdultHistory.keeps(url) || isAuthPage(url, title)) {
      return false;
    }
    const vector = embed(`${String(title ?? "").slice(0, TITLE_CHARS)}\n${String(text).slice(0, TEXT_CHARS)}`.trim());
    if (!vector) {
      return false;
    }
    this.init();
    const s = await load();
    s.entries = s.entries.filter(e => e.url != url);
    s.entries.push({ url, title, vector, date, chars: String(text ?? "").trim().length });
    if (s.entries.length > MAX_ENTRIES) {
      s.entries.splice(0, s.entries.length - MAX_ENTRIES);
    }
    await save();
    return true;
  },

  /** W24: drops a page (origin and path, as stored) a site labelled adult after it was read. */
  async forget(url) {
    let key = String(url ?? "");
    try {
      const uri = Services.io.newURI(key);
      key = uri.prePath + uri.filePath;
    } catch {
      // Not a URL: compare it as given.
    }
    const s = await load();
    const before = s.entries.length;
    s.entries = s.entries.filter(e => e.url != key && e.url != url);
    if (s.entries.length != before) {
      await save();
    }
  },

  /**
   * @returns {Promise<{url, title, score}[]>} best `k` matches, newest ties
   * first: one per site, never a sign-in page or a title-only entry.
   */
  async query(text, k = 3) {
    if (!this.on || String(text ?? "").trim().length < MIN_QUERY_CHARS) {
      return [];
    }
    const words = meaningfulText(text);
    const vector = words && embed(words);
    if (!vector) {
      return [];
    }
    const s = await load();
    const candidates = s.entries
      .map(e => ({ entry: e, score: cosine(vector, e.vector) }))
      .filter(c => c.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score || (b.entry.date ?? 0) - (a.entry.date ?? 0));
    const results = [];
    const sites = new Set();
    const titles = new Set();
    for (const { entry, score } of candidates) {
      if (results.length >= k) {
        break;
      }
      const site = siteOf(entry.url);
      const title = String(entry.title ?? "").trim().toLowerCase();
      if (sites.has(site) || (title && titles.has(title)) || isAuthPage(entry.url, entry.title) || this._titleOnly(entry)) {
        continue;
      }
      sites.add(site);
      if (title) {
        titles.add(title);
      }
      results.push({ url: entry.url, title: entry.title, score });
    }
    return results;
  },

  // A pre-W30 entry (no `chars`) whose vector is just its title's.
  _titleOnly(entry) {
    if (entry.chars != null) {
      return false; // Stored since W30: capture already turned away short pages.
    }
    const titleVector = embed(String(entry.title ?? "").slice(0, TITLE_CHARS).trim());
    return !titleVector || cosine(titleVector, entry.vector) >= TITLE_ONLY;
  },

  _clears: 0,

  async clear({ since = null } = {}) {
    this._clears++;
    this.init();
    const s = await load();
    s.entries = since == null ? [] : s.entries.filter(e => (e.date ?? 0) < since);
    await save();
  },

  async count() {
    return (await load()).entries.length;
  },

  // Tests: the raw entries (url/title/date, vector left out), for when a
  // stub embedder's scoring can't be trusted to rank a real capture.
  async _entriesForTesting() {
    const s = await load();
    return s.entries.map(({ url, title, date }) => ({ url, title, date }));
  },

  /** Tests: a stub embedder, and optionally a stub word list (default: every word known). */
  _setTestEmbedder(fn, { knows: knowsFn = null } = {}) {
    testEmbedder = fn;
    testKnows = fn ? (knowsFn ?? (() => true)) : null;
  },

  // Tests: what query() embeds for `text` (null: nothing to match on).
  _meaningfulTextForTesting(text) {
    return meaningfulText(text);
  },

  // Tests: whether the real word list knows `word` (null with no model).
  _knowsWordForTesting(word) {
    try {
      return service()?.knowsWord(word, locale()) ?? null;
    } catch {
      return null;
    }
  },

  _isAuthPageForTesting: isAuthPage,

  // Tests: how alike two texts are to the real (or test) embedder.
  _similarityForTesting(a, b) {
    const va = embed(a);
    const vb = embed(b);
    return va && vb ? cosine(va, vb) : null;
  },

  // Tests: a scratch state (the folder itself is reset through
  // WhimsyAIStore._resetForTesting).
  _resetForTesting() {
    state = null;
    loading = null;
  },

  provider: null,
  _captureWindows: new Set(),

  /** Registers the "Related" urlbar rows and passive capture, once per window. */
  initWindow(win) {
    this.init();
    if (!this.provider) {
      const manager = lazy.ProvidersManager.getInstanceForSap("urlbar");
      this.provider = manager.getProvider("WhimsyRelated");
      if (!this.provider) {
        this.provider = new WhimsyRelatedProvider();
        manager.registerProvider(this.provider);
      }
    }
    this._initCapture(win);
  },

  // Passive capture: a normal tab's title and reader text, once a page
  // finishes loading. Never a private window (checked once, up front, so
  // a private window's tabs are never even watched), never a private,
  // hidden, or locked tab (isOffLimits, checked per visit since a tab can
  // move spaces), and only public internet pages (never a local or
  // intranet address, which this Mac can't tell apart from one needing a
  // sign-in): WhimsyAIReader.isPublicUrl.
  _initCapture(win) {
    if (!win?.gBrowser || this._captureWindows.has(win) || lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      return;
    }
    this._captureWindows.add(win);
    const listener = {
      onStateChange: (browser, webProgress, request, flags) => {
        const done = Ci.nsIWebProgressListener.STATE_STOP | Ci.nsIWebProgressListener.STATE_IS_WINDOW;
        if ((flags & done) != done || !webProgress.isTopLevel) {
          return;
        }
        this._captureVisit(win, browser).catch(() => {});
      },
    };
    win.gBrowser.addTabsProgressListener(listener);
    win.addEventListener("unload", () => {
      win.gBrowser.removeTabsProgressListener(listener);
      this._captureWindows.delete(win);
    }, { once: true });
  },

  // Exposed (not test-only) so a test can drive one capture directly
  // without waiting on a real navigation.
  async _captureVisit(win, browser) {
    if (!this.on) {
      return;
    }
    // A clear while this page is still being read wins: the page isn't
    // added back after it.
    const cleared = this._clears;
    const tab = win.gBrowser.getTabForBrowser(browser);
    if (!tab || lazy.WhimsyAIContext.isOffLimits(tab)) {
      return;
    }
    const url = browser.currentURI?.spec ?? "";
    if (!lazy.WhimsyAIReader.isPublicUrl(url)) {
      return;
    }
    const title = browser.contentTitle || tab.label || "";
    let text = "";
    try {
      text = await lazy.WhimsyAIReader.readTab(browser, { removeBoilerplate: true });
    } catch {
      return;
    }
    // M4 (night-log rule): never a signed-in page. And never a query or
    // fragment (reset tokens, search terms, message ids): the page's address
    // is kept as origin and path only.
    const uri = browser.currentURI;
    if (String(text ?? "").trim().length < MIN_TEXT_CHARS || this._signedIn(browser, uri, title, text) || cleared != this._clears) {
      return;
    }
    await this.add({ url: uri.prePath + uri.filePath, title, text });
  },

  /**
   * Whether a page looks like it's shown to a signed-in person: an account
   * hint in the page (Sign out, an email address or Inbox in the title), or
   * a sign-in cookie for the site in the tab's container. When unsure, it
   * counts as signed in: the index skips it.
   */
  _signedIn(browser, uri, title = "", text = "") {
    if (SIGNED_IN_TEXT.test(String(text).slice(0, 200000)) || ACCOUNT_TITLE.test(title)) {
      return true;
    }
    try {
      const attrs = browser.contentPrincipal?.originAttributes ?? {};
      return Services.cookies.getCookiesFromHost(uri.host, attrs).some(c => AUTH_COOKIE.test(c.name));
    } catch {
      return true;
    }
  },
};

function topWindow() {
  return lazy.BrowserWindowTracker.getTopWindow();
}

// cmd-4.1-4.3: after word matches and the Ask row, up to 3 rows tagged
// "Related", found by meaning rather than words. Never private, never with
// AI off; a new query replaces the last one (startQuery is re-entrant per
// context, so an older answer simply loses the race).
class WhimsyRelatedProvider extends UrlbarProvider {
  get name() {
    return "WhimsyRelated";
  }

  get type() {
    return UrlbarShared.PROVIDER_TYPE.PROFILE;
  }

  async isActive(context) {
    const win = topWindow();
    const text = (context.searchString ?? "").trim();
    if (!win || context.searchMode || context.restrictSource || text.length < MIN_QUERY_CHARS) {
      return false;
    }
    if (context.isPrivate || lazy.WhimsyAIContext.isPrivate(win.gBrowser?.selectedTab)) {
      return false;
    }
    return WhimsyAIIndex.on;
  }

  async startQuery(context, addCallback) {
    const text = context.searchString.trim();
    const matches = await WhimsyAIIndex.query(text, MAX_RESULTS);
    if (!matches.length) {
      return;
    }
    // The urlbar's own tag chip, after the title (and read after it).
    const relatedTag = await new Localization(["browser/whimsy.ftl"]).formatValue("whimsy-command-related-tag");
    // All at -1: the very end, after the first (heuristic) row, word
    // matches, and the Ask row. The muxer puts each later -1 row before the
    // one already placed, so add the weakest first to read best-first.
    // (Distinct negatives would count back past a short list's heuristic.)
    for (const match of matches.toReversed()) {
      addCallback(this, new lazy.UrlbarResult({
        type: UrlbarShared.RESULT_TYPE.URL,
        source: UrlbarShared.RESULT_SOURCE.HISTORY,
        suggestedIndex: -1,
        // One (empty) highlight list per tag: the view reads them by index.
        highlights: { tags: [[]] },
        payload: {
          url: match.url,
          title: match.title || match.url,
          icon: RELATED_ICON,
          tags: [relatedTag],
        },
      }));
    }
  }
}
