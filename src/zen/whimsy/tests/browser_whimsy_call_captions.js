/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// F31: Live Captions for This Call. Calls (Google Meet and other WebRTC
// calls) never get the video speed control (F30), whose CC captions
// videos; their sound plays from the page's own <audio srcObject> elements,
// not the muted video tiles. The command (and the CC button of a call's
// picture-in-picture window) taps those MediaStreams, mixed into one track,
// for the on-device speech captions, shown over the call's largest tile.

const PAGE =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_call_captions.html";
const { WhimsyLiveSpeech } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLiveSpeech.sys.mjs");
const { WhimsyCaptions } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCaptions.sys.mjs");
const { WhimsyCallPip } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCallPip.sys.mjs");

function makeSpeech() {
  const speech = {
    authorizationStatus: "authorized",
    onDeviceLocales: ["en-US"],
    sessions: [],
    requestAccess(callback) {
      callback(true, "authorized");
    },
    start(locale, listener) {
      const session = { locale, listener, audio: [], stopped: false,
        appendAudio(samples, rate) { this.audio.push(rate); },
        stop() { this.stopped = true; } };
      this.sessions.push(session);
      return session;
    },
  };
  WhimsyLiveSpeech.testSpeech = speech;
  return speech;
}

const control = browser =>
  SpecialPowers.spawn(browser, [], () => {
    const actor = content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
    return actor ? JSON.parse(JSON.stringify(actor.testState())) : null;
  });

add_task(async function test_call_captions_tap_the_calls_audio() {
  await SpecialPowers.pushPrefEnv({ set: [["media.autoplay.default", 0], ["media.autoplay.blocking_policy", 0]] });
  const speech = makeSpeech();
  WhimsyCaptions.testTranslate = async text => text;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  try {
    await SpecialPowers.spawn(browser, [], async () => {
      const voice = content.document.getElementById("voice");
      await ContentTaskUtils.waitForCondition(() => !voice.paused && voice.srcObject.getAudioTracks().length,
        "The call's voice plays");
      const { SpeechTesting } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCaptionsChild.sys.mjs");
      const log = (SpeechTesting.log = { tracks: [] });
      SpeechTesting.tap = () => ({
        sampleRate: 16000,
        start(track) {
          log.tracks.push({ kind: track.kind, state: track.readyState });
        },
        stop() {},
        take() {
          return [0.1, -0.1];
        },
      });
    });

    // Not offered outside a call.
    const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
    const action = globalActions.find(a => a.l10nId == "whimsy-action-call-captions");
    ok(action, "Live Captions for This Call is a command");
    ok(!action.isAvailable(window), "...offered only in a call");

    is(await WhimsyCallPip.toggleCaptions(browser), "on", "Turned on");
    await TestUtils.waitForCondition(() => speech.sessions.length == 1, "A speech session started");
    const tracks = await TestUtils.waitForCondition(async () => {
      const log = await SpecialPowers.spawn(browser, [], () => {
        const { SpeechTesting } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCaptionsChild.sys.mjs");
        return JSON.parse(JSON.stringify(SpeechTesting.log));
      });
      return log.tracks.length ? log.tracks : null;
    }, "The call's audio was tapped");
    is(tracks[0].kind, "audio", "...as a live audio track");
    is(tracks[0].state, "live", "...that's live");
    await TestUtils.waitForCondition(() => speech.sessions[0].audio.length > 0, "Audio reaches the recognizer");

    speech.sessions[0].listener.onText("hello everyone", true);
    await TestUtils.waitForCondition(async () => {
      const captions = (await control(browser))?.captions;
      return captions?.shown && captions.text == "hello everyone";
    }, "The words show over the call");
    ok(!(await control(browser)).shown, "No speed control on the call (F30)");

    is(await WhimsyCallPip.toggleCaptions(browser), "off", "Turned off");
    await TestUtils.waitForCondition(() => speech.sessions[0].stopped, "The speech session stops");
  } finally {
    await SpecialPowers.spawn(browser, [], () => {
      const { SpeechTesting } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCaptionsChild.sys.mjs");
      SpeechTesting.tap = null;
      delete SpeechTesting.log;
    });
    WhimsyLiveSpeech.testSpeech = null;
    WhimsyCaptions.testTranslate = null;
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_no_call_no_captions() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  is(await WhimsyCallPip.toggleCaptions(tab.linkedBrowser), "no-video", "A page without a call has nothing to caption");
  BrowserTestUtils.removeTab(tab);
});
