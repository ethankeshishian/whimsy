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
//
// W32 perf: a page load never embeds or writes. A finished load is read
// (the reader actor, async) and queued; its words are embedded in idle
// slices (embedIdle, the same arithmetic as embed), and the index is saved
// at most every SAVE_DELAY_MS and at shutdown. A clear or a forget still
// writes at once. The file is binary (encode/decode below): one header, the
// entries' fields as JSON, then every vector as float64, so a save no longer
// stringifies 20,000 vectors. The JSON file older builds wrote is read once
// and rewritten in the new format.

import { UrlbarProvider } from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import { UrlbarShared } from "chrome://browser/content/urlbar/UrlbarShared.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AsyncShutdown: "resource://gre/modules/AsyncShutdown.sys.mjs",
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
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
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
// W31 (aievals): a page's vector is the mean of its words' vectors (Apple's
// word embedding), less the mean of everyday words (CENTER_WORDS), never the
// sentence model's one vector for the whole page. That model loses a long
// input's topic: a review of thin laptops, title alone 0.37 for "thin laptop
// battery life", fell steadily as its text was added, to 0.03 at 1,200
// characters (a pasta recipe: 0.29 for "pasta recipe for dinner"). Word
// means keep it (0.52, 0.61). Without the centering every text shares one
// "ordinary English" direction and unrelated pages score 0.5-0.65.
// Below this cosine similarity a page isn't "about" the query: centered
// word means score unrelated pages -0.2-0.28 and same-topic ones 0.52-0.76
// (browser_whimsy_ai_index.js logs them).
const MIN_SCORE = 0.4;
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
const STOP_WORDS = new Set(("the and for with from that this these those what how why who whom which when where are was were you your " +
  "yours our ours his her hers its their theirs they them she him not but can will just does did has have had about into over " +
  "after before than then too very also any all each few both more most other some such only own same out off once here there " +
  "been being would could should may might must shall").split(" "));
// Everyday words across topics: their mean is the direction every text
// shares, taken off each vector so only what a page is about is compared.
const CENTER_WORDS = ("weather cold windy week bought new pair running shoes meeting moved thursday afternoon team won game final " +
  "minute planted tomatoes basil garden museum opens ten morning prices electricity rose again winter train airport leaves " +
  "every twenty minutes scientists discovered species frog company announced quarterly earnings today forgot umbrella " +
  "restaurant children painted pictures families click sign account read privacy policy terms service band released third " +
  "album last spring add onions cook until soft hotel room view harbor install update restart computer election results " +
  "tonight grandmother tells best stories bridge closed repairs learn write better emails work doctor recommended sleep " +
  "exercise office near central station movie longer expected download app track orders river flooded days heavy rain " +
  "students submit essays friday recipe needs two cups flour adopted puppy shelter startup raised money investors traffic " +
  "highway library thousands old maps free shipping fifty dollars painting sold record price auction learning play guitar " +
  "phone bigger screen city plans build bike lanes subscribe newsletter weekly updates volcano erupted first time century");
// A word's vector is asked for once (bounded).
const WORD_CACHE_MAX = 20000;
// ...and a page that is mostly its title (a login form, a redirect, a
// landing page, an app shell still loading) is a catch-all keyed on the
// title's form words: "HOW TO BATTLESTATION", a thin /lander page, scored
// 0.46 for "how much fat to eat per day" (and 0.60 for "how to bake bread")
// while the site's real guide scored 0.04. So a page with under
// MIN_TEXT_CHARS of text isn't indexed, nor (W31) one whose text has under
// MIN_PAGE_WORDS meaningful words its title doesn't already say ("Get
// started" twenty times has two). An entry stored before W30 (no `chars`)
// is dropped at query time if its vector is within TITLE_HEAVY of its
// title's alone.
const MIN_TEXT_CHARS = 200;
const MIN_PAGE_WORDS = 12;
const TITLE_HEAVY = 0.75;

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
// W32: an add is saved within this long (and at shutdown), not on its own.
const SAVE_DELAY_MS = 30000;
// Pages read but not yet embedded; past this the oldest waits for its next visit.
const MAX_PENDING = 32;
// Idle slices for embedding: at most this long each, this long when the
// idle callback timed out (a browser that never idles still gets there).
const IDLE_TIMEOUT_MS = 10000;
const MAX_SLICE_MS = 40;
const FORCED_SLICE_MS = 8;
// The file: "WAIX", the format, the fields' byte length, the vector count
// (uint32 each, little-endian), the fields (UTF-8 JSON, space-padded to 8
// bytes), then the vectors (float64, little-endian, end to end).
const MAGIC = [0x57, 0x41, 0x49, 0x58];
const FORMAT = 2;
const HEADER_BYTES = 16;

