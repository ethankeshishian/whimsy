/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W9-03: Form protection: tabs with half-filled forms are exempt from
// auto-archive and typed text is restored after tab crash or reload.
//
// When a user fills in a form on a page, WhimsyFormProtection marks the tab
// with `whimsy-form-protected="true"` and displays a subtle indicator on the
// tab. WhimsyArchive's sweepWindow checks `isFormProtected(tab)` and exempts
// protected tabs from being auto-archived. Firefox SessionStore's built-in
// form data caching (`TabStateCache`) is also consulted, ensuring session
// restore form data is respected and preserved across reloads and crashes.
//
// W10-25 (the user's picks):
// - Marker: an "in-progress form" glyph (a form outline, partly filled,
//   with a pencil) after the tab's title, shown only once the person has
//   typed into a form (whimsy-form-typed), never for an untouched form. A
//   tab protected by hand with nothing typed shows a lock there instead
//   ("Protected tab"); typing takes precedence.
// - Unload asks first: every unload the person asks for goes through
//   gBrowser.explicitUnloadTabs (the tab menu's Unload, Unload Tab, Unload
//   Space); a tab with a form gets "Unload this tab?" beside the sidebar
//   with Keep Loaded as the default. Automatic unloading never touches
//   protected tabs anyway.
// - Refill asks first: a reload keeps what was typed (a snapshot taken as
//   the page goes away, in memory, and for a normal tab also in the
//   session so it survives a restart, for up to 7 days); when the page is
//   back, a toast asks "Fill in 3 answers you typed before?" with Fill In.
//   Passwords and card numbers are never kept.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  TabStateCache: "moz-src:///browser/components/sessionstore/TabStateCache.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyToast: "resource:///modules/whimsy/WhimsyToast.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));

const FEATURE_PREF = "whimsy.feature.form-protection";
const COMMAND_ID = "cmd_whimsyProtectForm";
const ATTR = "whimsy-form-protected";
// W10-25: the person typed into a form here (the marker shows only then).
const TYPED_ATTR = "whimsy-form-typed";
const MARKER_CLASS = "whimsy-tab-form-marker";
const MARKER_ICON = "chrome://browser/content/whimsy/whimsy-form-badge.svg";
// Protected by hand (Protect This Tab) with nothing typed: a lock in the
// same place (the user, 2026-11-01). Typing takes precedence.
const MANUAL_ATTR = "whimsy-form-manual";
const LOCK_ICON = "chrome://browser/skin/zen-icons/selectable/lock-closed.svg";
const SNAPSHOT_KEY = "whimsy-formdata";
const SNAPSHOT_MAX_BYTES = 64 * 1024;
const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const REFILL_OFFER_MS = 10000;
const UNLOAD_PANEL_ID = "whimsy-form-unload";
const HTML_NS = "http://www.w3.org/1999/xhtml";

// browser -> { url, data, time }: the last snapshot (memory).
const snapshots = new WeakMap();

// A page's form snapshot is page data: only plain records of strings,
// booleans and select values, within the size cap.
function cleanSnapshot(data) {
  if (!data || typeof data != "object") {
    return null;
  }
  const clean = {};
  for (const key of ["id", "xpath"]) {
    const record = data[key];
    if (!record || typeof record != "object") {
      continue;
    }
    clean[key] = {};
    for (const [name, value] of Object.entries(record)) {
      if (typeof name != "string" || name.length > 500) {
        continue;
      }
      if (typeof value == "string" || typeof value == "boolean") {
        clean[key][name] = value;
      } else if (value && typeof value == "object" && typeof value.value == "string") {
        clean[key][name] = { selectedIndex: Number(value.selectedIndex) || 0, value: value.value };
      }
    }
  }
  const json = JSON.stringify(clean);
  return json.length <= SNAPSHOT_MAX_BYTES && json != "{}" ? clean : null;
}

function sameAddress(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    x.hash = "";
    y.hash = "";
    return x.href == y.href;
  } catch (e) {
    return false;
  }
}

