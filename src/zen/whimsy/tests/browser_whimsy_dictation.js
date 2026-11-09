/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 voice-image: dictation (media-5.x, fu-media 5.2, dec-15). Hold Fn
// dictates into the focused field, greyed until final, never sending; with
// no field the command bar opens listening; the bar's mic; hold ⌘K speaks
// into the open menu; no on-device language shows setup steps and takes no
// audio; it all works with AI off. A stand-in for @whimsy/speech;1.

const { WhimsyDictation } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyDictation.sys.mjs");
const { WhimsyAIHints } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIHints.sys.mjs");

const PAGE = "https://example.com/browser/zen/whimsy/tests/whimsy_dictation.html";
const GREY_PREF = "ui.IMERawInputForeground";

function fakeSpeech({ locales = ["en-US"], mic = "authorized", speech = "authorized", fnKeyUsage = 2 } = {}) {
  const fake = {
    authorizationStatus: speech,
    microphoneStatus: mic,
    onDeviceLocales: locales,
    fnKeyUsage,
    sessions: [],
    asked: [],
    opened: [],
    fn: null,
    requestAccess(callback) {
      fake.asked.push("speech");
      callback(fake.authorizationStatus == "authorized", fake.authorizationStatus);
    },
    requestMicrophoneAccess(callback) {
      fake.asked.push("microphone");
      callback(fake.microphoneStatus == "authorized", fake.microphoneStatus);
    },
    listen(locale, listener) {
      const session = {
        locale,
        listener,
        finished: false,
        stopped: false,
        finish() {
          this.finished = true;
        },
        stop() {
          this.stopped = true;
        },
        say(text, final = false) {
          listener.onText(text, final);
        },
      };
      fake.sessions.push(session);
      return session;
    },
    watchFnKey(listener) {
      fake.fn = listener;
      return { stop: () => (fake.fn = null) };
    },
    openSystemSettings(page) {
      fake.opened.push(page);
    },
  };
  return fake;
}

let speech;

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.feature.dictation", true],
    ["whimsy.dictation.hold-fn", true],
    ["whimsy.ai.hints.seen", "voice"],
    ["whimsy.ai.hints.today", ""],
  ] });
  registerCleanupFunction(() => {
    WhimsyDictation.cancel();
    WhimsyDictation.setTestSpeech(null);
    WhimsyDictation._barOpens = 0;
    Services.prefs.clearUserPref(GREY_PREF);
    for (const id of ["whimsy-dictation-setup", "whimsy-dictation-denied"]) {
      document.getElementById(id)?.hidePopup();
    }
  });
});

async function setup(options) {
  WhimsyDictation.cancel();
  speech = fakeSpeech(options);
  WhimsyDictation.setTestSpeech(speech);
  ok(speech.fn, "Fn is watched through the speech service");
  return speech;
}

async function holdFn() {
  speech.fn("down");
  await TestUtils.waitForCondition(() => WhimsyDictation.active?.phase == "listening" || document.querySelector("panel[id^='whimsy-dictation-']"), "Holding Fn starts dictation");
}

async function focusBody(browser) {
  await SpecialPowers.spawn(browser, [], () => {
    const body = content.document.getElementById("body");
    body.focus();
    body.setSelectionRange(body.value.length, body.value.length);
  });
  await TestUtils.waitForCondition(() => window.windowUtils.IMEStatus == Ci.nsIDOMWindowUtils.IME_STATUS_ENABLED, "The field has focus");
}

function fieldValue(browser) {
  return SpecialPowers.spawn(browser, [], () => content.document.getElementById("body").value);
}

async function closeBar() {
  if (gURLBar.view.isOpen || gURLBar.focused) {
    gURLBar.view.close();
    gURLBar.blur();
    gBrowser.selectedBrowser.focus();
  }
  await TestUtils.waitForCondition(() => !gURLBar.view.isOpen, "The command bar is closed");
}

