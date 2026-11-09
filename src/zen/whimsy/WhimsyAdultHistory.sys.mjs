/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W24: keep adult sites out of history (after the Lens browser; owner
// approved). The page itself loads normally; what changes is what's
// remembered. A visit to an adult site never lands in history, so it's
// never in the Library, the address bar's suggestions and autofill, or the
// command bar's Recent; a closed adult tab leaves Recently Closed (and the
// Archive, a view over it); the meaning index (Related), memory, and Year
// in tabs never record it.
//
// Two on-device signals, nothing sent anywhere:
//  1. Firefox's own list (FilterAdult, the Rust filter_adult component): a
//     static set of MD5-hashed base domains, checked when a top-level page
//     load opens, before the visit is written. The tab's browsing context
//     is told not to use global history for that load (the same switch the
//     docshell checks before every visit and title update).
//  2. A page that labels itself: <meta name="rating" content="adult"> or the
//     RTA label (Google's and ASACP's), found by WhimsyAdultHistoryChild at
//     DOMContentLoaded, or an HTTP Rating header. A visit already written is
//     removed (Places removal also clears its autocomplete, frecency and
//     icon), and only that page is remembered for the session, so a site
//     with one labelled page keeps the rest of its history.
//
// whimsy.feature.adult-history is the feature switch; the person's switch
// is Settings › Privacy › "Keep adult sites out of history"
// (whimsy.adult-history.enabled, on by default).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  FilterAdultComponent: "moz-src:///toolkit/components/uniffi-bindgen-gecko-js/components/generated/RustFilterAdult.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
  Whimsy: "resource:///modules/whimsy/Whimsy.sys.mjs",
});

const FEATURE = "adult-history";
const PREF = "whimsy.adult-history.enabled";
// Google's and ASACP's self-labels, compared lower-case.
const LABELS = new Set(["adult", "rta-5042-1996-1400-1577-rta"]);

let filter = null;
// Hex MD5s of stand-in base domains, for tests only (never real domains).
const testHashes = new Set();
// Pages that labelled themselves this session (no fragment).
const labelled = new Set();
// Browsing contexts this module took out of global history.
const disabled = new WeakSet();

function withoutRef(url) {
  try {
    return Services.io.newURI(url).specIgnoringRef;
  } catch {
    return String(url ?? "");
  }
}

