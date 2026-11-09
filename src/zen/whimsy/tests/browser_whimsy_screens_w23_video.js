/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 video: screenshots of the plates (fu-media dec-1, media-1.3, 1.5,
// dec-3), the summary (media-1.7, fu-media 1.14), the speed note (media-2.3),
// back to default (fu-media 2.5), and Settings › Media (media-2.8, 2.9).

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_video_w23.js", this);

async function shootPage(name, browser, prepare) {
  await whimsyBothSchemes(name, async dark => {
    await prepare?.(dark);
    await new Promise(r => setTimeout(r, 200));
  });
  ok(true, `Shot ${name}`);
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
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

add_task(async function shots_plates() {
  const { tab, browser } = await openVideo();
  await shootPage("w23-video-dec-1", browser, () => hoverVideo(browser).then(() => shownControl(browser)));
  ok(true, "dec-1 shot");
  BrowserTestUtils.removeTab(tab);
  const small = await openVideo("", "#small");
  await shootPage("w23-video-media-1.5", small.browser, () => hoverVideo(small.browser, "#small").then(() => shownControl(small.browser)));
  BrowserTestUtils.removeTab(small.tab);
});

add_task(async function shots_speed() {
  const { tab, browser } = await openVideo();
  await shootPage("w23-video-2.5", browser, async () => {
    await SpecialPowers.spawn(browser, [], () => (content.document.getElementById("video").playbackRate = 2));
    await hoverVideo(browser);
    await TestUtils.waitForCondition(async () => (await videoControl(browser)).reset.shown, "Back to default shows");
  });
  BrowserTestUtils.removeTab(tab);
});

add_task(async function shots_summary() {
  await freshChatStore();
  stubProvider("Night trains nearly vanished from Europe by 2016, then came back as flying got pricier.\n\nChapters\n- 0:00 Why they disappeared\n- 0:01 ÖBB’s bet on Nightjet\n- 0:02 Riding Vienna to Paris");
  const { tab, browser } = await openVideo();
  await pressSummarize(browser);
  await summaryAnswered();
  await shootPage("w23-video-media-1.7", browser, () => hoverVideo(browser));
  await closeChat();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function shots_settings() {
  await BrowserTestUtils.withNewTab("about:preferences#whimsyMedia", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.getElementById("whimsyMediaVideosGroup") && !doc.getElementById("whimsyMediaVideosGroup").hidden, "Media shows");
    await whimsyBothSchemes("w23-video-media-2.8", async () => {
      await new Promise(r => setTimeout(r, 200));
    });
    ok(true, "media-2.8 shot");
  });
});