let embedder = null;
let embedderChecked = false;
let state = null; // { entries: [{url, title, vector, date}] }
let loading = null;
let testEmbedder = null;
let testKnows = null;
let testWordVector = null;
let wordCache = new Map(); // word -> { vector, unit } (both null: unknown)
let saveTimer = null;
let dirty = false;
let pending = []; // [{ page, cleared, resolve }]
let draining = false;
let idleScheduler = null; // Tests: stands in for ChromeUtils.idleDispatch.
let saveDelayMs = SAVE_DELAY_MS;
let centerVector; // undefined: not yet worked out; null: none (no word list)

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

// The meaning of `input`: the mean of its words' unit vectors, less the
// everyday-words mean (see MIN_SCORE). null when no word in it is known.
function embed(input) {
  const text = String(input ?? "").slice(0, EMBED_CHARS);
  if (testEmbedder) {
    return testEmbedder(text);
  }
  const mean = wordMean(contentWords(text));
  if (!mean) {
    return null;
  }
  centerVector === undefined && (centerVector = wordMean(contentWords(CENTER_WORDS)));
  return centerVector?.length == mean.length ? mean.map((x, i) => x - centerVector[i]) : mean;
}

// What a page is embedded from: its title and text, each capped (P2-L3).
function embedInput({ title = "", text = "" }) {
  return `${String(title ?? "").slice(0, TITLE_CHARS)}\n${String(text).slice(0, TEXT_CHARS)}`.trim();
}

// One word's vector from the on-device word list, or null.
function wordVector(word) {
  return cachedWord(word).vector;
}

// One word's vector and its unit vector (the vector over its length, worked
// out once rather than at every occurrence), both null for an unknown word.
function cachedWord(word) {
  if (wordCache.has(word)) {
    return wordCache.get(word);
  }
  let vector = null;
  if (testWordVector) {
    vector = testWordVector(word) ?? null;
  } else {
    try {
      const raw = service()?.wordVector(word, locale());
      vector = raw && raw.length >= VECTOR_DIM_GUARD ? Array.from(raw) : null;
    } catch {
      vector = null;
    }
  }
  if (wordCache.size >= WORD_CACHE_MAX) {
    wordCache.clear();
  }
  const len = vector && Math.hypot(...vector);
  const entry = { vector, unit: len ? vector.map(x => x / len) : null };
  wordCache.set(word, entry);
  return entry;
}

// The words of `text` that can say what it's about (lowercase, three
// letters or more, not a stop word), in order, repeats kept.
function contentWords(text) {
  return (String(text ?? "").toLowerCase().match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) ?? [])
    .filter(w => w.length >= MIN_WORD_CHARS && !STOP_WORDS.has(w));
}

// The mean of the unit vectors of the known `words`, or null.
function wordMean(words) {
  const mean = new WordMean();
  for (const word of words) {
    mean.add(word);
  }
  return mean.result();
}

// The same, a word at a time, so embedIdle can stop between words.
class WordMean {
  sum = null;
  n = 0;

  add(word) {
    const u = cachedWord(word).unit;
    if (!u || (this.sum && u.length != this.sum.length)) {
      return;
    }
    this.sum ??= new Array(u.length).fill(0);
    for (let i = 0; i < u.length; i++) {
      this.sum[i] += u[i];
    }
    this.n++;
  }

  result() {
    return this.n ? this.sum.map(x => x / this.n) : null;
  }
}

