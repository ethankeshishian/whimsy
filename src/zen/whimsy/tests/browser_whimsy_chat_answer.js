/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 chat-answers: thinking, streaming, citations, the model menu, notes,
// the error block, language, and pass-through (code, images, reports).

const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyChatAnswer, errorSpec } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatAnswer.sys.mjs");
const { WhimsyChatContextUI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatContextUI.sys.mjs");
const { WhimsyAIProviders, WhimsyAIError } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyAIUpdates } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIUpdates.sys.mjs");
const { WhimsyAIReports } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIReports.sys.mjs");

const ARTICLE = "https://example.com/browser/zen/whimsy/tests/whimsy_chat_article.html";
const chat = () => WhimsyChatPanel.forWindow(window);
const el = () => document.getElementById("whimsy-chat");
const part = sel => el().querySelector(sel);
const parts = sel => [...el().querySelectorAll(sel)];

let calls = [];
let script = null;

async function fresh() {
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, "whimsy-chat-answer-" + Math.random().toString(16).slice(2)));
  calls = [];
  script = null;
}

async function openOn(url = ARTICLE) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  if (!chat().isOpen) {
    EventUtils.synthesizeKey("e", { accelKey: true });
  }
  await TestUtils.waitForCondition(() => chat().isOpen && chat().ready, "Chat is open");
  await TestUtils.waitForCondition(() => el().getAnimations({ subtree: true }).every(a => a.playState != "running"), "Chat settled");
  return tab;
}

async function closeAll(...tabs) {
  if (chat().isOpen) {
    chat().close({ reason: "key" });
    await TestUtils.waitForCondition(() => el().hidden, "Chat closed");
  }
  for (const tab of tabs) {
    BrowserTestUtils.removeTab(tab);
  }
}

function type(text) {
  chat().composer.focus();
  EventUtils.sendString(text);
  EventUtils.synthesizeKey("KEY_Enter");
}

const answered = () => TestUtils.waitForCondition(() => !part(".whimsy-chat-msg[data-role='ai'][busy]") && parts(".whimsy-chat-msg[data-role='ai']").length, "The answer is in");

function gate() {
  let open;
  const promise = new Promise(r => (open = r));
  return { promise, open };
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.ai.enabled", true],
      ["whimsy.feature.ai-hints", false],
      ["whimsy.ai.order", "claude,openai"],
      ["whimsy.ai.off", ""],
      ["whimsy.ai.openai.model", "gpt-5"],
    ],
  });
  WhimsyAIProviders.setTestProvider(async function* (provider, request) {
    calls.push({ provider, request });
    if (script) {
      yield* script(provider, request);
      return;
    }
    yield { type: "text", delta: "Answer to " + request.lastUserText };
  });
  registerCleanupFunction(() => {
    if (chat().isOpen) {
      chat().close({ reason: "key" });
    }
    while (gBrowser.tabs.length > 1) {
      BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
    }
    WhimsyAIProviders.setTestProvider(null);
    Services.prefs.clearUserPref("whimsy.ai.hints.seen");
  });
});

add_task(async function thinking_folds_when_answer_starts() {
  await fresh();
  const tab = await openOn();
  const g = gate();
  script = async function* () {
    yield { type: "thinking", text: "The article is about national trends." };
    await g.promise;
    yield { type: "text", delta: "Likely yes." };
  };
  type("Is this a good idea for Oakland?");
  await TestUtils.waitForCondition(() => part(".whimsy-chat-thinking[live]")?.textContent.includes("national trends"), "Thinking streams in a muted block");
  ok(!part(".whimsy-chat-msg[busy] .whimsy-chat-status"), "in place of the status row");
  g.open();
  await answered();
  const head = part(".whimsy-chat-thinking[folded] .whimsy-chat-thinking-head");
  ok(head, "The block folds to one line");
  await TestUtils.waitForCondition(() => /Thought for \d+ seconds?/.test(head.textContent), "Thought for N seconds");
  is(head.getAttribute("aria-expanded"), "false", "folded");
  EventUtils.synthesizeMouseAtCenter(head, {});
  ok(part(".whimsy-chat-thinking").hasAttribute("open"), "Pressing it opens the thinking again");
  await closeAll(tab);
});

