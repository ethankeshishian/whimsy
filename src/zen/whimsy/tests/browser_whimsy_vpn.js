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

// What IPProtectionService itself sends on a state change: its listeners
// (Firefox's proxy manager among them) read event.detail.
function announceState() {
  const state = IPProtectionService.state;
  IPProtectionService.dispatchEvent(
    new CustomEvent("IPProtectionService:StateChanged", { detail: { state, prevState: state } })
  );
}

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

    // wave9/designfix (M7): one VPN section, one switch. Firefox's group
    // (start automatically, exceptions) sits right under Whimsy's card.
    const firefoxVpn = doc.querySelector('setting-group[groupid="ipprotection"]');
    if (firefoxVpn) {
      is(doc.getElementById("whimsyVpnGroup").nextElementSibling, firefoxVpn, "Firefox's VPN options follow the card");
      ok(
        ![...firefoxVpn.querySelectorAll("moz-toggle, moz-checkbox")].some(el => el.id == "ipProtectionVisible"),
        "Firefox's group has no second on/off switch"
      );
    }
    is(doc.getElementById("whimsyVpnGroup").dataset.subcategory, "vpn", "#privacy-vpn links land on the switch");

    checkbox.click();
    await TestUtils.waitForCondition(
      () => !Services.prefs.getBoolPref("browser.ipProtection.enabled"),
      "Unchecking the Settings toggle turns off the real Firefox pref"
    );
    checkbox.click();
    await TestUtils.waitForCondition(() => Services.prefs.getBoolPref("browser.ipProtection.enabled"));
  });
});

// F02 follow-up: Firefox's own VPN button would duplicate the address bar
// control, so Whimsy takes it out of the default toolbar on init, even
// after Zen's CustomizableUI patch places it there again.
add_task(function test_init_removes_the_toolbar_button() {
  const id = "ipprotection-button";
  const widget = CustomizableUI.getWidget(id);
  is(widget?.provider, CustomizableUI.PROVIDER_API, "Firefox made its VPN widget");
  CustomizableUI.addWidgetToArea(id, CustomizableUI.AREA_NAVBAR);
  try {
    WhimsyVPN.hideButton();
    ok(!CustomizableUI.getPlacementOfWidget(id), "The button is out of the toolbar");
  } finally {
    CustomizableUI.removeWidgetFromArea(id);
  }
});

// fix7 settings: the VPN is Firefox's (a Mozilla service), so Firefox's own
// VPN strings say so instead of "Whimsy's built-in VPN".
add_task(async function test_vpn_is_labelled_as_firefox() {
  const l10n = new Localization(["branding/brand.ftl", "browser/ipProtection.ftl"], true);
  const title = l10n.formatValueSync("unauthenticated-vpn-title");
  ok(title.includes("Firefox"), `The panel names Firefox's VPN: "${title}"`);
  ok(!/whimsy/i.test(title), "not Whimsy's");
});

