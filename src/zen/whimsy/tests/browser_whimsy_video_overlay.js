/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 video: two plates at the top right of a video (Summarize, then PiP in
// the corner) fade with the speed plate; Summarize is a toggle that closes
// chat, reopens the same summary, and switches from another conversation.

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_video_w23.js", this);

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
  stubProvider();
  registerCleanupFunction(async () => {
    await closeChat();
    WhimsyAIProviders.setTestProvider(null);
  });
});

add_task(async function two_plates_fade_together() {
  const { tab, browser } = await openVideo();
  is((await videoControl(browser))?.right?.shown ?? false, false, "Nothing before the pointer comes");
  await hoverVideo(browser);
  const state = await shownControl(browser);
  ok(state.plates.summ.right <= state.plates.pip.left, "Summarize sits left of PiP");
  const videoRight = await SpecialPowers.spawn(browser, [], () => content.document.getElementById("video").getBoundingClientRect().right);
  Assert.less(Math.abs(videoRight - 8 - state.plates.pip.right), 1.5, "PiP is in the video's corner");
  is(state.plates.summ.top, state.plates.bar.top, "Both sides on one line");
  await TestUtils.waitForCondition(async () => {
    const { opacity } = await videoControl(browser);
    return opacity.bar == 1 && opacity.right == 1;
  }, "Both fade in");
  // Off the video: both go together.
  await BrowserTestUtils.synthesizeMouse("body", 2, 700, { type: "mousemove" }, browser);
  const hidden = await shownControl(browser, false);
  ok(!hidden.shown && !hidden.right.shown, "Both fade out together");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function tab_order() {
  const { tab, browser } = await openVideo();
  // Off your default, so back-to-default shows.
  await SpecialPowers.spawn(browser, [], () => (content.document.getElementById("video").playbackRate = 2));
  await hoverVideo(browser);
  await TestUtils.waitForCondition(async () => (await videoControl(browser)).reset.shown, "Back to default shows off the default");
  const state = await videoControl(browser);
  Assert.deepEqual(state.focusOrder, ["reset", "value", "toggle", "cc", "summ", "pip"], "Back to default, number, presets, CC, Summarize, PiP");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function small_video_icon_only_and_none() {
  const { tab, browser } = await openVideo("", "#small");
  await hoverVideo(browser, "#small");
  let state = await shownControl(browser);
  ok(state.right.compact, "240px wide: Summarize is its icon");
  ok(!state.summ.labelShown, "with no label");
  ok(state.pip.shown, "PiP still shows");
  await hoverVideo(browser, "#tiny");
  state = await shownControl(browser, false);
  ok(!state.right.shown, "Under 120×68 nothing draws");
  await hoverVideo(browser);
  state = await shownControl(browser);
  ok(!state.right.compact && state.summ.labelShown, "A big video gets the label");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function ai_off_no_summarize_pip_stays() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", false]] });
  const { tab, browser } = await openVideo();
  await hoverVideo(browser);
  const state = await shownControl(browser);
  ok(!state.summ.shown, "AI off: no Summarize");
  ok(state.pip.shown, "PiP stays in the corner");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function summarize_toggle_closes_and_reopens_same() {
  await freshChatStore();
  stubProvider();
  const { tab, browser } = await openVideo();
  await pressSummarize(browser);
  await summaryAnswered();
  const threadId = chatPanel().thread.id;
  is(providerCalls.length, 1, "One summary was asked for");
  await hoverVideo(browser);
  await TestUtils.waitForCondition(async () => (await videoControl(browser)).summ.pressed, "Summarize shows pressed");
  is((await videoControl(browser)).summ.title, "Hide summary", "The tooltip says a press hides it");

  await pressSummarize(browser);
  await TestUtils.waitForCondition(() => !chatPanel().isOpen, "A second press closes chat");
  await hoverVideo(browser);
  await TestUtils.waitForCondition(async () => !(await videoControl(browser)).summ.pressed, "Not pressed with chat closed");
  is((await videoControl(browser)).summ.title, "Show summary", "The tooltip says a press shows it");

  await pressSummarize(browser);
  await TestUtils.waitForCondition(() => chatPanel().isOpen && chatPanel().thread?.id == threadId, "A third press reopens the same summary");
  is(providerCalls.length, 1, "without asking again");
  await closeChat();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function switches_from_other_thread() {
  await freshChatStore();
  stubProvider();
  const { tab, browser } = await openVideo();
  await pressSummarize(browser);
  await summaryAnswered();
  const threadId = chatPanel().thread.id;
  chatPanel().newChat();
  await TestUtils.waitForCondition(() => chatPanel().thread?.draft, "Chat shows another conversation");
  await hoverVideo(browser);
  await TestUtils.waitForCondition(async () => (await videoControl(browser)).summ.title == "Show summary", "A press would show the summary");
  await pressSummarize(browser);
  await TestUtils.waitForCondition(() => chatPanel().isOpen && chatPanel().thread?.id == threadId, "Summarize switches chat to its summary");
  ok(chatPanel().isOpen, "and chat stays open");
  await closeChat();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function firefox_pip_toggle_hidden() {
  ok(!Services.prefs.getBoolPref("media.videocontrols.picture-in-picture.video-toggle.enabled"), "Firefox's own toggle is off");
  const { tab, browser } = await openVideo();
  await hoverVideo(browser);
  const state = await shownControl(browser);
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(null, win => win.document.documentURI.includes("pictureinpicture"));
  await clickPoint(browser, state.pip);
  const pipWin = await opened;
  ok(pipWin, "Our PiP button opens Firefox's picture-in-picture window");
  await hoverVideo(browser);
  await TestUtils.waitForCondition(async () => (await videoControl(browser)).pip.pressed, "and shows pressed");
  await BrowserTestUtils.closeWindow(pipWin);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function cross_origin_embed_draws() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, VIDEO_PAGE + "?embed");
  const browser = tab.linkedBrowser;
  const frame = await TestUtils.waitForCondition(() => browser.browsingContext.children[0], "The embed is there");
  await SpecialPowers.spawn(frame, [], async () => {
    const video = content.document.getElementById("video");
    await ContentTaskUtils.waitForCondition(() => video.readyState >= 1 && content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed")?.videos.has(video), "The embed's video is known");
  });
  ok(frame.currentWindowGlobal.documentPrincipal.origin != browser.browsingContext.currentWindowGlobal.documentPrincipal.origin, "The embed is cross-origin");
  await hoverVideo(browser, "#video", frame);
  const state = await shownControl(browser, true, frame);
  ok(state.summ.shown && state.pip.shown, "Both plates draw over a cross-origin embed");
  BrowserTestUtils.removeTab(tab);
});