// Idle time in slices: next() waits for an idle callback, spent() says the
// slice is used up. At least one step runs per slice.
function idleSlicer() {
  let end = 0;
  return {
    spent: () => Cu.now() >= end,
    async next() {
      const deadline = await (idleScheduler ?? (() => new Promise(resolve =>
        ChromeUtils.idleDispatch(resolve, { timeout: IDLE_TIMEOUT_MS }))))();
      end = Cu.now() + (deadline.didTimeout ? FORCED_SLICE_MS : Math.min(deadline.timeRemaining(), MAX_SLICE_MS));
    },
  };
}

async function idleWordMean(words, slicer) {
  const mean = new WordMean();
  for (const word of words) {
    if (slicer.spent()) {
      await slicer.next();
    }
    mean.add(word);
  }
  return mean.result();
}

// embed(), in idle slices between words: what a captured visit uses, so a
// page load never waits on the native word list. Same arithmetic, same vector.
async function embedIdle(input, slicer = idleSlicer()) {
  const text = String(input ?? "").slice(0, EMBED_CHARS);
  if (slicer.spent()) {
    await slicer.next();
  }
  if (testEmbedder) {
    return testEmbedder(text);
  }
  const mean = await idleWordMean(contentWords(text), slicer);
  if (!mean) {
    return null;
  }
  if (centerVector === undefined) {
    const center = await idleWordMean(contentWords(CENTER_WORDS), slicer);
    centerVector === undefined && (centerVector = center);
  }
  return centerVector?.length == mean.length ? mean.map((x, i) => x - centerVector[i]) : mean;
}

