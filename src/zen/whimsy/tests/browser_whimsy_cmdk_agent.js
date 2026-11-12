/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W25: the ⌘K agent (tab-commands.html K.1–K.11). Something to do gets the
// Do this row; one tab action is the row's confirm with Undo (K.3); a plan
// waits for Approve (K.4), ⌘↩ runs it in the background this once, Tab
// moves through the models, a guard pause asks on the status card with
// Enter doing nothing and Esc as "Don't" (K.8), Esc cancels a plan, and
// what it can't do says so with Ask in chat (K.10).

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_cmdbar_ai.js", this);

const { WhimsyCommandBarAgent } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommandBarAgent.sys.mjs");
const { WhimsyChatAgent } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatAgent.sys.mjs");
const { WhimsyAgentTasks } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAgentTasks.sys.mjs");

const MODE = "whimsy.ai.agent.mode";
const PAGES = ["https://example.org/", "https://test1.example.com/", "https://test2.example.com/"].map(
  origin => origin + "browser/zen/whimsy/tests/whimsy_chat_article.html"
);

let planReply = null;
let actions = [];
let tabReply = null;

const PLAN = {
  act: true,
  can: true,
  web: true,
  title: "Book a table",
  line: "I’ll open the booking page, find a table, and ask before booking.",
  steps: [{ text: "Open the booking page" }, { text: "Find a table for 4 on Friday" }, { text: "Book it", pauses: "submit" }],
};

const agentRow = () => rowOf(WhimsyCommandBarAgent.ROW_TYPE);
const planCard = () => gURLBar.view.panel.querySelector(".whimsy-cmdk-card");
const control = name => planCard()?.querySelector(`[data-control="${name}"]`);
const executorCalls = () => calls.filter(c => c.request.system.includes("browser agent, carrying out"));
const statusToast = id => WhimsyCommandBarAgent._statusToast(id)?.element ?? null;

async function freshAgent() {
  await freshStore();
  WhimsyCommandBarAgent._resetForTesting();
  WhimsyAgentTasks._resetForTesting();
  WhimsyChatAgent._resetForTesting();
  planReply = PLAN;
  actions = [{ done: "Booked a table for 4 at 7:00 PM." }];
  tabReply = null;
  script = async function* (provider, request) {
    if (request.system.includes("You plan tasks")) {
      yield { type: "text", delta: JSON.stringify(planReply) };
    } else if (request.system.includes("browser agent, carrying out")) {
      const next = actions.shift() ?? { done: "Done." };
      yield { type: "text", delta: JSON.stringify(typeof next == "function" ? await next() : next) };
    } else if (request.system.includes("You act on the person's browser tabs")) {
      yield { type: "text", delta: JSON.stringify(tabReply(request)) };
    } else {
      yield { type: "text", delta: "An answer." };
    }
  };
}

/** Types `text` and waits for the Do this row (K.1). */
async function typeTask(text) {
  await typeInBar(text);
  await TestUtils.waitForCondition(() => agentRow(), "The Do this row is up");
}

/** Do this, then the plan card (K.4). */
async function planWithKeys(text = "book a table for 4 at the cafe on Friday") {
  await typeTask(text);
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(() => planCard()?.querySelector(".whimsy-cmdk-step") && control("approve"), "The plan with Approve is up");
  return WhimsyCommandBarAgent.state(window);
}

async function finished(taskId) {
  await TestUtils.waitForCondition(() => WhimsyAgentTasks.get(taskId)?.state == "done", "The task finished");
}

add_setup(async function () {
  await setupAI();
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.ai-agent", true],
      ["whimsy.feature.ai-tab-requests", true],
      [MODE, "drive"],
    ],
  });
  await BrowserTestUtils.openNewForegroundTab(gBrowser, ARTICLE);
  registerCleanupFunction(() => {
    WhimsyCommandBarAgent._resetForTesting();
    WhimsyAgentTasks._resetForTesting();
    Services.prefs.clearUserPref(MODE);
  });
});

