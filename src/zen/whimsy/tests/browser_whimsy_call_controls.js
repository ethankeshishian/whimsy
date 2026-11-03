/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W13-R3: a call's microphone and camera stay in sync three ways: the call
// page's own toggles (whimsy_meet.html mimics Google Meet: data-is-muted
// buttons that re-render a moment later, ⌘D/⌘E), the small player under the
// tab bar (Zen's sharing card) and the picture-in-picture window. Every
// toggle is a real click (or key) on the real control, and after every one
// the state is checked in all three places.
// Design: whimsy-handoff/wave13/r3-meetpip-design.md.

const { WhimsyCallPip } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCallPip.sys.mjs");
const { SitePermissions } = ChromeUtils.importESModule("resource:///modules/SitePermissions.sys.mjs");

const ORIGIN = "https://example.com";
const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", ORIGIN) + "whimsy_meet.html";
const KINDS = ["mic", "camera"];
const ON = { mic: "on", camera: "on" };

function pipWindow() {
  return Services.wm.getMostRecentWindow("Toolkit:PictureInPicture");
}

// BrowserTestUtils.switchTab waits for a switch, which never comes when
// the tab is already selected (e.g. after closing the tab beside it).
async function selectTab(tab) {
  if (gBrowser.selectedTab != tab) {
    await BrowserTestUtils.switchTab(gBrowser, tab);
  }
}

// One call for the file (a second camera getUserMedia in one run never
// resolved under the fake devices; see browser_whimsy_call_pip.js).
let sharedCall = null;
async function openCall() {
  if (sharedCall) {
    await selectTab(sharedCall);
    return sharedCall;
  }
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.wrappedJSObject.startCall());
  await TestUtils.waitForCondition(() => WhimsyCallPip.isInCall(tab), "The tab is in a call");
  await TestUtils.waitForCondition(() => cardFor(tab), "The call has its small player");
  sharedCall = tab;
  registerCleanupFunction(async () => {
    await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.wrappedJSObject.endCall());
    await TestUtils.waitForCondition(() => !WhimsyCallPip.isInCall(tab), "The call ended");
    BrowserTestUtils.removeTab(tab);
  });
  return tab;
}

// Leaves the call for another tab: the call floats.
async function float(call) {
  const other = BrowserTestUtils.addTab(gBrowser, "about:blank");
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(null);
  gBrowser.selectedTab = other;
  const pip = await opened;
  await TestUtils.waitForCondition(() => pip._whimsyCallBrowser == call.linkedBrowser, "The PiP window shows the call");
  return { pip, other };
}

async function unfloat(call, { pip, other }) {
  const closed = BrowserTestUtils.domWindowClosed(pip);
  gBrowser.selectedTab = call;
  await closed;
  BrowserTestUtils.removeTab(other);
}

function meetState(tab) {
  return SpecialPowers.spawn(tab.linkedBrowser, [], () => content.wrappedJSObject.meetState());
}

// The call's small player. (Before R3 the cards weren't tagged with their
// tab; then the card titled with the tab's label is the one.)
function cardFor(tab) {
  const cards = [...document.querySelectorAll("#zen-media-controls-toolbar .zen-media-card[media-sharing]")].filter(
    card => !card.hasAttribute("zen-removing")
  );
  return (
    cards.find(card => card._whimsyCallBrowser == tab.linkedBrowser) ??
    cards.find(card => !card._whimsyCallBrowser && card.querySelector(".zen-media-title")?.textContent == tab.label)
  );
}

function cardButton(tab, kind) {
  return cardFor(tab)?.querySelector(kind == "mic" ? ".zen-media-mute-mic-button" : ".zen-media-mute-camera-button");
}

// What the small player shows: "on", "off" or "hidden".
function cardState(tab, kind) {
  const card = cardFor(tab);
  if (!card) {
    return "no small player";
  }
  if (card.hasAttribute(`whimsy-call-hide-${kind}`)) {
    return "hidden";
  }
  return card.hasAttribute(kind == "mic" ? "mic-muted" : "camera-muted") ? "off" : "on";
}

// W21: the small player's corner badge for the non-default mute ("lock",
// "off" or null), read off the card's button.
function cardBadge(tab, kind) {
  return cardButton(tab, kind)?.getAttribute("whimsy-call-badge") || null;
}

// The PiP window's control for a device. (F32 put the microphone on
// Firefox's speaker button; reading that too lets the same checks run on
// the code before R3.)
function pipControl(pip, kind) {
  return pip.document.getElementById(`whimsy-call-${kind}`) ?? (kind == "mic" ? pip.document.getElementById("audio") : null);
}

function pipState(pip, kind) {
  const el = pipControl(pip, kind);
  if (!el) {
    return "missing";
  }
  if (el.hidden) {
    return "hidden";
  }
  if (el.id == "audio") {
    return pip.document.getElementById("controls").classList.contains("muted") ? "off" : "on";
  }
  return el.dataset.state;
}

