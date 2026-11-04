/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { Preferences } = ChromeUtils.importESModule("resource://gre/modules/Preferences.sys.mjs");

// W13 F02 (wave12 F02, A and B; the user asked for both): Firefox's
// built-in VPN (it keeps its name, Firefox IP Protection) gets
//  A. a "VPN" control with a status dot in the address bar: one click on
//     it toggles, the address bar's hover, only the dot changes; W14 3c: a
//     chevron after a hairline opens Firefox's own panel, anchored to it;
//  B. a row in This Site (Zen's site panel) with a switch and, while on,
//     the scope choice. W14 3a/3b: no shield anywhere (no tile, no badge on
//     the site icon) and an arrow cursor, like the rest of the address bar.
// Whether a Mozilla account is signed in isn't under the test's control, so
// Firefox's service and proxy states are stubbed (as browser_whimsy_vpn.js
// does); the clicks are real.

const { WhimsyVPN } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVPN.sys.mjs");
const { IPProtectionService, IPProtectionStates } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/ipprotection/IPProtectionService.sys.mjs"
);
const { IPPProxyManager, IPPProxyStates } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs"
);

function stubState(singleton, state) {
  Object.defineProperty(singleton, "state", { value: state, configurable: true });
  return () => delete singleton.state;
}

const control = () => document.getElementById("whimsy-vpn-urlbar");
const main = () => document.getElementById("whimsy-vpn-urlbar-toggle");
const chevron = () => document.getElementById("whimsy-vpn-urlbar-chevron");
const dot = () => control().querySelector(".whimsy-vpn-dot");
const siteIcon = () => document.getElementById("zen-site-data-icon-button");

// A colour expression as it resolves beside the control.
function resolved(expression) {
  const probe = document.createXULElement("box");
  probe.style.backgroundColor = expression;
  control().append(probe);
  const value = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return value;
}

// For checks that something does NOT happen: nothing to wait for.
const settle = ms => new Promise(resolve => setTimeout(resolve, ms)); // eslint-disable-line mozilla/no-arbitrary-setTimeout

let restore = [];
function setStates(service, proxy) {
  restore.forEach(fn => fn());
  restore = [stubState(IPProtectionService, service), stubState(IPPProxyManager, proxy)];
  WhimsyVPN.updateUi(window);
}

const LEAKED_PREFS = [
  "browser.ipProtection.added",
  "browser.ipProtection.locationListCache",
  "browser.ipProtection.onboardingMessageMask",
  "browser.ipProtection.stateCache",
  "media.peerconnection.ice.proxy_only_if_behind_proxy",
  "whimsy.stats.tabs-opened",
];

add_setup(async function () {
  const original = new Map(
    LEAKED_PREFS.filter(name => Services.prefs.prefHasUserValue(name)).map(name => [name, Preferences.get(name)])
  );
  await SpecialPowers.pushPrefEnv({
    set: [["whimsy.feature.vpn", true], ["browser.ipProtection.enabled", true], ["browser.ipProtection.whimsy.userContextIds", ""]],
  });
  registerCleanupFunction(() => {
    while (gBrowser.tabs.length > 1) {
      BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
    }
    restore.forEach(fn => fn());
    WhimsyVPN.updateUi(window);
    for (const name of LEAKED_PREFS) {
      if (original.has(name)) {
        Preferences.set(name, original.get(name));
      } else {
        Services.prefs.clearUserPref(name);
      }
    }
  });
});