add_task(async function hold_fn_dictates_into_field_greyed_until_final() {
  await setup();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await focusBody(browser);
    speech.fn("down");
    await new Promise(r => setTimeout(r, 100));
    ok(!WhimsyDictation.active, "A short press of Fn is macOS's");
    speech.fn("up");

    await holdFn();
    is(WhimsyDictation.active.target, "field", "Holding Fn in a field dictates into it");
    const pill = document.getElementById("whimsy-dictation-pill");
    ok(BrowserTestUtils.isVisible(pill), "The listening pill shows");
    is(pill.getAttribute("phase"), "listening", "It says it's listening");
    is(speech.sessions.length, 1, "One session listens");

    speech.sessions[0].say("I can do Thursday at");
    await TestUtils.waitForCondition(async () => (await fieldValue(browser)) == "Hi Sam, thanks for the notes. I can do Thursday at", "Words go into the field as you speak");
    is(Services.prefs.getStringPref(GREY_PREF, ""), "#8e8e93", "Words not yet final are greyed");
    ok(await SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.compositions == 1), "They go in as one composition, not final yet");

    speech.fn("up");
    ok(speech.sessions[0].finished, "Letting go of Fn turns the microphone off");
    speech.sessions[0].say("I can do Thursday at six if the train still runs.", true);
    await TestUtils.waitForCondition(async () => (await fieldValue(browser)) == "Hi Sam, thanks for the notes. I can do Thursday at six if the train still runs.", "The final words land, punctuated");
    ok(!Services.prefs.prefHasUserValue(GREY_PREF), "The grey is gone once final");
    ok(!WhimsyDictation.active, "Dictation is over");
    is(pill.getAttribute("phase"), "done", "The pill says Done");
    await TestUtils.waitForCondition(() => pill.hidden, "Then it goes");
  });
});

add_task(async function never_sends() {
  await setup();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await focusBody(browser);
    await holdFn();
    speech.sessions[0].say("Sounds good");
    speech.fn("up");
    speech.sessions[0].say("Sounds good.", true);
    await TestUtils.waitForCondition(async () => (await fieldValue(browser)).endsWith("Sounds good."), "The words land");
    const counts = await SpecialPowers.spawn(browser, [], () => ({ submits: content.wrappedJSObject.submits, enters: content.wrappedJSObject.enters }));
    is(counts.submits, 0, "The form isn't sent");
    is(counts.enters, 0, "No Enter is pressed");
    is(browser.currentURI.spec, PAGE, "The page stays");
  });
});

add_task(async function no_field_opens_bar_listening() {
  await setup();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await SpecialPowers.spawn(browser, [], () => content.document.activeElement?.blur());
    browser.focus();
    await TestUtils.waitForCondition(() => window.windowUtils.IMEStatus == Ci.nsIDOMWindowUtils.IME_STATUS_DISABLED, "No field has focus");
    await holdFn();
    is(WhimsyDictation.active.target, "commandbar", "With no field, the command bar listens");
    ok(gURLBar.focused, "The command bar opened");
    ok(gURLBar.hasAttribute("whimsy-dictating"), "It shows it's listening");
    const mic = document.getElementById("whimsy-dictation-mic");
    is(mic.getAttribute("aria-pressed"), "true", "The mic is filled");

    speech.sessions[0].say("night trains from vienna");
    speech.sessions[0].say("night trains from vienna to paris");
    await TestUtils.waitForCondition(() => gURLBar.value == "night trains from vienna to paris", "Words go into the bar");
    const tail = gURLBar.querySelector(".whimsy-dictation-tail");
    is(tail.textContent, "vienna to paris", "The unsure tail is drawn greyed");

    speech.fn("up");
    speech.sessions[0].say("night trains from vienna to paris", true);
    await TestUtils.waitForCondition(() => !gURLBar.hasAttribute("whimsy-dictating"), "Listening ends");
    is(gURLBar.value, "night trains from vienna to paris", "The words stay in the bar");
    ok(!gURLBar.querySelector(".whimsy-dictation-mirror"), "Nothing greyed is left");
    is(browser.currentURI.spec, PAGE, "Nothing ran");
    await closeBar();
  });
});

add_task(async function hold_cmd_k_listens_release_selects_top() {
  await setup();
  await BrowserTestUtils.withNewTab("https://example.com/browser/zen/whimsy/tests/whimsy_cmdk.html", async browser => {
    browser.focus();
    EventUtils.synthesizeKey("k", { accelKey: true, type: "keydown" });
    await TestUtils.waitForCondition(() => gURLBar.view.isOpen || gURLBar.focused, "⌘K opens on key down");
    ok(!WhimsyDictation.active, "Not listening before 300ms");
    EventUtils.synthesizeKey("k", { accelKey: true, type: "keydown", repeat: true });
    await TestUtils.waitForCondition(() => WhimsyDictation.active?.target == "cmdk", "Held 300ms, the menu listens", 50, 40);
    ok(gURLBar.hasAttribute("whimsy-holding-k"), "K is held");
    ok(!gURLBar.hasAttribute("whimsy-numbers"), "Row numbers stay hidden while K is held");
    const key = gURLBar.querySelector(".whimsy-dictation-key");
    ok(key && !key.hidden, "It says to release ⌘K");

    speech.sessions[0].say("example");
    await TestUtils.waitForCondition(() => gURLBar.value == "example", "Spoken words filter the menu");
    EventUtils.synthesizeKey("k", { accelKey: true, type: "keydown", repeat: true });
    is(gURLBar.value, "example", "Key repeat doesn't reopen the menu");

    EventUtils.synthesizeKey("k", { accelKey: true, type: "keyup" });
    ok(speech.sessions[0].finished, "Letting go stops listening");
    speech.sessions[0].say("example", true);
    await TestUtils.waitForCondition(() => !WhimsyDictation.active, "Listening ends");
    await TestUtils.waitForCondition(() => gURLBar.view.isOpen && gURLBar.view.selectedRowIndex == 0, "The top match is selected");
    is(gURLBar.value, "example", "The words stay");
    is(browser.currentURI.spec, "https://example.com/browser/zen/whimsy/tests/whimsy_cmdk.html", "Nothing ran by itself");
    ok(!gURLBar.hasAttribute("whimsy-holding-k"), "K is let go");
    await closeBar();
  });
});