export class WhimsyFormProtectionParent extends JSWindowActorParent {
  receiveMessage(message) {
    const browser = this.browsingContext?.top?.embedderElement;
    if (message.name === "Whimsy:FormSnapshot") {
      if (browser && this.browsingContext == this.browsingContext.top) {
        WhimsyFormProtection.storeSnapshot(browser, message.data?.url, message.data?.data);
      }
      return null;
    }
    if (message.name === "Whimsy:FormSnapshotFor") {
      if (!browser || this.browsingContext != this.browsingContext.top) {
        return null;
      }
      const snapshot = WhimsyFormProtection.snapshotFor(browser, message.data?.url);
      return snapshot ? { data: snapshot.data } : null;
    }
    if (message.name === "Whimsy:FormRefillReady") {
      if (browser) {
        WhimsyFormProtection.offerRefill(browser, this, Math.max(0, Math.round(Number(message.data?.count) || 0)));
      }
      return null;
    }
    if (message.name === "Whimsy:FormProtectionState") {
      if (!browser) {
        return null;
      }
      if (!browser._whimsyFormContexts) {
        browser._whimsyFormContexts = new Set();
      }
      if (message.data.hasForm) {
        browser._whimsyFormContexts.add(this.browsingContext.id);
      } else {
        browser._whimsyFormContexts.delete(this.browsingContext.id);
      }
      const win = browser.documentGlobal;
      const tab = win?.gBrowser?.getTabForBrowser(browser);
      if (tab) {
        WhimsyFormProtection.updateTabProtection(tab, browser._whimsyFormContexts.size > 0);
      }
    }
    return null;
  }
}