add_task(async function test_address_bar_control() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  setStates(IPProtectionStates.READY, IPPProxyStates.NOT_READY);
  const el = control();
  ok(el && el.checkVisibility(), "A VPN control in the address bar");
  is(el.parentElement.id, "page-action-buttons", "…with the address bar's buttons");
  await document.l10n.translateFragment(el);
  is(el.querySelector(".whimsy-vpn-urlbar-label").value, "VPN", "It says VPN");
  is(el.getAttribute("state"), "off", "Off");
  const radius = getComputedStyle(document.getElementById("urlbar")).getPropertyValue("--urlbar-icon-border-radius").trim() || "8px";
  is(getComputedStyle(el).borderTopLeftRadius, radius, "The address bar's radius");
  is(getComputedStyle(dot()).backgroundColor, "rgba(0, 0, 0, 0)", "Off: the dot is a ring");
  isnot(getComputedStyle(dot()).boxShadow, "none", "…drawn as an inset ring");
  is(getComputedStyle(el).cursor, "default", "An arrow, not a finger, on the control");
  is(getComputedStyle(dot()).cursor, "default", "…and on its dot");

  is(getComputedStyle(chevron()).cursor, "default", "…and on the chevron");

  // The address bar's hover on each end, and the text never moves.
  const label = el.querySelector(".whimsy-vpn-urlbar-label");
  // Within the control: the address bar's other buttons (Copy URL on
  // hover) can move the whole control.
  const offset = () => label.getBoundingClientRect().left - el.getBoundingClientRect().left;
  const at = offset();
  const hover = resolved("var(--urlbar-box-hover-bgcolor, color-mix(in srgb, currentColor 9%, transparent))");
  for (const part of [main(), chevron()]) {
    InspectorUtils.addPseudoClassLock(part, ":hover");
    await TestUtils.waitForCondition(() => getComputedStyle(part).backgroundColor == hover, `Hover: the address bar's fill on ${part.id}`);
    InspectorUtils.removePseudoClassLock(part, ":hover");
  }

  // One real click turns it on.
  const calls = [];
  const start = IPPProxyManager.start;
  const stop = IPPProxyManager.stop;
  IPPProxyManager.start = async () => calls.push("start");
  IPPProxyManager.stop = async () => calls.push("stop");
  try {
    EventUtils.synthesizeMouseAtCenter(main(), {});
    await TestUtils.waitForCondition(() => calls.includes("start"), "A click starts Firefox's VPN");

    setStates(IPProtectionStates.READY, IPPProxyStates.ACTIVATING);
    is(el.getAttribute("state"), "connecting", "Connecting");
    is(getComputedStyle(dot()).animationName, "whimsy-vpn-pulse", "…the dot pulses amber");

    setStates(IPProtectionStates.READY, IPPProxyStates.ACTIVE);
    await TestUtils.waitForCondition(() => el.getAttribute("state") == "on", "On");
    is(getComputedStyle(dot()).backgroundColor, resolved("light-dark(rgb(31, 143, 78), rgb(79, 209, 139))"), "On: the dot is green");
    is(getComputedStyle(dot(), "::after").animationName, "whimsy-vpn-ring", "…sending out one ring");
    is(getComputedStyle(dot(), "::after").animationIterationCount, "1", "…once");
    is(offset(), at, "The text never moves");
    ok(!siteIcon().hasAttribute("whimsy-vpn-on"), "No shield badge on the site icon");
    is(getComputedStyle(siteIcon(), "::before").content, "none", "…none drawn");

    // And off again.
    EventUtils.synthesizeMouseAtCenter(main(), {});
    await TestUtils.waitForCondition(() => calls.includes("stop"), "A click stops it");
  } finally {
    IPPProxyManager.start = start;
    IPPProxyManager.stop = stop;
  }

  // Firefox's VPN switched off in Settings: no control at all.
  await SpecialPowers.pushPrefEnv({ set: [["browser.ipProtection.enabled", false]] });
  await TestUtils.waitForCondition(() => !el.checkVisibility(), "Hidden when Firefox's VPN is off");
  await SpecialPowers.popPrefEnv();
  await TestUtils.waitForCondition(() => el.checkVisibility(), "Back when it's on");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_this_site_row() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  setStates(IPProtectionStates.READY, IPPProxyStates.ACTIVE);
  const panel = document.getElementById("zen-unified-site-data-panel");
  const shown = BrowserTestUtils.waitForPopupEvent(panel, "shown");
  EventUtils.synthesizeMouseAtCenter(siteIcon(), {});
  await shown;
  const section = document.getElementById("whimsy-vpn-site-section");
  ok(section, "This Site has the VPN row");
  is(section.previousElementSibling?.id, "zen-site-data-header", "…first, under the quick buttons");
  const name = section.querySelector("#whimsy-vpn-site-name");
  const detail = section.querySelector("#whimsy-vpn-site-detail");
  await document.l10n.translateFragment(section);
  is(name.textContent, "Firefox IP Protection", "Firefox's name for its VPN");
  is(detail.textContent, "VPN on · All spaces", "Its state and scope");
  const toggle = section.querySelector("#whimsy-vpn-site-switch");
  ok(toggle.checked, "The switch is on");
  is(toggle.getAttribute("role"), "switch", "…a switch");
  ok(!section.querySelector(".whimsy-surface-tile"), "No shield tile");
  const scopeRow = section.querySelector(".whimsy-vpn-scope-row");
  const seg = scopeRow.querySelector(".whimsy-surface-seg");
  ok(scopeRow.hasAttribute("open") && seg.checkVisibility(), "The scope choice while it's on");
  is(seg.querySelector('[data-value="browser"]').getAttribute("aria-checked"), "true", "All spaces picked");

  // W14 3d: the space's profile, by name; a space on the Default profile
  // (no container) can be picked too.
  const { WhimsyVPNScope } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVPNScope.sys.mjs");
  const profile = WhimsyVPNScope.profileName(WhimsyVPNScope.profileForWindow(window));
  const spaceButton = seg.querySelector('[data-value="space"]');
  is(spaceButton.textContent, `All spaces in ${profile}`, "The other choice names the profile");
  ok(!spaceButton.disabled, "…and works without a container");
  EventUtils.synthesizeMouseAtCenter(spaceButton, {});
  await TestUtils.waitForCondition(() => spaceButton.getAttribute("aria-checked") == "true", "Picked");
  is(Services.prefs.getStringPref(WhimsyVPNScope.PREF), String(WhimsyVPNScope.profileForWindow(window)), "The profile is saved");
  is(seg.style.getPropertyValue("--index"), "1", "The thumb moves on the same control");
  is(section.querySelector(".whimsy-vpn-scope-row .whimsy-surface-seg"), seg, "…not a new one");
  await TestUtils.waitForCondition(() => detail.textContent == `VPN on · All spaces in ${profile}`, "The detail says so");
  EventUtils.synthesizeMouseAtCenter(spaceButton, {});
  await settle(100);
  is(Services.prefs.getStringPref(WhimsyVPNScope.PREF), String(WhimsyVPNScope.profileForWindow(window)), "Picking it again changes nothing");
  EventUtils.synthesizeMouseAtCenter(seg.querySelector('[data-value="browser"]'), {});
  await TestUtils.waitForCondition(() => Services.prefs.getStringPref(WhimsyVPNScope.PREF) == "", "All spaces again");
  is(seg.style.getPropertyValue("--index"), "0", "…the thumb slides back");

  // A real click on the switch turns it off, and the row is updated in
  // place: the same switch, its knob sliding, the scope row closing.
  const calls = [];
  const stop = IPPProxyManager.stop;
  IPPProxyManager.stop = async () => calls.push("stop");
  try {
    EventUtils.synthesizeMouseAtCenter(toggle, {});
    await TestUtils.waitForCondition(() => calls.includes("stop"), "The switch stops the VPN");
  } finally {
    IPPProxyManager.stop = stop;
  }
  setStates(IPProtectionStates.READY, IPPProxyStates.NOT_READY);
  is(section.querySelector("#whimsy-vpn-site-switch"), toggle, "The same switch");
  ok(!toggle.checked, "Off");
  await TestUtils.waitForCondition(() => detail.textContent == "Off · hides your location from sites", "Says what it does");
  is(section.querySelector("#whimsy-vpn-site-detail"), detail, "…in the same line");
  ok(!scopeRow.hasAttribute("open") && scopeRow.inert, "The scope row closes");
  is(getComputedStyle(scopeRow).transitionDuration.split(",")[0].trim(), "0.2s", "…over 200ms");

  // Turning on from a stubbed instant ACTIVATING then ACTIVE: no rebuild.
  setStates(IPProtectionStates.READY, IPPProxyStates.ACTIVATING);
  const knob = document.getAnimations().find(a => a.effect?.target == toggle && a.effect.pseudoElement == "::after");
  ok(knob, "The knob slides");
  setStates(IPProtectionStates.READY, IPPProxyStates.ACTIVE);
  is(section.querySelector("#whimsy-vpn-site-switch"), toggle, "Still the same switch");
  ok(toggle.checked && scopeRow.hasAttribute("open"), "On, with the scope row open");

  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  panel.hidePopup();
  await hidden;
  BrowserTestUtils.removeTab(tab);
});

