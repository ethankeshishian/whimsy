/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 cmdbar-ai: the Ask row and the answer card under the command bar.

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_cmdbar_ai.js", this);

add_setup(async function () {
  await setupAI();
});

add_task(async function ask_row_second_for_question_only() {
  await freshStore();
  await typeInBar(Q);
  const all = rows();
  ok(askRow(), "A question gets the Ask row");
  is(all.indexOf(askRow()), 1, "It's the second row");
  is(gURLBar.view.selectedRowIndex, 0, "The first (heuristic) result stays selected");
  ok(askRow().textContent.includes(Q), "The row is the question");
  await typeInBar("macbook air");
  ok(!askRow(), "Plain words get no Ask row");
  await typeInBar("summarize the battery section here");
  ok(askRow(), "A request with 3+ words gets one");
  await closeBar();
});

add_task(async function never_for_url_like() {
  for (const t of ["theverge.com/2026/laptops", "https://what.com/why?", "localhost:3000/how", "about:config", "/usr/bin/what"]) {
    ok(!looksLikeQuestion(t), `"${t}" isn't a question`);
  }
  for (const t of ["how do magnets work", "is it raining in paris?", "explain this page please", "What is this?"]) {
    ok(looksLikeQuestion(t), `"${t}" is`);
  }
  await typeInBar("theverge.com/2026/laptops");
  ok(!askRow(), "URL-like input never gets the Ask row");
  await closeBar();
});

add_task(async function cmd_return_asks_from_anywhere() {
  await freshStore();
  await typeInBar(Q);
  is(gURLBar.view.selectedRowIndex, 0, "The search row is selected");
  EventUtils.synthesizeKey("KEY_Enter", { accelKey: true });
  await TestUtils.waitForCondition(() => calls.length == 1, "⌘↩ asked");
  is(calls[0].request.task, "ask", "as an Ask");
  await answered();
  await closeBar();
  await freshStore();
  await typeInBar(Q);
  EventUtils.synthesizeKey("KEY_ArrowDown");
  is(gURLBar.view.selectedElement?.closest(".urlbarView-row"), askRow(), "↓ selects the Ask row");
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(() => calls.length == 1, "↓ then Enter asks");
  await answered();
  await closeBar();
});

add_task(async function question_moves_into_card_input_clears() {
  await freshStore();
  await askWithKeys();
  is(cardEl().querySelector(".whimsy-ask-q").textContent, Q, "The question is in the card");
  is(gURLBar.value, "", "The input cleared for a follow-up");
  ok(gURLBar.hasAttribute("whimsy-ask"), "The Ask AI pill shows");
  is(document.l10n.getAttributes(gURLBar.inputField).id, "whimsy-cmdbar-ask-followup", "Placeholder asks for a follow-up");
  await answered();
  ok(cardEl().querySelector(".whimsy-ask-body").textContent.includes("2.7 lb"), "The answer shows");
  is(rows().length, 1, "The card is the only thing under the input");
  await closeBar();
  ok(!gURLBar.hasAttribute("whimsy-ask"), "Closing leaves Ask mode");
});

add_task(async function esc_stops_and_keeps_in_chat_list() {
  await freshStore();
  const g = gate();
  let signal = null;
  script = async function* (_p, request) {
    signal = request.signal;
    yield { type: "text", delta: "The 13-inch" };
    await g.promise;
  };
  await askWithKeys();
  await TestUtils.waitForCondition(() => cardEl().querySelector(".whimsy-ask-body"), "Streaming");
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(() => !gURLBar.view.isOpen, "Esc closed the bar");
  ok(signal?.aborted, "and stopped the stream");
  g.open();
  await TestUtils.waitForCondition(async () => (await WhimsyAIStore.threads({ kind: "cmdbar" })).length == 1, "The exchange is in chat's list");
  ok(!WhimsyChat.isOpen(window), "Chat didn't open");
  if (gURLBar.focused) {
    gBrowser.selectedBrowser.focus();
  }
});

function citing(url, title) {
  return async function* () {
    yield { type: "text", delta: "The 13-inch is the lightest." };
    yield { type: "citation", n: 1, source: { url, title } };
    yield { type: "text", delta: " The 15-inch is heavier." };
  };
}

add_task(async function open_source_beside_and_close() {
  await freshStore();
  const asking = await BrowserTestUtils.openNewForegroundTab(gBrowser, ARTICLE);
  await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  gBrowser.selectedTab = asking;
  const url = "https://example.org/browser/zen/whimsy/tests/whimsy_chat_article.html";
  script = citing(url, "Tech Specs");
  await askWithKeys();
  await answered();
  const chip = cardEl().querySelector(".whimsy-ask-source");
  ok(chip, "A source chip matches the citation");
  ok(cardEl().querySelector(".whimsy-ask-body .whimsy-ask-cite"), "and a numbered citation in the text");
  const loaded = BrowserTestUtils.waitForNewTab(gBrowser, url);
  EventUtils.synthesizeMouseAtCenter(chip, {});
  const tab = await loaded;
  is(tab._tPos, asking._tPos + 1, "The source opens beside the asking tab");
  is(gBrowser.selectedTab, tab, "and is selected");
  await TestUtils.waitForCondition(() => !gURLBar.view.isOpen, "The bar closed");
  ok(WhimsyAIUpdates.recentAnswer(), "The answer is the Recent answer");
  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
  BrowserTestUtils.removeTab(asking);
});

