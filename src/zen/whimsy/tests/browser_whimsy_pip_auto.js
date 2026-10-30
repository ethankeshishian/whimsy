/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// fixD: automatic picture-in-picture (Arc): leaving a tab, or a space,
// while its video plays pops the video out. It's Firefox's own auto-PiP;
// background muting used to mute the tab first, and Firefox never pops out
// a muted tab. The tab now gets a moment to pop out before it's muted.

const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_video_sound.html";
const AUTO_PIP = "media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled";
const FEATURE = "whimsy.feature.pip-auto-before-mute";
const { PictureInPicture } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/pictureinpicture/PictureInPicture.sys.mjs"
);

const muted = tab => tab.hasAttribute("muted");
const players = () => [...Services.wm.getEnumerator("Toolkit:PictureInPicture")];

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["media.autoplay.default", 0],
      ["media.autoplay.blocking_policy", 0],
      ["media.videocontrols.picture-in-picture.video-toggle.min-video-secs", 0],
      [AUTO_PIP, true],
      // Every tab you leave would be muted.
      ["whimsy.media.background-mute", "background"],
    ],
  });
});

async function openPlayingVideo() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const video = content.document.getElementById("video");
    await ContentTaskUtils.waitForCondition(() => video.readyState >= 2, "video loaded");
    await video.play();
  });
  await TestUtils.waitForCondition(() => tab.soundPlaying, "the video plays sound");
  await TestUtils.waitForCondition(
    () => PictureInPicture.getEligiblePipVideoCount(tab.linkedBrowser).totalPipCount > 0,
    "the page reports a PiP-able video"
  );
  return tab;
}

async function closeAllPlayers() {
  for (const win of players()) {
    const closed = BrowserTestUtils.domWindowClosed(win);
    win.close();
    await closed;
  }
}

add_task(async function test_leaving_the_tab_pops_out_unmuted() {
  const video = await openPlayingVideo();
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(null);
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  const player = await opened;
  is(player.document.documentElement.getAttribute("windowtype"), "Toolkit:PictureInPicture", "The video popped out");
  await TestUtils.waitForCondition(() => video.pictureinpicture, "the tab is in PiP");
  await new Promise(r => setTimeout(r, 1500));
  ok(!muted(video), "A tab in PiP keeps its sound");
  // fix7: Whimsy's fallback leaves it to Firefox here, so the player isn't
  // toggled twice (a second toggle would close it).
  is(players().length, 1, "Exactly one player, still open");
  ok(video.pictureinpicture, "and the tab is still in PiP");

  const closed = BrowserTestUtils.domWindowClosed(player);
  gBrowser.selectedTab = video;
  await closed;
  ok(true, "Back on the tab, the video goes back in the page");
  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(video);
});

add_task(async function test_leaving_the_space_pops_out() {
  const first = gZenWorkspaces.getWorkspaces().find(w => w.uuid === gZenWorkspaces.activeWorkspace);
  const second = await gZenWorkspaces.createAndSaveWorkspace("PiP test", undefined, true);
  let video;
  try {
    await gZenWorkspaces.changeWorkspace(first);
    video = await openPlayingVideo();
    const opened = BrowserTestUtils.domWindowOpenedAndLoaded(null);
    await gZenWorkspaces.changeWorkspace(second);
    const player = await opened;
    is(player.document.documentElement.getAttribute("windowtype"), "Toolkit:PictureInPicture", "Switching spaces pops the video out");
    await new Promise(r => setTimeout(r, 1500));
    ok(!muted(video), "and it keeps playing out loud");
    const closed = BrowserTestUtils.domWindowClosed(player);
    await gZenWorkspaces.changeWorkspace(first);
    gBrowser.selectedTab = video;
    await closed;
    ok(true, "Back in the space, on the tab, the player closes");
  } finally {
    await closeAllPlayers();
    if (video) {
      BrowserTestUtils.removeTab(video);
    }
    await gZenWorkspaces.changeWorkspace(first);
    await gZenWorkspaces.removeWorkspace(second.uuid);
  }
});

add_task(async function test_audio_only_tab_is_muted_as_before() {
  const audioPage = PAGE.replace("whimsy_video_sound.html", "whimsy_media.html");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, audioPage);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.getElementById("audio").play());
  await TestUtils.waitForCondition(() => tab.soundPlaying, "plays");
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  await TestUtils.waitForCondition(() => muted(tab), "No video: muted when you leave");
  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_switch_off_mutes_first() {
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
  const video = await openPlayingVideo();
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  await TestUtils.waitForCondition(() => muted(video), "Off: muted on the switch");
  await new Promise(r => setTimeout(r, 1500));
  is(players().length, 0, "Off: Firefox doesn't pop out a muted tab");
  await closeAllPlayers();
  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(video);
  await SpecialPowers.popPrefEnv();
});

// fix7: Firefox listens for the page going hidden only while a video is on
// screen. Scrolled down to the comments, leaving the tab still pops the
// video out (Whimsy's fallback asks the page).
add_task(async function test_scrolled_away_video_still_pops_out() {
  const video = await openPlayingVideo();
  await SpecialPowers.spawn(video.linkedBrowser, [], async () => {
    const spacer = content.document.createElement("div");
    spacer.style.height = "5000px";
    content.document.body.append(spacer);
    content.scrollTo(0, 4000);
    const toggle = content.windowGlobalChild.getActor("PictureInPictureToggle");
    await ContentTaskUtils.waitForCondition(
      () => !toggle.docState.isTrackingVideos,
      "Firefox stops watching the page once the video is off screen"
    );
  });
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(null);
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  const player = await opened;
  is(player.document.documentElement.getAttribute("windowtype"), "Toolkit:PictureInPicture", "The video popped out anyway");
  await TestUtils.waitForCondition(() => video.pictureinpicture, "the tab is in PiP");
  await new Promise(r => setTimeout(r, 1500));
  is(players().length, 1, "One player");
  ok(!muted(video), "and it keeps its sound");
  const closed = BrowserTestUtils.domWindowClosed(player);
  gBrowser.selectedTab = video;
  await closed;
  ok(true, "Back on the tab, the player closes (it was an automatic one)");
  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(video);
});

// fix7: closing the player by hand still skips the next automatic one.
add_task(async function test_fallback_respects_closed_by_hand() {
  const video = await openPlayingVideo();
  PictureInPicture.weakAutoPipBrowserClosedDeliberately.add(video.linkedBrowser);
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  await new Promise(r => setTimeout(r, 1500));
  is(players().length, 0, "No player after closing the last one by hand");
  ok(
    !PictureInPicture.weakAutoPipBrowserClosedDeliberately.has(video.linkedBrowser),
    "and only that one switch is skipped"
  );
  await closeAllPlayers();
  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(video);
});
