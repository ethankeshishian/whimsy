/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W21: the "⋯" Call Options button (small player and PiP) and the panel it
// opens — all four mutes as checkable rows, the Click Mutes default switch,
// opened by its own click, by right-click on mic/camera, and by Shift+F10.
// Design: whimsy-handoff/wave13/design/call-controls-v2 (page v3, option E1).

const { WhimsyCallPip } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCallPip.sys.mjs");
const { SitePermissions } = ChromeUtils.importESModule("resource:///modules/SitePermissions.sys.mjs");

const ORIGIN = "https://example.com";
const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", ORIGIN) + "whimsy_meet.html";

add_setup(async function () {
  // As browser_whimsy_call_controls.js: fake devices behind a real, granted
  // permission, so the tab reports sharing and gets its small player.
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
      ["media.navigator.streams.fake", true],
      ["media.navigator.permission.fake", true],
      ["media.audio_loopback_dev", ""],
      ["media.video_loopback_dev", ""],
      ["media.getusermedia.window.focus_source.enabled", false],
      ["media.autoplay.default", 0],
      ["media.autoplay.blocking_policy", 0],
    ],
  });
});

let sharedCall = null;
async function openCall() {
  if (sharedCall) {
    if (gBrowser.selectedTab != sharedCall) {
      await BrowserTestUtils.switchTab(gBrowser, sharedCall);
    }
    return sharedCall;
  }
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  // No real camera needed for these tests (button/panel wiring only); a
  // second fake camera getUserMedia in one run never resolved reliably
  // (see browser_whimsy_call_controls.js's openCall and browser_whimsy_call_pip.js),
  // so the sharing indicator is set directly, as that file's second call does.
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.wrappedJSObject.startCall({ camera: false }));
  gZenMediaController.updateMediaSharing({
    windowId: tab.linkedBrowser.innerWindowID,
    showCameraIndicator: true,
    showMicrophoneIndicator: false,
  });
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

// As browser_whimsy_call_controls.js's clickCard: hovering opens the card's
// header over 0.3s, which pushes the buttons down; a press before that
// settles lands on the wrong element. Wait for the button's rect to stop
// moving, re-reading it each frame, before clicking.
async function settle(getEl) {
  EventUtils.synthesizeMouseAtCenter(getEl(), { type: "mousemove" }, window);
  let last = "";
  await TestUtils.waitForCondition(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const now = getEl();
    const rect = JSON.stringify(now?.getBoundingClientRect());
    const still = rect == last;
    last = rect;
    if (!still && now) {
      EventUtils.synthesizeMouseAtCenter(now, { type: "mousemove" }, window);
    }
    return still;
  }, "The button has stopped moving");
  return getEl();
}

async function openOptionsPanel(tab) {
  const card = cardFor(tab);
  const options = card.querySelector("#whimsy-call-options");
  ok(options, "the small player has a Call Options button");
  await settle(() => cardFor(tab)?.querySelector("#whimsy-call-options"));
  const shown = BrowserTestUtils.waitForEvent(window, "popupshown", false, e => e.target.id == "whimsy-call-options-panel");
  EventUtils.synthesizeMouseAtCenter(cardFor(tab).querySelector("#whimsy-call-options"), {}, window);
  const event = await shown;
  return event.target;
}

add_task(async function test_options_button_exists_after_a_hairline() {
  const call = await openCall();
  const card = cardFor(call);
  const options = card.querySelector("#whimsy-call-options");
  ok(options, "options button exists in the small player");
  ok(card.querySelector(".whimsy-call-options-rule"), "a hairline separates it from mic/camera");
});

add_task(async function test_click_options_opens_panel_anchored_to_it() {
  const call = await openCall();
  const panel = await openOptionsPanel(call);
  is(panel.id, "whimsy-call-options-panel", "the WhimsySurface panel opened");
  panel.hidePopup();
});

// For checks that something does NOT happen: nothing to wait for.
const wait = ms => new Promise(resolve => setTimeout(resolve, ms)); // eslint-disable-line mozilla/no-arbitrary-setTimeout