function md5Hex(text) {
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
  hash.init(Ci.nsICryptoHash.MD5);
  const bytes = new TextEncoder().encode(text);
  hash.update(bytes, bytes.length);
  return [...hash.finish(false)].map(c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

function baseDomain(uri) {
  try {
    return Services.eTLD.getBaseDomain(uri);
  } catch {
    return uri.asciiHost ?? "";
  }
}

export const WhimsyAdultHistory = {
  FEATURE,
  PREF,

  get on() {
    return lazy.Whimsy.featureEnabled(FEATURE) && Services.prefs.getBoolPref(PREF, true);
  },

  /** Whether a page's address is an adult site's (the list, or a page that labelled itself). */
  isAdultUrl(url) {
    if (!url) {
      return false;
    }
    let uri;
    try {
      uri = typeof url == "string" ? Services.io.newURI(url) : url;
    } catch {
      return false;
    }
    if (!uri.schemeIs("http") && !uri.schemeIs("https")) {
      return false;
    }
    if (labelled.has(uri.specIgnoringRef)) {
      return true;
    }
    const domain = baseDomain(uri);
    if (!domain) {
      return false;
    }
    if (testHashes.size && testHashes.has(md5Hex(domain))) {
      return true;
    }
    try {
      filter ??= lazy.FilterAdultComponent.init();
      return filter.contains(domain);
    } catch {
      return false;
    }
  },

  /** For the other history-like stores: false when this page must not be kept. */
  keeps(url) {
    return !(this.on && this.isAdultUrl(url));
  },

  /** The same for a tab: false when its page must not be kept. */
  keepsTab(tab) {
    return this.keeps(tab?.linkedBrowser?.currentURI?.spec);
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    Services.obs.addObserver(this, "http-on-opening-request");
    Services.obs.addObserver(this, "http-on-examine-response");
    Services.obs.addObserver(this, "sessionstore-closed-objects-changed");
    this._placesListener = events => {
      if (!this.on) {
        return;
      }
      for (const event of events) {
        // Backstop: a visit written anyway (a page found adult after its
        // load opened, or a browsing context swapped mid-load) goes again.
        if (event.type == "page-visited" && this.isAdultUrl(event.url)) {
          lazy.PlacesUtils.history.remove(event.url).catch(() => {});
        }
      }
    };
    lazy.PlacesUtils.observers.addListener(["page-visited"], this._placesListener);
  },

  // The browsing context a top-level page load lands in, or null.
  _topContext(channel) {
    try {
      const info = channel.loadInfo;
      if (info?.externalContentPolicyType != Ci.nsIContentPolicy.TYPE_DOCUMENT) {
        return null;
      }
      const bc = info.targetBrowsingContext ?? info.browsingContext;
      return bc?.isContent && !bc.parent ? bc : null;
    } catch {
      return null;
    }
  },

  _setHistory(bc, use) {
    try {
      if (!use && bc.useGlobalHistory) {
        bc.useGlobalHistory = false;
        disabled.add(bc);
      } else if (use && disabled.has(bc)) {
        bc.useGlobalHistory = true;
        disabled.delete(bc);
      }
    } catch (e) {
      console.error("WhimsyAdultHistory: history switch", e);
    }
  },

  observe(subject, topic) {
    switch (topic) {
      case "http-on-opening-request": {
        // Before the visit: a redirect opens a new channel, so each hop is
        // decided as it opens (the redirect's source visit is written with
        // the switch its own load set).
        const channel = subject.QueryInterface(Ci.nsIChannel);
        const bc = this._topContext(channel);
        if (bc) {
          this._setHistory(bc, !(this.on && this.isAdultUrl(channel.URI)));
        }
        break;
      }
      case "http-on-examine-response": {
        if (!this.on) {
          break;
        }
        const channel = subject.QueryInterface(Ci.nsIHttpChannel);
        const bc = this._topContext(channel);
        if (!bc) {
          break;
        }
        let rating = "";
        try {
          rating = channel.getResponseHeader("Rating");
        } catch {
          // No header.
        }
        if (LABELS.has(rating.trim().toLowerCase())) {
          labelled.add(channel.URI.specIgnoringRef);
          this._setHistory(bc, false);
        }
        break;
      }
      case "sessionstore-closed-objects-changed":
        if (this.on) {
          this.scrubClosedTabs();
        }
        break;
    }
  },

  // Recently Closed (and the Archive over it): a closed tab that had an
  // adult page anywhere in its back/forward list is forgotten.
  scrubClosedTabs() {
    if (this._scrubbing) {
      return;
    }
    this._scrubbing = true;
    try {
      const adult = tabData => (tabData?.state?.entries ?? []).some(entry => this.isAdultUrl(entry.url));
      for (const win of lazy.BrowserWindowTracker.orderedWindows) {
        if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
          continue;
        }
        for (const tabData of lazy.SessionStore.getClosedTabDataForWindow(win)) {
          if (adult(tabData)) {
            lazy.SessionStore.forgetClosedTabById(tabData.closedId, win);
          }
        }
      }
      for (const tabData of lazy.SessionStore.getClosedTabDataFromClosedWindows()) {
        if (adult(tabData)) {
          lazy.SessionStore.forgetClosedTabById(tabData.closedId, { sourceClosedId: tabData.sourceClosedId });
        }
      }
    } catch (e) {
      console.error("WhimsyAdultHistory: closed tabs", e);
    } finally {
      this._scrubbing = false;
    }
  },

  /**
   * A page that labelled itself after its visit was written: remember it,
   * keep the rest of its load out of history, and take back what's stored.
   */
  async forgetLabelledPage(browsingContext, url) {
    if (!this.on || !url) {
      return;
    }
    const spec = withoutRef(url);
    labelled.add(spec);
    if (browsingContext && !browsingContext.parent) {
      this._setHistory(browsingContext, false);
    }
    await lazy.PlacesUtils.history.remove(spec).catch(() => {});
    if (spec != url) {
      await lazy.PlacesUtils.history.remove(url).catch(() => {});
    }
    const { WhimsyAIIndex } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIIndex.sys.mjs");
    await WhimsyAIIndex.forget(spec).catch(() => {});
  },

  _addTestHashForTesting(hex) {
    testHashes.add(hex);
  },

  _md5ForTesting(text) {
    return md5Hex(text);
  },

  _resetForTesting() {
    testHashes.clear();
    labelled.clear();
  },
};

// The page's self-label, found by WhimsyAdultHistoryChild. The address is
// the parent's own record of the document, never the page's word.
export class WhimsyAdultHistoryParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name != "Labelled") {
      return;
    }
    const url = this.manager.documentURI?.spec;
    const bc = this.manager.browsingContext;
    if (!url || bc.parent || !/^https?:/.test(url)) {
      return;
    }
    WhimsyAdultHistory.forgetLabelledPage(bc, url).catch(console.error);
  }
}
