/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W9-04: Site settings ("This Site"), after Lens's "Settings for each
// site": the browser remembers a site's zoom, Reader View, desktop/mobile
// version, full screen and content blocking, and one place shows what it
// remembers and forgets it, row by row or all at once.
//
// It lives in Zen's site panel (the button left of the address, which
// replaces Firefox's padlock popup as the site's panel; Firefox's identity
// popup is now only the connection details behind the panel's security
// button). Zen's panel already has, and keeps:
//   - "Settings": every permission the site has a stored decision for, plus
//     "Tracking protection" (Firefox's ContentBlockingAllowList toggle, the
//     same switch as the shield popup). Content blocking stays there.
//   - the footer's Reader View button (enter/leave now), security info, and
//     the "..." menu (Clear cookies and site data, Zap, Page Info's
//     permissions as "Site settings").
// This module adds one section after "Settings", rebuilt each time the
// panel opens, with these rows (fixed order; the optional one last):
//   Zoom             Firefox's site-specific zoom (FullZoom, content prefs);
//                    the % and a reset button when it isn't the default.
//   Autoplay         Firefox's autoplay-media permission (SitePermissions):
//                    click cycles Allow / Block audio / Block audio and
//                    video; a button forgets it. Zen's own Autoplay row is
//                    hidden while this section shows, so it isn't listed
//                    twice.
//   Reader View      "Always open in Reader": an article on this site opens
//                    in Reader View by itself (once per page, so leaving
//                    Reader sticks).
//   Full Screen      "Open in full screen": the window goes full screen
//                    when a tab shows this site (once per tab and site).
//   Pretend to Be    Whimsy's per-site user agent (WhimsyUserAgent; iPhone
//                    = the mobile site); click opens its sheet, a button
//                    forgets it. Only while that feature is on.
// "Forget All" in the header forgets every row plus the tracking protection
// exception, with Undo.
//
// Storage follows the underlying stores, so private tabs and Scratch never
// persist and profiles (containers) stay apart where the store allows:
// Reader and Full Screen are permissions on the site's principal with the
// tab's userContextId and privateBrowsingId (the permission manager keeps
// private ones in memory and drops them when the last private tab closes);
// autoplay is the same; the user agent is per profile with private choices
// in memory (WhimsyUserAgent); zoom is Firefox's content prefs, per site
// but not per container, in memory for private tabs; the tracking
// protection exception is Firefox's own (private ones in memory).
//
// The "Site Settings…" command opens the panel on this section.
// whimsy.feature.site-settings.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AboutReaderParent: "resource:///actors/AboutReaderParent.sys.mjs",
  ContentBlockingAllowList: "resource://gre/modules/ContentBlockingAllowList.sys.mjs",
  PanelMultiView: "moz-src:///browser/components/customizableui/PanelMultiView.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  ReaderMode: "moz-src:///toolkit/components/reader/ReaderMode.sys.mjs",
  SitePermissions: "resource:///modules/SitePermissions.sys.mjs",
  WhimsyPanels: "resource:///modules/whimsy/WhimsyPanels.sys.mjs",
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
  WhimsyUndo: "resource:///modules/whimsy/WhimsyUndo.sys.mjs",
  WhimsyUserAgent: "resource:///modules/whimsy/WhimsyUserAgent.sys.mjs",
  ZoomUI: "resource:///modules/ZoomUI.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.site-settings";
export const COMMAND_ID = "cmd_whimsySiteSettings";
const SECTION_ID = "whimsy-site-settings-section";
const PANEL_ID = "zen-unified-site-data-panel";
const AUTOPLAY = "autoplay-media";

// Permission types for the two settings Firefox has no store for.
export const PERM_TYPES = {
  reader: "whimsy-site-reader",
  fullscreen: "whimsy-site-fullscreen",
};

// browser -> the page URL Reader View last opened by itself, so leaving
// Reader (or going back to the page) doesn't bounce into it again.
const autoReaderDone = new WeakMap();
// browser -> the host full screen last applied for (once per tab and site).
const autoFullscreenDone = new WeakMap();

