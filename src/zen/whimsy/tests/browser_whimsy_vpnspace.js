/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */
"use strict";

const { WhimsyVPNScope } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyVPNScope.sys.mjs"
);
const { IPPChannelFilter } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/ipprotection/IPPChannelFilter.sys.mjs"
);
const { IPPSiteRuleManager, IPPPrincipalRules } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/ipprotection/IPPSiteRuleManager.sys.mjs"
);
const { IPPProxyManager, IPPProxyStates } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs"
);

function scopeWindow(containerId, tabId = containerId) {
  return {
    gZenWorkspaces: { getActiveWorkspace: () => ({ containerTabId: containerId }) },
    gBrowser: { selectedBrowser: { getAttribute: () => String(tabId) } },
  };
}

add_task(async function scope_selection_and_button() {
  await SpecialPowers.pushPrefEnv({ set: [
    [WhimsyVPNScope.PREF, ""], [WhimsyVPNScope.FEATURE, true],
    ["whimsy.feature.vpn", true], ["browser.ipProtection.enabled", true],
  ] });
  const original = Object.getOwnPropertyDescriptor(IPPProxyManager, "state");
  Object.defineProperty(IPPProxyManager, "state", {
    configurable: true, value: IPPProxyStates.ACTIVE,
  });
  try {
    const win = scopeWindow(4);
    is(WhimsyVPNScope.buttonState(win), "browser", "Empty restriction is browser scope");
    ok(WhimsyVPNScope.setScope(win, "space"), "Choose the active space");
    is(Services.prefs.getStringPref(WhimsyVPNScope.PREF), "4", "Container saved");
    is(WhimsyVPNScope.buttonState(win), "space", "Button shows space scope");
    is(WhimsyVPNScope.buttonState(scopeWindow(5)), "elsewhere", "Other space is not covered");
    is(WhimsyVPNScope.buttonState(scopeWindow(4, 0)), "space", "Button follows current space");
    is(WhimsyVPNScope.buttonState(scopeWindow(5, 4)), "elsewhere", "Button follows current space rather than selected tab");
    is(Services.prefs.getStringPref(WhimsyVPNScope.PREF), "4", "Viewing another space never retargets policy");
    ok(WhimsyVPNScope.setScope(scopeWindow(5), "space"), "Add second space");
    is(WhimsyVPNScope.ids, "4,5", "Two spaces enabled together");
    is(WhimsyVPNScope.buttonState(win), "space", "First remains covered");
    is(WhimsyVPNScope.buttonState(scopeWindow(5)), "space", "Second covered");
    // W14 3c/3d: picking "All spaces in <profile>" again changes nothing
    // (it used to take the space out, and could write "none").
    ok(WhimsyVPNScope.setScope(win, "space"), "Pick the first again");
    is(WhimsyVPNScope.ids, "4,5", "…nothing changes");
    is(WhimsyVPNScope.scopeChoice(win), "space", "This Site shows All spaces in its profile");
    is(WhimsyVPNScope.scopeChoice(scopeWindow(6)), null, "…and nothing picked where it's off");
    Services.prefs.setStringPref(WhimsyVPNScope.PREF, "0x4,4e0,+4");
    is(WhimsyVPNScope.buttonState(win), "elsewhere", "Nondecimal tokens cannot advertise protection");
    Services.prefs.setStringPref(WhimsyVPNScope.PREF, "4");
    // A space on the Default profile (no container) works too: its
    // channels carry userContextId 0.
    for (const id of [0, undefined, "bad"]) {
      is(WhimsyVPNScope.profileForWindow(scopeWindow(id)), 0, `A space with containerTabId ${id} is on the Default profile`);
    }
    is(WhimsyVPNScope.buttonState(scopeWindow(0)), "elsewhere", "Default not covered yet");
    ok(WhimsyVPNScope.setScope(scopeWindow(undefined), "space"), "Pick All spaces in Default");
    is(Services.prefs.getStringPref(WhimsyVPNScope.PREF), "4,0", "Default saved as 0");
    is(WhimsyVPNScope.buttonState(scopeWindow(0)), "space", "Default covered");
    is(WhimsyVPNScope.profileName(0), "Default", "Named Default");
    const noSpace = { gZenWorkspaces: { getActiveWorkspace: () => null } };
    ok(!WhimsyVPNScope.setScope(noSpace, "space"), "No space in front: nothing to pick");
    is(Services.prefs.getStringPref(WhimsyVPNScope.PREF), "4,0", "No accidental change");
    ok(WhimsyVPNScope.setScope(win, "browser"), "Choose whole browser");
    is(Services.prefs.getStringPref(WhimsyVPNScope.PREF), "", "Empty means all containers");
    Services.prefs.setBoolPref(WhimsyVPNScope.FEATURE, false);
    ok(!WhimsyVPNScope.setScope(win, "space"), "Feature off rejects scope changes");
    is(WhimsyVPNScope.buttonState(win), "browser", "Feature off leaves native behavior");
    Object.defineProperty(IPPProxyManager, "state", { configurable: true, value: IPPProxyStates.NOT_READY });
    is(WhimsyVPNScope.buttonState(win), "off", "Disconnected button state");
  } finally {
    if (original) {
      Object.defineProperty(IPPProxyManager, "state", original);
    } else {
      delete IPPProxyManager.state;
    }
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function channel_boundary_precedes_site_rules() {
  await SpecialPowers.pushPrefEnv({ set: [
    [WhimsyVPNScope.PREF, "4"], [WhimsyVPNScope.FEATURE, true],
    ["whimsy.feature.vpn", true], ["browser.ipProtection.mode", 0],
  ] });
  const original = IPPSiteRuleManager.getRule;
  let rule = IPPPrincipalRules.INCLUDED;
  IPPSiteRuleManager.getRule = () => rule;
  const filter = IPPChannelFilter.create();
  filter.proxyInfo = {}; // Exercise shouldProxy/applyFilter directly, without service/network.
  function channel(id, privateBrowsingId = 0) {
    const uri = Services.io.newURI("https://example.com/");
    const principal = Services.scriptSecurityManager.createContentPrincipal(uri, {
      userContextId: id, privateBrowsingId,
    });
    return NetUtil.newChannel({ uri, loadingPrincipal: principal,
      securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
      contentPolicyType: Ci.nsIContentPolicy.TYPE_OTHER });
  }
  try {
    ok(filter.shouldProxy(channel(4)), "Chosen container included");
    ok(filter.shouldProxy(channel(4, 1)), "Same container in a private window follows policy");
    ok(!filter.shouldProxy(channel(5)), "Site inclusion cannot override container boundary");
    ok(!filter.shouldProxy(channel(0)), "Default container excluded");
    ok(!filter.shouldProxy({ loadInfo: {} }), "Missing origin attributes excluded");
    const fallback = {};
    let result;
    filter.applyFilter(channel(5), fallback, { onProxyFilterResult: value => { result = value; } });
    is(result, fallback, "Unselected container keeps its original proxy routing");
    filter.applyFilter(channel(4), fallback, { onProxyFilterResult: value => { result = value; } });
    is(result, filter.proxyInfo, "Selected channel takes IP Protection proxy");
    rule = IPPPrincipalRules.EXCLUDED;
    ok(!filter.shouldProxy(channel(4)), "Site exclusions still apply within selected container");
    rule = IPPPrincipalRules.INCLUDED;
    Services.prefs.setStringPref(WhimsyVPNScope.PREF, "4, 5");
    ok(filter.shouldProxy(channel(4)), "First container remains protected with two spaces on");
    ok(filter.shouldProxy(channel(5)), "Comma list supports several containers");
    Services.prefs.setStringPref(WhimsyVPNScope.PREF, "0");
    ok(filter.shouldProxy(channel(0)), "The Default profile can be chosen on its own");
    ok(!filter.shouldProxy(channel(4)), "…without the other profiles");
    WhimsyVPNScope.setScope(scopeWindow(4), "browser");
    ok(filter.shouldProxy(channel(4)), "All spaces restores first container");
    ok(filter.shouldProxy(channel(5)), "All spaces restores second container");
    Services.prefs.setStringPref(WhimsyVPNScope.PREF, "0x4,4e0,+4");
    ok(!filter.shouldProxy(channel(4)), "Nondecimal tokens match neither UI nor channel coverage");
    Services.prefs.setStringPref(WhimsyVPNScope.PREF, "broken, , 4x");
    ok(!filter.shouldProxy(channel(0)), "Malformed nonempty list never expands to all containers");
    Services.prefs.setStringPref(WhimsyVPNScope.PREF, "");
    ok(filter.shouldProxy(channel(0)), "Empty restriction restores whole browser");
    Services.prefs.setStringPref(WhimsyVPNScope.PREF, "4");
    Services.prefs.setBoolPref(WhimsyVPNScope.FEATURE, false);
    ok(filter.shouldProxy(channel(5)), "Scope feature off restores native filter");
    Services.prefs.setBoolPref(WhimsyVPNScope.FEATURE, true);
    Services.prefs.setBoolPref("whimsy.feature.vpn", false);
    ok(filter.shouldProxy(channel(5)), "VPN wrapper off restores native filter");
  } finally {
    IPPSiteRuleManager.getRule = original;
    await SpecialPowers.popPrefEnv();
  }
});

// W14 3c: This Site's row is the one scope control; Firefox's panel gets
// no Protect radios of Whimsy's.
add_task(async function native_panel_has_no_scope_radios() {
  const { WhimsyVPN } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVPN.sys.mjs");
  await SpecialPowers.pushPrefEnv({ set: [
    [WhimsyVPNScope.FEATURE, true], ["whimsy.feature.vpn", true],
    ["browser.ipProtection.enabled", true], [WhimsyVPNScope.PREF, ""],
  ] });
  let panel;
  try {
    ok(!document.getElementById("ipprotection-button"), "Firefox's VPN button is not in the toolbar");
    ok(await WhimsyVPN.openPanel(window), "Firefox's panel opens");
    panel = WhimsyVPN.getPanel(window).panel;
    if (panel.state != "open") {
      await BrowserTestUtils.waitForPopupEvent(panel, "shown");
    }
    ok(document.querySelector("ipprotection-content"), "Native VPN content retained");
    ok(!document.getElementById("whimsy-vpn-scope"), "No Protect radios in Firefox's panel");
    ok(!panel.querySelector('input[name="whimsy-vpn-scope"]'), "…none at all");
  } finally {
    panel?.hidePopup();
    await SpecialPowers.popPrefEnv();
  }
});
