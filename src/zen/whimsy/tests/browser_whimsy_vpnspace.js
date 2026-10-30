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
const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");

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
    const spaces = { gZenWorkspaces: { getWorkspaces: () => [
      { name: "Work", containerTabId: 4 }, { name: "Home", containerTabId: 5 },
      { name: "Other", containerTabId: 6 },
    ] } };
    Assert.deepEqual(WhimsyVPNScope.coveredSpaces(spaces), ["Work", "Home"], "Popover lists covered spaces");
    WhimsyVPNScope.setScope(win, "space");
    is(WhimsyVPNScope.ids, "5", "Turning first off preserves second");
    is(WhimsyVPNScope.buttonState(win), "elsewhere", "First now off");
    is(WhimsyVPNScope.buttonState(scopeWindow(5)), "space", "Second stays on");
    WhimsyVPNScope.setScope(scopeWindow(5), "space");
    is(WhimsyVPNScope.buttonState(scopeWindow(5)), "elsewhere", "Last removal does not enable all spaces");
    WhimsyVPNScope.setScope(win, "space");
    for (const id of [0, undefined, -1, "bad"]) {
      ok(!WhimsyVPNScope.setScope(scopeWindow(id), "space"), "No valid default container: unavailable");
      is(Services.prefs.getStringPref(WhimsyVPNScope.PREF), "4", "No accidental expansion to all containers");
    }
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
    ok(filter.shouldProxy(channel(5)), "Comma list supports several containers");
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

add_task(async function native_panel_scope_controls() {
  await SpecialPowers.pushPrefEnv({ set: [
    [WhimsyVPNScope.FEATURE, true], ["whimsy.feature.vpn", true],
    ["browser.ipProtection.enabled", true], [WhimsyVPNScope.PREF, ""],
  ] });
  let panel;
  try {
    const button = await TestUtils.waitForCondition(() => document.getElementById("ipprotection-button"));
    button.click();
    const group = await TestUtils.waitForCondition(() => document.getElementById("whimsy-vpn-scope"));
    panel = group.closest("panel");
    ok(document.querySelector("ipprotection-content"), "Native VPN content retained");
    is(document.querySelectorAll("#ipprotection-button").length, 1, "One VPN button");
    const space = group.querySelector('[value="space"]');
    const container = WhimsyVPNScope.containerForWindow(window);
    is(space.disabled, !container, "No default container disables space choice");
    if (container) {
      space.click();
      is(Services.prefs.getStringPref(WhimsyVPNScope.PREF), String(container), "Radio selects current container");
    } else {
      is(group.querySelector("p").getAttribute("data-l10n-id"), "whimsy-vpn-scope-no-container", "Explains how to assign a container");
    }
    group.querySelector('[value="browser"]').click();
    is(Services.prefs.getStringPref(WhimsyVPNScope.PREF), "", "Browser radio clears restriction");
    Services.prefs.setBoolPref(WhimsyVPNScope.FEATURE, false);
    ok(!document.getElementById("whimsy-vpn-scope"), "Feature off removes extension immediately");
    ok(!document.getElementById("whimsy-vpn-scope-badge"), "Feature off restores native button");
  } finally {
    panel?.hidePopup();
    await SpecialPowers.popPrefEnv();
  }
});
