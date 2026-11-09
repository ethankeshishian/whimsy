/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23: discovery hints. Zen's toast, once ever, a queue of one, 2s apart,
// three a day, only while the surface shows, Got it only, Esc never
// dismisses, and none while AI is off except voice and image text.

const { WhimsyAIHints } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIHints.sys.mjs");

const FAST = { gapMs: 300, seenMs: 150, timeoutMs: 1500, pollMs: 50 };

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.ai.enabled", true],
    ["whimsy.ai.hints.seen", ""],
    ["whimsy.ai.hints.today", ""],
  ] });
  WhimsyAIHints._resetForTesting();
  WhimsyAIHints._setTimingForTesting(FAST);
  registerCleanupFunction(() => {
    WhimsyAIHints._restoreForTesting();
    WhimsyAIHints._setTimingForTesting(null);
    WhimsyAIHints._setTodayForTesting(null);
  });
});

async function resetHints() {
  WhimsyAIHints._resetForTesting();
  closeToasts();
  Services.prefs.setStringPref("whimsy.ai.hints.seen", "");
  Services.prefs.setStringPref("whimsy.ai.hints.today", "");
}

function hintToast() {
  return gZenUIManager.toasts.getToasts().find(t => t.element.hasAttribute("whimsy-ai-hint")) ?? null;
}

async function waitForHint(id) {
  await TestUtils.waitForCondition(() => hintToast()?.element.getAttribute("whimsy-ai-hint") == id, `The ${id} hint shows`);
  const toast = hintToast();
  await toast.shown;
  return toast;
}

async function waitNoHint() {
  await TestUtils.waitForCondition(() => !WhimsyAIHints.current, "No hint showing");
}

add_task(async function hint_once_ever_queue_and_daily_cap() {
  await resetHints();
  let visible = true;
  for (const id of ["ask", "chat", "updates", "context-commands"]) {
    WhimsyAIHints.register({ id, isVisible: () => visible });
  }

  ok(WhimsyAIHints.request(window, "ask"), "The Ask hint is taken");
  const ask = await waitForHint("ask");
  await document.l10n.translateFragment(ask.element);
  ok(ask.element.textContent.includes("Ask AI from here"), "Its title");
  ok(ask.element.textContent.includes("Type a question, then press ⌘↩."), "Its line");
  const buttons = [...ask.element.querySelectorAll(".whimsy-toast-button")];
  is(buttons.length, 1, "One button");
  ok(buttons[0].textContent.includes("Got it"), "Got it");
  ok(!ask.element.querySelector(".whimsy-toast-close"), "No close button");

  ok(WhimsyAIHints.request(window, "chat"), "A second hint waits in line");
  ok(!WhimsyAIHints.request(window, "updates"), "A third is dropped: the queue holds one");
  is(WhimsyAIHints.waiting, "chat", "Chat is the one waiting");

  // Esc never dismisses a hint.
  buttons[0].focus();
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  await new Promise(r => setTimeout(r, 100));
  is(hintToast(), ask, "Esc leaves the hint up");

  await TestUtils.waitForCondition(() => WhimsyAIHints.seen("ask"), "Shown long enough: seen");
  const closedAt = Date.now();
  EventUtils.synthesizeMouseAtCenter(buttons[0], {}, window);
  const chat = await waitForHint("chat");
  ok(Date.now() - closedAt >= FAST.gapMs - 20, "The next hint comes after the gap");
  ok(!WhimsyAIHints.request(window, "ask"), "A seen hint never shows again");

  WhimsyAIHints.used("chat");
  ok(WhimsyAIHints.seen("chat"), "Using the feature counts as seen");
  await waitNoHint();
  ok(!hintToast() || hintToast() != chat, "...and takes the hint down");

  // A third hint today, then the cap.
  ok(WhimsyAIHints.request(window, "updates"), "The third hint today");
  await waitForHint("updates");
  await TestUtils.waitForCondition(() => WhimsyAIHints.seen("updates"), "Seen");
  hintToast().close({ instant: true });
  await waitNoHint();
  ok(!WhimsyAIHints.request(window, "context-commands"), "Three a day at most");
  WhimsyAIHints._setTodayForTesting(() => "2099-01-01");
  ok(WhimsyAIHints.request(window, "context-commands"), "A new day allows more");
  // Gone with its surface, and not seen when cut short.
  await waitForHint("context-commands");
  visible = false;
  await waitNoHint();
  ok(!WhimsyAIHints.seen("context-commands"), "Cut short by its surface leaving: not seen");
  WhimsyAIHints._setTodayForTesting(null);
});