// Waits until the page, the small player and (when floating) the PiP
// window all show `expected`, then states each one.
async function expectAll(call, pip, expected, what) {
  const agree = async () => {
    const page = await meetState(call);
    return KINDS.every(
      kind => page[kind] == expected[kind] && cardState(call, kind) == expected[kind] &&
        (!pip || pipState(pip, kind) == expected[kind])
    );
  };
  try {
    await TestUtils.waitForCondition(agree, `${what}: all agree`, 50, 100);
  } catch (e) {
    // Fall through: the checks below say which surface is wrong.
  }
  const page = await meetState(call);
  for (const kind of KINDS) {
    is(page[kind], expected[kind], `${what}: Meet's ${kind}`);
    is(cardState(call, kind), expected[kind], `${what}: the small player's ${kind}`);
    if (pip) {
      is(pipState(pip, kind), expected[kind], `${what}: the PiP window's ${kind}`);
    }
  }
  if (page.cameraTrackEnabled !== null && expected.camera != "hidden") {
    is(page.cameraTrackEnabled, expected.camera == "on", `${what}: the camera track follows Meet`);
  }
}

async function clickCard(call, kind) {
  const button = cardButton(call, kind);
  ok(button && button.getBoundingClientRect().width > 0, `The small player's ${kind} button is on screen`);
  // As a person does: point at it first. Hovering opens the card's header
  // (Zen's .show-on-hover, with its close button) over 0.3s, which pushes
  // the buttons down; a press without that hover moved the card between
  // mousedown and mouseup, so the release landed on the close button and
  // nothing was clicked. Click where the button is once the card has
  // settled, re-reading it each frame (a state change re-renders it too).
  EventUtils.synthesizeMouseAtCenter(button, { type: "mousemove" }, window);
  let last = "";
  await TestUtils.waitForCondition(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const now = cardButton(call, kind);
    const rect = JSON.stringify(now?.getBoundingClientRect());
    const still = rect == last;
    last = rect;
    if (!still && now) {
      EventUtils.synthesizeMouseAtCenter(now, { type: "mousemove" }, window);
    }
    return still;
  }, `The small player's ${kind} button has stopped moving`);
  EventUtils.synthesizeMouseAtCenter(cardButton(call, kind), {}, window);
}

// Option-click: does the "other" mute instead of the default.
async function clickCardAlt(call, kind) {
  const button = cardButton(call, kind);
  ok(button && button.getBoundingClientRect().width > 0, `The small player's ${kind} button is on screen`);
  EventUtils.synthesizeMouseAtCenter(button, { type: "mousemove" }, window);
  let last = "";
  await TestUtils.waitForCondition(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const now = cardButton(call, kind);
    const rect = JSON.stringify(now?.getBoundingClientRect());
    const still = rect == last;
    last = rect;
    if (!still && now) {
      EventUtils.synthesizeMouseAtCenter(now, { type: "mousemove" }, window);
    }
    return still;
  }, `The small player's ${kind} button has stopped moving`);
  EventUtils.synthesizeMouseAtCenter(cardButton(call, kind), { altKey: true }, window);
}

async function clickPip(pip, kind) {
  const button = pipControl(pip, kind);
  ok(button, `The PiP window has a ${kind} button`);
  if (!button) {
    return;
  }
  // Show the player's controls, as hovering does.
  EventUtils.synthesizeMouseAtCenter(pip.document.getElementById("controls"), { type: "mousemove" }, pip);
  EventUtils.synthesizeMouseAtCenter(button, {}, pip);
}

// Option-click in the PiP window: does the "other" mute.
async function clickPipAlt(pip, kind) {
  const button = pipControl(pip, kind);
  ok(button, `The PiP window has a ${kind} button`);
  if (!button) {
    return;
  }
  EventUtils.synthesizeMouseAtCenter(pip.document.getElementById("controls"), { type: "mousemove" }, pip);
  EventUtils.synthesizeMouseAtCenter(button, { altKey: true }, pip);
}

// W21: the PiP button's corner badge for the non-default mute.
function pipBadge(pip, kind) {
  return pipControl(pip, kind)?.dataset.badge ?? null;
}

// Every state the PiP's microphone control shows while `action` runs.
async function recordPip(pip, kind, action, until) {
  // Starts from the state shown before the action: what counts is that it
  // goes to the new state once and never back.
  const seen = [pipState(pip, kind)];
  const note = () => {
    const state = pipState(pip, kind);
    if (seen.at(-1) != state) {
      seen.push(state);
    }
  };
  const observer = new pip.MutationObserver(note);
  observer.observe(pip.document.body, { subtree: true, attributes: true, attributeFilter: ["data-state", "class", "hidden"] });
  try {
    await action();
    await until();
    // Let a late flip-back show up.
    // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
    await new Promise(resolve => setTimeout(resolve, 400));
  } finally {
    observer.disconnect();
  }
  return seen;
}

