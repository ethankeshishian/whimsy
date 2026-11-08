/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 chat-answers: context chips in the composer, widening, Leave out
// with Undo, drops, and What AI sees.

const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyChatContextUI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatContextUI.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyAIContext } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIContext.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");

const ARTICLE = "https://example.com/browser/zen/whimsy/tests/whimsy_chat_article.html";
const OTHER = "https://example.org/?other";
const chat = () => WhimsyChatPanel.forWindow(window);
const el = () => document.getElementById("whimsy-chat");
const part = sel => el().querySelector(sel);
const parts = sel => [...el().querySelectorAll(sel)];
let calls = [];

async function openOn(url = ARTICLE) {
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, "whimsy-chat-context-" + Math.random().toString(16).slice(2)));
  calls = [];
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  if (!chat().isOpen) {
    EventUtils.synthesizeKey("e", { accelKey: true });
  }
  await TestUtils.waitForCondition(() => chat().isOpen && chat().ready && part(".whimsy-chat-chip[data-kind='tab']"), "Chat is open with its chip");
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

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", true], ["whimsy.feature.ai-hints", false], ["whimsy.ai.order", "claude"], ["whimsy.ai.off", ""]] });
  WhimsyAIProviders.setTestProvider(async function* (provider, request) {
    calls.push({ provider, request });
    yield { type: "text", delta: "Answer to " + request.lastUserText };
  });
  registerCleanupFunction(() => {
    WhimsyAIProviders.setTestProvider(null);
    Services.prefs.clearUserPref("whimsy.ai.hints.seen");
  });
});

add_task(async function chips_show_counts_and_label() {
  const tab = await openOn();
  const chip = part(".whimsy-chat-chip[data-kind='tab']");
  ok(chip.closest(".whimsy-chat-composer"), "Chips sit inside the composer");
  const body = chip.querySelector(".whimsy-chat-chip-body");
  await TestUtils.waitForCondition(() => body.getAttribute("aria-label")?.startsWith("This tab, text"), "Screen readers get the words");
  ok(chip.querySelector(".whimsy-chat-chip-count[data-kind='text']"), "Counts are icons");
  ok(chip.querySelector(".whimsy-chat-chip-mark"), "led by the source's mark");
  await closeAll(tab);
});

add_task(async function all_my_tabs_widens_and_notes_left_out() {
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, OTHER);
  const priv = WhimsyPrivate.openPrivateTab(window, { url: OTHER + "&private", force: true });
  await BrowserTestUtils.browserLoaded(priv.linkedBrowser);
  const tab = await openOn();
  type("Which of all my tabs mention parking?");
  await answered();
  const used = await TestUtils.waitForCondition(() => part(".whimsy-chat-used"), "A Used line sits under the message");
  await TestUtils.waitForCondition(() => used.textContent.startsWith("Used all my tabs"), "naming what it used");
  const note = part(".whimsy-chat-note[data-kind='left-out']");
  ok(note, "Left out says so");
  await TestUtils.waitForCondition(() => note.textContent.includes("1 private tab"), "counting the private tab");
  ok(!calls.at(-1).request.system.includes("&private"), "The private tab never reaches the model");
  ok(calls.at(-1).request.system.includes(OTHER), "The other tab does");
  await TestUtils.waitForCondition(() => part(".whimsy-chat-chip[data-kind='tabs']"), "The widened chip stays for the chat");
  await closeAll(tab, priv, other);
});

add_task(async function remove_chip_note_line_undo() {
  const tab = await openOn();
  EventUtils.synthesizeMouseAtCenter(part(".whimsy-chat-chip[data-kind='tab'] .whimsy-chat-chip-x"), {});
  await TestUtils.waitForCondition(() => !part(".whimsy-chat-chip[data-kind='tab']"), "× leaves the tab out");
  const note = await TestUtils.waitForCondition(() => part(".whimsy-chat-note[data-kind='chip-removed']"), "One note line says so");
  type("Anything?");
  await answered();
  ok(!calls.at(-1).request.system.includes("Buffalo"), "The page isn't sent");
  EventUtils.synthesizeMouseAtCenter(note.querySelector(".whimsy-chat-link"), {});
  await TestUtils.waitForCondition(() => part(".whimsy-chat-chip[data-kind='tab']"), "Undo brings it back");
  ok(!part(".whimsy-chat-note[data-kind='chip-removed']"), "and the line goes");
  await closeAll(tab);
});

add_task(async function drop_tab_adds_chip() {
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, OTHER);
  const tab = await openOn();
  const dataTransfer = new DataTransfer();
  dataTransfer.mozSetDataAt("application/x-moz-tabbrowser-tab", other, 0);
  const drop = new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true });
  part(".whimsy-chat-composer").dispatchEvent(drop);
  await TestUtils.waitForCondition(() => parts(".whimsy-chat-chip:not(.whimsy-chat-chip-add)").length == 2, "The dropped tab becomes a chip");
  type("Compare them");
  await answered();
  ok(calls.at(-1).request.system.includes(OTHER), "and is sent with the next message");
  await closeAll(tab, other);
});

add_task(async function what_ai_sees_rows_drill_in_and_leave_out() {
  const tab = await openOn();
  EventUtils.synthesizeMouseAtCenter(part(".whimsy-chat-chip[data-kind='tab'] .whimsy-chat-chip-body"), {});
  const sheet = await TestUtils.waitForCondition(() => part(".whimsy-chat-sheet .whimsy-chat-sees-row"), "Tapping the chip opens What AI sees");
  const dest = part(".whimsy-chat-sees-dest-detail");
  await TestUtils.waitForCondition(() => dest.textContent.includes("API key") && dest.textContent.includes("Leaves this Mac"), "It names where it goes and how");
  ok(sheet, "one row per kind");
  EventUtils.synthesizeMouseAtCenter(part(".whimsy-chat-sees-row[data-kind='text']"), {});
  await TestUtils.waitForCondition(() => part(".whimsy-chat-sees-text")?.textContent.includes("Buffalo"), "Drilling in shows the text sent");
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(() => part(".whimsy-chat-sheet-view[data-view='list']") && !part(".whimsy-chat-sees-text"), "Esc goes back to the list");
  const leave = [...part(".whimsy-chat-sheet-foot").querySelectorAll("button")].find(b => b.textContent == "Leave out");
  EventUtils.synthesizeMouseAtCenter(leave, {});
  await TestUtils.waitForCondition(() => !part(".whimsy-chat-chip[data-kind='tab']") && !part(".whimsy-chat-sheet"), "Leave out drops the chip");
  ok(chat().isOpen, "Chat stays open");
  await closeAll(tab);
});
