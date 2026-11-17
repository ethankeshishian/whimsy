/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsySiteSettings: "resource:///modules/whimsy/WhimsySiteSettings.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
  WhimsyPage: "resource:///modules/whimsy/WhimsyPage.sys.mjs",
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
  ZoomUI: "resource:///modules/ZoomUI.sys.mjs",
});

import { DARK_PAGES_KEY } from "resource:///modules/whimsy/WhimsyDarkPagesConfig.sys.mjs";
const PREFIX = "whimsy.dark-pages.";
const privateSites = new Map();
const states = new WeakMap();
const windows = new Set();
const ICON = "chrome://browser/content/whimsy/icons/moon.svg";
// W26 site panel: each profile's Automatic Dark Mode, for the page actors
// (WhimsyDarkPagesChild's profileSites).
const PROFILES_KEY = "Whimsy:DarkPagesProfiles";

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

  // The site's choice: what's remembered for it, else what its profile's
  // Automatic Dark Mode gives ("automatic" when that's the global setting).
  choice(browser) {
    return this.storedChoice(browser) || this.profileChoice(browser);
  },

  storedChoice(browser) {
    const key = this.siteKey(browser);
    return (browser.browsingContext.originAttributes.privateBrowsingId ? privateSites.get(key) : this.sites()[key]) || null;
  },

  setChoice(browser, value) {
    value = this.forProfile(browser, value);
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
    this.initProfiles();
    Services.prefs.addObserver(PREFIX, this);
    Services.prefs.addObserver("whimsy.feature.dark-pages", this);
    Services.obs.addObserver(this, "last-pb-context-exited");
    this.publish();
  },

  // The page actor. Whimsy's startup hook registers it after session
  // restore, so pages already open then get their child started here.
  registerActor() {
    this.init();
    if (this._actorRegistered) {
      return;
    }
    this._actorRegistered = true;
    ChromeUtils.registerWindowActor("WhimsyDarkPages", {
      parent: { esModuleURI: "resource:///modules/whimsy/WhimsyDarkPagesParent.sys.mjs" },
      child: {
        esModuleURI: "resource:///modules/whimsy/WhimsyDarkPagesChild.sys.mjs",
        events: {
          DOMDocElementInserted: {},
          StyleSheetApplicableStateChanged: {},
          StyleRuleAdded: {},
          StyleRuleRemoved: {},
          StyleRuleChanged: {},
          DOMContentLoaded: {},
          pageshow: {},
          pagehide: {},
          beforeprint: {},
          afterprint: {},
          load: { capture: true },
        },
      },
      matches: ["http://*/*", "https://*/*"],
      allFrames: false,
      messageManagerGroups: ["browsers"],
      safeForUntrustedWebProcess: true,
    });
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      for (const browser of win.gBrowser?.browsers || []) {
        try {
          browser.browsingContext?.currentWindowGlobal?.getActor("WhimsyDarkPages")
            .sendAsyncMessage("Whimsy:DarkPagesStart");
        } catch (e) {
          // Not a web page (the actor only matches http and https).
        }
      }
    }
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
      this.publishProfiles();
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
  // auto-hide apply). It shows only on an overridden site; one click sets
  // the site back to the global setting, live; no menu.
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

  // Two states per site (owner, W25): dark or not. Off is the default
  // (nothing remembered) when the global setting leaves the site light;
  // otherwise the site's choice is remembered.
  isDark(browser) {
    const choice = this.choice(browser);
    return choice == "on" || (choice == "automatic" && this.active);
  },

  setDark(browser, dark) {
    this.setChoice(browser, dark == this.active ? "automatic" : dark ? "on" : "off");
  },

  toggle(browser) {
    this.setDark(browser, !this.isDark(browser));
  },

  updateButton(win) {
    const browser = win.gBrowser.selectedBrowser;
    const button = win.document.getElementById("whimsy-dark-page-button");
    if (!button) {
      return;
    }
    const dark = this.isDark(browser);
    // Owner, W29: the global setting decides; the site switch overrides it.
    // The moon shows only on a site that differs from the global setting,
    // and a click sets it back.
    button.hidden = !this.enabled || !this.siteKey(browser) || dark == this.active;
    button.toggleAttribute("active", dark);
    // Publishing a choice and receiving the child's state both reach here.
    // Keep existing controls (and their focus/hover) through both updates.
    if (win.document.getElementById("zen-unified-site-data-panel")?.state == "open") {
      this.updateRows(win, browser);
    }
    button.setAttribute("aria-pressed", dark);
    win.document.l10n.setAttributes(button, dark ? "whimsy-dark-pages-button-original" : "whimsy-dark-pages-button-dark");
  },

  updateRows(win, browser) {
    const doc = win.document;
    const siteToggle = doc.getElementById("whimsy-site-settings-dark-pages-switch");
    // An open popup can briefly outlive its selected tab.
    if (siteToggle?._whimsyBrowser != browser) {
      return;
    }
    const update = (id, checked, remembered) => {
      const toggle = doc.getElementById(id);
      if (toggle) {
        toggle.checked = checked;
        toggle.closest("[whimsy-site-setting]").setAttribute("state", remembered ? "allow" : "block");
      }
    };
    update("whimsy-site-settings-dark-pages-switch", this.isDark(browser), this.storedChoice(browser) != null);
    const id = this.userContextIdOf(browser);
    update("whimsy-site-settings-profile-dark-switch", this.profileOn(id), typeof this.profiles()[id] == "boolean");
    const section = lazy.WhimsySiteSettings.sectionOf(win);
    if (section) {
      const updateRemembered = globalZoom => {
        if (!siteToggle.isConnected || win.gBrowser.selectedBrowser != browser) {
          return;
        }
        const remembered = !!section.querySelector(
          '[whimsy-site-setting][state="allow"]:not([whimsy-site-setting="zoom"])');
        const zoom = win.ZoomManager?.getZoomForBrowser?.(browser) ?? 1;
        lazy.WhimsySiteSettings.updateForgetAll(section, remembered || Math.abs(zoom - globalZoom) > 0.001);
      };
      lazy.ZoomUI.getGlobalValue().then(updateRemembered).catch(() => {});
    }
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

  // A switch row like Always Open in Reader View (WhimsySiteSettings.render).
  siteRow(win, browser) {
    if (!this.enabled) {
      return null;
    }
    const doc = win.document;
    const dark = this.isDark(browser);
    const labelId = "whimsy-dark-page-site-label";
    const toggle = lazy.WhimsySurface.switch(doc, {
      checked: dark,
      labelledBy: labelId,
      id: "whimsy-site-settings-dark-pages-switch",
      onChange: checked => this.setDark(browser, checked),
    });
    toggle._whimsyBrowser = browser;
    return lazy.WhimsySiteSettings.row(doc, {
      kind: "dark-pages",
      l10nId: "whimsy-site-settings-dark-mode",
      labelId,
      on: this.storedChoice(browser) != null,
      trailing: [toggle],
    });
  },

  // ---------------------------------------------------------------------
  // W26 site panel: Automatic Dark Mode per profile. Each profile has one
  // two-state switch, its default for every site; a site's own switch
  // overrides it. A profile nobody has switched follows Settings'
  // dark-pages mode (on unless it's Off). Switched on, a profile is dark
  // when Whimsy is (or always, with Settings' Always).

  profiles() {
    try {
      const profiles = JSON.parse(Services.prefs.getStringPref(PREFIX + "profiles", "{}"));
      return profiles && typeof profiles == "object" && !Array.isArray(profiles) ? profiles : {};
    } catch (e) {
      return {};
    }
  },

  // The profile's switch.
  profileOn(userContextId) {
    const stored = this.profiles()[userContextId || 0];
    return typeof stored == "boolean" ? stored : this.mode != "off";
  },

  setProfileOn(userContextId, on) {
    const profiles = this.profiles();
    const id = String(userContextId || 0);
    if (!!on == (this.mode != "off")) {
      delete profiles[id];
    } else {
      profiles[id] = !!on;
    }
    Services.prefs.setStringPref(PREFIX + "profiles", JSON.stringify(profiles));
  },

  // Whether pages in the profile are dark unless a site says otherwise.
  activeFor(userContextId) {
    return this.enabled && this.profileOn(userContextId) && (this.mode == "always" || !!this._dark);
  },

  userContextIdOf(browser) {
    return browser?.browsingContext?.originAttributes?.userContextId || 0;
  },

  // A site with nothing remembered: "automatic" when its profile does what
  // the global setting does, else the profile's own on or off.
  profileChoice(browser) {
    const own = this.activeFor(this.userContextIdOf(browser));
    return own == this.active ? "automatic" : own ? "on" : "off";
  },

  // setChoice's value against the site's profile: "automatic" (the global
  // setting's, from setDark) is kept as an explicit choice where the profile
  // differs, and a choice that matches the profile is not remembered.
  forProfile(browser, value) {
    if (!browser?.browsingContext) {
      return value;
    }
    const own = this.activeFor(this.userContextIdOf(browser));
    if (value == "automatic") {
      if (own == this.active) {
        return value;
      }
      return this.active && this.state(browser) != "locked" ? "on" : "off";
    }
    if ((value == "on") == own && this.state(browser) != "locked") {
      return "automatic";
    }
    return value;
  },

  // Forgets the site's own choice (Forget All), back to its profile's.
  forget(browser) {
    const key = this.siteKey(browser);
    if (!key || !this.storedChoice(browser)) {
      return;
    }
    if (browser.browsingContext.originAttributes.privateBrowsingId) {
      privateSites.delete(key);
      this.publish();
    } else {
      const sites = this.sites();
      delete sites[key];
      Services.prefs.setStringPref(PREFIX + "sites", JSON.stringify(sites));
    }
  },

  // Restores a choice exactly as it was remembered (Undo of Forget All).
  restoreChoice(browser, stored) {
    if (stored) {
      this.setChoice(browser, stored);
    } else {
      this.forget(browser);
    }
  },

  initProfiles() {
    this._profilesObserver = {
      QueryInterface: ChromeUtils.generateQI(["nsIObserver", "nsISupportsWeakReference"]),
      observe: () => {
        this.publishProfiles();
        this.publish();
      },
    };
    for (const pref of [PREFIX + "profiles", PREFIX + "mode", "whimsy.feature.dark-pages"]) {
      Services.prefs.addObserver(pref, this._profilesObserver);
    }
    lazy.WhimsyProfiles.onDelete(id => {
      const profiles = this.profiles();
      if (String(id) in profiles) {
        delete profiles[String(id)];
        Services.prefs.setStringPref(PREFIX + "profiles", JSON.stringify(profiles));
      }
    });
    this.publishProfiles();
  },

  // The page actors' copy: {userContextId: dark} for every profile that
  // differs from the global setting; flushed with the next publish().
  publishProfiles() {
    const differs = {};
    for (const id of Object.keys(this.profiles())) {
      const own = this.activeFor(Number(id));
      if (own != this.active) {
        differs[id] = own;
      }
    }
    Services.ppmm.sharedData.set(PROFILES_KEY, differs);
  },

  // The site panel's Profile Settings row: the profile's Automatic Dark
  // Mode switch.
  profileRow(win, userContextId) {
    if (!this.enabled) {
      return null;
    }
    const doc = win.document;
    const labelId = "whimsy-site-settings-profile-dark-label";
    const toggle = lazy.WhimsySurface.switch(doc, {
      checked: this.profileOn(userContextId),
      labelledBy: labelId,
      id: "whimsy-site-settings-profile-dark-switch",
      onChange: checked => this.setProfileOn(userContextId, checked),
    });
    return lazy.WhimsySiteSettings.row(doc, {
      kind: "profile-dark-pages",
      l10nId: "whimsy-site-settings-profile-dark-mode",
      labelId,
      on: typeof this.profiles()[userContextId || 0] == "boolean",
      trailing: [toggle],
    });
  },
};
