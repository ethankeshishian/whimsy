/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave3/cmdbar: DuckDuckGo-style bangs ("!w black holes", "jazz !yt")
// resolved on this machine. DuckDuckGo resolves a bang on its own server and
// redirects; here the command bar maps it straight to the destination's
// search URL, so it works with whatever search engine is the default, costs
// no round trip and tells no search engine what you looked up. The catalog
// is plain text ("!key https://...{{{s}}}" per line): ~100 curated bangs
// ship in WhimsyBangsData, and Settings → Search edits the list.
import { UrlbarProvider } from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import { UrlbarShared } from "chrome://browser/content/urlbar/UrlbarShared.mjs";
import { DEFAULT_BANGS } from "resource:///modules/whimsy/WhimsyBangsData.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ProvidersManager: "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
});

const FEATURE = "whimsy.feature.offline-bangs";
const CUSTOM = "whimsy.bangs.custom";
const SLOT = "{{{s}}}";
const MAX_TEXT = 100000;
const KEY = "[a-z0-9_.-]+";
const LEADING = new RegExp(`^!(${KEY})(?:\\s+([^]*))?$`, "i");
const TRAILING = new RegExp(`^([^]*?)\\s+!(${KEY})$`, "i");
const ANY_BANG = new RegExp(`(^|\\s)!${KEY}(?=\\s|$)`, "i");

let cachedText = null;
let cachedTable = new Map();

export const WhimsyBangs = {
  DEFAULT_BANGS,

  // No user value means the bundled list. A saved empty list means "no
  // bangs"; Restore Defaults clears the pref.
  get text() {
    return Services.prefs.prefHasUserValue(CUSTOM) ? Services.prefs.getStringPref(CUSTOM, "") : DEFAULT_BANGS;
  },

  // Throws an Error whose message is the 1-based bad line ("limit" when the
  // text is too long), so a typo can never replace a working list.
  parse(text) {
    if (text.length > MAX_TEXT) {
      throw new Error("limit");
    }
    const table = new Map();
    for (const [index, raw] of text.split(/\r?\n/).entries()) {
      const line = raw.trim();
      if (!line) {
        continue;
      }
      const match = line.match(new RegExp(`^!(${KEY})\\s+(\\S+)$`, "i"));
      const key = match?.[1].toLowerCase();
      const template = match?.[2];
      let url = null;
      if (template && template.split(SLOT).length == 2) {
        try {
          url = new URL(template.replace(SLOT, "q"));
        } catch {}
      }
      if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password || table.has(key)) {
        throw new Error(String(index + 1));
      }
      table.set(key, template);
    }
    return table;
  },

  table() {
    const text = this.text;
    if (text !== cachedText) {
      cachedText = text;
      try {
        cachedTable = this.parse(text);
      } catch {
        // A hand-edited pref that doesn't parse: no bangs, normal search.
        cachedTable = new Map();
      }
    }
    return cachedTable;
  },

  save(text) {
    this.parse(text);
    Services.prefs.setStringPref(CUSTOM, text);
  },

  reset() {
    Services.prefs.clearUserPref(CUSTOM);
  },

  // "!w query", "query !w" or a bare "!w" (the site's home page). Returns
  // null for anything else, including two bangs or an unknown one, so the
  // text goes to the normal search engine untouched.
  resolve(input) {
    if (!Services.prefs.getBoolPref(FEATURE, true) || typeof input != "string") {
      return null;
    }
    const text = input.trim();
    let key, query;
    let match = text.match(LEADING);
    if (match) {
      [, key, query = ""] = match;
    } else if ((match = text.match(TRAILING))) {
      [, query, key] = match;
    } else {
      return null;
    }
    query = query.trim();
    if (ANY_BANG.test(query)) {
      return null;
    }
    key = key.toLowerCase();
    const template = this.table().get(key);
    if (!template) {
      return null;
    }
    try {
      const url = query ? template.replace(SLOT, encodeURIComponent(query)) : new URL(template.replace(SLOT, "")).origin + "/";
      return { key, query, url };
    } catch {
      // encodeURIComponent throws on lone surrogates.
      return null;
    }
  },

  init() {
    const manager = lazy.ProvidersManager.getInstanceForSap("urlbar");
    if (!manager.getProvider("WhimsyBangs")) {
      manager.registerProvider(new WhimsyBangsProvider());
    }
  },
};

export class WhimsyBangsProvider extends UrlbarProvider {
  get name() {
    return "WhimsyBangs";
  }

  get type() {
    return UrlbarShared.PROVIDER_TYPE.HEURISTIC;
  }

  // Above everything else (engine aliases, search suggestions): a bang is
  // an explicit command, like a bookmark keyword, and Enter must follow it.
  getPriority() {
    return 100;
  }

  async isActive(context) {
    return !context.searchMode && !context.restrictSource && !!WhimsyBangs.resolve(context.searchString);
  }

  async startQuery(context, addCallback) {
    const bang = WhimsyBangs.resolve(context.searchString);
    if (!bang) {
      return;
    }
    const host = new URL(bang.url).host;
    addCallback(
      this,
      new lazy.UrlbarResult({
        type: UrlbarShared.RESULT_TYPE.KEYWORD,
        source: UrlbarShared.RESULT_SOURCE.OTHER_LOCAL,
        group: UrlbarShared.RESULT_GROUP.HEURISTIC_BOOKMARK_KEYWORD,
        heuristic: true,
        payload: {
          title: bang.query ? `${host}: ${bang.query}` : host,
          url: bang.url,
          keyword: `!${bang.key}`,
          input: context.searchString,
          icon: `page-icon:${new URL(bang.url).origin}/`,
        },
      })
    );
  }
}