add_setup(async function () {
  const principal = Services.scriptSecurityManager.createContentPrincipalFromOrigin(ORIGIN);
  for (const id of ["camera", "microphone"]) {
    SitePermissions.setForPrincipal(principal, id, SitePermissions.ALLOW);
  }
  const hasUsedPref = "media.videocontrols.picture-in-picture.video-toggle.has-used";
  const hadHasUsed = Services.prefs.prefHasUserValue(hasUsedPref);
  const hasUsedBefore = Services.prefs.getBoolPref(hasUsedPref, false);
  registerCleanupFunction(() => {
    if (hadHasUsed) {
      Services.prefs.setBoolPref(hasUsedPref, hasUsedBefore);
    } else {
      Services.prefs.clearUserPref(hasUsedPref);
    }
    Services.prefs.clearUserPref("whimsy.call.buttons-default");
    for (const id of ["camera", "microphone"]) {
      SitePermissions.removeFromPrincipal(principal, id);
    }
  });
  await SpecialPowers.pushPrefEnv({
    set: [
      // As browser_whimsy_call_pip.js: fake devices behind a real, granted
      // permission, so the tab reports sharing and gets its small player.
      ["media.navigator.streams.fake", true],
      ["media.navigator.permission.fake", true],
      ["media.audio_loopback_dev", ""],
      ["media.video_loopback_dev", ""],
      ["media.getusermedia.window.focus_source.enabled", false],
      ["media.autoplay.default", 0],
      ["media.autoplay.blocking_policy", 0],
      ["whimsy.callControls.log", true],
    ],
  });
});

add_task(async function test_small_player_toggles_meet() {
  const call = await openCall();
  await expectAll(call, null, ON, "Joined");
  await clickCard(call, "mic");
  await expectAll(call, null, { mic: "off", camera: "on" }, "Small player: microphone off");
  await clickCard(call, "camera");
  await expectAll(call, null, { mic: "off", camera: "off" }, "Small player: camera off");
  await clickCard(call, "mic");
  await expectAll(call, null, { mic: "on", camera: "off" }, "Small player: microphone on");
  await clickCard(call, "camera");
  await expectAll(call, null, ON, "Small player: camera on");
});

add_task(async function test_pip_toggles_meet_without_a_glitch() {
  const call = await openCall();
  const floating = await float(call);
  const { pip } = floating;
  try {
    await expectAll(call, pip, ON, "Floating");
    ok(pip.document.getElementById("audio").hidden || pip.getComputedStyle(pip.document.getElementById("audio")).display == "none",
      "The speaker button (the call tile's muted video) isn't offered in a call");

    // The PiP's microphone never shows a state Meet doesn't have.
    const seen = await recordPip(pip, "mic", () => clickPip(pip, "mic"),
      () => TestUtils.waitForCondition(async () => (await meetState(call)).mic == "off", "Meet muted", 50, 100).catch(() => {}));
    Assert.deepEqual(seen, ["on", "off"], "The PiP's microphone went straight from on to off, with no flip back");
    await expectAll(call, pip, { mic: "off", camera: "on" }, "PiP: microphone off");

    await clickPip(pip, "camera");
    await expectAll(call, pip, { mic: "off", camera: "off" }, "PiP: camera off");
    // The small player, while floating, moves the PiP too.
    await clickCard(call, "mic");
    await expectAll(call, pip, { mic: "on", camera: "off" }, "Small player while floating: microphone on");
    await clickPip(pip, "camera");
    await expectAll(call, pip, ON, "PiP: camera on");

    // Meet's own keys in the PiP window, and M as before.
    pip.focus();
    EventUtils.synthesizeKey("d", { accelKey: true }, pip);
    await expectAll(call, pip, { mic: "off", camera: "on" }, "PiP ⌘D");
    EventUtils.synthesizeKey("e", { accelKey: true }, pip);
    await expectAll(call, pip, { mic: "off", camera: "off" }, "PiP ⌘E");
    EventUtils.synthesizeKey("m", {}, pip);
    await expectAll(call, pip, { mic: "on", camera: "off" }, "PiP M");
    EventUtils.synthesizeKey("e", { accelKey: true }, pip);
    await expectAll(call, pip, ON, "PiP ⌘E again");
  } finally {
    await unfloat(call, floating);
  }
});

add_task(async function test_changes_on_the_page_reach_both() {
  const call = await openCall();
  const floating = await float(call);
  const { pip } = floating;
  try {
    await expectAll(call, pip, ON, "Floating");
    // A click on Meet's own button.
    await SpecialPowers.spawn(call.linkedBrowser, [], () => {
      content.document.querySelector('[data-is-muted][aria-label*="microphone"]').click();
    });
    await expectAll(call, pip, { mic: "off", camera: "on" }, "Meet's button: microphone off");
    // Meet's own shortcuts, on the page.
    const accel = AppConstants.platform == "macosx" ? "metaKey" : "ctrlKey";
    for (const [key, expected, what] of [
      ["e", { mic: "off", camera: "off" }, "Meet's ⌘E: camera off"],
      ["d", { mic: "on", camera: "off" }, "Meet's ⌘D: microphone on"],
      ["e", ON, "Meet's ⌘E: camera on"],
    ]) {
      await SpecialPowers.spawn(call.linkedBrowser, [key, accel], (k, mod) => {
        content.document.dispatchEvent(new content.KeyboardEvent("keydown", { key: k, [mod]: true, bubbles: true }));
      });
      await expectAll(call, pip, expected, what);
    }
  } finally {
    await unfloat(call, floating);
  }
});

