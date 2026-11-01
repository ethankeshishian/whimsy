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
// panel opens. W10-16 (the user: the panel is good, "Pretend" is horrible,
// turning full screen off didn't end it, the zoom button did nothing): the
// rows are WhimsySurface parts on one track, each with a real control and
// no per-row ✕; turning a control back to its default forgets it.
//   Zoom             Firefox's site-specific zoom (FullZoom, content prefs):
//                    a − / % / + stepper; the % resets to 100%.
//   Autoplay         Firefox's autoplay-media permission (SitePermissions):
//                    a dropdown with Allow / Block audio / Block audio and
//                    video / Use Default (forgets it). Zen's own Autoplay row
//                    is hidden while this section shows, so it isn't listed
//                    twice.
//   Reader View      "Always open in Reader" switch: an article on this site
//                    opens in Reader View by itself (once per page, so
//                    leaving Reader sticks).
//   Full Screen      "Open in full screen" switch: the window goes full
//                    screen when a tab shows this site (once per tab and
//                    site); off also leaves the full screen it entered.
//   Pretend to Be    Whimsy's per-site user agent (WhimsyUserAgent), the
//                    user's pick B: one row with a dropdown (Chrome / Whimsy
//                    / Safari / iPhone / Custom…), picked in the panel, which
//                    stays open while the page reloads. Only while that
//                    feature is on.
// "Forget All" in the caption forgets every row plus the tracking
// protection exception, with Undo.
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
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
  WhimsyUndo: "resource:///modules/whimsy/WhimsyUndo.sys.mjs",
  WhimsyUserAgent: "resource:///modules/whimsy/WhimsyUserAgent.sys.mjs",
  ZoomUI: "resource:///modules/ZoomUI.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.site-settings";
