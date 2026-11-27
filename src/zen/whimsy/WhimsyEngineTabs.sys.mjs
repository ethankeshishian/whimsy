/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W32: engine tabs. A tab whose page another engine (WebKit for now) shows
// over its parked Gecko <browser>: the per-tab state, event routing,
// layering, discards, and the requests the engine asks Gecko to answer.
// Each engine registers an adapter (WhimsyWebKit is WebKit's) for its
// service and what only it knows.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  DownloadPaths: "resource://gre/modules/DownloadPaths.sys.mjs",
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  E10SUtils: "resource://gre/modules/E10SUtils.sys.mjs",
  nsUnknownContentTypeDialog: "resource://gre/modules/HelperAppDlg.sys.mjs",
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
  SessionHistory: "resource://gre/modules/sessionstore/SessionHistory.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  SitePermissions: "resource:///modules/SitePermissions.sys.mjs",
  TabStateCache: "moz-src:///browser/components/sessionstore/TabStateCache.sys.mjs",
  WebRTCParent: "resource:///actors/WebRTCParent.sys.mjs",
  WhimsyEngineLogins: "resource:///modules/whimsy/WhimsyEngineLogins.sys.mjs",
});

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

function parseJSON(data) {
  try {
    const parsed = JSON.parse(data || "{}");
    return parsed && typeof parsed == "object" ? parsed : {};
  } catch {
    return {};
  }
}

// After you accept a certificate on Gecko's error page, an engine failure
// for the same host within this window opens the site in Firefox instead of
// looping back to the error page.
const CERT_RETRY_MS = 30000;

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