add_task(async function no_on_device_language_setup_steps() {
  await setup({ locales: [], mic: "notDetermined", speech: "notDetermined" });
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await focusBody(browser);
    speech.fn("down");
    const panel = await TestUtils.waitForCondition(() => document.getElementById("whimsy-dictation-setup"), "Setup steps show");
    await TestUtils.waitForCondition(() => panel.state == "open", "The panel is open");
    is(speech.sessions.length, 0, "No audio is taken");
    is(speech.asked.length, 0, "Nothing is asked of macOS");
    ok(!WhimsyDictation.active, "Not listening");
    const text = panel.querySelector(".whimsy-dictation-panel-text");
    await document.l10n.translateFragment(panel);
    ok(text.textContent.includes("English"), "It names the language");
    const open = document.getElementById("whimsy-dictation-setup-open");
    await TestUtils.waitForCondition(() => open.getBoundingClientRect().width > 0, "The button is laid out");
    EventUtils.synthesizeMouseAtCenter(open, {});
    Assert.deepEqual(speech.opened, ["keyboard"], "It opens Keyboard settings");
    await TestUtils.waitForCondition(() => !document.getElementById("whimsy-dictation-setup"), "The panel goes");
    speech.fn("up");
  });
});

add_task(async function denied_microphone_names_the_switch() {
  await setup({ mic: "denied" });
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await focusBody(browser);
    speech.fn("down");
    const panel = await TestUtils.waitForCondition(() => document.getElementById("whimsy-dictation-denied"), "The access panel shows");
    await TestUtils.waitForCondition(() => panel.state == "open", "The panel is open");
    is(speech.sessions.length, 0, "No audio is taken");
    is(panel.querySelector(".whimsy-dictation-panel-text").getAttribute("data-l10n-id"), "whimsy-dictation-denied-microphone", "It names the microphone switch");
    const open = document.getElementById("whimsy-dictation-denied-open");
    await TestUtils.waitForCondition(() => open.getBoundingClientRect().width > 0, "The button is laid out");
    EventUtils.synthesizeMouseAtCenter(open, {});
    Assert.deepEqual(speech.opened, ["microphone"], "It opens the Microphone settings");
    await TestUtils.waitForCondition(() => !document.getElementById("whimsy-dictation-denied"), "The panel goes");
    speech.fn("up");
  });
});

add_task(async function works_with_ai_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", false]] });
  await setup();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    gURLBar.focus();
    gURLBar.select();
    const mic = document.getElementById("whimsy-dictation-mic");
    await TestUtils.waitForCondition(() => BrowserTestUtils.isVisible(mic) && mic.getBoundingClientRect().width > 0, "The mic shows in the command bar");
    EventUtils.synthesizeMouseAtCenter(mic, {});
    await TestUtils.waitForCondition(() => WhimsyDictation.active?.phase == "listening", "A click listens, AI off");
    speech.sessions[0].say("weather in vienna");
    await TestUtils.waitForCondition(() => gURLBar.value == "weather in vienna", "Words go into the bar");
    EventUtils.synthesizeMouseAtCenter(mic, {});
    ok(speech.sessions[0].finished, "A second click stops");
    speech.sessions[0].say("weather in vienna", true);
    await TestUtils.waitForCondition(() => !WhimsyDictation.active, "Listening ends");
    is(gURLBar.value, "weather in vienna", "The words stay");

    await closeBar();
    await focusBody(browser);
    await holdFn();
    is(WhimsyDictation.active.target, "field", "Hold Fn works with AI off too");
    speech.fn("up");
    speech.sessions.at(-1).say("", true);
    await TestUtils.waitForCondition(() => !WhimsyDictation.active, "Done");
    is(await fieldValue(browser), "Hi Sam, thanks for the notes.", "Silence leaves the field as it was");
  });
  await SpecialPowers.popPrefEnv();
});

