/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave5/profiles, phase 3: history per profile in the address bar (Arc:
// each profile has its own history, so typing in a new profile doesn't
// suggest pages from another). Firefox keeps one history (Places, synced as
// one), so this is a view filter, not isolation: WhimsySpaceHistory records
// which profile each visit came from, and the address bar's history results
// (Places, input history, autofill and the history heuristic) leave out
// pages the current tab's profile never visited. History from before
// profiles, and visits synced from other devices (Firefox Sync has no field
// for it), carry no profile: they belong to Default. Bookmarks and open tabs
// are never filtered. The Library's History tab has the same filter, with
// "All Profiles" to see everything.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
  WhimsySpaceHistory: "resource:///modules/whimsy/WhimsySpaceHistory.sys.mjs",
});

// UrlbarShared.RESULT_SOURCE.HISTORY
const SOURCE_HISTORY = 2;
const PROVIDERS = [
  ["moz-src:///browser/components/urlbar/UrlbarProviderPlaces.sys.mjs", "UrlbarProviderPlaces", false],
  ["moz-src:///browser/components/urlbar/UrlbarProviderInputHistory.sys.mjs", "UrlbarProviderInputHistory", false],
  ["moz-src:///browser/components/urlbar/UrlbarProviderHistoryUrlHeuristic.sys.mjs", "UrlbarProviderHistoryUrlHeuristic", false],
  // Autofill completes to an origin as often as to a page.
  ["moz-src:///browser/components/urlbar/UrlbarProviderAutofill.sys.mjs", "UrlbarProviderAutofill", true],
];

export const WhimsyProfileHistory = {
  get enabled() {
    return lazy.WhimsyProfiles.enabled && lazy.WhimsySpaceHistory.enabled;
  },

  /**
   * Whether a page belongs in `key`'s history. Pages with recorded visits
   * show in the profiles that visited them; pages without any are Default's.
   */
  visibleIn(key, url, { origin = false } = {}) {
    const profiles = lazy.WhimsySpaceHistory.profilesFor(url, { origin });
    if (!profiles?.size) {
      return key == lazy.WhimsyProfiles.DEFAULT_KEY;
    }
    return profiles.has(key);
  },

  keep(queryContext, result, origin) {
    if (!this.enabled || queryContext?.isPrivate || result?.source != SOURCE_HISTORY) {
      return true;
    }
    const url = result.payload?.url;
    if (!url) {
      return true;
    }
    const key = lazy.WhimsyProfiles.keyFor(queryContext.userContextId ?? 0);
    return this.visibleIn(key, url, { origin });
  },

  wrapProvider(moduleUrl, name, origin) {
    let Provider;
    try {
      Provider = ChromeUtils.importESModule(moduleUrl)[name];
    } catch (e) {
      console.error(`Whimsy: ${name} is gone; its history isn't filtered by profile`, e);
      return;
    }
    const proto = Provider?.prototype;
    const original = proto?.startQuery;
    if (typeof original != "function" || original._whimsyProfiles) {
      return;
    }
    const self = this;
    const wrapped = function (queryContext, addCallback, ...rest) {
      const filtered = (provider, result, ...more) => {
        if (self.keep(queryContext, result, origin)) {
          return addCallback(provider, result, ...more);
        }
        return undefined;
      };
      return original.call(this, queryContext, filtered, ...rest);
    };
    wrapped._whimsyProfiles = true;
    proto.startQuery = wrapped;
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    for (const [url, name, origin] of PROVIDERS) {
      this.wrapProvider(url, name, origin);
    }
    // Load the visit index now, before the first query needs it.
    lazy.WhimsySpaceHistory.file().catch(console.error);
  },
};