add_task(async function plan_answer_fades_in_whole_and_thinking_menu_hidden_for_plan() {
  await fresh();
  const usesPlan = WhimsyAIProviders._usesPlan;
  WhimsyAIProviders._usesPlan = id => id == "claude";
  const tab = await openOn();
  const g = gate();
  script = async function* () {
    yield { type: "text", delta: "First half. " };
    await g.promise;
    yield { type: "text", delta: "Second half." };
  };
  type("Sum up this article");
  await TestUtils.waitForCondition(() => calls.length, "Asked");
  await TestUtils.waitForCondition(() => part(".whimsy-chat-msg[busy]"), "The answer is on its way");
  await new Promise(r => setTimeout(r, 100));
  is(part(".whimsy-chat-msg[busy] .whimsy-chat-text").textContent, "", "Nothing streams from the plan");
  ok(part(".whimsy-chat-msg[busy] .whimsy-chat-status"), "The row says what it's doing");
  g.open();
  await answered();
  const msg = parts(".whimsy-chat-msg[data-role='ai']").at(-1);
  ok(msg.textContent.includes("First half. Second half."), "The whole answer arrives at once");
  ok(msg.getAnimations().some(a => a.effect.getKeyframes().some(k => "opacity" in k)), "and fades in");
  EventUtils.synthesizeMouseAtCenter(part(".whimsy-chat-model-button"), {});
  await TestUtils.waitForCondition(() => part(".whimsy-chat-model-menu"), "The model menu opens");
  ok(!part(".whimsy-chat-thinking-control"), "No Thinking control for the Claude plan");
  EventUtils.synthesizeKey("KEY_Escape");
  ok(!part(".whimsy-chat-model-menu") && chat().isOpen, "Esc closes the menu, not chat");
  WhimsyAIProviders._usesPlan = usesPlan;
  await closeAll(tab);
});

add_task(async function model_choice_holds_for_this_chat_only() {
  await fresh();
  const tab = await openOn();
  EventUtils.synthesizeMouseAtCenter(part(".whimsy-chat-model-button"), {});
  await TestUtils.waitForCondition(() => part(".whimsy-chat-model-menu .whimsy-chat-option[data-provider='openai']"), "The menu lists ChatGPT");
  ok(part(".whimsy-chat-thinking-control"), "Thinking shows for a model that has it");
  const deep = part(".whimsy-chat-segment[data-level='deep']");
  EventUtils.synthesizeMouseAtCenter(deep, {});
  await TestUtils.waitForCondition(() => deep.getAttribute("aria-checked") == "true", "Deep is picked");
  EventUtils.synthesizeMouseAtCenter(part(".whimsy-chat-option[data-provider='openai']"), {});
  await TestUtils.waitForCondition(() => !part(".whimsy-chat-model-menu"), "Picking closes the menu");
  await TestUtils.waitForCondition(() => part(".whimsy-chat-model-name").textContent.startsWith("ChatGPT"), "The line names the choice");
  ok(part(".whimsy-chat-model-thinking"), "and says Deep thinking");
  type("one");
  await answered();
  is(calls.at(-1).provider, "openai", "The chat asks ChatGPT");
  is(calls.at(-1).request.thinking, "deep", "with deep thinking");
  EventUtils.synthesizeMouseAtCenter(document.getElementById("whimsy-chat-new-button"), {});
  await TestUtils.waitForCondition(() => chat().thread?.draft && !part(".whimsy-chat-msg"), "A new chat");
  type("two");
  await TestUtils.waitForCondition(() => calls.length == 2, "Asked again");
  await answered();
  is(calls.at(-1).provider, "claude", "A new chat starts on the order again");
  await closeAll(tab);
});