// The coordinator's check: the lane saw the old toolbar badge's "VPN off"
// wrap onto two lines. The address bar control stays one line, 26px tall,
// in a narrow window too.
add_task(async function test_one_line_in_a_narrow_window() {
  const win = await BrowserTestUtils.openNewBrowserWindow();
  win.resizeTo(520, 600);
  await TestUtils.waitForCondition(() => win.outerWidth <= 540, "A narrow window");
  const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, "https://example.com/");
  setStates(IPProtectionStates.READY, IPPProxyStates.NOT_READY);
  WhimsyVPN.updateUi(win);
  const el = win.document.getElementById("whimsy-vpn-urlbar");
  await TestUtils.waitForCondition(() => el?.checkVisibility(), "The control shows");
  await win.document.l10n.translateFragment(el);
  const label = el.querySelector(".whimsy-vpn-urlbar-label");
  const style = win.getComputedStyle(label);
  is(style.whiteSpace, "nowrap", "The label never wraps");
  is(win.getComputedStyle(el).whiteSpace, "nowrap", "…nor the control");
  // One line: as tall as a one-character label in the same style.
  const probe = label.cloneNode();
  probe.setAttribute("value", "V");
  probe.removeAttribute("data-l10n-id");
  label.after(probe);
  const oneLine = probe.getBoundingClientRect().height;
  probe.remove();
  Assert.less(Math.abs(label.getBoundingClientRect().height - oneLine), 0.5, `The label is one line (${label.getBoundingClientRect().height}px)`);
  Assert.less(Math.abs(el.getBoundingClientRect().height - 26), 0.5, "The control is 26px tall");
  BrowserTestUtils.removeTab(tab);
  await BrowserTestUtils.closeWindow(win);
});