add_task(async function mic_click_stops_when_the_window_loses_focus() {
  await setup();
  await BrowserTestUtils.withNewTab(PAGE, async () => {
    gURLBar.focus();
    gURLBar.select();
    const mic = document.getElementById("whimsy-dictation-mic");
    await TestUtils.waitForCondition(() => BrowserTestUtils.isVisible(mic) && mic.getBoundingClientRect().width > 0, "The mic shows in the command bar");
    EventUtils.synthesizeMouseAtCenter(mic, {});
    await TestUtils.waitForCondition(() => WhimsyDictation.active?.phase == "listening", "A click listens");
    const other = await BrowserTestUtils.openNewBrowserWindow();
    await SimpleTest.promiseFocus(other);
    await TestUtils.waitForCondition(() => speech.sessions[0].finished, "Leaving the window turns the mic off");
    speech.sessions[0].say("", true);
    await TestUtils.waitForCondition(() => !WhimsyDictation.active, "Listening ends");
    await BrowserTestUtils.closeWindow(other);
    await SimpleTest.promiseFocus(window);
    await closeBar();
  });
});

add_task(async function first_use_toast_only() {
  await setup();
  // Only the voice hint is new here.
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.hints.seen", "ask,context-commands,chat,updates,video-summary,image-text,agent-mode"], ["whimsy.ai.hints.today", ""]] });
  WhimsyAIHints._resetForTesting();
  WhimsyAIHints._setTimingForTesting({ gapMs: 0, seenMs: 5000, timeoutMs: 3000, pollMs: 50 });
  WhimsyDictation.registerHint();
  WhimsyDictation._barOpens = 0;
  await BrowserTestUtils.withNewTab(PAGE, async () => {
    const toastFor = () => gZenUIManager.toasts.getToasts().find(t => t.element.getAttribute("whimsy-ai-hint") == "voice");
    for (let i = 0; i < 2; i++) {
      gURLBar.focus();
      gURLBar.select();
      EventUtils.sendString("a");
      await TestUtils.waitForCondition(() => gURLBar.view.isOpen, "The bar opens");
      await closeBar();
    }
    ok(!toastFor(), "No hint on the first two opens");
    gURLBar.focus();
    gURLBar.select();
    EventUtils.sendString("a");
    await TestUtils.waitForCondition(() => gURLBar.view.isOpen, "The bar opens a third time");
    const toast = await TestUtils.waitForCondition(toastFor, "The voice hint shows");
    await document.l10n.translateFragment(toast.element);
    ok(toast.element.textContent.includes("Hold Fn to talk instead of typing"), "It says how");
    const mic = document.getElementById("whimsy-dictation-mic");
    is(getComputedStyle(mic).boxShadow, "none", "No ring on the mic");
    is(mic.getAnimations().length, 0, "Nothing pulses");
    toast.close({ instant: true });
    await closeBar();
  });
  WhimsyAIHints._resetForTesting();
  WhimsyAIHints._setTimingForTesting(null);
  await SpecialPowers.popPrefEnv();
});

add_task(async function settings_media_hold_fn_and_note() {
  await setup({ fnKeyUsage: 2 });
  await BrowserTestUtils.withNewTab("about:preferences#whimsyMedia", async browser => {
    const doc = browser.contentDocument;
    const check = await TestUtils.waitForCondition(() => doc.getElementById("whimsyDictationHoldFn"), "Hold Fn is in Settings › Media");
    await TestUtils.waitForCondition(() => check.checked, "It's on by default");
    const note = doc.getElementById("whimsyDictationFnNote");
    ok(note, "A note says macOS also uses Fn");
    const button = doc.getElementById("whimsyDictationOpenKeyboard");
    button.scrollIntoView({ block: "center" });
    await TestUtils.waitForCondition(() => button.getBoundingClientRect().width > 0, "The button is laid out");
    EventUtils.synthesizeMouseAtCenter(button, {}, browser.contentWindow);
    Assert.deepEqual(speech.opened, ["keyboard"], "It opens Keyboard settings");
  });
  await setup({ fnKeyUsage: 0 });
  await BrowserTestUtils.withNewTab("about:preferences#whimsyMedia", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.getElementById("whimsyDictationHoldFn"), "Hold Fn is in Settings › Media");
    ok(!doc.getElementById("whimsyDictationFnNote"), "No note when Fn does nothing else");
  });
});
