/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W24 emoji: the shared emoji index behind both the space icon picker
// (WhimsySpaces.initEmojiSearch, whimsy.feature.emoji-search) and the
// command bar's ":" emoji surface (WhimsyEmoji.sys.mjs). Both read the same
// data: Zen's own per-emoji tags (ZenEmojisData, loaded the way
// ZenEmojiPicker.mjs does) plus a small seed of CLDR-style annotations —
// the short name ("party popper") and a few extra keyword synonyms CLDR's
// emoji annotations carry that Zen's tags don't. The seed only covers the
// emoji Whimsy's own UI names or ranks explicitly; everything else still
// searches and matches fine on Zen's tags alone, just without a pretty name
// (it falls back to its first tag).

// prettier-ignore
const CLDR_ANNOTATIONS = {
  "😀": { name: "grinning face" },
  "😃": { name: "grinning face with big eyes" },
  "😄": { name: "grinning face with smiling eyes" },
  "😁": { name: "beaming face with smiling eyes" },
  "😆": { name: "grinning squinting face" },
  "🥹": { name: "face holding back tears" },
  "😅": { name: "grinning face with sweat" },
  "🤣": { name: "rolling on the floor laughing" },
  "😂": { name: "face with tears of joy" },
  "❤️": { name: "red heart" },
  "👍": { name: "thumbs up", keywords: ["approve", "yes", "good", "like"] },
  "👎": { name: "thumbs down", keywords: ["disapprove", "no", "bad", "dislike"] },
  "🙏": { name: "folded hands", keywords: ["pray", "please", "thanks"] },
  "✅": { name: "check mark button", keywords: ["done", "yes", "correct"] },
  "👀": { name: "eyes", keywords: ["look", "watching", "see"] },
  "🔥": { name: "fire", keywords: ["lit", "hot", "flame"] },
  "🎉": { name: "party popper", keywords: ["congrats", "congratulations", "yay"] },
  "🥳": { name: "partying face", keywords: ["celebrate", "congrats", "party"] },
  "🎊": { name: "confetti ball", keywords: ["party", "celebrate"] },
  "🪅": { name: "piñata", keywords: ["party"] },
  "🎈": { name: "balloon", keywords: ["party", "birthday"] },
  "🍾": { name: "bottle with popping cork", keywords: ["champagne", "celebrate", "party"] },
  "🎂": { name: "birthday cake", keywords: ["party", "cake"] },
  "🕺": { name: "man dancing", keywords: ["party", "dance"] },
  "🚀": { name: "rocket", keywords: ["ship", "launch"] },
  // Zen tags both of these "party" (a loose keyboard-category tag, not a
  // meaning) alongside the real party emoji above. Curating their real
  // names/keywords means they rank on their own merits (tongue, silly,
  // joking) instead of tying with 🎉/🥳 on a bare "party" tag match.
  "😛": { name: "face with tongue", keywords: ["playful", "silly", "savoring"] },
  "😜": { name: "winking face with tongue", keywords: ["silly", "joking", "crazy"] },
  "🫶": { name: "heart hands" },
  "🙌": { name: "raising hands", keywords: ["celebrate", "yay"] },
  "👏": { name: "clapping hands", keywords: ["applause", "congrats"] },
  "🤙": { name: "call me hand" },
  "✌️": { name: "victory hand", keywords: ["peace"] },
  "👌": { name: "ok hand", keywords: ["okay", "perfect"] },
};

let cachedEmojis = null;

function loadZenEmojis() {
  if (cachedEmojis) {
    return cachedEmojis;
  }
  const lazy = {};
  Services.scriptloader.loadSubScript(
    "chrome://browser/content/zen-components/ZenEmojisData.min.mjs",
    lazy
  );
  /* eslint-disable mozilla/valid-lazy */
  cachedEmojis = lazy.ZenEmojisData;
  return cachedEmojis;
}

