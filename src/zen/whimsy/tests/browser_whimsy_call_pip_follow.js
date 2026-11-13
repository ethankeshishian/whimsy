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
      const start = ChromeUtils.now();
      await page(call, "setSpeaker", "Ben");
      await TestUtils.waitForCondition(async () => (await floated(call)).includes("remote-Ben"),
        "The floating window follows the new speaker");
      Assert.greaterOrEqual(ChromeUtils.now() - start, 1000, "It waits for the new speaker to hold the big tile");
      Assert.deepEqual(await floated(call), ["remote-Ben"], "Only the new speaker is cloned");
      ok(!pip.closed, "The same window stays open");
      const windows = pipWindows();
      is(windows.length, 1, "One floating window");
      ok(windows[0] === pip, "It is the window that opened first");
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

// W26: Arc-style Leave Call. The PiP's red button presses the call page's
// own hang-up control and shows only while the page has one.

function leaveButton(pip) {
  return pip.document.getElementById("whimsy-call-leave");
}

// A follow round has answered since now (it reports the hang-up control).
async function followRound(pip, browser) {
  await TestUtils.waitForCondition(() => !pip._whimsyFollowPending, "No follow round in flight");
  await WhimsyCallPip.followCall(pip, browser);
}

async function pressInPip(pip, button) {
  EventUtils.synthesizeMouseAtCenter(pip.document.getElementById("controls"), { type: "mousemove" }, pip);
  EventUtils.synthesizeMouseAtCenter(button, {}, pip);
}

// The colour `css` resolves to, as [r, g, b] (0-255), through a canvas.
function resolveColor(pip, css) {
  const canvas = pip.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
}

