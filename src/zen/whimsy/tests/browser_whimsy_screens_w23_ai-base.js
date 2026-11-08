/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 ai-base: shots of what this lane draws, for side-by-side checks
// against the mockups (09-discovery disc-1.x hint toasts; fu-settings 9.5
// solid masks). WHIMSY_SHOTS=<dir> writes w23-ai-base-*.png.

const { WhimsyAIHints } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIHints.sys.mjs");
const { WhimsyAIContext } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIContext.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");

// Typing here is fixture data: whatever drafts it leaves use the test key
// store and are gone before the next file.
add_setup(async function () {
  const { OSKeyStoreTestUtils } = ChromeUtils.importESModule("resource://testing-common/OSKeyStoreTestUtils.sys.mjs");
  const { WhimsyFormDrafts } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFormProtection.sys.mjs");
  OSKeyStoreTestUtils.setup();
  registerCleanupFunction(async () => {
    await WhimsyFormDrafts.forgetAll();
    await OSKeyStoreTestUtils.cleanup();
  });
});

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.ai.enabled", true],
    ["whimsy.ai.hints.seen", ""],
    ["whimsy.ai.hints.today", ""],
  ] });
  WhimsyAIHints._setTimingForTesting({ gapMs: 0, timeoutMs: 0 });
  registerCleanupFunction(() => {
    WhimsyAIHints._resetForTesting();
    WhimsyAIHints._setTimingForTesting(null);
  });
});

function hintToast() {
  return gZenUIManager.toasts.getToasts().find(t => t.element.hasAttribute("whimsy-ai-hint")) ?? null;
}

async function showHint(id) {
  WhimsyAIHints._resetForTesting();
  closeToasts();
  Services.prefs.setStringPref("whimsy.ai.hints.seen", "");
  Services.prefs.setStringPref("whimsy.ai.hints.today", "");
  WhimsyAIHints.register({ id, isVisible: () => true });
  ok(WhimsyAIHints.request(window, id), `${id}: requested`);
  await TestUtils.waitForCondition(hintToast, `${id}: showing`);
  const toast = hintToast();
  await document.l10n.translateFragment(toast.element);
  return toast;
}

const STATES = [
  ["disc-1.1", "ask"],
  ["disc-1.2", "context-commands"],
  ["disc-1.3", "chat"],
  ["disc-1.4", "updates"],
  ["disc-1.5", "video-summary"],
  ["disc-1.6", "voice"],
  ["disc-1.7", "image-text"],
  ["agent-1.1", "agent-mode"],
];

add_task(async function shots_hint_toasts() {
  for (const [state, id] of STATES) {
    await whimsyBothSchemes(`w23-ai-base-${state}`, async () => {
      const toast = await showHint(id);
      await toast.shown;
      return () => toast.close({ instant: true });
    });
  }
});

// Motion (09-discovery): in with scale 0 -> 1 on Zen's spring.
add_task(async function shots_hint_toast_mid_animation() {
  for (const ms of [120, 250]) {
    const motion = whimsyCaptureMotion(el => el.hasAttribute?.("whimsy-ai-hint") || el.classList?.contains("zen-toast"));
    try {
      const toast = await showHint("ask");
      await whimsyShotMid("w23-ai-base-disc-1.1", motion.get, ms);
      await toast.shown;
      toast.close({ instant: true });
    } finally {
      motion.stop();
    }
  }
});

add_task(async function shots_masked_fields() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, ROOT + "whimsy_ai_sensitive.html");
  const browser = tab.linkedBrowser;
  browser.focus();
  for (const [sel, text] of [["#pw", "hunter" + "2"], ["#cc", "4111" + "111111111111"], ["#otp", "48" + "2913"]]) {
    await BrowserTestUtils.synthesizeMouseAtCenter(sel, {}, browser);
    await TestUtils.waitForCondition(() => SpecialPowers.spawn(browser, [sel], s =>
      content.document.activeElement == content.document.querySelector(s)), `${sel} has focus`);
    EventUtils.sendString(text);
    await TestUtils.waitForCondition(() => SpecialPowers.spawn(browser, [sel, text], (s, t) =>
      content.document.querySelector(s).value == t), `${sel} is filled`);
  }
  await WhimsyAIContext.withMask(tab.linkedBrowser, () =>
    whimsyShot("w23-ai-base-mask-fields", tab.linkedBrowser.browsingContext.currentWindowGlobal));
  BrowserTestUtils.removeTab(tab);
});
