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

// One call for the whole file: a second getUserMedia in the same run never
// resolved under the fake devices, so both tasks use this call and it hangs
// up at the end.
let sharedCall = null;
async function openCall() {
  if (sharedCall) {
    gBrowser.selectedTab = sharedCall;
    return sharedCall;
  }
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.wrappedJSObject.startCall());
  await TestUtils.waitForCondition(() => WhimsyCallPip.isInCall(tab), "The tab is in a call");
  sharedCall = tab;
  registerCleanupFunction(() => endCall(tab));
  return tab;
}

// Hangs up before the tab closes, as a call ends.
async function endCall(tab) {
  if (!tab.isConnected) {
    return; // W16-17's last task closed it mid-call.
  }
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.wrappedJSObject.endCall());
  await TestUtils.waitForCondition(() => !WhimsyCallPip.isInCall(tab), "The call ended");
  BrowserTestUtils.removeTab(tab);
}

async function cloned(tab, id) {
  return SpecialPowers.spawn(tab.linkedBrowser, [id], videoId =>
    content.document.getElementById(videoId).isCloningElementVisually
  );
}

const TOGGLE_HAS_USED_PREF = "media.videocontrols.picture-in-picture.video-toggle.has-used";

add_setup(async function () {
  // Floating a call for real opens a genuine PiP window, so Firefox's own
  // PiP code marks its toggle as used; that's not ours to leave behind.
  const hadToggleHasUsed = Services.prefs.prefHasUserValue(TOGGLE_HAS_USED_PREF);
  const toggleHasUsed = hadToggleHasUsed ? Services.prefs.getBoolPref(TOGGLE_HAS_USED_PREF) : null;
  registerCleanupFunction(() => {
    if (hadToggleHasUsed) {
      Services.prefs.setBoolPref(TOGGLE_HAS_USED_PREF, toggleHasUsed);
    } else {
      Services.prefs.clearUserPref(TOGGLE_HAS_USED_PREF);
    }
  });

  const { SitePermissions } = ChromeUtils.importESModule("resource:///modules/SitePermissions.sys.mjs");
  const principal = Services.scriptSecurityManager.createContentPrincipalFromOrigin("https://example.com");
  for (const id of ["camera", "microphone"]) {
    SitePermissions.setForPrincipal(principal, id, SitePermissions.ALLOW);
  }
  registerCleanupFunction(() => {
    for (const id of ["camera", "microphone"]) {
      SitePermissions.removeFromPrincipal(principal, id);
    }
  });
  await SpecialPowers.pushPrefEnv({
    set: [
      ["media.navigator.streams.fake", true],
      // Like Firefox's own WebRTC tests: fake devices behind a real, granted
      // permission, so the tab reports camera/microphone sharing.
      // (permission.disabled skips Firefox's WebRTC UI, so no tab would ever
      // look like it's in a call.)
      ["media.navigator.permission.fake", true],
      ["media.audio_loopback_dev", ""],
      ["media.video_loopback_dev", ""],
      // getUserMedia otherwise waits for the window to have OS focus, which
      // a test window in the middle of a run may not (Firefox's WebRTC tests
      // set the same).
      ["media.getusermedia.window.focus_source.enabled", false],
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
});

// The call's microphone and camera in the PiP window are covered by
// browser_whimsy_call_controls.js (W13-R3).
add_task(async function test_call_pip_captions() {
  const call = await openCall();

  const other = BrowserTestUtils.addTab(gBrowser, "about:blank");
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(null);
  gBrowser.selectedTab = other;
  const pip = await opened;
  WhimsyCallPip.hookPipWindow(pip);
  // The player's own script finishes setting up after load; Whimsy attaches
  // to it once it has (retrying every 50ms), and only then is it the call's.
  await TestUtils.waitForCondition(() => pip._whimsyCallBrowser == call.linkedBrowser, "The PiP window shows the call");

  // F31: the player's CC button shows in a call and turns its live
  // captions on and off.
  const cc = pip.document.getElementById("closed-caption");
  ok(cc && !cc.hidden && !cc.disabled, "CC shows in the call's PiP window");
  const toggled = [];
  const toggle = WhimsyCallPip.toggleCaptions;
  WhimsyCallPip.toggleCaptions = async browser => toggled.push(browser);
  try {
    // Firefox's player drops CC from windows under 476px wide.
    pip.resizeTo(720, 420);
    await TestUtils.waitForCondition(() => cc.getBoundingClientRect().width > 0, "A PiP window wide enough for CC");
    EventUtils.synthesizeMouseAtCenter(cc, {}, pip);
    await TestUtils.waitForCondition(() => toggled.length == 1, "CC turns the call's captions on");
    is(toggled[0], call.linkedBrowser, "...for the call's tab");
    ok(!pip.document.getElementById("settings")?.matches?.(":popover-open"), "...not the player's subtitle settings");
  } finally {
    WhimsyCallPip.toggleCaptions = toggle;
  }
  WhimsyCallPip.showCaption(call.linkedBrowser, "hello from the call");
  is(pip.document.getElementById("whimsy-call-caption")?.textContent, "hello from the call", "Captions show in the PiP window");

  const closed = BrowserTestUtils.domWindowClosed(pip);
  gBrowser.selectedTab = call;
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  ok(globalActions.find(a => a.l10nId == "whimsy-action-call-captions").isAvailable(window),
    "Live Captions for This Call is offered in the call");
  await closed;
  BrowserTestUtils.removeTab(other);
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
});

// W16-17: a capture-only call (a camera test page: no peer connection, no
// call controls) gets the small player; its PiP camera button blocks the
// device and the block holds; its microphone button, with no microphone
// captured, isn't offered.
add_task(async function test_capture_only_call() {
  const call = await openCall();
  const browser = call.linkedBrowser;
  const cardFor = () => [...document.querySelectorAll("#zen-media-controls-toolbar .zen-media-card[media-sharing]")]
    .find(card => card._whimsyCallBrowser == browser && !card.hasAttribute("zen-removing"));
  await TestUtils.waitForCondition(cardFor, "The capture-only call has its small player");
  ok(cardFor().hasAttribute("whimsy-call-hide-mic"), "…with no microphone button (none is captured)");

  const other = BrowserTestUtils.addTab(gBrowser, "about:blank");
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(null);
  gBrowser.selectedTab = other;
  const pip = await opened;
  await TestUtils.waitForCondition(() => pip._whimsyCallBrowser == browser, "The call floats");
  const camera = await TestUtils.waitForCondition(() => {
    const el = pip.document.getElementById("whimsy-call-camera");
    return el && !el.hidden && el;
  }, "The PiP has its camera button");
  ok(pip.document.getElementById("whimsy-call-mic").hidden, "…and no microphone button");
  EventUtils.synthesizeMouseAtCenter(pip.document.getElementById("controls"), { type: "mousemove" }, pip);
  EventUtils.synthesizeMouseAtCenter(camera, {}, pip);
  await TestUtils.waitForCondition(() => WhimsyCallPip.stateFor(browser).blocked.camera, "The camera button blocks the device");
  await new Promise(resolve => setTimeout(resolve, 1000)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
  ok(WhimsyCallPip.stateFor(browser).blocked.camera, "A second later the block still holds");
  is(camera.dataset.state, "off", "…and the button shows it off");
  EventUtils.synthesizeMouseAtCenter(camera, {}, pip);
  await TestUtils.waitForCondition(() => !WhimsyCallPip.stateFor(browser).blocked.camera, "A second press releases it");

  const closed = BrowserTestUtils.domWindowClosed(pip);
  gBrowser.selectedTab = call;
  await closed;
  BrowserTestUtils.removeTab(other);
});

// W16-17: closing the call's tab mid-call closes its PiP. Last: it ends the
// file's one call.
add_task(async function test_pip_goes_with_its_tab() {
  const call = await openCall();
  const other = BrowserTestUtils.addTab(gBrowser, "about:blank");
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(null);
  gBrowser.selectedTab = other;
  const pip = await opened;
  await TestUtils.waitForCondition(() => pip._whimsyCallBrowser == call.linkedBrowser, "The call floats");
  const closed = BrowserTestUtils.domWindowClosed(pip);
  BrowserTestUtils.removeTab(call);
  await closed;
  ok(!pipWindow(), "Closing the call's tab closed its PiP");
  BrowserTestUtils.removeTab(other);
});
