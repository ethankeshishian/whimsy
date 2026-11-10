/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W24 agentdone (owner bugs 9, 10's second bullet, and 11): the agent never
// reports success for an unmet goal. A stub provider plans like Apple's
// small model (only "type", or "copy, switch tabs"), and a local search form
// stands in for Google and Yahoo.

const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyChatAgent } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatAgent.sys.mjs");
const { WhimsyAgentTasks } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAgentTasks.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyClaude } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyClaude.sys.mjs");

const PATH = "/browser/zen/whimsy/tests/whimsy_agent_search.html";
const GOOGLE = `https://example.com${PATH}?engine=Google`;
const YAHOO = `https://example.org${PATH}?engine=Yahoo`;
const MODE = "whimsy.ai.agent.mode";
const chat = () => WhimsyChatPanel.forWindow(window);
const el = () => document.getElementById("whimsy-chat");
const part = sel => el().querySelector(sel);

let planReply = null;
let actions = [];
let calls = [];

async function fresh(plan, steps) {
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, "whimsy-agent-done-" + Math.random().toString(16).slice(2)));
  WhimsyAgentTasks._resetForTesting();
  WhimsyChatAgent._resetForTesting();
  planReply = { act: true, title: "Search", line: "I’ll search.", steps: plan, template: "Search for {query}" };
  actions = steps;
  calls = [];
}

async function openOn(url) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  if (!chat().isOpen) {
    EventUtils.synthesizeKey("e", { accelKey: true });
  }
  await TestUtils.waitForCondition(() => chat().isOpen && chat().ready, "Chat is open");
  return tab;
}

async function closeAll() {
  WhimsyAgentTasks._resetForTesting();
  if (chat().isOpen) {
    chat().close({ reason: "key" });
    await TestUtils.waitForCondition(() => el().hidden, "Chat closed");
  }
  while (gBrowser.tabs.length > 1) {
    BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
  }
  Services.prefs.clearUserPref(MODE);
}

function send(text) {
  chat().composer.focus();
  EventUtils.sendString(text);
  EventUtils.synthesizeKey("KEY_Enter");
}

function click(node) {
  node.scrollIntoView({ block: "nearest" });
  EventUtils.synthesizeMouseAtCenter(node, {});
}

// The last tool result the agent saw, and a field's ref in it.
const lastResult = request => String(request.messages.at(-1)?.content ?? "");
function fieldRef(request) {
  const line = lastResult(request).split("\n").find(l => /searchbox|textbox|combobox/.test(l));
  return line?.match(/ref_\d+/)?.[0];
}
const executorCalls = () => calls.filter(c => c.request.system.includes("browser agent, carrying out"));
const idOf = tab => WhimsyClaude.tabId(tab);

async function startPlan(text) {
  send(text);
  const start = await TestUtils.waitForCondition(() => part(".whimsy-agent-card[data-card='agent-plan'] [data-choice='start']"), "The plan is ready");
  click(start);
  return TestUtils.waitForCondition(() => part(".whimsy-agent-end"), "The run ends");
}

async function endMsg() {
  const messages = await WhimsyAIStore.messages(chat().thread.id);
  return messages.find(m => m.card == "agent-end");
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
      const next = actions.shift() ?? { done: "Done." };
      yield { type: "text", delta: JSON.stringify(typeof next == "function" ? await next(request) : next) };
      return;
    }
    yield { type: "text", delta: "Answer to " + request.lastUserText };
  });
  registerCleanupFunction(async () => {
    await closeAll();
    WhimsyAIProviders.setTestProvider(null);
    Services.prefs.clearUserPref("whimsy.ai.hints.seen");
  });
});

