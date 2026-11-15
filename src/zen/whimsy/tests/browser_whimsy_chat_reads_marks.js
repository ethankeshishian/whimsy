/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W28 tab-state-indicators (option A, the sparkle badge): [whimsy-chat-reads]
// (+ [whimsy-chat-reading] while answering) tracks the open chat's context,
// appearing/disappearing in sync with attachment, honoring
// prefers-reduced-motion, and never landing on the selected tab.

const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyChatContextUI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatContextUI.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");

const ARTICLE = "https://example.com/browser/zen/whimsy/tests/whimsy_chat_article.html";
const OTHER = "https://example.org/?other";
const chat = () => WhimsyChatPanel.forWindow(window);
const el = () => document.getElementById("whimsy-chat");
const part = sel => el().querySelector(sel);
let calls = [];

async function openOn(url = ARTICLE) {
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, "whimsy-chat-reads-" + Math.random().toString(16).slice(2)));
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

const answered = () => TestUtils.waitForCondition(() => !part(".whimsy-chat-msg[data-role='ai'][busy]") && [...el().querySelectorAll(".whimsy-chat-msg[data-role='ai']")].length, "The answer is in");

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
  });
});

// The marker appears/disappears in sync with chat attachment (chip add,
// chat close, and a chip removal via x).
add_task(async function marker_tracks_attachment() {
  const tab = await openOn();
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, OTHER);
  await TestUtils.waitForCondition(() => tab.hasAttribute("whimsy-chat-reads"), "The attached tab's own chat marks it");
  ok(!other.hasAttribute("whimsy-chat-reads"), "A tab with no chip stays unmarked");

  const dataTransfer = new DataTransfer();
  dataTransfer.mozSetDataAt("application/x-moz-tabbrowser-tab", other, 0);
  const drop = new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true });
  part(".whimsy-chat-composer").dispatchEvent(drop);
  await TestUtils.waitForCondition(() => [...el().querySelectorAll(".whimsy-chat-chip:not(.whimsy-chat-chip-add)")].length == 2, "The dropped tab becomes a chip");
  await TestUtils.waitForCondition(() => other.hasAttribute("whimsy-chat-reads"), "Dropping a tab into the chat marks it too");

  EventUtils.synthesizeMouseAtCenter(part(".whimsy-chat-chip[data-kind='tab'] .whimsy-chat-chip-x"), {});
  await TestUtils.waitForCondition(() => !tab.hasAttribute("whimsy-chat-reads"), "x-ing a chip clears the mark right away");
  ok(other.hasAttribute("whimsy-chat-reads"), "the other chip's mark survives");

  chat().close({ reason: "key" });
  await TestUtils.waitForCondition(() => el().hidden, "Chat closed");
  ok(!other.hasAttribute("whimsy-chat-reads"), "Closing the chat clears every remaining mark");
  ok(!other.hasAttribute("aria-description"), "...and the aria-description with it");

  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(tab);
});

// Never the selected tab, even though it has the chip for its own content.
add_task(async function never_on_the_selected_tab() {
  const tab = await openOn();
  ok(!tab.hasAttribute("selected") || !tab.hasAttribute("whimsy-chat-reads"), "sanity: selected and reads-marked are mutually exclusive");
  is(gBrowser.selectedTab, tab, "This is the selected tab");
  ok(!tab.hasAttribute("whimsy-chat-reads"), "The selected tab is never marked, even though it's what the chat reads");
  await closeAll(tab);
});

// "All my tabs" marks every eligible tab (not the selected one, not a
// private one), and the mark goes when the widened chip is removed.
add_task(async function all_my_tabs_marks_every_eligible_tab() {
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, OTHER);
  const priv = WhimsyPrivate.openPrivateTab(window, { url: OTHER + "&private", force: true });
  await BrowserTestUtils.browserLoaded(priv.linkedBrowser);
  const tab = await openOn();
  type("Which of all my tabs mention parking?");
  await answered();
  await TestUtils.waitForCondition(() => part(".whimsy-chat-chip[data-kind='tabs']"), "The widened chip shows");
  await TestUtils.waitForCondition(() => other.hasAttribute("whimsy-chat-reads"), "All my tabs marks the other tab");
  ok(!tab.hasAttribute("whimsy-chat-reads"), "...but not the selected tab");
  ok(!priv.hasAttribute("whimsy-chat-reads"), "...and not the private tab");
  await closeAll(tab, priv, other);
});

// The "Reading" state ([whimsy-chat-reading]) tracks whether the thread is
// actively answering, separate from plain attachment.
add_task(async function reading_state_tracks_streaming() {
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, OTHER);
  const tab = await openOn();
  const dataTransfer = new DataTransfer();
  dataTransfer.mozSetDataAt("application/x-moz-tabbrowser-tab", other, 0);
  const drop = new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true });
  part(".whimsy-chat-composer").dispatchEvent(drop);
  await TestUtils.waitForCondition(() => other.hasAttribute("whimsy-chat-reads"), "Attached and marked");
  ok(!other.hasAttribute("whimsy-chat-reading"), "Not reading yet: no message sent");

  chat().composer.focus();
  EventUtils.sendString("Go");
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(() => other.hasAttribute("whimsy-chat-reading"), "Reading while the answer streams");
  await answered();
  await TestUtils.waitForCondition(() => !other.hasAttribute("whimsy-chat-reading"), "Reading ends once the answer lands");
  ok(other.hasAttribute("whimsy-chat-reads"), "...but it's still attached");
  await closeAll(tab, other);
});

// Reduced motion disables both the pop-in and the twinkle.
add_task(async function reduced_motion_disables_the_animation() {
  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 1]] });
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, OTHER);
  const tab = await openOn();
  const dataTransfer = new DataTransfer();
  dataTransfer.mozSetDataAt("application/x-moz-tabbrowser-tab", other, 0);
  const drop = new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true });
  part(".whimsy-chat-composer").dispatchEvent(drop);
  await TestUtils.waitForCondition(() => other.hasAttribute("whimsy-chat-reads"), "Attached and marked");
  const badge = () => other.querySelector(".tab-icon-stack");
  is(getComputedStyle(badge(), "::before").animationName, "none", "No pop-in animation under reduced motion");

  chat().composer.focus();
  EventUtils.sendString("Go");
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(() => other.hasAttribute("whimsy-chat-reading"), "Reading while the answer streams");
  is(getComputedStyle(badge(), "::before").animationName, "none", "No twinkle animation under reduced motion either");
  await answered();
  await closeAll(tab, other);
  await SpecialPowers.popPrefEnv();
});
