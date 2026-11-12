/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W26: a floating call shows the other people, not you. Owner report: in a
// call with the camera off, the floating window showed "Camera off" and
// nobody else. whimsy_call.html stands in for the call: your fake camera
// (a large unmirrored preview and a small mirrored self-view) plus other
// participants received over a real RTCPeerConnection loopback, so their
// tiles play "remote video" tracks as a call app's do.

const { WhimsyCallPip } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCallPip.sys.mjs");

const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_call.html";
const TOGGLE_HAS_USED_PREF = "media.videocontrols.picture-in-picture.video-toggle.has-used";

function pipWindows() {
  return [...Services.wm.getEnumerator("Toolkit:PictureInPicture")];
}

// One call for the file: a second getUserMedia in one run never resolved
// under the fake devices (see browser_whimsy_call_pip.js).
let sharedCall = null;
async function openCall() {
  if (sharedCall) {
    await selectTab(sharedCall);
    return sharedCall;
  }
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.wrappedJSObject.startCall());
  await TestUtils.waitForCondition(() => WhimsyCallPip.isInCall(tab), "The tab is in a call");
  const labels = await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    content.wrappedJSObject.joinOthers(Cu.cloneInto(["Ada", "Ben"], content)));
  Assert.deepEqual([...labels], ["remote video", "remote video"], "Both participants play received WebRTC video");
  sharedCall = tab;
  registerCleanupFunction(async () => {
    await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.wrappedJSObject.endCall());
    await TestUtils.waitForCondition(() => !WhimsyCallPip.isInCall(tab), "The call ended");
    BrowserTestUtils.removeTab(tab);
  });
  return tab;
}

async function selectTab(tab) {
  if (gBrowser.selectedTab != tab) {
    await BrowserTestUtils.switchTab(gBrowser, tab);
  }
}

// Leaves the call for another tab: the call floats.
async function float(call) {
  const other = BrowserTestUtils.addTab(gBrowser, "about:blank");
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(null);
  gBrowser.selectedTab = other;
  const pip = await opened;
  await TestUtils.waitForCondition(() => pip._whimsyCallBrowser == call.linkedBrowser, "The call floats");
  return { pip, other };
}

// Back to the call: its floating window closes.
async function unfloat(call, { pip, other }) {
  const closed = pip.closed ? null : BrowserTestUtils.domWindowClosed(pip);
  await selectTab(call);
  await closed;
  BrowserTestUtils.removeTab(other);
}

async function floated(call) {
  return SpecialPowers.spawn(call.linkedBrowser, [], () =>
    [...content.document.querySelectorAll("video")].filter(video => video.isCloningElementVisually).map(video => video.id));
}

async function page(call, fn, ...args) {
  return SpecialPowers.spawn(call.linkedBrowser, [fn, args], (name, list) =>
    content.wrappedJSObject[name](...Cu.cloneInto(list, content)));
}

function cover(pip) {
  return pip.document.getElementById("whimsy-call-camera-off");
}

add_setup(async function () {
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
      ["media.navigator.permission.fake", true],
      ["media.audio_loopback_dev", ""],
      ["media.video_loopback_dev", ""],
      ["media.getusermedia.window.focus_source.enabled", false],
      ["media.autoplay.default", 0],
      ["media.autoplay.blocking_policy", 0],
      // The participants' loopback connections, as Firefox's own WebRTC
      // tests set them up: host candidates on the loopback interface.
      ["media.peerconnection.ice.loopback", true],
      ["media.peerconnection.ice.obfuscate_host_addresses", false],
    ],
  });
});

// Root cause 2: "unmirrored, then largest" floated your own unmirrored
// camera preview. Another participant always wins over it.
add_task(async function test_remote_beats_own_preview() {
  const call = await openCall();
  const floating = await float(call);
  try {
    await TestUtils.waitForCondition(async () => (await floated(call)).includes("remote-Ada"),
      "The active speaker (a remote participant) floats");
    const ids = await floated(call);
    ok(!ids.includes("speaker"), "Your large, unmirrored camera preview stays in the page");
    ok(!ids.includes("self"), "Your mirrored self-view stays in the page");
  } finally {
    await unfloat(call, floating);
  }
});

// The self-view test also looks at the video's ancestors: a processed
// preview (background blur, drawn through a canvas, so no camera device on
// its track), mirrored on its wrapper and bigger than anyone else's tile,
// still loses to a participant the page decodes itself.
add_task(async function test_parent_mirrored_preview_loses() {
  const call = await openCall();
  await page(call, "hideOthers", true);
  await page(call, "showProcessedSelf");
  await page(call, "showDecodedOther");
  const kinds = await SpecialPowers.spawn(call.linkedBrowser, [], () => {
    const actor = content.windowGlobalChild.getActor("WhimsyPage");
    const doc = content.document;
    return ["processed", "decoded", "speaker", "self", "remote-Ada"].map(id => actor.callVideoKind(doc.getElementById(id)));
  });
  Assert.deepEqual(kinds, ["local", "unknown", "local", "local", "remote"],
    "Mirrored on a parent is your own; a camera track is your own; a received track is someone else's");
  const floating = await float(call);
  try {
    await TestUtils.waitForCondition(async () => (await floated(call)).includes("decoded"),
      "The other participant floats, not your bigger mirrored preview");
  } finally {
    await unfloat(call, floating);
    await page(call, "leaveOthers");
    await page(call, "hideOthers", false);
    await page(call, "joinOthers", ["Ada", "Ben"]);
  }
});

