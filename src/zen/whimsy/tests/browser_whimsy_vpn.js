/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// tierC-vpn: VPN (Firefox's built-in IP Protection). WhimsyVPN only adds a
// command bar toggle and a Settings status card on top of Firefox's own
// toolbar button, panel, sign-in and per-site rules; it never reimplements
// any of that. Whether a Mozilla account happens to be signed in isn't under
// Whimsy's (or this test's) control, so the state-dependent gating is
// exercised against stubbed IPProtectionService/IPPProxyManager state, the
// way Firefox's own IP Protection suites mock auth/proxy failures.

const { WhimsyVPN } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVPN.sys.mjs");
const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
const { IPProtectionService, IPProtectionStates } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/ipprotection/IPProtectionService.sys.mjs"
);
const { IPPProxyManager, IPPProxyStates } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs"
);

function action(l10nId) {
  return globalActions.find(a => a.l10nId == l10nId);
}

// Shadows the "state" getter (on the class prototype) with an own property
// for the duration of a test, and returns a function that removes it again.
function stubState(singleton, state) {
  Object.defineProperty(singleton, "state", { value: state, configurable: true });
  return () => delete singleton.state;
}

add_task(async function test_defaults() {
  ok(Services.prefs.getBoolPref("whimsy.feature.vpn"), "The feature switch is on");
  ok(Services.prefs.getBoolPref("browser.ipProtection.enabled"), "IP Protection is on by default");
  ok(
    Services.prefs.getBoolPref("browser.ipProtection.features.siteInclusions"),
    'Per-site "always use VPN" is on by default, on top of the existing exclusions'
  );
});

add_task(function test_actions_registered() {
  ok(action("whimsy-action-vpn-on"), "Turn VPN On is registered");
  ok(action("whimsy-action-vpn-off"), "Turn VPN Off is registered");
  ok(action("whimsy-action-vpn-setup"), "Set Up VPN is registered");
});

add_task(function test_not_ready_hides_both_actions() {
  const restore = stubState(IPProtectionService, IPProtectionStates.UNAUTHENTICATED);
  try {
    ok(!action("whimsy-action-vpn-on").isAvailable(window), "Not signed in: no Turn On");
    ok(!action("whimsy-action-vpn-off").isAvailable(window), "Not signed in: no Turn Off");
    ok(action("whimsy-action-vpn-setup").isAvailable(window), "Not signed in: Set Up VPN is there instead");
  } finally {
    restore();
  }
});

add_task(function test_ready_shows_turn_on_only() {
  const restoreService = stubState(IPProtectionService, IPProtectionStates.READY);
  const restoreProxy = stubState(IPPProxyManager, IPPProxyStates.NOT_READY);
  try {
    ok(action("whimsy-action-vpn-on").isAvailable(window), "Ready + not connected: Turn On available");
    ok(!action("whimsy-action-vpn-off").isAvailable(window), "Ready + not connected: no Turn Off");
    ok(!action("whimsy-action-vpn-setup").isAvailable(window), "Ready: no Set Up VPN");
  } finally {
    restoreService();
    restoreProxy();
  }
});

add_task(function test_active_shows_turn_off_only() {
  const restoreService = stubState(IPProtectionService, IPProtectionStates.READY);
  const restoreProxy = stubState(IPPProxyManager, IPPProxyStates.ACTIVE);
  try {
    ok(!action("whimsy-action-vpn-on").isAvailable(window), "Connected: no Turn On");
    ok(action("whimsy-action-vpn-off").isAvailable(window), "Connected: Turn Off available");
  } finally {
    restoreService();
    restoreProxy();
  }
});

add_task(async function test_turn_on_calls_proxy_manager() {
  const restoreService = stubState(IPProtectionService, IPProtectionStates.READY);
  const restoreProxy = stubState(IPPProxyManager, IPPProxyStates.NOT_READY);
  const calls = [];
  const originalStart = IPPProxyManager.start;
  IPPProxyManager.start = async () => calls.push("start");
  try {
    await WhimsyVPN.turnOn(window);
    Assert.deepEqual(calls, ["start"], "Turning on calls IPPProxyManager.start()");
  } finally {
    IPPProxyManager.start = originalStart;
    restoreService();
    restoreProxy();
  }
});

add_task(async function test_turn_off_calls_proxy_manager() {
  const restoreService = stubState(IPProtectionService, IPProtectionStates.READY);
  const restoreProxy = stubState(IPPProxyManager, IPPProxyStates.ACTIVE);
  const calls = [];
  const originalStop = IPPProxyManager.stop;
  IPPProxyManager.stop = async () => calls.push("stop");
  try {
    await WhimsyVPN.turnOff(window);
    Assert.deepEqual(calls, ["stop"], "Turning off calls IPPProxyManager.stop()");
  } finally {
    IPPProxyManager.stop = originalStop;
    restoreService();
    restoreProxy();
  }
});

add_task(async function test_feature_switch_off_hides_actions_even_when_ready() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.vpn", false]] });
  const restoreService = stubState(IPProtectionService, IPProtectionStates.READY);
  const restoreProxy = stubState(IPPProxyManager, IPPProxyStates.NOT_READY);
  try {
    ok(!action("whimsy-action-vpn-on").isAvailable(window), "Switch off: hidden even when ready");
  } finally {
    restoreService();
    restoreProxy();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_settings_card() {
  await BrowserTestUtils.withNewTab("about:preferences#privacy", async browser => {
    const doc = browser.contentDocument;
    const checkbox = await TestUtils.waitForCondition(() => doc.getElementById("whimsyVpnEnabled"));
    ok(checkbox.checked, "The toggle reflects browser.ipProtection.enabled (on by default)");
    const status = doc.getElementById("whimsyVpnStatus");
    ok(status && status.textContent, "A status line is shown");

    checkbox.click();
    await TestUtils.waitForCondition(
      () => !Services.prefs.getBoolPref("browser.ipProtection.enabled"),
      "Unchecking the Settings toggle turns off the real Firefox pref"
    );
    checkbox.click();
    await TestUtils.waitForCondition(() => Services.prefs.getBoolPref("browser.ipProtection.enabled"));
  });
});

// fix7 settings: the command bar puts Firefox's VPN button back in the
// toolbar when it isn't there, so there's always a visible control.
add_task(function test_command_bar_shows_the_button() {
  const id = "ipprotection-button";
  const widget = CustomizableUI.getWidget(id);
  if (widget?.provider != CustomizableUI.PROVIDER_API) {
    ok(!WhimsyVPN.showButton(window), "No VPN widget: nothing to show");
    return;
  }
  const placement = CustomizableUI.getPlacementOfWidget(id);
  CustomizableUI.removeWidgetFromArea(id);
  try {
    const button = WhimsyVPN.showButton(window);
    is(CustomizableUI.getPlacementOfWidget(id)?.area, CustomizableUI.AREA_NAVBAR, "The button is back in the toolbar");
    ok(button, "and it's returned to open the panel");
  } finally {
    if (placement) {
      CustomizableUI.addWidgetToArea(id, placement.area, placement.position);
    } else {
      CustomizableUI.removeWidgetFromArea(id);
    }
  }
});