add_task(async function do_this_row_only_for_something_to_do() {
  await freshAgent();
  await typeInBar("book review hunger games");
  ok(!agentRow(), "A search that starts with a verb keeps the bar as it is");
  await typeTask("book a table for 4 at the cafe on Friday");
  ok(!askRow(), "Something to do gets one top row, not Ask AI too");
  is(agentRow().querySelector(".whimsy-cmdk-row-key").textContent, "↩︎", "Enter does it");
  await closeBar();
});

add_task(async function website_requests_get_the_row_in_actions_mode_too() {
  await freshAgent();
  // Requests that go to a site, find, or summarize are something to do.
  for (const text of [
    "go to wikipedia.org find the eiffel tower article, and summarize its history in three bullets",
    "search amazon for a usb-c charger and add the cheapest one to my cart",
  ]) {
    await typeTask(text);
    ok(agentRow(), `Do this for "${text}"`);
  }
  await typeInBar("find my iphone");
  ok(!agentRow(), "A short search stays a search");
  await closeBar();

  // ⌘K with text selected opens Actions mode; a request still gets the row.
  await typeInBar("x");
  const searching = UrlbarTestUtils.promiseSearchComplete(window);
  const { UrlbarShared } = ChromeUtils.importESModule("chrome://browser/content/urlbar/UrlbarShared.mjs");
  gURLBar.searchMode = { source: UrlbarShared.RESULT_SOURCE.ZEN_ACTIONS, isPreview: false };
  gURLBar.value = "go to wikipedia.org and summarize the eiffel tower article";
  gURLBar.startQuery({ allowAutofill: false, event: new Event("input") });
  await searching;
  await TestUtils.waitForCondition(() => agentRow(), "Do this is up in Actions mode");
  await closeBar();
});

add_task(async function one_step_confirm_then_undo() {
  await freshAgent();
  const tabs = [];
  for (const url of PAGES.slice(0, 2)) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, url));
  }
  await BrowserTestUtils.switchTab(gBrowser, gBrowser.tabs[1]);
  const before = gBrowser.tabs.length;
  tabReply = request => {
    const list = request.messages.at(-1).content;
    const ids = [...list.matchAll(/^(t\d+): .*\((?:example\.org|test1\.example\.com)\)$/gm)].map(m => m[1]);
    return { action: "close", tabs: ids, label: `Close ${ids.length} tabs from yesterday` };
  };
  await typeTask("close the tabs from yesterday's research");
  EventUtils.synthesizeKey("KEY_Enter");
  const row = await TestUtils.waitForCondition(
    () => agentRow()?.querySelector(".whimsy-cmdk-row-title")?.textContent == "Close 2 tabs from yesterday" && agentRow(),
    "The row says exactly what will happen (K.3)"
  );
  ok(row.querySelector(".whimsy-cmdk-row-detail").textContent.includes("Undo reopens them."), "and that Undo reopens them");
  ok(tabs.every(t => t.hasAttribute("whimsy-cmdk-ring")), "The sidebar rings the tabs");
  is(gBrowser.tabs.length, before, "Nothing has changed yet");

  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(() => tabs.every(t => !t.isConnected), "Enter closed them");
  ok(!gURLBar.view.isOpen, "The bar closed");
  const undo = await TestUtils.waitForCondition(() => document.getElementById("whimsy-undo-toast-button"), "The toast offers Undo");
  undo.click();
  await TestUtils.waitForCondition(() => gBrowser.tabs.length == before, "Undo reopened them");
  ok(![...gBrowser.tabs].some(t => t.hasAttribute("whimsy-cmdk-ring")), "No ring is left");
  while (gBrowser.tabs.length > 2) {
    BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
  }
});