// W21: with no recognisable in-call controls, the small player's buttons
// never hide or no-op — they fall back to the device mute (Review Focus:
// "the no in-call controls found fallback").
add_task(async function test_unknown_state_falls_back_to_device_mute() {
  const call = await openCall();
  const floating = await float(call);
  const { pip } = floating;
  try {
    await expectAll(call, pip, ON, "Floating");
    await SpecialPowers.spawn(call.linkedBrowser, [], () => content.wrappedJSObject.removeControls());
    await TestUtils.waitForCondition(
      () => cardState(call, "mic") != "hidden" && cardState(call, "mic") != "off",
      "Meet's toggles are gone: the small player's microphone stays, showing the device mute"
    );
    ok(!WhimsyCallPip.commandTarget(window, "mic"), "Toggle Meeting Microphone has nothing to toggle");
    await clickCard(call, "mic");
    await TestUtils.waitForCondition(
      () => WhimsyCallPip.stateFor(call.linkedBrowser).blocked.mic,
      "the click fell back to blocking the device"
    );
    is(cardState(call, "mic"), "off", "the small player shows it muted");
    await clickCard(call, "mic");
    await TestUtils.waitForCondition(
      () => !WhimsyCallPip.stateFor(call.linkedBrowser).blocked.mic,
      "a second click releases it"
    );
    await SpecialPowers.spawn(call.linkedBrowser, [], () => content.wrappedJSObject.restoreControls());
    await expectAll(call, pip, ON, "Meet's toggles are back");
  } finally {
    await unfloat(call, floating);
  }
});

add_task(async function test_blocked_device_hides_its_button() {
  const call = await openCall();
  const floating = await float(call);
  const { pip } = floating;
  const principal = Services.scriptSecurityManager.createContentPrincipalFromOrigin(ORIGIN);
  try {
    await expectAll(call, pip, ON, "Floating");
    SitePermissions.setForPrincipal(principal, "microphone", SitePermissions.BLOCK);
    await TestUtils.waitForCondition(
      () => cardState(call, "mic") == "hidden" && pipState(pip, "mic") == "hidden",
      "The microphone is blocked for the site: its button hides in both"
    );
    is(cardState(call, "camera"), "on", "The camera's button stays in the small player");
    is(pipState(pip, "camera"), "on", "...and in the PiP window");
    SitePermissions.setForPrincipal(principal, "microphone", SitePermissions.ALLOW);
    await expectAll(call, pip, ON, "Allowed again");
  } finally {
    SitePermissions.setForPrincipal(principal, "microphone", SitePermissions.ALLOW);
    await unfloat(call, floating);
  }
});

add_task(async function test_commands_toggle_the_floating_call() {
  const call = await openCall();
  const floating = await float(call);
  const { pip } = floating;
  try {
    const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
    for (const id of ["cmd_whimsyCallMicrophone", "cmd_whimsyCallCamera"]) {
      ok(document.getElementById(id), `${id} exists`);
      ok(document.getElementById(`key_${id}`), `${id} has a key that can be assigned`);
      ok(WhimsyCommands.title({ l10nId: id == "cmd_whimsyCallMicrophone" ? "whimsy-action-call-microphone" : "whimsy-action-call-camera" }),
        `${id} has a name`);
    }
    is(WhimsyCallPip.commandTarget(window, "mic"), call.linkedBrowser, "From another tab, the commands target the floating call");
    document.getElementById("cmd_whimsyCallMicrophone").doCommand();
    await expectAll(call, pip, { mic: "off", camera: "on" }, "Toggle Meeting Microphone");
    document.getElementById("cmd_whimsyCallCamera").doCommand();
    await expectAll(call, pip, { mic: "off", camera: "off" }, "Toggle Meeting Camera");
    document.getElementById("cmd_whimsyCallMicrophone").doCommand();
    document.getElementById("cmd_whimsyCallCamera").doCommand();
    await expectAll(call, pip, ON, "Both commands again");
  } finally {
    await unfloat(call, floating);
  }
});

add_task(async function test_two_calls_keep_their_own_state() {
  const call = await openCall();
  const second = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  try {
    // The second call shares nothing real (a second fake camera never
    // resolves in one run): its small player is shown as Zen's own test
    // does, for a tab with a peer connection.
    await SpecialPowers.spawn(second.linkedBrowser, [], () => content.wrappedJSObject.startCall({ camera: false }));
    gZenMediaController.updateMediaSharing({
      windowId: second.linkedBrowser.innerWindowID,
      showCameraIndicator: true,
      showMicrophoneIndicator: false,
    });
    await TestUtils.waitForCondition(() => cardState(second, "mic") == "on", "The second call's small player follows its page");
    await clickCard(second, "mic");
    await TestUtils.waitForCondition(async () => (await meetState(second)).mic == "off" && cardState(second, "mic") == "off",
      "The second call's microphone is off");
    await expectAll(call, null, ON, "The first call is untouched");
    await clickCard(second, "mic");
    await TestUtils.waitForCondition(async () => (await meetState(second)).mic == "on" && cardState(second, "mic") == "on",
      "The second call's microphone is on again");
    ok(!WhimsyCallPip.commandTarget(window, "mic") || WhimsyCallPip.commandTarget(window, "mic") == second.linkedBrowser,
      "With two calls, the commands only ever target the selected one");
  } finally {
    gZenMediaController.updateMediaSharing({
      windowId: second.linkedBrowser.innerWindowID,
      showCameraIndicator: false,
      showMicrophoneIndicator: false,
    });
    await SpecialPowers.spawn(second.linkedBrowser, [], () => content.wrappedJSObject.endCall());
    BrowserTestUtils.removeTab(second);
    await selectTab(call);
  }
});

