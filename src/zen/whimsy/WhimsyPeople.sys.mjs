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

// wave9/mini W8-28: CDN hosts each site serves its own profile photos from,
// the only images a page's own link may lend the card (pageContext).
const AVATAR_HOSTS = {
  "github.com": /^avatars\.githubusercontent\.com$/,
  "linkedin.com": /^media\.licdn\.com$/,
  "x.com": /^pbs\.twimg\.com$/,
  "twitter.com": /^pbs\.twimg\.com$/,
};
// A title that names the site, not a person (X's app shell, error pages).
const GENERIC_TITLE = /^(?:x|twitter|linkedin|github|profile|page not found|this page doesn.t exist)(?:\s*[\/|·-]\s*(?:x|twitter|linkedin|github))?$/i;
const LOGIN_TITLE = /sign ?in|log ?in|sign ?up|security verification|just a moment/i;

const cache = new Map();
let requestTimes = [];

// One site for both of X's hosts.
function siteOf(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^(www|mobile)\./, "");
  return host == "twitter.com" ? "x.com" : host;
}

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

  // fix7/tabs: what the People card shows, from a lookup's meta tags (or
  // none yet): the person's name without the site's decoration ("Mona Lisa
  // (monalisa) · GitHub" is "Mona Lisa"), their handle and site, a bio
  // without the site's boilerplate, and the counts it mentions.
  card(found, profileUrl, { loading = false } = {}) {
    const url = new URL(profileUrl);
    const slug = url.pathname.split("/").filter(Boolean).at(-1);
    const linkedIn = url.hostname == "linkedin.com";
    const handle = linkedIn ? slug : `@${slug}`;
    const site = SITE_NAMES[url.hostname];
    let name = (found?.title || "").trim();
    let headline = null;
    for (let i = 0; i < 3; i++) {
      name = name.replace(/\s*(?:[·|\-–—]\s*(?:GitHub|LinkedIn|X|Twitter|Overview)|\/\s*(?:X|Twitter)|on (?:X|Twitter))\s*$/i, "");
    }
    const paren = /^(.+?)\s*\(([^()]+)\)$/.exec(name);
    if (paren) {
      const [, outside, inside] = paren;
      const same = value => value.replace(/^@/, "").toLowerCase() == slug.toLowerCase();
      name = same(inside) ? outside : same(outside) ? inside : name;
    }
    if (linkedIn && name.includes(" - ")) {
      [name, ...headline] = name.split(" - ");
      headline = headline.join(" · ");
    }
    if (name == slug || name == `@${slug}`) {
      name = "";
    }
    const description = (found?.description || "").trim();
    const stats = [];
    const statPattern = /(\d[\d,.]*\s?[KkMm]?\+?)\s+(followers|following|repositories|connections|posts|stars)\b/gi;
    for (const [, value, label] of description.matchAll(statPattern)) {
      if (!stats.some(stat => stat.label == label.toLowerCase())) {
        stats.push({ value: value.replace(/\s/g, ""), label: label.toLowerCase() });
      }
    }
    let bio = description
      .replace(/^\S+ has \d[\d,]* repositor(?:y|ies) available\.?\s*/i, "")
      .replace(/Follow their code on GitHub\.?/i, "")
      .replace(/[·|]?\s*\d[\d,+]*\s+connections on LinkedIn\.?/i, "")
      .replace(/\s+/g, " ")
      .trim();
    bio = [headline, bio].filter(Boolean).join(" — ") || null;
    const initials = (name || slug).split(/[\s_.-]+/).filter(Boolean).slice(0, 2)
      .map(word => word.match(/[\p{L}\p{N}]/u)?.[0] ?? "").join("").toUpperCase();
    return {
      name: name || handle,
      handle,
      site,
      bio,
      stats,
      initials,
      image: found?.image?.startsWith("https://") ? found.image : null,
      url: profileUrl,
      loading,
    };
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
  // container, so its signed-in cookies), reading only its meta tags (and,
  // when they name no one, the oEmbed endpoint the page lists).
  async fetchProfile(win, url, userContextId) {
    const { text } = await this.fetchText(win, url, userContextId, ["text/html"]);
    const found = this.parseProfile(win, text, url);
    if (found) {
      return found;
    }
    const { oembed } = this.parseMeta(win, text);
    return oembed ? this.fetchOEmbed(win, oembed, url, userContextId).catch(() => null) : null;
  },

  // One GET as `userContextId`, with its cookies; no redirects, 1 MB and 8 s
  // at most, a 200 of one of `types` only. Resolves to { text }.
  async fetchText(win, url, userContextId, types) {
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
    channel.setRequestHeader("Accept", types.join(", "), false);
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
            ok &&= channel.responseStatus == 200 && types.includes(channel.contentType);
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
    return { text };
  },

  // DOMParser documents are inert: no scripts run, nothing loads.
  // wave9/mini W8-28: X and a signed-in LinkedIn serve pages with few or no
  // og: tags, so the card fell back to the bare handle. Each field now
  // falls back in turn: og: tags, then twitter: tags, then the page's
  // schema.org Person (JSON-LD, which LinkedIn and X put on profile pages),
  // then <title> and the description meta. Still meta and data only.
  parseProfile(win, text, url) {
    const found = this.parseMeta(win, text);
    if (!found.title) {
      return null;
    }
    return { title: found.title, url, description: found.description, image: found.image };
  },

  // Every field the page offers, plus its oEmbed endpoint when it lists one.
  parseMeta(win, text) {
    const doc = new win.DOMParser().parseFromString(text, "text/html");
    const meta = (...names) => {
      for (const name of names) {
        const value = doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`)
          ?.getAttribute("content")?.trim();
        if (value) {
          return value;
        }
      }
      return null;
    };
    const person = this.jsonLdPerson(doc);
    const cleanTitle = value => {
      // Signed-in tabs prefix the unread count: "(3) Jane Doe | LinkedIn".
      const title = String(value || "").replace(/^\(\d+\+?\)\s*/, "").replace(/\s+/g, " ").trim();
      return title && !GENERIC_TITLE.test(title) ? title : null;
    };
    let title = cleanTitle(meta("og:title", "twitter:title")) || cleanTitle(person?.name) ||
      cleanTitle(doc.title);
    if (title && LOGIN_TITLE.test(title)) {
      title = null;
    }
    const https = value => (typeof value == "string" && value.startsWith("https://") ? value : null);
    const oembed = doc.querySelector('link[rel="alternate"][type="application/json+oembed"]')?.getAttribute("href");
    return {
      title,
      description: meta("og:description", "twitter:description") || person?.description || meta("description") || null,
      image: https(meta("og:image", "twitter:image", "twitter:image:src")) || https(person?.image) ||
        https(doc.querySelector('link[rel="image_src"]')?.getAttribute("href")),
      oembed: https(oembed),
    };
  },

  // The first schema.org Person in the page's JSON-LD (anywhere in @graph,
  // mainEntity or author), as { name, description, image } strings.
  jsonLdPerson(doc) {
    const isPerson = node => [].concat(node?.["@type"] ?? []).includes("Person");
    const find = (node, depth = 0) => {
      if (!node || typeof node != "object" || depth > 4) {
        return null;
      }
      if (Array.isArray(node)) {
        for (const item of node) {
          const hit = find(item, depth + 1);
          if (hit) {
            return hit;
          }
        }
        return null;
      }
      if (isPerson(node)) {
        return node;
      }
      return find(node["@graph"], depth + 1) || find(node.mainEntity, depth + 1) || find(node.author, depth + 1);
    };
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try {
        data = JSON.parse(script.textContent);
      } catch {
        continue;
      }
      const node = find(data);
      if (!node) {
        continue;
      }
      const text = value => (typeof value == "string" ? value.trim() : Array.isArray(value) ?
        value.filter(item => typeof item == "string").join(" · ").trim() : "") || null;
      const image = [].concat(node.image ?? [])[0];
      return {
        name: text(node.name) || text([node.givenName, node.familyName].filter(Boolean).join(" ")),
        description: text(node.description) || text(node.jobTitle),
        image: typeof image == "string" ? image : image?.contentUrl || image?.url || null,
      };
    }
    return null;
  },

  // oEmbed, where the profile page lists an endpoint on its own site: the
  // author's name and photo. Same rules as the page fetch.
  async fetchOEmbed(win, endpoint, profileUrl, userContextId) {
    let url;
    try {
      url = new URL(endpoint);
    } catch {
      return null;
    }
    const site = siteOf(new URL(profileUrl).hostname);
    const host = siteOf(url.hostname);
    if (url.protocol != "https:" || (host != site && !host.endsWith(`.${site}`))) {
      return null;
    }
    const { text } = await this.fetchText(win, url.href, userContextId, ["application/json", "application/json+oembed", "text/json"]);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return null;
    }
    const title = typeof data?.author_name == "string" ? data.author_name.trim() :
      typeof data?.title == "string" ? data.title.trim() : "";
    if (!title || GENERIC_TITLE.test(title) || LOGIN_TITLE.test(title)) {
      return null;
    }
    const image = typeof data.thumbnail_url == "string" && data.thumbnail_url.startsWith("https://") ? data.thumbnail_url : null;
    return { title, url: profileUrl, description: null, image };
  },

  // wave9/mini W8-28: what the hovered link itself says about the person,
  // only on the profile's own site (a LinkedIn name link on LinkedIn, an X
  // avatar on X), so another page can't put a name on someone's profile.
  // The parent checks the page's site itself; the child's word isn't taken.
  // Returns { title, image } (either may be null) or null.
  pageContext(profileUrl, pageHost, context) {
    if (!context || !profileUrl || !pageHost) {
      return null;
    }
    const site = siteOf(new URL(profileUrl).hostname);
    if (siteOf(pageHost) != site) {
      return null;
    }
    let name = String(context.name || "").split("\n").map(line => line.trim()).find(Boolean) || "";
    name = name.replace(/\s+/g, " ").slice(0, 80);
    if (/^view\b/i.test(name) || LOGIN_TITLE.test(name)) {
      name = "";
    }
    let image = null;
    try {
      const src = new URL(context.image);
      if (src.protocol == "https:" && AVATAR_HOSTS[site]?.test(src.hostname)) {
        image = src.href;
      }
    } catch {}
    return name || image ? { title: name || null, url: profileUrl, description: null, image } : null;
  },

  // What the card shows: the lookup's fields first, the link's own context
  // for what the lookup lacks (or when there was no lookup).
  merge(found, context) {
    if (!context) {
      return found;
    }
    if (!found) {
      return context;
    }
    return {
      ...found,
      title: found.title || context.title,
      image: found.image || context.image,
    };
  },

  _resetForTests() {
    cache.clear();
    requestTimes = [];
  },
};