export const COMMAND_ID = "cmd_whimsySiteSettings";
const SECTION_ID = "whimsy-site-settings-section";
const PANEL_ID = "zen-unified-site-data-panel";
const PRETEND_PANEL_ID = "whimsy-pretend-panel";
const AUTOPLAY = "autoplay-media";
const HTML_NS = "http://www.w3.org/1999/xhtml";
// Pretend to Be's choices, in the dropdown's order; "default" is Whimsy.
const UA_CHOICES = ["chrome-mac", "default", "safari-mac", "safari-iphone", "custom"];

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

  // The permission type for a setting in a profile. Firefox's permission
  // manager ignores containers (permissions.isolateBy.userContext is off),
  // so a profile's own settings carry its container in the type; Default's
  // keep the plain type. Private browsing stays apart by its principal.
  permType(kind, oa) {
    const userContextId = oa?.userContextId || 0;
    return userContextId ? `${PERM_TYPES[kind]}.uc${userContextId}` : PERM_TYPES[kind];
  },

  getFlag(kind, host, oa) {
    try {
      const principal = this.sitePrincipal(host, oa);
      return Services.perms.testExactPermissionFromPrincipal(principal, this.permType(kind, oa)) == Services.perms.ALLOW_ACTION;
    } catch (e) {
      return false;
    }
  },

  setFlag(kind, host, oa, on) {
    const principal = this.sitePrincipal(host, oa);
    if (on) {
      // A private principal's permission is kept for the session only (the
      // permission manager forces it), so private tabs never persist.
      Services.perms.addFromPrincipal(principal, this.permType(kind, oa), Services.perms.ALLOW_ACTION);
    } else {
      Services.perms.removeFromPrincipal(principal, this.permType(kind, oa));
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

  exitFullscreen(win) {
    win.fullScreen = false;
  },

  // W10-16: turning Open in Full Screen off ends the full screen Whimsy
  // entered for this site, never one the person entered themselves.
  leaveFullscreen(win, browser, host) {
    const entered = autoFullscreenDone.get(browser) == host;
    autoFullscreenDone.delete(browser);
    if (entered && win.fullScreen) {
      this.exitFullscreen(win);
      return true;
    }
    return false;
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
    section.className = "zen-site-data-section whimsy-site-settings-section whimsy-surface-tokens";
    const { caption } = lazy.WhimsySurface.caption(doc, {
      l10nId: "whimsy-site-settings-title",
      id: "whimsy-site-settings-heading",
    });
    caption.classList.add("whimsy-site-settings-caption");
    const forgetAll = lazy.WhimsySurface.textButton(doc, {
      l10nId: "whimsy-site-settings-forget-all",
      id: "whimsy-site-settings-forget-all",
      onCommand: () => this.forgetAll(win),
    });
    caption.append(forgetAll);
    const list = lazy.WhimsySurface.group(doc);
    list.id = "whimsy-site-settings-list";
    list.setAttribute("role", "group");
    list.setAttribute("aria-labelledby", "whimsy-site-settings-heading");
    // Custom user agent: a field under the list, only while it's chosen.
    const custom = doc.createXULElement("hbox");
    custom.className = "whimsy-site-settings-custom";
    custom.setAttribute("align", "center");
    custom.hidden = true;
    const note = doc.createElementNS(HTML_NS, "p");
    note.className = "whimsy-site-settings-private-note";
    doc.l10n.setAttributes(note, "whimsy-site-settings-private-note");
    note.hidden = true;
    section.append(caption, list, custom, note);
    zenSection.after(section);
    return section;
  },

  // Rebuilds the section for the selected tab. Runs on the panel's
  // popupshowing, after Zen fills its own lists, and after each change.
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
    const customBox = section.querySelector(".whimsy-site-settings-custom");
    const hadFocus = section.contains(doc.activeElement) ?
      doc.activeElement.closest("[whimsy-site-setting]")?.getAttribute("whimsy-site-setting") : null;
    list.replaceChildren();
    customBox.replaceChildren();
    customBox.hidden = true;
    section.hidden = !site;
    if (!site) {
      return;
    }
    section._site = site;
    let remembered = 0;

    list.append(this.zoomRow(win, browser, section));

    // Autoplay (Firefox's permission).
    const principal = this.originPrincipal(site);
    const stored = this.storedAutoplay(principal);
    remembered += stored != null ? 1 : 0;
    const { SitePermissions } = lazy;
    const state = value => ({ value, text: SitePermissions.getMultichoiceStateLabel(AUTOPLAY, value) });
    const autoplay = lazy.WhimsySurface.dropdown(doc, {
      id: "whimsy-site-settings-autoplay-button",
      label: "whimsy-site-settings-autoplay-label",
      width: 240,
      value: stored ?? "default",
      options: [
        state(SitePermissions.ALLOW),
        state(SitePermissions.BLOCK),
        state(SitePermissions.AUTOPLAY_BLOCKED_ALL),
        {
          value: "default",
          rule: true,
          l10nId: "whimsy-site-settings-autoplay-default",
        },
      ],
      onPick: value => {
        if (value == "default") {
          SitePermissions.removeFromPrincipal(principal, AUTOPLAY, browser);
        } else {
          SitePermissions.setForPrincipal(principal, AUTOPLAY, value, SitePermissions.SCOPE_PERSISTENT, browser);
        }
        this.render(win);
      },
    });
    if (stored == null) {
      // Not remembered: the button says what the default does.
      const text = autoplay.button.querySelector(".whimsy-surface-dropdown-value");
      text.removeAttribute("data-l10n-id");
      text.textContent = SitePermissions.getMultichoiceStateLabel(AUTOPLAY, SitePermissions.getDefault(AUTOPLAY));
    }
    const autoplayRow = this.row(doc, {
      kind: "autoplay",
      text: SitePermissions.getPermissionLabel(AUTOPLAY),
      labelId: "whimsy-site-settings-autoplay-label",
      on: stored != null,
      trailing: [autoplay.button],
    });
    list.append(autoplayRow);

    // Reader View and Full Screen: switches.
    for (const kind of ["reader", "fullscreen"]) {
      const on = this.getFlag(kind, site.host, site.oa);
      remembered += on ? 1 : 0;
      const labelId = `whimsy-site-settings-${kind}-label`;
      const toggle = lazy.WhimsySurface.switch(doc, {
        checked: on,
        labelledBy: labelId,
        id: `whimsy-site-settings-${kind}-switch`,
        onChange: checked => {
          this.setFlag(kind, site.host, site.oa, checked);
          if (checked) {
            this.applyNow(win, kind);
          } else if (kind == "fullscreen") {
            this.leaveFullscreen(win, browser, site.host);
          }
          this.render(win);
        },
      });
      list.append(this.row(doc, { kind, l10nId: `whimsy-site-settings-${kind}`, labelId, on, trailing: [toggle] }));
    }

    // Pretend to Be (Whimsy's per-site user agent), last: it's optional.
    if (lazy.WhimsyUserAgent.enabled) {
      const options = this.uaOptions(site);
      const entry = lazy.WhimsyUserAgent.entry(site.host, options);
      const preset = entry?.preset ?? null;
      remembered += preset ? 1 : 0;
      list.append(this.userAgentRow(win, site, options, entry, customBox));
    }

    const note = section.querySelector(".whimsy-site-settings-private-note");
    note.hidden = !(site.oa.privateBrowsingId > 0);
    this.updateForgetAll(section, remembered > 0);
    lazy.ZoomUI.getGlobalValue()
      .then(globalZoom => {
        const zoom = win.ZoomManager?.getZoomForBrowser?.(browser) ?? 1;
        if (section.isConnected && Math.abs(zoom - globalZoom) > 0.001) {
          this.updateForgetAll(section, true);
        }
      })
      .catch(() => {});
    if (hadFocus) {
      const row = list.querySelector(`[whimsy-site-setting="${hadFocus}"]`);
      row?.querySelector("input, button")?.focus();
    }
  },

  // Zoom: − / the % (resets) / +, on Firefox's zoom steps.
  zoomRow(win, browser, section) {
    const doc = win.document;
    const zoom = win.ZoomManager?.getZoomForBrowser?.(browser) ?? 1;
    const stepper = doc.createXULElement("hbox");
    stepper.className = "whimsy-site-settings-stepper";
    stepper.setAttribute("align", "center");
    const button = (l10nId, className, onClick) => {
      const el = doc.createElementNS(HTML_NS, "button");
      el.type = "button";
      el.className = className;
      doc.l10n.setAttributes(el, l10nId);
      el.addEventListener("click", async event => {
        event.stopPropagation();
        await onClick();
        this.updateZoom(win, browser, stepper);
        this.updateForgetAll(section, true);
      });
      return el;
    };
    const out = button("whimsy-site-settings-zoom-out", "whimsy-site-settings-zoom-out", () =>
      win.FullZoom?.reduce?.());
    out.textContent = "−";
    const value = button("whimsy-site-settings-zoom-reset", "whimsy-site-settings-zoom-value", () =>
      this.resetZoom(win, browser));
    const into = button("whimsy-site-settings-zoom-in", "whimsy-site-settings-zoom-in", () =>
      win.FullZoom?.enlarge?.());
    into.textContent = "+";
    stepper.append(out, value, into);
    // − and = work while the stepper has the keyboard.
    stepper.addEventListener("keydown", event => {
      if (event.key == "-" || event.key == "_") {
        event.preventDefault();
        out.click();
      } else if (event.key == "=" || event.key == "+") {
        event.preventDefault();
        into.click();
      } else if (event.key == "0") {
        event.preventDefault();
        value.click();
      }
    });
    this.updateZoom(win, browser, stepper, zoom);
    return this.row(doc, {
      kind: "zoom",
      l10nId: "whimsy-site-settings-zoom",
      labelId: "whimsy-site-settings-zoom-label",
      on: Math.abs(zoom - 1) > 0.001,
      trailing: [stepper],
    });
  },

  updateZoom(win, browser, stepper, zoom = win.ZoomManager?.getZoomForBrowser?.(browser) ?? 1) {
    const [out, value, into] = stepper.children;
    value.textContent = `${Math.round(zoom * 100)}%`;
    value.toggleAttribute("at-default", Math.abs(zoom - 1) < 0.001);
    const min = win.ZoomManager?.MIN ?? 0.3;
    const max = win.ZoomManager?.MAX ?? 5;
    out.disabled = zoom <= min + 0.001;
    into.disabled = zoom >= max - 0.001;
    stepper.closest("[whimsy-site-setting]")?.setAttribute("state", Math.abs(zoom - 1) > 0.001 ? "allow" : "block");
  },

  // Pretend to Be (variant B): one row with a dropdown. Picking reloads the
  // page as that browser while the panel stays; the row says so until the
  // page has loaded. Custom… reveals a field under the list.
  userAgentRow(win, site, options, entry, customBox) {
    const doc = win.document;
    const tab = win.gBrowser.selectedTab;
    const preset = entry?.preset ?? "default";
    const reloadingAs = tab._whimsyUserAgentReloading;
    const dropdown = lazy.WhimsySurface.dropdown(doc, {
      id: "whimsy-site-settings-useragent-button",
      label: "whimsy-site-settings-useragent-label",
      width: 260,
      value: preset,
      options: UA_CHOICES.map(value => ({
        value,
        l10nId: `whimsy-site-settings-useragent-${value}`,
        detailL10nId: { default: "whimsy-site-settings-useragent-default-detail",
          "safari-iphone": "whimsy-site-settings-useragent-iphone-detail" }[value],
        rule: value == "custom",
      })),
      onPick: value => {
        if (value == "custom") {
          this.showCustom(win, site, options, customBox, entry);
          return;
        }
        this.pickUserAgent(win, site, options, value);
      },
    });
    const row = this.row(doc, {
      kind: "useragent",
      l10nId: "whimsy-site-settings-useragent",
      labelId: "whimsy-site-settings-useragent-label",
      detailL10nId: reloadingAs ? "whimsy-site-settings-useragent-reloading" : "whimsy-site-settings-useragent-reloads",
      detailArgs: reloadingAs ? { browser: reloadingAs } : null,
      on: preset != "default",
      trailing: [dropdown.button],
    });
    if (reloadingAs) {
      row.querySelector(".whimsy-surface-row-detail")?.prepend(lazy.WhimsySurface.spinner(doc));
    }
    if (preset == "custom") {
      this.showCustom(win, site, options, customBox, entry, { focus: false });
    }
    return row;
  },

  showCustom(win, site, options, customBox, entry, { focus = true } = {}) {
    const doc = win.document;
    customBox.replaceChildren();
    const field = doc.createElementNS(HTML_NS, "input");
    field.className = "whimsy-site-settings-custom-field";
    field.setAttribute("spellcheck", "false");
    field.value = entry?.custom ?? "";
    doc.l10n.setAttributes(field, "whimsy-useragent-custom-field");
    const apply = lazy.WhimsySurface.footerButton(doc, {
      l10nId: "whimsy-useragent-custom-apply",
      primary: true,
      onCommand: () => {
        const value = field.value.trim();
        if (value) {
          this.pickUserAgent(win, site, options, "custom", value);
        } else {
          field.focus();
        }
      },
    });
    apply.id = "whimsy-site-settings-custom-apply";
    field.addEventListener("keydown", event => {
      if (event.key == "Enter") {
        event.preventDefault();
        apply.doCommand();
      }
    });
    customBox.append(field, apply);
    customBox.hidden = false;
    if (focus) {
      field.focus();
    }
  },

  // Sets (or clears, for Whimsy) the user agent and reloads; the panel
  // stays open and the row says it's reloading until the page loads.
  pickUserAgent(win, site, options, preset, custom = null) {
    const tab = win.gBrowser.selectedTab;
    if (preset == "default") {
      lazy.WhimsyUserAgent.clear(site.host, options);
    } else {
      lazy.WhimsyUserAgent.set(site.host, preset, custom, options);
    }
    const id = `whimsy-site-settings-useragent-${preset}`;
    win.document.l10n.formatValue(id).then(name => {
      tab._whimsyUserAgentReloading = name.replace(/…$/, "");
      const browser = tab.linkedBrowser;
      const listener = {
        onStateChange: (b, progress, request, flags) => {
          const done = Ci.nsIWebProgressListener.STATE_STOP | Ci.nsIWebProgressListener.STATE_IS_WINDOW;
          if (b == browser && progress.isTopLevel && (flags & done) == done) {
            win.gBrowser.removeTabsProgressListener(listener);
            delete tab._whimsyUserAgentReloading;
            if (this.isPanelOpen(win)) {
              this.render(win);
            }
            this.renderPretend(win);
          }
        },
      };
      win.gBrowser.addTabsProgressListener(listener);
      this.render(win);
      this.renderPretend(win);
      lazy.WhimsyUserAgent.reload(win, tab);
    });
  },

  // "Change User Agent…" with Site Settings switched off (the user keeps
  // that command): a small WhimsySurface holding only Pretend to Be, the
  // same row, dropdown and custom field as in This Site.
  openPretend(win) {
    const browser = win.gBrowser.selectedBrowser;
    const site = this.siteOf(browser);
    if (!site || !lazy.WhimsyUserAgent.enabled) {
      return null;
    }
    const parts = lazy.WhimsySurface.create(win, {
      id: PRETEND_PANEL_ID,
      width: 320,
      title: site.host,
      close: true,
      className: "whimsy-pretend-panel",
      initialFocus: () => parts.view.querySelector(".whimsy-surface-dropdown"),
    });
    parts.panel._site = site;
    this.renderPretend(win);
    const anchor = lazy.WhimsySurface.visibleAnchor(win, ["zen-site-data-icon-button", "identity-icon-box", "urlbar"]);
    if (anchor) {
      lazy.WhimsySurface.open(win, parts.panel, { anchor, position: "after_start", y: 4 });
    } else {
      lazy.WhimsySurface.open(win, parts.panel, { at: "page-top-center" });
    }
    return parts.panel;
  },

  renderPretend(win) {
    const panel = win.document.getElementById(PRETEND_PANEL_ID);
    const site = panel?._site;
    if (!site) {
      return;
    }
    const doc = win.document;
    const view = panel.querySelector(".whimsy-surface-view");
    const hadFocus = panel.contains(doc.activeElement);
    for (const el of [...view.children].filter(el => !el.classList.contains("whimsy-surface-header"))) {
      el.remove();
    }
    const options = this.uaOptions(site);
    const group = lazy.WhimsySurface.group(doc);
    const custom = doc.createXULElement("hbox");
    custom.className = "whimsy-site-settings-custom";
    custom.setAttribute("align", "center");
    custom.hidden = true;
    group.append(this.userAgentRow(win, site, options, lazy.WhimsyUserAgent.entry(site.host, options), custom));
    view.append(group, custom);
    if (hadFocus && !custom.contains(doc.activeElement)) {
      view.querySelector(".whimsy-surface-dropdown")?.focus();
    }
  },

  isPanelOpen(win) {
    const panel = win.document.getElementById(PANEL_ID);
    return !!panel && panel.state == "open";
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
   * One row on the track (WhimsySurface): the name (and a line under it),
   * then its control. `state="allow"` marks a remembered value.
   */
  row(doc, o) {
    const { row, label } = lazy.WhimsySurface.row(doc, {
      l10nId: o.l10nId,
      text: o.text,
      detailL10nId: o.detailL10nId,
      detailArgs: o.detailArgs,
      trailing: o.trailing ?? [],
    });
    row.classList.add("whimsy-site-settings-item", `whimsy-site-settings-${o.kind}`);
    row.setAttribute("whimsy-site-setting", o.kind);
    row.setAttribute("state", o.on ? "allow" : "block");
    if (o.labelId) {
      label.id = o.labelId;
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

  async open(win, { focus = null } = {}) {
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
      const target = focus ? section.querySelector(`[whimsy-site-setting="${focus}"]`) : null;
      const controls = [...(target ?? section.querySelector("#whimsy-site-settings-list")).querySelectorAll("button, input")];
      controls.find(el => !el.hidden && !el.disabled && el.checkVisibility())?.focus();
    }
    return true;
  },
};
