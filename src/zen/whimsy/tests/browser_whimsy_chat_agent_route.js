/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W30 driveroute: with the agent on, a message that asks Whimsy to do
// something reaches the planner by its shape ("can you …", "please …", an
// imperative), not by a fixed verb list; plain questions never cost a planner
// call; and chat never claims it can't act on the page while the agent is on.
// Owner bug: in Drive on a GitHub PR's Files changed page, "can you expand all
// the diffs on this page?" got no plan, and chat said it couldn't click.

const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyChatAgent } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatAgent.sys.mjs");
const { WhimsyAgentTasks } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAgentTasks.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");

const ARTICLE = "https://example.com/browser/zen/whimsy/tests/whimsy_chat_article.html";
const MODE = "whimsy.ai.agent.mode";
const AGENT = "whimsy.feature.ai-agent";
const chat = () => WhimsyChatPanel.forWindow(window);
const el = () => document.getElementById("whimsy-chat");
const part = sel => el().querySelector(sel);
const parts = sel => [...el().querySelectorAll(sel)];

// true: it asks Whimsy to do something (the planner decides act or answer).
// false: a question or a chat job (answer, explain, write), or something
// another handler owns (tab requests, page edits, forms, extensions).
const CORPUS = [
  ["can you expand all the diffs on this page?", true],
  ["Expand all the diffs on this page", true],
  ["Could you collapse every file in this PR?", true],
  ["please click the Load more button", true],
  ["Scroll down to the comments", true],
  ["scroll to the bottom", true],
  ["Toggle dark mode on this site", true],
  ["Collapse the sidebar", true],
  ["show all the hidden comments", true],
  ["Select every checkbox in the list", true],
  ["Uncheck all the email notification boxes", true],
  ["I want you to approve this pull request", true],
  ["Would you mind starring this repo?", true],
  ["hey, can you resolve all the review threads", true],
  ["Order two more bags of the coffee I got last time", true],
  ["Book a table for two at 7 on Friday", true],
  ["Unsubscribe me from this newsletter", true],
  ["search for flights to Tokyo next month", true],
  ["Go ahead and merge it", true],
  ["Can you play the video?", true],
  ["Dismiss the cookie banner", true],
  ["Load the next page of results", true],
  ["What is this page about?", false],
  ["Why is the build failing?", false],
  ["Summarize this page", false],
  ["Explain the diff in utils.js", false],
  ["How do I expand all the diffs on GitHub?", false],
  ["Who wrote this article?", false],
  ["Is this PR safe to merge?", false],
  ["Can you explain what this function does?", false],
  ["Could you summarize the main points?", false],
  ["Tell me about the author", false],
  ["Give me a summary of the comments", false],
  ["Write a reply to this review", false],
  ["Translate this paragraph into French", false],
  ["Fill this form for me", false],
  ["Hide the sidebar", false], // a page edit: chat changes the page itself
  ["The second paragraph is confusing", false],
  ["Thanks, that helps!", false],
  ["what's the difference between these two approaches", false],
  ["Weather in Paris tomorrow", false],
  ["best pizza near me", false],
  ["Draft a reply to this email", false],
  ["Can you see this page?", false],
  ["Help me understand this error", false],
  ["List the changed files", false],
  ["Should I use a map or a set here?", false],
  ["I think the second option is better", false],
  ["can you expand on that last point?", false],
  ["Sum up this article", false],
  ["Average these rents", false],
];

let planReply = null;
let calls = [];
const plannerCalls = () => calls.filter(c => c.request.system.includes("You plan tasks"));
const chatCalls = () => calls.filter(c => c.request.system.startsWith("You are the chat in Whimsy"));

const DIFFS_PLAN = {
  act: true,
  title: "Expand diffs",
  line: "I’ll expand every collapsed diff on this page and stop when they’re all open.",
  steps: [{ text: "Click each “Load diff” button on the page" }, { text: "Click each collapsed file header to expand it" }],
  template: "Expand all the diffs on this page",
  readsOnly: true,
};

async function fresh() {
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, "whimsy-chat-agent-route-" + Math.random().toString(16).slice(2)));
  WhimsyAgentTasks._resetForTesting();
  WhimsyChatAgent._resetForTesting();
  planReply = DIFFS_PLAN;
  calls = [];
}

async function openOn(url = ARTICLE) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  if (!chat().isOpen) {
    EventUtils.synthesizeKey("e", { accelKey: true });
  }
  await TestUtils.waitForCondition(() => chat().isOpen && chat().ready, "Chat is open");
  return tab;
}

async function closeAll(...tabs) {
  WhimsyAgentTasks._resetForTesting();
  if (chat().isOpen) {
    chat().close({ reason: "key" });
    await TestUtils.waitForCondition(() => el().hidden, "Chat closed");
  }
  for (const tab of tabs) {
    if (tab.isConnected) {
      BrowserTestUtils.removeTab(tab);
    }
  }
}

