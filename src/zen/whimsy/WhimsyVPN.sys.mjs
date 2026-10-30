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
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
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

  initWindow(win) {
    // vpnspace: Keep the native panel and widget as the single VPN control.
    lazy.WhimsyVPNScope.initWindow(win);
    if (!this.wrapperEnabled) {
      return;
    }
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
        return this.canTurnOn() ? this.turnOn(w) : null;
      },
      icon: ICON,
      variants: [
        { l10nId: "whimsy-action-vpn-on", isAvailable: () => this.wrapperEnabled && this.canTurnOn() },
        { l10nId: "whimsy-action-vpn-off", isAvailable: () => this.wrapperEnabled && this.canTurnOff() },
      ],
    });
  },
};
