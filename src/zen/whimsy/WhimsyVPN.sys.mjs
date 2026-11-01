/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// tierC-vpn: VPN. Firefox already ships a free, built-in VPN — "IP
// Protection" (toolkit/browser/components/ipprotection): sign in with a
// Mozilla account, a 50 GB/month cap (browser.ipProtection.bandwidth.maxInGb),
// a toolbar button + panel with a location picker and bandwidth usage, and
// per-site rules (exclude a site, or — with
// browser.ipProtection.features.siteInclusions — always use the VPN on a
// site, layered on the exclusions). It ships off (browser.ipProtection.enabled
// = false) and with site inclusions off; Whimsy turns both on by default
// (prefs/whimsy/whimsy.yaml) and adds a command bar "Turn VPN On/Off" and a
// Settings → Privacy card with live status and a "manage" shortcut to
// Firefox's own panel. This is NOT a VPN Whimsy built: the service, sign-in,
// proxy, quota and per-site rules are entirely Firefox's
// (engine/toolkit/components/ipprotection, engine/browser/components/ipprotection).
//
// Original flow: sign in (Mozilla account) -> click the toolbar button to
// connect -> check the quota/location in the panel -> exclude (or, with
// inclusions on, "always use") specific sites. See
// https://support.mozilla.org/en-US/kb/built-in-vpn.
//
// vpnspace: Container scoping extends the native control in WhimsyVPNScope;
// the channel boundary is implemented by the Whimsy IPPChannelFilter patch.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyVPNScope: "resource:///modules/whimsy/WhimsyVPNScope.sys.mjs",
  CustomizableUI: "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  IPProtection:
    "moz-src:///browser/components/ipprotection/IPProtection.sys.mjs",
  IPProtectionService:
    "moz-src:///toolkit/components/ipprotection/IPProtectionService.sys.mjs",
  IPProtectionStates:
    "moz-src:///toolkit/components/ipprotection/IPProtectionService.sys.mjs",
  IPPProxyManager:
    "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs",
  IPPProxyStates:
    "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.vpn";
// Firefox's own master switch (also gates the toolbar button/panel and the
// backend service). Whimsy defaults it to true; this is the real on/off.
const MASTER_PREF = "browser.ipProtection.enabled";
const ICON = "chrome://browser/skin/zen-icons/selectable/lock-closed.svg";
const WIDGET_ID = "ipprotection-button";

