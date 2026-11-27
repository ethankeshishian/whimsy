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

function ownVideoTab(tab) {
  registerCleanupFunction(() => closeVideoTab(tab));
  return tab;
}

async function closeVideoTab(tab) {
  if (!tab.isConnected) {
    return;
  }
  if (!tab.closing) {
    // Stop playback and release media resources before destroying the page.
    try {
      await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
        for (const video of content.document.querySelectorAll("video")) {
          video.pause();
          video.removeAttribute("src");
          video.querySelectorAll("source").forEach(source => source.remove());
          video.load();
        }
      });
    } finally {
      // removeTab itself returns void. The final SessionStore message is
      // Firefox's completion signal for teardown of this browser's content.
      const flushed = BrowserTestUtils.waitForSessionStoreUpdate(tab);
      BrowserTestUtils.removeTab(tab, { animate: false });
      await flushed;
    }
  } else {
    await TestUtils.waitForCondition(() => !tab.isConnected, "The video tab finished closing");
  }
}

async function openVideo(query = "", selector = "#video", win = window) {
  // Own the tab before navigation or metadata can fail.
  const tab = ownVideoTab(BrowserTestUtils.addTab(win.gBrowser, "about:blank"));
  const browser = tab.linkedBrowser;
  await BrowserTestUtils.switchTab(win.gBrowser, tab);
  const loaded = BrowserTestUtils.browserLoaded(browser, false, VIDEO_PAGE + query);
  BrowserTestUtils.startLoadingURIString(browser, VIDEO_PAGE + query);
  await loaded;
  await SpecialPowers.spawn(browser, [selector], async sel => {
    const video = content.document.querySelector(sel);
    // A decoder failure is terminal; report it rather than calling it a slow
    // load. Keep the same metadata wait budget as the original test.
    await ContentTaskUtils.waitForCondition(() => {
      if (video.error) {
        throw new Error(`Video load failed: ${video.error.code} ${video.error.message} (${video.currentSrc})`);
      }
      return video.readyState >= 1;
    }, "The video has its metadata");
    await ContentTaskUtils.waitForCondition(() => {
      const actor = content.windowGlobalChild.getExistingActor("WhimsyVideoSpeed");
      return actor?.videos.has(video) && actor.siteRate !== null;
    }, "The control knows the video");
  });
  browser.focus();
  return { tab, browser };
}

async function shownLiveControl(browser) {
  return TestUtils.waitForCondition(async () => {
    const state = await videoControl(browser);
    return state?.right?.shown && state;
  }, "The live video's top-right plates show");
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

// Summarize's own thread, drawn and answered, with its source note (the last
// thing Summarize adds, after the answer and its chips). Closing chat keeps
// the last thread drawn, and reopening shows it until the new one renders,
// so an earlier summary's answer must never count (freshChatStore forgets
// earlier summaries, so only this one is owned).
async function summaryAnswered() {
  await TestUtils.waitForCondition(() => {
    const panel = chatPanel();
    return (
      panel.isOpen &&
      panel.ready &&
      WhimsyVideoSummary.owns(panel.thread) &&
      panel.body.querySelector(".whimsy-chat-msg[data-role='ai']:not([busy])") &&
      panel.body.querySelector(".whimsy-chat-note[data-kind='video-source']")
    );
  }, "The summary is in");
}
