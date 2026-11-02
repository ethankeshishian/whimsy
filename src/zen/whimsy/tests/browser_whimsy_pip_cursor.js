/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W9-15: the pointer must never stay hidden after a video pops out. Each way
// to pop out is covered: the in-video Picture-in-Picture button, the
// keyboard shortcut (also what Zen's media controller and the command bar
// send), Whimsy's automatic pop-out on leaving the tab, Whimsy's floating
// calls, and popping out of a full-screen video. After each, the test moves
// the pointer over the page's video and over the player window and reads the
// cursor that would be drawn there: the computed `cursor` of the deepest
// element under the pointer (into the video controls' shadow tree), walking
// up until something sets one.

const PAGE =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_pip_cursor.html";
const { PictureInPicture } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/pictureinpicture/PictureInPicture.sys.mjs"
);

const players = () => [...Services.wm.getEnumerator("Toolkit:PictureInPicture")].filter(w => !w.closed);

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["media.autoplay.default", 0],
      ["media.autoplay.blocking_policy", 0],
      ["media.videocontrols.picture-in-picture.enabled", true],
      ["media.videocontrols.picture-in-picture.video-toggle.enabled", true],
      ["media.videocontrols.picture-in-picture.video-toggle.always-show", true],
      ["media.videocontrols.picture-in-picture.video-toggle.min-video-secs", 0],
      ["media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled", true],
      ["full-screen-api.allow-trusted-requests-only", false],
      ["full-screen-api.transition-duration.enter", "0 0"],
      ["full-screen-api.transition-duration.leave", "0 0"],
      ["whimsy.media.background-mute", "off"],
    ],
  });
});

// The cursor under the pointer in a content page, after a real mouse move
// to the element's center.
async function pageCursor(browser, selector, { move = true } = {}) {
  if (move) {
    await BrowserTestUtils.synthesizeMouseAtCenter(selector, { type: "mousemove" }, browser);
  }
  return SpecialPowers.spawn(browser, [selector], async sel => {
    await new Promise(r => content.requestAnimationFrame(() => content.requestAnimationFrame(r)));
    const rect = content.document.querySelector(sel).getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    let el = content.document.elementFromPoint(x, y);
    for (let i = 0; i < 5 && el?.openOrClosedShadowRoot; i++) {
      const inner = el.openOrClosedShadowRoot.elementFromPoint(x, y);
      if (!inner || inner == el) {
        break;
      }
      el = inner;
    }
    for (let node = el; node; node = node.parentElement ?? node.getRootNode?.().host ?? null) {
      if (node.nodeType != node.ELEMENT_NODE) {
        continue;
      }
      const cursor = content.getComputedStyle(node).cursor;
      if (cursor != "auto") {
        return cursor;
      }
    }
    return "auto";
  });
}

// The same over the player window's video.
async function playerCursor(player) {
  const doc = player.document;
  await TestUtils.waitForCondition(() => doc.readyState == "complete" && doc.getElementById("browser"), "player ready");
  const target = doc.getElementById("browser");
  EventUtils.synthesizeMouseAtCenter(target, { type: "mousemove" }, player);
  await new Promise(r => player.requestAnimationFrame(() => player.requestAnimationFrame(r)));
  const rect = target.getBoundingClientRect();
  let el = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  for (let node = el; node; node = node.parentElement) {
    const cursor = player.getComputedStyle(node).cursor;
    if (cursor != "auto") {
      return cursor;
    }
  }
  return "auto";
}

async function openPage(playId) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await SpecialPowers.spawn(tab.linkedBrowser, [playId], async id => {
    const video = content.document.getElementById(id);
    await ContentTaskUtils.waitForCondition(() => video.readyState >= 2, "video loaded");
    await video.play();
  });
  await TestUtils.waitForCondition(() => tab.soundPlaying, "the video plays sound");
  // Firefox tracks a page's videos once the pointer has been over one.
  await BrowserTestUtils.synthesizeMouseAtCenter(`#${playId}`, { type: "mousemove" }, tab.linkedBrowser);
  await TestUtils.waitForCondition(
    () => PictureInPicture.getEligiblePipVideoCount(tab.linkedBrowser).totalPipCount > 0,
    "the page reports a PiP-able video"
  );
  return tab;
}

async function closePlayers() {
  for (const win of players()) {
    const closed = BrowserTestUtils.domWindowClosed(win);
    win.close();
    await closed;
  }
}

async function expectVisibleCursor(tab, selector, player, how) {
  isnot(await pageCursor(tab.linkedBrowser, selector), "none", `${how}: the pointer shows over the page's video`);
  isnot(await playerCursor(player), "none", `${how}: the pointer shows over the player`);
}

function waitForPlayer() {
  return BrowserTestUtils.domWindowOpenedAndLoaded(null, win =>
    win.document.documentElement.getAttribute("windowtype") == "Toolkit:PictureInPicture"
  );
}

