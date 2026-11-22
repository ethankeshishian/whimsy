/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W29: WebKit tabs (lane 1: engine-tab model, switching, indicator).
// Gecko stays the engine everywhere by default; WebKit is used only for a tab
// you switch or a site you add to Engines for Sites (whimsy.webkit.sites).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PanelMultiView: "moz-src:///browser/components/customizableui/PanelMultiView.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  ReaderMode: "moz-src:///toolkit/components/reader/ReaderMode.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyPanels: "resource:///modules/whimsy/WhimsyPanels.sys.mjs",
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
  WhimsySiteSettings: "resource:///modules/whimsy/WhimsySiteSettings.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
  WhimsyVerbs: "resource:///modules/whimsy/WhimsyVerbs.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.webkit-tabs";
const SITES_PREF = "whimsy.webkit.sites";
const DATASTORES_PREF = "whimsy.webkit.datastores";

const PILL_ID = "whimsy-webkit-pill";
const EXT_PANEL_ID = "unified-extensions-panel";
const EXT_SECTION_ID = "whimsy-webkit-extensions-engine-section";
const SITE_PANEL_ID = "zen-unified-site-data-panel";
const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
// The engine verbs use Whimsy's globe (Library's "Open site" mark); Zen has no compass.
const GLOBE = "chrome://browser/content/whimsy/icons/globe-line.svg";

// Map XUL VK_* keycode names to macOS Carbon virtual key codes so keyset
// bindings using keycode="VK_*" are matched by the native NSEvent monitor.
const MAC_KEYCODES = {
  VK_RETURN: 36,
  VK_TAB: 48,
  VK_SPACE: 49,
  VK_BACK: 51,
  VK_ESCAPE: 53,
  VK_F5: 96,
  VK_F6: 97,
  VK_F7: 98,
  VK_F3: 99,
  VK_F8: 100,
  VK_F9: 101,
  VK_F11: 103,
  VK_F10: 109,
  VK_F12: 111,
  VK_HOME: 115,
  VK_PAGE_UP: 116,
  VK_DELETE: 117,
  VK_F4: 118,
  VK_END: 119,
  VK_F2: 120,
  VK_PAGE_DOWN: 121,
  VK_F1: 122,
  VK_LEFT: 123,
  VK_RIGHT: 124,
  VK_DOWN: 125,
  VK_UP: 126,
};

function isWebURI(uri) {
  return !!uri && (uri.schemeIs("http") || uri.schemeIs("https"));
}

function safeNewURI(spec) {
  if (!spec || typeof spec != "string") {
    return null;
  }
  try {
    return Services.io.newURI(spec);
  } catch {
    return null;
  }
}

