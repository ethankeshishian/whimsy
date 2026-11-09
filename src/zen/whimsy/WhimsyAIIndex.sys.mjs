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
  ProvidersManager: "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
  Whimsy: "resource:///modules/whimsy/Whimsy.sys.mjs",
  WhimsyAI: "resource:///modules/whimsy/WhimsyAI.sys.mjs",
  WhimsyAIContext: "resource:///modules/whimsy/WhimsyAIContext.sys.mjs",
  WhimsyAIStore: "resource:///modules/whimsy/WhimsyAIStore.sys.mjs",
});

const RELATED_TYPE = "whimsyRelated";
const RELATED_ICON = "chrome://browser/skin/zen-icons/search-page.svg";
const MAX_RESULTS = 3;

const FOLDER_KIND = "index";
const FILE_NAME = "index.bin";
const FEATURE = "ai-related";
const MAX_ENTRIES = 20000;
const TEXT_CHARS = 2000;
const VECTOR_DIM_GUARD = 4; // Below this a "vector" is treated as unusable.

let embedder = null;
let embedderChecked = false;
let state = null; // { entries: [{url, title, vector, date}] }
let loading = null;
let testEmbedder = null;

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

function embed(text) {
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
    state = { entries: Array.isArray(saved?.entries) ? saved.entries : [] };
    loading = null;
    return state;
  })();
  return loading;
}

async function save() {
  await lazy.WhimsyAIStore.writeFile(await path(), state);
}

export const WhimsyAIIndex = {
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
    lazy.WhimsyAIStore.registerClearer("index", async () => {
      state = { entries: [] };
      await save().catch(() => {});
    });
  },

  /** @param {{url, title, text}} page. Never for a private tab (callers check). */
  async add({ url, title = "", text = "" } = {}) {
    if (!this.on || !url) {
      return false;
    }
    const vector = embed(`${title}\n${String(text).slice(0, TEXT_CHARS)}`.trim());
    if (!vector) {
      return false;
    }
    this.init();
    const s = await load();
    s.entries = s.entries.filter(e => e.url != url);
    s.entries.push({ url, title, vector, date: Date.now() });
    if (s.entries.length > MAX_ENTRIES) {
      s.entries.splice(0, s.entries.length - MAX_ENTRIES);
    }
    await save();
    return true;
  },

  /** @returns {Promise<{url, title, score}[]>} best `k` matches, newest ties first. */
  async query(text, k = 3) {
    if (!this.on || !String(text ?? "").trim()) {
      return [];
    }
    const vector = embed(text);
    if (!vector) {
      return [];
    }
    const s = await load();
    return s.entries
      .map(e => ({ url: e.url, title: e.title, score: cosine(vector, e.vector), date: e.date }))
      .filter(e => e.score > 0)
      .sort((a, b) => b.score - a.score || b.date - a.date)
      .slice(0, k)
      .map(({ url, title, score }) => ({ url, title, score }));
  },

  async clear({ since = null } = {}) {
    this.init();
    const s = await load();
    s.entries = since == null ? [] : s.entries.filter(e => (e.date ?? 0) < since);
    await save();
  },

  async count() {
    return (await load()).entries.length;
  },

  _setTestEmbedder(fn) {
    testEmbedder = fn;
  },

  // Tests: a scratch state (the folder itself is reset through
  // WhimsyAIStore._resetForTesting).
  _resetForTesting() {
    state = null;
    loading = null;
  },

  provider: null,

  /** Registers the "Related" urlbar rows, once per session. */
  initWindow() {
    this.init();
    if (this.provider) {
      return;
    }
    const manager = lazy.ProvidersManager;
    this.provider = manager.getProvider("WhimsyRelated") ?? new WhimsyRelatedProvider();
    manager.registerProvider(this.provider);
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
    if (!win || context.searchMode || context.restrictSource || text.length < 2) {
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
    for (const [i, match] of matches.entries()) {
      addCallback(this, new lazy.UrlbarResult({
        type: UrlbarShared.RESULT_TYPE.URL,
        source: UrlbarShared.RESULT_SOURCE.HISTORY,
        // Negative: relative to the end, so word matches and the Ask row
        // (positive suggestedIndex) stay ahead of these.
        suggestedIndex: -(MAX_RESULTS - i),
        payload: {
          url: match.url,
          title: match.title || match.url,
          icon: RELATED_ICON,
          whimsyRelated: true,
        },
      }));
    }
  }
}
