/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave6/parity: Arc's non-AI tidy tab titles. Arc ships fixed rules for 52
// sites (a fixed name for a home page, or patterns to strip, like
// " | LinkedIn" or a "(3) " unread count); Arc Max's AI rename comes on
// top. Whimsy uses these first when a tab is pinned (WhimsyAITabs), so a
// tidy name works with AI off or killed.
//
// A rule matches when every condition holds: pathEquals / pathContainsRegex
// on the path, fragmentEquals / fragmentContainsRegex on the fragment
// (without "#"). Hosts match exactly, ignoring a leading "www.". The first
// matching rule wins.

import { TIDY_TITLES } from "resource:///modules/whimsy/WhimsyTidyTitlesData.sys.mjs";

const regexCache = new Map();
function regex(source) {
  if (!regexCache.has(source)) {
    let rx = null;
    try {
      rx = new RegExp(source);
    } catch (e) {
      console.warn(`Whimsy: tidy title pattern ${source}`, e);
    }
    regexCache.set(source, rx);
  }
  return regexCache.get(source);
}

function matches(match = {}, path, fragment) {
  if ("pathEquals" in match && path != match.pathEquals) {
    return false;
  }
  if ("fragmentEquals" in match && fragment != match.fragmentEquals) {
    return false;
  }
  if ("pathContainsRegex" in match && !regex(match.pathContainsRegex)?.test(path)) {
    return false;
  }
  if ("fragmentContainsRegex" in match && !regex(match.fragmentContainsRegex)?.test(fragment)) {
    return false;
  }
  return true;
}

export const WhimsyTidyTitles = {
  hostRules(host) {
    host = (host || "").toLowerCase().replace(/^www\./, "");
    if (TIDY_TITLES[host]) {
      return TIDY_TITLES[host];
    }
    if (host.endsWith(".atlassian.net")) {
      return TIDY_TITLES["atlassian.net"];
    }
    return null;
  },

  /**
   * Arc's tidy title for a page, or null when no rule applies or the
   * result would be empty or unchanged.
   *
   * @param {nsIURI|URL|string} uri
   * @param {string} title The page's own title.
   */
  tidy(uri, title) {
    let url;
    try {
      url = typeof uri == "string" ? new URL(uri) : new URL(uri.spec ?? uri.href);
    } catch (e) {
      return null;
    }
    if (!/^https?:$/.test(url.protocol)) {
      return null;
    }
    let site = this.hostRules(url.hostname);
    if (!site && /\/browse\/[A-Z0-9]+-[0-9]+/.test(url.pathname) && / - (?:Jira|Atlassian.*)$/.test(title ?? "")) {
      site = TIDY_TITLES["atlassian.net"];
    }
    if (!site) {
      return null;
    }
    const fragment = url.hash.replace(/^#/, "");
    const rule = site.rules?.find(r => matches(r.match, url.pathname, fragment));
    if (!rule) {
      return null;
    }
    let result;
    if (rule.title?.always) {
      result = rule.title.always;
    } else {
      const patterns = rule.title?.removingPatterns ?? (rule.title?.removingPattern ? [rule.title.removingPattern] : []);
      result = title ?? "";
      for (const pattern of patterns) {
        const rx = regex(pattern);
        if (rx) {
          result = result.replace(rx, "");
        }
      }
    }
    result = result.trim();
    return result && result != (title ?? "").trim() ? result : null;
  },
};
