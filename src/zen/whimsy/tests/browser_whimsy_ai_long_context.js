/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W27 longctx: a page or video transcript longer than its share, asked a
// question, keeps its start and the passages that answer the question (by
// meaning, on-device), in order, with "…" where text was left out. Short
// text, no question, a summary request, an embedder that fails, and a slow
// one all keep today's cut at the budget exactly. Vectors come from a stub
// embedder (nsIWhimsyEmbedding is macOS-only hardware), as in
// browser_whimsy_ai_index.js.

const { WhimsyAIPassages } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIPassages.sys.mjs");
const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyVideoSummary } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVideoSummary.sys.mjs");

const VOCAB = ["narwhal", "tusk", "weather", "rain", "guide"];
function vectorFor(text) {
  const lower = String(text).toLowerCase();
  // A constant last dimension, so text with none of the words still has a vector.
  return [...VOCAB.map(w => (lower.includes(w) ? 1 : 0)), 0.1];
}

const INTRO = "The Sea Guide\n\nThis guide covers animals of the cold seas, one paragraph at a time.\n\n";
const filler = n => `Paragraph ${n}. The weather at sea changes fast, and rain sweeps in over the grey water most afternoons. ${"Sailors watch the sky and the swell. ".repeat(14)}\n\n`;
const ANSWER = "The narwhal grows a single spiral tusk, which is really a long tooth that can reach three metres.\n\n";

// About 80,000 characters, the answer near the end.
function longPage() {
  let text = INTRO;
  for (let n = 1; n <= 120; n++) {
    text += n == 110 ? ANSWER : filler(n);
  }
  return text;
}

add_setup(async function () {
  WhimsyAIPassages._setTestEmbedder(vectorFor);
  registerCleanupFunction(() => WhimsyAIPassages._setTestEmbedder(null));
});

add_task(async function short_text_is_unchanged() {
  const text = "A short page about the narwhal.";
  is(await WhimsyAIPassages.fit(text, { question: "What about the narwhal?", budget: 100 }), text, "Text within the budget is sent as is");
  const page = longPage();
  is(await WhimsyAIPassages.fit(page, { budget: 6000 }), page.slice(0, 6000), "With no question, a long page is cut at the budget as before");
  is(await WhimsyAIPassages.fit(page, { question: "Summarize this page", budget: 6000 }), page.slice(0, 6000),
    "A summary request is cut at the budget as before");
  ok(WhimsyAIPassages.isSummaryRequest("tl;dr please") && !WhimsyAIPassages.isSummaryRequest("How long is the tusk?"),
    "Summary requests are told from questions");
});

add_task(async function long_text_keeps_the_passage_that_answers() {
  const page = longPage();
  const budget = 6000;
  ok(!page.slice(0, budget).includes("narwhal"), "Cutting at the budget would drop the answer");
  const fitted = await WhimsyAIPassages.fit(page, { question: "How long is the narwhal's tusk?", budget });
  Assert.lessOrEqual(fitted.length, budget, `The fitted text stays within the budget (${fitted.length})`);
  ok(fitted.startsWith("The Sea Guide\n\nThis guide covers"), "The start of the page (title, intro) always comes first");
  ok(fitted.includes(ANSWER.trim()), "The passage that answers the question is in");
  ok(fitted.includes("\n…\n"), "A marker stands where text was left out");
  const numbers = [...fitted.matchAll(/Paragraph (\d+)\./g)].map(m => Number(m[1]));
  Assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), "Passages keep the page's order");
  Assert.less(fitted.indexOf("Paragraph 1."), fitted.indexOf("narwhal"), "The answer comes after the start, where it is on the page");
});

