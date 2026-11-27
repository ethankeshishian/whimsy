/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W29: WebKit tabs (lane 1: engine-tab model, switching, indicator).
// Gecko stays the engine everywhere by default; WebKit is used only for a tab
// you switch or a site you add to Engines for Sites (whimsy.webkit.sites).
// W32: what any engine's tabs share lives in WhimsyEngineTabs; this module
// keeps WebKit's own parts (its service, data stores, site rules, cookies,
// and UI) and still exports everything it did.

import { WhimsyEngineTabs } from "resource:///modules/whimsy/WhimsyEngineTabs.sys.mjs";

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
  WhimsyWebKitCookies: "resource:///modules/whimsy/WhimsyWebKitCookies.sys.mjs",
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

function isWebURI(uri) {
  return !!uri && (uri.schemeIs("http") || uri.schemeIs("https"));
}

// NSURLErrorDomain certificate failures (NSURLErrorSecureConnectionFailed
// through NSURLErrorClientCertificateRejected).
const CERT_ERROR_CODES = new Set([-1200, -1201, -1202, -1203, -1204, -1205]);

// NSURLErrorDomain connection failures Gecko has an error page for: timed
// out, host not found, can't connect, connection lost, DNS lookup failed,
// and not connected to the internet.
const NET_ERROR_CODES = new Set([-1001, -1003, -1004, -1005, -1006, -1009]);

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
        // W32: WebKit's engine tab service.
        this._service =
          Cc["@mozilla.org/whimsy/engine-tab;1?engine=webkit"]?.getService(
            Ci.nsIWhimsyEngineTab
          ) ?? null;
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
    return this.stateOf(tab)?.engine == "webkit";
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
      return this.stateOf(tab).uri ?? null;
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

  async setTabEngine(tab, engine, { persistSite = null, waitForLoad = true } = {}) {
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
      WhimsyEngineTabs.saveEngineChoice(tab);
      return this.switchTab(tab, "webkit", { waitForLoad });
    }
    tab._whimsyWebKitOverride = "firefox";
    tab._whimsyWebKitOverrideHost = host;
    WhimsyEngineTabs.saveEngineChoice(tab);
    return this.switchTab(tab, "firefox", { waitForLoad });
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
      WhimsyEngineTabs.saveEngineChoice(tab);
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
    WhimsyEngineTabs.saveEngineChoice(tab);
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
        const state = this.stateOf(tab);
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
    const svc = this.service;
    if (!svc || !tab.linkedBrowser) {
      return false;
    }

    // W32: the engine-neutral half (state, events, layering) is
    // WhimsyEngineTabs'.
    const state = WhimsyEngineTabs._openTab(
      tab,
      "webkit",
      targetURI,
      this.dataStoreIdForTab(tab)
    );
    if (!state) {
      return false;
    }
    const isSelected = win.gBrowser.selectedTab == tab;

    // W30: bring the site's Firefox cookies along before WebKit loads it, so
    // you stay signed in. The tab is already a WebKit tab, so a second
    // switch can't race this one.
    await lazy.WhimsyWebKitCookies.copyToWebKit(tab, targetURI);
    if (this.stateOf(tab) != state) {
      // Closed or switched back while the cookies were copying.
      return false;
    }

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
    const state = this.stateOf(tab);
    if (!state || state.detaching) {
      return true;
    }
    const { win, browser } = state;
    const reloadSpec = url || state.url || "about:blank";

    // W30: bring the site's WebKit cookies back before Gecko loads it.
    // Read while the WKWebView still exists, so nothing it just set is
    // missed.
    state.detaching = true;
    const reloadURI = safeNewURI(reloadSpec);
    if (isWebURI(reloadURI)) {
      await lazy.WhimsyWebKitCookies.copyToFirefox(tab, reloadURI);
      if (this.stateOf(tab) != state) {
        // Closed while the cookies were copying.
        return true;
      }
    }

    this._destroyTabState(tab);
    // W32: SessionStore follows the Gecko <browser> again.
    WhimsyEngineTabs._resyncGeckoSession(tab);

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

  // W32: refreshUI (WhimsyEngineTabs') runs this for every window, then
  // syncs the selected engine tab.
  refreshWindowUI(win) {
    this.updatePill(win);
    this.updateSitePanelProtections(win);
    lazy.WhimsySiteSettings.renderIfOpen?.(win);
    const extPanel = win.document?.getElementById(EXT_PANEL_ID);
    if (extPanel && extPanel.state == "open") {
      this.renderExtensionsPanel(win);
    }
  },

  refreshUI(win) {
    WhimsyEngineTabs.refreshUI(win);
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

    // W32: engine tabs' own wiring (navigation, selection, close, discards,
    // commands, focus, and layout).
    WhimsyEngineTabs.initWindow(win);

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
        puzzleBtn?.removeEventListener("command", onPuzzleCommand, true);
        puzzleBtn?.removeEventListener("click", onPuzzleCommand, true);
      },
      { once: true }
    );
  },

  // -------------------------------------------------------------------------
  // W32: WebKit's engine adapter for WhimsyEngineTabs.

  tabAttribute: "whimsy-webkit",

  isCertError(info) {
    return (
      info.domain == "NSURLErrorDomain" &&
      CERT_ERROR_CODES.has(Number(info.code))
    );
  },

  // Which Gecko error page a failed WebKit load shows: "certerror",
  // "neterror" (no connection), or null (cancelled loads, policy changes,
  // and errors with no Gecko page stay in WebKit).
  netErrorKind(info) {
    if (this.isCertError(info)) {
      return "certerror";
    }
    if (
      info.domain == "NSURLErrorDomain" &&
      NET_ERROR_CODES.has(Number(info.code))
    ) {
      return "neterror";
    }
    return null;
  },

  // W32: SessionStore keeps a tab's engine choice for its site: the
  // per-tab override ("webkit" or "firefox") and, for a WebKit tab, WebKit.
  sessionChoice(tab) {
    const override = tab._whimsyWebKitOverride;
    if (override == "webkit" || override == "firefox") {
      return { override, host: tab._whimsyWebKitOverrideHost || "" };
    }
    if (this.isWebKitTab(tab)) {
      return { override: "webkit", host: this.currentHostOf(tab) };
    }
    return null;
  },

  // A restored tab gets its override back. Its page then loads in Gecko
  // and onGeckoLocationChange opens it in WebKit, as when the tab was
  // switched; a different site than the one chosen for clears it there.
  restoreSessionChoice(tab, choice, url) {
    if (!choice || (choice.override != "webkit" && choice.override != "firefox")) {
      return;
    }
    let host = String(choice.host || "").toLowerCase();
    if (!host) {
      const uri = safeNewURI(url);
      host = isWebURI(uri) ? (uri.asciiHost || "").toLowerCase() : "";
    }
    if (!host) {
      return;
    }
    tab._whimsyWebKitOverride = choice.override;
    tab._whimsyWebKitOverrideHost = host;
  },

  // A Firefox tab navigated: opening a URL whose host is in
  // whimsy.webkit.sites automatically switches that tab to WebKit.
  onGeckoLocationChange(tab, location) {
    if (!this.availableForTab(tab) || !isWebURI(location)) {
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
      WhimsyEngineTabs.saveEngineChoice(tab);
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

WhimsyEngineTabs.registerEngine("webkit", WhimsyWebKit);

// W32: WhimsyWebKit stays the module everyone imports. What moved to
// WhimsyEngineTabs (tab state, page calls, layering, and the requests) is
// reached through it, bound to WhimsyEngineTabs; assigning one (a test's
// stand-in) replaces WhimsyEngineTabs' own.
{
  const bound = new WeakMap();
  for (const key of Object.keys(WhimsyEngineTabs)) {
    if (Object.hasOwn(WhimsyWebKit, key)) {
      continue;
    }
    Object.defineProperty(WhimsyWebKit, key, {
      configurable: true,
      enumerable: false,
      get() {
        const value = WhimsyEngineTabs[key];
        if (typeof value != "function") {
          return value;
        }
        let fn = bound.get(value);
        if (!fn) {
          fn = value.bind(WhimsyEngineTabs);
          bound.set(value, fn);
        }
        return fn;
      },
      set(value) {
        WhimsyEngineTabs[key] = value;
      },
    });
  }
}
