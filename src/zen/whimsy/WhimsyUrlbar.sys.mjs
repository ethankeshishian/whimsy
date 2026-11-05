/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Show the full URL on click (Safari's "Show full website address"; Arc
// shows just the domain until you interact, then reveals the full, selected,
// editable URL on a single click). Firefox/Zen already untrim to the full
// https://... URL on focus (browser.urlbar.untrimOnUserInteraction.featureGate,
// zen.urlbar.show-domain-only-in-sidebar); this adds:
// - a single click selects the whole untrimmed URL (Arc), always;
// - a Settings checkbox, "Always show full address", for people who want the
//   full URL even without clicking (writes trimURLs/show-domain-only-in-sidebar).
// whimsy.feature.full-url-click gates the click-to-select behavior; turning
// it off leaves Firefox/Zen's own focus handling alone. The "always show"
// checkbox works independently of the switch.

// W16-25: a dotless host (go/, intranet/) becomes an address once you've
// typed it and it loaded, as in Chrome: go/workday then opens
// http://go/workday instead of searching. Firefox only learns one from its
// "Did you mean to go to…" bar, which is off by default
// (browser.urlbar.dnsResolveSingleWordsAfterSearch = 0); this sets the same
// pref that bar sets, browser.fixup.domainwhitelist.<host>, which URIFixup
// reads live. Typed visits only (a link or a redirect to http://somehost/
// doesn't count), http(s) only, never an IP address; private windows add
// no visits, so they never teach a host. Once at startup, hosts already
// typed (moz_places.typed) are learned too.
const KNOWN_HOST_BRANCH = "browser.fixup.domainwhitelist.";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.full-url-click";
const ALWAYS_FULL_PREF = "whimsy.urlbar.always-full-url";
const MIRROR_PREFS = {
  "zen.urlbar.show-domain-only-in-sidebar": false,
  "browser.urlbar.trimURLs": false,
};

export const WhimsyUrlbar = {
  get clickToSelectEnabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  initWindow(win) {
    this.learnTypedHosts();
    const { gURLBar } = win;
    if (!gURLBar) {
      return;
    }
    gURLBar.inputField.addEventListener("click", () => {
      if (!this.clickToSelectEnabled) {
        return;
      }
      // Let gURLBar's own focus/untrim handler run first.
      win.setTimeout(() => {
        if (win.document.activeElement == gURLBar.inputField) {
          gURLBar.select();
        }
      }, 0);
    });

    const update = () => this.applyAlwaysFull();
    Services.prefs.addObserver(ALWAYS_FULL_PREF, update);
    win.addEventListener("unload", () => Services.prefs.removeObserver(ALWAYS_FULL_PREF, update), {
      once: true,
    });
    // Once globally is enough (it writes global prefs, not per-window state),
    // but observing per window keeps Settings responsive without a restart.
    update();
  },

  /** The dotless host `url` would teach, or null. */
  dotlessHost(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol != "http:" && parsed.protocol != "https:") {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    // No dot, not an IPv6 literal, not a number (http://2130706433/ is an
    // IPv4 address), not localhost (always known).
    if (!host || host.includes(".") || host.startsWith("[") || /^(0x[0-9a-f]+|\d+)$/i.test(host) || host == "localhost") {
      return null;
    }
    return host;
  },

  learnHost(url) {
    const host = this.dotlessHost(url);
    if (!host || Services.prefs.getBoolPref(KNOWN_HOST_BRANCH + host, false)) {
      return false;
    }
    Services.prefs.setBoolPref(KNOWN_HOST_BRANCH + host, true);
    return true;
  },

  learnTypedHosts() {
    if (this._learning) {
      return;
    }
    this._learning = true;
    const { PlacesUtils } = lazy;
    this._onVisits = events => {
      for (const event of events) {
        if (event.type == "page-visited" && event.transitionType == PlacesUtils.history.TRANSITION_TYPED) {
          this.learnHost(event.url);
        }
      }
    };
    PlacesObservers.addListener(["page-visited"], this._onVisits);
    // Hosts typed before this existed.
    Services.tm.idleDispatchToMainThread(() => {
      this.learnFromHistory().catch(e => console.error("Whimsy: learning typed hosts", e));
    }, 5000);
  },

  async learnFromHistory() {
    const db = await lazy.PlacesUtils.promiseDBConnection();
    // rev_host is the host reversed with a trailing dot ("og." for go), so a
    // dotless host has exactly that one dot.
    const rows = await db.executeCached(
      `SELECT url FROM moz_places
       WHERE typed = 1 AND (url BETWEEN 'http://' AND 'http://~' OR url BETWEEN 'https://' AND 'https://~')
         AND instr(substr(rev_host, 1, length(rev_host) - 1), '.') = 0`
    );
    let learned = 0;
    for (const row of rows) {
      learned += this.learnHost(row.getResultByName("url")) ? 1 : 0;
    }
    return learned;
  },

  applyAlwaysFull() {
    const always = Services.prefs.getBoolPref(ALWAYS_FULL_PREF, false);
    const defaults = Services.prefs.getDefaultBranch("");
    for (const [name, valueWhenAlways] of Object.entries(MIRROR_PREFS)) {
      if (always) {
        Services.prefs.setBoolPref(name, valueWhenAlways);
      } else if (Services.prefs.prefHasUserValue(name) && Services.prefs.getBoolPref(name) == valueWhenAlways) {
        // Only clear what we set; leave an unrelated user override alone.
        try {
          Services.prefs.setBoolPref(name, defaults.getBoolPref(name));
        } catch (e) {}
      }
    }
  },
};