// Every word in `words` must match (the emoji's CLDR name, a curated
// keyword, or one of Zen's own tags) — the same "every word must match"
// rule WhimsySpaces.emojiMatches already uses for the picker, extended with
// the annotation seed so a query like "congrats" also finds 🎉 by its
// keyword rather than only its Zen tags.
//
// Lower is better; null means the word doesn't match at all. Curated data
// (name, then keyword) always outranks Zen's own bare tags, which are a
// grab-bag with no notion of relevance (e.g. Zen tags both 😛 and 😜
// "party", the same keyboard category as 🎉 and 🥳, not because they mean
// party). So a query like "party" puts 🎉 ("party popper") and 🥳 (curated
// with the "party" keyword) ahead of anything that only matches on a raw
// tag, tongue faces included.
function wordScore(entry, word) {
  if (entry.name?.split(/\s+/).includes(word)) {
    return 0;
  }
  if (entry.keywords?.includes(word)) {
    return 1;
  }
  for (const tag of entry.tags) {
    if (tag == word) {
      return 2;
    }
  }
  for (const tag of entry.tags) {
    if (tag.startsWith(word)) {
      return 3;
    }
  }
  if (entry.name?.includes(word)) {
    return 4;
  }
  if (entry.keywords?.some(k => k.includes(word))) {
    return 4;
  }
  for (const tag of entry.tags) {
    if (tag.includes(word)) {
      return 4;
    }
  }
  return null;
}

// A dedup key that collapses skin-tone and gender/other ZWJ variants of the
// same emoji onto one cell: the grid shows one representative (the pref's
// tone is applied at pick time, not in the grid — WhimsyEmoji.pick), not
// three near-identical 👯/👯‍♂️/👯‍♀️ cells for one search hit.
const SKIN_TONE_RE = /[\u{1F3FB}-\u{1F3FF}]/gu;
const GENDER_ZWJ_RE = /‍[♂♀]️?/gu;
const VARIATION_SELECTOR_RE = /️/gu;
function variantKey(emoji) {
  return emoji.replace(SKIN_TONE_RE, "").replace(GENDER_ZWJ_RE, "").replace(VARIATION_SELECTOR_RE, "");
}

export const WhimsyEmojiIndex = {
  CLDR_ANNOTATIONS,

  // All emoji, each with Zen's own tags kept separate from the annotation
  // seed's curated name/keywords (wordScore ranks the curated fields above
  // the bare tags; merging them the way the picker's flat tag list does
  // would lose that distinction), cached for the session.
  all() {
    return loadZenEmojis().map(emoji => {
      const extra = CLDR_ANNOTATIONS[emoji.emoji];
      return { emoji: emoji.emoji, tags: emoji.tags, keywords: extra?.keywords ?? null, order: emoji.order, name: extra?.name ?? null };
    });
  },

  // A human name for the footer: the CLDR seed's name, else the emoji's
  // first (most specific) Zen tag, else the emoji itself.
  nameOf(emoji) {
    const extra = CLDR_ANNOTATIONS[emoji];
    if (extra?.name) {
      return extra.name;
    }
    const found = loadZenEmojis().find(e => e.emoji == emoji);
    return found?.tags?.[0] ?? emoji;
  },

  // Ranked matches for a query (every word must match some name/keyword/tag
  // of the emoji). Ties break on Zen's own order. Skin-tone and gender/other
  // ZWJ variants of the same match collapse to one cell (variantKey) — the
  // best-ranked variant represents the group; WhimsyEmoji applies the
  // skin-tone pref when it's picked, not here. An empty query matches
  // nothing (the command bar shows frequent/smileys instead; see
  // WhimsyEmoji).
  search(query, { limit = 64 } = {}) {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) {
      return [];
    }
    const scored = [];
    for (const entry of this.all()) {
      let worst = 0;
      let ok = true;
      for (const word of words) {
        const score = wordScore(entry, word);
        if (score == null) {
          ok = false;
          break;
        }
        worst = Math.max(worst, score);
      }
      if (ok) {
        scored.push({ entry, worst });
      }
    }
    scored.sort((a, b) => a.worst - b.worst || a.entry.order - b.entry.order);
    const seen = new Set();
    const results = [];
    for (const { entry } of scored) {
      const key = variantKey(entry.emoji);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push(entry.emoji);
      if (results.length >= limit) {
        break;
      }
    }
    return results;
  },
};