// A page that acts only on a real (trusted) click still toggles, from the
// PiP window and the small player while the call's tab is in the background.
add_task(async function test_trusted_clicks_reach_a_background_call() {
  const call = await openCall();
  const floating = await float(call);
  const { pip } = floating;
  await SpecialPowers.spawn(call.linkedBrowser, [], () => {
    content.wrappedJSObject.requireTrusted = true;
  });
  try {
    await expectAll(call, pip, ON, "Floating");
    await clickPip(pip, "mic");
    await expectAll(call, pip, { mic: "off", camera: "on" }, "Trusted only: PiP microphone off");
    await clickCard(call, "camera");
    await expectAll(call, pip, { mic: "off", camera: "off" }, "Trusted only: small player camera off");
    await clickPip(pip, "mic");
    await clickPip(pip, "camera");
    await expectAll(call, pip, ON, "Trusted only: both on");
  } finally {
    await SpecialPowers.spawn(call.linkedBrowser, [], () => {
      content.wrappedJSObject.requireTrusted = false;
    });
    await unfloat(call, floating);
  }
});

// B14: the page also shows other people's microphones and cameras (the
// People panel, host controls, a request to unmute), each with
// data-is-muted and a device name. Only your own call-bar toggles are the
// call's state, and only they are ever pressed: dev.1100 pressed a
// participant's control ("asks people to unmute").
add_task(async function test_never_someone_elses_controls() {
  const call = await openCall();
  const found = await SpecialPowers.spawn(call.linkedBrowser, [], () => {
    const { findControls } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCallControls.sys.mjs");
    const controls = findControls(content.document);
    return {
      mic: controls.mic?.closest("#bar") ? "bar" : controls.mic?.getAttribute("aria-label") ?? null,
      camera: controls.camera?.closest("#bar") ? "bar" : controls.camera?.getAttribute("aria-label") ?? null,
    };
  });
  Assert.deepEqual(found, { mic: "bar", camera: "bar" }, "Your own toggles are the ones in the call bar");
  await expectAll(call, null, ON, "With other people's controls on the page");
  await clickCard(call, "mic");
  await expectAll(call, null, { mic: "off", camera: "on" }, "The small player turns your microphone off");
  await clickCard(call, "mic");
  await expectAll(call, null, ON, "and on again");
  is((await meetState(call)).decoyPresses, 0, "Nobody else's control was pressed");
});

add_task(async function test_switched_off() {
  const call = await openCall();
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.call-controls", false]] });
  const floating = await float(call);
  const { pip } = floating;
  try {
    ok(!pip.document.getElementById("whimsy-call-mic"), "Switched off: no call buttons in the PiP window");
    ok(!WhimsyCallPip.commandTarget(window, "mic"), "...and nothing for the commands");
  } finally {
    await unfloat(call, floating);
    await SpecialPowers.popPrefEnv();
  }
  // Back on: the small player follows the page again.
  await expectAll(call, null, ON, "Switched on again");
});

// W21: the call-bar finder is general to any call page, not just Meet.
// Zoom's web client and Webex use data-is-muted like Meet; Teams uses
// aria-pressed only, proving the widened candidate selector.
add_task(async function test_finder_works_on_zoom_teams_webex() {
  for (const fixture of ["whimsy_zoom.html", "whimsy_teams.html", "whimsy_webex.html"]) {
    const page = getRootDirectory(gTestPath).replace("chrome://mochitests/content", ORIGIN) + fixture;
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, page);
    try {
      await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.wrappedJSObject.startCall({ camera: false }));
      const found = await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
        const { findControls, readState } = ChromeUtils.importESModule(
          "resource:///modules/whimsy/WhimsyCallControls.sys.mjs"
        );
        const controls = findControls(content.document);
        return {
          mic: controls.mic?.closest("#bar") ? "bar" : (controls.mic?.getAttribute("aria-label") ?? null),
          camera: controls.camera?.closest("#bar") ? "bar" : null,
          state: readState(content.document),
        };
      });
      is(found.mic, "bar", `${fixture}: the mic toggle resolves to the call bar, not a decoy`);
      is(found.state.mic, "on", `${fixture}: readState reports the mic's polarity`);
      await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
        content.document.querySelector("#bar button")?.click();
      });
      await TestUtils.waitForCondition(
        async () => (await meetState(tab)).mic == "off",
        `${fixture}: the mic toggled`
      );
      is((await meetState(tab)).decoyPresses, 0, `${fixture}: no decoy was pressed`);
    } finally {
      await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.wrappedJSObject.endCall());
      BrowserTestUtils.removeTab(tab);
    }
  }
});