let readerListener = null;

function isWebURI(uri) {
  return !!uri && (uri.schemeIs("http") || uri.schemeIs("https"));
}

export const WhimsySiteSettings = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  // ---------------------------------------------------------------------
  // The site a browser shows: its page, or the article behind Reader View.

  /**
   * @returns {{uri: nsIURI, host: string, oa: {userContextId: number, privateBrowsingId: number}}|null}
   */
  siteOf(browser) {
    let uri = browser?.currentURI;
    if (!uri) {
      return null;
    }
    if (uri.spec.startsWith("about:reader")) {
      try {
        const original = lazy.ReaderMode.getOriginalUrl(uri.spec);
        uri = original ? Services.io.newURI(original) : null;
      } catch (e) {
        uri = null;
      }
    }
    if (!isWebURI(uri) || !uri.asciiHost) {
      return null;
    }
    return { uri, host: uri.asciiHost, oa: this.oaOf(browser) };
  },

  oaOf(browser) {
    const attrs = browser?.browsingContext?.originAttributes ?? browser?.contentPrincipal?.originAttributes ?? {};
    let privateBrowsingId = attrs.privateBrowsingId || 0;
    if (!privateBrowsingId && browser && lazy.PrivateBrowsingUtils.isBrowserPrivate(browser)) {
      privateBrowsingId = 1;
    }
    return { userContextId: attrs.userContextId || 0, privateBrowsingId };
  },

  // Whimsy's own settings are keyed by host (http and https alike), in the
  // tab's profile and private state.
  sitePrincipal(host, oa) {
    return Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(`https://${host}/`), {
      userContextId: oa.userContextId || 0,
      privateBrowsingId: oa.privateBrowsingId || 0,
    });
  },

  // Autoplay is Firefox's: its permission is keyed by the exact origin.
  originPrincipal(site) {
    return Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(site.uri.prePath), {
      userContextId: site.oa.userContextId || 0,
      privateBrowsingId: site.oa.privateBrowsingId || 0,
    });
  },

  // ---------------------------------------------------------------------
  // Reader View and Full Screen (Whimsy's own, as permissions).

  getFlag(kind, host, oa) {
    try {
      const principal = this.sitePrincipal(host, oa);
      return Services.perms.testExactPermissionFromPrincipal(principal, PERM_TYPES[kind]) == Services.perms.ALLOW_ACTION;
    } catch (e) {
      return false;
    }
  },

  setFlag(kind, host, oa, on) {
    const principal = this.sitePrincipal(host, oa);
    if (on) {
      // A private principal's permission is kept for the session only (the
      // permission manager forces it), so private tabs never persist.
      Services.perms.addFromPrincipal(principal, PERM_TYPES[kind], Services.perms.ALLOW_ACTION);
    } else {
      Services.perms.removeFromPrincipal(principal, PERM_TYPES[kind]);
    }
  },

  // ---------------------------------------------------------------------
  // Window wiring.

  initWindow(win) {
    this.initReaderListener();
    const { gBrowser } = win;
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
      onLocationChange: (webProgress, request, location, flags) => {
        if (!webProgress?.isTopLevel || flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT) {
          return;
        }
        this.maybeFullscreen(win, gBrowser.selectedBrowser);
      },
    };
    gBrowser.addProgressListener(listener);
    // Every tab: a page that isn't the one Reader last opened by itself
    // may open in Reader again.
    const tabsListener = {
      onLocationChange: (browser, webProgress, request, location, flags) => {
        if (webProgress?.isTopLevel && !(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT)) {
          this.forgetDoneOnNavigation(browser);
        }
      },
    };
    gBrowser.addTabsProgressListener(tabsListener);
    win._whimsySiteSettingsListener = listener;
    const onSelect = () => this.maybeFullscreen(win, gBrowser.selectedBrowser);
    gBrowser.tabContainer.addEventListener("TabSelect", onSelect);

    const panel = win.document.getElementById(PANEL_ID);
    const onShowing = event => {
      if (event.target == panel) {
        this.render(win);
      }
    };
    panel?.addEventListener("popupshowing", onShowing);
    win.addEventListener(
      "unload",
      () => {
        gBrowser.removeProgressListener(listener);
        gBrowser.removeTabsProgressListener(tabsListener);
        gBrowser.tabContainer.removeEventListener("TabSelect", onSelect);
        panel?.removeEventListener("popupshowing", onShowing);
      },
      { once: true }
    );
  },

  // Once per session: Reader View's "this page is an article" message, for
  // every tab (background ones too).
  initReaderListener() {
    if (readerListener) {
      return;
    }
    readerListener = {
      receiveMessage: message => {
        try {
          if (message.data?.isArticle) {
            this.maybeEnterReader(message.target);
          }
        } catch (e) {
          console.error("Whimsy: site settings (reader)", e);
        }
      },
    };
    lazy.AboutReaderParent.addMessageListener("Reader:UpdateReaderButton", readerListener);
  },

  forgetDoneOnNavigation(browser) {
    const uri = browser?.currentURI;
    if (!uri || uri.spec.startsWith("about:reader")) {
      return;
    }
    if (autoReaderDone.has(browser) && autoReaderDone.get(browser) != uri.spec) {
      autoReaderDone.delete(browser);
    }
  },

  maybeEnterReader(browser) {
    if (!this.enabled || !browser?.isConnected) {
      return false;
    }
    const uri = browser.currentURI;
    if (!isWebURI(uri) || !uri.asciiHost) {
      return false;
    }
    if (autoReaderDone.get(browser) == uri.spec) {
      return false;
    }
    if (!this.getFlag("reader", uri.asciiHost, this.oaOf(browser))) {
      return false;
    }
    autoReaderDone.set(browser, uri.spec);
    return this.enterReader(browser);
  },

  enterReader(browser) {
    try {
      const actor = browser.browsingContext?.currentWindowGlobal?.getActor("AboutReader");
      if (!actor || actor.isReaderMode()) {
        return false;
      }
      actor.sendAsyncMessage("Reader:ToggleReaderMode", {});
      return true;
    } catch (e) {
      return false;
    }
  },

  maybeFullscreen(win, browser) {
    if (!this.enabled || !browser) {
      return false;
    }
    const site = this.siteOf(browser);
    if (!site || !this.getFlag("fullscreen", site.host, site.oa)) {
      autoFullscreenDone.delete(browser);
      return false;
    }
    if (autoFullscreenDone.get(browser) == site.host) {
      return false;
    }
    autoFullscreenDone.set(browser, site.host);
    if (win.fullScreen) {
      return false;
    }
    this.enterFullscreen(win);
    return true;
  },

  // The window's own full screen (View > Enter Full Screen), not a page
  // element's. Tests replace this to observe it.
  enterFullscreen(win) {
    win.fullScreen = true;
  },

  // ---------------------------------------------------------------------
  // The section in Zen's site panel.

  sectionOf(win) {
    const doc = win.document;
    let section = doc.getElementById(SECTION_ID);
    if (section) {
      return section;
    }
    const settingsList = doc.getElementById("zen-site-data-settings-list");
    const zenSection = settingsList?.closest(".zen-site-data-section");
    if (!zenSection) {
      return null;
    }
    section = doc.createXULElement("vbox");
    section.id = SECTION_ID;
    section.className = "zen-site-data-section whimsy-site-settings-section";
    const header = doc.createXULElement("hbox");
    header.className = "zen-site-data-section-header";
    const title = doc.createXULElement("label");
    title.setAttribute("flex", "1");
    title.setAttribute("data-l10n-id", "whimsy-site-settings-title");
    // The second label is styled by Zen like the other sections' "More".
    const forgetAll = doc.createXULElement("label");
    forgetAll.id = "whimsy-site-settings-forget-all";
    forgetAll.setAttribute("data-l10n-id", "whimsy-site-settings-forget-all");
    forgetAll.setAttribute("role", "button");
    forgetAll.setAttribute("tabindex", "0");
    const activate = event => {
      event.stopPropagation();
      this.forgetAll(win);
    };
    forgetAll.addEventListener("click", activate);
    forgetAll.addEventListener("keydown", event => {
      if (event.key == "Enter" || event.key == " ") {
        event.preventDefault();
        activate(event);
      }
    });
    header.append(title, forgetAll);
    const list = doc.createXULElement("vbox");
    list.id = "whimsy-site-settings-list";
    section.append(header, list);
    zenSection.after(section);
    return section;
  },

  // Rebuilds the section for the selected tab. Runs on the panel's
  // popupshowing, after Zen fills its own lists.
  render(win) {
    const doc = win.document;
    const browser = win.gBrowser.selectedBrowser;
    const site = this.enabled ? this.siteOf(browser) : null;
    const section = this.sectionOf(win);
    this.hideZenAutoplay(win, !!(site && section));
    if (!section) {
      return;
    }
    const list = section.querySelector("#whimsy-site-settings-list");
    list.replaceChildren();
    section.hidden = !site;
    if (!site) {
      return;
    }
    section._site = site;
    let remembered = 0;

    // Zoom.
    const zoom = win.ZoomManager?.getZoomForBrowser?.(browser) ?? 1;
    const zoomRow = this.row(doc, {
      kind: "zoom",
      l10nId: "whimsy-site-settings-zoom",
      stateL10nId: "whimsy-site-settings-zoom-value",
      stateArgs: { percent: Math.round(zoom * 100) },
      forget: {
        l10nId: "whimsy-site-settings-zoom-reset",
        onCommand: () => this.resetZoom(win, browser).then(() => this.render(win)),
      },
    });
    zoomRow.setAttribute("state", "block");
    zoomRow.querySelector(".whimsy-site-settings-forget").hidden = true;
    list.append(zoomRow);
    lazy.ZoomUI.getGlobalValue()
      .then(globalZoom => {
        const changed = Math.abs(zoom - globalZoom) > 0.001;
        if (zoomRow.isConnected) {
          zoomRow.setAttribute("state", changed ? "allow" : "block");
          zoomRow.querySelector(".whimsy-site-settings-forget").hidden = !changed;
          if (changed) {
            this.updateForgetAll(section, true);
          }
        }
      })
      .catch(() => {});

    // Autoplay (Firefox's permission).
    const principal = this.originPrincipal(site);
    const stored = this.storedAutoplay(principal);
    const autoplayStored = stored != null;
    const autoplayState = autoplayStored ? stored : lazy.SitePermissions.getDefault(AUTOPLAY);
    remembered += autoplayStored ? 1 : 0;
    const autoplayRow = this.row(doc, {
      kind: "autoplay",
      label: lazy.SitePermissions.getPermissionLabel(AUTOPLAY),
      stateText: lazy.SitePermissions.getMultichoiceStateLabel(AUTOPLAY, autoplayState),
      on: autoplayStored,
      onCommand: () => {
        this.cycleAutoplay(site, browser, autoplayState);
        this.render(win);
      },
      forget: autoplayStored
        ? {
            l10nId: "whimsy-site-settings-forget",
            onCommand: () => {
              lazy.SitePermissions.removeFromPrincipal(principal, AUTOPLAY, browser);
              this.render(win);
            },
          }
        : null,
    });
    autoplayRow.classList.add(`permission-popup-permission-item-${AUTOPLAY}`);
    list.append(autoplayRow);

    // Reader View and Full Screen.
    for (const kind of ["reader", "fullscreen"]) {
      const on = this.getFlag(kind, site.host, site.oa);
      remembered += on ? 1 : 0;
      list.append(
        this.row(doc, {
          kind,
          l10nId: `whimsy-site-settings-${kind}`,
          stateL10nId: on ? "whimsy-site-settings-on" : "whimsy-site-settings-off",
          on,
          onCommand: () => {
            this.setFlag(kind, site.host, site.oa, !on);
            if (!on) {
              this.applyNow(win, kind);
            }
            this.render(win);
          },
        })
      );
    }

    // Pretend to Be (Whimsy's per-site user agent), last: it's optional.
    if (lazy.WhimsyUserAgent.enabled) {
      const options = this.uaOptions(site);
      const entry = lazy.WhimsyUserAgent.entry(site.host, options);
      const preset = entry?.preset ?? null;
      remembered += preset ? 1 : 0;
      list.append(
        this.row(doc, {
          kind: "useragent",
          l10nId: "whimsy-site-settings-useragent",
          stateL10nId: `whimsy-site-settings-useragent-${preset ?? "default"}`,
          on: !!preset,
          onCommand: () => {
            this.hidePanel(win).then(() => lazy.WhimsyUserAgent.openPicker(win, site.host));
          },
          forget: preset
            ? {
                l10nId: "whimsy-site-settings-forget",
                onCommand: () => {
                  lazy.WhimsyUserAgent.clear(site.host, options);
                  lazy.WhimsyUserAgent.reload(win, win.gBrowser.selectedTab);
                  this.render(win);
                },
              }
            : null,
        })
      );
    }

    this.updateForgetAll(section, remembered > 0);
  },

  updateForgetAll(section, show) {
    const forgetAll = section.querySelector("#whimsy-site-settings-forget-all");
    forgetAll.hidden = !show;
  },

  // Zen lists autoplay under "Settings" when the site has a stored
  // decision; this section always shows it, so Zen's row steps aside.
  hideZenAutoplay(win, hide) {
    const list = win.document.getElementById("zen-site-data-settings-list");
    if (!list) {
      return;
    }
    for (const item of list.querySelectorAll(`.permission-popup-permission-item-${AUTOPLAY}`)) {
      item.hidden = hide;
    }
    const zenSection = list.closest(".zen-site-data-section");
    if (hide && zenSection && ![...list.children].some(child => !child.hidden)) {
      zenSection.hidden = true;
    }
  },

  uaOptions(site) {
    return {
      isPrivate: site.oa.privateBrowsingId > 0,
      profileKey: lazy.WhimsyProfiles.keyFor(site.oa.userContextId || 0),
    };
  },

  /**
   * One row, built like Zen's permission rows (so Zen's styles apply): a
   * round icon, the name, the state under it; `state="allow"` lights the
   * icon when the site has a remembered value. `forget` adds a trailing
   * button; `onCommand` makes the row itself act (click, Enter, Space).
   */
  row(doc, o) {
    const row = doc.createXULElement("hbox");
    row.className = `permission-popup-permission-item whimsy-site-settings-item whimsy-site-settings-${o.kind}`;
    row.setAttribute("align", "center");
    row.setAttribute("whimsy-site-setting", o.kind);
    row.setAttribute("state", o.on ? "allow" : "block");

    const icon = doc.createXULElement("toolbarbutton");
    icon.className = "permission-popup-permission-icon zen-site-data-permission-icon";
    icon.setAttribute("closemenu", "none");
    icon.setAttribute("tabindex", "-1");
    icon.setAttribute("aria-hidden", "true");

    const text = doc.createXULElement("vbox");
    text.setAttribute("flex", "1");
    text.setAttribute("align", "start");
    text.className = "permission-popup-permission-label-container";
    const name = doc.createXULElement("label");
    name.className = "permission-popup-permission-label";
    if (o.l10nId) {
      doc.l10n.setAttributes(name, o.l10nId);
    } else {
      name.textContent = o.label ?? "";
    }
    const state = doc.createXULElement("label");
    state.className = "zen-permission-popup-permission-state-label whimsy-site-settings-state";
    if (o.stateL10nId) {
      doc.l10n.setAttributes(state, o.stateL10nId, o.stateArgs);
    } else {
      state.textContent = o.stateText ?? "";
    }
    text.append(name, state);
    row.append(icon, text);

    if (o.onCommand) {
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");
      row.setAttribute("actionable", "true");
      row.addEventListener("click", event => {
        if (event.button == 0 && !event.target.closest(".whimsy-site-settings-forget")) {
          o.onCommand(event);
        }
      });
      row.addEventListener("keydown", event => {
        if ((event.key == "Enter" || event.key == " ") && event.target == row) {
          event.preventDefault();
          o.onCommand(event);
        }
      });
    }
    if (o.forget) {
      const forget = doc.createXULElement("toolbarbutton");
      forget.className = "whimsy-site-settings-forget";
      forget.setAttribute("tabindex", "0");
      forget.setAttribute("closemenu", "none");
      forget.setAttribute("image", "chrome://browser/skin/zen-icons/close.svg");
      doc.l10n.setAttributes(forget, o.forget.l10nId);
      forget.addEventListener("command", event => {
        event.stopPropagation();
        o.forget.onCommand(event);
      });
      row.append(forget);
    }
    return row;
  },

  // ---------------------------------------------------------------------
  // Actions.

  resetZoom(win, browser) {
    return Promise.resolve(win.FullZoom?.reset?.(browser)).catch(() => {});
  },

  // The site's own autoplay decision (not the default), or null.
  storedAutoplay(principal) {
    const permission = Services.perms.getPermissionObject(principal, AUTOPLAY, true);
    return permission ? permission.capability : null;
  },

  cycleAutoplay(site, browser, current) {
    const { SitePermissions } = lazy;
    const order = [SitePermissions.ALLOW, SitePermissions.BLOCK, SitePermissions.AUTOPLAY_BLOCKED_ALL];
    const index = order.indexOf(current);
    const next = order[(index + 1) % order.length];
    SitePermissions.setForPrincipal(this.originPrincipal(site), AUTOPLAY, next, SitePermissions.SCOPE_PERSISTENT, browser);
    return next;
  },

  // Turning Reader or Full Screen on applies it to the page in front now.
  applyNow(win, kind) {
    const browser = win.gBrowser.selectedBrowser;
    if (kind == "reader") {
      if (browser.isArticle && isWebURI(browser.currentURI)) {
        autoReaderDone.set(browser, browser.currentURI.spec);
        this.hidePanel(win).then(() => this.enterReader(browser));
      }
    } else if (kind == "fullscreen") {
      this.hidePanel(win).then(() => this.maybeFullscreen(win, browser));
    }
  },

  // What "Forget All" removes, so Undo can put it back.
  snapshot(win, browser, site) {
    const principal = this.originPrincipal(site);
    let trackingException = false;
    try {
      trackingException = lazy.ContentBlockingAllowList.canHandle(browser) && lazy.ContentBlockingAllowList.includes(browser);
    } catch (e) {}
    return {
      zoom: win.ZoomManager?.getZoomForBrowser?.(browser) ?? 1,
      autoplay: this.storedAutoplay(principal),
      reader: this.getFlag("reader", site.host, site.oa),
      fullscreen: this.getFlag("fullscreen", site.host, site.oa),
      ua: lazy.WhimsyUserAgent.entry(site.host, this.uaOptions(site)),
      trackingException,
    };
  },

  async forgetAll(win) {
    const browser = win.gBrowser.selectedBrowser;
    const tab = win.gBrowser.selectedTab;
    const site = this.siteOf(browser);
    if (!site) {
      return false;
    }
    const before = this.snapshot(win, browser, site);
    const reload = this.clear(win, browser, site, before);
    await this.resetZoom(win, browser);
    await this.hidePanel(win);
    if (reload && tab.linkedBrowser == browser) {
      browser.reload();
    }
    lazy.WhimsyUndo.showToast(
      win,
      "whimsy-site-settings-forgot-toast",
      {
        type: "site-settings-forget",
        undo: () => this.restore(win, browser, site, before),
        redo: null,
      },
      { site: site.host }
    );
    return true;
  },

  // Clears everything but zoom (async, done by the caller). Returns
  // whether the page needs a reload to drop what it loaded with.
  clear(win, browser, site, before) {
    let reload = false;
    if (before.autoplay != null) {
      lazy.SitePermissions.removeFromPrincipal(this.originPrincipal(site), AUTOPLAY, browser);
    }
    this.setFlag("reader", site.host, site.oa, false);
    this.setFlag("fullscreen", site.host, site.oa, false);
    if (before.ua) {
      lazy.WhimsyUserAgent.clear(site.host, this.uaOptions(site));
      reload = true;
    }
    if (before.trackingException) {
      lazy.ContentBlockingAllowList.remove(browser);
      reload = true;
    }
    return reload;
  },

  restore(win, browser, site, before) {
    let reload = false;
    if (before.autoplay != null) {
      lazy.SitePermissions.setForPrincipal(
        this.originPrincipal(site),
        AUTOPLAY,
        before.autoplay,
        lazy.SitePermissions.SCOPE_PERSISTENT,
        browser
      );
    }
    this.setFlag("reader", site.host, site.oa, before.reader);
    this.setFlag("fullscreen", site.host, site.oa, before.fullscreen);
    if (before.ua) {
      lazy.WhimsyUserAgent.set(site.host, before.ua.preset, before.ua.custom, this.uaOptions(site));
      reload = true;
    }
    // The page-bound parts only if the tab still shows the site.
    const same = browser.isConnected && this.siteOf(browser)?.host == site.host;
    if (before.trackingException && same) {
      lazy.ContentBlockingAllowList.add(browser);
      reload = true;
    }
    if (same) {
      if (Math.abs(before.zoom - (win.ZoomManager?.getZoomForBrowser?.(browser) ?? 1)) > 0.001) {
        win.FullZoom?.setZoom?.(before.zoom, browser);
      }
      if (reload) {
        browser.reload();
      }
    }
    return true;
  },

  hidePanel(win) {
    const panel = win.document.getElementById(PANEL_ID);
    if (!panel || panel.state == "closed") {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      panel.addEventListener("popuphidden", () => resolve(), { once: true });
      lazy.PanelMultiView.hidePopup(panel);
    });
  },

  // ---------------------------------------------------------------------
  // "Site Settings…": opens Zen's site panel and puts focus on this section.

  async open(win) {
    if (!this.enabled) {
      return false;
    }
    const doc = win.document;
    const panel = doc.getElementById(PANEL_ID);
    const zen = win.gZenSiteDataPanel;
    if (!panel || !zen) {
      return false;
    }
    if (panel.state != "open") {
      const shown = new Promise(resolve => panel.addEventListener("popupshown", resolve, { once: true }));
      const anchor = lazy.WhimsyPanels.visibleAnchor(win, [zen.anchor]);
      if (anchor) {
        win.gUnifiedExtensions.togglePanel(null, null, zen.unifiedPanel, zen.unifiedPanelView, zen.anchor);
      } else {
        // The address bar is hidden (compact mode, no toolbar): hang the
        // panel off the address bar's spot or the page instead.
        const fallback =
          lazy.WhimsyPanels.visibleAnchor(win, ["urlbar", "tabbrowser-tabbox", "browser"]) ?? doc.documentElement;
        lazy.PanelMultiView.openPopup(panel, fallback, { position: "bottomleft topleft" }).catch(() => {});
      }
      const timedOut = new Promise(resolve => win.setTimeout(() => resolve("timeout"), 3000));
      if ((await Promise.race([shown, timedOut])) == "timeout") {
        return false;
      }
    }
    const section = doc.getElementById(SECTION_ID);
    if (section && !section.hidden) {
      section.scrollIntoView({ block: "nearest" });
      section.querySelector(".whimsy-site-settings-item[tabindex='0']")?.focus();
    }
    return true;
  },
};
