/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W27: "Quiz Me on This Page" is a built-in command. It shows in ⌘K's page
// group, runs in chat (the answers wait until you ask), and its switch in
// Settings › AI › Commands hides it like the other built-ins.

const { WhimsyAICommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAICommands.sys.mjs");
const { WhimsyContextCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVerbs.sys.mjs");
const { WhimsyChat } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChat.sys.mjs");

const SUBJECT = { kind: "page", text: "", title: "Weeknight miso salmon", url: "https://a.test/salmon" };
const VIEW = { shares: { article: 1 }, images: [], underPointer: null, product: false, textChars: 1000 };

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-hints", false], ["whimsy.ai.enabled", true]] });
  await WhimsyAICommands._resetForTesting();
  await WhimsyAICommands.init();
  registerCleanupFunction(async () => {
    await WhimsyAICommands._resetForTesting();
    await WhimsyAICommands.init();
    closeToasts();
  });
});

function quizRow(view = VIEW) {
  const groups = WhimsyContextCommands.rank(window, { ...SUBJECT }, view);
  return groups.flatMap(g => g.all).find(r => r.id == "ai:quiz-page") ?? null;
}

add_task(async function quiz_is_a_built_in() {
  const cmd = WhimsyAICommands.get("quiz");
  ok(cmd, "Quiz is listed");
  ok(cmd.builtIn, "as a built-in");
  is(cmd.name, "Quiz Me on This Page", "with its name");
  is(cmd.scope, "page", "It works on the page");
  ok(!cmd.hidden, "Shown by default");
  const builtIns = WhimsyAICommands.list().filter(c => c.builtIn).map(c => c.id);
  is(builtIns.at(-1), "quiz", "It comes after the other built-ins, so theirs don't move");
  const prompt = WhimsyAICommands.promptFor(cmd, { ...SUBJECT, pageText: "Salmon cooks fast under the broiler." });
  ok(prompt.includes("Salmon cooks fast"), "The page's text fills {page}");
  ok(/questions/i.test(prompt), "It asks for questions");
  ok(/Don't show the answers/.test(prompt) && /Wait until I ask/.test(prompt), "and keeps the answers until you ask");
});

add_task(async function quiz_shows_in_cmdk_and_runs_in_chat() {
  const row = quizRow();
  ok(row, "⌘K's page group has Quiz");
  is(row.label, "Quiz Me on This Page", "under the command's name");
  ok(!row.unavailable, "It can run on a page with text");
  const empty = quizRow({ ...VIEW, textChars: 0 });
  is(empty?.unavailable, "There’s no text here to quiz you on.", "With no text it's greyed with a reason");

  const opened = [];
  const realOpen = WhimsyChat.open;
  WhimsyChat.open = (win, opts) => opened.push(opts);
  try {
    await row.run(window, { ...SUBJECT });
  } finally {
    WhimsyChat.open = realOpen;
  }
  is(opened.length, 1, "Running it opens chat");
  ok(opened[0].send, "and sends the prompt");
  ok(opened[0].prompt.startsWith("Quiz me on Weeknight miso salmon"), "naming the page");
  ok(/Wait until I ask/.test(opened[0].prompt), "with the answers held back");
});

add_task(async function hiding_quiz_takes_it_out_of_cmdk() {
  await WhimsyAICommands.setHidden("quiz", true);
  ok(WhimsyAICommands.get("quiz").hidden, "Hidden in the store");
  is(quizRow(), null, "⌘K no longer offers it");
  await WhimsyAICommands.setHidden("quiz", false);
  ok(quizRow(), "Shown again");
});

add_task(async function settings_switch_hides_quiz() {
  await WhimsyAICommands._resetForTesting();
  await WhimsyAICommands.init();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences#whimsyAI");
  const win = tab.linkedBrowser.contentWindow;
  const doc = win.document;
  await TestUtils.waitForCondition(() => win.WhimsyAISettings?.root && doc.getElementById("whimsyAIPage")?.checkVisibility(), "Settings › AI shows");
  await TestUtils.waitForCondition(() => doc.getElementById("whimsyCommandsList")?.dataset.ready == "true", "Commands are listed");
  const row = doc.querySelector('#whimsyCommandsBuiltIn .whimsy-commands-row[data-command="quiz"]');
  ok(row, "Quiz is listed under Built in");
  const toggle = row.querySelector("moz-toggle");
  ok(toggle?.pressed, "with its switch on");
  ok(!row.querySelector(".whimsy-commands-iconbtn"), "and no edit button");
  toggle.scrollIntoView({ block: "center" });
  EventUtils.synthesizeMouseAtCenter(toggle.buttonEl, {}, win);
  await TestUtils.waitForCondition(() => WhimsyAICommands.get("quiz").hidden, "The switch hides it");
  is(quizRow(), null, "and ⌘K drops it");
  EventUtils.synthesizeMouseAtCenter(toggle.buttonEl, {}, win);
  await TestUtils.waitForCondition(() => !WhimsyAICommands.get("quiz").hidden, "Shown again");
  win.WhimsyAISettings.closeSheet?.({ restore: false });
  BrowserTestUtils.removeTab(tab);
});