// W21: whimsy.call.buttons-default picks which mute a plain click does;
// toggleOther always does the other one, regardless of the pref.
add_task(async function test_default_pref_picks_which_click_does() {
  const call = await openCall();
  await expectAll(call, null, ON, "Joined");
  await WhimsyCallPip.toggleDefault(call.linkedBrowser, "mic");
  is((await meetState(call)).mic, "off", "default=call toggles the page");
  is(WhimsyCallPip.stateFor(call.linkedBrowser).blocked.mic, false, "device mute untouched");
  await WhimsyCallPip.toggleDefault(call.linkedBrowser, "mic");
  await expectAll(call, null, ON, "Back on");
});

add_task(async function test_default_device_inverts_both_clicks() {
  const call = await openCall();
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.call.buttons-default", "device"]] });
  try {
    await WhimsyCallPip.toggleDefault(call.linkedBrowser, "mic");
    is(WhimsyCallPip.stateFor(call.linkedBrowser).blocked.mic, true, "default=device blocks the device");
    is((await meetState(call)).mic, "on", "page toggle untouched");
  } finally {
    await WhimsyCallPip.toggleDefault(call.linkedBrowser, "mic");
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_alt_click_does_the_other_mute() {
  const call = await openCall();
  await WhimsyCallPip.toggleOther(call.linkedBrowser, "camera");
  is(WhimsyCallPip.stateFor(call.linkedBrowser).blocked.camera, true, "the other mute blocks the device");
  is((await meetState(call)).camera, "on", "page toggle untouched by the other mute");
  await WhimsyCallPip.toggleOther(call.linkedBrowser, "camera");
  is(WhimsyCallPip.stateFor(call.linkedBrowser).blocked.camera, false, "a second press releases it");
});

add_task(async function test_device_mute_released_when_call_ends() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.wrappedJSObject.startCall());
  await TestUtils.waitForCondition(() => WhimsyCallPip.isInCall(tab), "The tab is in a call");
  await WhimsyCallPip.toggleBlocked(tab.linkedBrowser, "mic");
  is(WhimsyCallPip.stateFor(tab.linkedBrowser).blocked.mic, true, "blocked while in the call");
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.wrappedJSObject.endCall());
  await TestUtils.waitForCondition(() => !WhimsyCallPip.isInCall(tab), "The call ended");
  await TestUtils.waitForCondition(
    () => !WhimsyCallPip._calls.has(tab.linkedBrowser),
    "the call ending forgot the browser (and, with it, released the device mute)"
  );
  is(WhimsyCallPip.stateFor(tab.linkedBrowser).blocked.mic, false, "a fresh state has no device mute left on");
  BrowserTestUtils.removeTab(tab);
});

// W21: the small player's mic/camera buttons do the default mute on a plain
// click, the other mute on Option-click, and show a corner badge for
// whichever mute is on but isn't the default (so it's never lost from view).
add_task(async function test_card_click_does_default_alt_click_does_other() {
  const call = await openCall();
  await expectAll(call, null, ON, "Joined");
  await clickCard(call, "mic");
  await expectAll(call, null, { mic: "off", camera: "on" }, "A plain click does the default (call) mute");
  is(WhimsyCallPip.stateFor(call.linkedBrowser).blocked.mic, false, "the device mute is untouched");
  await clickCard(call, "mic");
  await expectAll(call, null, ON, "Back on");

  await clickCardAlt(call, "camera");
  await TestUtils.waitForCondition(
    () => WhimsyCallPip.stateFor(call.linkedBrowser).blocked.camera,
    "Option-click does the device block"
  );
  is((await meetState(call)).camera, "on", "the page's own toggle is untouched by the other mute");
  await clickCardAlt(call, "camera");
  await TestUtils.waitForCondition(
    () => !WhimsyCallPip.stateFor(call.linkedBrowser).blocked.camera,
    "a second Option-click releases it"
  );
});

add_task(async function test_card_shows_badge_for_the_non_default_mute() {
  const call = await openCall();
  await expectAll(call, null, ON, "Joined");
  await WhimsyCallPip.toggleBlocked(call.linkedBrowser, "mic");
  is(cardBadge(call, "mic"), "lock", "the device mute is on but not the default: a lock badge, not a second glyph");
  is(cardState(call, "mic"), "on", "the main glyph still shows the default (call) mute, which is off");
  await WhimsyCallPip.toggleBlocked(call.linkedBrowser, "mic");
  is(cardBadge(call, "mic"), null, "badge clears once the device mute is off again");
});