// The PiP button drawn over the video (videocontrols' toggle).
add_task(async function test_video_toggle() {
  const tab = await openPage("native");
  const browser = tab.linkedBrowser;
  await BrowserTestUtils.synthesizeMouseAtCenter("#native", { type: "mousemove" }, browser);
  const toggle = await SpecialPowers.spawn(browser, [], async () => {
    const shadow = content.document.getElementById("native").openOrClosedShadowRoot;
    const button = shadow.getElementById("pictureInPictureToggle");
    await ContentTaskUtils.waitForCondition(() => !button.hidden && button.getBoundingClientRect().width > 0, "toggle");
    const r = button.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const opened = waitForPlayer();
  for (const type of ["mousemove", "mousedown", "mouseup"]) {
    await BrowserTestUtils.synthesizeMouseAtPoint(toggle.x, toggle.y, { type }, browser);
  }
  const player = await opened;
  await expectVisibleCursor(tab, "#native", player, "In-video button");
  await closePlayers();
  BrowserTestUtils.removeTab(tab);
});

// Firefox's Picture-in-Picture command (shortcut, menu, command bar), and
// Zen's media controller's PiP button, which sends PictureInPicture:KeyToggle.
add_task(async function test_keyboard_and_media_controller() {
  for (const how of ["command", "media controller"]) {
    const tab = await openPage("custom");
    const opened = waitForPlayer();
    if (how == "command") {
      // Firefox's Picture-in-Picture command (its shortcut, menu item and
      // the command bar row run it).
      await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.focus());
      document.getElementById("View:PictureInPicture").doCommand();
    } else {
      tab.linkedBrowser.browsingContext.currentWindowGlobal
        .getActor("PictureInPictureLauncher")
        .sendAsyncMessage("PictureInPicture:KeyToggle");
    }
    const player = await opened;
    await expectVisibleCursor(tab, "#player", player, how);
    await closePlayers();
    BrowserTestUtils.removeTab(tab);
  }
});

// Whimsy's automatic pop-out when leaving the tab, then coming back.
add_task(async function test_auto_pip_on_leaving_the_tab() {
  const tab = await openPage("custom");
  const opened = waitForPlayer();
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  const player = await opened;
  isnot(await playerCursor(player), "none", "Auto pop-out: the pointer shows over the player");
  await BrowserTestUtils.switchTab(gBrowser, tab);
  await TestUtils.waitForCondition(() => !players().length || !tab.pictureinpicture, "back on the tab");
  isnot(await pageCursor(tab.linkedBrowser, "#player"), "none", "Auto pop-out: the pointer shows back on the page");
  await closePlayers();
  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(tab);
});

// Whimsy's floating calls (WhimsyCallPip → Whimsy:CallPip).
add_task(async function test_call_pip() {
  const tab = await openPage("custom");
  const opened = waitForPlayer();
  await tab.linkedBrowser.browsingContext.currentWindowGlobal.getActor("WhimsyPage").sendQuery("Whimsy:CallPip");
  const player = await opened;
  await expectVisibleCursor(tab, "#player", player, "Floating call");
  await closePlayers();
  BrowserTestUtils.removeTab(tab);
});

// Popping out of a full-screen video whose controls had faded (they hide
// the pointer while full screen): the root cause. The controls' spacer kept
// cursor: none after the video left full screen or went into the player,
// until the controls faded in again, so the pointer vanished over the video
// (and macOS kept it hidden over the player window that opened under it).
add_task(async function test_pop_out_of_full_screen() {
  const tab = await openPage("native");
  const browser = tab.linkedBrowser;
  const hidesCursor = () =>
    SpecialPowers.spawn(browser, [], () =>
      content.document.getElementById("native").openOrClosedShadowRoot.querySelector(".controlsSpacer").hasAttribute("hideCursor")
    );
  const entered = BrowserTestUtils.waitForEvent(window, "fullscreen");
  await SpecialPowers.spawn(browser, [], async () => {
    SpecialPowers.wrap(content.document).notifyUserGestureActivation();
    await content.document.getElementById("native").requestFullscreen();
  });
  await entered;
  // The controls fade out after a moment without moving, hiding the pointer.
  await TestUtils.waitForCondition(hidesCursor, "controls faded", 100, 100);
  is(await pageCursor(browser, "#native", { move: false }), "none", "Full screen, idle: the pointer is hidden (expected)");

  const opened = waitForPlayer();
  browser.browsingContext.currentWindowGlobal
    .getActor("PictureInPictureLauncher")
    .sendAsyncMessage("PictureInPicture:KeyToggle");
  const player = await opened;
  await TestUtils.waitForCondition(async () => !(await hidesCursor()), "popping out stops hiding the pointer");
  isnot(await playerCursor(player), "none", "Full screen: the pointer shows over the player");
  if (document.fullscreenElement || window.fullScreen) {
    const left = BrowserTestUtils.waitForEvent(window, "fullscreen");
    await SpecialPowers.spawn(browser, [], () => content.document.exitFullscreen());
    await left;
  }
  ok(!(await hidesCursor()), "Out of full screen, the controls don't hide the pointer");
  isnot(await pageCursor(browser, "#native", { move: false }), "none", "…before the pointer even moves");
  isnot(await pageCursor(browser, "#native"), "none", "…and after");
  await closePlayers();

  // Leaving full screen without popping out (Esc) also gives the pointer back.
  await TestUtils.waitForCondition(() => !players().length && !tab.pictureinpicture, "back in the page");
  // Full screen needs the focused tab, and a closing player (headed) can
  // leave the window without focus: back to the page first, as a person
  // clicking into it would.
  await SimpleTest.promiseFocus(window);
  await SpecialPowers.spawn(browser, [], async () => {
    const video = content.document.getElementById("native");
    SpecialPowers.wrap(content.document).notifyUserGestureActivation();
    await video.requestFullscreen();
    await ContentTaskUtils.waitForCondition(() => content.document.fullscreenElement == video, "full screen again");
  });
  await TestUtils.waitForCondition(hidesCursor, "controls faded again", 100, 100);
  await SpecialPowers.spawn(browser, [], async () => {
    await content.document.exitFullscreen();
    await ContentTaskUtils.waitForCondition(() => !content.document.fullscreenElement, "left full screen");
  });
  ok(!(await hidesCursor()), "Leaving full screen gives the pointer back");
  BrowserTestUtils.removeTab(tab);
});