add_task(async function approve_runs_the_plan_as_set() {
  await freshAgent();
  const st = await planWithKeys();
  const card = planCard();
  is(card.querySelector(".whimsy-cmdk-title").textContent, "Book a table", "The plan has its title");
  is(card.querySelectorAll(".whimsy-cmdk-step").length, 3, "and its numbered steps");
  ok(card.querySelector(".whimsy-cmdk-step[data-pause] .whimsy-cmdk-asks"), "The step that submits says it asks first");
  ok(control("where") && control("model"), "A website plan has the mode and model dropdowns");
  is(control("model").dataset.provider, "auto", "The model starts on Auto");
  ok(control("background"), "Run in background sits beside Approve while the setting is In this tab");
  is(document.activeElement, gURLBar.inputField, "Focus stays in the request field");
  const task = WhimsyAgentTasks.get(st.taskId);
  is(task.state, "planning", "Nothing runs before Approve");
  // A held Enter, or an IME's, never approves.
  const enter = more => ({ key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, preventDefault() {}, stopImmediatePropagation() {}, ...more });
  ok(WhimsyCommandBarAgent.onInputKey(window, enter({ repeat: true })), "A held Enter is taken");
  ok(WhimsyCommandBarAgent.onInputKey(window, enter({ isComposing: true })), "An IME's Enter is taken");
  is(task.state, "planning", "Neither approved");
  ok(gURLBar.view.isOpen, "The plan is still there");

  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(() => !gURLBar.view.isOpen, "Approve closed the bar");
  is(task.mode, "drive", "Approve runs it as set: in this tab");
  await finished(task.id);
  const done = await TestUtils.waitForCondition(() => statusToast(task.id)?.getAttribute("whimsy-cmdk-status") == "done" && statusToast(task.id), "The status card became the done toast");
  await TestUtils.waitForCondition(() => done.textContent.includes("Booked a table for 4"), "It says what was done");
  const thread = await WhimsyAIStore.thread(WhimsyChatAgent.runOf(task.id).threadId);
  is(thread.origin, "cmdk", "The run is in chat's history, from ⌘K");
});

add_task(async function cmd_enter_runs_in_background_this_once() {
  await freshAgent();
  const st = await planWithKeys();
  EventUtils.synthesizeKey("KEY_Enter", { accelKey: true });
  await TestUtils.waitForCondition(() => !gURLBar.view.isOpen, "⌘↩ approved and closed the bar");
  const task = WhimsyAgentTasks.get(st.taskId);
  is(task.mode, "background", "⌘↩ runs it in the background");
  is(Services.prefs.getStringPref(MODE), "drive", "only this once: chat's setting stays In this tab");
  await finished(task.id);

  // With the setting already In the background, Enter does the same and
  // the button hides.
  Services.prefs.setStringPref(MODE, "background");
  await planWithKeys();
  ok(!control("background"), "Run in background hides when the setting already is");
  await closeBar();
  Services.prefs.setStringPref(MODE, "drive");
});

add_task(async function tab_cycles_the_model_for_this_run() {
  await freshAgent();
  const st = await planWithKeys();
  EventUtils.synthesizeKey("KEY_Tab");
  await TestUtils.waitForCondition(() => control("model").dataset.provider == "claude", "Tab: the next model");
  EventUtils.synthesizeKey("KEY_Tab");
  await TestUtils.waitForCondition(() => control("model").dataset.provider == "openai", "Tab again: the one after");
  EventUtils.synthesizeKey("KEY_Tab", { shiftKey: true });
  await TestUtils.waitForCondition(() => control("model").dataset.provider == "claude", "⇧Tab goes back");
  EventUtils.synthesizeKey("KEY_Tab");
  EventUtils.synthesizeKey("KEY_Tab");
  await TestUtils.waitForCondition(() => control("model").dataset.provider == "auto", "and it wraps to Auto");
  EventUtils.synthesizeKey("KEY_Tab");
  EventUtils.synthesizeKey("KEY_Tab");
  await TestUtils.waitForCondition(() => control("model").dataset.provider == "openai", "OpenAI picked");
  is(document.activeElement, gURLBar.inputField, "Tab never left the field");
  ok(gURLBar.view.isOpen && planCard(), "and the plan is still up");

  EventUtils.synthesizeKey("KEY_Enter");
  await finished(st.taskId);
  is(executorCalls().at(-1).provider, "openai", "The run used the model picked for it");

  await planWithKeys();
  is(control("model").dataset.provider, "auto", "The next ⌘K starts on Auto");
  await closeBar();
});

