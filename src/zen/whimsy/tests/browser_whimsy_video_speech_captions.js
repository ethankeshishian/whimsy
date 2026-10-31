/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// w7native: CC on a video without captions makes live captions from its
// speech. Stand-ins replace the native pieces: the recognizer in the parent
// (WhimsyLiveSpeech.testSpeech for nsIWhimsySpeech) and, in the content
// process, the audio capture and tap (SpeechTesting for captureStream() and
// nsIWhimsyAudioTap). The audio flows child -> parent, the transcript flows
// back, settles and is translated. Access refused, no on-device language and
// the switch off each say so; CC off stops everything. The real audio tap
// is checked on a Web Audio track.

const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_video_captions.html";

const { WhimsyCaptions } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCaptions.sys.mjs");
const { WhimsyLiveSpeech, pickLocale } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLiveSpeech.sys.mjs");
const { speechTail } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCaptionsChild.sys.mjs");

const calls = [];

const control = browser =>
  SpecialPowers.spawn(browser, [], () => {
    const actor = content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
    return actor ? JSON.parse(JSON.stringify(actor.testState())) : null;
  });

function makeSpeech({ status = "authorized", grant = true, locales = ["en-US", "es-ES", "es-MX"] } = {}) {
  const speech = {
    authorizationStatus: status,
    requests: 0,
    onDeviceLocales: locales,
    sessions: [],
    requestAccess(callback) {
      this.requests++;
      this.authorizationStatus = grant ? "authorized" : "denied";
      callback(grant, this.authorizationStatus);
    },
    start(locale, listener) {
      const session = {
        locale,
        listener,
        audio: [],
        stopped: false,
        appendAudio(samples, rate) {
          this.audio.push({ samples: [...samples], rate });
        },
        stop() {
          this.stopped = true;
        },
      };
      this.sessions.push(session);
      return session;
    },
  };
  WhimsyLiveSpeech.testSpeech = speech;
  return speech;
}

// The capture and tap stand-ins, in the page's content process.
function fakeAudio(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const { SpeechTesting } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCaptionsChild.sys.mjs");
    const log = (SpeechTesting.log = { captures: 0, captureStops: 0, starts: 0, stops: 0, takes: 0 });
    SpeechTesting.capture = async () => {
      log.captures++;
      return { track: { fake: true }, stop: () => log.captureStops++ };
    };
    SpeechTesting.tap = () => ({
      sampleRate: 16000,
      start() {
        log.starts++;
      },
      stop() {
        log.stops++;
      },
      take() {
        log.takes++;
        return [0.25, -0.5, 0.125];
      },
    });
  });
}

const audioLog = browser =>
  SpecialPowers.spawn(browser, [], () => {
    const { SpeechTesting } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCaptionsChild.sys.mjs");
    return JSON.parse(JSON.stringify(SpeechTesting.log));
  });

function clearFakeAudio(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const { SpeechTesting } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCaptionsChild.sys.mjs");
    SpeechTesting.capture = null;
    SpeechTesting.tap = null;
    delete SpeechTesting.log;
  });
}

async function openPage({ lang = "es" } = {}) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [lang], async pageLang => {
    content.document.documentElement.lang = pageLang;
    const actor = () => content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
    const video = content.document.getElementById("plain");
    await ContentTaskUtils.waitForCondition(() => video.readyState >= 1, "plain has its metadata");
    await ContentTaskUtils.waitForCondition(() => actor()?.videos.has(video), "The speed control knows plain");
  });
  await fakeAudio(browser);
  browser.focus();
  return { tab, browser };
}

async function closePage(tab) {
  await clearFakeAudio(tab.linkedBrowser);
  BrowserTestUtils.removeTab(tab);
}

async function clickCC(browser) {
  await BrowserTestUtils.synthesizeMouseAtCenter("#plain", { type: "mousemove" }, browser);
  await TestUtils.waitForCondition(async () => (await control(browser))?.shown, "The control shows");
  const { cc } = await control(browser);
  ok(cc.shown, "CC is in the control");
  await BrowserTestUtils.synthesizeMouseAtPoint(cc.x, cc.y, {}, browser);
}

