/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W30 drm-webkit: Whimsy's Widevine has no VMP signature, so sites that
// require it refuse to play. When a page in a Firefox tab asks for Widevine,
// the tab switches to WebKit (FairPlay) through the same path as a manual
// engine switch (cookies included), and a toast says so. The trigger is the
// Widevine request itself, never a list of sites.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyWebKit: "resource:///modules/whimsy/WhimsyWebKit.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.webkit-drm";
const TOAST_ID = "whimsy-webkit-drm-toast";
const WIDEVINE = /^com\.widevine\.alpha(\.|$)/;

export const WhimsyWebKitDRM = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  isWidevine(keySystem) {
    return WIDEVINE.test(String(keySystem ?? ""));
  },

  /**
   * A page in `tab` asked for `keySystem`. Switches the tab to WebKit when
   * it's Widevine and the tab may switch.
   *
   * @param {Element} tab
   * @param {string} keySystem
   * @param {object} [options]
   * @param {number} [options.innerWindowId] - The top document that asked;
   *   a document only ever switches its tab once.
   * @returns {Promise<boolean>} Whether the tab switched.
   */
  async onKeySystemRequest(tab, keySystem, { innerWindowId = 0 } = {}) {
    const WebKit = lazy.WhimsyWebKit;
    if (!tab || !this.enabled || !this.isWidevine(keySystem)) {
      return false;
    }
    // Already WebKit (or on its way there): nothing to do.
    if (WebKit.isWebKitTab(tab) || tab._whimsyDRMSwitching) {
      return false;
    }
    // You put this site back in Firefox: it stays there.
    if (tab._whimsyWebKitOverride == "firefox") {
      return false;
    }
    if (innerWindowId && tab._whimsyDRMSwitchedFor == innerWindowId) {
      return false;
    }
    if (!WebKit.availableForTab(tab)) {
      return false;
    }
    tab._whimsyDRMSwitching = true;
    tab._whimsyDRMSwitchedFor = innerWindowId;
    let switched = false;
    try {
      switched = await WebKit.setTabEngine(tab, "webkit", {
        waitForLoad: false,
      });
    } catch (e) {
      console.error("WhimsyWebKitDRM: switch failed", e);
    } finally {
      tab._whimsyDRMSwitching = false;
    }
    if (switched && WebKit.isWebKitTab(tab)) {
      const win = tab.ownerDocument?.defaultView;
      if (win && !win.closed) {
        win.gZenUIManager?.showToast(TOAST_ID);
      }
    }
    return switched;
  },
};

export class WhimsyWebKitDRMParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name != "WhimsyWebKitDRM:Widevine") {
      return;
    }
    const top = this.browsingContext?.top;
    const browser = top?.embedderElement;
    const tab = browser?.getTabBrowser?.()?.getTabForBrowser(browser);
    if (!tab) {
      return;
    }
    // Only the document the tab is showing; a page already gone doesn't
    // switch the tab it left.
    const current = top.currentWindowGlobal;
    const asking = this.manager?.topWindowContext;
    if (!current || !asking || current.innerWindowId != asking.innerWindowId) {
      return;
    }
    WhimsyWebKitDRM.onKeySystemRequest(tab, message.data?.keySystem, {
      innerWindowId: current.innerWindowId,
    }).catch(console.error);
  }
}