// W8-41: Set Up VPN in command bar enables master pref, initiates connection if ready,
// or opens panel / alerts user to sign-in requirement.
add_task(async function test_w8_41_setup_vpn() {
  await SpecialPowers.pushPrefEnv({ set: [["browser.ipProtection.enabled", false]] });
  try {
    let toast = null;
    const origToast = window.gZenUIManager?.showToast;
    if (window.gZenUIManager) {
      window.gZenUIManager.showToast = id => {
        toast = id;
      };
    }
    const restoreService = stubState(IPProtectionService, IPProtectionStates.UNAUTHENTICATED);
    // W10-50: the real panel exists now; record the open instead of
    // leaving Firefox's popup open for the next tasks.
    const opened = [];
    const restorePanel = stubPanel({ open: async w => opened.push(w) });
    try {
      await WhimsyVPN.setUp(window);
      ok(Services.prefs.getBoolPref("browser.ipProtection.enabled"), "setUp enables master pref");
      ok(opened.length == 1 && !toast, "Sign-in guidance provided: Firefox's VPN panel opens");
    } finally {
      restorePanel();
      restoreService();
      if (window.gZenUIManager) {
        window.gZenUIManager.showToast = origToast;
      }
    }

    // When ready to connect:
    const restoreReadyService = stubState(IPProtectionService, IPProtectionStates.READY);
    const restoreProxy = stubState(IPPProxyManager, IPPProxyStates.NOT_READY);
    let turnedOn = false;
    const origTurnOn = WhimsyVPN.turnOn;
    WhimsyVPN.turnOn = async () => {
      turnedOn = true;
    };
    try {
      await WhimsyVPN.setUp(window);
      ok(turnedOn, "setUp connects when ready to turn on");
    } finally {
      WhimsyVPN.turnOn = origTurnOn;
      restoreReadyService();
      restoreProxy();
    }
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

// W10-50: Firefox's VPN never started in Whimsy. Zen defines
// app.update.checkInstallTime.days only for official builds, so
// BrowserGlue._checkForOldBuildUpdates() threw and _onFirstWindowLoaded
// stopped before the browser-first-window-ready category, which is what
// starts IPProtectionActivator (and ContentBlockingPrefs, DoHController...).
// The service stayed "uninitialized": no button, no panel, dead buttons.
add_task(function test_w10_50_firefox_vpn_starts() {
  ok(
    Services.prefs.getDefaultBranch("").getIntPref("app.update.checkInstallTime.days", 0) > 0,
    "The update-check age pref Firefox reads at first window is defined"
  );
  ok(
    Cu.isESModuleLoaded("moz-src:///browser/components/ipprotection/IPProtectionHelpers.sys.mjs"),
    "browser-first-window-ready ran: Firefox's VPN activator is loaded"
  );
  ok(
    Cu.isESModuleLoaded("moz-src:///browser/components/protections/ContentBlockingPrefs.sys.mjs"),
    "and so are the other first-window modules (ContentBlockingPrefs)"
  );
  const { IPProtection } = ChromeUtils.importESModule(
    "moz-src:///browser/components/ipprotection/IPProtection.sys.mjs"
  );
  isnot(IPProtectionService.state, IPProtectionStates.UNINITIALIZED, "The VPN service started");
  ok(IPProtection.created, "Firefox made its VPN button");
  ok(IPProtection.getPanel(window), "and the panel the buttons open");
});

function stubToast() {
  const toasts = [];
  const original = window.gZenUIManager.showToast;
  window.gZenUIManager.showToast = id => {
    toasts.push(id);
  };
  return { toasts, restore: () => (window.gZenUIManager.showToast = original) };
}

function stubPanel(panel) {
  const original = Object.getOwnPropertyDescriptor(WhimsyVPN, "getPanel");
  WhimsyVPN.getPanel = () => panel;
  return () => Object.defineProperty(WhimsyVPN, "getPanel", original);
}

// W10-50: Set Up VPN opens Firefox's panel (sign in) and never falls back to
// just opening Settings; without a panel it says why.
add_task(async function test_w10_50_setup_opens_panel_not_settings() {
  const restoreService = stubState(IPProtectionService, IPProtectionStates.UNAUTHENTICATED);
  const opened = [];
  const restorePanel = stubPanel({ open: async w => opened.push(w) });
  const tabs = gBrowser.tabs.length;
  try {
    await WhimsyVPN.setUp(window);
    Assert.deepEqual(opened, [window], "Set Up VPN opens Firefox's VPN panel in this window");
    is(gBrowser.tabs.length, tabs, "and doesn't open Settings");
  } finally {
    restorePanel();
    restoreService();
  }

  const toast = stubToast();
  const restoreNone = stubPanel(null);
  const restoreUnavailable = stubState(IPProtectionService, IPProtectionStates.UNAVAILABLE);
  try {
    await WhimsyVPN.setUp(window);
    Assert.deepEqual(toast.toasts, ["whimsy-vpn-unavailable-toast"], "No panel: a toast says the VPN isn't available");
    is(gBrowser.tabs.length, tabs, "still no Settings tab");
  } finally {
    restoreUnavailable();
    restoreNone();
    toast.restore();
  }
});

// W10-50: a failed "Get started" (here: Guardian answers 451) says why
// instead of silently showing "Get started" again.
add_task(async function test_w10_50_enroll_failure_is_explained() {
  const toast = stubToast();
  try {
    Services.obs.notifyObservers(window, "whimsy-ipprotection-enroll-failed", "region_unavailable");
    Assert.deepEqual(toast.toasts, ["whimsy-vpn-enroll-region"], "Region not served: a clear toast");
    is(WhimsyVPN.lastEnrollError, "region_unavailable", "remembered for Settings");
    is(WhimsyVPN.enrollErrorL10nId("network_error"), "whimsy-vpn-enroll-network", "Network errors read as such");
    is(WhimsyVPN.enrollErrorL10nId("not_entitled"), "whimsy-vpn-enroll-account", "Account errors read as such");
  } finally {
    toast.restore();
  }

  const restoreService = stubState(IPProtectionService, IPProtectionStates.UNAUTHENTICATED);
  try {
    await BrowserTestUtils.withNewTab("about:preferences#privacy", async browser => {
      const doc = browser.contentDocument;
      const status = await TestUtils.waitForCondition(() => doc.getElementById("whimsyVpnStatus"));
      await TestUtils.waitForCondition(
        () => status.getAttribute("data-l10n-id") == "whimsy-vpn-enroll-region",
        "The Settings status line explains the failed sign-up"
      );
    });
  } finally {
    restoreService();
    WhimsyVPN.lastEnrollError = "";
  }
});

// W10-50: "Open VPN panel" and Firefox's "Get started" both work, and
// neither is ever a dead button.
add_task(async function test_w10_50_settings_buttons() {
  await BrowserTestUtils.withNewTab("about:preferences#privacy", async browser => {
    const doc = browser.contentDocument;
    const manage = await TestUtils.waitForCondition(() => doc.getElementById("whimsyVpnManage"));
    const opened = [];
    const restorePanel = stubPanel({ open: async w => opened.push(w) });
    const restoreService = stubState(IPProtectionService, IPProtectionStates.UNAUTHENTICATED);
    try {
      announceState();
      await TestUtils.waitForCondition(() => !manage.disabled, "Signed out: Open VPN panel is enabled");
      manage.doCommand();
      await TestUtils.waitForCondition(() => opened.length == 1, "Open VPN panel opens Firefox's panel");
      is(opened[0], window, "in the browser window");
    } finally {
      restoreService();
      restorePanel();
    }

    const restoreUnavailable = stubState(IPProtectionService, IPProtectionStates.UNAVAILABLE);
    try {
      announceState();
      await TestUtils.waitForCondition(() => manage.disabled, "No panel possible: the button is disabled, not dead");
      is(
        doc.getElementById("whimsyVpnStatus").getAttribute("data-l10n-id"),
        "whimsy-vpn-status-unavailable",
        "and the status line says why"
      );
    } finally {
      restoreUnavailable();
      announceState();
    }

    // Firefox's own "Get started" reaches enroll() on the real panel.
    const getStarted = await TestUtils.waitForCondition(() => {
      const button = doc.getElementById("getStartedButton");
      return button && BrowserTestUtils.isVisible(button) && button;
    }, "Firefox's Get started is shown before signing up");
    {
      const { IPProtection } = ChromeUtils.importESModule(
        "moz-src:///browser/components/ipprotection/IPProtection.sys.mjs"
      );
      const panel = IPProtection.getPanel(window);
      ok(panel, "Get started has a panel to enroll through");
      const calls = [];
      const originalEnroll = panel.enroll;
      panel.enroll = async options => calls.push(options);
      try {
        getStarted.click();
        await TestUtils.waitForCondition(() => calls.length == 1, "Get started starts Firefox's sign-in");
      } finally {
        panel.enroll = originalEnroll;
      }

      // Without a panel, Get started explains instead of doing nothing.
      const toast = stubToast();
      const restoreNone = stubPanel(null);
      try {
        getStarted.click();
        await TestUtils.waitForCondition(() => toast.toasts.length == 1, "Get started without a panel shows why");
      } finally {
        restoreNone();
        toast.restore();
      }
    }
  });
});

// F02 follow-up: Firefox's toolbar button is taken out of the default
// toolbar (test_init_removes_the_toolbar_button), so the address bar
// control and This Site's row (browser_whimsy_vpn_controls.js) are the
// only VPN controls in the window; nothing else offers it.
add_task(function test_vpn_controls_has_no_stray_toolbar_button() {
  ok(!CustomizableUI.getPlacementOfWidget("ipprotection-button"), "Firefox's VPN button is not placed");
  const controls = [...document.querySelectorAll("toolbarbutton, button, menuitem, .subviewbutton")].filter(el => {
    const id = (el.id || "") + " " + (el.getAttribute("data-l10n-id") || "") + " " + (el.getAttribute("command") || "");
    // Anywhere in the window (the toolbar, its overflow, a menu), except
    // inside Firefox's own VPN panel or Whimsy's own controls.
    return /vpn|ipprotection/i.test(id) && !el.closest("[id^='PanelUI-ipprotection'], #whimsy-vpn-site-section, #whimsy-vpn-urlbar");
  });
  Assert.deepEqual(controls.map(el => el.id), [], "No stray VPN control outside Whimsy's own");
});