function type(text) {
  chat().composer.focus();
  EventUtils.sendString(text);
  EventUtils.synthesizeKey("KEY_Enter");
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.ai.enabled", true],
      ["whimsy.feature.ai-hints", false],
      ["whimsy.ai.order", "claude"],
      ["whimsy.ai.off", ""],
    ],
  });
  WhimsyAIProviders.setTestProvider(async function* (provider, request) {
    calls.push({ provider, request });
    if (request.system.includes("You plan tasks")) {
      yield { type: "text", delta: JSON.stringify(planReply) };
      return;
    }
    if (request.system.includes("browser agent, carrying out")) {
      yield { type: "text", delta: JSON.stringify({ done: "Done." }) };
      return;
    }
    yield { type: "text", delta: "Answer to " + request.lastUserText };
  });
  registerCleanupFunction(async () => {
    WhimsyAgentTasks._resetForTesting();
    WhimsyChatAgent._resetForTesting();
    if (chat().isOpen) {
      chat().close({ reason: "key" });
    }
    while (gBrowser.tabs.length > 1) {
      BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
    }
    WhimsyAIProviders.setTestProvider(null);
    Services.prefs.clearUserPref(MODE);
    Services.prefs.clearUserPref("whimsy.ai.hints.seen");
  });
});

add_task(async function corpus_routes_by_shape() {
  ok(CORPUS.length >= 40, `The corpus has ${CORPUS.length} messages`);
  const wrong = CORPUS.filter(([text, act]) => WhimsyChatAgent.looksLikeTask(text) != act);
  const acts = CORPUS.filter(([, act]) => act).length;
  info(`Corpus: ${acts} actions, ${CORPUS.length - acts} questions or chat jobs, ${wrong.length} misrouted`);
  for (const [text, act] of CORPUS) {
    is(WhimsyChatAgent.looksLikeTask(text), act, `${act ? "Planned" : "Chat"}: “${text}”`);
  }
  is(wrong.length, 0, "Nothing is misrouted");
});

add_task(async function expand_diffs_gets_a_drive_plan() {
  await fresh();
  Services.prefs.setStringPref(MODE, "drive");
  const tab = await openOn();
  type("can you expand all the diffs on this page?");
  await TestUtils.waitForCondition(() => part(".whimsy-agent-card[data-card='agent-plan'] [data-choice='start']"), "The plan is ready");
  is(plannerCalls().length, 1, "The request reached the planner");
  const system = plannerCalls()[0].request.system;
  ok(system.includes("Mode: Drive"), "in Drive");
  ok(system.includes("Current tab:") && system.includes(ARTICLE), "and it reads the current tab");
  const card = part(".whimsy-agent-card[data-card='agent-plan']");
  is(card.querySelector(".whimsy-agent-planline").textContent, DIFFS_PLAN.line, "The plan says what it'll do");
  is(card.querySelectorAll(".whimsy-agent-step").length, 2, "with its steps");
  const [task] = WhimsyAgentTasks.list();
  is(task.mode, "drive", "The task drives the current tab");
  is(chatCalls().length, 0, "Chat didn't answer instead");
  await closeAll(tab);
});

add_task(async function questions_never_call_the_planner() {
  await fresh();
  const tab = await openOn();
  type("What is this page about?");
  await TestUtils.waitForCondition(() => part(".whimsy-chat-msg[data-role='ai']:not([busy])"), "Chat answered");
  is(plannerCalls().length, 0, "No planner call for a question");
  ok(!part(".whimsy-agent-card[data-card='agent-plan']"), "and no plan card");
  await closeAll(tab);
});

add_task(async function chat_knows_the_agent_can_act() {
  await fresh();
  planReply = { act: false };
  const tab = await openOn();
  // The planner may still say a request is a question; chat then answers,
  // and mustn't claim it can't act on the page.
  type("Can you play the video?");
  await TestUtils.waitForCondition(() => parts(".whimsy-chat-msg[data-role='ai']:not([busy])").length, "Chat answered");
  is(plannerCalls().length, 1, "The planner was asked first");
  const system = chatCalls().at(-1).request.system;
  ok(/agent/i.test(system) && /Drive/.test(system), "Chat's prompt says Whimsy's agent can act on pages");
  ok(!/can(?:no|')t (?:click|act|change|interact)/i.test(system), "and never tells it that it can't");
  await closeAll(tab);
});

add_task(async function agent_off_keeps_chat_as_it_was() {
  await fresh();
  await SpecialPowers.pushPrefEnv({ set: [[AGENT, false]] });
  const tab = await openOn();
  type("Can you play the video?");
  await TestUtils.waitForCondition(() => part(".whimsy-chat-msg[data-role='ai']:not([busy])"), "Chat answered");
  is(plannerCalls().length, 0, "No planner with the agent off");
  ok(!/agent/i.test(chatCalls().at(-1).request.system), "and chat's prompt doesn't mention the agent");
  await closeAll(tab);
  await SpecialPowers.popPrefEnv();
});
