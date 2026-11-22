/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W30: WebKit cookie copy. Firefox and WebKit keep separate cookie jars, so a
// site you're signed into in one engine was signed out after a switch. On
// every engine switch WhimsyWebKit copies that site's cookies (its
// registrable domain and subdomains, never third parties or CHIPS
// partitions) from the engine you're leaving into the one about to load it.
// Part of whimsy.feature.webkit-tabs: it only runs when a tab switches.
//
// Jars line up one to one: Gecko's default jar or a container
// (userContextId) and that profile's persistent WKWebsiteDataStore. Private
// tabs never become WebKit tabs, and the copy refuses them anyway, so
// nothing private is ever written to a persistent store. Cookie values are
// never logged.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyWebKit: "resource:///modules/whimsy/WhimsyWebKit.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

// A stuck native store must never hold up the switch itself.
const COPY_TIMEOUT_MS = 3000;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise(resolve => {
      timer = lazy.setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => lazy.clearTimeout(timer));
}

export const WhimsyWebKitCookies = {
  // Tests swap in a stand-in for the native WKHTTPCookieStore calls.
  _store: null,

  get store() {
    return this._store ?? lazy.WhimsyWebKit.service;
  },

  // ---------------------------------------------------------------------
  // Pure selection and mapping (tested headlessly).

  // The site a URL belongs to: its registrable domain, or the bare host for
  // IP addresses and single-label hosts, which have none.
  siteOf(uri) {
    if (!uri || !(uri.schemeIs("http") || uri.schemeIs("https"))) {
      return "";
    }
    let host = "";
    try {
      host = (uri.asciiHost || "").toLowerCase();
    } catch {
      return "";
    }
    if (!host) {
      return "";
    }
    try {
      return Services.eTLD.getBaseDomainFromHost(host);
    } catch {
      return host;
    }
  },

  cookieInSite(domain, site) {
    if (!domain || !site) {
      return false;
    }
    const d = String(domain).toLowerCase().replace(/^\./, "");
    const s = String(site).toLowerCase();
    return d == s || d.endsWith("." + s);
  },

  // Keeps only the site's own, unpartitioned, still-live cookies.
  selectSiteCookies(cookies, site, now = Date.now()) {
    return (cookies || []).filter(
      c =>
        c &&
        typeof c.name == "string" &&
        c.name &&
        typeof c.value == "string" &&
        !c.partitioned &&
        this.cookieInSite(c.domain, site) &&
        !(c.expires > 0 && c.expires <= now)
    );
  },

  // nsICookie -> the portable shape the native side speaks. sameSite "" is
  // "no SameSite attribute", which both engines treat as None.
  fromGecko(cookie) {
    let sameSite = "";
    if (cookie.sameSite == Ci.nsICookie.SAMESITE_LAX) {
      sameSite = "lax";
    } else if (cookie.sameSite == Ci.nsICookie.SAMESITE_STRICT) {
      sameSite = "strict";
    }
    return {
      name: cookie.name,
      value: cookie.value,
      // Gecko's host keeps the leading dot of a domain cookie, as
      // NSHTTPCookie's domain does.
      domain: cookie.host,
      path: cookie.path || "/",
      expires: cookie.isSession ? 0 : Number(cookie.expiry) || 0,
      secure: !!cookie.isSecure,
      httpOnly: !!cookie.isHttpOnly,
      sameSite,
      partitioned: !!cookie.isPartitioned,
    };
  },

  // The portable shape -> the arguments of Services.cookies.add.
  toGeckoArgs(c, originAttributes, scheme = "https") {
    let sameSite;
    if (c.sameSite == "lax") {
      sameSite = Ci.nsICookie.SAMESITE_LAX;
    } else if (c.sameSite == "strict") {
      sameSite = Ci.nsICookie.SAMESITE_STRICT;
    } else if (Ci.nsICookie.SAMESITE_UNSET !== undefined) {
      sameSite = Ci.nsICookie.SAMESITE_UNSET;
    } else {
      // Gecko refuses SameSite=None without Secure; Lax is the closest it
      // keeps.
      sameSite = c.secure
        ? Ci.nsICookie.SAMESITE_NONE
        : Ci.nsICookie.SAMESITE_LAX;
    }
    const schemeMap =
      c.secure || scheme == "https"
        ? Ci.nsICookie.SCHEME_HTTPS
        : Ci.nsICookie.SCHEME_HTTP;
    const isSession = !(c.expires > 0);
    // A session cookie still needs an expiry; it ends with the session.
    const expiry = isSession
      ? Date.now() + 24 * 60 * 60 * 1000
      : Number(c.expires);
    return [
      c.domain,
      c.path || "/",
      c.name,
      c.value,
      !!c.secure,
      !!c.httpOnly,
      isSession,
      expiry,
      originAttributes,
      sameSite,
      schemeMap,
      false, // isPartitioned: partitioned cookies never travel
    ];
  },

  // The cookie jars a tab's switch copies between, or null when it must not
  // copy: private tabs, first-party isolation (its jars are keyed per site
  // and WebKit has nothing like them), and containers that WebKit can't keep
  // apart (a non-default container whose WebKit profile key falls back to
  // the default one would mix two jars).
  jarFor(tab) {
    const webkit = lazy.WhimsyWebKit;
    if (!tab || webkit.isTabPrivate(tab)) {
      return null;
    }
    if (Services.prefs.getBoolPref("privacy.firstparty.isolate", false)) {
      return null;
    }
    const oa = tab.linkedBrowser?.browsingContext?.originAttributes;
    if (oa?.privateBrowsingId) {
      return null;
    }
    const userContextId = tab.userContextId || oa?.userContextId || 0;
    if (
      userContextId &&
      webkit.profileKeyOf(userContextId) == webkit.profileKeyOf(0)
    ) {
      return null;
    }
    return {
      originAttributes: { userContextId, privateBrowsingId: 0 },
      dataStoreId: webkit.dataStoreIdForProfile(userContextId),
    };
  },

  // ---------------------------------------------------------------------
  // The copies. Each resolves with the number of cookies copied (0 when
  // there was nothing to copy or it was skipped) and never throws.

  async copyToWebKit(tab, uri) {
    try {
      const site = this.siteOf(uri);
      const jar = site && this.jarFor(tab);
      const store = this.store;
      if (!jar || !store?.setCookies) {
        return 0;
      }
      const cookies = this.selectSiteCookies(
        Services.cookies
          .getCookiesFromHost(site, jar.originAttributes)
          .map(c => this.fromGecko(c)),
        site
      );
      if (!cookies.length) {
        return 0;
      }
      const count = await withTimeout(
        store.setCookies(jar.dataStoreId, site, JSON.stringify(cookies)),
        COPY_TIMEOUT_MS
      );
      return Number(count) || 0;
    } catch (e) {
      // The name only: the error never carries cookie values.
      console.error("WhimsyWebKitCookies: copy to WebKit failed", e?.name);
      return 0;
    }
  },

  async copyToFirefox(tab, uri) {
    try {
      const site = this.siteOf(uri);
      const jar = site && this.jarFor(tab);
      const store = this.store;
      if (!jar || !store?.getCookies) {
        return 0;
      }
      const json = await withTimeout(
        store.getCookies(jar.dataStoreId, site),
        COPY_TIMEOUT_MS
      );
      let parsed = [];
      try {
        parsed = JSON.parse(json || "[]");
      } catch {}
      const cookies = this.selectSiteCookies(
        Array.isArray(parsed) ? parsed : [],
        site
      );
      const scheme = uri.schemeIs("https") ? "https" : "http";
      let copied = 0;
      for (const c of cookies) {
        try {
          const validation = Services.cookies.add(
            ...this.toGeckoArgs(c, jar.originAttributes, scheme)
          );
          if (
            !validation ||
            validation.result == Ci.nsICookieValidation.eOK
          ) {
            copied++;
          }
        } catch {
          // One cookie Gecko rejects (a bad prefix, say) doesn't stop the rest.
        }
      }
      return copied;
    } catch (e) {
      console.error("WhimsyWebKitCookies: copy to Firefox failed", e?.name);
      return 0;
    }
  },
};
