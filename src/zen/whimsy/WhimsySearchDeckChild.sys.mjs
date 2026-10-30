/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave6/search: Instant result and the Search Deck, the page side. Only
// ever runs in the hidden, sandboxed browser WhimsySearchDeck loads a search
// results page into (messagemanagergroup "headless-browsers"); it reads the
// result links and answers, nothing else. Results-page markup changes, so
// each engine has a small adapter, with a generic fallback (links that wrap
// a heading and leave the site) for everything else.

const MAX_RESULTS = 10;
const POLL_MS = 250;
const POLL_TRIES = 12;

// hostname pattern -> selectors for result title links, best first.
const ADAPTERS = [
  { host: /(^|\.)google\.[a-z.]+$/, selectors: ["#rso a[href]:has(> h3)", "#search a[href]:has(h3)"] },
  { host: /(^|\.)bing\.com$/, selectors: ["#b_results li.b_algo h2 a[href]"] },
  {
    host: /(^|\.)duckduckgo\.com$/,
    selectors: ['a[data-testid="result-title-a"]', "a.result__a", "a.result-link"],
  },
  { host: /(^|\.)search\.brave\.com$/, selectors: ['#results .snippet[data-type="web"] a[href^="http"]'] },
  { host: /(^|\.)kagi\.com$/, selectors: ["a.__sri_title_link", ".__sri-title a[href]"] },
  { host: /(^|\.)startpage\.com$/, selectors: ["a.result-title", ".w-gl__result-title"] },
  { host: /(^|\.)ecosia\.org$/, selectors: ['[data-test-id="result-link"]', "a.result__link"] },
];

// Rough registrable domain: good enough to tell the engine's own links
// (images.google.com, support.google.com) from results.
function siteOf(hostname) {
  const parts = hostname.replace(/^www\./, "").split(".");
  const tail = parts.slice(-2).join(".");
  // co.uk, com.au...: keep one more label.
  return parts.length > 2 && /^(co|com|org|net|ac|gov|edu)\.[a-z]{2}$/.test(tail) ? parts.slice(-3).join(".") : tail;
}

// Redirect wrappers (/url?q=, /l/?uddg=, bing's u=a1<base64>) -> the target.
export function unwrapResultUrl(href, pageUrl) {
  let url;
  try {
    url = new URL(href, pageUrl);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) {
    return null;
  }
  let page;
  try {
    page = new URL(pageUrl);
  } catch {
    return url.href;
  }
  if (siteOf(url.hostname) != siteOf(page.hostname)) {
    return url.href;
  }
  for (const name of ["uddg", "url", "q", "u", "target"]) {
    let value = url.searchParams.get(name);
    if (!value) {
      continue;
    }
    if (name == "u" && /^a1/.test(value)) {
      try {
        value = atob(value.slice(2).replace(/-/g, "+").replace(/_/g, "/"));
      } catch {
        continue;
      }
    }
    if (/^https?:\/\//i.test(value)) {
      try {
        const target = new URL(value);
        return siteOf(target.hostname) == siteOf(page.hostname) ? null : target.href;
      } catch {}
    }
  }
  // The engine's own page (images, settings, related searches).
  return null;
}

function linkTitle(link) {
  const heading = link.querySelector("h1, h2, h3, h4");
  return (heading?.textContent || link.textContent || "").replace(/\s+/g, " ").trim();
}

/**
 * The results on a search results page, in order.
 *
 * @param {Document} document
 * @returns {Array<{ url: string, title: string }>}
 */
export function extractResults(document, limit = MAX_RESULTS) {
  const pageUrl = document.location.href;
  const hostname = document.location.hostname;
  const adapter = ADAPTERS.find(a => a.host.test(hostname));
  let links = [];
  for (const selector of adapter?.selectors ?? []) {
    try {
      links = [...document.querySelectorAll(selector)];
    } catch {
      links = [];
    }
    if (links.length) {
      break;
    }
  }
  if (!links.length) {
    // Generic: links wrapping a heading, else any link off the site, inside
    // the main content when the page marks it.
    const root = document.querySelector("main, [role=main]") ?? document.body;
    if (!root) {
      return [];
    }
    const all = [...root.querySelectorAll("a[href]")];
    const headed = all.filter(a => a.querySelector("h1, h2, h3, h4"));
    links = headed.length ? headed : all;
  }
  const seen = new Set();
  const results = [];
  for (const link of links) {
    const url = unwrapResultUrl(link.getAttribute("href"), pageUrl);
    if (!url || seen.has(url)) {
      continue;
    }
    const title = linkTitle(link);
    if (!title) {
      continue;
    }
    seen.add(url);
    results.push({ url, title: title.slice(0, 200) });
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

export class WhimsySearchDeckChild extends JSWindowActorChild {
  async receiveMessage({ name, data }) {
    if (name != "WhimsySearchDeck:Read") {
      return null;
    }
    const limit = Math.min(Math.max(Number(data?.limit) || MAX_RESULTS, 1), MAX_RESULTS);
    // Client-rendered result pages (DuckDuckGo) fill in after load.
    for (let i = 0; i < POLL_TRIES; i++) {
      const doc = this.document;
      if (!doc) {
        return [];
      }
      const results = extractResults(doc, limit);
      if (results.length) {
        return results;
      }
      await new Promise(resolve => this.contentWindow?.setTimeout(resolve, POLL_MS) ?? resolve());
    }
    return [];
  }
}