add_task(async function citation_click_scrolls_and_tints() {
  await fresh();
  const tab = await openOn();
  script = async function* () {
    yield { type: "text", delta: "Buffalo went first" };
    yield { type: "citation", n: 1, source: { quote: "Buffalo was first in 2017" } };
    yield { type: "text", delta: ", in 2017. More follows" };
  };
  type("When did it start?");
  await answered();
  const pill = part(".whimsy-chat-msg[data-role='ai'] .whimsy-chat-cite");
  ok(pill, "A pill follows its sentence");
  is(pill.getAttribute("aria-label"), "Source 1", "and is a labelled button");
  EventUtils.synthesizeMouseAtCenter(pill, {});
  ok(pill.hasAttribute("active"), "The pill is active");
  await TestUtils.waitForCondition(async () => (await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.getSelection().toString())).includes("Buffalo was first"), "The page shows the passage");
  await closeAll(tab);
});

add_task(async function handoff_note_line_once() {
  await fresh();
  const tab = await openOn();
  script = async function* (provider) {
    if (provider == "claude") {
      throw Object.assign(new WhimsyAIError("rate-limited"), { provider });
    }
    yield { type: "text", delta: "ChatGPT here." };
  };
  type("Sum up");
  await answered();
  await TestUtils.waitForCondition(() => parts(".whimsy-chat-note[data-kind='handoff']").length == 1, "One note line names the handoff");
  ok(part(".whimsy-chat-note[data-kind='handoff']").textContent.includes("ChatGPT"), "naming who answered");
  WhimsyAIProviders.clearResting("claude");
  await closeAll(tab);
});

add_task(async function mid_stream_quota_offers_finish_with_next() {
  await fresh();
  const tab = await openOn();
  script = async function* (provider, request) {
    if (provider == "claude") {
      yield { type: "text", delta: "Cities are dropping the rule" };
      throw Object.assign(new WhimsyAIError("plan-limit"), { provider });
    }
    yield { type: "text", delta: request.lastUserText.startsWith("Continue") ? ", and it lowers costs." : "?" };
  };
  type("Sum up this article");
  await answered();
  const block = await TestUtils.waitForCondition(() => part(".whimsy-chat-msg[data-role='ai'] .whimsy-chat-error[tone='amber']"), "The partial answer keeps a block");
  ok(part(".whimsy-chat-msg[data-role='ai']").textContent.includes("Cities are dropping the rule"), "The part so far is kept");
  is(calls.filter(c => c.provider == "openai").length, 0, "Nothing switches by itself");
  const finish = block.querySelector(".whimsy-chat-pill-btn.primary");
  await TestUtils.waitForCondition(() => finish.textContent.includes("Finish with ChatGPT"), "Finish with the next provider");
  EventUtils.synthesizeMouseAtCenter(finish, {});
  await TestUtils.waitForCondition(() => part(".whimsy-chat-msg[data-role='ai']:not([busy])")?.textContent.includes("Cities are dropping the rule, and it lowers costs."), "ChatGPT finishes the same answer");
  ok(!part(".whimsy-chat-error"), "and the block goes");
  WhimsyAIProviders.clearResting("claude");
  await closeAll(tab);
});

add_task(async function error_block_tones_and_next_steps() {
  await fresh();
  const cases = [
    [{ code: "failed", provider: "claude" }, "red", "whimsy-chat-error-down"],
    [{ code: "plan-limit", provider: "claude" }, "amber", "whimsy-chat-error-plan-out"],
    [{ code: "offline", provider: "claude" }, "amber", "whimsy-chat-error-offline"],
    [{ code: "none-capable", provider: "claude", needs: { research: true } }, "grey", "whimsy-chat-error-cannot-research"],
    [{ code: "signed-out", provider: "claude" }, "amber", "whimsy-chat-error-signed-out"],
    [{ code: "all-failed", provider: "claude", tried: ["claude", "openai"] }, "red", "whimsy-chat-error-all-failed"],
  ];
  for (const [msg, tone, id] of cases) {
    const spec = errorSpec(msg, { win: window });
    is(spec.tone, tone, `${msg.code} is ${tone}`);
    is([spec.l10n].flat()[0], id, `${msg.code} says ${id}`);
    ok(spec.buttons.length >= 1, `${msg.code} offers a next step`);
  }
  const tab = await openOn();
  script = async function* (provider) {
    throw Object.assign(new WhimsyAIError("unavailable"), { provider });
    yield* [];
  };
  type("Sum up");
  const block = await TestUtils.waitForCondition(() => part(".whimsy-chat-error[tone='red']"), "Every provider failing shows the red block");
  script = null;
  const retry = [...block.querySelectorAll("button")].find(b => b.textContent == "Try again");
  ok(retry, "with Try again");
  EventUtils.synthesizeMouseAtCenter(retry, {});
  await TestUtils.waitForCondition(() => !part(".whimsy-chat-error") && part(".whimsy-chat-msg[data-role='ai']:not([busy])"), "Try again answers in its place");
  await closeAll(tab);
});