// W14 21.1: a reconnect goes from off to on within one task (Firefox keeps
// its proxy pass), so amber was never painted. Now "connecting" shows from
// the click for at least 800ms, and the dot visibly pulses (0.3 to 1, every
// 600ms).
add_task(async function test_connecting_shows_on_an_instant_reconnect() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  setStates(IPProtectionStates.READY, IPPProxyStates.NOT_READY);
  const el = control();
  await TestUtils.waitForCondition(() => el.checkVisibility(), "The control shows");
  const seen = [];
  const observer = new MutationObserver(() => seen.push([el.getAttribute("state"), performance.now()]));
  observer.observe(el, { attributeFilter: ["state"] });
  const start = IPPProxyManager.start;
  IPPProxyManager.start = async () => {
    setStates(IPProtectionStates.READY, IPPProxyStates.ACTIVATING);
    setStates(IPProtectionStates.READY, IPPProxyStates.ACTIVE);
  };
  try {
    const clicked = performance.now();
    EventUtils.synthesizeMouseAtCenter(main(), {});
    await TestUtils.waitForCondition(() => el.getAttribute("state") == "on", "On in the end");
    observer.disconnect();
    const connecting = seen.find(([state]) => state == "connecting");
    ok(connecting, "Connecting showed");
    const on = seen.find(([state]) => state == "on");
    Assert.greaterOrEqual(on[1] - clicked, 700, `…for at least 700ms (${Math.round(on[1] - clicked)}ms) before on`);
  } finally {
    IPPProxyManager.start = start;
    observer.disconnect();
  }
  setStates(IPProtectionStates.READY, IPPProxyStates.ACTIVATING);
  const style = getComputedStyle(dot());
  is(style.animationName, "whimsy-vpn-pulse", "The amber dot pulses");
  is(style.animationDuration, "0.3s", "…every 300ms each way");
  is(style.animationDirection, "alternate", "…back and forth");
  const keyframes = dot().getAnimations()[0].effect.getKeyframes();
  is(Number(keyframes[0].opacity), 0.3, "…from 0.3");
  setStates(IPProtectionStates.READY, IPPProxyStates.NOT_READY);
  BrowserTestUtils.removeTab(tab);
});

