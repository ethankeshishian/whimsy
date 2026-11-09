/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 voice-image screenshots: dictation (media-5.3, 5.4, 5.5, 5.7, 5.9,
// 5.10, fu-media 5.2, dec-15). A stand-in for @whimsy/speech;1; panels are
// copied into the window before each shot (drawSnapshot misses popups).

const { WhimsyDictation } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyDictation.sys.mjs");
const { WhimsyAIHints } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIHints.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const DICTATION_PAGE = ROOT + "whimsy_dictation.html";
const ARTICLE_PAGE = ROOT + "whimsy_chat_article.html";

function fakeSpeech({ locales = ["en-US"], mic = "authorized" } = {}) {
  const fake = {
    authorizationStatus: "authorized",
    microphoneStatus: mic,
    onDeviceLocales: locales,
    fnKeyUsage: 2,
    sessions: [],
    fn: null,
    requestAccess: cb => cb(true, "authorized"),
    requestMicrophoneAccess: cb => cb(fake.microphoneStatus == "authorized", fake.microphoneStatus),
    listen(locale, listener) {
      const session = { finished: false, finish() { this.finished = true; }, stop() {}, say: (text, final = false) => listener.onText(text, final) };
      fake.sessions.push(session);
      return session;
    },
    watchFnKey(listener) {
      fake.fn = listener;
      return { stop: () => (fake.fn = null) };
    },
    openSystemSettings() {},
  };
  return fake;
}

let speech;

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.feature.dictation", true],
    ["whimsy.feature.ai-hints", false],
    ["whimsy.ai.hints.seen", "voice"],
  ] });
  registerCleanupFunction(() => {
    WhimsyDictation.cancel();
    WhimsyDictation.setTestSpeech(null);
    WhimsyDictation._barOpens = 0;
    Services.prefs.clearUserPref("ui.IMERawInputForeground");
  });
});

function useSpeech(options) {
  WhimsyDictation.cancel();
  speech = fakeSpeech(options);
  WhimsyDictation.setTestSpeech(speech);
  return speech;
}

async function frames(n = 2) {
  for (let i = 0; i < n; i++) {
    await new Promise(r => requestAnimationFrame(r));
  }
}

async function closeBar() {
  WhimsyDictation.cancel();
  gURLBar.view.close();
  gURLBar.blur();
  gBrowser.selectedBrowser.focus();
  await TestUtils.waitForCondition(() => !gURLBar.view.isOpen, "The command bar is closed");
}

async function openBar(text = "") {
  gURLBar.focus();
  gURLBar.select();
  if (text) {
    EventUtils.sendString(text);
    await TestUtils.waitForCondition(() => gURLBar.view.isOpen, "The command bar is open");
  }
  await TestUtils.waitForCondition(() => document.getElementById("whimsy-dictation-mic")?.getBoundingClientRect().width > 0, "The mic shows");
}

async function focusField(browser) {
  await SpecialPowers.spawn(browser, [], () => {
    const body = content.document.getElementById("body");
    body.focus();
    body.setSelectionRange(body.value.length, body.value.length);
  });
  await TestUtils.waitForCondition(() => window.windowUtils.IMEStatus == Ci.nsIDOMWindowUtils.IME_STATUS_ENABLED, "The field has focus");
}

async function holdFn() {
  speech.fn("down");
  await TestUtils.waitForCondition(() => WhimsyDictation.active?.phase == "listening" || document.querySelector("panel[id^='whimsy-dictation-']")?.state == "open", "Holding Fn starts");
}