// Following the active speaker swaps the video inside the same window,
// after the new speaker has held the big tile for a moment.
add_task(async function test_speaker_swap_keeps_window() {
  const call = await openCall();
  const floating = await float(call);
  const { pip } = floating;
  try {
    await TestUtils.waitForCondition(async () => (await floated(call)).includes("remote-Ada"), "Ada floats");
    let reopened = false;
    const onOpen = { observe: (subject, topic) => (reopened ||= topic == "domwindowopened") };
    Services.ww.registerNotification(onOpen);
    try {
      const start = Cu.now();
      await page(call, "setSpeaker", "Ben");
      await TestUtils.waitForCondition(async () => (await floated(call)).includes("remote-Ben"),
        "The floating window follows the new speaker");
      Assert.greaterOrEqual(Cu.now() - start, 1000, "It waits for the new speaker to hold the big tile");
      Assert.deepEqual(await floated(call), ["remote-Ben"], "Only the new speaker is cloned");
      ok(!pip.closed, "The same window stays open");
      Assert.deepEqual(pipWindows(), [pip], "No other window opened");
      ok(!reopened, "No window was closed and opened again");
      ok(!WhimsyCallPip._closedByHand.has(call.linkedBrowser), "A swap is not a deliberate close");
    } finally {
      Services.ww.unregisterNotification(onOpen);
    }
  } finally {
    await page(call, "setSpeaker", "Ada");
    await unfloat(call, floating);
  }
});

// The owner's bug (root cause 1): with your camera off, the "Camera off"
// cover hid whichever video floated. It now covers only your own preview.
add_task(async function test_camera_off_never_covers_others() {
  const call = await openCall();
  const browser = call.linkedBrowser;
  await page(call, "addCallBar");
  await TestUtils.waitForCondition(() => WhimsyCallPip.shownState(browser, "camera") == "on", "The call bar is read");
  let floating = await float(call);
  try {
    await TestUtils.waitForCondition(async () => (await floated(call)).includes("remote-Ada"), "Ada floats");
    await shoot(floating.pip, "call-pip-remote-camera-on");

    await page(call, "setDevice", "camera", false);
    await TestUtils.waitForCondition(() => WhimsyCallPip.shownState(browser, "camera") == "off", "Your camera is off");
    // Let a follow round that started before the change finish, then run
    // one that sees it.
    await TestUtils.waitForCondition(() => !floating.pip._whimsyFollowPending, "No follow round in flight");
    await WhimsyCallPip.followCall(floating.pip, browser);
    is(floating.pip._whimsyFloatingSelf, false, "The page reports someone else floating");
    ok(cover(floating.pip).hidden, "No cover over a remote participant while your camera is off");
    Assert.deepEqual(await floated(call), ["remote-Ada"], "Ada still floats");
    ok(!floating.pip.document.getElementById("whimsy-call-camera").hidden, "Your camera button stays");
    ok(!floating.pip.document.getElementById("whimsy-call-mic").hidden, "Your microphone button stays");
    await shoot(floating.pip, "call-pip-remote-camera-off");

    // Everyone else leaves: only your own preview is left to float, and
    // with your camera off it gets the cover.
    const closed = BrowserTestUtils.domWindowClosed(floating.pip);
    const reopened = BrowserTestUtils.domWindowOpenedAndLoaded(null);
    await page(call, "leaveOthers");
    await closed;
    floating = { ...floating, pip: await reopened };
    await TestUtils.waitForCondition(async () => (await floated(call)).includes("speaker"), "Your preview floats");
    await TestUtils.waitForCondition(() => cover(floating.pip)?.hidden === false, "Your own preview gets the cover");

    await page(call, "setDevice", "camera", true);
    await TestUtils.waitForCondition(() => cover(floating.pip).hidden, "Camera on: the cover goes");
  } finally {
    await unfloat(call, floating);
  }
});

// Light and dark shots of the floating window, controls showing.
async function shoot(pip, name) {
  for (const dark of [false, true]) {
    await whimsySetScheme(dark);
    try {
      pip.Player?.revealControls?.(true);
      await new Promise(resolve => pip.requestAnimationFrame(() => pip.requestAnimationFrame(resolve)));
      await whimsyShot(`${name}-${dark ? "dark" : "light"}`, pip.browsingContext.currentWindowGlobal);
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
}