// W14 3c: the chevron opens Firefox's own panel (sign-in, location, usage,
// rules), anchored to it, and closes it when pressed again; the main part
// still only toggles.
add_task(async function test_chevron_opens_firefox_panel() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  setStates(IPProtectionStates.READY, IPPProxyStates.NOT_READY);
  const el = control();
  await TestUtils.waitForCondition(() => el.checkVisibility(), "The control shows");
  const cv = chevron();
  is(cv.previousElementSibling.className, "whimsy-vpn-urlbar-divider", "A hairline between the two ends");
  is(cv.getAttribute("aria-haspopup"), "true", "The chevron says it opens a panel");
  is(cv.getAttribute("aria-expanded"), "false", "…closed");
  Assert.less(Math.abs(cv.getBoundingClientRect().width - 20), 0.5, "The chevron is 20px wide");

  const vpnPanel = () => WhimsyVPN.getPanel(window);
  EventUtils.synthesizeMouseAtCenter(cv, {});
  await TestUtils.waitForCondition(() => vpnPanel()?.panel?.state == "open", "A click on the chevron opens Firefox's panel");
  const panel = vpnPanel().panel;
  ok(panel.querySelector("#PanelUI-ipprotection"), "…its VPN view");
  is(panel.anchorNode, cv, "…anchored to the chevron");
  is(cv.getAttribute("aria-expanded"), "true", "The chevron says it's open");

  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  EventUtils.synthesizeMouseAtCenter(cv, {});
  await hidden;
  await settle(300);
  ok(!vpnPanel()?.active, "A second click closes it, and it stays closed");
  is(cv.getAttribute("aria-expanded"), "false", "…closed");

  // The keyboard: Enter on the chevron opens it, Escape closes it.
  cv.focus();
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(() => vpnPanel()?.panel?.state == "open", "Enter on the chevron opens it");
  const closed = BrowserTestUtils.waitForPopupEvent(vpnPanel().panel, "hidden");
  EventUtils.synthesizeKey("KEY_Escape");
  await closed;

  // The main part toggles and never opens the panel.
  const calls = [];
  const start = IPPProxyManager.start;
  IPPProxyManager.start = async () => calls.push("start");
  try {
    EventUtils.synthesizeMouseAtCenter(main(), {});
    await TestUtils.waitForCondition(() => calls.includes("start"), "A click on VPN starts it");
    await settle(300);
    ok(!vpnPanel()?.active, "…without opening the panel");
  } finally {
    IPPProxyManager.start = start;
    WhimsyVPN.endHold();
  }
  BrowserTestUtils.removeTab(tab);
});

add_task(function test_command() {
  const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
  const entry = WhimsyCommands.get("cmd_whimsyVPNToggle");
  ok(entry?.keyId && document.getElementById(entry.keyId), "Turn VPN On or Off has a key Settings can bind");
  const panel = WhimsyCommands.get("cmd_whimsyVPNPanel");
  ok(panel?.keyId && document.getElementById(panel.keyId), "Open Firefox IP Protection Panel has a key Settings can bind");
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  ok(globalActions.find(a => a.whimsyCommand == "cmd_whimsyVPNPanel")?.icon, "…and an icon in the command bar");
  const call = WhimsyCommands.get("cmd_whimsyVPNPauseCall");
  ok(call?.keyId && document.getElementById(call.keyId), "Pause VPN for This Call has a key Settings can bind");
  ok(globalActions.find(a => a.whimsyCommand == "cmd_whimsyVPNPauseCall")?.icon, "…and an icon");
});

