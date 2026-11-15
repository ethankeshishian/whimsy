/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W28 tab-state-indicators (option A, the sparkle badge): [whimsy-chat-reads]
// (+ [whimsy-chat-reading] while answering) tracks the open chat's context,
// appearing/disappearing in sync with attachment, honoring
// prefers-reduced-motion, and never landing on the selected tab.

const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyAIContext } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIContext.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");

const ARTICLE = "https://example.com/browser/zen/whimsy/tests/whimsy_chat_article.html";
const OTHER = "https://example.org/?other";
const chat = () => WhimsyChatPanel.forWindow(window);
const el = () => document.getElementById("whimsy-chat");
const part = sel => el().querySelector(sel);
// A chip's data-chip is `${kind}:${tabKey}` (WhimsyAIContext.chipFor); this
// picks the x for one specific tab's chip among several "tab" chips.
const tabChipX = tab => part(`.whimsy-chat-chip[data-chip="tab:${CSS.escape(WhimsyAIContext.tabKey(tab))}"] .whimsy-chat-chip-x`);
let calls = [];
const defaultProvider = async function* (provider, request) {
  calls.push({ provider, request });
  yield { type: "text", delta: "Answer to " + request.lastUserText };
};
function gate() {
  let open;
  const promise = new Promise(r => (open = r));
  return { promise, open };
}

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
  WhimsyAIProviders.setTestProvider(defaultProvider);
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
// chat close, and a chip removal via x). `other` is opened before the
// chat (as the other journeys here do), because opening a foreground tab
// while the chat is already open switches it to that tab's own thread
// (onSelect -> showTab in WhimsyChatPanel.init), which would move the
// chat's attachment off `tab` entirely.
add_task(async function marker_tracks_attachment() {
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, OTHER);
  const tab = await openOn();
  ok(!other.hasAttribute("whimsy-chat-reads"), "A tab with no chip stays unmarked");
  ok(!tab.hasAttribute("whimsy-chat-reads"), "The selected tab is never marked, even though it's attached");

  const drop = () => {
    const dataTransfer = new DataTransfer();
    dataTransfer.mozSetDataAt("application/x-moz-tabbrowser-tab", other, 0);
    part(".whimsy-chat-composer").dispatchEvent(new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true }));
  };
  drop();
  await TestUtils.waitForCondition(() => [...el().querySelectorAll(".whimsy-chat-chip:not(.whimsy-chat-chip-add)")].length == 2, "The dropped tab becomes a chip");
  await TestUtils.waitForCondition(() => other.hasAttribute("whimsy-chat-reads"), "Dropping a tab into the chat marks it too");
  await TestUtils.waitForCondition(() => other.getAttribute("aria-description") == "Chat reads this tab", "...with an aria-description to match");

  EventUtils.synthesizeMouseAtCenter(tabChipX(other), {});
  await TestUtils.waitForCondition(() => !other.hasAttribute("whimsy-chat-reads") && !other.hasAttribute("aria-description"), "x-ing its chip clears the mark right away");

  drop();
  await TestUtils.waitForCondition(() => other.hasAttribute("whimsy-chat-reads"), "Dropping it back in marks it again");

  chat().close({ reason: "key" });
  await TestUtils.waitForCondition(() => el().hidden, "Chat closed");
  ok(!other.hasAttribute("whimsy-chat-reads") && !other.hasAttribute("aria-description"), "Closing the chat clears every remaining mark");

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
// actively answering, separate from plain attachment. The test provider's
// default resolves in one microtask, too fast to ever observe the
// transient reading=true state by polling, so this task gates the stream
// open (browser_whimsy_chat_answer.js's gate() pattern) and restores the
// default provider afterward for the tasks that follow.
add_task(async function reading_state_tracks_streaming() {
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, OTHER);
  const tab = await openOn();
  const dataTransfer = new DataTransfer();
  dataTransfer.mozSetDataAt("application/x-moz-tabbrowser-tab", other, 0);
  const drop = new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true });
  part(".whimsy-chat-composer").dispatchEvent(drop);
  await TestUtils.waitForCondition(() => other.hasAttribute("whimsy-chat-reads"), "Attached and marked");
  ok(!other.hasAttribute("whimsy-chat-reading"), "Not reading yet: no message sent");

  const g = gate();
  WhimsyAIProviders.setTestProvider(async function* (provider, request) {
    calls.push({ provider, request });
    yield { type: "text", delta: "Working" };
    await g.promise;
    yield { type: "text", delta: " on it." };
  });
  chat().composer.focus();
  EventUtils.sendString("Go");
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(() => other.hasAttribute("whimsy-chat-reading"), "Reading while the answer streams");
  g.open();
  await answered();
  await TestUtils.waitForCondition(() => !other.hasAttribute("whimsy-chat-reading"), "Reading ends once the answer lands");
  ok(other.hasAttribute("whimsy-chat-reads"), "...but it's still attached");
  WhimsyAIProviders.setTestProvider(defaultProvider);
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

  const g = gate();
  WhimsyAIProviders.setTestProvider(async function* (provider, request) {
    calls.push({ provider, request });
    yield { type: "text", delta: "Working" };
    await g.promise;
    yield { type: "text", delta: " on it." };
  });
  chat().composer.focus();
  EventUtils.sendString("Go");
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(() => other.hasAttribute("whimsy-chat-reading"), "Reading while the answer streams");
  is(getComputedStyle(badge(), "::before").animationName, "none", "No twinkle animation under reduced motion either");
  g.open();
  await answered();
  await closeAll(tab, other);
  await SpecialPowers.popPrefEnv();
});