async function waitCaption(browser, text, message) {
  await TestUtils.waitForCondition(async () => {
    const captions = (await control(browser))?.captions;
    return captions?.shown && captions.text == text;
  }, message);
  return (await control(browser)).captions;
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.video-speed", true],
      ["whimsy.feature.video-captions", true],
      ["whimsy.feature.video-speech-captions", true],
      ["browser.translations.enable", true],
    ],
  });
  WhimsyCaptions.testTargetLanguage = "en";
  WhimsyCaptions.testTranslate = async (text, { from, to }) => {
    calls.push({ text, from, to });
    return `[${to}] ${text}`;
  };
  registerCleanupFunction(() => {
    WhimsyCaptions.testTranslate = null;
    WhimsyCaptions.testTargetLanguage = null;
    WhimsyLiveSpeech.testSpeech = null;
  });
});

add_task(async function test_helpers() {
  is(pickLocale(["en-US", "es-ES", "es-MX"], ["es"]), "es-ES", "A bare language takes its first locale");
  is(pickLocale(["en-US", "es-ES", "es-MX"], ["es", "en-MX"]), "es-MX", "in the region the person uses when there is one");
  is(pickLocale(["en_GB", "en-US"], ["en-GB"]), "en-GB", "Exact matches win, underscores or not");
  is(pickLocale(["fr-FR"], ["de", "nonsense!"]), null, "No on-device language, no locale");
  is(pickLocale(null, ["en"]), null, "No list, no locale");

  is(speechTail("  hello   there  "), "hello there", "Short text is just tidied");
  const long = "This is the first sentence of a long talk. And this second one is the sentence being spoken right now";
  is(speechTail(long, 70), "And this second one is the sentence being spoken right now", "The current sentence when it fits");
  const words = "one two three four five six seven eight nine ten eleven twelve";
  const tail = speechTail(words, 20);
  ok(words.endsWith(tail) && tail.length <= 20 && !tail.startsWith(" "), "Else the last whole words");
});

add_task(async function test_live_captions() {
  calls.length = 0;
  const speech = makeSpeech({ status: "notDetermined" });
  const { tab, browser } = await openPage({ lang: "es" });

  await clickCC(browser);
  let state = await control(browser);
  ok(state.cc.pressed, "CC turns on for a video without captions");
  is(state.captions.kind, "speech", "with its speech as the source");
  ok(state.captions.note.length, "and a note that it's listening");

  await TestUtils.waitForCondition(() => speech.sessions.length == 1, "A recognition session starts");
  is(speech.requests, 1, "macOS is asked for access the first time");
  const session = speech.sessions[0];
  is(session.locale, "es-ES", "in the page's language");

  await TestUtils.waitForCondition(() => session.audio.length > 0, "The video's audio reaches the recognizer");
  is(session.audio[0].rate, 16000, "at the tap's rate");
  Assert.deepEqual(session.audio[0].samples, [0.25, -0.5, 0.125], "sample for sample");
  let log = await audioLog(browser);
  is(log.captures, 1, "The video's audio was captured once");
  is(log.starts, 1, "and tapped");
  state = await control(browser);
  ok(state.captions.tapping, "The caption source says it's tapping");
  is(state.captions.speechLang, "es-ES", "and knows the recognizer's language");

  // A partial transcript shows at once, dimmed, then translated once settled.
  session.listener.onText("hola amigos", false);
  let captions = await waitCaption(browser, "[en] hola amigos", "The settled transcript shows translated");
  is(captions.lang, "en", "in your language");
  ok(!captions.pending, "no longer dimmed");
  Assert.deepEqual(calls.at(-1), { text: "hola amigos", from: "es-ES", to: "en" }, "Translated from the recognizer's language");

  // Partials that keep changing are translated once, when they settle.
  const before = calls.length;
  session.listener.onText("hola amigos de", false);
  session.listener.onText("hola amigos de la", false);
  session.listener.onText("hola amigos de la ciudad", true);
  captions = await waitCaption(browser, "[en] hola amigos de la ciudad", "A finished stretch is translated at once");
  is(calls.length, before + 1, "Only the settled text was translated");

  // CC off stops everything.
  await clickCC(browser);
  await TestUtils.waitForCondition(async () => !(await control(browser)).captions.on, "CC off");
  await TestUtils.waitForCondition(() => session.stopped, "The recognition session stops");
  log = await audioLog(browser);
  is(log.stops, 1, "The tap stops");
  is(log.captureStops, 1, "and the captured stream's tracks stop");
  is(WhimsyLiveSpeech.sessions.size, 0, "No session is left");

  await closePage(tab);
});