add_task(async function cmd_click_background_keeps_card() {
  await freshStore();
  const url = "https://example.org/browser/zen/whimsy/tests/whimsy_chat_article.html";
  script = citing(url, "Tech Specs");
  const before = gBrowser.selectedTab;
  await askWithKeys();
  await answered();
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, url);
  EventUtils.synthesizeMouseAtCenter(cardEl().querySelector(".whimsy-ask-source"), { accelKey: true });
  const tab = await opened;
  is(gBrowser.selectedTab, before, "⌘-click opens in the background");
  ok(gURLBar.view.isOpen && cardEl(), "and keeps the card");
  await TestUtils.waitForCondition(() => cardEl().querySelector(".whimsy-ask-source[visited]"), "The source is marked Opened");
  await closeBar();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function wording_open_in_chat_and_continue_in_chat() {
  await freshStore();
  await askWithKeys();
  await answered();
  const foot = () => cardEl().querySelector(".whimsy-ask-foot");
  is(document.l10n.getAttributes(foot().querySelector("[data-action='open-in-chat'] span")).id, "whimsy-cmdbar-open-in-chat", "Done: Open in chat ⌘↩");
  EventUtils.sendString("and which one has the better battery");
  await TestUtils.waitForCondition(() => foot().querySelector("[data-action='continue']"), "Typing swaps in Continue in chat ↩");
  ok(!foot().querySelector("[data-action='open-in-chat']"), "No duplicate way forward");
  const thread = WhimsyCommandBarAI.card(window).threadId;
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(() => WhimsyChat.isOpen(window), "Enter continued in chat");
  await TestUtils.waitForCondition(() => calls.length == 2, "The follow-up was sent there");
  const messages = await WhimsyAIStore.messages(thread);
  ok(messages.some(m => m.role == "user" && m.text == Q), "The thread has the first question");
  await TestUtils.waitForCondition(async () => (await WhimsyAIStore.messages(thread)).some(m => m.text == "and which one has the better battery"), "and the follow-up");
  WhimsyChat.close(window, { reason: "key" });
  for (const l10nId of ["whimsy-cmdbar-ask-ai", "whimsy-cmdbar-open-in-chat", "whimsy-cmdbar-continue-in-chat"]) {
    ok(await document.l10n.formatValue(l10nId), `${l10nId} has copy`);
  }
  is(await document.l10n.formatValue("whimsy-cmdbar-ask-ai"), "Ask AI", "Ask AI");
  is(await document.l10n.formatValue("whimsy-cmdbar-open-in-chat"), "Open in chat", "Open in chat");
  is(await document.l10n.formatValue("whimsy-cmdbar-continue-in-chat"), "Continue in chat", "Continue in chat");
});

add_task(async function handoff_line_in_card() {
  await freshStore();
  script = async function* () {
    yield { type: "handoff", from: "claude", to: "openai", reason: "quota" };
    yield { type: "text", delta: "ChatGPT here." };
  };
  await askWithKeys();
  await answered();
  const line = cardEl().querySelector(".whimsy-ask-line[tone='info']");
  ok(line, "One handoff line in the card");
  is(document.l10n.getAttributes(line.querySelector("span")).id, "whimsy-cmdbar-handoff", "It names who took it");
  await closeBar();
});

add_task(async function errors_are_one_line_with_a_next_step() {
  await freshStore();
  script = async function* () {
    const e = new Error("down");
    e.code = "provider-down";
    throw e;
    // eslint-disable-next-line no-unreachable
    yield null;
  };
  await askWithKeys();
  await TestUtils.waitForCondition(() => cardEl().querySelector(".whimsy-ask-line[role='alert']"), "An error line");
  const line = cardEl().querySelector(".whimsy-ask-line[role='alert']");
  ok(line.querySelector("[data-action='retry']"), "with Try again");
  await closeBar();
});

add_task(async function private_bar_has_no_ask() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  await typeInBar(Q, win);
  ok(!askRow(win), "No Ask row in a private bar");
  await closeBar(win);
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function ai_off_no_ask_row_set_up_ai_when_typed() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", false]] });
  await typeInBar(Q);
  ok(!askRow(), "AI off: no Ask row");
  for (const t of ["ai", "claude", "chatgpt", "set up"]) {
    await typeInBar(t);
    const row = askRow();
    ok(row, `"${t}" offers Set up AI`);
    is(document.l10n.getAttributes(row.querySelector(".urlbarView-title")).id, "whimsy-cmdbar-setup-ai", "Set up AI…");
  }
  await closeBar();
  await SpecialPowers.popPrefEnv();
});

add_task(async function rtl_and_live_region() {
  await freshStore();
  script = async function* () {
    yield { type: "text", delta: "מקבוק אייר 13 אינץ׳ שוקל 1.24 ק״ג." };
  };
  await askWithKeys("כמה שוקל מקבוק אייר 13?");
  await answered();
  is(cardEl().getAttribute("dir"), "rtl", "The card follows the text's direction");
  is(cardEl().getAttribute("role"), "status", "The card is a status region");
  is(cardEl().getAttribute("aria-live"), "polite", "and polite");
  is(cardEl().getAttribute("aria-busy"), "false", "not busy once done");
  is(document.activeElement, gURLBar.inputField, "Focus stays in the input");
  await closeBar();
});