function standInPopups() {
  const made = [];
  for (const panel of document.querySelectorAll("panel")) {
    if (panel.state != "open") {
      continue;
    }
    const box = panel.shadowRoot?.querySelector("[part~='content']") ?? panel;
    const outer = panel.getOuterScreenRect();
    const inPanel = panel.getBoundingClientRect();
    const rect = box.getBoundingClientRect();
    const stand = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    stand.className = `${panel.className} whimsy-surface-tokens`;
    const look = getComputedStyle(panel);
    for (let i = 0; i < look.length; i++) {
      const name = look.item(i);
      if (name.startsWith("--")) {
        stand.style.setProperty(name, look.getPropertyValue(name));
      }
    }
    const boxLook = getComputedStyle(box);
    for (const name of ["background-color", "background-image", "border-top", "border-right", "border-bottom", "border-left", "border-radius", "box-shadow", "padding", "color", "font-family", "font-size", "font-weight", "line-height"]) {
      stand.style.setProperty(name, boxLook.getPropertyValue(name));
    }
    if (boxLook.boxShadow == "none") {
      stand.style.boxShadow = "0 0 0 0.5px rgba(0, 0, 0, 0.18), 0 8px 24px rgba(0, 0, 0, 0.16)";
    }
    if (/rgba\(.*, 0\)|transparent/.test(boxLook.backgroundColor)) {
      stand.style.backgroundColor = "var(--zen-dialog-background, var(--arrowpanel-background, Canvas))";
    }
    Object.assign(stand.style, {
      position: "fixed",
      zIndex: "2147483647",
      boxSizing: "border-box",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      left: `${outer.left - window.mozInnerScreenX + rect.left - inPanel.left}px`,
      top: `${outer.top - window.mozInnerScreenY + rect.top - inPanel.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    for (const child of panel.children) {
      stand.append(child.cloneNode(true));
    }
    document.documentElement.append(stand);
    made.push(stand);
  }
  return () => made.forEach(s => s.remove());
}

async function closePanels() {
  for (const panel of document.querySelectorAll("panel.whimsy-dictation-panel")) {
    if (panel.state == "open") {
      const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
      panel.hidePopup();
      await hidden;
    }
  }
}

add_task(async function shots_command_bar_mic() {
  useSpeech();
  await BrowserTestUtils.withNewTab(ARTICLE_PAGE, async () => {
    // media-5.3: keyboard focus on the mic, its tooltip names the key.
    await whimsyBothSchemes("w23-voice-image-media-5.3", async () => {
      await openBar("night trains");
      const mic = document.getElementById("whimsy-dictation-mic");
      mic.focus({ focusVisible: true });
      await document.l10n.translateFragment(mic);
      await frames();
      ok(mic.matches(":focus-visible"), "The mic has keyboard focus");
      is(getComputedStyle(mic.querySelector(".whimsy-dictation-tip")).visibility, "visible", "Its tooltip shows");
      return closeBar;
    });

    // media-5.4: listening in the bar, the unsure tail greyed.
    await whimsyBothSchemes("w23-voice-image-media-5.4", async () => {
      await openBar("n");
      gURLBar.select();
      EventUtils.synthesizeKey("KEY_Backspace");
      const mic = document.getElementById("whimsy-dictation-mic");
      EventUtils.synthesizeMouseAtCenter(mic, {});
      await TestUtils.waitForCondition(() => WhimsyDictation.active?.phase == "listening", "Listening");
      speech.sessions.at(-1).say("night trains from vienna");
      speech.sessions.at(-1).say("night trains from vienna to paris");
      await TestUtils.waitForCondition(() => gURLBar.value == "night trains from vienna to paris", "Words in the bar");
      await TestUtils.waitForCondition(() => gURLBar.view.isOpen, "Results update");
      await document.l10n.translateFragment(gURLBar);
      await frames();
      ok(gURLBar.querySelector(".whimsy-dictation-tail").textContent.length, "A tail is greyed");
      return closeBar;
    });

    // media-5.7: Fn with nothing focused opens the bar listening.
    await whimsyBothSchemes("w23-voice-image-media-5.7", async () => {
      gBrowser.selectedBrowser.focus();
      await SpecialPowers.spawn(gBrowser.selectedBrowser, [], () => content.document.activeElement?.blur());
      await holdFn();
      await document.l10n.translateFragment(gURLBar);
      await frames();
      is(WhimsyDictation.active.target, "commandbar", "The bar listens");
      return async () => {
        speech.fn("up");
        await closeBar();
      };
    });

    // fu-media dec-15: hold ⌘K, the open menu listens.
    await whimsyBothSchemes("w23-voice-image-fu-dec-15", async () => {
      gBrowser.selectedBrowser.focus();
      EventUtils.synthesizeKey("k", { accelKey: true, type: "keydown" });
      await TestUtils.waitForCondition(() => WhimsyDictation.active?.target == "cmdk", "The menu listens");
      speech.sessions.at(-1).say("summarize this");
      speech.sessions.at(-1).say("summarize this page");
      await TestUtils.waitForCondition(() => gURLBar.value == "summarize this page", "Words in the menu");
      await document.l10n.translateFragment(gURLBar);
      await frames(3);
      ok(!gURLBar.querySelector(".whimsy-dictation-key").hidden, "It says release ⌘K");
      return async () => {
        EventUtils.synthesizeKey("k", { accelKey: true, type: "keyup" });
        await closeBar();
      };
    });

    // fu-media 5.2: the first-use toast, no ring.
    await SpecialPowers.pushPrefEnv({ set: [
      ["whimsy.feature.ai-hints", true],
      ["whimsy.ai.hints.seen", "ask,context-commands,chat,updates,video-summary,image-text,agent-mode"],
      ["whimsy.ai.hints.today", ""],
    ] });
    WhimsyAIHints._resetForTesting();
    WhimsyAIHints._setTimingForTesting({ gapMs: 0, seenMs: 60000, timeoutMs: 60000, pollMs: 50 });
    WhimsyDictation.registerHint();
    await whimsyBothSchemes("w23-voice-image-fu-5.2", async () => {
      Services.prefs.setStringPref("whimsy.ai.hints.seen", "ask,context-commands,chat,updates,video-summary,image-text,agent-mode");
      WhimsyDictation._barOpens = 2;
      await openBar("n");
      const toast = await TestUtils.waitForCondition(() => gZenUIManager.toasts.getToasts().find(t => t.element.getAttribute("whimsy-ai-hint") == "voice"), "The voice hint shows");
      await toast.shown;
      await document.l10n.translateFragment(toast.element);
      await whimsySettled();
      is(getComputedStyle(document.getElementById("whimsy-dictation-mic")).boxShadow, "none", "No ring on the mic");
      return async () => {
        toast.close({ instant: true });
        WhimsyAIHints._resetForTesting();
        await closeBar();
      };
    });
    WhimsyAIHints._setTimingForTesting(null);
    await SpecialPowers.popPrefEnv();
  });
});

add_task(async function shots_field_and_panels() {
  useSpeech();
  await BrowserTestUtils.withNewTab(DICTATION_PAGE, async browser => {
    // media-5.5: words go in greyed until final, the pill under the caret.
    await whimsyBothSchemes("w23-voice-image-media-5.5", async () => {
      await focusField(browser);
      await holdFn();
      speech.sessions.at(-1).say("I can do Thursday at");
      await TestUtils.waitForCondition(
        async () => (await SpecialPowers.spawn(browser, [], () => content.document.getElementById("body").value)).endsWith("Thursday at"),
        "Words go into the field"
      );
      const pill = document.getElementById("whimsy-dictation-pill");
      await document.l10n.translateFragment(pill);
      await frames(3);
      WhimsyDictation.placePill(WhimsyDictation.active);
      ok(BrowserTestUtils.isVisible(pill), "The pill shows");
      return async () => {
        WhimsyDictation.cancel();
        speech.fn("up");
      };
    });

    // media-5.9: the microphone is off for Whimsy.
    useSpeech({ mic: "denied" });
    await whimsyBothSchemes("w23-voice-image-media-5.9", async () => {
      await focusField(browser);
      speech.fn("down");
      const panel = await TestUtils.waitForCondition(() => document.getElementById("whimsy-dictation-denied"), "The panel shows");
      await TestUtils.waitForCondition(() => panel.state == "open", "Open");
      await document.l10n.translateFragment(panel);
      await whimsySettled();
      ok(panel.querySelector(".whimsy-dictation-panel-text"), "It names the switch");
      const undo = standInPopups();
      return async () => {
        undo();
        speech.fn("up");
        await closePanels();
      };
    });

    // media-5.10: no on-device dictation for the language.
    useSpeech({ locales: [] });
    await whimsyBothSchemes("w23-voice-image-media-5.10", async () => {
      await openBar();
      speech.fn("down");
      const panel = await TestUtils.waitForCondition(() => document.getElementById("whimsy-dictation-setup"), "The panel shows");
      await TestUtils.waitForCondition(() => panel.state == "open", "Open");
      await document.l10n.translateFragment(panel);
      await whimsySettled();
      ok(panel.querySelector(".whimsy-dictation-panel-text"), "It says where to get it");
      const undo = standInPopups();
      return async () => {
        undo();
        speech.fn("up");
        await closePanels();
        await closeBar();
      };
    });
  });
});