export const WhimsyFormProtection = {
  COMMAND_ID,
  ATTR,
  _initialized: false,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    ChromeUtils.registerWindowActor("WhimsyFormProtection", {
      parent: { esModuleURI: "resource:///modules/whimsy/WhimsyFormProtection.sys.mjs" },
      child: {
        esModuleURI: "resource:///modules/whimsy/WhimsyFormProtectionChild.sys.mjs",
        events: {
          input: { mozSystemGroup: true, capture: true },
          change: { mozSystemGroup: true, capture: true },
          pageshow: { mozSystemGroup: true },
          // W10-25: a snapshot of typed answers as the page goes away.
          pagehide: { mozSystemGroup: true },
        },
      },
      matches: ["https://*/*", "http://*/*"],
      messageManagerGroups: ["browsers"],
      safeForUntrustedWebProcess: true,
    });
  },

  hasSessionRestoreFormData(tab) {
    const browser = tab?.linkedBrowser;
    if (!browser) {
      return false;
    }
    const cached = lazy.TabStateCache?.get(browser.permanentKey);
    const fd = cached?.formdata;
    if (fd) {
      if (fd.id && Object.keys(fd.id).length > 0) {
        return true;
      }
      if (fd.xpath && Object.keys(fd.xpath).length > 0) {
        return true;
      }
      if (fd.innerHTML) {
        return true;
      }
      if (
        Array.isArray(fd.children) &&
        fd.children.some(
          c =>
            c &&
            ((c.id && Object.keys(c.id).length > 0) ||
              (c.xpath && Object.keys(c.xpath).length > 0))
        )
      ) {
        return true;
      }
    }
    return false;
  },

  canProtect(win) {
    return this.enabled && !!win.gBrowser?.selectedBrowser?.currentURI?.spec?.startsWith("http");
  },

  isFormProtected(tab) {
    if (!this.enabled || !tab) {
      return false;
    }
    if (tab.hasAttribute(ATTR)) {
      return true;
    }
    return this.hasSessionRestoreFormData(tab);
  },

  // The dot is drawn with CSS on .tab-icon-stack::before; its meaning goes
  // in the tab's tooltip and accessible description (see wrapTooltip), not
  // in a `title` the tab tooltip overrides (review design-full-4 M10).
  updateTabProtection(tab, hasForm) {
    if (!this.enabled) {
      tab.removeAttribute(ATTR);
      tab.removeAttribute(TYPED_ATTR);
      this.refreshMarker(tab);
      return;
    }
    const typed = !!hasForm || this.hasSessionRestoreFormData(tab);
    const shouldProtect = typed || tab._whimsyFormManual;
    tab.toggleAttribute(ATTR, !!shouldProtect);
    this.setTyped(tab, typed);
  },

  // W10-25: the in-progress form glyph, after the tab's title (the icon
  // stack for pinned tabs and Essentials, which have none). Only after
  // typing.
  setTyped(tab, typed) {
    tab.toggleAttribute(TYPED_ATTR, !!typed);
    this.refreshMarker(tab);
  },

  // The one marker: the form glyph once something was typed, else a lock
  // while the tab is protected by hand, else nothing.
  refreshMarker(tab) {
    const typed = tab.hasAttribute(TYPED_ATTR);
    const manual = !typed && !!tab._whimsyFormManual && tab.hasAttribute(ATTR) && this.enabled;
    tab.toggleAttribute(MANUAL_ATTR, manual);
    let marker = tab.querySelector(`.${MARKER_CLASS}`);
    if (!typed && !manual) {
      return;
    }
    if (!marker) {
      const doc = tab.ownerDocument;
      marker = doc.createXULElement("image");
      marker.className = MARKER_CLASS;
      const label = tab.querySelector(".tab-label-container");
      if (label) {
        label.after(marker);
      } else {
        tab.querySelector(".tab-content")?.append(marker);
      }
    }
    marker.setAttribute("src", typed ? MARKER_ICON : LOCK_ICON);
    marker.setAttribute("kind", typed ? "form" : "lock");
    if (manual) {
      marker.removeAttribute("aria-hidden");
      marker.setAttribute("role", "img");
      tab.ownerDocument.l10n.setAttributes(marker, "whimsy-tab-protected-marker");
    } else {
      marker.setAttribute("aria-hidden", "true");
      marker.removeAttribute("role");
      marker.removeAttribute("data-l10n-id");
      marker.removeAttribute("tooltiptext");
      marker.removeAttribute("aria-label");
    }
  },

  isFormTyped(tab) {
    return !!tab?.hasAttribute(TYPED_ATTR);
  },

  // ---- W10-25: keep and refill what was typed ----

  storeSnapshot(browser, url, data) {
    if (!this.enabled || typeof url != "string" || !/^https?:/.test(url)) {
      return false;
    }
    const clean = cleanSnapshot(data);
    if (!clean) {
      return false;
    }
    // Only the page the tab is on can leave its answers.
    try {
      // URL.host has the port, nsIURI.host doesn't: compare like with like.
      const host = new URL(url).host;
      if (browser.currentURI?.host && browser.currentURI.hostPort != host) {
        return false;
      }
    } catch (e) {
      return false;
    }
    const snapshot = { url, data: clean, time: Date.now() };
    snapshots.set(browser, snapshot);
    const win = browser.documentGlobal;
    const tab = win?.gBrowser?.getTabForBrowser(browser);
    // Private tabs keep it in memory only; normal ones in the session too,
    // so it survives a restart.
    if (tab && !lazy.PrivateBrowsingUtils.isBrowserPrivate(browser) && !lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      try {
        lazy.SessionStore.setCustomTabValue(tab, SNAPSHOT_KEY, JSON.stringify(snapshot));
      } catch (e) {
        console.error("Whimsy: form snapshot", e);
      }
    }
    return true;
  },

  snapshotFor(browser, url) {
    if (!this.enabled || typeof url != "string") {
      return null;
    }
    let snapshot = snapshots.get(browser) ?? null;
    if (!snapshot) {
      const win = browser.documentGlobal;
      const tab = win?.gBrowser?.getTabForBrowser(browser);
      try {
        const stored = tab ? lazy.SessionStore.getCustomTabValue(tab, SNAPSHOT_KEY) : "";
        if (stored) {
          const parsed = JSON.parse(stored);
          snapshot = { url: String(parsed.url ?? ""), data: cleanSnapshot(parsed.data), time: Number(parsed.time) || 0 };
        }
      } catch (e) {
        snapshot = null;
      }
    }
    if (!snapshot?.data || Date.now() - snapshot.time > SNAPSHOT_MAX_AGE_MS) {
      if (snapshot) {
        this.clearSnapshot(browser);
      }
      return null;
    }
    return sameAddress(snapshot.url, url) ? snapshot : null;
  },

  clearSnapshot(browser) {
    snapshots.delete(browser);
    const tab = browser.documentGlobal?.gBrowser?.getTabForBrowser(browser);
    if (tab) {
      try {
        lazy.SessionStore.deleteCustomTabValue(tab, SNAPSHOT_KEY);
      } catch (e) {}
    }
  },

  // "Fill in 3 answers you typed before?" · Fill In. Nothing is filled
  // unless the person asks.
  offerRefill(browser, actor, count) {
    const win = browser.documentGlobal;
    if (!count || !win?.gBrowser || win.gBrowser.selectedBrowser != browser) {
      return null;
    }
    return lazy.WhimsyToast.show(win, {
      l10nId: "whimsy-form-refill-ask",
      l10nArgs: { count },
      detailL10nId: "whimsy-form-refill-ask-detail",
      icon: MARKER_ICON,
      browser,
      timeout: REFILL_OFFER_MS,
      action: {
        id: "whimsyFormRefillFill",
        l10nId: "whimsy-form-refill-fill",
        onCommand: () => {
          this.clearSnapshot(browser);
          actor.sendQuery("Whimsy:FormRefill").catch(() => {});
        },
      },
    });
  },

  // ---- W10-25: ask before unloading a tab with a form ----

  /**
   * "Unload this tab?" beside the sidebar, level with the tab. Resolves
   * true for Unload; Keep Loaded (the default), Return and Esc resolve
   * false.
   */
  confirmUnload(win, tabs) {
    const doc = win.document;
    const tab = tabs[0];
    const browser = tab.linkedBrowser;
    let host = "";
    try {
      host = browser.currentURI?.displayHost || "";
    } catch (e) {}
    const isPrivate = lazy.PrivateBrowsingUtils.isBrowserPrivate(browser) || lazy.PrivateBrowsingUtils.isWindowPrivate(win);
    return new Promise(resolve => {
      let answer = false;
      const parts = lazy.WhimsySurface.create(win, {
        id: UNLOAD_PANEL_ID,
        width: 300,
        titleL10nId: "whimsy-form-unload-title",
        titleArgs: { count: tabs.length },
        footer: true,
        className: "whimsy-form-unload",
        initialFocus: () => keep,
        onHidden: () => resolve(answer),
      });
      const body = doc.createElementNS(HTML_NS, "p");
      body.className = "whimsy-form-unload-body";
      if (tabs.length > 1) {
        doc.l10n.setAttributes(body, "whimsy-form-unload-body-many", { count: tabs.length });
      } else {
        doc.l10n.setAttributes(body, isPrivate ? "whimsy-form-unload-body-private" : "whimsy-form-unload-body",
          { host: host || browser.currentURI?.spec || "" });
      }
      parts.view.append(body);
      parts.panel.setAttribute("aria-describedby", "whimsy-form-unload-body");
      body.id = "whimsy-form-unload-body";
      const unload = lazy.WhimsySurface.footerButton(doc, {
        l10nId: "whimsy-form-unload-accept",
        id: "whimsy-form-unload-accept",
        onCommand: () => {
          answer = true;
          lazy.WhimsySurface.close(parts.panel);
        },
      });
      const keep = lazy.WhimsySurface.footerButton(doc, {
        l10nId: "whimsy-form-unload-keep",
        id: "whimsy-form-unload-keep",
        primary: true,
        onCommand: () => lazy.WhimsySurface.close(parts.panel),
      });
      parts.footer.append(unload, keep);
      lazy.WhimsySurface.finish(parts);
      // Level with the tab, beside the sidebar (where the Look picker opens).
      const sidebar = lazy.WhimsySurface.visibleAnchor(win, ["TabsToolbar", "navigator-toolbox"]);
      const tabRect = tab.getBoundingClientRect();
      const y = sidebar && tabRect.height ? Math.max(0, Math.round(tabRect.top - sidebar.getBoundingClientRect().top)) : 0;
      lazy.WhimsySurface.open(win, parts.panel, { at: "beside-sidebar", y });
    });
  },

  // Every unload the person asks for goes through explicitUnloadTabs; the
  // tabs with forms ask first. Keep Loaded keeps those loaded and unloads
  // the rest.
  wrapUnload(win) {
    const gBrowser = win.gBrowser;
    if (!gBrowser?.explicitUnloadTabs || gBrowser._whimsyFormUnload) {
      return;
    }
    gBrowser._whimsyFormUnload = true;
    const original = gBrowser.explicitUnloadTabs;
    const self = this;
    gBrowser.explicitUnloadTabs = async function (tabs, ...rest) {
      const list = [...(tabs ?? [])];
      const asking = self.enabled ? list.filter(tab => self.isFormProtected(tab) && tab.linkedPanel) : [];
      if (asking.length && !(await self.confirmUnload(win, asking))) {
        const rest_ = list.filter(tab => !asking.includes(tab));
        return rest_.length ? original.call(this, rest_, ...rest) : undefined;
      }
      return original.call(this, list, ...rest);
    };
  },

  isManuallyProtected(tab) {
    return !!tab?._whimsyFormManual;
  },

  toggleTabProtection(tab) {
    if (!tab) {
      return false;
    }
    const protect = !tab._whimsyFormManual;
    tab._whimsyFormManual = protect;
    tab.toggleAttribute(ATTR, protect);
    this.refreshMarker(tab);
    const win = tab.documentGlobal;
    try {
      lazy.WhimsyToast.show(win, {
        l10nId: protect ? "whimsy-form-protected-toast" : "whimsy-form-unprotected-toast",
      });
    } catch (e) {}
    return protect;
  },

  // Firefox's tab tooltip and the focused tab's accessible description both
  // come from gBrowser.getTabTooltip; add a line while the tab is protected.
  wrapTooltip(win) {
    const gBrowser = win.gBrowser;
    if (!gBrowser?.getTabTooltip || gBrowser._whimsyFormTooltip) {
      return;
    }
    gBrowser._whimsyFormTooltip = true;
    const original = gBrowser.getTabTooltip;
    const self = this;
    gBrowser.getTabTooltip = function (tab, ...args) {
      const text = original.call(this, tab, ...args);
      if (!self.enabled || !tab?.hasAttribute(ATTR)) {
        return text;
      }
      let note = "";
      try {
        note = lazy.l10n.formatValueSync("whimsy-tab-form-protected-tooltip", {
          reason: tab._whimsyFormManual ? "manual" : "form",
        });
      } catch (e) {}
      return [text, note].filter(Boolean).join("\n");
    };
  },

  initWindow(win) {
    this.init();
    lazy.WhimsyCommands.register(win, {
      id: COMMAND_ID,
      l10nId: "whimsy-action-protect-form",
      run: w => {
        const tab = w.gBrowser?.selectedTab;
        if (tab) {
          this.toggleTabProtection(tab);
        }
      },
      icon: "chrome://browser/skin/zen-icons/shield.svg",
      isAvailable: w => this.canProtect(w),
      // Review design-full-4 L5: say what running it will do.
      variants: [
        {
          l10nId: "whimsy-action-protect-form-on",
          isAvailable: w => this.canProtect(w) && !this.isManuallyProtected(w.gBrowser.selectedTab),
        },
        {
          l10nId: "whimsy-action-protect-form-off",
          isAvailable: w => this.canProtect(w) && this.isManuallyProtected(w.gBrowser.selectedTab),
        },
      ],
    });
    this.wrapTooltip(win);
    this.wrapUnload(win);

    // Clean up attribute on tab reload or location change if form is cleared
    const onLocationChange = (browser, webProgress, request, location) => {
      const tab = win.gBrowser?.getTabForBrowser(browser);
      if (
        tab &&
        !tab._whimsyFormManual &&
        !this.hasSessionRestoreFormData(tab) &&
        !browser._whimsyFormContexts?.size
      ) {
        tab.removeAttribute(ATTR);
        tab.removeAttribute(TYPED_ATTR);
        this.refreshMarker(tab);
      }
    };
    win.gBrowser?.addTabsProgressListener({
      onLocationChange,
    });
  },
};