add_task(async function answer_in_page_language_offer() {
  await fresh();
  const tab = await openOn();
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => (content.document.documentElement.lang = "ja"));
  type("What is this about?");
  await answered();
  const note = await TestUtils.waitForCondition(() => part(".whimsy-chat-note[data-kind='language']"), "One quiet line offers the page's language");
  await TestUtils.waitForCondition(() => note.textContent.includes("Japanese"), "naming it");
  const button = note.querySelector(".whimsy-chat-link");
  EventUtils.synthesizeMouseAtCenter(button, {});
  await TestUtils.waitForCondition(() => calls.at(-1).request.lastUserText.includes("in Japanese"), "Answer in Japanese asks again in it");
  await answered();
  await closeAll(tab);
});

add_task(async function code_block_copy() {
  await fresh();
  const tab = await openOn();
  script = async function* () {
    yield { type: "text", delta: "Like this:\n```python\nprint(1 + 1)\n```\nDone." };
  };
  type("code please");
  await answered();
  const block = part(".whimsy-chat-code[data-language='python']");
  ok(block, "Code gets a block with its language");
  const copy = block.querySelector(".whimsy-chat-code-copy");
  await SimpleTest.promiseClipboardChange("print(1 + 1)", () => EventUtils.synthesizeMouseAtCenter(copy, {}));
  await closeAll(tab);
});

add_task(async function research_report_saved_and_opens_as_tab_and_posts_update() {
  await fresh();
  WhimsyAIUpdates._resetForTesting();
  const tab = await openOn();
  script = async function* () {
    yield { type: "artifact", artifact: { kind: "progress", title: "Deep research", lines: ["Found city studies"] } };
    yield { type: "text", delta: "In short: rents ran lower." };
    yield { type: "artifact", artifact: { kind: "report", title: "Parking reform and rents", markdown: "Rents ran 8 to 15% lower.", sources: 3 } };
  };
  const tabs = gBrowser.tabs.length;
  type("Do deep research on parking reform");
  await answered();
  await TestUtils.waitForCondition(() => gBrowser.tabs.length == tabs + 1, "The report opens as a tab");
  is(gBrowser.selectedTab, tab, "beside the chat's tab, which stays in front");
  const card = await TestUtils.waitForCondition(() => part(".whimsy-chat-report"), "The chat keeps a card for it");
  const report = await WhimsyAIReports.get(card.dataset.report);
  const reportTab = await TestUtils.waitForCondition(() => gBrowser.tabs.find(t => t.linkedBrowser.currentURI.spec == PathUtils.toFileURI(report.path)), "The new tab is that file");
  ok(await IOUtils.exists(report.path), "saved as a local file");
  is((await IOUtils.stat(report.path)).permissions & 0o777, 0o600, "readable only by you");
  const updates = await WhimsyAIUpdates.list();
  ok(updates.updates.concat(updates.recent ? [updates.recent] : []).some(u => u.source == "research"), "Research posts to Updates");
  BrowserTestUtils.removeTab(reportTab);
  await BrowserTestUtils.switchTab(gBrowser, tab);
  EventUtils.synthesizeMouseAtCenter(card.querySelector(".whimsy-chat-pill-btn"), {});
  await TestUtils.waitForCondition(() => gBrowser.selectedTab.linkedBrowser.currentURI.spec == PathUtils.toFileURI(report.path), "Open tab reopens the file after its tab closed");
  BrowserTestUtils.removeTab(gBrowser.selectedTab);
  await WhimsyAIStore.clear({ kinds: ["reports"] });
  ok(!(await IOUtils.exists(report.path)), "The Fire button clears reports");
  await closeAll(tab);
});

