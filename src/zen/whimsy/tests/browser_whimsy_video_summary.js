/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 video: what Summarize reads. Text tracks (every cue, in hidden mode),
// subtitle files the tab loaded (matched by timing), then the page.
// Protected video: no frames. No captions: speech captions start silently.
// A text-only model says it can't see frames. Times seek the right tab.

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_video_w23.js", this);

const { WhimsySubtitleSniffer } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySubtitleSniffer.sys.mjs");
const { WhimsyLiveSpeech } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLiveSpeech.sys.mjs");

const hasImage = call => (call?.request?.messages ?? []).some(m => Array.isArray(m.content) && m.content.some(p => p?.type == "image"));

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.video-speed", true],
      ["whimsy.feature.ai-hints", false],
      ["whimsy.ai.order", "claude,openai"],
      ["whimsy.ai.off", ""],
      ["media.autoplay.default", 0],
      ["media.autoplay.blocking_policy", 0],
    ],
  });
  registerCleanupFunction(async () => {
    await closeChat();
    WhimsyAIProviders.setTestProvider(null);
  });
});

add_task(async function text_tracks_hidden_mode_all_cues() {
  await freshChatStore();
  stubProvider();
  const { tab, browser } = await openVideo();
  await pressSummarize(browser);
  await summaryAnswered();
  const sent = sentText(providerCalls[0]);
  for (const line of ["Night trains nearly vanished", "Then Austria bought", "We ride Vienna to Paris"]) {
    ok(sent.includes(line), `Every cue is read: ${line}`);
  }
  is(await SpecialPowers.spawn(browser, [], () => content.document.getElementById("video").textTracks[0].mode), "disabled", "The track's mode is put back");
  ok(hasImage(providerCalls[0]), "A model that sees gets the frame");
  ok(chatPanel().chips.querySelector("[data-kind='video']"), "Chat has a This video chip");
  ok(chatPanel().body.querySelector(".whimsy-chat-note[data-kind='video-source']"), "and says where the summary came from");
  await closeChat();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function sniffed_ttml_matched_by_timing() {
  await freshChatStore();
  stubProvider();
  const { tab, browser } = await openVideo("?sniff");
  await TestUtils.waitForCondition(() => WhimsySubtitleSniffer.forBrowser(browser).length, "The TTML file was noticed");
  await pressSummarize(browser);
  await summaryAnswered();
  const sent = sentText(providerCalls[0]);
  ok(sent.includes("hiding a death"), "The sniffed TTML's text is read");
  ok(sent.includes("subtitles"), "and said to be from the subtitles");
  await closeChat();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function drm_no_frames() {
  await freshChatStore();
  stubProvider();
  const { tab, browser } = await openVideo("?drm");
  await SpecialPowers.spawn(browser, [], () => ContentTaskUtils.waitForCondition(() => content.wrappedJSObject.drmReady, "Media keys are set"));
  await pressSummarize(browser);
  await summaryAnswered();
  ok(!hasImage(providerCalls[0]), "No frames from protected video");
  ok(sentText(providerCalls[0]).includes("copy-protected"), "The model hears it's protected");
  await closeChat();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function no_captions_starts_speech_silently() {
  await freshChatStore();
  stubProvider("He likes the new hinge.");
  const sessions = [];
  WhimsyLiveSpeech.testSpeech = {
    authorizationStatus: "authorized",
    onDeviceLocales: ["en-US"],
    requestAccess: cb => cb(true, "authorized"),
    start(locale, listener) {
      const session = { listener, appendAudio() {}, stop() {} };
      sessions.push(session);
      return session;
    },
  };
  const { tab, browser } = await openVideo("?bare");
  await SpecialPowers.spawn(browser, [], () => {
    const { SpeechTesting } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCaptionsChild.sys.mjs");
    SpeechTesting.capture = async () => ({ track: { fake: true }, stop() {} });
    SpeechTesting.tap = () => ({ sampleRate: 16000, start() {}, stop() {}, take: () => [] });
  });
  await pressSummarize(browser);
  await summaryAnswered();
  await TestUtils.waitForCondition(() => sessions.length, "Speech captions started");
  const state = await videoControl(browser);
  ok(!state.cc.pressed, "CC stays off");
  ok(!state.captions?.shown, "Nothing is drawn on the video");
  ok(chatPanel().body.querySelector(".whimsy-video-heard"), "What's said so far waits in chat");
  sessions[0].listener.onText("He likes the new hinge, and says the battery swap took under two minutes. ".repeat(10), true);
  await TestUtils.waitForCondition(() => chatPanel().body.querySelector(".whimsy-video-heard-text")?.textContent.includes("hinge"), "and grows as it plays");
  await SpecialPowers.spawn(browser, [], () => {
    const { SpeechTesting } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCaptionsChild.sys.mjs");
    SpeechTesting.capture = null;
    SpeechTesting.tap = null;
  });
  await closeChat();
  BrowserTestUtils.removeTab(tab);
  WhimsyLiveSpeech.testSpeech = null;
});

add_task(async function plan_text_only_video_note() {
  await freshChatStore();
  stubProvider();
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.order", "claude"]] });
  const usesPlan = WhimsyAIProviders._usesPlan;
  WhimsyAIProviders._usesPlan = id => id == "claude";
  const { tab, browser } = await openVideo();
  await pressSummarize(browser);
  await summaryAnswered();
  ok(!hasImage(providerCalls[0]), "No frames for a text-only model");
  const note = chatPanel().body.querySelector(".whimsy-chat-note[data-kind='video-source'] span");
  await TestUtils.waitForCondition(() => note.textContent.includes("can’t look at frames"), "The note says it can't see frames");
  WhimsyAIProviders._usesPlan = usesPlan;
  await closeChat();
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function timestamp_seeks_right_tab() {
  await freshChatStore();
  stubProvider("Night trains came back.\n\nChapters\n- 0:00 Why they vanished\n- 0:02 Nightjet");
  const { tab, browser } = await openVideo();
  await pressSummarize(browser);
  await summaryAnswered();
  const threadId = chatPanel().thread.id;
  await SpecialPowers.spawn(browser, [], () => {
    const video = content.document.getElementById("video");
    content.document.body.dataset.seeks = "0";
    video.addEventListener("seeked", () => (content.document.body.dataset.seeks = String(Number(content.document.body.dataset.seeks) + 1)));
  });
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  // From another tab, the conversation list shows the summary again.
  await WhimsyChatPanel.forWindow(window).open({ threadId });
  const pill = await TestUtils.waitForCondition(() => chatPanel().body.querySelector(".whimsy-chat-time[data-seconds='0']"), "Times are pills");
  EventUtils.synthesizeMouseAtCenter(pill, {});
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == tab, "The summary's tab comes back first");
  await TestUtils.waitForCondition(async () => Number(await SpecialPowers.spawn(browser, [], () => content.document.body.dataset.seeks)) > 0, "and its video seeks");
  BrowserTestUtils.removeTab(other);
  await closeChat();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function live_relative_times() {
  const { WhimsyVideoSummary: S } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVideoSummary.sys.mjs");
  const text = S.describe({ title: "Spain v England", live: true, currentTime: 1200, cues: [{ start: 120, text: "Spain score" }, { start: 1080, text: "Russo hits the post" }] }, "captions");
  ok(text.includes("18 min ago Spain score"), "Live times count back from now");
  ok(text.includes("2 min ago Russo hits the post"), "for every moment");
});