add_task(async function hint_waits_for_real_toasts_and_surface() {
  await resetHints();
  let visible = false;
  WhimsyAIHints.register({ id: "ask", isVisible: () => visible });
  ok(!WhimsyAIHints.request(window, "ask"), "Not while its surface is off screen");
  visible = true;
  const real = gZenUIManager.toasts.open("whimsy-ai-hint-got-it", { timeout: 0, key: "whimsy-test-real" });
  ok(WhimsyAIHints.request(window, "ask"), "Taken");
  await new Promise(r => setTimeout(r, FAST.gapMs * 2));
  ok(!WhimsyAIHints.current, "A real toast wins: the hint waits");
  real.close({ instant: true });
  const ask = await waitForHint("ask");
  ok(true, "Shows once the real toast is gone");
  WhimsyAIHints._setTimingForTesting({ ...FAST, seenMs: 60_000 });
  EventUtils.synthesizeMouseAtCenter(ask.element.querySelector(".whimsy-toast-button"), {}, window);
  await waitNoHint();
  ok(WhimsyAIHints.seen("ask"), "Got it counts as seen, however soon");
  WhimsyAIHints._setTimingForTesting(FAST);
});

// A hint asked for in a window that then closes (waiting behind a real
// toast, or on screen) never holds up the hints of the windows still open.
add_task(async function hint_in_closed_window_frees_the_line() {
  await resetHints();
  // A new window's surfaces register their own hints: these go in after.
  const register = () => {
    for (const id of ["chat", "updates", "ask"]) {
      WhimsyAIHints.register({ id, isVisible: () => true });
    }
  };

  let win = await BrowserTestUtils.openNewBrowserWindow();
  register();
  win.gZenUIManager.toasts.open("whimsy-ai-hint-got-it", { timeout: 0, key: "whimsy-test-real" });
  ok(WhimsyAIHints.request(win, "chat"), "Chat waits behind the other window's real toast");
  await BrowserTestUtils.closeWindow(win);
  await TestUtils.waitForCondition(() => !WhimsyAIHints.waiting, "Its window closed: it stops waiting");

  win = await BrowserTestUtils.openNewBrowserWindow();
  register();
  ok(WhimsyAIHints.request(win, "updates"), "Updates is taken in a second window");
  await TestUtils.waitForCondition(() => WhimsyAIHints.current?.id == "updates", "and shows there");
  await BrowserTestUtils.closeWindow(win);
  await TestUtils.waitForCondition(() => !WhimsyAIHints.current, "Its window closed: it's gone");

  ok(WhimsyAIHints.request(window, "ask"), "Ask is taken here");
  await waitForHint("ask");
  ok(true, "and shows: nothing is stuck");
});

add_task(async function hint_not_shown_ai_off_except_media() {
  await resetHints();
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", false]] });
  for (const id of ["ask", "chat", "voice", "image-text"]) {
    WhimsyAIHints.register({ id, isVisible: () => true });
  }
  ok(!WhimsyAIHints.request(window, "ask"), "No Ask hint with AI off");
  ok(!WhimsyAIHints.request(window, "chat"), "No chat hint with AI off");
  ok(WhimsyAIHints.request(window, "voice"), "Voice works with AI off, so its hint shows");
  const voice = await waitForHint("voice");
  voice.close({ instant: true });
  await waitNoHint();
  ok(WhimsyAIHints.request(window, "image-text"), "So does image text");
  await waitForHint("image-text");
  hintToast().close({ instant: true });
  await waitNoHint();
  await SpecialPowers.popPrefEnv();
  await resetHints();
});
