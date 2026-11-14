/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W27 longctx: smarter context for long pages and video transcripts. When a
// text is longer than its budget and there's a question, the text is split
// into paragraph-sized passages (a transcript line is never split, so its
// time stays with it), each is ranked against the question with the
// on-device embedder (nsIWhimsyEmbedding, as WhimsyAIIndex uses), and the
// best passages are sent in page order with "…" where text was left out.
// The start of the text (title, intro) always goes first. With no question,
// a summary request, no embedder, an embedder error, or ranking that takes
// longer than TIMEOUT_MS, the text is cut at the budget exactly as before.

// A passage closes at a blank line once it has MIN_PASSAGE characters, at
// any line once it has TARGET_PASSAGE, and before a line that would take it
// past MAX_PASSAGE. A single line longer than that is cut at sentences.
const MIN_PASSAGE = 300;
const TARGET_PASSAGE = 900;
const MAX_PASSAGE = 1600;
// The start of the text that always goes in.
const HEAD_CHARS = 1500;
const TIMEOUT_MS = 1500;
// Passages are ranked in slices, yielding between them.
const SLICE = 16;
// What the native embedder is handed is capped (as WhimsyAIIndex does).
const EMBED_CHARS = 2000;
const VECTOR_DIM_GUARD = 4;
const GAP = "\n…\n";
// "Summarize this", "tl;dr", "what's this page about": no single passage
// answers these, so they keep the start of the text.
const SUMMARY_REQUEST =
  /\b(?:summar(?:y|ies|ise|ize|ising|izing)|tl;?\s?dr|recap|sum (?:it|this|that|them) up|gist|overview|what(?:'s| is) (?:this|it|the (?:page|video|article)) about)\b/i;

let embedder = null;
let embedderChecked = false;
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

// A vector for `text`, or null when there's no model. Throws when the
// embedder does (the caller falls back).
function embed(text, svc) {
  const input = String(text ?? "").slice(0, EMBED_CHARS);
  const vector = testEmbedder ? testEmbedder(input) : svc.embed(input, locale());
  return vector && vector.length >= VECTOR_DIM_GUARD ? Array.from(vector) : null;
}

function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Where a line longer than a passage is cut: after a sentence, else a space.
function cutPoint(text, start, end) {
  const span = text.slice(start + MIN_PASSAGE, end);
  const sentence = [...span.matchAll(/[.!?]["”’)\]]*\s+/g)].pop();
  if (sentence) {
    return start + MIN_PASSAGE + sentence.index + sentence[0].length;
  }
  const space = span.lastIndexOf(" ");
  return space > 0 ? start + MIN_PASSAGE + space + 1 : end;
}

/**
 * The text as passages, [start, end) offsets that cover it in order.
 */
function passagesOf(text) {
  const out = [];
  const n = text.length;
  let start = 0;
  let at = 0;
  while (at < n) {
    const nl = text.indexOf("\n", at);
    const lineEnd = nl < 0 ? n : nl + 1;
    if (lineEnd - start > MAX_PASSAGE && at > start) {
      out.push([start, at]);
      start = at;
    }
    while (lineEnd - start > MAX_PASSAGE) {
      const cut = cutPoint(text, start, start + MAX_PASSAGE);
      out.push([start, cut]);
      start = cut;
    }
    const blank = !text.slice(at, lineEnd).trim();
    at = lineEnd;
    const size = at - start;
    if ((blank && size >= MIN_PASSAGE) || size >= TARGET_PASSAGE) {
      out.push([start, at]);
      start = at;
    }
  }
  if (start < n) {
    out.push([start, n]);
  }
  return out;
}

// The chosen passages (indexes, any order) as text, in order, "…" where
// text was left out.
function assemble(text, passages, chosen) {
  const order = [...chosen].sort((a, b) => a - b);
  let out = "";
  let prev = -1;
  for (const i of order) {
    const piece = text.slice(...passages[i]);
    if (prev >= 0 && i != prev + 1) {
      out = out.replace(/\s+$/, "") + GAP + piece.replace(/^\s+/, "");
    } else {
      out += piece;
    }
    prev = i;
  }
  if (prev < passages.length - 1) {
    out = out.replace(/\s+$/, "") + GAP.trimEnd();
  }
  return out;
}

const tick = () => new Promise(resolve => Services.tm.dispatchToMainThread(resolve));

export const WhimsyAIPassages = {
  TIMEOUT_MS,

  /** Whether `question` asks for a summary rather than something in particular. */
  isSummaryRequest(question) {
    return SUMMARY_REQUEST.test(String(question ?? ""));
  },

  /**
   * `text` fitted to `budget` characters. With a question it can't answer
   * from the start alone, the passages that best answer it (by meaning),
   * after the start of the text, in order; otherwise, and whenever ranking
   * fails or is slow, `text.slice(0, budget)` exactly as before.
   *
   * @param {string} text
   * @param {{question?: string, budget: number, timeoutMs?: number}} opts
   * @returns {Promise<string>}
   */
  async fit(text, { question = "", budget, timeoutMs = TIMEOUT_MS } = {}) {
    const value = String(text ?? "");
    const cut = value.slice(0, budget);
    const asked = String(question ?? "").trim();
    if (value.length <= budget || !asked || this.isSummaryRequest(asked)) {
      return cut;
    }
    try {
      return (await this._rank(value, asked, budget, timeoutMs)) ?? cut;
    } catch (e) {
      return cut;
    }
  },

  async _rank(text, question, budget, timeoutMs) {
    const svc = testEmbedder ? null : service();
    if (!testEmbedder && (!svc || !svc.available(locale()))) {
      return null;
    }
    const passages = passagesOf(text);
    if (passages.length < 2) {
      return null;
    }
    const started = ChromeUtils.now();
    const late = () => ChromeUtils.now() - started >= timeoutMs;
    const asked = embed(question, svc);
    if (!asked) {
      return null;
    }
    // The start always goes in: whole passages up to HEAD_CHARS, at least one.
    const chosen = new Set([0]);
    let used = passages[0][1] - passages[0][0];
    for (let i = 1; i < passages.length && passages[i][1] <= HEAD_CHARS; i++) {
      chosen.add(i);
      used += passages[i][1] - passages[i][0];
    }
    if (used + GAP.length > budget) {
      return null;
    }
    const scores = [];
    for (let i = 0; i < passages.length; i++) {
      if (late()) {
        return null;
      }
      if (!chosen.has(i)) {
        const vector = embed(text.slice(...passages[i]), svc);
        scores.push({ i, score: vector ? cosine(asked, vector) : -1 });
      }
      if (i % SLICE == SLICE - 1) {
        await tick();
      }
    }
    if (late()) {
      return null;
    }
    scores.sort((a, b) => b.score - a.score || a.i - b.i);
    // Each passage costs its length plus at most two gap markers.
    for (const { i } of scores) {
      const size = passages[i][1] - passages[i][0] + 2 * GAP.length;
      if (used + size <= budget) {
        chosen.add(i);
        used += size;
      }
    }
    return assemble(text, passages, chosen).slice(0, budget);
  },

  // Tests: the passages `text` splits into, as strings.
  _passagesForTesting(text) {
    return passagesOf(String(text)).map(([s, e]) => text.slice(s, e));
  },

  // Tests: a stand-in embedder, fn(text) => number[] (or throws).
  _setTestEmbedder(fn) {
    testEmbedder = fn;
  },
};