add_task(async function test_card_no_in_call_controls_falls_back_to_device() {
  const call = await openCall();
  await expectAll(call, null, ON, "Joined");
  await SpecialPowers.spawn(call.linkedBrowser, [], () => {
    content.document.querySelector("#bar button[aria-label*=microphone]")?.remove();
  });
  await TestUtils.waitForCondition(
    () => WhimsyCallPip.displayState(call.linkedBrowser, "mic").inCallAvailable === false,
    "The mic's in-call control is gone"
  );
  await clickCard(call, "mic");
  await TestUtils.waitForCondition(
    () => WhimsyCallPip.stateFor(call.linkedBrowser).blocked.mic,
    "falls back to the device mute, not a no-op"
  );
  await WhimsyCallPip.toggleBlocked(call.linkedBrowser, "mic");
  await SpecialPowers.spawn(call.linkedBrowser, [], () => content.wrappedJSObject.restoreControls());
  await expectAll(call, null, ON, "Meet's toggles are back");
});

// W21: the PiP window's mic/camera buttons do the default mute on a plain
// click, the other mute on Option-click (mouse) or Shift+key (keyboard),
// and show a corner badge for whichever mute is on but isn't the default.
add_task(async function test_pip_click_does_default_alt_click_does_other() {
  const call = await openCall();
  const floating = await float(call);
  const { pip } = floating;
  try {
    await expectAll(call, pip, ON, "Floating");
    await clickPip(pip, "mic");
    await expectAll(call, pip, { mic: "off", camera: "on" }, "A plain click does the default (call) mute");
    is(WhimsyCallPip.stateFor(call.linkedBrowser).blocked.mic, false, "the device mute is untouched");
    await clickPip(pip, "mic");
    await expectAll(call, pip, ON, "Back on");

    await clickPipAlt(pip, "camera");
    await TestUtils.waitForCondition(
      () => WhimsyCallPip.stateFor(call.linkedBrowser).blocked.camera,
      "Option-click does the device block"
    );
    is((await meetState(call)).camera, "on", "the page's own toggle is untouched by the other mute");
    await clickPipAlt(pip, "camera");
    await TestUtils.waitForCondition(
      () => !WhimsyCallPip.stateFor(call.linkedBrowser).blocked.camera,
      "a second Option-click releases it"
    );
  } finally {
    await unfloat(call, floating);
  }
});

// Review Focus: the PiP's rendered label must always match the glyph it
// draws, for every combination of the call's own state and the device
// block — the ticket's "label said unmute while unmuted" regression.
add_task(async function test_pip_label_always_matches_the_rendered_state() {
  const call = await openCall();
  const floating = await float(call);
  const { pip } = floating;
  try {
    await expectAll(call, pip, ON, "Floating");
    const browser = call.linkedBrowser;
    for (const callState of ["on", "off"]) {
      for (const blocked of [false, true]) {
        WhimsyCallPip.stateFor(browser).mic = callState;
        WhimsyCallPip.stateFor(browser).blocked.mic = blocked;
        WhimsyCallPip.renderPip(pip, browser);
        const d = WhimsyCallPip.displayState(browser, "mic");
        const button = pipControl(pip, "mic");
        is(button.dataset.state, d.off ? "off" : "on", `glyph state for call=${callState} blocked=${blocked}`);
        const id = button.getAttribute("data-l10n-id");
        const expectsOffLabel = d.off;
        const idSaysOff = id.includes("turn-on") || id.includes("unblock");
        const idSaysOn = id.includes("turn-off") || id.includes("block") && !id.includes("unblock");
        ok(
          (expectsOffLabel && idSaysOff) || (!expectsOffLabel && idSaysOn),
          `label "${id}" matches off=${d.off} for call=${callState} blocked=${blocked}`
        );
      }
    }
    // Restore real state so the call can clean up normally.
    WhimsyCallPip.stateFor(browser).blocked.mic = false;
    await SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.meetState());
    await WhimsyCallPip.watch(browser);
    await expectAll(call, pip, ON, "Restored");
  } finally {
    await unfloat(call, floating);
  }
});

add_task(async function test_pip_shows_badge_for_non_default() {
  const call = await openCall();
  const floating = await float(call);
  const { pip } = floating;
  try {
    await expectAll(call, pip, ON, "Floating");
    await WhimsyCallPip.toggleBlocked(call.linkedBrowser, "mic");
    is(pipBadge(pip, "mic"), "lock", "device mute on, in-call default off -> lock badge");
    is(pipState(pip, "mic"), "on", "the main glyph still shows the default (call) mute, which is off");
    await WhimsyCallPip.toggleBlocked(call.linkedBrowser, "mic");
    is(pipBadge(pip, "mic"), null, "badge clears once the device mute is off again");
  } finally {
    await unfloat(call, floating);
  }
});

// Review Focus: Shift+key in the PiP window does the other mute, while bare
// Option still does nothing (⌥⌘D is macOS's Show/Hide Dock).
add_task(async function test_pip_shift_key_does_the_other_mute() {
  const call = await openCall();
  const floating = await float(call);
  const { pip } = floating;
  try {
    await expectAll(call, pip, ON, "Floating");
    const accel = AppConstants.platform == "macosx" ? { metaKey: true } : { ctrlKey: true };
    EventUtils.synthesizeKey("d", { ...accel, shiftKey: true }, pip);
    await TestUtils.waitForCondition(
      () => WhimsyCallPip.stateFor(call.linkedBrowser).blocked.mic,
      "Shift+accel+D does the other (device) mute"
    );
    is((await meetState(call)).mic, "on", "the page's own toggle is untouched");
    EventUtils.synthesizeKey("d", { ...accel, shiftKey: true }, pip);
    await TestUtils.waitForCondition(
      () => !WhimsyCallPip.stateFor(call.linkedBrowser).blocked.mic,
      "a second Shift+accel+D releases it"
    );
  } finally {
    await unfloat(call, floating);
  }
});

