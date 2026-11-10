/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { Preferences } = ChromeUtils.importESModule("resource://gre/modules/Preferences.sys.mjs");

// W13 F02 (wave12 F02, A and B; the user asked for both): Firefox's
// built-in VPN (it keeps its name, Firefox IP Protection) gets
//  A. a "VPN" control with a status dot in the address bar: one click on
//     it toggles, the address bar's hover, only the dot changes; W14 3c: a
//     chevron after a hairline opens Firefox's own panel, anchored to it;
//  B. a scope choice after Firefox's status card, available while off;
//     nothing in the site panel. W14 3a/3b: no shield anywhere (no tile, no badge on
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
  // W16-23: the control hides until the sidebar is hovered (unless the VPN
  // is on); these tasks reach it as a person does, with the sidebar
  // hovered. test_hides_until_hover_unless_on checks the hiding.
  const hoverWas = gNavToolbox.getAttribute("zen-has-implicit-hover");
  gNavToolbox.setAttribute("zen-has-implicit-hover", "true");
  // Zen drops the attribute when the pointer leaves the toolbox (a click
  // elsewhere): put it back, except while a task checks the hiding.
  const keepHovered = new MutationObserver(() => {
    if (!window.whimsyTestUnhover && gNavToolbox.getAttribute("zen-has-implicit-hover") != "true") {
      gNavToolbox.setAttribute("zen-has-implicit-hover", "true");
    }
  });
  keepHovered.observe(gNavToolbox, { attributes: true, attributeFilter: ["zen-has-implicit-hover"] });
  registerCleanupFunction(() => {
    keepHovered.disconnect();
    if (hoverWas) {
      gNavToolbox.setAttribute("zen-has-implicit-hover", hoverWas);
    } else {
      gNavToolbox.removeAttribute("zen-has-implicit-hover");
    }
  });
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

// The site panel no longer carries a VPN item.
add_task(async function test_site_panel_has_no_vpn() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  setStates(IPProtectionStates.READY, IPPProxyStates.ACTIVE);
  const site = document.getElementById("zen-unified-site-data-panel");
  const shown = BrowserTestUtils.waitForPopupEvent(site, "shown");
  EventUtils.synthesizeMouseAtCenter(siteIcon(), {});
  await shown;
  ok(!site.querySelector("[id*='whimsy-vpn']"), "No VPN item in the site panel");
  ok(!site.querySelector("[data-l10n-id^='whimsy-vpn']"), "…no VPN text either");
  const hidden = BrowserTestUtils.waitForPopupEvent(site, "hidden");
  site.hidePopup();
  await hidden;

  setStates(IPProtectionStates.READY, IPPProxyStates.NOT_READY);
  BrowserTestUtils.removeTab(tab);
});

async function openVpnPanel() {
  ok(await WhimsyVPN.openPanel(window), "Firefox's panel opens");
  const popup = WhimsyVPN.getPanel(window).panel;
  if (popup.state != "open") {
    await BrowserTestUtils.waitForPopupEvent(popup, "shown");
  }
  return popup;
}

async function closeVpnPanel(popup) {
  if (popup.state == "closed") {
    return;
  }
  const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  popup.hidePopup();
  await hidden;
}

