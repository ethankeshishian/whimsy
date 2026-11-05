/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W21/W14-6: the "⋯" Call Options button (small player and PiP) and the
// panel it opens: "Buttons mute: <app> | This Device", then a switch per
// mute showing the real state; opened only from its own button (W14-7).
// Design: whimsy-handoff/wave13/design/call-options (option A).

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

let currentPip = null;
let sharedCall = null;
async function openCall() {
  if (sharedCall) {
    // While the call floats (currentPip) selecting its tab would snap the PiP back.
    if (!currentPip && gBrowser.selectedTab != sharedCall) {
      await BrowserTestUtils.switchTab(gBrowser, sharedCall);
    }
    return sharedCall;
  }
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  // A real fake-device call (as browser_whimsy_call_controls.js): the PiP
  // window needs the call's video to float.
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

// The same panel from the call's floating (PiP) window: leave for another
// tab, open the panel from the PiP window's "⋯".

async function floatCall(call) {
  const other = BrowserTestUtils.addTab(gBrowser, "about:blank");
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(null);
  gBrowser.selectedTab = other;
  const pip = await opened;
  await TestUtils.waitForCondition(
    () => pip._whimsyCallBrowser == call.linkedBrowser && pip.document.getElementById("whimsy-call-options"),
    "The PiP window shows the call with its Call Options button"
  );
  return { pip, other };
}

async function unfloatCall(call, { pip, other }) {
  const closed = BrowserTestUtils.domWindowClosed(pip);
  gBrowser.selectedTab = call;
  await closed;
  BrowserTestUtils.removeTab(other);
}

async function openPipPanel(pip) {
  const doc = pip.document;
  EventUtils.synthesizeMouseAtCenter(doc.getElementById("controls"), { type: "mousemove" }, pip);
  const shown = BrowserTestUtils.waitForEvent(pip, "popupshown", false, e => e.target.id == "whimsy-call-options-panel");
  EventUtils.synthesizeMouseAtCenter(doc.getElementById("whimsy-call-options"), {}, pip);
  return (await shown).target;
}

// Each of these runs from the small player, then from the PiP window.
function addViaTasks(fn) {
  add_task(async function () {
    await fn(null);
  });
  add_task(async function () {
    const call = await openCall();
    const floating = await floatCall(call);
    currentPip = floating.pip;
    try {
      await fn(floating.pip);
    } finally {
      currentPip = null;
      await unfloatCall(call, floating);
    }
  });
}

async function openPanelVia(call) {
  return currentPip ? openPipPanel(currentPip) : openOptionsPanel(call);
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

function row(panel, name) {
  return panel.querySelector(`[data-row="${name}"]`);
}

function rowSwitch(panel, name) {
  return row(panel, name)?.querySelector(".whimsy-surface-switch");
}

function detailOf(panel, name) {
  const detail = row(panel, name)?.querySelector(".whimsy-surface-row-detail");
  return detail && !detail.hidden ? detail.textContent : "";
}

function clickPage(browser, kind) {
  return SpecialPowers.spawn(browser, [kind], k => {
    const name = k == "mic" ? "microphone" : "camera";
    content.document.querySelector(`#bar button[aria-label*=${name}]`).click();
  });
}

// W14-6: layout A — "Buttons mute: <app> | This Device" on top, then a
// switch per mute under a fixed label, no letters, nothing cut off.
add_task(async function test_panel_layout() {
  const call = await openCall();
  const panel = await openOptionsPanel(call);
  try {
    is(panel.querySelector(".whimsy-surface-caption-label").textContent, "Buttons mute", "the choice comes first");
    const seg = panel.querySelector(".whimsy-call-options-default");
    is(seg.querySelector("[aria-checked=true]").dataset.value, "call", "defaults to the call's own buttons");
    const segments = [...seg.querySelectorAll(".whimsy-surface-segment")];
    Assert.deepEqual(segments.map(b => b.textContent), ["The Call", "This Device"], "a page without a name: The Call");
    for (const b of segments) {
      Assert.lessOrEqual(b.scrollWidth, b.clientWidth, `"${b.textContent}" isn't cut off`);
    }
    for (const name of ["mic-in-call", "mic-device", "camera-in-call", "camera-device"]) {
      ok(rowSwitch(panel, name), `${name} has a switch`);
    }
    is(row(panel, "mic-in-call").querySelector(".whimsy-surface-row-label").textContent, "Muted in the call", "fixed label");
    is(row(panel, "camera-in-call").querySelector(".whimsy-surface-row-label").textContent, "Off in the call", "fixed label");
    is(row(panel, "mic-device").querySelector(".whimsy-surface-row-label").textContent, "Blocked on this device", "fixed label");
    const letters = [...panel.querySelectorAll("span, label")].filter(el => /^[A-Z]$/.test(el.textContent.trim()));
    Assert.deepEqual(letters.map(el => el.textContent), [], "no shortcut letters");
    ok(!/saved for all calls/i.test(panel.textContent), "no 'saved for all calls' text");
    ok(panel.querySelector(".whimsy-call-options-fallback").hidden, "no fallback line while the page's mutes are found");
  } finally {
    panel.hidePopup();
  }
});

// The page's own app name, once it gives one (it's sent with the state).
add_task(async function test_panel_names_the_app() {
  const call = await openCall();
  const browser = call.linkedBrowser;
  await SpecialPowers.spawn(browser, [], () => {
    const meta = content.document.createElement("meta");
    meta.name = "application-name";
    meta.content = "Meet";
    content.document.head.append(meta);
  });
  const panel = await openOptionsPanel(call);
  try {
    await clickPage(browser, "mic");
    await TestUtils.waitForCondition(() => WhimsyCallPip.appName(browser) == "Meet", "the page's name arrives");
    const first = panel.querySelector(".whimsy-call-options-default .whimsy-surface-segment");
    await TestUtils.waitForCondition(() => first.textContent == "Meet", "Buttons mute: Meet | This Device");
    await clickPage(browser, "mic");
    await TestUtils.waitForCondition(() => WhimsyCallPip.shownState(browser, "mic") == "on", "back on");
  } finally {
    panel.hidePopup();
  }
});

// 6c: the switches follow every change while the panel is open — the page's
// own buttons, the small player, and a switch's own press.
async function test_switches_follow_the_real_state() {
  const call = await openCall();
  const browser = call.linkedBrowser;
  const panel = await openPanelVia(call);
  try {
    ok(!rowSwitch(panel, "mic-in-call").checked, "the microphone is on in the call");
    await clickPage(browser, "mic");
    await TestUtils.waitForCondition(() => rowSwitch(panel, "mic-in-call").checked, "Meet's own button: the switch follows");
    await clickPage(browser, "mic");
    await TestUtils.waitForCondition(() => !rowSwitch(panel, "mic-in-call").checked, "…and back");

    EventUtils.synthesizeMouseAtCenter(rowSwitch(panel, "camera-in-call"), {}, panel.documentGlobal);
    await TestUtils.waitForCondition(() => WhimsyCallPip.shownState(browser, "camera") == "off", "the switch turns the call's camera off");
    ok(rowSwitch(panel, "camera-in-call").checked, "…and shows it");
    EventUtils.synthesizeMouseAtCenter(rowSwitch(panel, "camera-in-call"), {}, panel.documentGlobal);
    await TestUtils.waitForCondition(() => WhimsyCallPip.shownState(browser, "camera") == "on", "…and on");
    await TestUtils.waitForCondition(() => !rowSwitch(panel, "camera-in-call").checked, "…and shows that");

    EventUtils.synthesizeMouseAtCenter(rowSwitch(panel, "mic-device"), {}, panel.documentGlobal);
    ok(WhimsyCallPip.stateFor(browser).blocked.mic, "the device switch blocks the microphone");
    ok(rowSwitch(panel, "mic-device").checked, "…and shows it");
    is(panel.state, "open", "the panel stays open");
    WhimsyCallPip.toggleBlocked(browser, "mic");
    ok(!rowSwitch(panel, "mic-device").checked, "a block released elsewhere shows at once");
  } finally {
    panel.hidePopup();
  }
}
addViaTasks(test_switches_follow_the_real_state);


// The hint sits on the mute a plain press does, and moves with the choice.
async function test_hint_moves_with_the_choice() {
  const call = await openCall();
  const panel = await openPanelVia(call);
  try {
    // The hint text is localized a moment after it is set (the PiP window's
    // document most visibly).
    await TestUtils.waitForCondition(() => detailOf(panel, "mic-in-call") == "Mic button", "a plain press mutes in the call");
    is(detailOf(panel, "mic-device"), "", "…not on the device");
    // W16-2 (D1): from the PiP window too, the camera button follows the
    // choice (Whimsy answers the call's camera request from another tab).
    await TestUtils.waitForCondition(() => detailOf(panel, "camera-in-call") == "Camera button", "same for the camera");
    EventUtils.synthesizeMouseAtCenter(panel.querySelector('.whimsy-call-options-default [data-value="device"]'), {}, panel.documentGlobal);
    is(Services.prefs.getStringPref("whimsy.call.buttons-default"), "device", "the choice is saved");
    await TestUtils.waitForCondition(() => detailOf(panel, "mic-device") == "Mic button", "the hint moves to the device");
    is(detailOf(panel, "mic-in-call"), "", "…off the call's row");
    is(detailOf(panel, "camera-device"), "Camera button", "…for the camera too");
  } finally {
    Services.prefs.clearUserPref("whimsy.call.buttons-default");
    panel.hidePopup();
  }
}
addViaTasks(test_hint_moves_with_the_choice);


// 6d: with no in-call control on the page, the buttons block the device,
// and the panel says so.
async function test_fallback_shows_when_the_page_mute_is_missing() {
  const call = await openCall();
  const browser = call.linkedBrowser;
  await SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.removeControls());
  await TestUtils.waitForCondition(
    () => WhimsyCallPip.displayState(browser, "mic").inCallAvailable === false,
    "The page's controls are gone"
  );
  const panel = await openPanelVia(call);
  try {
    const warn = panel.querySelector(".whimsy-call-options-fallback");
    ok(!warn.hidden, "a line says the buttons block this device now");
    await TestUtils.waitForCondition(() => warn.textContent.includes("block this device"), "…in words");
    ok(rowSwitch(panel, "mic-in-call").disabled, "the call's mute can't be used");
    ok(row(panel, "mic-in-call").classList.contains("whimsy-call-options-dim"), "…and dims");
    await TestUtils.waitForCondition(() => /mute button wasn't found/.test(detailOf(panel, "mic-in-call")), "…with the reason");
    is(detailOf(panel, "mic-device"), "Mic button", "the hint is on the device block");
    await SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.restoreControls());
    await TestUtils.waitForCondition(() => warn.hidden, "controls back: the line goes");
    await TestUtils.waitForCondition(() => detailOf(panel, "mic-in-call") == "Mic button", "…and the hint returns");
  } finally {
    panel.hidePopup();
  }
}
addViaTasks(test_fallback_shows_when_the_page_mute_is_missing);


const SAMPLES = {
  caption: ".whimsy-surface-caption-label",
  seg: ".whimsy-call-options-default",
  segment: ".whimsy-surface-segment",
  switch: ".whimsy-surface-switch",
  rowLabel: ".whimsy-surface-row-label",
  rowDetail: '[data-row="mic-in-call"] .whimsy-surface-row-detail',
  icon: ".whimsy-call-options-icon",
  row: ".whimsy-surface-row",
};
const SAMPLE_PROPS = ["fontSize", "fontWeight", "color", "backgroundColor", "width", "height", "padding", "borderRadius"];

function snapshot(panel) {
  const win = panel.documentGlobal;
  const styles = {};
  for (const [name, selector] of Object.entries(SAMPLES)) {
    const el = panel.querySelector(selector);
    ok(el, `the panel has a ${name}`);
    const computed = win.getComputedStyle(el);
    styles[name] = Object.fromEntries(SAMPLE_PROPS.map(prop => [prop, computed[prop]]));
  }
  return {
    rows: [...panel.querySelectorAll("[data-row]")].map(r => r.dataset.row),
    captions: [...panel.querySelectorAll(".whimsy-surface-caption-label")].map(c => c.textContent),
    segments: [...panel.querySelectorAll(".whimsy-surface-segment")].map(c => c.textContent),
    primary: win.getComputedStyle(panel).getPropertyValue("--zen-primary-color"),
    panelBackground: win.getComputedStyle(panel).backgroundColor,
    panelRadius: win.getComputedStyle(panel).borderRadius,
    styles,
  };
}

// The PiP panel is the small player's panel: same rows, same look.
add_task(async function test_pip_panel_looks_like_the_small_players() {
  const call = await openCall();
  const small = await openOptionsPanel(call);
  const fromPlayer = snapshot(small);
  const hidden = BrowserTestUtils.waitForEvent(small, "popuphidden");
  small.hidePopup();
  await hidden;

  const floating = await floatCall(call);
  const panel = await openPipPanel(floating.pip);
  try {
    ok(panel.classList.contains("whimsy-surface"), "the PiP window's panel is a Whimsy surface");
    const fromPip = snapshot(panel);
    Assert.deepEqual(fromPip.rows, fromPlayer.rows, "the same rows in the same order");
    Assert.deepEqual(fromPip.captions, fromPlayer.captions, "the same captions");
    Assert.deepEqual(fromPip.segments, fromPlayer.segments, "the same segmented choices");
    Assert.deepEqual(fromPip.styles, fromPlayer.styles, "the same computed styles on every part");
    // The small player's panel is drawn by the system (a native popover: its
    // own background is transparent, or the system's), and the PiP window's
    // is filled by the panel's content: both must be a solid, themed fill.
    const fill = panel.documentGlobal.getComputedStyle(panel, "::part(content)").backgroundColor;
    isnot(fill, "rgba(0, 0, 0, 0)", `the PiP panel has a fill of its own (${fill})`);
    is(fill, panel.style.getPropertyValue("--arrowpanel-background") ? fill : "", "the fill is the themed one");
    is(fromPip.panelRadius, fromPlayer.panelRadius, "the same panel corners");
    const callPrimary = getComputedStyle(document.documentElement).getPropertyValue("--zen-primary-color");
    ok(callPrimary, "the call window has an accent");
    is(fromPip.primary, callPrimary, "the PiP panel uses the call window's accent");
    is(fromPlayer.primary, callPrimary, "...as the small player's does");
    Assert.greater(parseFloat(fromPip.styles.caption.fontSize), 0, "a caption has a size");
    Assert.less(parseFloat(fromPip.styles.caption.fontSize), 16, "the caption is not a default heading");
    is(fromPip.styles.switch.width, fromPlayer.styles.switch.width, "the switch is the styled one, not a native checkbox");
  } finally {
    panel.hidePopup();
    await unfloatCall(call, floating);
  }
});

// A change in one panel shows in the other: refresh reaches both.
add_task(async function test_both_panels_stay_in_step() {
  const call = await openCall();
  const browser = call.linkedBrowser;
  const floating = await floatCall(call);
  const pipPanel = await openPipPanel(floating.pip);
  const { WhimsyCallOptionsPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCallOptionsPanel.sys.mjs");
  const shown = BrowserTestUtils.waitForEvent(window, "popupshown", false, e => e.target.id == "whimsy-call-options-panel");
  WhimsyCallOptionsPanel.open(window, browser, { anchor: cardFor(call).querySelector("#whimsy-call-options") });
  const smallPanel = (await shown).target;
  try {
    is(pipPanel.state, "open", "the PiP panel stays open beside the other");
    EventUtils.synthesizeMouseAtCenter(rowSwitch(pipPanel, "camera-in-call"), {}, floating.pip);
    await TestUtils.waitForCondition(() => rowSwitch(smallPanel, "camera-in-call").checked, "the small player's panel follows the PiP's");
    EventUtils.synthesizeMouseAtCenter(rowSwitch(smallPanel, "camera-in-call"), {}, window);
    await TestUtils.waitForCondition(() => !rowSwitch(pipPanel, "camera-in-call").checked, "the PiP's follows the small player's");
    await TestUtils.waitForCondition(() => WhimsyCallPip.shownState(browser, "camera") == "on", "the camera is back on");
  } finally {
    smallPanel.hidePopup();
    pipPanel.hidePopup();
    await unfloatCall(call, floating);
  }
});

// 6c: Zen lets go of the device mute itself (its card's close button sends
// webrtc:Unmute*); the block reads off from then on.
add_task(async function test_zen_releasing_the_device_shows() {
  const call = await openCall();
  const browser = call.linkedBrowser;
  WhimsyCallPip.toggleBlocked(browser, "mic");
  WhimsyCallPip.toggleBlocked(browser, "camera");
  ok(WhimsyCallPip.stateFor(browser).blocked.mic, "blocked");
  cardFor(call).querySelector(".zen-media-close-button").doCommand();
  ok(!WhimsyCallPip.stateFor(browser).blocked.mic, "Zen's close unmuted the microphone");
  ok(!WhimsyCallPip.stateFor(browser).blocked.camera, "…and the camera");
  await TestUtils.waitForCondition(() => !cardFor(call), "the card is gone");
  WhimsyCallPip.toggleBlocked(browser, "mic");
  // Zen drops a closed card from its list once its exit animation ends.
  await TestUtils.waitForCondition(() => {
    gZenMediaController.updateMediaSharing({
      windowId: browser.innerWindowID,
      showCameraIndicator: true,
      showMicrophoneIndicator: false,
    });
    return cardFor(call);
  }, "a new card (Zen unmutes both first)");
  ok(!WhimsyCallPip.stateFor(browser).blocked.mic, "the new card starts unblocked");
  const panel = await openOptionsPanel(call);
  try {
    ok(!rowSwitch(panel, "mic-device").checked, "the panel reads unblocked");
  } finally {
    panel.hidePopup();
  }
});