// Bug 9 (a, b, e): the plan only types. The model says "done" twice; the
// runner submits the search itself, and the page shows results.
add_task(async function type_only_plan_still_submits_the_search() {
  Services.prefs.setStringPref(MODE, "drive");
  const tab = await openOn(GOOGLE);
  await fresh([{ text: "type search query" }], [
    { step: 0, say: "Finding the box", tool: "find", args: { tabId: idOf(tab), query: "search" } },
    request => ({ step: 0, say: "Typing", tool: "type", args: { tabId: idOf(tab), ref: fieldRef(request), text: "hello world" } }),
    { done: "Searched for hello world." },
    { done: "Searched for hello world." },
  ]);
  const end = await startPlan('please search up "hello world"');
  await TestUtils.waitForCondition(() => end.getAttribute("data-outcome"), "The outcome is set");
  ok(new URL(tab.linkedBrowser.currentURI.spec).searchParams.get("q") == "hello world", "The search ran: the page moved to its results");
  is(end.getAttribute("data-outcome"), "done", "and only then is it a success");
  ok(executorCalls().some(c => lastResult(c.request).startsWith("Not done yet: you typed")), "The first “done” was sent back: typed, never submitted");
  is(part(".whimsy-agent-step").textContent, "Type search query", "Step labels are sentence case");
  const msg = await endMsg();
  ok(msg.timing && msg.timing.turns >= 3 && msg.timing.modelMs >= 0 && msg.timing.toolMs >= 0, "The run records where its time went");
  ok(msg.timing.totalMs < 60000 && msg.minutes == 1, "Minutes count from Start");
  await closeAll();
});

// Bug 9 (a, b, e): typed where nothing can submit it. The run says it
// didn't finish, with no success check anywhere.
add_task(async function unsubmittable_typing_reports_the_shortfall() {
  Services.prefs.setStringPref(MODE, "drive");
  const tab = await openOn(GOOGLE);
  await fresh([{ text: "type search query" }], [
    { step: 0, say: "Finding the box", tool: "find", args: { tabId: idOf(tab), query: "notes" } },
    request => ({ step: 0, say: "Typing", tool: "type", args: { tabId: idOf(tab), ref: fieldRef(request), text: "hello world" } }),
    { done: "Searched for hello world." },
    { done: "Searched for hello world." },
  ]);
  const end = await startPlan('please search up "hello world"');
  await TestUtils.waitForCondition(() => end.getAttribute("data-outcome"), "The outcome is set");
  is(end.getAttribute("data-outcome"), "unmet", "An unmet goal isn't a success");
  const line = end.querySelector(".whimsy-agent-outcome [data-l10n-id]");
  is(line?.getAttribute("data-l10n-id"), "whimsy-agent-chat-unmet-typed-search", "It says: typed the search but couldn't submit it");
  await document.l10n.translateFragment(end);
  ok(line.textContent.startsWith("Didn’t finish"), "in words");
  ok(!end.textContent.includes("Searched for hello world"), "The model's claim isn't shown as the summary");
  ok(!end.querySelector("[data-card='agent-kept']"), "No green-check “tab kept” card");
  const left = end.querySelector("[data-card='agent-left'] .whimsy-agent-card-title");
  is(left?.getAttribute("data-l10n-id"), "whimsy-agent-chat-left-open", "The tab is “left open” instead");
  ok(!getComputedStyle(end.querySelector("[data-card='agent-left'] .whimsy-agent-icon")).getPropertyValue("--whimsy-agent-icon").includes("check.svg"), "with no check icon");
  const step = part(".whimsy-agent-card[data-card='agent-plan'] .whimsy-agent-step");
  is(step.dataset.state, "fail", "The plan card doesn't tick the step that fell short");
  ok(!new URL(tab.linkedBrowser.currentURI.spec).searchParams.has("q"), "Nothing was searched");
  await closeAll();
});

