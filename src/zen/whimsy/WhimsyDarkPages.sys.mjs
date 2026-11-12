/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsySiteSettings: "resource:///modules/whimsy/WhimsySiteSettings.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
  WhimsyPage: "resource:///modules/whimsy/WhimsyPage.sys.mjs",
});

import { DARK_PAGES_KEY } from "resource:///modules/whimsy/WhimsyDarkPagesConfig.sys.mjs";
const PREFIX = "whimsy.dark-pages.";
const privateSites = new Map();
const states = new WeakMap();
const windows = new Set();
const ICON = "chrome://browser/content/whimsy/icons/moon.svg";

export const WhimsyDarkPages = {
  get enabled() {
    return Services.prefs.getBoolPref("whimsy.feature.dark-pages", true);
  },

  get mode() {
    return Services.prefs.getStringPref(PREFIX + "mode", "match");
  },

  get active() {
    return this.enabled && (this.mode == "always" || (this.mode == "match" && this._dark));
  },

  sites() {
    try {
      const sites = JSON.parse(Services.prefs.getStringPref(PREFIX + "sites", "{}"));
      return sites && typeof sites == "object" && !Array.isArray(sites) ? sites : {};
    } catch (e) {
      return {};
    }
  },

  siteKey(browser) {
    const uri = browser?.currentURI;
    if (!uri || !(uri.schemeIs("https") || uri.schemeIs("http"))) {
      return null;
    }
    const oa = browser.browsingContext.originAttributes;
    return `${oa.userContextId || 0}|${uri.prePath}`;
  },

  choice(browser) {
    const key = this.siteKey(browser);
    return (browser.browsingContext.originAttributes.privateBrowsingId ? privateSites.get(key) : this.sites()[key]) || "automatic";
  },

  setChoice(browser, value) {
    const key = this.siteKey(browser);
    if (!key || !["automatic", "on", "off"].includes(value)) {
      return;
    }
    this._manual = { key, isPrivate: !!browser.browsingContext.originAttributes.privateBrowsingId,
      serial: (this._manual?.serial || 0) + 1 };
    if (browser.browsingContext.originAttributes.privateBrowsingId) {
      if (value == "automatic") {
        privateSites.delete(key);
      } else {
        privateSites.set(key, value);
      }
      this.publish();
    } else {
      const sites = this.sites();
      if (value == "automatic") {
        delete sites[key];
      } else {
        sites[key] = value;
      }
      Services.prefs.setStringPref(PREFIX + "sites", JSON.stringify(sites));
    }
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    this._dark = Services.prefs.getIntPref("ui.systemUsesDarkTheme", 0) == 1;
    Services.prefs.addObserver(PREFIX, this);
    Services.prefs.addObserver("whimsy.feature.dark-pages", this);
    Services.obs.addObserver(this, "last-pb-context-exited");
    this.publish();
  },

  observe(subject, topic, data) {
    if (data == PREFIX + "offered") {
      return;
    }
    if (topic == "last-pb-context-exited") {
      privateSites.clear();
      if (this._manual?.isPrivate) {
        this._manual = null;
      }
    }
    this.publish();
    if (data == PREFIX + "mode" || data == "whimsy.feature.dark-pages") {
      lazy.WhimsyPage.applyDarkPdf({ reload: true });
    }
  },

  publish() {
    Services.ppmm.sharedData.set(DARK_PAGES_KEY, {
      enabled: this.enabled,
      active: this.active,
      dim: Services.prefs.getBoolPref(PREFIX + "dim-images", false),
      sites: this.sites(),
      privateSites: Object.fromEntries(privateSites),
      manual: this._manual,
    });
    Services.ppmm.sharedData.flush();
    for (const win of windows) {
      this.updateButton(win);
    }
  },

  initWindow(win) {
    this.init();
    windows.add(win);
    const media = win.matchMedia("(prefers-color-scheme: dark)");
    const theme = () => {
      const previous = this.active;
      this._dark = media.matches;
      this.publish();
      if (previous != this.active) {
        lazy.WhimsyPage.applyDarkPdf({ reload: true });
      }
    };
    media.addEventListener("change", theme);
    theme();
    this.addButton(win);
    const update = () => {
      this.updateButton(win);
      this.offer(win, win.gBrowser.selectedBrowser);
    };
    win.gBrowser.tabContainer.addEventListener("TabSelect", update);
    const progress = { onLocationChange: (browser, webProgress, request, location, flags) => {
      if (webProgress?.isTopLevel && !(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT)) {
        states.delete(browser);
        this.updateButton(win);
      }
    } };
    win.gBrowser.addTabsProgressListener(progress);
    win.addEventListener("unload", () => {
      windows.delete(win);
      media.removeEventListener("change", theme);
      win.gBrowser.tabContainer.removeEventListener("TabSelect", update);
      win.gBrowser.removeTabsProgressListener(progress);
    }, { once: true });
    update();
  },

  // The URL bar's moon: a page action like Reader view (the shared
  // .urlbar-page-action > .urlbar-icon markup, so Zen's hover pill and
  // auto-hide apply). One click flips this site between dark and original,
  // live; no menu.
  addButton(win) {
    const doc = win.document;
    const anchor = doc.getElementById("page-action-buttons");
    if (!anchor || doc.getElementById("whimsy-dark-page-button")) {
      return;
    }
    const button = doc.createXULElement("hbox");
    button.id = "whimsy-dark-page-button";
    button.className = "urlbar-page-action";
    button.setAttribute("role", "button");
    button.setAttribute("tabindex", "0");
    const icon = doc.createXULElement("image");
    icon.className = "urlbar-icon";
    icon.setAttribute("src", ICON);
    button.append(icon);
    const toggle = event => {
      if (event.type == "click" ? event.button != 0 : event.key != "Enter" && event.key != " ") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.toggle(win.gBrowser.selectedBrowser);
    };
    button.addEventListener("click", toggle);
    button.addEventListener("keydown", toggle);
    anchor.append(button);
  },

  toggle(browser) {
    this.setChoice(browser, this.state(browser) == "original" ? "on" : "off");
  },

  updateButton(win) {
    const browser = win.gBrowser.selectedBrowser;
    const button = win.document.getElementById("whimsy-dark-page-button");
    if (!button) {
      return;
    }
    const dark = this.state(browser) != "original";
    button.hidden = !this.enabled || !this.siteKey(browser);
    button.toggleAttribute("active", dark);
    // Keep an open site panel's row in step, only when this site's choice
    // or state actually changed (a re-render would close other controls).
    const shown = `${browser.browserId}|${this.siteKey(browser)}|${this.choice(browser)}|${this.state(browser)}`;
    if (button._shown != shown) {
      const panelOpen = win.document.getElementById("zen-unified-site-data-panel")?.state == "open";
      if (panelOpen && button._shown?.startsWith(`${browser.browserId}|${this.siteKey(browser)}|`)) {
        lazy.WhimsySiteSettings.render(win);
      }
      button._shown = shown;
    }
    button.setAttribute("aria-pressed", dark);
    win.document.l10n.setAttributes(button, dark ? "whimsy-dark-pages-button-original" : "whimsy-dark-pages-button-dark");
  },

  state(browser) {
    return states.get(browser) || "original";
  },

  report(browser, state) {
    if (!["native", "generated", "original"].includes(state)) {
      return;
    }
    states.set(browser, state);
    const win = browser.ownerDocument.defaultView;
    this.updateButton(win);
    this.offer(win, browser);
  },

  offer(win, browser) {
    if (win.gBrowser.selectedBrowser != browser || this.state(browser) != "generated" ||
        Services.prefs.getBoolPref(PREFIX + "offered", false)) {
      return;
    }
    const toast = win.gZenUIManager?.toasts?.open("whimsy-dark-pages-toast", {
      key: "whimsy-dark-pages",
      icon: ICON,
      browser,
      timeout: 12000,
      buttons: [
        { id: "whimsyDarkPagesTurnOff", l10nId: "whimsy-dark-pages-turn-off", command: () => {
          Services.prefs.setStringPref(PREFIX + "mode", "off");
        } },
        { id: "whimsyDarkPagesSiteSettings", l10nId: "whimsy-dark-pages-site-settings", command: () => {
          lazy.WhimsySiteSettings.open(win, { focus: "dark-pages" });
        } },
      ],
    });
    if (toast) {
      Services.prefs.setBoolPref(PREFIX + "offered", true);
    }
  },

  // A row like Autoplay's (WhimsySiteSettings.render): label left, the
  // shared dropdown right.
  siteRow(win, browser) {
    if (!this.enabled) {
      return null;
    }
    const doc = win.document;
    const choice = this.choice(browser);
    const dropdown = lazy.WhimsySurface.dropdown(doc, {
      id: "whimsy-site-settings-dark-pages-button",
      label: "whimsy-dark-page-site-label",
      width: 240,
      value: choice,
      options: [
        { value: "automatic", l10nId: "whimsy-dark-pages-automatic" },
        { value: "on", l10nId: "whimsy-dark-pages-dark" },
        { value: "off", l10nId: "whimsy-dark-pages-original" },
      ],
      onPick: value => this.setChoice(browser, value),
    });
    return lazy.WhimsySiteSettings.row(doc, {
      kind: "dark-pages",
      l10nId: "whimsy-dark-pages-site-title",
      labelId: "whimsy-dark-page-site-label",
      on: choice != "automatic",
      trailing: [dropdown.button],
    });
  },
};