add_task(async function fallback_when_embedder_fails_or_is_slow() {
  const page = longPage();
  const budget = 6000;
  const asked = "How long is the narwhal's tusk?";
  WhimsyAIPassages._setTestEmbedder(() => {
    throw new Error("No model");
  });
  try {
    is(await WhimsyAIPassages.fit(page, { question: asked, budget }), page.slice(0, budget), "An embedder that throws: cut at the budget");
    let calls = 0;
    WhimsyAIPassages._setTestEmbedder(text => {
      if (++calls > 3) {
        throw new Error("Failed partway");
      }
      return vectorFor(text);
    });
    is(await WhimsyAIPassages.fit(page, { question: asked, budget }), page.slice(0, budget), "One that fails partway: cut at the budget");
    WhimsyAIPassages._setTestEmbedder(() => null);
    is(await WhimsyAIPassages.fit(page, { question: asked, budget }), page.slice(0, budget), "No model for this language: cut at the budget");
  } finally {
    WhimsyAIPassages._setTestEmbedder(vectorFor);
  }
  is(WhimsyAIPassages.TIMEOUT_MS, 1500, "Ranking gives up after 1.5 s");
  is(await WhimsyAIPassages.fit(page, { question: asked, budget, timeoutMs: 0 }), page.slice(0, budget),
    "Ranking that runs past its time: cut at the budget");
});

add_task(async function transcript_times_are_kept() {
  const cues = [];
  for (let i = 0; i < 1500; i++) {
    const text = i == 1400 ? "and here the narwhal lifts its tusk out of the water" : `the weather turns and the rain keeps falling on the boat number ${i}`;
    cues.push({ start: i * 4, text });
  }
  const source = { title: "Arctic Diary", duration: 6000, cues };
  const whole = WhimsyVideoSummary.describe(source, "captions", { cap: Infinity });
  const capped = WhimsyVideoSummary.describe(source, "captions");
  Assert.greater(whole.length, capped.length, "The whole transcript is longer than what Summarize reads");
  ok(whole.includes("1:33:20 and here the narwhal"), "and holds the late line");
  ok(!capped.includes("narwhal"), "which Summarize's cut leaves out");

  const budget = 8000;
  const fitted = await WhimsyAIPassages.fit(whole, { question: "When does the narwhal show its tusk?", budget });
  Assert.lessOrEqual(fitted.length, budget, "Within the budget");
  ok(fitted.startsWith("Title: Arctic Diary"), "The video's title comes first");
  ok(fitted.includes("1:33:20 and here the narwhal lifts its tusk"), "The answering line keeps its time");
  const lines = fitted.split("\n").filter(Boolean);
  const transcript = lines.slice(lines.indexOf("Transcript (from the captions):") + 1);
  ok(transcript.length > 10, "Transcript lines are in");
  ok(transcript.every(l => l == "…" || /^\d+(?::\d\d){1,2} /.test(l)), "Every transcript line still starts with its time");
  for (const passage of WhimsyAIPassages._passagesForTesting(whole)) {
    ok(passage.endsWith("\n") || whole.endsWith(passage), "A passage never splits a transcript line");
  }
});

add_task(async function chat_fits_the_page_and_a_videos_whole_transcript() {
  const panel = WhimsyChatPanel.forWindow(window);
  const page = { url: "https://example.com/sea", title: "The Sea Guide", text: longPage() };
  const transcript = `Title: Arctic Diary\nTranscript (from the captions):\n${"0:01 the rain keeps falling on the boat\n".repeat(1500)}1:40:00 the narwhal lifts its tusk\n`;
  const video = { title: "Arctic Diary", url: "", text: transcript.slice(0, 30000), fullText: transcript };

  const plain = await panel.fitSources(page, [video], "");
  is(plain.page.text, page.text.slice(0, 60000), "No question: the page is cut at its share as before");
  is(plain.extra[0].text, video.text.slice(0, 20000), "and a source at its share, from what it held before");
  ok(!("fullText" in plain.extra[0]), "The whole transcript never reaches the prompt as is");

  const asked = await panel.fitSources(page, [video], "Where is the narwhal tusk?");
  Assert.lessOrEqual(asked.page.text.length, 60000, "The page stays within its share");
  ok(asked.page.text.includes(ANSWER.trim()), "and keeps the answering passage");
  Assert.lessOrEqual(asked.extra[0].text.length, 20000, "The video stays within its share");
  ok(asked.extra[0].text.includes("1:40:00 the narwhal lifts its tusk"), "and reaches the line past Summarize's cut, with its time");
  is(page.text, longPage(), "The saved page itself is left whole");
});
