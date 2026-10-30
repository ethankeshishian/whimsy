/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Picture-in-picture keeps Firefox's own buttons: X closes the player and
// pauses the video; "Back to tab" (the arrow) is visible, returns to the
// video's tab and keeps it playing there.

const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_video.html";

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
  await TestUtils.waitForCondition(
    () => win.document.getElementById("close") && win.document.getElementById("unpip"),
    "player ready"
  );
  return win;
}

const paused = browser => SpecialPowers.spawn(browser, [], () => content.document.getElementById("video").paused);

const backInPage = browser =>
  SpecialPowers.spawn(browser, [], async () => {
    const video = content.document.getElementById("video");
    await ContentTaskUtils.waitForCondition(() => !video.isCloningElementVisually, "back in the page");
  });

add_task(async function test_x_closes_and_pauses() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const player = await openPip(tab.linkedBrowser);
  const closed = BrowserTestUtils.domWindowClosed(player);
  EventUtils.synthesizeMouseAtCenter(player.document.getElementById("close"), {}, player);
  await closed;
  await backInPage(tab.linkedBrowser);
  await TestUtils.waitForCondition(() => paused(tab.linkedBrowser), "X pauses the video (Firefox's default)");
  ok(await paused(tab.linkedBrowser), "The video is paused after X");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_back_to_tab_keeps_playing() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const player = await openPip(tab.linkedBrowser);
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  ok(!player.closed, "The player stays open on another tab");

  const unpip = player.document.getElementById("unpip");
  ok(!unpip.hidden, "Back to tab isn't hidden");
  const rect = unpip.getBoundingClientRect();
  ok(rect.width > 0 && rect.height > 0, "Back to tab has a size in the player");
  isnot(player.getComputedStyle(unpip).display, "none", "...and is displayed");
  isnot(player.getComputedStyle(unpip).visibility, "hidden", "...and visible");

  const closed = BrowserTestUtils.domWindowClosed(player);
  EventUtils.synthesizeMouseAtCenter(unpip, {}, player);
  await closed;
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == tab, "Back to tab selects the video's tab");
  await backInPage(tab.linkedBrowser);
  await new Promise(r => setTimeout(r, 300));
  ok(!(await paused(tab.linkedBrowser)), "The video keeps playing in its tab");
  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(tab);
});