add_task(async function test_same_language() {
  calls.length = 0;
  const speech = makeSpeech();
  const { tab, browser } = await openPage({ lang: "en" });
  await clickCC(browser);
  await TestUtils.waitForCondition(() => speech.sessions.length == 1, "A session starts");
  is(speech.sessions[0].locale, "en-US", "in English");
  speech.sessions[0].listener.onText("hello there", true);
  await waitCaption(browser, "hello there", "Speech in your language shows as it is");
  speech.sessions[0].listener.onText("hello there friends", false);
  const captions = await waitCaption(browser, "hello there friends", "and keeps showing as it's heard");
  ok(!captions.pending, "never dimmed");
  is(calls.length, 0, "with nothing translated");
  await closePage(tab);
});

add_task(async function test_denied() {
  const speech = makeSpeech({ status: "notDetermined", grant: false });
  const { tab, browser } = await openPage();
  await clickCC(browser);
  await TestUtils.waitForCondition(async () => {
    const state = await control(browser);
    return !state.captions.on && state.captions.note.includes("Speech Recognition");
  }, "Refused access turns CC off with a note saying where to allow it");
  is(speech.sessions.length, 0, "No session starts");
  ok(!(await control(browser)).cc.pressed, "CC isn't pressed");
  is((await audioLog(browser)).captures, 0, "and no audio is captured");
  await closePage(tab);
});

add_task(async function test_no_on_device_language() {
  const speech = makeSpeech({ locales: [] });
  const { tab, browser } = await openPage();
  await clickCC(browser);
  await TestUtils.waitForCondition(async () => {
    const state = await control(browser);
    return !state.captions.on && state.captions.note.includes("Dictation");
  }, "Without an on-device language CC says how to get one");
  is(speech.sessions.length, 0, "and nothing is sent anywhere");
  await closePage(tab);
});

add_task(async function test_session_error() {
  const speech = makeSpeech();
  const { tab, browser } = await openPage();
  await clickCC(browser);
  await TestUtils.waitForCondition(() => speech.sessions[0]?.audio.length > 0, "Audio flows");
  speech.sessions[0].listener.onError("failed");
  await TestUtils.waitForCondition(async () => !(await control(browser)).captions.on, "A failed session turns CC off");
  ok((await control(browser)).captions.note.length, "with a note");
  is((await audioLog(browser)).stops, 1, "and the tap stops");
  await closePage(tab);
});

