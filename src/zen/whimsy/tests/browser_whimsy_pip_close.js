/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// fixD: closing the picture-in-picture window with X keeps the video
// playing back in its tab (Arc). Firefox pauses it unless Shift is held.

const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_video.html";
const FEATURE = "whimsy.feature.pip-close-keeps-playing";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["media.autoplay.default", 0],
      ["media.autoplay.blocking_policy", 0],
      ["media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled", false],
    ],
  });
});

async function openPip(browser) {
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(null);
  await SpecialPowers.spawn(browser, [], async () => {
    const video = content.document.getElementById("video");
    await video.play();
    const event = new content.CustomEvent("MozTogglePictureInPicture", { bubbles: true });
    content.windowUtils.dispatchEventToChromeOnly(video, event);
    await ContentTaskUtils.waitForCondition(() => video.isCloningElementVisually, "cloned into the player");
  });
  const win = await opened;
  await TestUtils.waitForCondition(() => win.document.getElementById("close"), "player ready");
  return win;
}

const paused = browser => SpecialPowers.spawn(browser, [], () => content.document.getElementById("video").paused);

async function closeWithX(player) {
  const closed = BrowserTestUtils.domWindowClosed(player);
  EventUtils.synthesizeMouseAtCenter(player.document.getElementById("close"), {}, player);
  await closed;
}

add_task(async function test_x_keeps_playing() {
  ok(Services.prefs.getBoolPref(FEATURE), "On by default");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const player = await openPip(tab.linkedBrowser);
  await closeWithX(player);
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const video = content.document.getElementById("video");
    await ContentTaskUtils.waitForCondition(() => !video.isCloningElementVisually, "back in the page");
  });
  await new Promise(r => setTimeout(r, 300));
  ok(!(await paused(tab.linkedBrowser)), "The video keeps playing in its tab");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_other_buttons_unchanged() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const player = await openPip(tab.linkedBrowser);
  // Play/pause still pauses.
  player.document.getElementById("playpause").click();
  await TestUtils.waitForCondition(async () => await paused(tab.linkedBrowser), "Pause still pauses");
  await closeWithX(player);
  ok(await paused(tab.linkedBrowser), "Closing doesn't start a paused video");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_switch_off_pauses() {
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const player = await openPip(tab.linkedBrowser);
  await closeWithX(player);
  await TestUtils.waitForCondition(async () => await paused(tab.linkedBrowser), "Off: Firefox pauses on X");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