// Bug 10 (second bullet) and 11: "copy the query and search on the Yahoo
// tab" uses the Yahoo tab that's open; asking for a new one resolves to it.
add_task(async function named_tab_is_switched_to_not_reopened() {
  Services.prefs.setStringPref(MODE, "drive");
  const yahoo = BrowserTestUtils.addTab(gBrowser, YAHOO);
  await BrowserTestUtils.browserLoaded(yahoo.linkedBrowser);
  const google = await openOn(`${GOOGLE}&q=hello+world`);
  const before = gBrowser.tabs.length;
  let opened = 0;
  const onOpen = () => opened++;
  gBrowser.tabContainer.addEventListener("TabOpen", onOpen);
  await fresh([{ text: "copy" }, { text: "switch tabs" }], [
    { step: 0, say: "Reading the query", tool: "get_page_text", args: { tabId: idOf(google) } },
    { step: 1, say: "Switching", tool: "tabs_create", args: { url: "https://example.org/" } },
    request => {
      const id = Number(lastResult(request).match(/Use tabId (\d+)/)?.[1]);
      return { step: 1, say: "Finding the box", tool: "find", args: { tabId: id, query: "search" } };
    },
    request => ({ step: 1, say: "Typing", tool: "type", args: { tabId: idOf(yahoo), ref: fieldRef(request), text: "hello world" } }),
    { step: 1, say: "Searching", tool: "key", args: { tabId: idOf(yahoo), keys: "Enter" } },
    { done: "Searched on Yahoo." },
  ]);
  const end = await startPlan("copy the query and search on the Yahoo tab");
  gBrowser.tabContainer.removeEventListener("TabOpen", onOpen);
  const planner = calls.find(c => c.request.system.includes("You plan tasks"));
  ok(planner.request.system.includes('Open tabs the person named: "Yahoo"'), "The planner hears about the open Yahoo tab");
  ok(executorCalls()[0].request.system.includes(`tabId ${idOf(yahoo)} "Yahoo"`), "and the agent may use it by its tabId");
  is(opened, 0, "No new tab was opened");
  is(gBrowser.tabs.length, before, "gBrowser.tabs.length didn't change");
  is(gBrowser.selectedTab, yahoo, "Drive switched to the existing Yahoo tab");
  ok(new URL(yahoo.linkedBrowser.currentURI.spec).searchParams.get("q") == "hello world", "and searched there");
  is(end.getAttribute("data-outcome"), "done", "A goal that was met is a success");
  ok(yahoo.isConnected, "The person's Yahoo tab is never archived");
  const steps = [...part(".whimsy-agent-card[data-card='agent-plan']").querySelectorAll(".whimsy-agent-steptext")].map(s => s.textContent);
  Assert.deepEqual(steps, ["Copy", "Switch tabs"], "Step labels read as sentences");
  await closeAll();
});

// Bug 10 (second bullet): the same goal planned as "copy, switch tabs" and
// carried out as just that never ran the search, so it isn't a success.
add_task(async function multi_tab_plan_without_search_is_unmet() {
  Services.prefs.setStringPref(MODE, "drive");
  const yahoo = BrowserTestUtils.addTab(gBrowser, YAHOO);
  await BrowserTestUtils.browserLoaded(yahoo.linkedBrowser);
  const google = await openOn(`${GOOGLE}&q=hello+world`);
  await fresh([{ text: "copy" }, { text: "switch tabs" }], [
    { step: 0, say: "Reading the query", tool: "get_page_text", args: { tabId: idOf(google) } },
    { step: 1, say: "Switching", tool: "read_page", args: { tabId: idOf(yahoo), filter: "interactive" } },
    { done: "Done." },
    { done: "Done." },
  ]);
  const end = await startPlan("copy the query and search on the Yahoo tab");
  is(end.getAttribute("data-outcome"), "unmet", "Switching tabs isn't searching");
  is(end.querySelector(".whimsy-agent-outcome [data-l10n-id]")?.getAttribute("data-l10n-id"), "whimsy-agent-chat-unmet-no-search", "It says the search never ran");
  ok(executorCalls().some(c => lastResult(c.request).startsWith("Not done yet: the search never ran")), "The model was told before the run ended");
  await closeAll();
});

// Bug 11 ("it tried multiple new tabs"): a model that keeps asking for the
// same new tab gets it once, then the run stops with a "couldn't" message.
add_task(async function repeated_new_tab_opens_once_and_stops() {
  Services.prefs.setStringPref(MODE, "background");
  await openOn(GOOGLE);
  const target = `https://example.com${PATH}?engine=Yahoo`;
  let opened = 0;
  const onOpen = () => opened++;
  gBrowser.tabContainer.addEventListener("TabOpen", onOpen);
  const ask = { step: 0, say: "Opening Yahoo", tool: "tabs_create", args: { url: target } };
  await fresh([{ text: "Open Yahoo" }], Array.from({ length: 12 }, () => ask));
  const end = await startPlan("Open the Yahoo page");
  gBrowser.tabContainer.removeEventListener("TabOpen", onOpen);
  is(opened, 1, "Yahoo opened once at most");
  ok(executorCalls().length <= 4, "The run didn't loop on the same step");
  is(end.getAttribute("data-outcome"), "unmet", "and isn't a success");
  is(end.querySelector(".whimsy-agent-outcome [data-l10n-id]")?.getAttribute("data-l10n-id"), "whimsy-agent-chat-unmet-repeat", "It says it couldn't get past the step");
  ok(executorCalls().some(c => lastResult(c.request).includes("already has example.com open, so no new tab")), "The repeat was answered with the tab it already had");
  await closeAll();
});

