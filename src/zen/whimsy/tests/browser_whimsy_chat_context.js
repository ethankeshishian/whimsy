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

add_task(async function chips_show_counts_and_label() {
  const tab = await openOn();
  const chip = part(".whimsy-chat-chip[data-kind='tab']");
  ok(chip.closest(".whimsy-chat-composer"), "Chips sit inside the composer");
  const body = chip.querySelector(".whimsy-chat-chip-body");
  await TestUtils.waitForCondition(() => body.getAttribute("aria-label")?.startsWith("This tab, text"), "Screen readers get the words");
  ok(chip.querySelector(".whimsy-chat-chip-summary > .whimsy-chat-chip-count[data-kind='text']"), "Contents are one quiet line of words");
  ok(!chip.querySelector(".whimsy-chat-chip-count .whimsy-chat-icon"), "...with no glyphs");
  ok(chip.querySelector(".whimsy-chat-chip-mark"), "led by the source's mark");
  // W25 designfix: the chip is the composer's Add chip: same height,
  // radius, hairline, type, and a regular-weight name led by the favicon.
  const add = part(".whimsy-chat-chip-add");
  const [c, a] = [getComputedStyle(chip), getComputedStyle(add)];
  for (const prop of ["height", "border-top-left-radius", "font-size", "background-color"]) {
    is(c.getPropertyValue(prop), a.getPropertyValue(prop), `The context chip shares the Add chip's ${prop}`);
  }
  is(getComputedStyle(chip.querySelector(".whimsy-chat-chip-label")).fontWeight, "400", "The name is regular weight");
  is(chip.querySelector(".whimsy-chat-chip-mark").localName, "img", "A tab leads with its favicon");
  is(getComputedStyle(chip.querySelector(".whimsy-chat-chip-summary")).color, getComputedStyle(chip.querySelector(".whimsy-chat-chip-count")).color, "The contents line is one colour");
  const x = chip.querySelector(".whimsy-chat-chip-x");
  ok(x.localName == "button" && x.tabIndex >= 0 && x.checkVisibility(), "× is a visible button in the tab order");
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

add_task(async function split_view_one_chat_chip_per_pane() {
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, "whimsy-chat-context-" + Math.random().toString(16).slice(2)));
  calls = [];
  const a = await BrowserTestUtils.openNewForegroundTab(gBrowser, ARTICLE);
  const b = await BrowserTestUtils.openNewForegroundTab(gBrowser, OTHER);
  gZenViewSplitter.splitTabs([a, b], "vsep");
  await TestUtils.waitForCondition(() => gZenViewSplitter._data.find(g => g.tabs.includes(a))?.tabs.length == 2, "Split");
  if (!chat().isOpen) {
    EventUtils.synthesizeKey("e", { accelKey: true });
  }
  await TestUtils.waitForCondition(() => chat().isOpen && chat().ready, "Chat open");
  await TestUtils.waitForCondition(() => parts(".whimsy-chat-chip[data-kind='pane']").length == 2, "One chip per pane");
  type("Compare these");
  await answered();
  ok(calls.at(-1).request.system.includes("Buffalo"), "The first pane is sent");
  ok(calls.at(-1).request.system.includes(OTHER), "and so is the second");
  const threadId = chat().thread.id;
  const other = gBrowser.selectedTab == a ? b : a;
  gBrowser.selectedTab = other;
  await TestUtils.waitForTick();
  await TestUtils.waitForCondition(() => chat().ready, "Chat settled after the focus change");
  is(chat().thread.id, threadId, "Focusing the other pane keeps the split's one chat");
  is(parts(".whimsy-chat-msg[data-role='ai']").length, 1, "with its answer");
  is(parts(".whimsy-chat-chip[data-kind='pane']").length, 2, "and both chips");
  gZenViewSplitter.unsplitCurrentView();
  await closeAll(a, b);
});

add_task(async function granola_live_chip_while_panel_closed() {
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, "whimsy-chat-context-" + Math.random().toString(16).slice(2)));
  calls = [];
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, ARTICLE);
  ok(!chat().isOpen, "Chat is closed");
  WhimsyChatContextUI.setLiveChip(window, {
    id: "granola",
    kind: "granola",
    label: "Granola",
    counts: { text: 1 },
    parts: [{ chipId: "granola", kind: "text", size: 30, text: "Meeting notes: ship on Friday" }],
  });
  ok(!chat().isOpen, "A meeting starting doesn't open chat");
  EventUtils.synthesizeKey("e", { accelKey: true });
  const chip = await TestUtils.waitForCondition(() => chat().isOpen && chat().ready && part(".whimsy-chat-chip[data-chip='granola']"), "Opening chat shows the Granola chip");
  ok(chip.hasAttribute("live"), "marked live");
  ok(part(".whimsy-chat-chip[data-kind='tab']"), "beside this tab's chip");
  type("What did we decide?");
  await answered();
  ok(calls.at(-1).request.system.includes("ship on Friday"), "The meeting's notes are sent");
  chat().close({ reason: "key" });
  await TestUtils.waitForCondition(() => el().hidden, "Chat closed");
  WhimsyChatContextUI.setLiveChip(window, null);
  EventUtils.synthesizeKey("e", { accelKey: true });
  await TestUtils.waitForCondition(() => chat().isOpen && chat().ready && part(".whimsy-chat-chip[data-kind='tab']"), "Chat open again");
  ok(!part(".whimsy-chat-chip[data-chip='granola']"), "The chip goes when the meeting ends");
  await closeAll(tab);
});