// W14 4: a call can't connect on a page Firefox's VPN carries (Firefox
// turns off direct connections for it). When one starts, Whimsy asks
// "Pause VPN for this call?": yes adds a session-only "don't use the VPN"
// rule for the site and reloads it; the rule goes when the call ends.
add_task(async function test_call_asks_to_pause_the_vpn() {
  const { IPPChannelFilter } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/ipprotection/IPPChannelFilter.sys.mjs"
  );
  await SpecialPowers.pushPrefEnv({ set: [
    ["media.peerconnection.ice.proxy_only_if_behind_proxy", true],
    ["media.navigator.permission.disabled", false],
    ["browser.ipProtection.mode", 0],
  ] });
  const filter = IPPChannelFilter.create();
  filter.proxyInfo = {};
  const channelFilter = IPPProxyManager.channelFilter;
  IPPProxyManager.channelFilter = () => filter;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const browser = tab.linkedBrowser;
  const principal = browser.contentPrincipal;
  const rule = () => Services.perms.getPermissionObject(principal, "ipp-vpn", true);
  const toasts = gZenUIManager.toasts;
  const callToast = () => toasts.getToast("whimsy-vpn-call");
  const startCall = () => SpecialPowers.spawn(browser, [], async () => {
    const pc = new content.RTCPeerConnection();
    await pc.createOffer({ offerToReceiveAudio: true });
    pc.close();
  });
  try {
    setStates(IPProtectionStates.READY, IPPProxyStates.ACTIVE);
    ok(WhimsyVPN.callBlocked(browser), "A call on this page can't connect through the VPN");
    ok(!rule(), "No rule for the site yet");

    await startCall();
    const toast = await TestUtils.waitForCondition(callToast, "A call starts: Whimsy asks");
    await toast.shown;
    await document.l10n.translateFragment(toast.element);
    ok(toast.element.textContent.includes("Pause VPN for this call?"), "Pause VPN for this call?");
    const pause = toast.element.querySelector("#whimsy-vpn-call-pause");
    ok(pause?.checkVisibility(), "…with Pause VPN");
    ok(toast.element.querySelector("#whimsy-vpn-call-keep")?.checkVisibility(), "…and Keep On");
    ok(WhimsyVPN.canPauseForCall(window), "Pause VPN for This Call is offered in the command bar");

    const reloaded = BrowserTestUtils.browserLoaded(browser);
    EventUtils.synthesizeMouseAtCenter(pause, {});
    await reloaded;
    is(rule()?.capability, Ci.nsIPermissionManager.DENY_ACTION, "The site gets a don't-use-the-VPN rule");
    is(rule()?.expireType, Ci.nsIPermissionManager.EXPIRE_SESSION, "…for this session only");
    ok(!WhimsyVPN.callBlocked(browser), "The reloaded page's call connects directly");
    await startCall();
    await settle(300);
    ok(!callToast(), "No second ask for the call itself");

    // The call: media starts on the reloaded page, then stops.
    gBrowser.updateBrowserSharing(browser, { webRTC: { sharing: "camera" } });
    ok(rule(), "The rule stays during the call");
    gBrowser.updateBrowserSharing(browser, { webRTC: null });
    ok(!rule(), "The call ends: the rule is gone, the VPN is back for the site");

    // Keep On: no more asks on this page.
    await startCall();
    const again = await TestUtils.waitForCondition(callToast, "A new call asks again");
    await again.shown;
    EventUtils.synthesizeMouseAtCenter(again.element.querySelector("#whimsy-vpn-call-keep"), {});
    await TestUtils.waitForCondition(() => !callToast(), "Keep On closes it");
    await startCall();
    await settle(300);
    ok(!callToast(), "…and it doesn't ask again here");
    ok(!rule(), "Nothing changed for the site");

    // Leaving the site also takes the rule back off.
    ok(WhimsyVPN.pauseForCall(browser), "Paused again (the command)");
    await BrowserTestUtils.browserLoaded(browser);
    ok(rule(), "Rule on");
    BrowserTestUtils.startLoadingURIString(browser, "https://example.org/");
    await BrowserTestUtils.browserLoaded(browser);
    ok(!rule(), "The tab left the site: the rule is gone");
  } finally {
    IPPProxyManager.channelFilter = channelFilter;
    Services.perms.removeFromPrincipal(principal, "ipp-vpn");
    setStates(IPProtectionStates.READY, IPPProxyStates.NOT_READY);
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});