add_task(async function guard_pause_asks_on_the_status_card() {
  await freshAgent();
  let decided = null;
  actions = [
    async () => {
      const task = WhimsyAgentTasks.list({ client: "whimsy" })[0];
      const pause = WhimsyAgentTasks.pause(task.id, {
        kind: "send",
        host: "example.com",
        preview: { title: "Send Ana the invite?", fields: [{ label: "To", value: "ana@example.com" }] },
      });
      decided = await WhimsyAgentTasks.wait(task, pause);
      return { done: "Didn’t send it." };
    },
  ];
  const st = await planWithKeys("send the invite to Ana for the review");
  EventUtils.synthesizeKey("KEY_Enter");
  const toast = await TestUtils.waitForCondition(() => statusToast(st.taskId)?.getAttribute("whimsy-cmdk-status") == "pause" && statusToast(st.taskId), "The pause shows on the status card (K.8)");
  await TestUtils.waitForCondition(() => toast.textContent.includes("ana@example.com"), "with exactly what goes out");
  const labels = [...toast.querySelectorAll(".whimsy-toast-button")].map(b => b.id);
  Assert.deepEqual(labels, ["cmdk-pause-skip", "cmdk-pause-self", "cmdk-pause-do"], "Don’t send, I’ll edit it, and Send, as in chat");

  toast.querySelector("#cmdk-pause-skip").focus();
  // A pause's answer lands as the key is handled, so it would show at once.
  EventUtils.synthesizeKey("KEY_Enter");
  is(WhimsyAgentTasks.get(st.taskId).pause?.choice ?? null, null, "Enter does nothing: a stray key can’t send");
  is(WhimsyAgentTasks.get(st.taskId).state, "paused", "The task still waits");
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(() => decided, "Esc answered");
  is(decided, "skip", "Esc is always Don’t send");
  await finished(st.taskId);
});

add_task(async function esc_cancels_the_plan() {
  await freshAgent();
  const st = await planWithKeys();
  EventUtils.synthesizeKey("KEY_ArrowDown");
  await TestUtils.waitForCondition(() => control("approve")?.hasAttribute("data-kbd-focus"), "↓ moves into the footer, on Approve");
  EventUtils.synthesizeKey("KEY_ArrowLeft");
  await TestUtils.waitForCondition(() => control("background")?.hasAttribute("data-kbd-focus"), "← moves between its buttons");
  is(document.activeElement, gURLBar.inputField, "while the field keeps focus");
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(() => !gURLBar.view.isOpen, "Esc closed the bar");
  ok(!WhimsyCommandBarAgent.state(window), "The plan is gone");
  await TestUtils.waitForCondition(() => WhimsyAgentTasks.get(st.taskId)?.state == "stopped", "and nothing will run");
  is(executorCalls().length, 0, "Nothing changed");
});

add_task(async function cant_do_it_offers_chat() {
  await freshAgent();
  planReply = { act: true, can: false, reason: "Whimsy can only read Google Calendar, so it can’t make the event. It can find a free time." };
  await typeTask("make a meeting with Ana tomorrow at 3");
  EventUtils.synthesizeKey("KEY_Enter");
  const row = await TestUtils.waitForCondition(() => agentRow()?.querySelector(".whimsy-cmdk-row-title")?.textContent.startsWith("Whimsy can only read") && agentRow(), "One plain line says what’s out of reach (K.10)");
  ok(row.querySelector(".whimsy-cmdk-row-action:not([hidden])"), "with Ask in chat");
  ok(!WhimsyAgentTasks.list().length, "No task was made");
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(() => WhimsyChat.isOpen(window), "Ask in chat opened chat");
  WhimsyChat.close(window, { reason: "key" });
});
