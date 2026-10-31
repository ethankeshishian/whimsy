/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Reject cookie banners. Firefox removed its own cookie banner handler, so
// Whimsy ships DuckDuckGo's Autoconsent (MPL-2.0) as a hidden built-in add-on
// (cookie-banners/, packaged into builtin-addons/ like Firefox's webcompat
// add-on). On every site it detects the consent popup (OneTrust, Didomi,
// Cookiebot, Quantcast and ~1,300 more), clicks the "Reject" path for you and
// hides the banner while it does. It runs in private windows too.
// This module only keeps the add-on's enabled state in step with
// whimsy.reject-cookie-banners (Settings → Privacy & Security) and the
// whimsy.feature.cookie-banners switch.
//
// The manifest's content script deliberately has no match_origin_as_fallback.
// With it, the document_start script also matched a new tab's initial
// about:blank (whose origin falls back to the opener's) and blocked that
// document's parser until the script was ready. A navigation that started
// meanwhile (a tab created and loaded in one go) folded into the unfinished
// about:blank load, so its STATE_START was treated as the blank page's and the
// tab never got "busy": no throbber, no loading indicator. Autoconsent's frame
// rules match on the frame's real URL, so about:blank/srcdoc frames gained it
// nothing.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
});

const ADDON_ID = "cookie-banners@whimsy.browser";
const PREF = "whimsy.reject-cookie-banners";
const FEATURE_PREF = "whimsy.feature.cookie-banners";

export const WhimsyCookieBanners = {
  ADDON_ID,
  PREF,

  get enabled() {
    return (
      Services.prefs.getBoolPref(FEATURE_PREF, true) && Services.prefs.getBoolPref(PREF, true)
    );
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    const sync = () => this.sync().catch(e => console.error("Whimsy: cookie banners", e));
    Services.prefs.addObserver(PREF, sync);
    Services.prefs.addObserver(FEATURE_PREF, sync);
    sync();
  },

  // Resolves once the add-on matches the pref. A no-op when it already does,
  // which is every startup but the first after a change.
  async sync() {
    const addon = await lazy.AddonManager.getAddonByID(ADDON_ID);
    if (!addon) {
      return;
    }
    // A built-in (system) add-on: Whimsy's own toggle is its only switch,
    // since Add-ons and Themes doesn't list it.
    const wanted = this.enabled;
    if (wanted && addon.userDisabled) {
      await addon.enable({ allowSystemAddons: true });
    } else if (!wanted && !addon.userDisabled) {
      await addon.disable({ allowSystemAddons: true });
    }
  },
};
