/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Per-site user agent (Safari's Develop > User Agent; the "User-Agent
// Switcher" extensions): "Pretend to Be" in This Site (the site panel; the
// command bar's action opens it there, W10-16) sets the current site to
// Chrome, Safari (macOS or iPhone) or a custom string, reloading once. People use this for sites that block Firefox outright
// ("best viewed in Chrome") or to get a site's mobile layout.
// Built on BrowsingContext.customUserAgent (the same pref-free mechanism
// Responsive Design Mode uses); no engine patch. Per-site overrides are
// marked with a permission (so the permission manager's own UI/APIs can
// list and clear them) plus a JSON pref for the string itself.
// whimsy.feature.site-user-agent.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.site-user-agent";
const SITES_PREF = "whimsy.useragent.sites";
const PERM_TYPE = "whimsy-useragent";

export const PRESETS = {
  "chrome-mac":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/129.0.0.0 Safari/537.36",
  "safari-mac":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) " +
    "Version/17.5 Safari/605.1.15",
  "safari-iphone":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) " +
    "Version/17.5 Mobile/15E148 Safari/604.1",
};

function readSites() {
  try {
    const raw = JSON.parse(Services.prefs.getStringPref(SITES_PREF, "{}"));
    if (!raw || typeof raw !== "object") {
      return { default: {} };
    }
    // Backward compatibility: if raw has host keys directly (e.g. raw["example.com"] = { preset: "..." })
    // wrap it into { default: raw }
    const firstVal = Object.values(raw)[0];
    if (firstVal && (firstVal.preset !== undefined || typeof firstVal !== "object")) {
      return { default: raw };
    }
    return raw;
  } catch (e) {
    return { default: {} };
  }
}

function writeSites(sites) {
  Services.prefs.setStringPref(SITES_PREF, JSON.stringify(sites));
}

// wave8/isolation & W8-49: a choice made in a private tab stays in memory and
// applies to private tabs only (host -> entry, or null for "Default"). Gone
// when the last private tab closes.
const privateSites = new Map();
let watchingPrivate = false;

function watchPrivateEnd() {
  if (watchingPrivate) {
    return;
  }
  watchingPrivate = true;
  Services.obs.addObserver(() => privateSites.clear(), "last-pb-context-exited");
}

function parseOptions(opts) {
  if (typeof opts === "boolean") {
    return { isPrivate: opts, profileKey: "default" };
  }
  if (typeof opts === "string") {
    return { isPrivate: false, profileKey: opts };
  }
  return {
    isPrivate: !!opts?.isPrivate,
    profileKey: opts?.profileKey || "default",
  };
}

function entryFor(host, opts = {}) {
  const { isPrivate, profileKey } = parseOptions(opts);
  if (isPrivate && privateSites.has(host)) {
    return privateSites.get(host);
  }
  const sites = readSites();
  return sites[profileKey]?.[host] ?? null;
}

export const WhimsyUserAgent = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  // W9-04: the stored choice for a host ({ preset, custom }), or null. The
  // site panel's "This Site" section shows it and can put it back on Undo.
  entry(host, options = {}) {
    return entryFor(host, options);
  },

  // Returns the stored UA string for a host, or null.
  uaFor(host, options = {}) {
    const entry = entryFor(host, options);
    if (!entry) {
      return null;
    }
    return entry.preset == "custom" ? entry.custom || null : PRESETS[entry.preset] || null;
  },

  set(host, preset, custom, options = {}) {
    const { isPrivate, profileKey } = parseOptions(options);
    if (isPrivate) {
      watchPrivateEnd();
      privateSites.set(host, preset == "custom" ? { preset, custom } : { preset });
      return;
    }
    const sites = readSites();
    sites[profileKey] ??= {};
    sites[profileKey][host] = preset == "custom" ? { preset, custom } : { preset };
    writeSites(sites);
    try {
      const uri = Services.io.newURI(`https://${host}/`);
      const userContextId = lazy.WhimsyProfiles.idForKey(profileKey);
      const principal = Services.scriptSecurityManager.createContentPrincipal(uri, {
        userContextId,
      });
      Services.perms.addFromPrincipal(principal, PERM_TYPE, Services.perms.ALLOW_ACTION);
    } catch (e) {}
  },

  clear(host, options = {}) {
    const { isPrivate, profileKey } = parseOptions(options);
    if (isPrivate) {
      watchPrivateEnd();
      privateSites.set(host, null);
      return;
    }
    const sites = readSites();
    if (sites[profileKey]) {
      delete sites[profileKey][host];
      writeSites(sites);
    }
    try {
      const uri = Services.io.newURI(`https://${host}/`);
      const userContextId = lazy.WhimsyProfiles.idForKey(profileKey);
      const principal = Services.scriptSecurityManager.createContentPrincipal(uri, {
        userContextId,
      });
      Services.perms.removeFromPrincipal(principal, PERM_TYPE);
    } catch (e) {}
  },

  removeProfile(profileKey) {
    if (!profileKey || profileKey === "default") {
      return;
    }
    const sites = readSites();
    if (sites[profileKey]) {
      delete sites[profileKey];
      writeSites(sites);
    }
  },

  initWindow(win) {
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
      onLocationChange: (progress, request, location, flags) => {
        if (!this.enabled || !progress.isTopLevel) {
          return;
        }
        const bc = progress.browsingContext;
        const attrs = bc?.top?.originAttributes ?? {};
        const isPrivate = (attrs.privateBrowsingId || 0) > 0;
        const userContextId = attrs.userContextId || 0;
        const profileKey = lazy.WhimsyProfiles.keyFor(userContextId);
        this.applyTo(bc, location?.asciiHost, { isPrivate, profileKey });
      },
    };
    win.gBrowser.addTabsProgressListener?.(listener) ?? win.gBrowser.addProgressListener(listener);
    win._whimsyUserAgentListener = listener;
  },

  applyTo(browsingContext, host, options = null) {
    if (!browsingContext) {
      return;
    }
    if (!options) {
      const attrs = browsingContext.top?.originAttributes ?? {};
      const isPrivate = (attrs.privateBrowsingId || 0) > 0;
      const userContextId = attrs.userContextId || 0;
      const profileKey = lazy.WhimsyProfiles.keyFor(userContextId);
      options = { isPrivate, profileKey };
    }
    const ua = host ? this.uaFor(host, options) : null;
    const current = browsingContext.customUserAgent || "";
    if ((ua || "") != current) {
      browsingContext.customUserAgent = ua || "";
    }
  },

  // Reload the given tab's browser once, after the pref change above has
  // committed, so onLocationChange picks up the new UA before the request.
  reload(win, tab) {
    tab.linkedBrowser.reload();
  },
};

// W8-49: clean up per-site UA overrides when a custom profile is deleted.
try {
  lazy.WhimsyProfiles.onDelete?.((id, key) => WhimsyUserAgent.removeProfile(key));
} catch (e) {}
