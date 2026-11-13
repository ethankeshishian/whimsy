/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W26 (site panel): each profile (container) keeps its own site zoom.
//
// Firefox keeps a site's zoom in content prefs under one name
// ("browser.content.full-zoom") per site, whatever the container. FullZoom
// (browser-fullZoom.js, whimsy-browser-fullZoom-js.patch) reads and writes
// it through a store this module wraps: in a profile, the name gains the
// profile's container ("browser.content.full-zoom.uc2"), so a site zoomed
// in Work stays as it was in Default. Default keeps the plain name, so the
// zoom people already saved stays where it is. The global default zoom
// (Settings → Zoom) stays one value for every profile. Private tabs keep
// content prefs in memory, as before.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
});

export const ZOOM_NAME = "browser.content.full-zoom";
const SUFFIX = ".uc";
// The store's per-site calls: (domain, name, context, ...).
const SITE_CALLS = ["getByDomainAndName", "getCachedByDomainAndName", "set", "removeByDomainAndName"];

let deleteHooked = false;

export const WhimsyProfileZoom = {
  // The container a load context belongs to (0 for Default).
  userContextIdOf(context) {
    try {
      return context?.originAttributes?.userContextId || 0;
    } catch (e) {
      return 0;
    }
  },

  // The content-pref name a site's zoom has in a profile.
  nameFor(name, userContextId) {
    return name == ZOOM_NAME && userContextId > 0 ? `${name}${SUFFIX}${userContextId}` : name;
  },

  // The plain name and the container of a stored name.
  parse(name) {
    if (name == ZOOM_NAME) {
      return { name, userContextId: 0 };
    }
    const match = typeof name == "string" && name.startsWith(ZOOM_NAME + SUFFIX) ?
      /^(\d+)$/.exec(name.slice(ZOOM_NAME.length + SUFFIX.length)) : null;
    return match ? { name: ZOOM_NAME, userContextId: Number(match[1]) } : null;
  },

  /**
   * FullZoom's content-pref store for a window: per-site calls go to the
   * profile's own name; the observer FullZoom adds hears only changes in
   * the profile of the tab in front (Firefox applied any change to the
   * site to the tab in front, whatever its profile).
   */
  wrap(cps, win) {
    this.hookDelete(cps);
    const observers = new Map();
    const wrapper = {};
    for (const call of SITE_CALLS) {
      wrapper[call] = (domain, name, context, ...rest) =>
        cps[call](domain, this.nameFor(name, this.userContextIdOf(context)), context, ...rest);
    }
    wrapper.addObserverForName = (name, observer) => {
      if (name != ZOOM_NAME) {
        cps.addObserverForName(name, observer);
        return;
      }
      const filtered = {
        QueryInterface: ChromeUtils.generateQI(["nsIContentPrefObserver"]),
        matches: changed => {
          const parsed = this.parse(changed);
          if (!parsed) {
            return false;
          }
          const browser = win.gBrowser?.selectedBrowser;
          return parsed.userContextId == (browser?.browsingContext?.originAttributes?.userContextId || 0);
        },
        onContentPrefSet: (group, changed, value, isPrivate) => {
          if (filtered.matches(changed)) {
            observer.onContentPrefSet(group, ZOOM_NAME, value, isPrivate);
          }
        },
        onContentPrefRemoved: (group, changed, isPrivate) => {
          if (filtered.matches(changed)) {
            observer.onContentPrefRemoved(group, ZOOM_NAME, isPrivate);
          }
        },
      };
      observers.set(observer, filtered);
      // Every name: a profile's name exists only once it's used.
      cps.addObserverForName(null, filtered);
    };
    wrapper.removeObserverForName = (name, observer) => {
      const filtered = observers.get(observer);
      if (name == ZOOM_NAME && filtered) {
        observers.delete(observer);
        cps.removeObserverForName(null, filtered);
        return;
      }
      cps.removeObserverForName(name, observer);
    };
    // Everything else (the global zoom, extractDomain, …) is the store's own.
    return new Proxy(cps, {
      get: (target, prop) => {
        if (Object.hasOwn(wrapper, prop)) {
          return wrapper[prop];
        }
        const value = target[prop];
        return typeof value == "function" ? value.bind(target) : value;
      },
    });
  },

  // A deleted profile's zoom goes with it (its container's site data does).
  hookDelete(cps) {
    if (deleteHooked) {
      return;
    }
    deleteHooked = true;
    lazy.WhimsyProfiles.onDelete(id => this.forgetProfile(id, cps));
  },

  forgetProfile(id, cps = Cc["@mozilla.org/content-pref/service;1"].getService(Ci.nsIContentPrefService2)) {
    const name = this.nameFor(ZOOM_NAME, Number(id) || 0);
    if (name == ZOOM_NAME) {
      return Promise.resolve();
    }
    return new Promise(resolve => cps.removeByName(name, null, { handleCompletion: () => resolve() }));
  },
};
