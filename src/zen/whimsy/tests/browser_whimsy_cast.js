/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/small: Cast to AirPlay (Arc's View > Cast...). The native AVPlayer
// side (nsIWhimsyAirPlay) can't pick a real receiver in a test, so a
// stand-in records what the front end asks of it and answers like it.

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_cast.html";
const MSE =
  "https://example.com/document-builder.sjs?html=" +
  encodeURIComponent(
    "<video id=v width=320 height=180></video><script>v.src = URL.createObjectURL(new Blob(['x'], {type: 'video/mp4'}))</script>"
  );
const { WhimsyCast } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCast.sys.mjs");

function fakeNative() {
  return {
    calls: [],
    listener: null,
    active: false,
    currentTime: 0,
    cast(url, time, x, y, listener) {
      this.calls.push({ url, time, x, y });
      this.listener = listener;
    },
    stop() {
      this.calls.push({ stop: true });
      const listener = this.listener;
      this.listener = null;
      listener?.("disconnected", this.currentTime);
    },
    pause() {},
    resume() {},
    seek() {},
  };
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["media.autoplay.default", 0]] });
  registerCleanupFunction(() => {
    WhimsyCast.stop();
    WhimsyCast.nativeOverride = null;
  });
});

add_task(async function test_native_interface() {
  if (AppConstants.platform == "macosx" && Cc["@whimsy/airplay;1"]) {
    const native = Cc["@whimsy/airplay;1"].getService(Ci.nsIWhimsyAirPlay);
    ok(!native.active, "The native player starts idle");
    is(native.currentTime, 0, "with no position");
    native.stop();
    Assert.throws(
      () => native.cast("blob:https://example.com/x", 0, 0, 0, () => {}),
      // Same code as NS_ERROR_ILLEGAL_VALUE (the name XPConnect prints).
      e => e.result == Cr.NS_ERROR_INVALID_ARG,
      "Only http(s) addresses can be cast"
    );
  } else {
    ok(true, "No native AirPlay player on this platform");
  }
});

add_task(async function test_cast_direct_video() {
  const native = fakeNative();
  WhimsyCast.nativeOverride = native;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], async () => {
    const v = content.document.getElementById("direct");
    await v.play();
  });

  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const action = globalActions.find(a => a.l10nId == "whimsy-action-cast");
  ok(action?.isAvailable(window), "The command bar offers Cast to AirPlay");
  const stopAction = globalActions.find(a => a.l10nId == "whimsy-action-cast-stop");
  ok(!stopAction?.isAvailable(window), "Stop Casting is hidden until a cast runs");

  is(await WhimsyCast.cast(window), "picking", "The AirPlay picker opens");
  is(native.calls.length, 1, "The native player was asked once");
  ok(native.calls[0].url.endsWith("whimsy_audio.ogg"), "with the video's own address");
  ok(Number.isFinite(native.calls[0].x) && Number.isFinite(native.calls[0].y), "anchored at a screen point");
  ok(WhimsyCast.casting, "A session runs");
  ok(stopAction.isAvailable(window), "Stop Casting is offered now");
  ok(!action.isAvailable(window), "and Cast to AirPlay isn't");

  native.listener("connected", 0);
  await TestUtils.waitForCondition(
    () => SpecialPowers.spawn(browser, [], () => content.document.getElementById("direct").paused),
    "The page's video pauses while the TV plays"
  );

  native.currentTime = 0.5;
  WhimsyCast.stop();
  ok(native.calls.at(-1).stop, "Stopping stops the native player");
  ok(!WhimsyCast.casting, "and ends the session");
  await TestUtils.waitForCondition(
    () =>
      SpecialPowers.spawn(browser, [], () => {
        const v = content.document.getElementById("direct");
        return Math.abs(v.currentTime - Math.min(0.5, v.duration)) < 0.2;
      }),
    "The page's video picks up where the TV left off"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_closing_the_tab_stops() {
  const native = fakeNative();
  WhimsyCast.nativeOverride = native;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  is(await WhimsyCast.cast(window), "picking", "Casting");
  BrowserTestUtils.removeTab(tab);
  ok(native.calls.at(-1).stop, "Closing the tab stops the cast");
  ok(!WhimsyCast.casting, "No session is left");
});

add_task(async function test_cancelled_picker() {
  const native = fakeNative();
  WhimsyCast.nativeOverride = native;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await WhimsyCast.cast(window);
  native.listener("cancelled", 0);
  ok(!WhimsyCast.casting, "Closing the picker without a receiver ends the session");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_media_source_points_to_mirroring() {
  const native = fakeNative();
  WhimsyCast.nativeOverride = native;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, MSE);
  is(await WhimsyCast.cast(window), "mirror", "A blob: video can't be sent on its own");
  is(native.calls.length, 0, "The native player isn't asked");
  ok(!WhimsyCast.casting, "No session starts");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_no_video_and_switch() {
  const native = fakeNative();
  WhimsyCast.nativeOverride = native;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  is(await WhimsyCast.cast(window), "no-video", "Nothing to cast on a page without video");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.cast", false]] });
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  ok(!globalActions.find(a => a.l10nId == "whimsy-action-cast").isAvailable(window), "The switch hides the command");
  is(await WhimsyCast.cast(window), "off", "and turns casting off");
  await SpecialPowers.popPrefEnv();
  is(native.calls.length, 0, "The native player was never asked");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_view_menu_item() {
  const item = document.getElementById("menu_whimsyCast");
  ok(item, "View > Cast... exists");
  is(item.parentElement.id, "menu_viewPopup", "in the View menu");
});