// Whether the on-device word list knows `word`; with no word list for this
// language it can't tell, so every word counts.
function knows(word) {
  if (testKnows) {
    return testKnows(word);
  }
  if (testWordVector) {
    return !!wordVector(word);
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

// Whether a page's text says little its title doesn't (MIN_PAGE_WORDS).
function thinText(title, text) {
  const titleWords = new Set(contentWords(title));
  const words = new Set(contentWords(String(text ?? "").slice(0, TEXT_CHARS)).filter(w => !titleWords.has(w)));
  let known = 0;
  for (const word of words) {
    if (knows(word) && ++known >= MIN_PAGE_WORDS) {
      return false;
    }
  }
  return true;
}

// Whether `vector` (an entry stored before W30) is mostly what the title alone says.
function titleHeavy(title, vector) {
  const titleVector = embed(String(title ?? "").slice(0, TITLE_CHARS).trim());
  return !titleVector || cosine(titleVector, vector) >= TITLE_HEAVY;
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

// The file's bytes for `entries`.
function encode(entries) {
  const fields = [];
  const lengths = [];
  let floats = 0;
  for (const { vector, ...rest } of entries) {
    fields.push(rest);
    const n = vector?.length ?? 0;
    lengths.push(n);
    floats += n;
  }
  const json = new TextEncoder().encode(JSON.stringify({ entries: fields, lengths }));
  const jsonBytes = Math.ceil(json.length / 8) * 8;
  const bytes = new Uint8Array(HEADER_BYTES + jsonBytes + floats * 8);
  bytes.set(MAGIC, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, FORMAT, true);
  view.setUint32(8, jsonBytes, true);
  view.setUint32(12, floats, true);
  bytes.set(json, HEADER_BYTES);
  bytes.fill(0x20, HEADER_BYTES + json.length, HEADER_BYTES + jsonBytes);
  const out = new Float64Array(bytes.buffer, HEADER_BYTES + jsonBytes, floats);
  let at = 0;
  for (const { vector } of entries) {
    if (vector?.length) {
      out.set(vector, at);
      at += vector.length;
    }
  }
  return bytes;
}

// The entries in a file's bytes: this format, or the JSON one before W32
// ({ entries: [{ url, title, vector, date, chars }] }). Null when neither.
function decode(bytes) {
  if (bytes.length >= HEADER_BYTES && MAGIC.every((b, i) => bytes[i] == b)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const jsonBytes = view.getUint32(8, true);
    const floats = view.getUint32(12, true);
    if (view.getUint32(4, true) != FORMAT || bytes.length != HEADER_BYTES + jsonBytes + floats * 8) {
      return null;
    }
    const { entries, lengths } = JSON.parse(new TextDecoder().decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + jsonBytes)));
    const start = HEADER_BYTES + jsonBytes;
    const all = (bytes.byteOffset + start) % 8 == 0
      ? new Float64Array(bytes.buffer, bytes.byteOffset + start, floats)
      : new Float64Array(bytes.slice(start).buffer);
    let at = 0;
    return entries.map((fields, i) => {
      const n = lengths[i] ?? 0;
      const vector = Array.from(all.subarray(at, at + n));
      at += n;
      return { ...fields, vector };
    });
  }
  const saved = JSON.parse(new TextDecoder().decode(bytes));
  return Array.isArray(saved?.entries) ? saved.entries : null;
}

async function load() {
  if (state) {
    return state;
  }
  loading ??= (async () => {
    let entries = [];
    let migrate = false;
    try {
      const bytes = await IOUtils.read(await path());
      entries = decode(bytes) ?? [];
      migrate = bytes[0] != MAGIC[0];
    } catch {
      // No index yet, or one that can't be read: start empty.
    }
    state = { entries: entries.filter(e => !isAuthPage(e.url, e.title)) };
    loading = null;
    if (migrate || state.entries.length != entries.length) {
      await save().catch(() => {});
    }
    return state;
  })();
  return loading;
}

// The index with only entries comparable to `vector`: one stored from the
// sentence model before W31 (another length) means nothing next to a word
// mean, so it's dropped, and the page is indexed again on its next visit.
async function current(vector) {
  const s = await load();
  const kept = s.entries.filter(e => e.vector?.length == vector.length);
  if (kept.length != s.entries.length) {
    s.entries = kept;
    await save().catch(() => {});
  }
  return s;
}

// Writes the index now (a clear, a forget, a migration, shutdown).
async function save() {
  cancelSave();
  if (!state) {
    return;
  }
  await lazy.WhimsyAIStore.writeBytes(await path(), encode(state.entries));
}

function cancelSave() {
  dirty = false;
  if (saveTimer) {
    lazy.clearTimeout(saveTimer);
    saveTimer = null;
  }
}

// An add: written with whatever else comes in the next SAVE_DELAY_MS.
function scheduleSave() {
  dirty = true;
  saveTimer ??= lazy.setTimeout(() => {
    saveTimer = null;
    save().catch(e => console.error("Whimsy: saving the Related index", e));
  }, saveDelayMs);
}

// A finished page load's page, read and waiting for idle time to embed.
function dropPending() {
  for (const item of pending.splice(0)) {
    item.resolve(false);
  }
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
    return testEmbedder ? true : !!embed("page");
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    // N1: Fire's range applies here too ("Last hour" clears the last hour).
    lazy.WhimsyAIStore.registerClearer("index", async ({ since = null } = {}) => {
      this._clears++;
      dropPending();
      const s = since == null ? (state = { entries: [] }) : await load();
      s.entries = since == null ? [] : s.entries.filter(e => (e.date ?? 0) < since);
      await save().catch(() => {});
    });
    // Adds since the last save are written before the profile goes away.
    try {
      lazy.AsyncShutdown.profileBeforeChange.addBlocker("WhimsyAIIndex: save the Related index", this._saveAtShutdown, {
        fetchState: () => ({ dirty, pending: pending.length }),
      });
    } catch {
      // Already shutting down: nothing new is added from here on.
    }
  },

  /** Writes any add not yet on disk; resolves once it is. */
  async flush() {
    if (dirty) {
      await save();
    }
    await lazy.WhimsyAIStore.flush();
  },

  // The shutdown blocker (one function, so a test can find it).
  _saveAtShutdown: () => WhimsyAIIndex.flush().catch(e => console.error("Whimsy: saving the Related index", e)),

  /** @param {{url, title, text}} page. Never for a private tab (callers check). */
  async add(page = {}) {
    if (!this._accepts(page)) {
      return false;
    }
    return this._insert(page, embed(embedInput(page)));
  },

  // What add() turns away before any embedding.
  _accepts({ url, title = "" } = {}) {
    // W24: never an adult site's page (WhimsyAdultHistory).
    return !!(this.on && url && lazy.WhimsyAdultHistory.keeps(url) && !isAuthPage(url, title));
  },

  async _insert({ url, title = "", text = "", date = Date.now(), thin = false }, vector) {
    if (!vector || (thin && thinText(title, text))) {
      return false;
    }
    this.init();
    const s = await load();
    s.entries = s.entries.filter(e => e.url != url);
    s.entries.push({ url, title, vector, date, chars: String(text ?? "").trim().length });
    if (s.entries.length > MAX_ENTRIES) {
      s.entries.splice(0, s.entries.length - MAX_ENTRIES);
    }
    scheduleSave();
    return true;
  },

  // A captured visit: queued, then embedded in idle time. Resolves to
  // whether it was added.
  _queue(page, cleared) {
    return new Promise(resolve => {
      const dropped = pending.filter(item => item.page.url == page.url);
      pending = pending.filter(item => item.page.url != page.url);
      dropped.forEach(item => item.resolve(false));
      pending.push({ page, cleared, resolve });
      if (pending.length > MAX_PENDING) {
        pending.shift().resolve(false);
      }
      this._drain();
    });
  },

  async _drain() {
    if (draining) {
      return;
    }
    draining = true;
    try {
      while (pending.length) {
        const item = pending.shift();
        let added = false;
        try {
          added = await this._addIdle(item);
        } catch (e) {
          console.error("Whimsy: indexing a page", e);
        }
        item.resolve(added);
      }
    } finally {
      draining = false;
    }
  },

  async _addIdle({ page, cleared }) {
    const slicer = idleSlicer();
    await slicer.next();
    if (cleared != this._clears || !this._accepts(page)) {
      return false;
    }
    const vector = await embedIdle(embedInput(page), slicer);
    if (slicer.spent()) {
      await slicer.next();
    }
    // A clear or forget while this page was being embedded wins.
    if (cleared != this._clears || !this._accepts(page)) {
      return false;
    }
    return this._insert(page, vector);
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
    for (const item of pending.filter(i => i.page.url == key || i.page.url == url)) {
      pending.splice(pending.indexOf(item), 1);
      item.resolve(false);
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
    const s = await current(vector);
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

  // A pre-W30 entry (no `chars`) whose vector is mostly its title's.
  _titleOnly(entry) {
    if (entry.chars != null) {
      return false; // Stored since W30: capture already turned away thin pages.
    }
    return titleHeavy(entry.title, entry.vector);
  },

  _clears: 0,

  async clear({ since = null } = {}) {
    this._clears++;
    dropPending();
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

  /** Tests: stub word vectors (word -> array, or null for an unknown word) under the real averaging. */
  _setTestWordVectors(fn) {
    testWordVector = fn;
    wordCache = new Map();
    centerVector = undefined;
  },

  // Tests: every stored page's cosine score for `text`, threshold ignored,
  // best first: what query() saw before MIN_SCORE and the per-site filter.
  async _scoresForTesting(text) {
    const words = meaningfulText(text);
    const vector = words && embed(words);
    if (!vector) {
      return [];
    }
    const s = await current(vector);
    return s.entries.map(e => ({ url: e.url, score: cosine(vector, e.vector) })).sort((a, b) => b.score - a.score);
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
    cancelSave();
    dropPending();
    state = null;
    loading = null;
  },

  // Tests: what's on disk now (entries as stored, vectors included).
  async _readFileForTesting() {
    return decode(await IOUtils.read(await path()));
  },

  /** Tests: idle callbacks (fn() -> Promise<IdleDeadline-like>), the save delay; null puts back the real ones. */
  _setIdleSchedulerForTesting(fn) {
    idleScheduler = fn;
  },
  _setSaveDelayForTesting(ms) {
    saveDelayMs = ms ?? SAVE_DELAY_MS;
  },
  get _savePendingForTesting() {
    return dirty;
  },

  // Tests: both embedders on the same text.
  _embedForTesting: text => embed(text),
  _embedIdleForTesting: (text, slicer) => embedIdle(text, slicer),

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
    // `thin`: a page that's mostly its title isn't kept either. Embedded
    // later, in idle time (W32): nothing here runs the word list.
    if (!this._accepts({ url: uri.prePath + uri.filePath, title })) {
      return false;
    }
    return this._queue({ url: uri.prePath + uri.filePath, title, text, date: Date.now(), thin: true }, cleared);
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