export const WhimsyEngineTabs = {
  // Engine name -> adapter. An adapter gives:
  //   service: the engine's nsIWhimsyEngineTab (or null);
  //   tabAttribute: the attribute marking its tabs and their <browser>s;
  //   availableForTab(tab), switchTab(tab, engine, options);
  //   isCertError(info): whether a "neterror" is a certificate failure;
  //   netErrorKind(info): "certerror", "neterror", or null for a failed load;
  //   refreshWindowUI(win): its own window UI (refreshUI runs it);
  //   sessionChoice(tab): what SessionStore keeps of a tab's engine choice;
  //   restoreSessionChoice(tab, choice, url): puts that choice back;
  //   onGeckoLocationChange(tab, location): a Firefox tab navigated.
  _engines: new Map(),

  registerEngine(name, adapter) {
    this._engines.set(name, adapter);
  },

  // The service of a tab state's engine (or of an engine name), read each
  // time so a test's stand-in service takes effect.
  _svc(stateOrEngine) {
    const name =
      typeof stateOrEngine == "string" ? stateOrEngine : stateOrEngine?.engine;
    return this._engines.get(name)?.service ?? null;
  },

  _adapterOf(state) {
    return this._engines.get(state?.engine) ?? null;
  },

  isEngineTab(tab) {
    return !!tab?._whimsyEngineState;
  },

  stateOf(tab) {
    return tab?._whimsyEngineState ?? null;
  },

  // Shows targetURI's page in an engine over the tab's parked Gecko
  // <browser>: creates the engine's view below Gecko's content, routes its
  // events, and lays it out. The caller loads the page. Returns the tab's
  // state, or null when the engine couldn't create a view.
  _openTab(tab, engine, targetURI, dataStoreId) {
    const win = tab.ownerDocument.defaultView;
    const browser = tab.linkedBrowser;
    const adapter = this._engines.get(engine);
    const svc = adapter?.service;
    if (!svc || !browser) {
      return null;
    }

    const state = {
      id: 0,
      engine,
      tabAttribute: adapter.tabAttribute,
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

    // W32: download events outlive the tab's WKWebView (a discard or a
    // close mustn't strand a running download), so they skip the per-tab
    // checks.
    const listener = (id, type, data) => {
      if (type == "download" || type == "download-destination") {
        this._onDownloadEvent(type, data, engine, tab.documentGlobal);
        return;
      }
      this._onNativeEvent(tab, id, type, data);
    };
    state.listener = listener;
    state.dataStoreId = dataStoreId;

    let id = 0;
    try {
      id = svc.createTab(win, dataStoreId, "below", listener);
    } catch (e) {
      console.error("WhimsyWebKit: createTab failed", e);
      return null;
    }
    state.id = id;
    tab._whimsyEngineState = state;
    tab.setAttribute(state.tabAttribute, "true");
    browser.setAttribute(state.tabAttribute, "true");
    this._sessionStates.set(browser.permanentKey, state);

    // Expose the engine tab's live nsIURI through browser.currentURI so
    // WhimsySiteSettings, ZenSiteDataPanel, gURLBar, and ⌘K see the live site
    // while the underlying Gecko <browser> is parked on about:blank.
    this._hookURI(state);

    // Park the underlying Gecko <browser> on about:blank once any in-flight
    // initial load finishes so Gecko doesn't run duplicate page scripts/media.
    if (browser.webProgress?.isLoadingDocument) {
      win.setTimeout(() => this._parkGecko(tab, state), 50);
    } else {
      this._parkGecko(tab, state);
    }

    this.syncReservedShortcuts(win, state);
    svc.setVisible(state.id, win.gBrowser.selectedTab == tab);
    this.syncLayout(win);
    this._writeSession(state);
    return state;
  },

  // -------------------------------------------------------------------------
  // W32: SessionStore. An engine tab's Gecko <browser> sits parked on
  // about:blank, so SessionStore (and the Archive, closed tabs, and the
  // session file, all built from its cache) would keep that. Its history
  // entry is the engine's page instead, and the tab's engine choice is a
  // custom tab value, so a restored tab opens its page in the same engine.

  SESSION_KEY: "whimsy-engine",

  // Gecko <browser> permanentKey -> engine tab state.
  _sessionStates: new WeakMap(),

  _sessionHistory(state) {
    const uri = safeNewURI((state.geckoPage && state.certURL) || state.url);
    if (!isWebURI(uri)) {
      return null;
    }
    let triggeringPrincipal_base64 = lazy.E10SUtils.SERIALIZED_SYSTEMPRINCIPAL;
    try {
      triggeringPrincipal_base64 = lazy.E10SUtils.serializePrincipal(
        Services.scriptSecurityManager.createContentPrincipal(uri, {
          userContextId: state.tab?.userContextId || 0,
        })
      );
    } catch {}
    return {
      entries: [
        {
          url: uri.spec,
          title: state.title || uri.spec,
          triggeringPrincipal_base64,
        },
      ],
      index: 1,
    };
  },

  // SessionStore's hook (whimsy-SessionStore-sys-mjs.patch): Gecko's
  // history for an engine tab's parked <browser> becomes the engine's page.
  // A closing tab (or window) loses its engine state before its <browser>
  // sends its final update, and that update (the parked about:blank) is
  // what SessionStore copies into the closed tab, so the rewrite outlives
  // the engine state. Only leaving the engine for Firefox
  // (_resyncGeckoSession) or a newer engine state for the tab ends it.
  rewriteSessionUpdate(permanentKey, update) {
    const state = permanentKey && this._sessionStates.get(permanentKey);
    const data = update?.data;
    if (!state || !data) {
      return;
    }
    const current = state.tab?._whimsyEngineState;
    if (current && current != state) {
      return;
    }
    if (!("history" in data) && !("historychange" in data)) {
      return;
    }
    delete data.historychange;
    const history = this._sessionHistory(state);
    if (history) {
      data.history = history;
    } else {
      delete data.history;
    }
  },

  // Puts the engine's page in SessionStore's cache and saves soon.
  _writeSession(state) {
    const { tab, browser } = state ?? {};
    if (!tab || tab._whimsyEngineState != state || !browser?.permanentKey) {
      return;
    }
    const history = this._sessionHistory(state);
    if (!history) {
      return;
    }
    try {
      lazy.TabStateCache.update(browser.permanentKey, { history });
    } catch {}
    this.saveEngineChoice(tab, { force: true });
  },

  // The tab left its engine for Firefox: SessionStore's cache follows the
  // Gecko <browser>'s own history again.
  _resyncGeckoSession(tab) {
    const browser = tab?.linkedBrowser;
    if (browser?.permanentKey) {
      this._sessionStates.delete(browser.permanentKey);
    }
    const sh = browser?.browsingContext?.sessionHistory;
    if (!sh || !browser.permanentKey) {
      return;
    }
    try {
      const history = lazy.SessionHistory.collectFromParent(
        browser.currentURI?.spec,
        true,
        sh
      );
      if (history) {
        lazy.TabStateCache.update(browser.permanentKey, { history });
      }
    } catch (e) {
      console.error("WhimsyEngineTabs: couldn't resync session history", e);
    }
    this.saveEngineChoice(tab);
  },

  // Saves the tab's engine choice as a custom tab value (SessionStore saves
  // it with the tab, closed tabs and the Archive included). Never removed
  // when a tab closes: its closed-tab data shares the value.
  saveEngineChoice(tab, { force = false } = {}) {
    if (!tab?.isConnected || tab.closing) {
      return;
    }
    const choice = { engine: this.stateOf(tab)?.engine ?? null };
    let any = !!choice.engine;
    for (const [name, adapter] of this._engines) {
      const own = adapter.sessionChoice?.(tab);
      if (own) {
        choice[name] = own;
        any = true;
      }
    }
    const value = any ? JSON.stringify(choice) : "";
    if (!force && value == (tab._whimsyEngineSaved ?? "")) {
      return;
    }
    try {
      if (value) {
        lazy.SessionStore.setCustomTabValue(tab, this.SESSION_KEY, value);
      } else if (tab._whimsyEngineSaved) {
        lazy.SessionStore.deleteCustomTabValue(tab, this.SESSION_KEY);
      }
      tab._whimsyEngineSaved = value;
    } catch {}
  },

  // A tab is being restored (session restore, Undo Close Tab, the
  // Archive): its saved engine choice comes back, so loading its page
  // opens it in that engine.
  _onSessionRestoring(tab) {
    if (!tab || this.stateOf(tab)) {
      return;
    }
    let choice = null;
    try {
      choice = parseJSON(
        lazy.SessionStore.getCustomTabValue(tab, this.SESSION_KEY) || "{}"
      );
    } catch {}
    tab._whimsyEngineSaved = choice && Object.keys(choice).length
      ? JSON.stringify(choice)
      : "";
    if (!choice) {
      return;
    }
    let url = "";
    try {
      const tabState = JSON.parse(lazy.SessionStore.getTabState(tab));
      const entry = tabState.entries?.[(tabState.index || 1) - 1];
      url = entry?.url || "";
    } catch {}
    for (const [name, adapter] of this._engines) {
      try {
        adapter.restoreSessionChoice?.(tab, choice[name] ?? null, url, {
          engine: choice.engine ?? null,
        });
      } catch (e) {
        console.error("WhimsyEngineTabs: couldn't restore the engine choice", e);
      }
    }
  },

  _destroyTabState(tab) {
    const state = tab?._whimsyEngineState;
    if (!state) {
      return;
    }
    delete tab._whimsyEngineState;
    tab.removeAttribute(state.tabAttribute);
    const { browser, id } = state;
    this._cancelMediaPrompts(state);
    this._closeLoginPopup(tab);
    if (state.crashed) {
      tab.removeAttribute("crashed");
    }
    if (browser) {
      browser.removeAttribute(state.tabAttribute);
      // A discarded tab's lazy browser carries tabbrowser's own currentURI.
      this._unhookURI(state);
    }
    for (const resolve of state.loadWaiters) {
      try {
        resolve();
      } catch {}
    }
    state.loadWaiters.clear();
    if (id) {
      try {
        this._svc(state)?.destroyTab(id);
      } catch {}
    }
    state.id = 0;
  },

  // Expose the engine tab's live nsIURI through browser.currentURI.
  _hookURI(state) {
    const { browser } = state;
    if (!browser) {
      return;
    }
    Object.defineProperty(browser, "currentURI", {
      configurable: true,
      get() {
        return state.uri;
      },
    });
    state.uriHooked = true;
  },

  _unhookURI(state) {
    if (!state.uriHooked) {
      return;
    }
    state.uriHooked = false;
    const { browser } = state;
    if (state.origCurrentURIDescriptor) {
      Object.defineProperty(
        browser,
        "currentURI",
        state.origCurrentURIDescriptor
      );
    } else {
      delete browser.currentURI;
    }
  },

  _geckoURI(browser) {
    try {
      const proto = Object.getPrototypeOf(browser);
      const desc = Object.getOwnPropertyDescriptor(proto, "currentURI");
      return desc?.get ? desc.get.call(browser) : null;
    } catch {
      return null;
    }
  },

  // Parks the Gecko <browser> under an engine tab on about:blank.
  _parkGecko(tab, state) {
    if (tab._whimsyEngineState != state || state.geckoPage) {
      return;
    }
    const { browser } = state;
    if (!browser?.isConnected || !tab.linkedPanel) {
      return;
    }
    try {
      const geckoURI = this._geckoURI(browser);
      if (geckoURI && geckoURI.spec != "about:blank") {
        state.parkingGecko = true;
        browser.fixupAndLoadURIString("about:blank", {
          triggeringPrincipal:
            Services.scriptSecurityManager.getSystemPrincipal(),
        });
      }
    } catch {}
  },

  // The state of an engine tab whose view exists (not discarded).
  _live(tab) {
    const state = this.stateOf(tab);
    return state?.id && this._svc(state) ? state : null;
  },

  // An engine tab currently showing its engine's view (not a Gecko error or
  // tab-crashed page).
  _engineShown(tab) {
    const state = this._live(tab);
    return state && !state.geckoPage ? state : null;
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
    if (!state.id) {
      // Discarded: the URL loads when the tab comes back.
      state.suspended = null;
      if (state.tab.selected) {
        this._resumeTab(state.tab);
      }
      return true;
    }
    // W32: a load from Gecko's network or certificate error page (⌘K, a
    // link, the address bar) leaves the error page: the engine's view shows
    // the new page, and the Gecko <browser> parks again.
    if (state.geckoPage == "certerror" || state.geckoPage == "neterror") {
      this._exitGeckoPage(state.tab, state, { repark: true });
    }
    const promise = waitForLoad ? this._waitForNextLoad(state) : null;
    this._svc(state)?.loadURL(state.id, uri.spec);
    this.refreshUI(state.win);
    if (promise) {
      await promise;
    }
    return true;
  },

  async evaluateInTab(tab, script) {
    const state = this._live(tab);
    if (!state || !this._svc(state)) {
      return null;
    }
    return this._svc(state).evaluate(state.id, script);
  },

  hitTestAtTab(tab, x, y) {
    const state = this._live(tab);
    if (!state || !this._svc(state)) {
      return "none";
    }
    return this._svc(state).hitTestAt(state.id, x, y);
  },

  acceptsFirstMouseAtTab(tab, x, y) {
    const state = this._live(tab);
    if (!state || !this._svc(state)) {
      return false;
    }
    return this._svc(state).acceptsFirstMouseAt(state.id, x, y);
  },

  focusTab(tab) {
    const state = this._live(tab);
    if (!state || !this._svc(state)) {
      return;
    }
    try {
      this._svc(state).focus(state.id);
    } catch {}
  },

  blurTab(tab) {
    const state = this._live(tab);
    if (!state || !this._svc(state)) {
      return;
    }
    try {
      this._svc(state).blur(state.id);
    } catch {}
  },

  isTabFocused(tab) {
    const state = this._live(tab);
    if (!state || !this._svc(state)) {
      return false;
    }
    try {
      return this._svc(state).isFocused(state.id);
    } catch {
      return false;
    }
  },

  goBack(tab) {
    const state = this._live(tab);
    if (!state || !this._svc(state)) {
      return false;
    }
    this._svc(state).goBack(state.id);
    return true;
  },

  goForward(tab) {
    const state = this._live(tab);
    if (!state || !this._svc(state)) {
      return false;
    }
    this._svc(state).goForward(state.id);
    return true;
  },

  reload(tab) {
    const state = this._live(tab);
    if (!state) {
      return false;
    }
    if (state.crashed) {
      return this._reviveCrashed(tab);
    }
    this._svc(state).reload(state.id);
    return true;
  },

  // W32 epoch guard: runs aScript (a function body) in Whimsy's isolated
  // world only while the page is still the document with aEpoch (empty: the
  // current one). Rejects with an AbortError once that document is gone.
  async evaluateGuardedInTab(tab, script, epoch = "") {
    const state = this._live(tab);
    if (!state) {
      throw new DOMException("The tab has no live page", "AbortError");
    }
    return this._svc(state).evaluateGuarded(state.id, epoch, script);
  },

  currentEpochOf(tab) {
    const state = this._live(tab);
    if (!state) {
      return "";
    }
    try {
      return this._svc(state).currentEpoch(state.id);
    } catch {
      return "";
    }
  },

  stop(tab) {
    const state = this._live(tab);
    if (!state || !this._svc(state)) {
      return false;
    }
    this._svc(state).stop(state.id);
    return true;
  },

  // Re-applies what WebKit owns on the tab (title, icon, busy) after the
  // parked Gecko <browser>'s own load events overwrote it.
  _restoreTabChrome(tab, state) {
    const { win } = state;
    if (!win || win.closed) {
      return;
    }
    if (state.title && tab.label != state.title) {
      tab._fullLabel = state.title;
      tab.label = state.title;
      tab.setAttribute("label", state.title);
      if (tab.selected) {
        win.gBrowser.updateTitlebar?.();
      }
    }
    if (state.favicon && tab.getAttribute("image") != state.favicon) {
      tab.setAttribute("image", state.favicon);
    }
    if (state.loading) {
      tab.setAttribute("busy", "true");
    } else if (tab.hasAttribute("busy")) {
      tab.removeAttribute("busy");
      tab.removeAttribute("progress");
    }
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
        this._writeSession(state);
        break;
      }
      case "location": {
        if (!data || (data == "about:blank" && state.url != "about:blank")) {
          break;
        }
        const uri = safeNewURI(data);
        if (uri) {
          // Leaving the page withdraws its camera/microphone request. Only
          // WebKit's own location reports set committedPage: loadURLInTab
          // updates state.uri before the page actually changes.
          if (state.committedPage != uri.specIgnoringRef) {
            state.committedPage = uri.specIgnoringRef;
            this._cancelMediaPrompts(state);
            this._closeLoginPopup(tab);
          }
          state.url = uri.spec;
          state.uri = uri;
          if (tab.selected) {
            this._syncAddressBar(win, tab);
            this.refreshUI(win);
          }
          this._writeSession(state);
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
        // A reload sends no location change; end the old document's login
        // session here. Never let it stop the load bookkeeping above.
        try {
          lazy.WhimsyEngineLogins.closeIfStale(tab);
        } catch (e) {
          console.error("WhimsyEngineTabs: closing a stale login session failed", e);
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
      // W32: WebKit's delegate requests and failures, answered by Gecko's
      // own prompts, pages, and services.
      case "crashed":
        this._onCrashed(tab, state);
        break;
      case "neterror":
        this._onNetError(tab, state, parseJSON(data));
        break;
      case "dialog":
        this._onDialog(tab, state, id, parseJSON(data));
        break;
      case "openpanel":
        this._onOpenPanel(tab, state, id, parseJSON(data));
        break;
      case "auth":
        this._onAuth(tab, state, id, parseJSON(data));
        break;
      case "servertrust":
        this._onServerTrust(tab, state, id, parseJSON(data));
        break;
      case "media":
        this._onMedia(tab, state, id, parseJSON(data)).catch(e => {
          console.error("WhimsyWebKit: media request failed", e);
        });
        break;
      // W32: Firefox's password manager (WhimsyEngineLogins).
      case "login":
        lazy.WhimsyEngineLogins.onEvent(
          this,
          tab,
          state,
          this._svc(state),
          parseJSON(data)
        );
        break;
    }
  },

  _syncAddressBar(win, tab) {
    const state = this.stateOf(tab);
    if (!state || state.geckoPage || !state.uri || !win.gURLBar) {
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
    if (!state || state.geckoPage) {
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
  // W32: discards. Gecko's tab unloader and discardBrowser() free the
  // WKWebView; selecting the tab brings it back from WebKit's interaction
  // state, with its back/forward list and scroll position.

  _suspendTab(tab) {
    const state = this._live(tab);
    if (!state) {
      return;
    }
    const svc = this._svc(state);
    let saved = "";
    if (state.geckoPage == "certerror" || state.geckoPage == "neterror") {
      // Load the failing URL again when the tab comes back.
      state.url = state.certURL || state.url;
      state.uri = safeNewURI(state.url) || state.uri;
    } else {
      try {
        saved = svc.saveSessionState(state.id);
      } catch {}
    }
    this._cancelMediaPrompts(state);
    this._closeLoginPopup(tab);
    try {
      svc.destroyTab(state.id);
    } catch {}
    state.id = 0;
    state.suspended = saved || JSON.stringify({ url: state.url });
    state.geckoPage = null;
    state.certURL = null;
    state.crashed = false;
    state.loading = false;
    // tabbrowser gave the lazy browser its own currentURI (the WebKit URL,
    // read through ours when it discarded the tab).
    state.uriHooked = false;
    for (const resolve of [...state.loadWaiters]) {
      try {
        resolve();
      } catch {}
    }
  },

  // Gecko's tab unloader (whimsy-TabUnloader-sys-mjs.patch) asks this for
  // what its parked <browser> can't tell it: whether the engine's page plays
  // sound or captures, and the engine's content process. Null for a tab with
  // no engine view (a Gecko tab, or a discarded one).
  unloaderActivity(tab) {
    const state = this._live(tab);
    if (!state) {
      return null;
    }
    let activity;
    try {
      activity = parseJSON(this._svc(state).tabActivity?.(state.id));
    } catch {
      return null;
    }
    const pid =
      Number.isInteger(activity.pid) && activity.pid > 0 ? activity.pid : 0;
    if (pid) {
      this._unloaderFootprints.set(pid, Number(activity.footprint) || 0);
    }
    return {
      pid,
      audio: !!activity.audio,
      capture: !!activity.capture,
    };
  },

  // Fills in the memory of the engine processes unloaderActivity() named
  // (Gecko's process list doesn't hold them), in the unloader's process map.
  addUnloaderMemory(processMap) {
    for (const [pid, footprint] of this._unloaderFootprints) {
      const info = processMap.get(pid);
      if (info && !info.memory) {
        info.memory = footprint;
      }
    }
    this._unloaderFootprints.clear();
  },

  _unloaderFootprints: new Map(),

  // W32: the login popup belongs to the page and tab it opened for.
  _closeLoginPopup(tab) {
    lazy.WhimsyEngineLogins.close(tab);
  },

  _onBrowserInserted(tab) {
    const state = this.stateOf(tab);
    if (!state || state.id) {
      return;
    }
    // tabbrowser deleted the lazy browser's own properties, ours included.
    state.browser = tab.linkedBrowser;
    state.origCurrentURIDescriptor = Object.getOwnPropertyDescriptor(
      state.browser,
      "currentURI"
    );
    this._hookURI(state);
    this._sessionStates.set(state.browser.permanentKey, state);
    // SessionStore restored about:blank (see onInsertCapture); its cache
    // gets the engine's page back.
    this._writeSession(state);
    // SessionStore restores the Gecko browser's own history; park it again
    // once that load stops.
    state.parkAfterInsert = true;
    if (tab.selected) {
      this._resumeTab(tab);
    }
  },

  _resumeTab(tab) {
    const state = this.stateOf(tab);
    const svc = this._svc(state);
    if (!state || state.id || !svc || !tab.linkedPanel) {
      return;
    }
    const { win } = state;
    let id = 0;
    try {
      id = svc.createTab(win, state.dataStoreId, "below", state.listener);
    } catch (e) {
      console.error("WhimsyWebKit: createTab failed", e);
      return;
    }
    state.id = id;
    if (!state.uriHooked) {
      this._hookURI(state);
    }
    const saved = state.suspended || "";
    state.suspended = null;
    const parsed = parseJSON(saved);
    state.loading = true;
    tab.setAttribute("busy", "true");
    const loaded = this._waitForNextLoad(state);
    let restored = false;
    if (parsed.state) {
      try {
        restored = svc.restoreSessionState(id, saved);
      } catch {}
    }
    if (!restored) {
      try {
        svc.loadURL(id, parsed.url || state.url);
      } catch (e) {
        console.error("WhimsyWebKit: loadURL failed", e);
      }
    }
    this.syncReservedShortcuts(win, state);
    try {
      svc.setVisible(id, tab.selected);
    } catch {}
    this.syncLayout(win);
    if (tab.selected && win.document.activeElement == state.browser) {
      this.focusTab(tab);
    }
    this.refreshUI(win);

    const x = Math.max(0, Math.round(Number(parsed.scrollX) || 0));
    const y = Math.max(0, Math.round(Number(parsed.scrollY) || 0));
    if (x || y) {
      // WebKit usually restores the scroll position with the history item;
      // if the page is still at the top once it loads, put it back.
      loaded.then(() => {
        if (state.id != id) {
          return;
        }
        svc
          .evaluateGuarded(
            id,
            "",
            `if (window.scrollX == 0 && window.scrollY == 0) {
               window.scrollTo(${x}, ${y});
             }
             return window.scrollY;`
          )
          .catch(() => {});
      });
    }
  },

  // -------------------------------------------------------------------------
  // W32: Gecko pages shown in place of the WKWebView (the certificate error
  // page and the tab-crashed page). The parked Gecko <browser> shows them,
  // with its own address, title, and Back/Reload handling.

  _enterGeckoPage(tab, state, kind) {
    state.geckoPage = kind;
    this._cancelMediaPrompts(state);
    this._unhookURI(state);
    try {
      this._svc(state).blur(state.id);
      this._svc(state).setVisible(state.id, false);
    } catch {}
  },

  _exitGeckoPage(tab, state, { repark = false } = {}) {
    if (!state.geckoPage) {
      return;
    }
    state.geckoPage = null;
    state.certURL = null;
    if (tab._whimsyEngineState != state) {
      return;
    }
    this._hookURI(state);
    if (repark) {
      this._parkGecko(tab, state);
    }
    this._writeSession(state);
    const { win } = state;
    if (state.id) {
      try {
        this._svc(state).setVisible(state.id, tab.selected);
      } catch {}
    }
    this._restoreTabChrome(tab, state);
    if (tab.selected) {
      this._syncAddressBar(win, tab);
      this._syncNavigationCommands(win, tab);
      this.syncLayout(win);
    }
    this.refreshUI(win);
  },

  // The parked Gecko <browser>'s location changed while it shows a Gecko
  // page for this tab.
  _onGeckoPageLocation(tab, state, location, flags) {
    if (state.geckoPage != "certerror" && state.geckoPage != "neterror") {
      return;
    }
    if (flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_ERROR_PAGE) {
      return;
    }
    if (isWebURI(location) && state.geckoPage == "neterror") {
      // "Try Again" reached the site: WebKit loads it again.
      state.netRetry = {
        host: location.asciiHost,
        until: Date.now() + CERT_RETRY_MS,
      };
      const uri = location;
      this._exitGeckoPage(tab, state, { repark: true });
      state.url = uri.spec;
      state.uri = uri;
      if (state.id) {
        try {
          this._svc(state).loadURL(state.id, uri.spec);
        } catch {}
      }
      this._syncAddressBar(state.win, tab);
      return;
    }
    if (isWebURI(location)) {
      // "Accept the Risk and Continue" (or a reload after an exception was
      // added): Gecko loaded the site, so WebKit loads it again with Gecko's
      // certificate exception.
      state.certRetry = {
        host: location.asciiHost,
        until: Date.now() + CERT_RETRY_MS,
      };
      const uri = location;
      this._exitGeckoPage(tab, state, { repark: true });
      state.url = uri.spec;
      state.uri = uri;
      if (state.id) {
        try {
          this._svc(state).loadURL(state.id, uri.spec);
        } catch {}
      }
      this._syncAddressBar(state.win, tab);
      return;
    }
    // "Go Back" on the error page (about:blank, or the home page when
    // there's nothing to go back to).
    this._exitGeckoPage(tab, state, { repark: true });
    if (state.crashed) {
      this._onCrashed(tab, state);
    }
  },

  _netErrorKind(state, info) {
    const adapter = this._adapterOf(state);
    if (adapter?.netErrorKind) {
      return adapter.netErrorKind(info);
    }
    return adapter?.isCertError(info) ? "certerror" : null;
  },

  // W32: a failed load shows Gecko's own error page. The parked <browser>
  // loads the failing URL, so Gecko meets the same failure and shows its
  // certificate error or connection error page, with its own Try Again.
  _onNetError(tab, state, info) {
    const kind = this._netErrorKind(state, info);
    if (!kind) {
      return;
    }
    const uri = safeNewURI(info.url);
    if (!uri || !isWebURI(uri) || state.geckoPage) {
      return;
    }
    if (kind == "certerror" && !uri.schemeIs("https")) {
      return;
    }
    const retry = kind == "certerror" ? state.certRetry : state.netRetry;
    state.certRetry = null;
    state.netRetry = null;
    if (retry && retry.host == uri.asciiHost && Date.now() < retry.until) {
      // Gecko reaches the site and WebKit still doesn't: open it in
      // Firefox rather than loop back to the error page.
      this._adapterOf(state).switchTab(tab, "firefox", {
        url: uri.spec,
        waitForLoad: false,
      });
      return;
    }
    const { browser, win } = state;
    if (!browser?.isConnected) {
      return;
    }
    this._enterGeckoPage(tab, state, kind);
    // The failing URL (both kinds), loaded again when the tab comes back.
    state.certURL = uri.spec;
    try {
      browser.fixupAndLoadURIString(uri.spec, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
    } catch (e) {
      console.error("WhimsyWebKit: couldn't show the error page", e);
      this._exitGeckoPage(tab, state);
      return;
    }
    this.refreshUI(win);
  },

  // W32: the WebContent process died. A selected tab shows Gecko's
  // tab-crashed page (Restore reloads it in WebKit); a background tab
  // reloads when it's next selected, as Gecko restores a crashed background
  // tab on demand.
  _onCrashed(tab, state) {
    state.crashed = true;
    state.loading = false;
    tab.removeAttribute("busy");
    tab.removeAttribute("progress");
    for (const resolve of [...state.loadWaiters]) {
      try {
        resolve();
      } catch {}
    }
    this._cancelMediaPrompts(state);
    if (state.geckoPage || !tab.selected || !tab.linkedPanel) {
      return;
    }
    const { browser, win } = state;
    this._enterGeckoPage(tab, state, "tabcrashed");
    try {
      win.gBrowser.updateBrowserRemoteness(browser, {
        remoteType: lazy.E10SUtils.NOT_REMOTE,
      });
      browser.setAttribute("crashedPageTitle", state.title || "");
      browser.docShell.displayLoadError(
        Cr.NS_ERROR_CONTENT_CRASHED,
        state.uri,
        null
      );
      browser.removeAttribute("crashedPageTitle");
    } catch (e) {
      console.error("WhimsyWebKit: couldn't show the tab-crashed page", e);
    }
    tab.setAttribute("crashed", true);
    this.refreshUI(win);
  },

  _reviveCrashed(tab) {
    const state = this._live(tab);
    if (!state?.crashed) {
      return false;
    }
    state.crashed = false;
    tab.removeAttribute("crashed");
    if (state.geckoPage == "tabcrashed") {
      try {
        state.win.gBrowser.updateBrowserRemoteness(state.browser, {
          remoteType: lazy.E10SUtils.DEFAULT_REMOTE_TYPE,
        });
      } catch (e) {
        console.error("WhimsyWebKit: couldn't restore the parked browser", e);
      }
      this._exitGeckoPage(tab, state);
    }
    state.loading = true;
    tab.setAttribute("busy", "true");
    try {
      this._svc(state).reload(state.id);
    } catch {}
    if (tab.selected) {
      this.focusTab(tab);
    }
    return true;
  },

  // about:tabcrashed's Restore buttons call SessionStore.reviveCrashedTab
  // (and reviveAllCrashedTabs, which calls it per tab); WebKit tabs reload
  // their WKWebView instead.
  _installCrashRevive() {
    const ss = lazy.SessionStore;
    if (this._crashReviveInstalled || typeof ss?.reviveCrashedTab != "function") {
      return;
    }
    this._crashReviveInstalled = true;
    const orig = ss.reviveCrashedTab;
    const self = this;
    ss.reviveCrashedTab = function (aTab) {
      if (aTab && self._reviveCrashed(aTab)) {
        return undefined;
      }
      return orig.call(this, aTab);
    };
  },

  // -------------------------------------------------------------------------
  // W32: WebKit delegate requests, answered through Gecko's own prompts,
  // file picker, password manager, certificate exceptions, permission
  // doorhanger, and downloads list. Every request gets exactly one answer.

  _respond(id, req, response, engine) {
    if (!req) {
      return;
    }
    try {
      this._svc(engine)?.respond(id, req, JSON.stringify(response ?? {}));
    } catch {}
  },

  async _onDialog(tab, state, id, info) {
    const answer = response =>
      this._respond(id, info.req, response, state.engine);
    const bc = state.browser?.browsingContext;
    if (!bc) {
      answer({});
      return;
    }
    let title = "";
    try {
      title = Services.io.newURI(info.origin).displayHostPort;
    } catch {}
    const modal = Ci.nsIPrompt.MODAL_TYPE_TAB;
    const message = String(info.message ?? "");
    try {
      if (info.kind == "alert") {
        await Services.prompt.asyncAlert(bc, modal, title, message);
        answer({});
      } else if (info.kind == "confirm") {
        const bag = await Services.prompt.asyncConfirm(bc, modal, title, message);
        answer({ ok: !!bag.getProperty("ok") });
      } else if (info.kind == "prompt") {
        const bag = await Services.prompt.asyncPrompt(
          bc,
          modal,
          title,
          message,
          String(info.value ?? ""),
          null,
          false
        );
        answer({
          ok: !!bag.getProperty("ok"),
          value: String(bag.getProperty("value") ?? ""),
        });
      } else {
        answer({});
      }
    } catch {
      answer({});
    }
  },

  _onOpenPanel(tab, state, id, info) {
    const answer = response =>
      this._respond(id, info.req, response, state.engine);
    const bc = state.browser?.browsingContext;
    if (!bc) {
      answer({});
      return;
    }
    const nsIFilePicker = Ci.nsIFilePicker;
    let mode = nsIFilePicker.modeOpen;
    if (info.directories) {
      mode = nsIFilePicker.modeGetFolder;
    } else if (info.multiple) {
      mode = nsIFilePicker.modeOpenMultiple;
    }
    // The same title Gecko's <input type=file> gives its picker.
    let title = "";
    try {
      title = Services.strings
        .createBundle("chrome://global/locale/layout/HtmlForm.properties")
        .GetStringFromName(info.directories ? "DirectoryUpload" : "FileUpload");
    } catch {}
    const fp = Cc["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
    try {
      fp.init(bc, title, mode);
      fp.open(result => {
        if (result != nsIFilePicker.returnOK) {
          answer({});
          return;
        }
        const paths = [];
        try {
          if (mode == nsIFilePicker.modeOpenMultiple) {
            for (const file of fp.files) {
              paths.push(file.QueryInterface(Ci.nsIFile).path);
            }
          } else if (fp.file) {
            paths.push(fp.file.path);
          }
        } catch {}
        answer(paths.length ? { paths } : {});
      });
    } catch (e) {
      console.error("WhimsyWebKit: file picker failed", e);
      answer({});
    }
  },

  // HTTP auth: Firefox's auth prompt, filled and saved by the password
  // manager. Credentials go straight to WebKit; nothing here keeps or logs
  // them.
  _onAuth(tab, state, id, info) {
    const answer = response =>
      this._respond(id, info.req, response, state.engine);
    const { browser, win } = state;
    const uri = safeNewURI(info.url);
    if (!uri || !browser || !win) {
      answer({});
      return;
    }
    let prompter;
    let channel;
    try {
      prompter = Cc["@mozilla.org/passwordmanager/authpromptfactory;1"]
        .getService(Ci.nsIPromptFactory)
        .getPrompt(win, Ci.nsIAuthPrompt2);
      try {
        prompter.QueryInterface(Ci.nsILoginManagerAuthPrompter).browser =
          browser;
      } catch {}
      channel = lazy.NetUtil.newChannel({
        uri,
        loadUsingSystemPrincipal: true,
      });
    } catch (e) {
      console.error("WhimsyWebKit: auth prompt unavailable", e);
      answer({});
      return;
    }
    const nsIAuthInformation = Ci.nsIAuthInformation;
    let flags = info.proxy
      ? nsIAuthInformation.AUTH_PROXY
      : nsIAuthInformation.AUTH_HOST;
    if (info.failed) {
      flags |= nsIAuthInformation.PREVIOUS_FAILED;
    }
    const authInfo = {
      QueryInterface: ChromeUtils.generateQI(["nsIAuthInformation"]),
      flags,
      authenticationScheme: String(info.scheme || "basic"),
      realm: String(info.realm || ""),
      domain: "",
      username: String(info.username || ""),
      password: "",
    };
    const callback = {
      QueryInterface: ChromeUtils.generateQI(["nsIAuthPromptCallback"]),
      onAuthAvailable(_context, result) {
        answer({
          username: String(result?.username ?? authInfo.username),
          password: String(result?.password ?? authInfo.password),
        });
      },
      onAuthCancelled() {
        answer({});
      },
    };
    const level = uri.schemeIs("https")
      ? Ci.nsIAuthPrompt2.LEVEL_SECURE
      : Ci.nsIAuthPrompt2.LEVEL_NONE;
    try {
      prompter.asyncPromptAuth(channel, callback, null, level, authInfo);
    } catch (e) {
      console.error("WhimsyWebKit: auth prompt failed", e);
      answer({});
    }
  },

  // A certificate WebKit doesn't trust is accepted only when Gecko has an
  // exception for that host, port, and certificate.
  _onServerTrust(tab, state, id, info) {
    let trust = false;
    try {
      const cert = Cc["@mozilla.org/security/x509certdb;1"]
        .getService(Ci.nsIX509CertDB)
        .constructX509FromBase64(String(info.cert || ""));
      const overrides = Cc["@mozilla.org/security/certoverride;1"].getService(
        Ci.nsICertOverrideService
      );
      const host = String(info.host || "");
      const port = Number(info.port) > 0 ? Number(info.port) : 443;
      const attrs = [{}];
      if (tab.userContextId) {
        attrs.unshift({ userContextId: tab.userContextId });
      }
      trust = attrs.some(oa =>
        overrides.hasMatchingOverride(host, port, oa, cert, {})
      );
    } catch {}
    this._respond(id, info.req, { trust }, state.engine);
  },

  _mediaWindowId: 0x7f000000,

  // The capture devices WebKit uses (the system defaults).
  _captureDevices(engine) {
    return parseJSON(this._svc(engine)?.defaultCaptureDevices?.() ?? "{}");
  },

  // Camera and microphone: Gecko's sharing doorhanger and site permissions.
  // WebRTCParent's prompt runs on a stand-in actor for the WebKit page.
  async _onMedia(tab, state, id, info) {
    const answer = allow =>
      this._respond(id, info.req, { allow: !!allow }, state.engine);
    let principal;
    try {
      principal =
        Services.scriptSecurityManager.createContentPrincipalFromOrigin(
          info.origin
        );
    } catch {
      answer(false);
      return;
    }
    const kinds = [];
    if (info.camera) {
      kinds.push("camera");
    }
    if (info.microphone) {
      kinds.push("microphone");
    }
    if (!kinds.length || !state.browser) {
      answer(false);
      return;
    }
    const { SitePermissions } = lazy;
    const states = kinds.map(
      kind => SitePermissions.getForPrincipal(principal, kind, state.browser).state
    );
    if (states.includes(SitePermissions.BLOCK)) {
      answer(false);
      return;
    }
    const secure = principal.isOriginPotentiallyTrustworthy;
    if (secure && states.every(s => s == SitePermissions.ALLOW)) {
      answer(true);
      return;
    }

    const devices = await this._captureDevices(state.engine);
    const camera = info.camera ? devices.camera : null;
    const microphone = info.microphone ? devices.microphone : null;
    if ((info.camera && !camera?.name) || (info.microphone && !microphone?.name)) {
      // Nothing to capture from, as Gecko's NotFoundError.
      answer(false);
      return;
    }
    if (this.stateOf(tab) != state || state.id != id || state.geckoPage) {
      answer(false);
      return;
    }

    const windowID = ++this._mediaWindowId;
    const callID = Services.uuid.generateUUID().toString();
    const device = (d, index, mediaSource) => ({
      name: String(d.name),
      deviceIndex: index,
      id: String(d.id || d.name),
      mediaSource,
      rawId: String(d.id || d.name),
    });
    const request = {
      callID,
      windowID,
      origin: principal.origin,
      secure,
      requestTypes: [
        ...(camera ? ["Camera"] : []),
        ...(microphone ? ["Microphone"] : []),
      ],
      sharingScreen: false,
      sharingAudio: false,
      videoInputDevices: camera ? [device(camera, 0, "camera")] : [],
      audioInputDevices: microphone ? [device(microphone, 1, "microphone")] : [],
      audioOutputDevices: [],
      audioOutputId: "",
      hasInherentAudioConstraints: false,
      hasInherentVideoConstraints: false,
      isHandlingUserInput: false,
      secondOrigin: null,
    };

    const { browser } = state;
    const manager = {
      documentPrincipal: principal,
      topWindowContext: { documentPrincipal: principal },
      outerWindowId: windowID,
      documentURI: state.uri,
      isClosed: false,
    };
    let settled = false;
    const settle = allow => {
      if (settled) {
        return;
      }
      settled = true;
      state.mediaPrompts?.delete(callID);
      answer(allow);
    };
    const actor = Object.create(lazy.WebRTCParent.prototype);
    const own = value => ({ value, configurable: true, writable: true });
    Object.defineProperties(actor, {
      manager: own(manager),
      browsingContext: own(browser.browsingContext),
      getBrowser: own(() => browser),
      sendAsyncMessage: own(name => {
        if (name == "webrtc:Allow") {
          settle(true);
        } else if (name == "webrtc:Deny") {
          settle(false);
        }
      }),
    });
    state.mediaPrompts ??= new Map();
    state.mediaPrompts.set(callID, { actor, manager, settle });
    try {
      actor.receiveMessage({ name: "webrtc:Request", data: request });
    } catch (e) {
      console.error("WhimsyWebKit: media prompt failed", e);
      settle(false);
    }
  },

  // Withdraws open camera/microphone prompts (navigation, crash, close).
  _cancelMediaPrompts(state) {
    if (!state?.mediaPrompts?.size) {
      return;
    }
    const prompts = [...state.mediaPrompts];
    state.mediaPrompts.clear();
    for (const [callID, { actor, manager, settle }] of prompts) {
      manager.isClosed = true;
      try {
        actor.receiveMessage({ name: "webrtc:CancelRequest", data: callID });
      } catch {}
      settle(false);
    }
  },

  // Downloads: each WKDownload is a Firefox download (a legacy-saver
  // Download in the downloads list), saved where Firefox saves downloads.
  _downloads: new Map(),

  _onDownloadEvent(type, data, engine, win) {
    const info = parseJSON(data);
    if (type == "download-destination") {
      this._startDownload(info, engine, win).catch(e => {
        console.error("WhimsyWebKit: download failed to start", e);
        this._respond(0, info.req, {}, engine);
      });
      return;
    }
    const record = this._downloads.get(info.dl);
    if (!record) {
      return;
    }
    const { saver } = record;
    if (info.state == "progress") {
      const total = Number(info.total);
      saver.onProgressBytes(Number(info.current) || 0, total > 0 ? total : -1);
      return;
    }
    this._downloads.delete(info.dl);
    record.finished = true;
    if (info.state == "done") {
      IOUtils.stat(record.download.target.path)
        .then(({ size }) => saver.onProgressBytes(size, size))
        .catch(() => {})
        .finally(() => saver.onTransferFinished(Cr.NS_OK));
    } else {
      saver.onTransferFinished(
        info.state == "cancelled" ? Cr.NS_BINDING_ABORTED : Cr.NS_ERROR_FAILURE
      );
    }
  },

  // W32: where a download goes, chosen by Firefox's own download dialog
  // code: the download folder when browser.download.useDownloadDir is on
  // (a unique name there), otherwise Firefox's Save dialog, which starts in
  // the folder last used for that site. Resolves to an nsIFile, or null
  // when the Save dialog is cancelled.
  _chooseDownloadTarget(info, leaf, win) {
    const { nsUnknownContentTypeDialog } = lazy;
    const source = safeNewURI(info.url) || Services.io.newURI("about:blank");
    const dot = leaf.lastIndexOf(".");
    const ext = dot > 0 ? leaf.slice(dot) : "";
    let mimeInfo = null;
    try {
      mimeInfo = Cc["@mozilla.org/mime;1"]
        .getService(Ci.nsIMIMEService)
        .getFromTypeAndExtension(String(info.mime || ""), ext.slice(1));
    } catch {}
    // The Save dialog reads the type's description and extension.
    mimeInfo ??= { description: "", primaryExtension: ext.slice(1) };
    return new Promise(resolve => {
      const launcher = {
        source,
        suggestedFileName: leaf,
        MIMEInfo: mimeInfo,
        saveDestinationAvailable: file => resolve(file || null),
      };
      const context = {
        getInterface: iid => {
          if (win && !win.closed && iid.equals(Ci.nsIDOMWindow)) {
            return win;
          }
          throw Components.Exception("", Cr.NS_ERROR_NO_INTERFACE);
        },
      };
      try {
        new nsUnknownContentTypeDialog().promptForSaveToFileAsync(
          launcher,
          context,
          leaf,
          ext,
          false
        );
      } catch (e) {
        console.error("WhimsyWebKit: couldn't choose where to save", e);
        resolve(null);
      }
    });
  },

  async _startDownload(info, engine, win) {
    const { Downloads, DownloadPaths } = lazy;
    const dir = await Downloads.getPreferredDownloadsDirectory();
    if (Services.prefs.getBoolPref("browser.download.useDownloadDir", true)) {
      await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    }
    const leaf = DownloadPaths.sanitize(String(info.filename || "")) || "download";
    const file = await this._chooseDownloadTarget(info, leaf, win);
    if (!file) {
      // Cancelled in the Save dialog: WebKit drops the download.
      this._respond(0, info.req, {}, engine);
      return;
    }
    // Firefox's dialog code reserves the name (or the person chose to
    // replace a file); WebKit writes to the path itself, which must not
    // exist yet.
    const path = file.path;
    await IOUtils.remove(path, { ignoreAbsent: true });
    const source = safeNewURI(info.url)?.spec || "about:blank";
    const download = await Downloads.createDownload({
      source: { url: source, isPrivate: false },
      target: { path },
      saver: "legacy",
      contentType: String(info.mime || "") || undefined,
    });
    const saver = download.saver;
    const record = { download, saver, finished: false };
    this._downloads.set(info.dl, record);
    // Cancelled from the downloads list: stop WebKit's download too.
    saver.deferCanceled?.promise.then(() => {
      if (!record.finished) {
        record.finished = true;
        this._downloads.delete(info.dl);
        try {
          this._svc(engine)?.cancelDownload(info.dl);
        } catch {}
      }
    });
    const list = await Downloads.getList(Downloads.ALL);
    await list.add(download);
    download.start().catch(() => {});
    saver.onTransferStarted(null);
    if (Number(info.total) > 0) {
      saver.onProgressBytes(0, Number(info.total));
    }
    this._respond(0, info.req, { path }, engine);
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

    // 6. Tab-modal prompts (W32: WebKit's alert/confirm/prompt and HTTP
    // auth use Gecko's), over the selected tab.
    for (const box of doc.querySelectorAll(
      '.dialogStack:not([hidden]) .dialogOverlay[topmost="true"]:not([hidden]) .dialogBox'
    )) {
      if (isVisibleEl(box)) {
        addRect(box.getBoundingClientRect());
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
    if (!win || win.closed) {
      return;
    }
    const tab = win.gBrowser?.selectedTab;
    const state = this._engineShown(tab);
    if (!state) {
      return;
    }
    const m = this.measureBrowserRect(win, state.browser);
    const exclusions = this.collectOverlayExclusions(win);
    try {
      this._svc(state).setFrame(
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

  // W32: one tab's state, or (null) every live engine tab in the window.
  syncReservedShortcuts(win, tabState = null) {
    if (!win) {
      return [];
    }
    const shortcuts = this.collectReservedShortcuts(win);
    const json = JSON.stringify(shortcuts);
    if (tabState) {
      try {
        this._svc(tabState)?.setReservedShortcuts(tabState.id, json);
      } catch {}
      return shortcuts;
    }
    for (const tab of win.gBrowser?.tabs ?? []) {
      const state = this._live(tab);
      if (state) {
        try {
          this._svc(state).setReservedShortcuts(state.id, json);
        } catch {}
      }
    }
    return shortcuts;
  },

  // Each engine's window UI, then the selected engine tab's address bar,
  // commands, and layout.
  refreshUI(win) {
    if (!win || win.closed) {
      return;
    }
    for (const adapter of this._engines.values()) {
      adapter.refreshWindowUI?.(win);
    }
    const tab = win.gBrowser?.selectedTab;
    if (this.isEngineTab(tab)) {
      this._syncAddressBar(win, tab);
      this._syncNavigationCommands(win, tab);
      this.syncLayout(win);
    }
  },

  // -------------------------------------------------------------------------
  // Window wiring.

  initWindow(win) {
    if (!win || win._whimsyEngineTabsInitialized) {
      return;
    }
    win._whimsyEngineTabsInitialized = true;
    const { gBrowser, document: doc } = win;

    // Watch top-level navigations across tabs: an engine tab's parked Gecko
    // <browser> loads, and Firefox tabs each engine may take over (WebKit:
    // a host in whimsy.webkit.sites).
    const tabsProgressListener = {
      onStateChange: (browser, webProgress, request, flags) => {
        const wpl = Ci.nsIWebProgressListener;
        if (
          !webProgress?.isTopLevel ||
          !(flags & wpl.STATE_STOP) ||
          !(flags & wpl.STATE_IS_WINDOW)
        ) {
          return;
        }
        const tab = gBrowser.getTabForBrowser(browser);
        const state = tab && this.stateOf(tab);
        if (state) {
          if (state.parkAfterInsert) {
            // W32: SessionStore restored a discarded tab's Gecko history.
            state.parkAfterInsert = false;
            this._parkGecko(tab, state);
          }
          if (state.geckoPage) {
            return;
          }
          // tabbrowser clears the icon and busy state when the parked Gecko
          // load stops (see onLocationChange below).
          this._restoreTabChrome(tab, state);
        }
      },
      onLocationChange: (browser, webProgress, request, location, flags) => {
        if (
          !webProgress?.isTopLevel ||
          flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT
        ) {
          return;
        }
        const tab = gBrowser.getTabForBrowser(browser);
        if (!tab) {
          return;
        }
        const state = this.stateOf(tab);
        if (state) {
          if (!this._adapterOf(state)?.availableForTab(tab)) {
            return;
          }
          if (state.parkingGecko) {
            state.parkingGecko = false;
          }
          if (state.geckoPage) {
            // W32: the Gecko certificate error or tab-crashed page.
            this._onGeckoPageLocation(tab, state, location, flags);
            return;
          }
          // The parked Gecko <browser> can finish its about:blank load well
          // after WebKit has loaded the page (a process switch took ~700 ms
          // in tests); tabbrowser then relabels the tab from the URL and
          // clears its icon. WebKit owns those, so put them back. The
          // address bar too: Gecko just showed about:blank's empty URL there.
          this._restoreTabChrome(tab, state);
          if (tab.selected && state.id) {
            this._syncAddressBar(state.win, tab);
            this._syncNavigationCommands(state.win, tab);
          }
          return;
        }
        for (const adapter of this._engines.values()) {
          adapter.onGeckoLocationChange?.(tab, location);
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
        if (!isSelected) {
          this._closeLoginPopup(tab);
        }
        if (isSelected && !state.id && tab.linkedPanel) {
          // W32: a discarded tab comes back.
          this._resumeTab(tab);
        }
        if (!state.id) {
          continue;
        }
        if (isSelected && state.crashed && !state.geckoPage) {
          // W32: a tab whose page crashed in the background reloads.
          this._reviveCrashed(tab);
        }
        try {
          this._svc(state)?.setVisible(state.id, isSelected && !state.geckoPage);
        } catch {}
        if (isSelected && !state.geckoPage) {
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
      if (this.isEngineTab(tab)) {
        this._destroyTabState(tab);
        this.refreshUI(win);
      }
    };
    gBrowser.tabContainer.addEventListener("TabClose", onTabClose);

    // W32: discards (the tab unloader, discardBrowser) free the WKWebView.
    const onTabDiscarded = event => {
      if (this.isEngineTab(event.target)) {
        this._suspendTab(event.target);
        this.refreshUI(win);
      }
    };
    const onTabInserted = event => {
      if (this.isEngineTab(event.target)) {
        this._onBrowserInserted(event.target);
      }
    };
    gBrowser.tabContainer.addEventListener("TabBrowserDiscarded", onTabDiscarded);
    gBrowser.tabContainer.addEventListener("TabBrowserInserted", onTabInserted);
    // W32: runs before SessionStore's own TabBrowserInserted listener. A
    // discarded engine tab's Gecko <browser> restores about:blank, not the
    // engine's page, so Gecko doesn't load the site as well.
    const onInsertCapture = event => {
      const tab = event.target;
      const state = this.stateOf(tab);
      if (!state || state.id || !tab.linkedBrowser?.permanentKey) {
        return;
      }
      try {
        lazy.TabStateCache.update(tab.linkedBrowser.permanentKey, {
          history: {
            entries: [
              {
                url: "about:blank",
                triggeringPrincipal_base64:
                  lazy.E10SUtils.SERIALIZED_SYSTEMPRINCIPAL,
              },
            ],
            index: 1,
          },
        });
      } catch {}
    };
    win.addEventListener("TabBrowserInserted", onInsertCapture, true);
    const onSessionRestoring = event => this._onSessionRestoring(event.target);
    gBrowser.tabContainer.addEventListener("SSTabRestoring", onSessionRestoring);
    this._installCrashRevive();

    // Intercept Back, Forward, Reload, Stop, and ⌘L focus hand-off commands
    // when the selected tab is a WebKit tab.
    const onCommand = event => {
      const id = event.target?.id;
      const tab = gBrowser.selectedTab;
      const state = this.stateOf(tab);
      if (!state) {
        return;
      }
      if (state.geckoPage) {
        // W32: Gecko's error and tab-crashed pages run their own commands,
        // except Back (to the WebKit page) and Reload (restores the tab).
        if (
          id == "Browser:Back" &&
          (state.geckoPage == "certerror" || state.geckoPage == "neterror")
        ) {
          event.stopPropagation();
          event.preventDefault();
          this._exitGeckoPage(tab, state, { repark: true });
          if (state.crashed) {
            this._onCrashed(tab, state);
          }
        } else if (
          (id == "Browser:Reload" || id == "Browser:ReloadSkipCache") &&
          state.geckoPage == "tabcrashed"
        ) {
          event.stopPropagation();
          event.preventDefault();
          this._reviveCrashed(tab);
        }
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
      if (!this._engineShown(tab)) {
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

    if (win.gURLBar && !win.gURLBar._whimsyEngineTabsFocusWrapped) {
      win.gURLBar._whimsyEngineTabsFocusWrapped = true;
      const origFocus = win.gURLBar.focus?.bind(win.gURLBar);
      const origSelect = win.gURLBar.select?.bind(win.gURLBar);
      if (origFocus) {
        win.gURLBar.focus = (...args) => {
          const tab = gBrowser.selectedTab;
          if (this.isEngineTab(tab)) {
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
          if (this.isEngineTab(tab)) {
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
        if (this._engineShown(tab)) {
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
    // W32: tab-modal prompts over a WebKit page.
    doc.addEventListener("dialogopen", onPopupChange, true);
    doc.addEventListener("dialogclose", onPopupChange, true);
    win.addEventListener("resize", onPopupChange);

    win.addEventListener(
      "unload",
      () => {
        gBrowser.removeTabsProgressListener(tabsProgressListener);
        gBrowser.tabContainer.removeEventListener("TabSelect", onTabSelect);
        gBrowser.tabContainer.removeEventListener("TabClose", onTabClose);
        doc.removeEventListener("command", onCommand, true);
        doc.removeEventListener("focusin", onFocusIn, true);
        doc.removeEventListener("popupshown", onPopupChange, true);
        doc.removeEventListener("popuphidden", onPopupChange, true);
        doc.removeEventListener("dialogopen", onPopupChange, true);
        doc.removeEventListener("dialogclose", onPopupChange, true);
        gBrowser.tabContainer.removeEventListener(
          "TabBrowserDiscarded",
          onTabDiscarded
        );
        gBrowser.tabContainer.removeEventListener(
          "TabBrowserInserted",
          onTabInserted
        );
        win.removeEventListener("TabBrowserInserted", onInsertCapture, true);
        gBrowser.tabContainer.removeEventListener(
          "SSTabRestoring",
          onSessionRestoring
        );
        win.removeEventListener("resize", onPopupChange);
        ro.disconnect();
        mo.disconnect();
        for (const tab of gBrowser.tabs) {
          if (this.isEngineTab(tab)) {
            this._destroyTabState(tab);
          }
        }
      },
      { once: true }
    );
  },
};