export const WhimsyVPN = {
  FEATURE_PREF,
  MASTER_PREF,

  // Whimsy's own command bar/Settings layer is on. Firefox's VPN itself can
  // still be on or off independently via MASTER_PREF (the Settings checkbox).
  get wrapperEnabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  get masterEnabled() {
    return Services.prefs.getBoolPref(MASTER_PREF, false);
  },

  // Signed in, entitled, and ready to connect/disconnect.
  get ready() {
    return (
      this.wrapperEnabled &&
      this.masterEnabled &&
      lazy.IPProtectionService.state == lazy.IPProtectionStates.READY
    );
  },

  canTurnOn() {
    if (!this.ready) {
      return false;
    }
    const state = lazy.IPPProxyManager.state;
    return state != lazy.IPPProxyStates.ACTIVE && state != lazy.IPPProxyStates.ACTIVATING;
  },

  canTurnOff() {
    if (!this.ready) {
      return false;
    }
    const state = lazy.IPPProxyManager.state;
    return state == lazy.IPPProxyStates.ACTIVE || state == lazy.IPPProxyStates.ACTIVATING;
  },

  async turnOn(win) {
    if (!this.canTurnOn()) {
      return;
    }
    this.showButton(win);
    try {
      await lazy.IPPProxyManager.start();
      win.gZenUIManager?.showToast?.("whimsy-vpn-on-toast");
    } catch (e) {
      console.error("Whimsy: VPN turnOn failed", e);
    }
  },

  async turnOff(win) {
    if (!this.canTurnOff()) {
      return;
    }
    try {
      await lazy.IPPProxyManager.stop();
      win.gZenUIManager?.showToast?.("whimsy-vpn-off-toast");
    } catch (e) {
      console.error("Whimsy: VPN turnOff failed", e);
    }
  },

  // fix7 settings: Firefox's VPN button. Firefox places it once, next to
  // the account or extensions button; in Zen's layouts that spot can be
  // hidden or the button can end up in the overflow palette, so people
  // couldn't find it. Asking for the VPN from the command bar puts it back
  // in the toolbar, then returns the button (null when Firefox hasn't made
  // the widget, i.e. the VPN isn't available).
  showButton(win) {
    const { CustomizableUI } = lazy;
    const widget = CustomizableUI.getWidget(WIDGET_ID);
    if (!widget || widget.provider != CustomizableUI.PROVIDER_API) {
      return null;
    }
    if (!CustomizableUI.getPlacementOfWidget(WIDGET_ID)) {
      const next = CustomizableUI.getPlacementOfWidget("unified-extensions-button");
      CustomizableUI.addWidgetToArea(
        WIDGET_ID,
        CustomizableUI.AREA_NAVBAR,
        next?.area == CustomizableUI.AREA_NAVBAR ? next.position : undefined
      );
    }
    return widget.forWindow(win)?.node ?? null;
  },

  // W10-50: Firefox's VPN panel for this window, or null while Firefox's
  // service hasn't made it (switched off, starting, or not offered to this
  // profile). Nothing here may be a dead control, so callers explain a null.
  getPanel(win) {
    try {
      return lazy.IPProtection.getPanel(win) ?? null;
    } catch (e) {
      console.warn("Whimsy: failed to get the IPProtection panel", e);
      return null;
    }
  },

  // W10-50: opens Firefox's own VPN panel (sign-in, connect, location,
  // usage), putting its toolbar button back first so the panel has an
  // anchor. Returns false when there is no panel; see explain().
  async openPanel(win) {
    this.showButton(win);
    const panel = this.getPanel(win);
    if (!panel) {
      return false;
    }
    await panel.open(win);
    return true;
  },

  // W10-50: why the panel can't open yet, as a Fluent id.
  unavailableReason() {
    if (!this.masterEnabled) {
      return "whimsy-vpn-off-hint";
    }
    return lazy.IPProtectionService.state == lazy.IPProtectionStates.UNAVAILABLE
      ? "whimsy-vpn-unavailable-toast"
      : "whimsy-vpn-starting-toast";
  },

  explain(win) {
    win.gZenUIManager?.showToast?.(this.unavailableReason(), { timeout: 6000 });
  },

  // W10-50: the last failed enrollment (a Guardian AUTH_ERRORS value), so
  // Settings can say why "Get started" didn't stick. Cleared once signed in.
  lastEnrollError: "",

  enrollErrorL10nId(error) {
    switch (error) {
      case "region_unavailable":
        return "whimsy-vpn-enroll-region";
      case "not_entitled":
      case "unauthorized":
        return "whimsy-vpn-enroll-account";
      case "network_error":
      case "server_error":
        return "whimsy-vpn-enroll-network";
      default:
        return "whimsy-vpn-enroll-failed";
    }
  },

  // Fired by whimsy-IPProtectionPanel-sys-mjs.patch: Firefox only records a
  // failed enrollment, and its panel falls back to "Get started" silently.
  observe(subject, topic, data) {
    if (topic != "whimsy-ipprotection-enroll-failed") {
      return;
    }
    this.lastEnrollError = data || "enrollment_failed";
    const win = subject?.gZenUIManager ? subject : Services.wm.getMostRecentWindow("navigator:browser");
    win?.gZenUIManager?.showToast?.(this.enrollErrorL10nId(this.lastEnrollError), { timeout: 8000 });
    Services.obs.notifyObservers(null, "whimsy-vpn-enroll-error-changed");
  },

  _observing: false,
  _observeEnrollment() {
    if (this._observing) {
      return;
    }
    this._observing = true;
    Services.obs.addObserver(this, "whimsy-ipprotection-enroll-failed");
    lazy.IPProtectionService.addEventListener("IPProtectionService:StateChanged", () => {
      if (lazy.IPProtectionService.state == lazy.IPProtectionStates.READY && this.lastEnrollError) {
        this.lastEnrollError = "";
        Services.obs.notifyObservers(null, "whimsy-vpn-enroll-error-changed");
      }
    });
  },

  // Set Up VPN: switch Firefox's VPN on, then connect when signed in, or
  // open Firefox's panel to sign in. W10-50: it used to fall back to
  // opening Settings, because Firefox's service never started (see
  // prefs/whimsy/whimsy.yaml, app.update.checkInstallTime.days); now it
  // says why instead of sending people to a page that couldn't help either.
  async setUp(win) {
    if (!this.masterEnabled) {
      Services.prefs.setBoolPref(MASTER_PREF, true);
    }
    if (this.canTurnOn()) {
      return this.turnOn(win);
    }
    if (await this.openPanel(win)) {
      return undefined;
    }
    return this.explain(win);
  },

  canSetUp() {
    return this.wrapperEnabled && !this.ready;
  },

  initWindow(win) {
    // vpnspace: Keep the native panel and widget as the single VPN control.
    lazy.WhimsyVPNScope.initWindow(win);
    if (!this.wrapperEnabled) {
      return;
    }
    this._observeEnrollment();
    // wave5: one command for a shortcut; the command bar names the state
    // it moves to.
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyVPNToggle",
      l10nId: "whimsy-action-vpn-toggle",
      run: w => {
        if (!this.wrapperEnabled) {
          return null;
        }
        if (this.canTurnOff()) {
          return this.turnOff(w);
        }
        if (this.canSetUp()) {
          // fix7 settings: before sign-in neither On nor Off applies.
          return this.setUp(w);
        }
        return this.canTurnOn() ? this.turnOn(w) : null;
      },
      icon: ICON,
      variants: [
        { l10nId: "whimsy-action-vpn-on", isAvailable: () => this.wrapperEnabled && this.canTurnOn() },
        { l10nId: "whimsy-action-vpn-off", isAvailable: () => this.wrapperEnabled && this.canTurnOff() },
        { l10nId: "whimsy-action-vpn-setup", isAvailable: () => this.canSetUp() },
      ],
    });
  },
};
