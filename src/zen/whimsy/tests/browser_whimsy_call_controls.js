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
  EventUtils.synthesizeMouseAtCenter(button, {}, window);
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
  registerCleanupFunction(() => {
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

add_task(async function test_unknown_state_hides_the_buttons() {
  const call = await openCall();
  const floating = await float(call);
  const { pip } = floating;
  try {
    await expectAll(call, pip, ON, "Floating");
    await SpecialPowers.spawn(call.linkedBrowser, [], () => content.wrappedJSObject.removeControls());
    await TestUtils.waitForCondition(
      () => KINDS.every(kind => cardState(call, kind) == "hidden" && pipState(pip, kind) == "hidden"),
      "Meet's toggles are gone: both buttons hide in the small player and the PiP window"
    );
    ok(!WhimsyCallPip.commandTarget(window, "mic"), "Toggle Meeting Microphone has nothing to toggle");
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