function contrast(a, b) {
  const lum = rgb => {
    const [r, g, b2] = rgb.map(v => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// No hang-up control on the page: no Leave call button (never a dead one).
// It comes and goes with the page's control.
add_task(async function test_leave_hidden_without_hang_up() {
  const call = await openCall();
  const browser = call.linkedBrowser;
  await page(call, "addCallBar", false);
  const floating = await float(call);
  try {
    await TestUtils.waitForCondition(() => leaveButton(floating.pip), "The call buttons are in the window");
    await followRound(floating.pip, browser);
    is(floating.pip._whimsyCanLeave, false, "The page has no hang-up control");
    ok(leaveButton(floating.pip).hidden, "So the Leave call button is hidden");
    is(floating.pip.getComputedStyle(floating.pip.document.getElementById("playpause")).display, "none",
      "Play/pause stays hidden in a call window anyway");
    ok(!floating.pip.document.getElementById("whimsy-call-mic").hidden, "The microphone button shows");

    await page(call, "addCallBar", true);
    await TestUtils.waitForCondition(() => !leaveButton(floating.pip).hidden, "A hang-up control appears: so does Leave call");
    await page(call, "removeHangUp");
    await TestUtils.waitForCondition(() => leaveButton(floating.pip).hidden, "It goes: Leave call hides again");
    ok(!floating.pip.closed, "The window stays open");
  } finally {
    await unfloat(call, floating);
  }
});

// A call window has no ×: Firefox's × also pauses the floated video, a call
// tile in the page. Zen's "—" takes its corner and only closes the window:
// the call goes on.
add_task(async function test_close_is_hidden_and_minimize_keeps_the_call() {
  const call = await openCall();
  await page(call, "addCallBar", true);
  const floating = await float(call);
  try {
    const pip = floating.pip;
    await TestUtils.waitForCondition(() => leaveButton(pip) && !leaveButton(pip).hidden, "Leave call shows");
    const close = pip.document.getElementById("close");
    const minimize = pip.document.getElementById("minimize");
    is(pip.getComputedStyle(close).display, "none", "The call window hides ×");
    isnot(pip.getComputedStyle(minimize).display, "none", "The call window keeps —");
    const corner = minimize.getAttribute("mac") == "true" ? "left" : "right";
    is(pip.getComputedStyle(minimize)[corner], "10px", "— sits in ×'s corner");
    await shoot(pip, "call-pip-no-close");
    const closed = BrowserTestUtils.domWindowClosed(pip);
    await pressInPip(pip, minimize);
    await closed;
    ok(WhimsyCallPip.isInCall(call), "The call goes on");
    is(await SpecialPowers.spawn(call.linkedBrowser, [], () => content.wrappedJSObject.hungUp ?? 0), 0,
      "The page's hang-up control was not pressed");
  } finally {
    await unfloat(call, floating);
  }
});

// Leave call presses the page's hang-up control and closes the window.
// Last in the file: it ends the shared call.
add_task(async function test_leave_hangs_up_and_closes() {
  const call = await openCall();
  const browser = call.linkedBrowser;
  await page(call, "addCallBar", true);
  const found = await SpecialPowers.spawn(browser, [], () => {
    const { findLeave } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCallControls.sys.mjs");
    const doc = content.document;
    // Decoys: one that ends the call for everyone, one in someone else's
    // row, and a bare "Leave" outside the call bar.
    const decoys = document => {
      const box = document.createElement("div");
      box.id = "decoys";
      box.innerHTML = '<button aria-label="End call for everyone">x</button>' +
        '<div role="listitem"><button aria-label="Hang up">x</button></div><button>Leave</button>';
      document.body.prepend(box);
    };
    decoys(doc);
    const id = findLeave(doc)?.id ?? null;
    doc.getElementById("decoys").remove();
    return id;
  });
  is(found, "hang-up", "The finder picks the call bar's hang-up control, not the decoys");

  const floating = await float(call);
  const { pip } = floating;
  try {
    await TestUtils.waitForCondition(() => leaveButton(pip) && !leaveButton(pip).hidden, "Leave call shows");
    const button = leaveButton(pip);
    await TestUtils.waitForCondition(() => button.getAttribute("tooltip") == "Leave Call", "Its tooltip is filled");
    is(button.getAttribute("aria-label"), "Leave Call", "Its accessible name");
    const playpause = pip.document.getElementById("playpause");
    ok(button.parentElement == playpause.parentElement, "It sits with play/pause's controls");
    is(pip.getComputedStyle(playpause).display, "none", "Play/pause is gone from the call window");
    is(pip.getComputedStyle(button).gridArea.split(" / ")[0], "playpause", "Leave Call takes play/pause's spot");
    ok(button.classList.contains("control-button"), "Styled as the player's own buttons");
    const style = pip.getComputedStyle(button);
    const background = resolveColor(pip, style.backgroundColor);
    const icon = resolveColor(pip, style.fill);
    // The destructive pair's light-scheme values: solid red, white glyph.
    const probe = pip.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    probe.style.cssText = "color-scheme: light; background-color: var(--button-background-color-destructive); " +
      "color: var(--button-text-color-destructive)";
    pip.document.body.append(probe);
    const probeStyle = pip.getComputedStyle(probe);
    const token = resolveColor(pip, probeStyle.backgroundColor);
    const onToken = resolveColor(pip, probeStyle.color);
    probe.remove();
    Assert.deepEqual(background, token, "Filled with the design system's destructive colour (light scheme)");
    Assert.deepEqual(icon, onToken, "Its glyph is the pair's text colour");
    ok(icon.every(v => v >= 240), `The glyph is white (${icon})`);
    Assert.greaterOrEqual(contrast(background, icon), 4.5, "Its icon meets WCAG AA on the red");
    await shoot(pip, "call-pip-leave");

    const closed = BrowserTestUtils.domWindowClosed(pip);
    await pressInPip(pip, button);
    await closed;
    await TestUtils.waitForCondition(async () =>
      (await SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.hungUp ?? 0)) == 1,
    "The page's hang-up control was pressed once");
    await TestUtils.waitForCondition(() => !WhimsyCallPip.isInCall(call), "The call ended");
    is(pipWindows().length, 0, "No floating window is left");
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
