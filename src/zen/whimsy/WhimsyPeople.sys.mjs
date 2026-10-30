/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// People cards (Arc parity): rest the pointer on a GitHub, LinkedIn or X
// profile link and a small card says who it is (photo, name, headline)
// before you click through. Arc users love it in email and docs for the
// "who is this?" moment without leaving the page.
//
// The user asked for the signed-in session (like GitHub's) for LinkedIn and
// X too. So the profile page is fetched as the hovered tab's container, with
// its cookies, and only its <meta> tags are read (og:title/og:image/
// og:description) through an inert DOMParser. To stay far from anything that
// looks like crawling: only after a deliberate 600 ms hover (WhimsyHoverCard),
// cached for 15 minutes, at most one request every 10 seconds and 20 an hour
// in total, no redirects followed, never in private browsing. When a fetch
// isn't allowed or the site gives nothing usable (X serves an app shell; a
// login wall), the card still shows the handle and site, without a request.
// macOS Contacts would need a native (EventKit-style) component: deferred.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.people-cards";
const CACHE_MS = 15 * 60 * 1000;
const CACHE_SIZE = 100;
const MIN_SPACING_MS = 10 * 1000;
const HOURLY_CAP = 20;
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 8000;

export const PEOPLE_HOSTS = ["github.com", "linkedin.com", "x.com", "twitter.com"];

const SITE_NAMES = {
  "github.com": "GitHub",
  "linkedin.com": "LinkedIn",
  "x.com": "X",
  "twitter.com": "X",
};

// First path segments that are site pages, not people.
const RESERVED = new Set([
  "about", "collections", "events", "explore", "features", "home", "i", "intent",
  "join", "login", "logout", "marketplace", "messages", "notifications", "orgs",
  "organizations", "pricing", "search", "settings", "share", "signup", "sponsors",
  "topics", "trending", "enterprise", "pulls", "issues", "codespaces", "new",
]);

const cache = new Map();
let requestTimes = [];

export const WhimsyPeople = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  // A canonical https profile URL, or null for anything that isn't one
  // person's profile page (repos, posts, company pages, look-alike hosts).
  profile(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (url.protocol != "https:" || url.username || url.password || url.port) {
      return null;
    }
    const host = url.hostname.toLowerCase().replace(/^(www|mobile)\./, "");
    const parts = url.pathname.split("/").filter(Boolean);
    if (host == "linkedin.com") {
      if (parts.length != 2 || parts[0] != "in" || !/^[\w%-]{1,100}$/.test(parts[1])) {
        return null;
      }
    } else if (["github.com", "x.com", "twitter.com"].includes(host)) {
      if (
        parts.length != 1 ||
        !/^[A-Za-z0-9_-]{1,39}$/.test(parts[0]) ||
        RESERVED.has(parts[0].toLowerCase())
      ) {
        return null;
      }
    } else {
      return null;
    }
    return `https://${host}/${parts.join("/")}`;
  },

  // The no-network card: the handle and the site it's on.
  fallback(profileUrl) {
    const url = new URL(profileUrl);
    const handle = url.pathname.split("/").filter(Boolean).at(-1);
    const site = SITE_NAMES[url.hostname];
    return { title: url.hostname == "linkedin.com" ? handle : `@${handle}`, url: profileUrl, description: site };
  },

  // Resolves to { title, url, description, image } or null. Never throws.
  async lookup(win, value, { userContextId = 0, privateBrowsingId = 0 } = {}) {
    const url = this.profile(value);
    if (!url || privateBrowsingId || !this.enabled) {
      return null;
    }
    const key = `${userContextId}|${url}`;
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && cached.expires > now) {
      return cached.value;
    }
    requestTimes = requestTimes.filter(time => now - time < 60 * 60 * 1000);
    if (requestTimes.length >= HOURLY_CAP || now - (requestTimes.at(-1) ?? 0) < MIN_SPACING_MS) {
      return null;
    }
    requestTimes.push(now);
    const pending = this.fetchProfile(win, url, userContextId).catch(() => null);
    cache.delete(key);
    cache.set(key, { expires: now + CACHE_MS, value: pending });
    while (cache.size > CACHE_SIZE) {
      cache.delete(cache.keys().next().value);
    }
    return pending;
  },

  // Fetches the profile page as `userContextId` (the hovered tab's
  // container, so its signed-in cookies), reading only its meta tags.
  async fetchProfile(win, url, userContextId) {
    const uri = Services.io.newURI(url);
    const principal = Services.scriptSecurityManager.createContentPrincipal(uri, { userContextId });
    const channel = lazy.NetUtil.newChannel({
      uri,
      // As in ZenLiveFolder.sys.mjs's fetch(): makes the principal's
      // cookies apply.
      contentPolicyType: Ci.nsIContentPolicy.TYPE_SAVEAS_DOWNLOAD,
      loadingPrincipal: principal,
      triggeringPrincipal: principal,
      securityFlags:
        Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL | Ci.nsILoadInfo.SEC_COOKIES_INCLUDE,
    }).QueryInterface(Ci.nsIHttpChannel);
    channel.setRequestHeader("Accept", "text/html", false);
    // A redirect means a login wall or a challenge: never followed.
    channel.notificationCallbacks = {
      QueryInterface: ChromeUtils.generateQI(["nsIInterfaceRequestor", "nsIChannelEventSink"]),
      getInterface(iid) {
        return this.QueryInterface(iid);
      },
      asyncOnChannelRedirect(_oldChannel, _newChannel, _flags, callback) {
        callback.onRedirectVerifyCallback(Cr.NS_BINDING_ABORTED);
      },
    };
    const text = await new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      const timer = win.setTimeout(() => channel.cancel(Cr.NS_ERROR_NET_TIMEOUT), TIMEOUT_MS);
      channel.asyncOpen({
        onStartRequest() {},
        onDataAvailable(request, stream, _offset, count) {
          size += count;
          if (size > MAX_BYTES) {
            request.cancel(Cr.NS_ERROR_FILE_TOO_BIG);
            return;
          }
          chunks.push(new Uint8Array(lazy.NetUtil.readInputStream(stream, count)));
        },
        onStopRequest(_request, status) {
          win.clearTimeout(timer);
          let ok = Components.isSuccessCode(status);
          try {
            ok &&= channel.responseStatus == 200 && channel.contentType == "text/html";
          } catch {
            ok = false;
          }
          if (!ok) {
            reject(new Error("Profile unavailable"));
            return;
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          resolve(new TextDecoder().decode(bytes));
        },
      });
    });
    return this.parseProfile(win, text, url);
  },

  // DOMParser documents are inert: no scripts run, nothing loads.
  parseProfile(win, text, url) {
    const doc = new win.DOMParser().parseFromString(text, "text/html");
    const meta = name =>
      doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute("content")?.trim();
    const title = meta("og:title");
    if (!title || /sign ?in|log ?in|sign ?up|security verification|just a moment/i.test(title)) {
      return null;
    }
    const image = meta("og:image");
    return {
      title,
      url,
      description: meta("og:description") || meta("description") || null,
      image: image?.startsWith("https://") ? image : null,
    };
  },

  _resetForTests() {
    cache.clear();
    requestTimes = [];
  },
};
