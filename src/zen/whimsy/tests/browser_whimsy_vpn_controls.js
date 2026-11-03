/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { Preferences } = ChromeUtils.importESModule("resource://gre/modules/Preferences.sys.mjs");

// W13 F02 (wave12 F02, A and B; the user asked for both): Firefox's
// built-in VPN (it keeps its name, Firefox IP Protection) gets
//  A. a "VPN" control with a status dot in the address bar: one click
//     toggles, the address bar's hover, only the dot changes;
//  B. a row in This Site (Zen's site panel) with a switch and, while on,
//     All spaces | This space; and a green shield badge on the site icon
//     while it's on here.
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
  is(getComputedStyle(siteIcon(), "::before").content, "none", "No badge on the site icon while off");

  // The address bar's hover, and the text never moves.
  const label = el.querySelector(".whimsy-vpn-urlbar-label");
  const at = label.getBoundingClientRect().left;
  InspectorUtils.addPseudoClassLock(el, ":hover");
  const hover = resolved("var(--urlbar-box-hover-bgcolor, color-mix(in srgb, currentColor 9%, transparent))");
  await TestUtils.waitForCondition(() => getComputedStyle(el).backgroundColor == hover, "Hover: the address bar's fill");
  InspectorUtils.removePseudoClassLock(el, ":hover");

  // One real click turns it on.
  const calls = [];
  const start = IPPProxyManager.start;
  const stop = IPPProxyManager.stop;
  IPPProxyManager.start = async () => calls.push("start");
  IPPProxyManager.stop = async () => calls.push("stop");
  try {
    EventUtils.synthesizeMouseAtCenter(el, {});
    await TestUtils.waitForCondition(() => calls.includes("start"), "A click starts Firefox's VPN");

    setStates(IPProtectionStates.READY, IPPProxyStates.ACTIVATING);
    is(el.getAttribute("state"), "connecting", "Connecting");
    is(getComputedStyle(dot()).animationName, "whimsy-vpn-pulse", "…the dot pulses amber");

    setStates(IPProtectionStates.READY, IPPProxyStates.ACTIVE);
    is(el.getAttribute("state"), "on", "On");
    is(getComputedStyle(dot()).backgroundColor, resolved("light-dark(rgb(31, 143, 78), rgb(79, 209, 139))"), "On: the dot is green");
    is(getComputedStyle(dot(), "::after").animationName, "whimsy-vpn-ring", "…sending out one ring");
    is(getComputedStyle(dot(), "::after").animationIterationCount, "1", "…once");
    is(label.getBoundingClientRect().left, at, "The text never moves");
    ok(siteIcon().hasAttribute("whimsy-vpn-on"), "The site icon gets the badge");
    isnot(getComputedStyle(siteIcon(), "::before").content, "none", "…drawn");

    // And off again.
    EventUtils.synthesizeMouseAtCenter(el, {});
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
  ok(section.querySelector(".whimsy-vpn-tile").getAttribute("state") == "on", "A green tile");
  const seg = section.querySelector(".whimsy-vpn-scope-row .whimsy-surface-seg");
  ok(seg?.checkVisibility(), "All spaces | This space while it's on");
  is(seg.querySelector('[data-value="browser"]').getAttribute("aria-checked"), "true", "All spaces picked");

  // A real click on the switch turns it off.
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
  await TestUtils.waitForCondition(() => !section.querySelector("#whimsy-vpn-site-switch").checked, "Off");
  const offDetail = section.querySelector("#whimsy-vpn-site-detail");
  await document.l10n.translateFragment(section);
  is(offDetail.textContent, "Off · hides your location from sites", "Says what it does");
  ok(!section.querySelector(".whimsy-vpn-scope-row"), "No scope while it's off");
  ok(!siteIcon().hasAttribute("whimsy-vpn-on"), "No badge while it's off");

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

add_task(function test_command() {
  const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
  const entry = WhimsyCommands.get("cmd_whimsyVPNToggle");
  ok(entry?.keyId && document.getElementById(entry.keyId), "Turn VPN On or Off has a key Settings can bind");
});