// W14-7: right-click, Ctrl-click (macOS's secondary click) and Shift+F10 on
// the small player's mic and camera neither toggle nor open anything.
add_task(async function test_secondary_clicks_on_mic_and_camera_do_nothing() {
  const call = await openCall();
  const browser = call.linkedBrowser;
  const pageState = () => SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.meetState());
  const before = await pageState();
  const popups = [];
  const onShown = event => popups.push(event.target.id);
  window.addEventListener("popupshown", onShown);
  try {
    for (const kind of ["mic", "camera"]) {
      const button = () => cardButton(call, kind);
      await settle(button);
      EventUtils.synthesizeMouseAtCenter(button(), { ctrlKey: true }, window);
      EventUtils.synthesizeMouseAtCenter(button(), { type: "mousedown", button: 2 }, window);
      EventUtils.synthesizeMouseAtCenter(button(), { type: "contextmenu", button: 2 }, window);
      EventUtils.synthesizeMouseAtCenter(button(), { type: "mouseup", button: 2 }, window);
      button().focus();
      EventUtils.synthesizeKey("KEY_F10", { shiftKey: true }, window);
    }
    await wait(500);
    const after = await pageState();
    is(after.mic, before.mic, "the call's microphone is unchanged");
    is(after.camera, before.camera, "the call's camera is unchanged");
    ok(!WhimsyCallPip.stateFor(browser).blocked.mic, "the microphone isn't blocked");
    ok(!WhimsyCallPip.stateFor(browser).blocked.camera, "the camera isn't blocked");
    Assert.deepEqual(popups, [], "no panel or context menu opened");
  } finally {
    window.removeEventListener("popupshown", onShown);
    for (const id of ["whimsy-call-options-panel", "toolbar-context-menu"]) {
      document.getElementById(id)?.hidePopup?.();
    }
  }
});

add_task(async function test_panel_lists_all_four_mutes_with_shortcuts_and_checks() {
  const call = await openCall();
  await WhimsyCallPip.toggleInCall(call.linkedBrowser, "mic"); // mic now off in-call
  const panel = await openOptionsPanel(call);
  try {
    for (const row of ["mic-in-call", "mic-device", "camera-in-call", "camera-device"]) {
      ok(panel.querySelector(`[data-row="${row}"]`), `${row} row exists`);
    }
    const micInCallRow = panel.querySelector('[data-row="mic-in-call"]');
    is(micInCallRow.getAttribute("aria-checked"), "true", "mic in-call row shows checked (muted)");
    ok(panel.querySelector(".whimsy-call-options-shortcut").textContent.includes("D"), "shortcut hint is shown");
  } finally {
    panel.hidePopup();
    await WhimsyCallPip.toggleInCall(call.linkedBrowser, "mic");
  }
});

add_task(async function test_panel_has_click_mutes_switch_matching_the_pref() {
  const call = await openCall();
  const panel = await openOptionsPanel(call);
  try {
    const seg = panel.querySelector(".whimsy-surface-seg");
    is(seg.querySelector("[aria-checked=true]").dataset.value, "call", "defaults to call");
  } finally {
    panel.hidePopup();
  }
});

add_task(async function test_clicking_a_panel_row_toggles_and_stays_open() {
  const call = await openCall();
  const panel = await openOptionsPanel(call);
  try {
    const row = panel.querySelector('[data-row="mic-device"]');
    row.click();
    await TestUtils.waitForCondition(
      () => WhimsyCallPip.stateFor(call.linkedBrowser).blocked.mic,
      "the row toggled the device mute"
    );
    ok(panel.isConnected, "panel still open after one toggle");
    is(panel.state, "open", "the panel did not close itself");
  } finally {
    await WhimsyCallPip.toggleBlocked(call.linkedBrowser, "mic");
    panel.hidePopup();
  }
});

add_task(async function test_dimmed_in_call_row_when_no_controls_found() {
  const call = await openCall();
  await SpecialPowers.spawn(call.linkedBrowser, [], () => {
    content.document.querySelector("#bar button[aria-label*=microphone]")?.remove();
  });
  await TestUtils.waitForCondition(
    () => WhimsyCallPip.displayState(call.linkedBrowser, "mic").inCallAvailable === false,
    "The mic's in-call control is gone"
  );
  const panel = await openOptionsPanel(call);
  try {
    const row = panel.querySelector('[data-row="mic-in-call"]');
    ok(
      row.matches("[aria-disabled=true]") || row.classList.contains("whimsy-surface-row-dim"),
      "in-call row dims when this call page has no recognisable controls"
    );
  } finally {
    panel.hidePopup();
    await SpecialPowers.spawn(call.linkedBrowser, [], () => content.wrappedJSObject.restoreControls());
  }
});

add_task(async function test_switching_click_mutes_updates_the_pref() {
  const call = await openCall();
  const panel = await openOptionsPanel(call);
  try {
    panel.querySelector('.whimsy-surface-seg [data-value="device"]').click();
    is(Services.prefs.getStringPref("whimsy.call.buttons-default"), "device");
  } finally {
    Services.prefs.clearUserPref("whimsy.call.buttons-default");
    panel.hidePopup();
  }
});
