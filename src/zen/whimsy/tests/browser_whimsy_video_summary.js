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

add_task(async function transcript_and_key_quotes_chips() {
  await freshChatStore();
  stubProvider();
  const { tab, browser } = await openVideo();
  await pressSummarize(browser);
  await summaryAnswered();
  const body = chatPanel().body;
  const transcript = await TestUtils.waitForCondition(() => body.querySelector(".whimsy-video-chip[data-chip='transcript']"), "Transcript is a chip under the summary");
  const quotes = body.querySelector(".whimsy-video-chip[data-chip='quotes']");
  ok(quotes, "and so is Key quotes");
  await TestUtils.waitForCondition(() => transcript.textContent == "Transcript" && quotes.textContent == "Key quotes", "The chips are labelled");
  ok(!body.querySelector(".whimsy-video-chip[data-chip='update']"), "No Update for a video that isn't live");
  ok(!body.querySelector(".whimsy-chat-actions [data-action='video-transcript']"), "No second Transcript among the answer's icons");
  // The chips sit between the summary and the note that says where it came from.
  const card = transcript.closest(".whimsy-chat-msg");
  is(card.previousElementSibling?.dataset.role, "ai", "The chips follow the summary");
  is(card.nextElementSibling?.dataset.kind, "video-source", "and come before the source note");

  EventUtils.synthesizeMouseAtCenter(transcript, {});
  await TestUtils.waitForCondition(() => body.querySelectorAll(".whimsy-video-transcript > li").length >= 3, "The transcript lists the captions");
  EventUtils.synthesizeMouseAtCenter(transcript, {});
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(r => setTimeout(r, 200));
  is(body.querySelectorAll(".whimsy-video-transcript").length, 1, "A second press goes back to the same transcript");

  EventUtils.synthesizeMouseAtCenter(quotes, {});
  await TestUtils.waitForCondition(() => providerCalls.length == 2, "Key quotes asks the model");
  ok(sentText(providerCalls[1]).includes("most telling quotes"), "for quotes from the transcript");
  ok(JSON.stringify(providerCalls[1].request).includes("Night trains nearly vanished"), "with the transcript in its context");
  await TestUtils.waitForCondition(() => [...body.querySelectorAll(".whimsy-chat-msg[data-role='user']")].some(m => m.textContent.includes("Key quotes from this video")), "The question shows as yours");
  await TestUtils.waitForCondition(() => body.querySelectorAll(".whimsy-chat-msg[data-role='ai']:not([busy])").length == 2, "and the quotes stream in");
  await closeChat();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function live_stream_update_chip() {
  await freshChatStore();
  stubProvider("Spain lead.\n\nChapters\n- 0:00 Spain score");
  const { tab, browser } = await openVideo("?drawn");
  // Like a live stream: no end (the actor's own test, as Xrays hide a page's duration).
  await SpecialPowers.spawn(browser, [], () => {
    const actor = content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
    actor.isLive = el => el.id == "video";
  });
  await hoverVideo(browser);
  const state = await TestUtils.waitForCondition(async () => {
    const s = await videoControl(browser);
    return s?.right.shown && s;
  }, "A live stream gets the top-right plates");
  ok(!state.shown, "but no speed plate: a live stream can't run ahead");
  ok(state.summ.shown, "Summarize shows on a live stream");
  await clickPoint(browser, state.summ);
  await summaryAnswered();
  ok(sentText(providerCalls[0]).includes("live stream"), "The model hears it's live");
  const body = chatPanel().body;
  const update = await TestUtils.waitForCondition(() => body.querySelector(".whimsy-video-chip[data-chip='update']"), "Live: an Update chip");
  ok(!body.querySelector(".whimsy-video-chip[data-chip='transcript']"), "and no Transcript for a stream");
  const live = body.querySelector(".whimsy-video-live");
  ok(live && live.compareDocumentPosition(body.querySelector(".whimsy-chat-msg[data-role='ai']")) & Node.DOCUMENT_POSITION_FOLLOWING, "A LIVE line sits above the summary");
  await TestUtils.waitForCondition(() => live.textContent.includes("you’ve watched"), "and says it covers what you watched");
  await TestUtils.waitForCondition(() => update.textContent == "Update", "Update is labelled");

  await SpecialPowers.spawn(browser, [], () => {
    content.document.getElementById("drawn").textContent = "Russo hits the post.";
  });
  EventUtils.synthesizeMouseAtCenter(update, {});
  await TestUtils.waitForCondition(() => providerCalls.length == 2, "Update asks again");
  const sent = sentText(providerCalls[1]);
  ok(sent.includes("since your last summary"), "for what's happened since");
  ok(sent.includes("Russo hits the post"), "with what was captioned since");
  await TestUtils.waitForCondition(() => [...body.querySelectorAll(".whimsy-chat-msg[data-role='user']")].some(m => m.textContent.includes("happened since")), "The question shows as yours");
  await TestUtils.waitForCondition(() => body.querySelectorAll(".whimsy-chat-msg[data-role='ai']:not([busy])").length == 2, "and the update streams in");
  await closeChat();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function drawn_subtitles_collected_while_playing() {
  const { tab, browser } = await openVideo("?drawn");
  const lines = await SpecialPowers.spawn(browser, [], async () => {
    const doc = content.document;
    const video = doc.getElementById("video");
    const actor = content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
    actor.drawnLimits = { every: 50, cues: 3, chars: 60000 };
    await video.play();
    const said = ["Vienna on time.", "This is the couchette.", "Breakfast card.", "Lights out at eleven."];
    for (const text of said) {
      doc.getElementById("drawn").textContent = text;
      await ContentTaskUtils.waitForCondition(() => actor.drawnCues?.get(video)?.at(-1)?.text == text, `Collected: ${text}`);
    }
    video.pause();
    return actor.drawnSoFar(video).map(c => c.text);
  });
  ok(lines.includes("This is the couchette.") && lines.includes("Lights out at eleven."), "Lines drawn while it played are kept");
  ok(!lines.includes("Vienna on time."), "only the latest, within the bound");
  is(lines.length, 3, "The bound holds");
  BrowserTestUtils.removeTab(tab);

  // A private window never collects.
  const privateWin = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const ptab = await BrowserTestUtils.openNewForegroundTab(privateWin.gBrowser, VIDEO_PAGE + "?drawn");
  const collected = await SpecialPowers.spawn(ptab.linkedBrowser, [], async () => {
    const video = content.document.getElementById("video");
    await ContentTaskUtils.waitForCondition(() => video.readyState >= 1, "The video has its metadata");
    const actor = content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
    if (actor) {
      actor.drawnLimits = { every: 50, cues: 3, chars: 60000 };
    }
    await video.play();
    // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
    await new Promise(r => content.setTimeout(r, 500));
    video.pause();
    return !!actor?.drawnCues?.has(video);
  });
  ok(!collected, "Nothing is collected in a private window");
  await BrowserTestUtils.closeWindow(privateWin);
});
