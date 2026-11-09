/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 video: shared by the overlay, summary, and screenshot tests.

const VIDEO_PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_video_vtt.html";

const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIStore } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIStore.sys.mjs");
const { WhimsyVideoSummary } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVideoSummary.sys.mjs");

const chatPanel = () => WhimsyChatPanel.forWindow(window);
let providerCalls = [];

function videoControl(browser, context = browser.browsingContext) {
  return SpecialPowers.spawn(context, [], () => {
    const actor = content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
    return actor ? JSON.parse(JSON.stringify(actor.testState())) : null;
  });
}

async function openVideo(query = "", selector = "#video") {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, VIDEO_PAGE + query);
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [selector], async sel => {
    const video = content.document.querySelector(sel);
    await ContentTaskUtils.waitForCondition(() => video.readyState >= 1, "The video has its metadata");
    await ContentTaskUtils.waitForCondition(() => {
      const actor = content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
      return actor?.videos.has(video) && actor.siteRate !== null;
    }, "The control knows the video");
  });
  browser.focus();
  return { tab, browser };
}

async function hoverVideo(browser, selector = "#video", context = browser) {
  await BrowserTestUtils.synthesizeMouseAtCenter(selector, { type: "mousemove" }, context);
}

async function shownControl(browser, shown = true, context = browser.browsingContext) {
  await TestUtils.waitForCondition(async () => {
    const state = await videoControl(browser, context);
    return (state?.shown ?? false) == shown && (state?.right?.shown ?? false) == shown;
  }, shown ? "Both plates show" : "Both plates hide");
  return videoControl(browser, context);
}

async function clickPoint(browser, point, context = browser) {
  await BrowserTestUtils.synthesizeMouseAtPoint(point.x, point.y, {}, context);
}

async function pressSummarize(browser) {
  await hoverVideo(browser);
  const state = await shownControl(browser);
  ok(state.summ.shown, "Summarize shows");
  await clickPoint(browser, state.summ);
}

function stubProvider(reply = "Night trains came back.\n\nChapters\n- 0:00 Why they vanished\n- 0:01 Nightjet") {
  providerCalls = [];
  WhimsyAIProviders.setTestProvider(async function* (provider, request) {
    providerCalls.push({ provider, request });
    yield { type: "text", delta: reply };
  });
}

const sentText = call => JSON.stringify(call?.request?.messages ?? []);

async function freshChatStore() {
  await WhimsyAIStore._resetForTesting(PathUtils.join(PathUtils.tempDir, "whimsy-video-" + Math.random().toString(16).slice(2)));
  WhimsyVideoSummary._resetForTesting();
}

async function closeChat() {
  if (chatPanel().isOpen) {
    chatPanel().close({ reason: "key" });
    await TestUtils.waitForCondition(() => document.getElementById("whimsy-chat")?.hidden ?? true, "Chat closed");
  }
}

async function summaryAnswered() {
  await TestUtils.waitForCondition(
    () => chatPanel().isOpen && chatPanel().thread?.video && chatPanel().body.querySelector(".whimsy-chat-msg[data-role='ai']:not([busy])"),
    "The summary is in"
  );
}