export const WhimsyWebKit = {
  _service: undefined,
  _verbsRegistered: false,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  get service() {
    if (this._service === undefined) {
      try {
        this._service =
          Cc["@mozilla.org/whimsy/webkit;1"]?.getService(Ci.nsIWhimsyWebKit) ??
          null;
      } catch {
        this._service = null;
      }
    }
    return this._service;
  },

  isWindowPrivate(win) {
    return !!win && lazy.PrivateBrowsingUtils.isWindowPrivate(win);
  },

  isTabPrivate(tab) {
    if (!tab) {
      return false;
    }
    const win = tab.ownerDocument?.defaultView;
    if (this.isWindowPrivate(win)) {
      return true;
    }
    if (lazy.WhimsyPrivate?.isPrivateTab?.(tab)) {
      return true;
    }
    const browser = tab.linkedBrowser;
    return !!(browser && lazy.PrivateBrowsingUtils.isBrowserPrivate(browser));
  },

  available(win = null) {
    if (!this.enabled) {
      return false;
    }
    if (win && (this.isWindowPrivate(win) || win._whimsyQuickWindow)) {
      return false;
    }
    try {
      return !!this.service?.available(win);
    } catch {
      return false;
    }
  },

  availableForTab(tab) {
    const win = tab?.ownerDocument?.defaultView;
    return !!win && this.available(win) && !this.isTabPrivate(tab);
  },

  isWebKitTab(tab) {
    return !!tab?._whimsyWebKitState;
  },

  stateOf(tab) {
    return tab?._whimsyWebKitState ?? null;
  },

  // -------------------------------------------------------------------------
  // Per-profile persistent WKWebsiteDataStore UUIDs.

  profileKeyOf(userContextId = 0) {
    try {
      return lazy.WhimsyProfiles.keyFor(userContextId || 0) || "default";
    } catch {
      return userContextId ? `uc-${userContextId}` : "default";
    }
  },

  dataStoreIdForTab(tab) {
    const userContextId =
      tab?.userContextId ||
      tab?.linkedBrowser?.browsingContext?.originAttributes?.userContextId ||
      0;
    return this.dataStoreIdForProfile(userContextId);
  },

  dataStoreIdForProfile(userContextId = 0) {
    const key = this.profileKeyOf(userContextId);
    let map = {};
    try {
      const raw = Services.prefs.getStringPref(DATASTORES_PREF, "{ }").trim();
      const parsed = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed == "object" && !Array.isArray(parsed)) {
        map = parsed;
      }
    } catch {}
    let uuid = map[key];
    if (
      typeof uuid != "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        uuid
      )
    ) {
      uuid = Services.uuid
        .generateUUID()
        .toString()
        .replace(/^\{|\}$/g, "");
      map[key] = uuid;
      Services.prefs.setStringPref(DATASTORES_PREF, JSON.stringify(map));
    }
    return uuid;
  },

  // -------------------------------------------------------------------------
  // Engine choice model: whimsy.webkit.sites (JSON list of host patterns, per
  // profile) and per-tab override.

  _readSitesPref() {
    try {
      const raw = Services.prefs.getStringPref(SITES_PREF, "[]").trim();
      if (!raw) {
        return [];
      }
      return JSON.parse(raw);
    } catch {
      return [];
    }
  },

  normalizePattern(pattern) {
    return String(pattern ?? "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
  },

  getSites(userContextId = 0) {
    const parsed = this._readSitesPref();
    const key = this.profileKeyOf(userContextId);
    let list = [];
    if (Array.isArray(parsed)) {
      list = parsed;
    } else if (parsed && typeof parsed == "object") {
      list =
        parsed[key] ??
        parsed[String(userContextId || 0)] ??
        (userContextId == 0 ? parsed.default : null) ??
        [];
    }
    if (!Array.isArray(list)) {
      return [];
    }
    const out = [];
    for (const item of list) {
      const norm = this.normalizePattern(item);
      if (norm && !out.includes(norm)) {
        out.push(norm);
      }
    }
    return out;
  },

  setSites(sites, userContextId = 0) {
    const clean = [];
    for (const item of sites ?? []) {
      const norm = this.normalizePattern(item);
      if (norm && !clean.includes(norm)) {
        clean.push(norm);
      }
    }
    const parsed = this._readSitesPref();
    const key = this.profileKeyOf(userContextId);
    if (
      userContextId == 0 &&
      (Array.isArray(parsed) || !parsed || typeof parsed != "object")
    ) {
      Services.prefs.setStringPref(SITES_PREF, JSON.stringify(clean));
      return clean;
    }
    const map =
      parsed && typeof parsed == "object" && !Array.isArray(parsed)
        ? { ...parsed }
        : { [this.profileKeyOf(0)]: Array.isArray(parsed) ? parsed : [] };
    map[key] = clean;
    Services.prefs.setStringPref(SITES_PREF, JSON.stringify(map));
    return clean;
  },

  matchesHostPattern(host, pattern) {
    const h = String(host ?? "").trim().toLowerCase();
    const p = this.normalizePattern(pattern);
    if (!h || !p) {
      return false;
    }
    if (h == p) {
      return true;
    }
    if (p.startsWith("*.")) {
      const suffix = p.slice(2);
      return !!suffix && (h == suffix || h.endsWith(`.${suffix}`));
    }
    return false;
  },

  isSiteInWebKit(host, userContextId = 0) {
    if (!host) {
      return false;
    }
    return this.getSites(userContextId).some(pattern =>
      this.matchesHostPattern(host, pattern)
    );
  },

  addSite(host, userContextId = 0) {
    const norm = this.normalizePattern(host);
    if (!norm) {
      return false;
    }
    const sites = this.getSites(userContextId);
    if (!sites.includes(norm)) {
      sites.push(norm);
      this.setSites(sites, userContextId);
    }
    return true;
  },

  removeSite(host, userContextId = 0) {
    const norm = this.normalizePattern(host);
    if (!norm) {
      return false;
    }
    const sites = this.getSites(userContextId).filter(
      pattern => pattern != norm && !this.matchesHostPattern(norm, pattern)
    );
    this.setSites(sites, userContextId);
    return true;
  },

  currentURIOf(tab) {
    if (!tab) {
      return null;
    }
    if (this.isWebKitTab(tab)) {
      return tab._whimsyWebKitState.uri ?? null;
    }
    let uri = tab.linkedBrowser?.currentURI ?? null;
    if (uri?.spec.startsWith("about:reader")) {
      try {
        const orig = lazy.ReaderMode.getOriginalUrl(uri.spec);
        uri = orig ? Services.io.newURI(orig) : null;
      } catch {
        uri = null;
      }
    }
    return uri;
  },

  currentHostOf(tab) {
    const uri = this.currentURIOf(tab);
    if (!isWebURI(uri)) {
      return "";
    }
    try {
      return (uri.asciiHost || "").toLowerCase();
    } catch {
      return "";
    }
  },

  // -------------------------------------------------------------------------
  // Switching a tab between Firefox (Gecko) and WebKit in place.

  async setTabEngine(tab, engine, { persistSite = null } = {}) {
    if (!tab || !this.availableForTab(tab)) {
      return false;
    }
    const host = this.currentHostOf(tab);
    const userContextId = tab.userContextId || 0;
    if (persistSite === true && host) {
      this.addSite(host, userContextId);
    } else if (persistSite === false && host) {
      this.removeSite(host, userContextId);
    }

    if (engine == "webkit") {
      tab._whimsyWebKitOverride = "webkit";
      tab._whimsyWebKitOverrideHost = host;
      return this.switchTab(tab, "webkit");
    }
    tab._whimsyWebKitOverride = "firefox";
    tab._whimsyWebKitOverrideHost = host;
    return this.switchTab(tab, "firefox");
  },

  async setAlwaysUseForTab(tab, alwaysUse) {
    if (!tab || !this.availableForTab(tab)) {
      return false;
    }
    const host = this.currentHostOf(tab);
    if (!host) {
      return false;
    }
    const userContextId = tab.userContextId || 0;
    if (alwaysUse) {
      this.addSite(host, userContextId);
      tab._whimsyWebKitOverride = "webkit";
      tab._whimsyWebKitOverrideHost = host;
      if (!this.isWebKitTab(tab)) {
        await this.switchTab(tab, "webkit");
      } else {
        this.refreshUI(tab.ownerDocument?.defaultView);
      }
      return true;
    }
    this.removeSite(host, userContextId);
    tab._whimsyWebKitOverride = null;
    tab._whimsyWebKitOverrideHost = null;
    if (this.isWebKitTab(tab)) {
      await this.switchTab(tab, "firefox");
    } else {
      this.refreshUI(tab.ownerDocument?.defaultView);
    }
    return true;
  },

  async switchTab(tab, engine, { url = null, waitForLoad = true } = {}) {
    const win = tab?.ownerDocument?.defaultView;
    if (!win || win.closed) {
      return false;
    }
    if (engine == "webkit") {
      if (!this.availableForTab(tab)) {
        return false;
      }
      const targetURI = url ? safeNewURI(url) : this.currentURIOf(tab);
      if (!isWebURI(targetURI)) {
        return false;
      }
      const targetSpec = targetURI.spec;
      if (this.isWebKitTab(tab)) {
        const state = tab._whimsyWebKitState;
        if (state.url != targetSpec) {
          await this.loadURLInTab(tab, targetSpec, { waitForLoad });
        }
        this.refreshUI(win);
        return true;
      }
      return this._attachWebKitToTab(tab, targetURI, { waitForLoad });
    }

    if (engine == "firefox") {
      if (!this.isWebKitTab(tab)) {
        this.refreshUI(win);
        return true;
      }
      return this._detachWebKitFromTab(tab, { url, waitForLoad });
    }
    return false;
  },

  async _attachWebKitToTab(tab, targetURI, { waitForLoad = true } = {}) {
    const win = tab.ownerDocument.defaultView;
    const browser = tab.linkedBrowser;
    const svc = this.service;
    if (!svc || !browser) {
      return false;
    }

    const dataStoreId = this.dataStoreIdForTab(tab);
    const state = {
      id: 0,
      tab,
      win,
      browser,
      url: targetURI.spec,
      uri: targetURI,
      title: tab.label || targetURI.asciiHost || targetURI.spec,
      favicon: tab.getAttribute("image") || "",
      loading: true,
      canGoBack: false,
      canGoForward: false,
      loadWaiters: new Set(),
      historyWaiters: new Set(),
      origCurrentURIDescriptor: Object.getOwnPropertyDescriptor(
        browser,
        "currentURI"
      ),
    };

    const listener = (id, type, data) => {
      this._onNativeEvent(tab, id, type, data);
    };

    let id = 0;
    try {
      id = svc.createTab(win, dataStoreId, "below", listener);
    } catch (e) {
      console.error("WhimsyWebKit: createTab failed", e);
      return false;
    }
    state.id = id;
    tab._whimsyWebKitState = state;
    tab.setAttribute("whimsy-webkit", "true");
    browser.setAttribute("whimsy-webkit", "true");

    // Expose the WebKit tab's live nsIURI through browser.currentURI so
    // WhimsySiteSettings, ZenSiteDataPanel, gURLBar, and ⌘K see the live site
    // while the underlying Gecko <browser> is parked on about:blank.
    Object.defineProperty(browser, "currentURI", {
      configurable: true,
      get() {
        return state.uri;
      },
    });

    // Park the underlying Gecko <browser> on about:blank once any in-flight
    // initial load finishes so Gecko doesn't run duplicate page scripts/media.
    const parkGeckoBrowser = () => {
      if (!this.isWebKitTab(tab) || tab._whimsyWebKitState != state) {
        return;
      }
      try {
        const proto = Object.getPrototypeOf(browser);
        const origDesc = Object.getOwnPropertyDescriptor(proto, "currentURI");
        const geckoURI = origDesc?.get ? origDesc.get.call(browser) : null;
        if (geckoURI && geckoURI.spec != "about:blank") {
          state.parkingGecko = true;
          browser.fixupAndLoadURIString("about:blank", {
            triggeringPrincipal:
              Services.scriptSecurityManager.getSystemPrincipal(),
          });
        }
      } catch {}
    };

    if (browser.webProgress?.isLoadingDocument) {
      win.setTimeout(parkGeckoBrowser, 50);
    } else {
      parkGeckoBrowser();
    }

    this.syncReservedShortcuts(win, state.id);
    const isSelected = win.gBrowser.selectedTab == tab;
    svc.setVisible(state.id, isSelected);
    this.syncLayout(win);

    const loadPromise = this._waitForNextLoad(state);
    try {
      svc.loadURL(state.id, targetURI.spec);
    } catch (e) {
      console.error("WhimsyWebKit: loadURL failed", e);
    }

    if (isSelected) {
      try {
        svc.focus(state.id);
      } catch {}
    }
    this.refreshUI(win);

    if (waitForLoad) {
      await loadPromise;
    }
    return true;
  },

  async _detachWebKitFromTab(tab, { url = null, waitForLoad = true } = {}) {
    const state = tab?._whimsyWebKitState;
    if (!state) {
      return true;
    }
    const { win, browser } = state;
    const reloadSpec = url || state.url || "about:blank";

    this._destroyTabState(tab);

    let loadedPromise = null;
    if (waitForLoad && browser?.isConnected && reloadSpec != "about:blank") {
      loadedPromise = new Promise(resolve => {
        const timeout = win.setTimeout(resolve, 5000);
        const progressListener = {
          onStateChange(b, webProgress, request, flags) {
            const done =
              Ci.nsIWebProgressListener.STATE_STOP |
              Ci.nsIWebProgressListener.STATE_IS_WINDOW;
            if (b == browser && webProgress?.isTopLevel && (flags & done) == done) {
              win.clearTimeout(timeout);
              win.gBrowser.removeTabsProgressListener(progressListener);
              resolve();
            }
          },
        };
        win.gBrowser.addTabsProgressListener(progressListener);
      });
    }

    if (browser?.isConnected) {
      state.restoringGecko = true;
      try {
        browser.fixupAndLoadURIString(reloadSpec, {
          triggeringPrincipal:
            Services.scriptSecurityManager.getSystemPrincipal(),
        });
      } catch (e) {
        console.error("WhimsyWebKit: reload in Firefox failed", e);
      }
      if (win.gBrowser.selectedTab == tab) {
        browser.focus();
      }
    }

    this.refreshUI(win);
    if (loadedPromise) {
      await loadedPromise;
    }
    this.refreshUI(win);
    return true;
  },

  _destroyTabState(tab) {
    const state = tab?._whimsyWebKitState;
    if (!state) {
      return;
    }
    delete tab._whimsyWebKitState;
    tab.removeAttribute("whimsy-webkit");
    const { browser, id } = state;
    if (browser) {
      browser.removeAttribute("whimsy-webkit");
      if (state.origCurrentURIDescriptor) {
        Object.defineProperty(
          browser,
          "currentURI",
          state.origCurrentURIDescriptor
        );
      } else {
        delete browser.currentURI;
      }
    }
    for (const resolve of state.loadWaiters) {
      try {
        resolve();
      } catch {}
    }
    state.loadWaiters.clear();
    try {
      this.service?.destroyTab(id);
    } catch {}
  },

  _waitForNextLoad(state, timeoutMs = 8000) {
    return new Promise(resolve => {
      const done = () => {
        state.loadWaiters.delete(done);
        state.win?.clearTimeout(timer);
        resolve();
      };
      const timer = state.win?.setTimeout(done, timeoutMs);
      state.loadWaiters.add(done);
    });
  },

  async loadURLInTab(tab, url, { waitForLoad = true } = {}) {
    const state = this.stateOf(tab);
    if (!state) {
      return false;
    }
    const uri = safeNewURI(url);
    if (!uri) {
      return false;
    }
    state.url = uri.spec;
    state.uri = uri;
    const promise = waitForLoad ? this._waitForNextLoad(state) : null;
    this.service?.loadURL(state.id, uri.spec);
    this.refreshUI(state.win);
    if (promise) {
      await promise;
    }
    return true;
  },

  async evaluateInTab(tab, script) {
    const state = this.stateOf(tab);
    if (!state || !this.service) {
      return null;
    }
    return this.service.evaluate(state.id, script);
  },

  hitTestAtTab(tab, x, y) {
    const state = this.stateOf(tab);
    if (!state || !this.service) {
      return "none";
    }
    return this.service.hitTestAt(state.id, x, y);
  },

  acceptsFirstMouseAtTab(tab, x, y) {
    const state = this.stateOf(tab);
    if (!state || !this.service) {
      return false;
    }
    return this.service.acceptsFirstMouseAt(state.id, x, y);
  },

  focusTab(tab) {
    const state = this.stateOf(tab);
    if (!state || !this.service) {
      return;
    }
    try {
      this.service.focus(state.id);
    } catch {}
  },

  blurTab(tab) {
    const state = this.stateOf(tab);
    if (!state || !this.service) {
      return;
    }
    try {
      this.service.blur(state.id);
    } catch {}
  },

  isTabFocused(tab) {
    const state = this.stateOf(tab);
    if (!state || !this.service) {
      return false;
    }
    try {
      return this.service.isFocused(state.id);
    } catch {
      return false;
    }
  },

  goBack(tab) {
    const state = this.stateOf(tab);
    if (!state || !this.service) {
      return false;
    }
    this.service.goBack(state.id);
    return true;
  },

  goForward(tab) {
    const state = this.stateOf(tab);
    if (!state || !this.service) {
      return false;
    }
    this.service.goForward(state.id);
    return true;
  },

  reload(tab) {
    const state = this.stateOf(tab);
    if (!state || !this.service) {
      return false;
    }
    this.service.reload(state.id);
    return true;
  },

  stop(tab) {
    const state = this.stateOf(tab);
    if (!state || !this.service) {
      return false;
    }
    this.service.stop(state.id);
    return true;
  },

  // -------------------------------------------------------------------------
  // Native event listener (title, URL, loading, favicon, history, newwindow).

  _onNativeEvent(tab, id, type, data) {
    const state = this.stateOf(tab);
    if (!state || state.id != id) {
      return;
    }
    const { win } = state;
    if (!win || win.closed) {
      return;
    }

    switch (type) {
      case "title": {
        const title = data || state.uri?.asciiHost || state.url || "";
        state.title = title;
        tab._fullLabel = title;
        tab.label = title;
        tab.setAttribute("label", title);
        if (tab.selected) {
          win.gBrowser.updateTitlebar?.();
        }
        break;
      }
      case "location": {
        if (!data || (data == "about:blank" && state.url != "about:blank")) {
          break;
        }
        const uri = safeNewURI(data);
        if (uri) {
          state.url = uri.spec;
          state.uri = uri;
          if (tab.selected) {
            this._syncAddressBar(win, tab);
            this.refreshUI(win);
          }
        }
        break;
      }
      case "loading": {
        const loading = data == "true";
        state.loading = loading;
        if (loading) {
          tab.setAttribute("busy", "true");
        } else {
          tab.removeAttribute("busy");
          tab.removeAttribute("progress");
          for (const resolve of [...state.loadWaiters]) {
            try {
              resolve();
            } catch {}
          }
        }
        if (tab.selected) {
          this._syncNavigationCommands(win, tab);
        }
        break;
      }
      case "favicon": {
        state.favicon = data || "";
        if (data) {
          tab.setAttribute("image", data);
          try {
            win.gBrowser.setIcon?.(tab, data);
          } catch {}
        }
        break;
      }
      case "history": {
        try {
          const parsed = JSON.parse(data || "{}");
          state.canGoBack = !!parsed.canGoBack;
          state.canGoForward = !!parsed.canGoForward;
        } catch {}
        if (tab.selected) {
          this._syncNavigationCommands(win, tab);
        }
        break;
      }
      case "newwindow": {
        const targetURI = safeNewURI(data);
        if (!isWebURI(targetURI)) {
          break;
        }
        const newTab = win.gBrowser.addTab(targetURI.spec, {
          triggeringPrincipal:
            Services.scriptSecurityManager.getSystemPrincipal(),
          relatedToCurrent: true,
          userContextId: tab.userContextId || 0,
        });
        win.gBrowser.selectedTab = newTab;
        break;
      }
    }
  },

  _syncAddressBar(win, tab) {
    const state = this.stateOf(tab);
    if (!state || !state.uri || !win.gURLBar) {
      return;
    }
    try {
      if (!win.gURLBar.focused) {
        win.gURLBar.setURI({ uri: state.uri, dueToSessionRestore: false });
      }
    } catch {}
  },

  _syncNavigationCommands(win, tab) {
    const state = this.stateOf(tab);
    if (!state) {
      return;
    }
    const doc = win.document;
    const backCmd = doc.getElementById("Browser:Back");
    const fwdCmd = doc.getElementById("Browser:Forward");
    const reloadCmd = doc.getElementById("Browser:Reload");
    const stopCmd = doc.getElementById("Browser:Stop");
    if (state.canGoBack) {
      backCmd?.removeAttribute("disabled");
    } else {
      backCmd?.setAttribute("disabled", "true");
    }
    if (state.canGoForward) {
      fwdCmd?.removeAttribute("disabled");
    } else {
      fwdCmd?.setAttribute("disabled", "true");
    }
    reloadCmd?.removeAttribute("disabled");
    if (state.loading) {
      stopCmd?.removeAttribute("disabled");
    } else {
      stopCmd?.setAttribute("disabled", "true");
    }
  },

  // -------------------------------------------------------------------------
  // Layout sync & overlay hole subtraction.

  collectOverlayExclusions(win) {
    const doc = win?.document;
    if (!doc) {
      return [];
    }
    const rects = [];
    const addRect = r => {
      if (!r || r.width <= 1 || r.height <= 1) {
        return;
      }
      rects.push([
        Math.floor(r.left),
        Math.floor(r.top),
        Math.ceil(r.width),
        Math.ceil(r.height),
      ]);
    };
    const isVisibleEl = el => {
      if (!el || !el.isConnected || el.hidden) {
        return false;
      }
      const cs = win.getComputedStyle(el);
      if (
        !cs ||
        cs.display == "none" ||
        cs.visibility == "hidden" ||
        parseFloat(cs.opacity || "1") <= 0.01
      ) {
        return false;
      }
      return true;
    };

    // 1. Open command bar / URL bar view / floating URL bar.
    const urlbar = doc.getElementById("urlbar");
    if (
      urlbar &&
      (urlbar.hasAttribute("open") ||
        urlbar.hasAttribute("breakout-extend") ||
        win.gURLBar?.view?.isOpen)
    ) {
      if (isVisibleEl(urlbar)) {
        addRect(urlbar.getBoundingClientRect());
      }
      const view = urlbar.querySelector(".urlbarView");
      if (isVisibleEl(view)) {
        addRect(view.getBoundingClientRect());
      }
    }

    // 2. Toasts (#zen-toast-container and individual toasts).
    for (const toast of doc.querySelectorAll(
      "#zen-toast-container .zen-toast, .zen-toast, .whimsy-toast"
    )) {
      if (isVisibleEl(toast)) {
        addRect(toast.getBoundingClientRect());
      }
    }

    // 3. Glance overlays.
    for (const glance of doc.querySelectorAll(
      ".zen-glance-overlay, #zen-glance-sidebar-container, .zen-glance-background"
    )) {
      if (isVisibleEl(glance)) {
        addRect(glance.getBoundingClientRect());
      }
    }

    // 4. Find bar and Whimsy Find card.
    for (const find of doc.querySelectorAll(
      "findbar:not([hidden]), .whimsy-find-card:not([hidden]), #whimsy-find-card:not([hidden])"
    )) {
      if (isVisibleEl(find)) {
        addRect(find.getBoundingClientRect());
      }
    }

    // 5. Open WhimsySurface popovers, sheets, side panels, and XUL panels.
    for (const surface of doc.querySelectorAll(
      ".whimsy-surface:not([hidden]), .whimsy-surface-sheet:not([hidden]), .whimsy-side-panel:not([hidden]), dialog[open]"
    )) {
      if (surface.localName == "panel") {
        continue;
      }
      if (isVisibleEl(surface)) {
        addRect(surface.getBoundingClientRect());
      }
    }

    for (const panel of doc.querySelectorAll("panel")) {
      if (panel.state != "open" && !panel.hasAttribute("panelopen")) {
        continue;
      }
      try {
        const outer = panel.getOuterScreenRect?.();
        if (outer && outer.width > 1 && outer.height > 1) {
          addRect({
            left: outer.left - win.mozInnerScreenX,
            top: outer.top - win.mozInnerScreenY,
            width: outer.width,
            height: outer.height,
          });
          continue;
        }
      } catch {}
      addRect(panel.getBoundingClientRect());
    }

    return rects;
  },

  measureBrowserRect(win, browser) {
    if (!win || !browser) {
      return { x: 0, y: 0, width: 0, height: 0, radius: 0 };
    }
    const rect = browser.getBoundingClientRect();
    let radius = 0;
    let cur = browser;
    for (let i = 0; i < 5 && cur && cur.nodeType == 1; i++) {
      const r = parseFloat(win.getComputedStyle(cur).borderTopLeftRadius) || 0;
      if (r > radius) {
        radius = r;
      }
      cur = cur.parentElement;
    }
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      radius,
    };
  },

  syncLayout(win) {
    if (!win || win.closed || !this.service) {
      return;
    }
    const tab = win.gBrowser?.selectedTab;
    const state = this.stateOf(tab);
    if (!state) {
      return;
    }
    const m = this.measureBrowserRect(win, state.browser);
    const exclusions = this.collectOverlayExclusions(win);
    try {
      this.service.setFrame(
        state.id,
        m.x,
        m.y,
        m.width,
        m.height,
        m.radius,
        JSON.stringify(exclusions)
      );
    } catch {}
  },

  // -------------------------------------------------------------------------
  // Reserved shortcuts (Ctrl+Tab, Ctrl+Shift+Tab, and every Whimsy binding
  // that uses Control in the window's keysets).

  collectReservedShortcuts(win) {
    const doc = win?.document;
    const out = [
      {
        id: "key_ctrlTab",
        key: "tab",
        keyCode: 48,
        ctrl: true,
        shift: false,
        alt: false,
        meta: false,
      },
      {
        id: "key_ctrlShiftTab",
        key: "tab",
        keyCode: 48,
        ctrl: true,
        shift: true,
        alt: false,
        meta: false,
      },
    ];
    if (!doc) {
      return out;
    }
    const seen = new Set(["48::1:0:0:0", "48::1:1:0:0"]);
    for (const keyEl of doc.querySelectorAll("keyset key, key")) {
      if (
        keyEl.getAttribute("disabled") == "true" ||
        keyEl.hasAttribute("disabled")
      ) {
        continue;
      }
      const rawMods = (keyEl.getAttribute("modifiers") || "").toLowerCase();
      if (!rawMods) {
        continue;
      }
      const tokens = rawMods.split(/[\s,]+/).filter(Boolean);
      const ctrl = tokens.includes("control");
      if (!ctrl) {
        continue;
      }
      const shift = tokens.includes("shift");
      const alt = tokens.includes("alt");
      const meta = tokens.includes("accel") || tokens.includes("meta");
      const keyAttr = (keyEl.getAttribute("key") || "").toLowerCase();
      const keycodeAttr = (keyEl.getAttribute("keycode") || "").toUpperCase();
      const keyCode = MAC_KEYCODES[keycodeAttr] || 0;
      if (!keyAttr && !keyCode) {
        continue;
      }
      const sig = `${keyCode}:${keyAttr}:${ctrl ? 1 : 0}:${shift ? 1 : 0}:${alt ? 1 : 0}:${meta ? 1 : 0}`;
      if (seen.has(sig)) {
        continue;
      }
      seen.add(sig);
      out.push({
        id: keyEl.id || "",
        command: keyEl.getAttribute("command") || "",
        key: keyAttr,
        keyCode,
        ctrl,
        shift,
        alt,
        meta,
      });
    }
    return out;
  },

  syncReservedShortcuts(win, tabId = null) {
    if (!win || !this.service) {
      return [];
    }
    const shortcuts = this.collectReservedShortcuts(win);
    const json = JSON.stringify(shortcuts);
    if (tabId != null) {
      try {
        this.service.setReservedShortcuts(tabId, json);
      } catch {}
      return shortcuts;
    }
    for (const tab of win.gBrowser?.tabs ?? []) {
      const state = this.stateOf(tab);
      if (state) {
        try {
          this.service.setReservedShortcuts(state.id, json);
        } catch {}
      }
    }
    return shortcuts;
  },

  // -------------------------------------------------------------------------
  // W.2: Address-bar pill and Engine rows (in both the site panel and the
  // puzzle button's unified extensions panel).

  ensurePill(win) {
    const doc = win.document;
    let pill = doc.getElementById(PILL_ID);
    if (pill) {
      return pill;
    }
    const actions = doc.getElementById("page-action-buttons");
    if (!actions) {
      return null;
    }
    // Reuses the page-action sibling layout of #whimsy-annotations-button
    // (WhimsyAnnotations.sys.mjs:503-556, whimsy-browser.css:8215-8258) and
    // the accent token pair of #whimsy-pass-keys-pill
    // (whimsy-navigation.css:351-385).
    pill = doc.createXULElement("hbox");
    pill.id = PILL_ID;
    pill.className = "urlbar-page-action whimsy-webkit-pill";
    pill.setAttribute("role", "button");
    pill.setAttribute("tabindex", "0");
    pill.setAttribute("align", "center");
    pill.hidden = true;
    doc.l10n.setAttributes(pill, "whimsy-webkit-pill");

    const svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "whimsy-webkit-pill-icon");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "12");
    svg.setAttribute("height", "12");
    svg.setAttribute("fill", "none");
    svg.setAttribute("aria-hidden", "true");
    const circle = doc.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", "8");
    circle.setAttribute("cy", "8");
    circle.setAttribute("r", "6.25");
    circle.setAttribute("stroke", "currentColor");
    circle.setAttribute("stroke-width", "1.4");
    const polygon = doc.createElementNS(SVG_NS, "polygon");
    polygon.setAttribute("points", "10.8,5.2 9.1,9.1 5.2,10.8 6.9,6.9");
    polygon.setAttribute("fill", "currentColor");
    svg.append(circle, polygon);

    const label = doc.createXULElement("label");
    label.className = "whimsy-webkit-pill-label";
    doc.l10n.setAttributes(label, "whimsy-webkit-pill-label");

    pill.append(svg, label);

    const openEnginePanel = event => {
      event.stopPropagation();
      lazy.WhimsySiteSettings.open(win, { focus: "engine" });
    };
    pill.addEventListener("click", openEnginePanel);
    pill.addEventListener("keydown", event => {
      if (event.key == "Enter" || event.key == " ") {
        event.preventDefault();
        openEnginePanel(event);
      }
    });

    const sep = doc.getElementById("pageActionSeparator");
    if (sep && sep.parentNode == actions) {
      actions.insertBefore(pill, sep);
    } else {
      actions.append(pill);
    }
    return pill;
  },

  updatePill(win) {
    if (!win || win.closed) {
      return;
    }
    const pill = this.ensurePill(win);
    if (!pill) {
      return;
    }
    const tab = win.gBrowser?.selectedTab;
    const show = this.availableForTab(tab) && this.isWebKitTab(tab);
    pill.hidden = !show;
  },

  /**
   * Builds the WhimsySurface Engine rows ("Engine: Firefox | WebKit" segmented
   * control, "Always use for this site" switch, and the WebKit feature note
   * when WebKit is active). Reuses WhimsySurface.row
   * (WhimsySurface.sys.mjs:391-452), WhimsySurface.seg
   * (WhimsySurface.sys.mjs:750-818), and WhimsySurface.switch
   * (WhimsySurface.sys.mjs:684-725).
   */
  buildEngineRows(win, { idPrefix = "whimsy-site-settings" } = {}) {
    const tab = win?.gBrowser?.selectedTab;
    if (!tab || !this.availableForTab(tab)) {
      return null;
    }
    const host = this.currentHostOf(tab);
    if (!host) {
      return null;
    }
    const doc = win.document;
    const userContextId = tab.userContextId || 0;
    const isWebKit = this.isWebKitTab(tab);
    const alwaysUse = this.isSiteInWebKit(host, userContextId);

    const engineLabelId = `${idPrefix}-engine-label`;
    // seg() returns { group, select }: the group is the element.
    const { group: seg, select } = lazy.WhimsySurface.seg(doc, {
      name: `${idPrefix}-engine`,
      options: [
        { value: "firefox", l10nId: "whimsy-webkit-engine-firefox" },
        { value: "webkit", l10nId: "whimsy-webkit-engine-webkit" },
      ],
      onPick: value => {
        this.setTabEngine(tab, value);
      },
    });
    seg.id = `${idPrefix}-engine-seg`;
    seg.setAttribute("aria-labelledby", engineLabelId);
    select(isWebKit ? "webkit" : "firefox");

    const { row: engineRow, label: engineLabel } = lazy.WhimsySurface.row(doc, {
      l10nId: "whimsy-webkit-engine-label",
      trailing: [seg],
    });
    engineLabel.id = engineLabelId;
    engineRow.classList.add(
      "whimsy-site-settings-item",
      "whimsy-site-settings-engine"
    );
    engineRow.setAttribute("whimsy-site-setting", "engine");
    engineRow.setAttribute("state", isWebKit ? "allow" : "block");
    doc.l10n.setAttributes(engineRow, "whimsy-webkit-engine-tooltip");

    const alwaysLabelId = `${idPrefix}-engine-always-label`;
    const toggle = lazy.WhimsySurface.switch(doc, {
      id: `${idPrefix}-engine-always-switch`,
      checked: alwaysUse,
      labelledBy: alwaysLabelId,
      onChange: checked => {
        this.setAlwaysUseForTab(tab, checked);
      },
    });
    const { row: alwaysRow, label: alwaysLabel } = lazy.WhimsySurface.row(doc, {
      l10nId: "whimsy-webkit-always-use",
      trailing: [toggle],
    });
    alwaysLabel.id = alwaysLabelId;
    alwaysRow.classList.add(
      "whimsy-site-settings-item",
      "whimsy-site-settings-engine-always"
    );
    alwaysRow.setAttribute("whimsy-site-setting", "engine-always");
    alwaysRow.setAttribute("state", alwaysUse ? "allow" : "block");
    doc.l10n.setAttributes(alwaysRow, "whimsy-webkit-always-use-tooltip");

    let note = null;
    if (isWebKit) {
      note = doc.createElementNS(HTML_NS, "p");
      note.className = "whimsy-webkit-engine-note";
      doc.l10n.setAttributes(note, "whimsy-webkit-engine-note");
    }

    return {
      isWebKit,
      alwaysUse,
      host,
      engineRow,
      alwaysRow,
      note,
      seg,
      toggle,
    };
  },

  updateSitePanelProtections(win) {
    const doc = win?.document;
    if (!doc) {
      return;
    }
    const item = doc.querySelector(
      ".permission-popup-permission-item-site-protection"
    );
    if (!item) {
      return;
    }
    const tab = win.gBrowser?.selectedTab;
    const isWebKit = this.availableForTab(tab) && this.isWebKitTab(tab);
    item.toggleAttribute("whimsy-webkit-off", isWebKit);
    const stateLabel = item.querySelector(
      ".zen-permission-popup-permission-state-label"
    );
    if (stateLabel && isWebKit) {
      doc.l10n.setAttributes(stateLabel, "whimsy-webkit-protections-off");
    }
  },

  // Puzzle button's panel (#unified-extensions-button / #unified-extensions-panel):
  // Zen's ZenSiteDataPanel removes #unified-extensions-panel-template when
  // merging extensions into #zen-unified-site-data-panel. We ensure a dedicated
  // #unified-extensions-panel exists for #unified-extensions-button and render
  // the exact same WhimsySurface Engine section in both panels.
  ensureExtensionsPanel(win) {
    if (!win || win._whimsyQuickWindow) {
      return null;
    }
    const doc = win.document;
    const tmpl = doc.getElementById("unified-extensions-panel-template");
    if (tmpl) {
      tmpl.replaceWith(tmpl.content);
    }
    let panel = doc.getElementById(EXT_PANEL_ID);
    if (!panel) {
      const popupSet =
        doc.getElementById("mainPopupSet") || doc.documentElement;
      panel = doc.createXULElement("panel");
      panel.id = EXT_PANEL_ID;
      panel.className =
        "panel-no-padding whimsy-surface-tokens whimsy-webkit-extensions-panel";
      panel.setAttribute("type", "arrow");
      panel.setAttribute("role", "group");
      popupSet.append(panel);
    }
    if (!panel._whimsyWebKitWired) {
      panel._whimsyWebKitWired = true;
      panel.addEventListener("popupshowing", event => {
        if (event.target == panel) {
          this.renderExtensionsPanel(win);
          this.syncLayout(win);
        }
      });
      panel.addEventListener("popupshown", event => {
        if (event.target == panel) {
          this.syncLayout(win);
        }
      });
      panel.addEventListener("popuphidden", event => {
        if (event.target == panel) {
          this.syncLayout(win);
        }
      });
    }
    return panel;
  },

  renderExtensionsPanel(win) {
    if (!win || win._whimsyQuickWindow) {
      return null;
    }
    const doc = win.document;
    const panel = this.ensureExtensionsPanel(win);
    if (!panel) {
      return null;
    }
    let section = doc.getElementById(EXT_SECTION_ID);
    if (!section) {
      section = doc.createXULElement("vbox");
      section.id = EXT_SECTION_ID;
      section.className =
        "zen-site-data-section whimsy-site-settings-section whimsy-webkit-engine-section whimsy-surface-tokens";
      const { caption, detail } = lazy.WhimsySurface.caption(doc, {
        l10nId: "whimsy-webkit-engine-heading",
        id: "whimsy-webkit-extensions-engine-heading",
        detail: "",
      });
      caption.classList.add("whimsy-site-settings-caption");
      detail.classList.add("whimsy-site-settings-caption-who");
      const list = lazy.WhimsySurface.group(doc);
      list.id = "whimsy-webkit-extensions-engine-list";
      list.setAttribute("role", "group");
      list.setAttribute(
        "aria-labelledby",
        "whimsy-webkit-extensions-engine-heading"
      );
      const note = doc.createElementNS(HTML_NS, "p");
      note.className = "whimsy-webkit-engine-note";
      doc.l10n.setAttributes(note, "whimsy-webkit-engine-note");
      note.hidden = true;
      section.append(caption, list, note);
      panel.prepend(section);
    }

    const list = section.querySelector("#whimsy-webkit-extensions-engine-list");
    const note = section.querySelector(".whimsy-webkit-engine-note");
    const who = section.querySelector(".whimsy-site-settings-caption-who");
    list.replaceChildren();

    const parts = this.buildEngineRows(win, {
      idPrefix: "whimsy-extensions-panel",
    });
    if (!parts) {
      section.hidden = true;
      note.hidden = true;
      return section;
    }
    section.hidden = false;
    who.textContent = parts.host;
    list.append(parts.engineRow, parts.alwaysRow);
    note.hidden = !parts.isWebKit;
    return section;
  },

  async openExtensionsPanel(win) {
    if (!win || !this.available(win)) {
      return null;
    }
    const doc = win.document;
    const panel = this.ensureExtensionsPanel(win);
    if (!panel) {
      return null;
    }
    this.renderExtensionsPanel(win);
    if (panel.state == "open") {
      return panel;
    }
    const anchor =
      lazy.WhimsyPanels.visibleAnchor(win, [
        "unified-extensions-button",
        "zen-site-data-icon-button",
        "urlbar",
      ]) || doc.documentElement;
    const shown = new Promise(resolve =>
      panel.addEventListener("popupshown", resolve, { once: true })
    );
    panel.openPopup(anchor, "bottomright topright", 0, 0, false, false);
    const timedOut = new Promise(resolve =>
      win.setTimeout(() => resolve("timeout"), 3000)
    );
    await Promise.race([shown, timedOut]);
    return panel;
  },

  hideExtensionsPanel(win) {
    const panel = win?.document?.getElementById(EXT_PANEL_ID);
    if (!panel || panel.state == "closed") {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      panel.addEventListener("popuphidden", () => resolve(), { once: true });
      panel.hidePopup();
    });
  },

  refreshUI(win) {
    if (!win || win.closed) {
      return;
    }
    this.updatePill(win);
    this.updateSitePanelProtections(win);
    lazy.WhimsySiteSettings.renderIfOpen?.(win);
    const extPanel = win.document?.getElementById(EXT_PANEL_ID);
    if (extPanel && extPanel.state == "open") {
      this.renderExtensionsPanel(win);
    }
    const tab = win.gBrowser?.selectedTab;
    if (this.isWebKitTab(tab)) {
      this._syncAddressBar(win, tab);
      this._syncNavigationCommands(win, tab);
      this.syncLayout(win);
    }
  },

  // -------------------------------------------------------------------------
  // W.1: ⌘K verbs and command bar commands.

  registerVerbs() {
    if (this._verbsRegistered) {
      return;
    }
    this._verbsRegistered = true;

    // 1. "Open in WebKit" / "Open in Firefox" (This tab)
    lazy.WhimsyVerbs.registerVerb({
      id: "webkit:switch-tab",
      group: "page",
      scope: "page",
      icon: GLOBE,
      isAvailable: win => {
        const tab = win?.gBrowser?.selectedTab;
        return this.availableForTab(tab) && !!this.currentHostOf(tab);
      },
      l10n: win => {
        const isWebKit = this.isWebKitTab(win?.gBrowser?.selectedTab);
        return {
          id: isWebKit
            ? "whimsy-webkit-cmd-open-firefox"
            : "whimsy-webkit-cmd-open",
        };
      },
      tag: () =>
        lazy.WhimsyVerbs.labelFor({ l10nId: "whimsy-webkit-cmd-tag-tab" }, {}),
      run: async win => {
        win.gURLBar?.view?.close();
        const tab = win.gBrowser.selectedTab;
        const next = this.isWebKitTab(tab) ? "firefox" : "webkit";
        await this.setTabEngine(tab, next);
      },
    });

    // 2. "Always Open {host} in WebKit" / "Stop Opening {host} in WebKit" (This site)
    lazy.WhimsyVerbs.registerVerb({
      id: "webkit:toggle-site",
      group: "page",
      scope: "page",
      icon: GLOBE,
      isAvailable: win => {
        const tab = win?.gBrowser?.selectedTab;
        return this.availableForTab(tab) && !!this.currentHostOf(tab);
      },
      l10n: win => {
        const tab = win?.gBrowser?.selectedTab;
        const host = this.currentHostOf(tab);
        const inList = this.isSiteInWebKit(host, tab?.userContextId || 0);
        return {
          id: inList
            ? "whimsy-webkit-cmd-stop-opening"
            : "whimsy-webkit-cmd-always-open",
          args: { host },
        };
      },
      tag: () =>
        lazy.WhimsyVerbs.labelFor({ l10nId: "whimsy-webkit-cmd-tag-site" }, {}),
      run: async win => {
        win.gURLBar?.view?.close();
        const tab = win.gBrowser.selectedTab;
        const host = this.currentHostOf(tab);
        const inList = this.isSiteInWebKit(host, tab?.userContextId || 0);
        await this.setAlwaysUseForTab(tab, !inList);
      },
    });
  },

  initCommands(win) {
    this.registerVerbs();

    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyOpenInWebKit",
      l10nId: "whimsy-webkit-cmd-open",
      icon: GLOBE,
      isAvailable: w => {
        const tab = w.gBrowser?.selectedTab;
        return (
          this.availableForTab(tab) &&
          !this.isWebKitTab(tab) &&
          !!this.currentHostOf(tab)
        );
      },
      run: w => this.setTabEngine(w.gBrowser.selectedTab, "webkit"),
    });

    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyOpenInFirefox",
      l10nId: "whimsy-webkit-cmd-open-firefox",
      icon: GLOBE,
      isAvailable: w => {
        const tab = w.gBrowser?.selectedTab;
        return this.availableForTab(tab) && this.isWebKitTab(tab);
      },
      run: w => this.setTabEngine(w.gBrowser.selectedTab, "firefox"),
    });
  },

  // -------------------------------------------------------------------------
  // Window wiring.

  initWindow(win) {
    if (!win || win._whimsyWebKitInitialized) {
      return;
    }
    win._whimsyWebKitInitialized = true;
    this.initCommands(win);

    if (this.isWindowPrivate(win) || win._whimsyQuickWindow) {
      return;
    }

    const { gBrowser, document: doc } = win;
    this.ensurePill(win);
    this.ensureExtensionsPanel(win);

    // Wire the puzzle button (#unified-extensions-button) so clicking it
    // renders and opens the unified extensions panel with the Engine rows.
    const puzzleBtn = doc.getElementById("unified-extensions-button");
    const onPuzzleCommand = event => {
      if (win._whimsyQuickWindow || !this.available(win)) {
        return;
      }
      if (
        event.type == "mousedown" &&
        (event.button != 0 || event.ctrlKey || event.metaKey)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const panel = this.ensureExtensionsPanel(win);
      if (panel?.state == "open") {
        panel.hidePopup();
      } else {
        this.openExtensionsPanel(win);
      }
    };
    puzzleBtn?.addEventListener("command", onPuzzleCommand, true);
    puzzleBtn?.addEventListener("click", onPuzzleCommand, true);

    // Watch top-level navigations across tabs so opening a URL whose host is in
    // whimsy.webkit.sites automatically switches that tab to WebKit.
    const tabsProgressListener = {
      onLocationChange: (browser, webProgress, request, location, flags) => {
        if (
          !webProgress?.isTopLevel ||
          flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT
        ) {
          return;
        }
        const tab = gBrowser.getTabForBrowser(browser);
        if (!tab || !this.availableForTab(tab)) {
          return;
        }
        const state = this.stateOf(tab);
        if (state) {
          if (state.parkingGecko) {
            state.parkingGecko = false;
            return;
          }
          return;
        }
        if (!isWebURI(location)) {
          return;
        }
        const host = (location.asciiHost || "").toLowerCase();
        if (!host) {
          return;
        }
        if (
          tab._whimsyWebKitOverrideHost &&
          tab._whimsyWebKitOverrideHost != host
        ) {
          tab._whimsyWebKitOverride = null;
          tab._whimsyWebKitOverrideHost = null;
        }
        if (tab._whimsyWebKitOverride == "firefox") {
          return;
        }
        if (
          tab._whimsyWebKitOverride == "webkit" ||
          this.isSiteInWebKit(host, tab.userContextId || 0)
        ) {
          this.switchTab(tab, "webkit", {
            url: location.spec,
            waitForLoad: false,
          });
        }
      },
    };
    gBrowser.addTabsProgressListener(tabsProgressListener);

    // Tab selection: show only the selected tab's WKWebView and hide all others.
    const onTabSelect = () => {
      const selected = gBrowser.selectedTab;
      for (const tab of gBrowser.tabs) {
        const state = this.stateOf(tab);
        if (!state) {
          continue;
        }
        const isSelected = tab == selected;
        try {
          this.service?.setVisible(state.id, isSelected);
        } catch {}
        if (isSelected) {
          this.syncLayout(win);
          this._syncAddressBar(win, tab);
          this._syncNavigationCommands(win, tab);
          if (doc.activeElement == tab.linkedBrowser) {
            this.focusTab(tab);
          }
        }
      }
      this.refreshUI(win);
    };
    gBrowser.tabContainer.addEventListener("TabSelect", onTabSelect);

    // Tab close: destroy the native WKWebView and clean up holes.
    const onTabClose = event => {
      const tab = event.target;
      if (this.isWebKitTab(tab)) {
        this._destroyTabState(tab);
        this.refreshUI(win);
      }
    };
    gBrowser.tabContainer.addEventListener("TabClose", onTabClose);

    // Intercept Back, Forward, Reload, Stop, and ⌘L focus hand-off commands
    // when the selected tab is a WebKit tab.
    const onCommand = event => {
      const id = event.target?.id;
      const tab = gBrowser.selectedTab;
      if (!this.isWebKitTab(tab)) {
        return;
      }
      if (id == "Browser:Back") {
        event.stopPropagation();
        event.preventDefault();
        this.goBack(tab);
      } else if (id == "Browser:Forward") {
        event.stopPropagation();
        event.preventDefault();
        this.goForward(tab);
      } else if (id == "Browser:Reload" || id == "Browser:ReloadSkipCache") {
        event.stopPropagation();
        event.preventDefault();
        this.reload(tab);
      } else if (id == "Browser:Stop") {
        event.stopPropagation();
        event.preventDefault();
        this.stop(tab);
      } else if (id == "Browser:OpenLocation") {
        this.blurTab(tab);
      }
    };
    doc.addEventListener("command", onCommand, true);

    // Focus hand-offs (⌘L / URL bar focus, ⌘T, ⌘W, and chrome focusin):
    // whenever a Gecko chrome element outside the placeholder <browser>
    // receives focus, return NSWindow firstResponder to ChildView.
    const onFocusIn = event => {
      const tab = gBrowser.selectedTab;
      if (!this.isWebKitTab(tab)) {
        return;
      }
      const target = event.target;
      if (target && target != tab.linkedBrowser) {
        this.blurTab(tab);
      } else if (target == tab.linkedBrowser) {
        this.focusTab(tab);
      }
      this.syncLayout(win);
    };
    doc.addEventListener("focusin", onFocusIn, true);

    if (win.gURLBar && !win.gURLBar._whimsyWebKitFocusWrapped) {
      win.gURLBar._whimsyWebKitFocusWrapped = true;
      const origFocus = win.gURLBar.focus?.bind(win.gURLBar);
      const origSelect = win.gURLBar.select?.bind(win.gURLBar);
      if (origFocus) {
        win.gURLBar.focus = (...args) => {
          const tab = gBrowser.selectedTab;
          if (this.isWebKitTab(tab)) {
            this.blurTab(tab);
          }
          const res = origFocus(...args);
          this.syncLayout(win);
          return res;
        };
      }
      if (origSelect) {
        win.gURLBar.select = (...args) => {
          const tab = gBrowser.selectedTab;
          if (this.isWebKitTab(tab)) {
            this.blurTab(tab);
          }
          const res = origSelect(...args);
          this.syncLayout(win);
          return res;
        };
      }
    }

    // Keep Back/Forward commands synced if Firefox runs UpdateBackForwardCommands.
    if (typeof win.UpdateBackForwardCommands == "function") {
      const origUpdateBF = win.UpdateBackForwardCommands.bind(win);
      win.UpdateBackForwardCommands = (...args) => {
        const res = origUpdateBF(...args);
        const tab = gBrowser.selectedTab;
        if (this.isWebKitTab(tab)) {
          this._syncNavigationCommands(win, tab);
        }
        return res;
      };
    }

    // ResizeObserver & MutationObserver for rect/radius sync and overlay hole
    // subtraction (command bar, toasts, Glance, find bar, WhimsySurface popovers).
    const ro = new win.ResizeObserver(() => this.syncLayout(win));
    const watchEl =
      doc.getElementById("tabbrowser-tabbox") ||
      doc.getElementById("browser") ||
      doc.documentElement;
    if (watchEl) {
      ro.observe(watchEl);
    }

    const mo = new win.MutationObserver(() => this.syncLayout(win));
    for (const id of [
      "urlbar",
      "zen-toast-container",
      "mainPopupSet",
      "zen-tabbox-wrapper",
    ]) {
      const el = doc.getElementById(id);
      if (el) {
        mo.observe(el, {
          attributes: true,
          childList: true,
          subtree: id == "zen-toast-container",
          attributeFilter: [
            "open",
            "breakout-extend",
            "hidden",
            "panelopen",
            "whimsy-open",
            "zen-glance-active",
          ],
        });
      }
    }

    const onPopupChange = () => this.syncLayout(win);
    doc.addEventListener("popupshown", onPopupChange, true);
    doc.addEventListener("popuphidden", onPopupChange, true);
    win.addEventListener("resize", onPopupChange);

    // Pref observer so changes to whimsy.feature.webkit-tabs or
    // whimsy.webkit.sites refresh the window's UI immediately.
    const onPrefChange = (_subject, _topic, data) => {
      if (data == FEATURE_PREF && !this.enabled) {
        for (const tab of gBrowser.tabs) {
          if (this.isWebKitTab(tab)) {
            this.switchTab(tab, "firefox", { waitForLoad: false });
          }
        }
      }
      this.refreshUI(win);
    };
    Services.prefs.addObserver(FEATURE_PREF, onPrefChange);
    Services.prefs.addObserver(SITES_PREF, onPrefChange);

    win.addEventListener(
      "unload",
      () => {
        Services.prefs.removeObserver(FEATURE_PREF, onPrefChange);
        Services.prefs.removeObserver(SITES_PREF, onPrefChange);
        gBrowser.removeTabsProgressListener(tabsProgressListener);
        gBrowser.tabContainer.removeEventListener("TabSelect", onTabSelect);
        gBrowser.tabContainer.removeEventListener("TabClose", onTabClose);
        doc.removeEventListener("command", onCommand, true);
        doc.removeEventListener("focusin", onFocusIn, true);
        doc.removeEventListener("popupshown", onPopupChange, true);
        doc.removeEventListener("popuphidden", onPopupChange, true);
        win.removeEventListener("resize", onPopupChange);
        puzzleBtn?.removeEventListener("command", onPuzzleCommand, true);
        puzzleBtn?.removeEventListener("click", onPuzzleCommand, true);
        ro.disconnect();
        mo.disconnect();
        for (const tab of gBrowser.tabs) {
          if (this.isWebKitTab(tab)) {
            this._destroyTabState(tab);
          }
        }
      },
      { once: true }
    );
  },
};