add_task(async function test_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.video-speech-captions", false]] });
  const speech = makeSpeech();
  const { tab, browser } = await openPage();
  await clickCC(browser);
  await TestUtils.waitForCondition(async () => (await control(browser))?.captions?.note, "A video without captions says so");
  ok(!(await control(browser)).cc.pressed, "CC stays off");
  is(speech.sessions.length, 0, "Nothing listens");
  is((await audioLog(browser)).captures, 0, "Nothing is captured");
  const result = await WhimsyLiveSpeech.start({}, { lang: "en" });
  is(result.error, "off", "The parent refuses too");
  await closePage(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_parent_checks() {
  const speech = makeSpeech();
  const actor = { messages: [], sendAsyncMessage(name, data) { this.messages.push({ name, data }); } };
  const other = { sendAsyncMessage() {} };
  const { id, lang } = await WhimsyLiveSpeech.start(actor, { lang: "es" });
  is(lang, "es-ES", "A session starts for the hinted language");
  const session = speech.sessions[0];

  WhimsyLiveSpeech.audio(other, { id, rate: 16000, samples: new Float32Array([0.5]) });
  is(session.audio.length, 0, "Another frame can't feed it");
  WhimsyLiveSpeech.audio(actor, { id, rate: 3, samples: new Float32Array([0.5]) });
  is(session.audio.length, 0, "A nonsense rate is refused");
  WhimsyLiveSpeech.audio(actor, { id, rate: 16000, samples: new Float32Array([2, NaN, -0.5]) });
  Assert.deepEqual(session.audio[0].samples, [1, 0, -0.5], "Samples are clamped and cleaned");
  WhimsyLiveSpeech.audio(actor, { id, rate: 16000, samples: new Float32Array(200000) });
  is(session.audio[1].samples.length, 96000, "At most 2 s of audio per message");

  session.listener.onText("x".repeat(3000), false);
  is(actor.messages.at(-1).data.text.length, 2000, "Text sent to the page is capped");

  WhimsyLiveSpeech.stop(other, { id });
  ok(!session.stopped, "Another frame can't stop it");
  WhimsyLiveSpeech.stopAll(actor);
  ok(session.stopped, "The frame going away stops it");
  is(WhimsyLiveSpeech.sessions.size, 0, "and forgets it");
});

add_task(async function test_native_components() {
  WhimsyLiveSpeech.testSpeech = null;
  if (AppConstants.platform != "macosx") {
    ok(!Cc["@whimsy/speech;1"], "The recognizer is only built on macOS");
    return;
  }
  // The real recognizer, without asking for access (that would prompt).
  const speech = Cc["@whimsy/speech;1"].getService(Ci.nsIWhimsySpeech);
  ok(["notDetermined", "denied", "restricted", "authorized"].includes(speech.authorizationStatus), "The recognizer reads its access");
  if (speech.authorizationStatus != "authorized") {
    const listener = { QueryInterface: ChromeUtils.generateQI(["nsIWhimsySpeechListener"]), onText() {}, onError() {} };
    Assert.throws(() => speech.start("en-US", listener), /NS_ERROR_NOT_AVAILABLE/, "It won't start without access");
  }
});

add_task(async function test_real_audio_tap() {
  // The real tap, in the content process, on a Web Audio oscillator's track.
  await SpecialPowers.pushPrefEnv({
    set: [
      ["media.autoplay.default", 0],
      ["media.autoplay.block-webaudio", false],
    ],
  });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const result = await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const tap = Cc["@whimsy/audio-tap;1"].createInstance(Ci.nsIWhimsyAudioTap);
    Assert.deepEqual(tap.take(), [], "An idle tap has nothing");
    ok(!tap.active, "and isn't active");
    const ctx = new content.AudioContext();
    const osc = ctx.createOscillator();
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    await ctx.resume();
    tap.start(dest.stream.getAudioTracks()[0]);
    ok(tap.active, "It taps a live audio track");
    let samples = [];
    await ContentTaskUtils.waitForCondition(() => {
      samples = samples.concat(tap.take());
      return samples.length > 4000;
    }, "Audio arrives");
    const rate = tap.sampleRate;
    const peak = samples.reduce((max, x) => Math.max(max, Math.abs(x)), 0);
    tap.stop();
    ok(!tap.active, "stop() ends it");
    Assert.deepEqual(tap.take(), [], "and drops the rest");
    osc.stop();
    await ctx.close();
    return { rate, peak };
  });
  Assert.greaterOrEqual(result.rate, 14000, "Divided down to about 16 kHz");
  Assert.lessOrEqual(result.rate, 24000, "not left at the graph's rate");
  Assert.greater(result.peak, 0.1, "The oscillator's tone is in the samples");
  Assert.lessOrEqual(result.peak, 1, "within -1..1");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