// W21 Task 7: the four individual-mute commands, plus the command that
// flips the buttons-default pref. All five are independently assignable.
add_task(async function test_four_new_commands_exist_and_run() {
  const call = await openCall();
  await selectTab(call);
  const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
  for (const [id, l10nId] of [
    ["cmd_whimsyCallMicrophoneInCall", "whimsy-action-call-microphone-in-call"],
    ["cmd_whimsyCallCameraInCall", "whimsy-action-call-camera-in-call"],
    ["cmd_whimsyCallMicrophoneBlock", "whimsy-action-call-microphone-block"],
    ["cmd_whimsyCallCameraBlock", "whimsy-action-call-camera-block"],
  ]) {
    ok(document.getElementById(id), `${id} exists`);
    ok(document.getElementById(`key_${id}`), `${id} has a key that can be assigned`);
    ok(WhimsyCommands.title({ l10nId }), `${id} has a name`);
  }
  document.getElementById("cmd_whimsyCallMicrophoneInCall").doCommand();
  await TestUtils.waitForCondition(async () => (await meetState(call)).mic == "off", "the in-call command mutes the page's own control");
  is(WhimsyCallPip.stateFor(call.linkedBrowser).blocked.mic, false, "...and leaves the device mute alone");
  document.getElementById("cmd_whimsyCallMicrophoneInCall").doCommand();
  await expectAll(call, pipWindow(), ON, "mic back on");

  document.getElementById("cmd_whimsyCallMicrophoneBlock").doCommand();
  is(WhimsyCallPip.stateFor(call.linkedBrowser).blocked.mic, true, "the block command blocks the device");
  is((await meetState(call)).mic, "on", "...and leaves the page's own control alone");
  document.getElementById("cmd_whimsyCallMicrophoneBlock").doCommand();
  is(WhimsyCallPip.stateFor(call.linkedBrowser).blocked.mic, false, "a second press releases it");

  document.getElementById("cmd_whimsyCallCameraInCall").doCommand();
  await TestUtils.waitForCondition(async () => (await meetState(call)).camera == "off", "the in-call camera command mutes the page's own control");
  document.getElementById("cmd_whimsyCallCameraInCall").doCommand();
  await expectAll(call, pipWindow(), ON, "camera back on");

  document.getElementById("cmd_whimsyCallCameraBlock").doCommand();
  is(WhimsyCallPip.stateFor(call.linkedBrowser).blocked.camera, true, "the block command blocks the camera device");
  document.getElementById("cmd_whimsyCallCameraBlock").doCommand();
  is(WhimsyCallPip.stateFor(call.linkedBrowser).blocked.camera, false, "a second press releases it");
});

add_task(async function test_buttons_default_command_toggles_the_pref() {
  const before = Services.prefs.getStringPref("whimsy.call.buttons-default", "call");
  const hadUserValue = Services.prefs.prefHasUserValue("whimsy.call.buttons-default");
  const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
  const id = "cmd_whimsyCallButtonsDefault";
  ok(document.getElementById(id), `${id} exists`);
  ok(document.getElementById(`key_${id}`), `${id} has a key that can be assigned`);
  ok(WhimsyCommands.title({ l10nId: "whimsy-action-call-buttons-default" }), `${id} has a name`);
  try {
    document.getElementById(id).doCommand();
    isnot(Services.prefs.getStringPref("whimsy.call.buttons-default"), before, "the pref flipped");
    document.getElementById(id).doCommand();
    is(Services.prefs.getStringPref("whimsy.call.buttons-default"), before, "a second press flips it back");
  } finally {
    if (hadUserValue) {
      Services.prefs.setStringPref("whimsy.call.buttons-default", before);
    } else {
      Services.prefs.clearUserPref("whimsy.call.buttons-default");
    }
  }
});

add_task(async function test_existing_toggle_commands_follow_the_default() {
  // cmd_whimsyCallMicrophone / cmd_whimsyCallCamera keep their ids but must
  // now call toggleDefault, not the old toggle()/toggleInCall() directly.
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.call.buttons-default", "device"]] });
  const call = await openCall();
  await selectTab(call);
  try {
    document.getElementById("cmd_whimsyCallMicrophone").doCommand();
    is(WhimsyCallPip.stateFor(call.linkedBrowser).blocked.mic, true, "now follows the device default");
    is((await meetState(call)).mic, "on", "the page's own control is untouched");
    document.getElementById("cmd_whimsyCallMicrophone").doCommand();
    is(WhimsyCallPip.stateFor(call.linkedBrowser).blocked.mic, false, "a second press releases it");
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});