// Bug 11: the run card's step, the plan's current step, and the count agree;
// a long step wraps to two lines and has a tooltip.
add_task(async function run_card_agrees_with_the_plan() {
  Services.prefs.setStringPref(MODE, "drive");
  const tab = await openOn(GOOGLE);
  let release;
  const hold = new Promise(r => (release = r));
  const long = "Copy the search query from the current page and keep it ready for the Yahoo tab";
  await fresh([{ text: long }, { text: "Switch to the Yahoo tab" }], [
    { step: 0, say: "Switch to the Yahoo tab and search for the copied query there", tool: "get_page_text", args: { tabId: idOf(tab) } },
    async () => {
      await hold;
      return { done: "Done." };
    },
  ]);
  send("copy the query and search on the Yahoo tab");
  const start = await TestUtils.waitForCondition(() => part("[data-choice='start']"), "The plan is ready");
  click(start);
  const title = await TestUtils.waitForCondition(() => part(".whimsy-agent-run .whimsy-agent-run-text > b")?.textContent && executorCalls().length >= 2 && part(".whimsy-agent-run .whimsy-agent-run-text > b"), "The run card shows a step");
  const now = part(".whimsy-agent-card[data-card='agent-plan'] .whimsy-agent-step[data-state='now'] .whimsy-agent-steptext");
  is(title.textContent, now.textContent, "The run card names the step the plan marks");
  is(title.getAttribute("title"), long, "with the whole step as its tooltip");
  const sub = part(".whimsy-agent-run .whimsy-agent-run-text > span[data-l10n-id]");
  Assert.deepEqual(JSON.parse(sub.getAttribute("data-l10n-args")), { step: 1, total: 2 }, "and the count is the same step");
  const style = getComputedStyle(title);
  is(style.getPropertyValue("-webkit-line-clamp"), "2", "A long step wraps to two lines before it's cut");
  ok(title.getBoundingClientRect().height > parseFloat(style.lineHeight) * 1.5, "and does wrap");
  release();
  await TestUtils.waitForCondition(() => part(".whimsy-agent-end"), "The run ends");
  await closeAll();
});

// Bug 9d: the disclosures use the standard chevron, pointing down when open
// and right when closed.
add_task(async function disclosures_use_the_standard_chevron() {
  Services.prefs.setStringPref(MODE, "drive");
  await openOn(GOOGLE);
  await fresh([{ text: "Open the page" }], [{ done: "Done." }]);
  send("Open the page");
  const disclose = await TestUtils.waitForCondition(() => part(".whimsy-agent-card[data-card='agent-plan'] .whimsy-agent-disclose"), "The plan has its disclosure");
  const before = () => getComputedStyle(disclose, "::before");
  ok(before().backgroundImage.includes("whimsy/icons/chevron-down.svg"), "The chat's chevron, not the filled arrow");
  is(before().rotate, "none", "Open: it points down");
  click(disclose);
  await TestUtils.waitForCondition(() => before().rotate == "-90deg", "Closed: it points right");
  await closeAll();
});

// Bug 9c: the conversation is cut to what the provider takes (Apple's
// small window overflowed after a few page reads).
add_task(async function history_fits_the_provider() {
  const real = Object.getOwnPropertyDescriptor(WhimsyAIProviders, "maxInputChars");
  Object.defineProperty(WhimsyAIProviders, "maxInputChars", { get: () => 7000, configurable: true });
  try {
    const page = "x".repeat(6000);
    const history = [{ role: "user", content: "please search up hello world" }];
    for (let i = 0; i < 6; i++) {
      history.push({ role: "assistant", content: `{"tool":"read_page","n":${i}}` }, { role: "user", content: `[Tool result for read_page]\n${page}` });
    }
    const system = "s".repeat(3000);
    const fitted = WhimsyChatAgent.fitHistory(history, system);
    const size = fitted.reduce((n, m) => n + m.content.length, 0);
    ok(size + system.length <= 7000, `It fits (${size + system.length} characters)`);
    is(fitted[0].content, history[0].content, "The request stays");
    is(fitted.at(-2).content, history.at(-2).content, "and so does the latest turn");
    const small = [{ role: "user", content: "hi" }];
    is(WhimsyChatAgent.fitHistory(small, system), small, "A conversation that fits is untouched");
  } finally {
    Object.defineProperty(WhimsyAIProviders, "maxInputChars", real);
  }
});