add_task(async function test_panel_section() {
  const { WhimsyVPNScope } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVPNScope.sys.mjs");
  await SpecialPowers.pushPrefEnv({ set: [
    ["browser.ipProtection.features.siteInclusions", true],
    [WhimsyVPNScope.FEATURE, true],
    [WhimsyVPNScope.PREF, ""],
  ] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  let popup;
  try {
    WhimsyVPN.endHold();
    setStates(IPProtectionStates.READY, IPPProxyStates.NOT_READY);
    popup = await openVpnPanel();
    const sections = () => document.querySelectorAll("#whimsy-vpn-panel-section");
    is(sections().length, 1, "The panel has one scope section");
    const section = sections()[0];
    const content = popup.querySelector("ipprotection-content");
    is(section.parentElement, content, "Scope is a light-DOM child of native content");
    is(section.slot, "whimsy-after-status", "Scope uses the slot after the status card");
    ok(section.checkVisibility(), "Scope shows while the VPN is off");
    ok(!document.getElementById("whimsy-vpn-panel-switch"), "No duplicate on/off switch");
    await content.updateComplete;
    const slot = content.shadowRoot.querySelector('slot[name="whimsy-after-status"]');
    ok(slot, "The status-card branch exposes the scope slot");
    ok(slot.assignedElements().includes(section), "The scope section is assigned to it");
    const card = slot.previousElementSibling;
    const rules = content.shadowRoot.querySelector(".vpn-bottom-content").querySelector("moz-button, a, button");
    ok(card && rules, "Native status card and rules action are present");
    const scopeRow = section.querySelector(".whimsy-vpn-scope-row");
    const seg = scopeRow.querySelector(".whimsy-surface-seg");
    await document.l10n.translateFragment(section);
    is(section.querySelector("#whimsy-vpn-scope-heading").textContent, "Use VPN in", "Scope has its caption");
    ok(!scopeRow.inert && seg.checkVisibility(), "Scope can be used before connecting");
    const rect = seg.getBoundingClientRect();
    Assert.greater(rect.top, card.getBoundingClientRect().bottom, "Scope sits below the status card");
    Assert.less(rect.top, rules.getBoundingClientRect().top, "Scope sits above Manage VPN rules");
    is(seg.querySelector('[data-value="browser"]').getAttribute("aria-checked"), "true", "All spaces picked");
    Assert.greaterOrEqual(rect.width, section.getBoundingClientRect().width - 40, "Scope spans the section");

    const profileId = WhimsyVPNScope.profileForWindow(window);
    isnot(profileId, null, "There is an active space profile");
    const profile = WhimsyVPNScope.profileName(profileId);
    const spaceButton = seg.querySelector('[data-value="space"]');
    is(spaceButton.textContent, "All spaces in " + profile, "The choice names the profile");
    is(spaceButton.title, "All spaces in " + profile, "The tooltip has the full name");
    ok(!spaceButton.disabled, "The choice is enabled while off");
    EventUtils.synthesizeMouseAtCenter(spaceButton, {});
    await TestUtils.waitForCondition(() => spaceButton.getAttribute("aria-checked") == "true", "Profile picked while off");
    is(Services.prefs.getStringPref(WhimsyVPNScope.PREF), String(profileId), "The profile ID is saved before connecting");
    is(IPPProxyManager.state, IPPProxyStates.NOT_READY, "Choosing scope leaves the VPN off");
    const detail = section.querySelector("#whimsy-vpn-panel-detail");
    ok(detail.hidden, "No elsewhere message while off");

    // Other chosen profiles: neither segment is selected, and the native
    // card's global on state is qualified by the local coverage message.
    const otherId = profileId == 0 ? 1 : 0;
    Services.prefs.setStringPref(WhimsyVPNScope.PREF, String(otherId));
    setStates(IPProtectionStates.READY, IPPProxyStates.ACTIVE);
    await document.l10n.translateFragment(section);
    ok(detail.checkVisibility(), "The elsewhere line shows outside the selected profiles");
    is(detail.textContent, "Off in this space · on in others", "The line explains local coverage");
    ok([...seg.querySelectorAll("[data-value]")].every(el => el.getAttribute("aria-checked") != "true"), "Nothing selected for an uncovered profile");
    EventUtils.synthesizeMouseAtCenter(spaceButton, {});
    await TestUtils.waitForCondition(() => spaceButton.getAttribute("aria-checked") == "true", "Pick this profile from elsewhere");
    is(Services.prefs.getStringPref(WhimsyVPNScope.PREF), otherId + "," + profileId, "The existing profile stays and this one is added");
    ok(detail.hidden, "The elsewhere line hides when this profile is covered");
    EventUtils.synthesizeMouseAtCenter(seg.querySelector('[data-value="browser"]'), {});
    await TestUtils.waitForCondition(() => Services.prefs.getStringPref(WhimsyVPNScope.PREF) == "", "All spaces clears the restriction");

    // Lit re-renders keep the slotted section and its controls intact.
    content.requestUpdate();
    await content.updateComplete;
    is(sections()[0], section, "The same section survives native re-rendering");
    is(section.querySelector(".whimsy-surface-seg"), seg, "The same segmented control survives");
    is(section.assignedSlot, slot, "The section remains in its slot");
    await closeVpnPanel(popup);
    popup = await openVpnPanel();
    is(sections().length, 1, "Reopening gives exactly one section");

    await closeVpnPanel(popup);
    await SpecialPowers.pushPrefEnv({ set: [["browser.ipProtection.features.siteInclusions", false]] });
    try {
      popup = await openVpnPanel();
      const defaultContent = popup.querySelector("ipprotection-content");
      await defaultContent.updateComplete;
      const defaultSection = document.getElementById("whimsy-vpn-panel-section");
      is(defaultSection.assignedSlot?.name, "whimsy-after-status", "The default branch also projects scope after status");
      ok(defaultSection.checkVisibility(), "Scope is visible without site inclusions too");
    } finally {
      await closeVpnPanel(popup);
      await SpecialPowers.popPrefEnv();
    }
  } finally {
    if (popup) {
      await closeVpnPanel(popup);
    }
    setStates(IPProtectionStates.READY, IPPProxyStates.NOT_READY);
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_panel_shared_inset_and_spacing() {
  const { WhimsyVPNScope } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVPNScope.sys.mjs");
  await SpecialPowers.pushPrefEnv({ set: [
    ["browser.ipProtection.features.siteInclusions", false],
    [WhimsyVPNScope.FEATURE, true],
    [WhimsyVPNScope.PREF, ""],
  ] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  let popup;
  try {
    WhimsyVPN.endHold();
    setStates(IPProtectionStates.READY, IPPProxyStates.NOT_READY);
    await whimsyBothSchemes("w24-uifix2-vpn-panel", async () => {
      popup = await openVpnPanel();
      const content = popup.querySelector("ipprotection-content");
      await content.updateComplete;
      const root = content.shadowRoot;
      const card = root.querySelector("ipprotection-status-card");
      const settings = root.querySelector("#vpn-settings-button");
      await Promise.all([card.updateComplete, settings.updateComplete]);
      await document.l10n.translateFragment(content);
      const group = content.querySelector(".whimsy-vpn-panel-group");
      const view = document.getElementById("PanelUI-ipprotection");
      ok(card.checkVisibility() && group.checkVisibility() && settings.checkVisibility(),
        "All three sections are visible in the open panel");
      const cardRect = card.getBoundingClientRect();
      const groupRect = group.getBoundingClientRect();
      const settingsRect = settings.getBoundingClientRect();
      is(groupRect.left, cardRect.left, "Scope group shares the status card's left inset");
      is(settingsRect.left, cardRect.left, "Settings shares the status card's left inset");
      const gap = groupRect.top - cardRect.bottom;
      Assert.greater(gap, 0, "Sections have a visible gap");
      is(settingsRect.top - groupRect.bottom, gap, "Both section gaps are equal");
      is(view.getBoundingClientRect().bottom - settingsRect.bottom, gap,
        "Bottom padding equals the section gap");

      const removeStandIn = whimsyStandInPopups();
      return async () => {
        removeStandIn();
        await closeVpnPanel(popup);
      };
    });
  } finally {
    if (popup) {
      await closeVpnPanel(popup);
    }
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});

// A long profile name has room: it wraps before anything is cut off, and
// the tooltip carries the full name.
add_task(async function test_panel_section_long_profile_name() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  setStates(IPProtectionStates.READY, IPPProxyStates.ACTIVE);
  const { WhimsyVPNScope } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVPNScope.sys.mjs");
  const longName = "Work and personal banking profile";
  const original = WhimsyVPNScope.profileName;
  WhimsyVPNScope.profileName = () => longName;
  try {
    const popup = await openVpnPanel();
    WhimsyVPN.updateUi(window);
    const spaceButton = document.querySelector('#whimsy-vpn-panel-section [data-value="space"]');
    await document.l10n.translateFragment(spaceButton.closest(".whimsy-surface-seg"));
    is(spaceButton.title, `All spaces in ${longName}`, "The tooltip is the full label");
    ok(spaceButton.scrollWidth <= spaceButton.clientWidth && spaceButton.scrollHeight <= spaceButton.clientHeight + 1,
      "A long name is not cut off");
    await closeVpnPanel(popup);
  } finally {
    WhimsyVPNScope.profileName = original;
  }
  setStates(IPProtectionStates.READY, IPPProxyStates.NOT_READY);
  BrowserTestUtils.removeTab(tab);
});

// The section hides where there is no VPN to control.
add_task(async function test_panel_section_hides() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  setStates(IPProtectionStates.READY, IPPProxyStates.ACTIVE);
  const popup = await openVpnPanel();
  ok(document.getElementById("whimsy-vpn-panel-section"), "The section is in the panel");
  await SpecialPowers.pushPrefEnv({ set: [["browser.ipProtection.enabled", false]] });
  WhimsyVPN.updateUi(window);
  WhimsyVPN.renderPanelSection(window);
  ok(!document.getElementById("whimsy-vpn-panel-section"), "Gone where the VPN is switched off");
  await SpecialPowers.popPrefEnv();
  await closeVpnPanel(popup);
  setStates(IPProtectionStates.READY, IPPProxyStates.NOT_READY);
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
  ok(panel?.keyId && document.getElementById(panel.keyId), "Open VPN Location and Rules has a key Settings can bind");
  // W16-10: the command and the chevron use one name.
  const l10n = new Localization(["browser/whimsy.ftl"], true);
  const commandName = l10n.formatValueSync("whimsy-action-vpn-panel");
  const [chevronMessage] = l10n.formatMessagesSync([{ id: "whimsy-vpn-urlbar-panel" }]);
  const tooltip = chevronMessage.attributes.find(a => a.name == "tooltiptext").value;
  ok(commandName.includes(tooltip), `The command ("${commandName}") says what the chevron does ("${tooltip}")`);
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
    // W16-4: the detail fits on the toast's one cropped line.
    const detail = toast.element.querySelector(".description");
    ok(detail?.textContent, "The toast has its detail line");
    Assert.lessOrEqual(detail.scrollWidth, detail.clientWidth, "…and it isn't cut off");
    const pause = toast.element.querySelector("#whimsy-vpn-call-pause");
    ok(pause?.checkVisibility(), "…with Pause VPN");
    ok(toast.element.querySelector("#whimsy-vpn-call-keep")?.checkVisibility(), "…and Keep On");
    ok(WhimsyVPN.canPauseForCall(window), "Pause VPN for This Call is offered in the command bar");

    const reloaded = BrowserTestUtils.browserLoaded(browser);
    EventUtils.synthesizeMouseAtCenter(pause, {});
    await reloaded;
    is(rule()?.capability, Ci.nsIPermissionManager.DENY_ACTION, "The site gets a don't-use-the-VPN rule");
    is(rule()?.expireType, Ci.nsIPermissionManager.EXPIRE_SESSION, "…for this session only");
    is(control().getAttribute("state"), "paused", "The call's tab shows the paused VPN state");
    is(getComputedStyle(dot()).backgroundColor, resolved("var(--whimsy-vpn-paused)"), "Paused: the dot is orange");
    isnot(getComputedStyle(dot()).backgroundColor, resolved("var(--whimsy-vpn-on)"), "Paused is distinct from connected green");
    await document.l10n.translateFragment(control());
    is(main().getAttribute("aria-label"), "VPN is paused", "The paused state is accessible");
    const popup = await openVpnPanel();
    try {
      const section = document.getElementById("whimsy-vpn-panel-section");
      const detail = section.querySelector("#whimsy-vpn-panel-detail");
      await document.l10n.translateFragment(section);
      ok(!detail.hidden && detail.checkVisibility(), "The panel shows the paused message");
      is(detail.textContent, "VPN is paused", "The panel explains the pause");
      is(getComputedStyle(detail).color, resolved("var(--whimsy-vpn-paused)"), "The paused message is orange");
    } finally {
      await closeVpnPanel(popup);
    }
    const otherTab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
    try {
      is(control().getAttribute("state"), "on", "Other tabs still show their connected state");
    } finally {
      BrowserTestUtils.removeTab(otherTab);
    }
    is(control().getAttribute("state"), "paused", "Returning to the call restores the paused state");
    ok(!WhimsyVPN.callBlocked(browser), "The reloaded page's call connects directly");
    await startCall();
    await settle(300);
    ok(!callToast(), "No second ask for the call itself");

    // The call: media starts on the reloaded page, then stops.
    gBrowser.updateBrowserSharing(browser, { webRTC: { sharing: "camera" } });
    ok(rule(), "The rule stays during the call");
    gBrowser.updateBrowserSharing(browser, { webRTC: null });
    ok(!rule(), "The call ends: the rule is gone, the VPN is back for the site");
    is(control().getAttribute("state"), "on", "The call ends: the control shows connected again");
    is(getComputedStyle(dot()).backgroundColor, resolved("var(--whimsy-vpn-on)"), "The connected dot is green again");

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

// W16-23: like Zen's address bar buttons, the VPN control hides until the
// sidebar is hovered, unless the VPN is on or turning on; an active Reader
// button stays too.
add_task(async function test_hides_until_hover_unless_on() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const toolbox = gNavToolbox;
  const hovered = toolbox.getAttribute("zen-has-implicit-hover");
  window.whimsyTestUnhover = true;
  toolbox.removeAttribute("zen-has-implicit-hover");
  const singleToolbar = document.documentElement.getAttribute("zen-single-toolbar");
  document.documentElement.setAttribute("zen-single-toolbar", "true");
  const shown = el => {
    const style = getComputedStyle(el);
    return style.visibility == "visible" && style.opacity == "1";
  };
  try {
    for (const [service, proxy, state, visible] of [
      [IPProtectionStates.READY, IPPProxyStates.NOT_READY, "off", false],
      [IPProtectionStates.UNAUTHENTICATED, IPPProxyStates.NOT_READY, "setup", false],
      [IPProtectionStates.READY, IPPProxyStates.ACTIVATING, "connecting", true],
      [IPProtectionStates.READY, IPPProxyStates.ACTIVE, "on", true],
    ]) {
      setStates(service, proxy);
      await TestUtils.waitForCondition(() => control().getAttribute("state") == state, `VPN ${state}`);
      await TestUtils.waitForCondition(() => shown(control()) == visible, `VPN ${state}, not hovering: ${visible ? "shown" : "hidden"}`);
      ok(true, `VPN ${state}, not hovering: ${visible ? "shown" : "hidden"}`);
    }
    setStates(IPProtectionStates.READY, IPPProxyStates.NOT_READY);
    toolbox.setAttribute("zen-has-implicit-hover", "true");
    await TestUtils.waitForCondition(() => shown(control()), "Hovering the sidebar shows it while off");
    toolbox.removeAttribute("zen-has-implicit-hover");
    await TestUtils.waitForCondition(() => !shown(control()), "…and it goes again");

    const reader = document.getElementById("reader-mode-button");
    ok(reader, "Firefox's Reader button is in the address bar");
    if (reader) {
      const wasHidden = reader.hidden;
      reader.hidden = false;
      await TestUtils.waitForCondition(() => !shown(reader), "Reader, inactive: hidden until hover");
      ok(!shown(reader), "Reader, inactive, not hovering: hidden");
      reader.setAttribute("readeractive", "true");
      await TestUtils.waitForCondition(() => shown(reader), "Reader, active: stays");
      ok(shown(reader), "Reader, active, not hovering: shown");
      reader.removeAttribute("readeractive");
      reader.hidden = wasHidden;
    }
  } finally {
    delete window.whimsyTestUnhover;
    if (singleToolbar === null) {
      document.documentElement.removeAttribute("zen-single-toolbar");
    } else {
      document.documentElement.setAttribute("zen-single-toolbar", singleToolbar);
    }
    toolbox.setAttribute("zen-has-implicit-hover", hovered || "true");
    setStates(IPProtectionStates.READY, IPPProxyStates.NOT_READY);
    BrowserTestUtils.removeTab(tab);
  }
});
