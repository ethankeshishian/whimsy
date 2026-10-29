/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// PiP snaps back (Arc): returning to a tab whose video is in a
// picture-in-picture window puts the video back in the page, even when the
// player was opened by hand. Firefox's automatic PiP is on by default.

const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_video.html";
const AUTO_PIP = "media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled";

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
  await TestUtils.waitForCondition(() => win.document.getElementById("unpip"), "player ready");
  return win;
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["media.autoplay.default", 0],
      ["media.autoplay.blocking_policy", 0],
      // Keep this test about the manual player.
      [AUTO_PIP, false],
    ],
  });
});

add_task(async function test_defaults() {
  ok(Services.prefs.getDefaultBranch("").getBoolPref(AUTO_PIP), "Automatic PiP is on by default (Arc)");
  ok(Services.prefs.getBoolPref("whimsy.media.pip-snap-back"), "Snap back is on");
});

add_task(async function test_snap_back() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  gBrowser.selectedTab = tab;
  const player = await openPip(tab.linkedBrowser);
  gBrowser.selectedTab = other;
  await new Promise(r => setTimeout(r, 200));
  ok(!player.closed, "The player stays open while you're on another tab");
  const closed = BrowserTestUtils.domWindowClosed(player);
  gBrowser.selectedTab = tab;
  await closed;
  ok(true, "Returning to the tab puts the video back in the page");
  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_off() {
  for (const [pref, value] of [
    ["whimsy.media.pip-snap-back", false],
    ["whimsy.feature.pip-snap-back", false],
  ]) {
    await SpecialPowers.pushPrefEnv({ set: [[pref, value]] });
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
    const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
    gBrowser.selectedTab = tab;
    const player = await openPip(tab.linkedBrowser);
    gBrowser.selectedTab = other;
    gBrowser.selectedTab = tab;
    await new Promise(r => setTimeout(r, 300));
    ok(!player.closed, `${pref} off: the player stays open`);
    const closed = BrowserTestUtils.domWindowClosed(player);
    player.close();
    await closed;
    BrowserTestUtils.removeTab(other);
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_settings() {
  await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
    const doc = browser.contentDocument;
    const row = await TestUtils.waitForCondition(() => doc.getElementById("whimsyPipSnapBack"), "Snap-back row");
    await TestUtils.waitForCondition(() => row.checked, "reflects the pref");
  });
});
