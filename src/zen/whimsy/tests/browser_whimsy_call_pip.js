/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Floating calls (Arc): leaving a tab that's in a video call (it uses the
// camera or microphone) puts the call's main video in picture-in-picture;
// coming back closes it. whimsy_call.html stands in for Meet: fake camera
// and microphone, shown in muted videos, one of them a mirrored self-view.

const { WhimsyCallPip } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCallPip.sys.mjs");

const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_call.html";

function pipWindow() {
  return Services.wm.getMostRecentWindow("Toolkit:PictureInPicture");
}

async function openCall() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.wrappedJSObject.startCall());
  await TestUtils.waitForCondition(() => WhimsyCallPip.isInCall(tab), "The tab is in a call");
  return tab;
}

async function cloned(tab, id) {
  return SpecialPowers.spawn(tab.linkedBrowser, [id], videoId =>
    content.document.getElementById(videoId).isCloningElementVisually
  );
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["media.navigator.streams.fake", true],
      ["media.navigator.permission.disabled", true],
      ["media.autoplay.default", 0],
      ["media.autoplay.blocking_policy", 0],
    ],
  });
});

add_task(async function test_call_floats_and_returns() {
  ok(Services.prefs.getBoolPref("whimsy.feature.call-pip"), "The switch is on");
  const call = await openCall();
  const other = BrowserTestUtils.addTab(gBrowser, "about:blank");

  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(null);
  gBrowser.selectedTab = other;
  const pip = await opened;
  is(pip.document.documentElement.getAttribute("windowtype"), "Toolkit:PictureInPicture", "The call floats");
  await TestUtils.waitForCondition(async () => cloned(call, "speaker"), "The speaker's video, not the self-view");
  ok(!(await cloned(call, "self")), "The mirrored self-view stays in the page");

  const closed = BrowserTestUtils.domWindowClosed(pip);
  gBrowser.selectedTab = call;
  await closed;
  ok(!pipWindow(), "Coming back to the call closes the floating window");

  // Another switch floats it again.
  const reopened = BrowserTestUtils.domWindowOpenedAndLoaded(null);
  gBrowser.selectedTab = other;
  const pip2 = await reopened;
  const closed2 = BrowserTestUtils.domWindowClosed(pip2);
  gBrowser.selectedTab = call;
  await closed2;

  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(call);
});

add_task(async function test_not_in_a_call_or_switched_off() {
  const fake = { linkedBrowser: { _sharingState: { webRTC: { screen: "Screen" } } } };
  ok(!WhimsyCallPip.isInCall(fake), "Sharing only the screen isn't a call");
  fake.linkedBrowser._sharingState.webRTC.microphone = 1;
  ok(WhimsyCallPip.isInCall(fake), "Using the microphone is");
  ok(!WhimsyCallPip.isInCall({ linkedBrowser: {} }), "A tab with no sharing isn't");

  const call = await openCall();
  const other = BrowserTestUtils.addTab(gBrowser, "about:blank");
  Services.prefs.setBoolPref("whimsy.feature.call-pip", false);
  ok(!WhimsyCallPip.onTabSelect(window, call, other), "Switch off: nothing floats");
  gBrowser.selectedTab = other;
  // Give a stray PiP window time to show up.
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 500));
  ok(!pipWindow(), "No floating window");
  Services.prefs.clearUserPref("whimsy.feature.call-pip");

  gBrowser.selectedTab = call;
  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(call);
});
