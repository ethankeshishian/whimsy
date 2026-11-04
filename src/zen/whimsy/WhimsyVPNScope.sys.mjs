/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// vpnspace: Extend Firefox's VPN rather than creating another one. W14 3c:
// This Site's row is the one scope control; Firefox's panel stays Firefox's.
// Policy is pinned to the profiles (containers, Default included) chosen at
// click time; space switching must never silently retarget it. Existing connections are not
// migrated, and site exclusions and Firefox's connection modes still apply.
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  IPPProxyManager: "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs",
  IPPProxyStates: "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs",
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
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
  // W14 3d: the profile (container) of the space in front; 0 is the
  // Default profile, whose channels carry userContextId 0. Null without a
  // space.
  profileForWindow(win) {
    const space = win.gZenWorkspaces?.getActiveWorkspace?.();
    if (!space) {
      return null;
    }
    const id = Number(space.containerTabId) || 0;
    return Number.isSafeInteger(id) && id >= 0 ? id : 0;
  },
  profileName(id) {
    return lazy.WhimsyProfiles.nameOf(id);
  },
  selectedIds() {
    // Match the channel filter's decimal list syntax so the button never
    // advertises coverage for a container the proxy would reject.
    return this.ids.split(",").map(value => value.trim())
      .filter(value => /^\d+$/.test(value)).map(Number)
      .filter(id => Number.isSafeInteger(id) && id >= 0);
  },
  // "browser": all spaces; "space": also all spaces in this space's profile,
  // added to any already chosen (picking it again changes nothing).
  setScope(win, scope) {
    if (!this.enabled || !["browser", "space"].includes(scope)) {
      return false;
    }
    if (scope === "browser") {
      Services.prefs.setStringPref(PREF, "");
      return true;
    }
    const id = this.profileForWindow(win);
    if (id === null) {
      return false;
    }
    const ids = new Set(this.selectedIds());
    ids.add(id);
    Services.prefs.setStringPref(PREF, [...ids].join(","));
    return true;
  },
  // The choice This Site shows: "browser", "space", or null when the VPN
  // covers other profiles but not this one.
  scopeChoice(win) {
    if (!this.ids) {
      return "browser";
    }
    return this.selectedIds().includes(this.profileForWindow(win)) ? "space" : null;
  },
  buttonState(win) {
    if (!Services.prefs.getBoolPref("browser.ipProtection.enabled", false)) {
      return "off";
    }
    const ids = this.ids;
    if (ids && !this.selectedIds().includes(this.profileForWindow(win))) {
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
