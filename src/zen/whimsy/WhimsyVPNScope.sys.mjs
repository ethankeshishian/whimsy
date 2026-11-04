/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// vpnspace: Extend Firefox's VPN rather than creating another one. W14 3c:
// This Site's row is the one scope control; Firefox's panel stays Firefox's.
// Policy is profile-wide, pinned to containers chosen at click time; space
// switching must never silently retarget it. Existing connections are not
// migrated, and site exclusions and Firefox's connection modes still apply.
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  IPPProxyManager: "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs",
  IPPProxyStates: "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs",
});
const PREF = "browser.ipProtection.whimsy.userContextIds";
const FEATURE = "whimsy.feature.vpnspace";

export const WhimsyVPNScope = {
  PREF,
  FEATURE,
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE, true) &&
      Services.prefs.getBoolPref("whimsy.feature.vpn", true);
  },
  get ids() {
    return this.enabled ? Services.prefs.getStringPref(PREF, "").trim() : "";
  },
  containerForWindow(win) {
    const id = Number(win.gZenWorkspaces?.getActiveWorkspace()?.containerTabId);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  },
  selectedIds() {
    // Match the channel filter's decimal list syntax so the button never
    // advertises coverage for a container the proxy would reject.
    return this.ids.split(",").map(value => value.trim())
      .filter(value => /^\d+$/.test(value)).map(Number)
      .filter(id => Number.isSafeInteger(id) && id > 0);
  },
  // Returns false without changing the previous policy when no container exists.
  setScope(win, scope) {
    if (!this.enabled || !["browser", "space"].includes(scope)) {
      return false;
    }
    const id = scope === "space" ? this.containerForWindow(win) : null;
    if (scope === "space" && !id) {
      return false;
    }
    const ids = new Set(this.selectedIds());
    if (id !== null) {
      if (ids.has(id)) {
        ids.delete(id);
      } else {
        ids.add(id);
      }
    }
    // A nonempty invalid token matches no channel; empty means all spaces.
    Services.prefs.setStringPref(PREF, id === null ? "" : [...ids].join(",") || "none");
    return true;
  },
  buttonState(win) {
    if (!Services.prefs.getBoolPref("browser.ipProtection.enabled", false)) {
      return "off";
    }
    const ids = this.ids;
    if (ids && !this.selectedIds().includes(this.containerForWindow(win))) {
      return "elsewhere";
    }
    if (lazy.IPPProxyManager.state === lazy.IPPProxyStates.ACTIVATING) {
      return "connecting";
    }
    if (lazy.IPPProxyManager.state !== lazy.IPPProxyStates.ACTIVE) {
      return "off";
    }
    return ids ? "space" : "browser";
  },
};