add_task(async function research_keeps_going_with_panel_closed() {
  await fresh();
  WhimsyAIUpdates._resetForTesting();
  const tab = await openOn();
  const g = gate();
  script = async function* () {
    yield { type: "artifact", artifact: { kind: "progress", title: "Deep research", lines: ["Reading 12 sources"] } };
    await g.promise;
    yield { type: "text", delta: "Done: rents ran lower." };
    yield { type: "artifact", artifact: { kind: "report", title: "Closed panel report", markdown: "Rents ran lower.", sources: 2 } };
  };
  type("Do deep research on parking reform");
  await TestUtils.waitForCondition(() => part(".whimsy-chat-research[live]"), "The progress card shows");
  chat().close({ reason: "key" });
  await TestUtils.waitForCondition(() => el().hidden, "Chat closed");
  ok(chat().streams.size, "Research keeps going with the panel closed");
  const tabs = gBrowser.tabs.length;
  g.open();
  await TestUtils.waitForCondition(() => gBrowser.tabs.length == tabs + 1, "The report lands as a tab");
  is(gBrowser.selectedTab, tab, "without taking you away");
  await TestUtils.waitForCondition(async () => {
    const list = await WhimsyAIUpdates.list();
    return list.updates.concat(list.recent ? [list.recent] : []).some(u => u.source == "research");
  }, "and in Updates");
  ok(!chat().isOpen, "Chat stays closed");
  EventUtils.synthesizeKey("e", { accelKey: true });
  await TestUtils.waitForCondition(() => chat().isOpen && chat().ready && part(".whimsy-chat-report"), "Reopening chat shows the report card");
  ok(!part(".whimsy-chat-research[live]"), "in place of the progress card");
  const reportTab = await TestUtils.waitForCondition(() => gBrowser.tabs.find(t => t.linkedBrowser.currentURI.spec.endsWith(".md")), "The report's tab");
  BrowserTestUtils.removeTab(reportTab);
  await WhimsyAIStore.clear({ kinds: ["reports"] });
  await closeAll(tab);
});

add_task(async function image_artifact_save_copy() {
  await fresh();
  const tab = await openOn();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  script = async function* () {
    yield { type: "text", delta: "Here it is." };
    yield { type: "artifact", artifact: { kind: "image", mime: "image/png", data: png, width: 1, height: 1 } };
  };
  type("Make an illustration");
  await answered();
  const card = part(".whimsy-chat-image-card");
  ok(card?.querySelector("img[draggable='true']"), "The image shows and drags out");
  const MockFilePicker = SpecialPowers.MockFilePicker;
  MockFilePicker.init(window.browsingContext);
  const dest = PathUtils.join(PathUtils.tempDir, "whimsy-chat-image.png");
  MockFilePicker.returnValue = MockFilePicker.returnOK;
  MockFilePicker.setFiles([new FileUtils.File(dest)]);
  const saved = await WhimsyChatAnswer.saveImage(window, { kind: "image", mime: "image/png", data: png });
  MockFilePicker.cleanup();
  is(saved, dest, "Save writes the file");
  ok((await IOUtils.read(dest)).length > 10, "with the image");
  await IOUtils.remove(dest);
  ok(WhimsyChatAnswer.copyImage(window, { kind: "image", mime: "image/png", data: png }), "Copy puts it on the clipboard");
  ok(Services.clipboard.hasDataMatchingFlavors(["image/png"], Ci.nsIClipboard.kGlobalClipboard), "as an image");
  await closeAll(tab);
});
