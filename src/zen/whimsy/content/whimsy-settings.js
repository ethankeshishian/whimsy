/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Whimsy's groups in Settings: Look and Feel (app icon, interface zoom,
// look), General → About Whimsy (version and updates), Tab Management and
// Privacy. They live in templates and are moved into their pane the first
// time it's shown, so Zen's settings code stays untouched.

"use strict";

var gWhimsySettings = {
  PANE: "paneZenLooks",

  init() {
    document.addEventListener("paneshown", event => {
      if (event.detail.category == this.PANE) {
        this.insertGroups();
      } else if (event.detail.category == "panePrivacy") {
        this.insertPrivacyGroups();
      } else if (event.detail.category == "paneZenTabManagement") {
        this.insertTabsGroup();
      } else if (["paneAbout", "paneGeneral"].includes(event.detail.category)) {
        this.insertAboutGroup(event.detail.category);
      }
    });
    // batch7: hardware video decoding toggle, in its own listener so it runs
    // on paneGeneral independently of the About-group branch above. With the
    // settings redesign, Firefox's Performance group is in Tab Management
    // (fix/panes).
    document.addEventListener("paneshown", event => {
      if (["paneGeneral", "paneZenTabManagement"].includes(event.detail.category)) {
        this.insertPerformanceGroup(event.detail.category);
      }
    });
  },

  get lazy() {
    const lazy = {};
    ChromeUtils.defineESModuleGetters(lazy, {
      Whimsy: "resource:///modules/whimsy/Whimsy.sys.mjs",
      WhimsyAppIcon: "resource:///modules/whimsy/WhimsyAppIcon.sys.mjs",
      WhimsyUpdates: "resource:///modules/whimsy/WhimsyUpdates.sys.mjs",
      WhimsySpaceArchive: "resource:///modules/whimsy/WhimsySpaceArchive.sys.mjs", // batch9: spaces
    });
    // tierC-vpn: VPN (Firefox's built-in IP Protection) status card.
    ChromeUtils.defineESModuleGetters(lazy, {
      CustomizableUI: "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
      IPProtection: "moz-src:///browser/components/ipprotection/IPProtection.sys.mjs",
      IPProtectionService: "moz-src:///toolkit/components/ipprotection/IPProtectionService.sys.mjs",
      IPProtectionStates: "moz-src:///toolkit/components/ipprotection/IPProtectionService.sys.mjs",
      IPPProxyManager: "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs",
      IPPProxyStates: "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs",
      WhimsyVPN: "resource:///modules/whimsy/WhimsyVPN.sys.mjs",
    });
    Object.defineProperty(this, "lazy", { value: lazy });
    return lazy;
  },

  insertGroups() {
    const template = document.getElementById("template-whimsyLooks");
    if (!template) {
      return;
    }
    Preferences.addAll([{ id: "whimsy.ui-zoom", type: "int" }]);
    const fragment = template.content;
    const groups = [...fragment.children];
    // Above Zen's first Look and Feel group, or at the end of the pane.
    const anchor = document.getElementById("zenVerticalTabsGroup");
    if (anchor) {
      anchor.before(fragment);
    } else {
      document.getElementById("mainPrefPane").append(fragment);
    }
    template.remove();
    for (const group of groups) {
      group.hidden = false;
    }
    Preferences.queueUpdateOfAllElements();

    const { Whimsy } = this.lazy;
    const keep = {
      whimsyUiZoomGroup: Whimsy.featureEnabled("ui-zoom"),
      whimsyAppIconGroup: Whimsy.featureEnabled("app-icon") && AppConstants.platform == "macosx",
    };
    for (const [id, enabled] of Object.entries(keep)) {
      if (!enabled) {
        document.getElementById(id)?.remove();
      }
    }
    if (keep.whimsyAppIconGroup) {
      this.initAppIcons();
    }
    this.initLookGroup();
    WhimsyDarkPagesSettings.init(document);
  },

  // Whimsy's version and updates live in Firefox's own Updates group (the
  // About pane with the settings redesign, General without it): Firefox's
  // version line shows the Whimsy version with "Based on Zen … · Firefox …"
  // under it, and Whimsy adds only the channel, plus the local updater's log
  // and roll back. On a Mac with the local updater, Firefox's "install
  // automatically" choice pauses or resumes it (WhimsyUpdates) and its check
  // button asks it to check.
  async insertAboutGroup(category) {
    const template = document.getElementById("template-whimsyAbout");
    // The updater and its versions only exist on macOS.
    if (!template || AppConstants.platform != "macosx") {
      return;
    }
    // With the settings redesign it goes in the About pane only.
    const redesign = Services.prefs.getBoolPref("browser.settings-redesign.enabled", false);
    if (this._insertingAbout || (category == "paneAbout") != redesign) {
      return;
    }
    this._insertingAbout = true;
    try {
      // The redesigned About pane renders its groups after it's shown.
      const selector =
        category == "paneAbout"
          ? 'setting-pane[data-category="paneAbout"] setting-group[groupid="updates"]'
          : '#mainPrefPane > setting-group[groupid="updates"][data-category="paneGeneral"]';
      let updates = null;
      for (let i = 0; i < 100 && !(updates = document.querySelector(selector)); i++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      if (!updates) {
        return;
      }
      await updates.updateComplete;
      const fieldset = updates.querySelector("moz-fieldset");
      if (!fieldset || !document.getElementById("template-whimsyAbout")) {
        return;
      }
      const group = template.content.firstElementChild;
      template.remove();
      Preferences.addAll([{ id: "whimsy.update-channel", type: "string" }]);
      fieldset.append(group);
      group.hidden = false;
      Preferences.queueUpdateOfAllElements();
      this.hookFirefoxUpdates();
      this.initUpdates();
    } finally {
      this._insertingAbout = false;
    }
  },

  // Wraps Firefox's Updates settings: the version line, and (local updater
  // only) the update state its check button shows.
  hookFirefoxUpdates() {
    const info = Preferences.getSetting("updateAppInfo");
    if (info && !info.config.whimsyHooked) {
      const original = info.config.getControlConfig;
      info.config.whimsyHooked = true;
      info.config.getControlConfig = (config, ...rest) => {
        config = original ? original.call(info.config, config, ...rest) : config;
        const whimsy = this.versionLine;
        if (whimsy) {
          config.controlAttrs = { ...config.controlAttrs, ...whimsy };
        }
        return config;
      };
    }
    const state = Preferences.getSetting("updateState");
    if (state && !state.config.whimsyHooked) {
      const original = state.config.get;
      state.config.whimsyHooked = true;
      state.config.get = function (...args) {
        return this.whimsyPanel || original.apply(this, args);
      };
    }
    // In the local updater's hands, "Check for updates" asks it to check.
    const proto = customElements.get("update-state")?.prototype;
    if (proto && !proto.whimsyHooked) {
      const original = proto.handleButtonClick;
      const settings = this;
      proto.whimsyHooked = true;
      proto.handleButtonClick = function (...args) {
        const checks = ["checkForUpdates", "noUpdatesFound", "checkingFailed", "downloadFailed"];
        if (settings.localUpdater && checks.includes(this.value)) {
          settings.checkLocalUpdater();
          return undefined;
        }
        return original.apply(this, args);
      };
    }
  },

  // Shows a panel of Firefox's update-state (null: Firefox's own).
  setUpdatePanel(panel) {
    const state = Preferences.getSetting("updateState");
    if (state && state.config.whimsyPanel !== panel) {
      state.config.whimsyPanel = panel;
      state.onChange();
    }
  },

  async checkLocalUpdater() {
    this.setUpdatePanel("checkingForUpdates");
    this.localCheck = true;
    if (!(await this.lazy.WhimsyUpdates.checkNow())) {
      this.localCheck = false;
      this.setUpdatePanel("checkingFailed");
      return;
    }
    this.refreshUpdates();
  },

  // A row goes with its feature's switch, except a row that IS that switch
  // (W10-12): turning it off in Settings must not take away the way to
  // turn it back on. Such a row goes only when overlay.py ships the
  // feature off because Zen has its own, unless it's off by choice
  // (data-whimsy-opt-in, e.g. tree-style tabs).
  keepFeatureRow(row) {
    const id = row.dataset.whimsyFeature;
    const pref = `whimsy.feature.${id}`;
    if (row.getAttribute("preference") == pref || row.querySelector(`[preference="${pref}"]`)) {
      return row.hasAttribute("data-whimsy-opt-in") || Services.prefs.getDefaultBranch("").getBoolPref(pref, true);
    }
    return this.lazy.Whimsy.featureEnabled(id);
  },

  insertTabsGroup() {
    const template = document.getElementById("template-whimsyTabs");
    if (!template) {
      return;
    }
    const fragment = template.content;
    const group = fragment.firstElementChild;
    for (const row of [...group.querySelectorAll("[data-whimsy-feature]")]) {
      if (!this.keepFeatureRow(row)) {
        row.remove();
      }
    }
    // wave5/uxfix: drop the collapsed Features list if none of its switches is left.
    const features = group.querySelector("#whimsyTabsFeatures");
    if (features && !features.querySelector("[preference]")) {
      features.remove();
    } else if (features) {
      // Settings search must reach the switches inside, so open the list.
      document.getElementById("searchInput")?.addEventListener("input", () => {
        features.open = true;
      });
    }
    template.remove();
    if (!group.querySelector("[preference]")) {
      return;
    }
    // Skip prefs a Firefox or Zen pane already registered (Preferences
    // throws on a second add; e.g. browser.uidensity, Firefox's Appearance).
    Preferences.addAll(
      [...group.querySelectorAll("[preference]")]
        .filter(el => !Preferences.get(el.getAttribute("preference")))
        .map(el => ({
          id: el.getAttribute("preference"),
          type: el.dataset.prefType || (el.localName == "checkbox" ? "bool" : "int"),
        }))
    );
    // At the end of Zen's Workspaces section, before "Pinned Tabs".
    const anchor = document.getElementById("zenWorkspacesGroup");
    if (anchor) {
      anchor.after(fragment);
    } else {
      document.getElementById("mainPrefPane").append(fragment);
    }
    group.hidden = false;
    Preferences.queueUpdateOfAllElements();
  },

  // Privacy & Security: "Reject cookie banners" and "Remove tracking
  // parameters from links", above Firefox's website privacy group (Global
  // Privacy Control). Each card goes with its whimsy.feature.<id> switch.
  insertPrivacyGroups() {
    const template = document.getElementById("template-whimsyPrivacy");
    if (!template) {
      return;
    }
    const fragment = template.content;
    const groups = [...fragment.children];
    const anchor =
      document.getElementById("nonTechnicalPrivacyGroup") ||
      document.querySelector('[groupid="nonTechnicalPrivacy2"]');
    if (anchor) {
      anchor.before(fragment);
    } else {
      document.getElementById("mainPrefPane").append(fragment);
    }
    template.remove();
    const inits = {
      "cookie-banners": () => this.initCookieBanners(),
      "strip-tracking": () => this.initStripTracking(),
      // batch9p: Scratch and private tabs
      scratch: () => this.initPrefCheckbox("whimsyPrivateInWindow", "whimsy.private.in-window"),
      // W11-14: lock private browsing.
      "private-lock": () => this.initPrivateLock(),
      // tierC-vpn: VPN (Firefox's built-in IP Protection).
      vpn: () => this.initVpn(),
      // wave3: email-aliases
      "email-aliases": () => this.initPrefCheckbox("whimsyEmailAliasesButton", "whimsy.email-aliases.button"),

      // wave3: handoff. Handoff only exists on macOS.
      handoff: () =>
        AppConstants.platform == "macosx"
          ? this.initPrefCheckbox("whimsyHandoffSend", "whimsy.handoff.send")
          : document.getElementById("whimsyHandoffGroup")?.remove(),

      // W10-28: the AI switch and provider moved to Settings → AI.
    };
    for (const group of groups) {
      const feature = group.dataset.whimsyFeature;
      if (feature && !this.lazy.Whimsy.featureEnabled(feature)) {
        group.remove();
        continue;
      }
      group.hidden = false;
      inits[feature]?.();
    }
    this.initPrefCheckbox("whimsyAutofillPayments", "extensions.formautofill.creditCards.enabled");
    this.initPrefCheckbox("whimsyAutofillAddresses", "extensions.formautofill.addresses.enabled");
  },

  // Reject cookie banners: Whimsy's built-in Autoconsent add-on
  // (WhimsyCookieBanners.sys.mjs turns it on or off with the pref).
  // Look and Feel → Look: rows go with their feature switch; the group goes
  // when it has none left.
  initLookGroup() {
    const group = document.getElementById("whimsyLookGroup");
    if (!group) {
      return;
    }
    const { Whimsy } = this.lazy;
    const supported = {
      // Only macOS draws the blurred material behind the window.
      transparency: AppConstants.platform == "macosx",
      // batch13: the menu bar icon only exists on macOS.
      "menu-bar-extra": AppConstants.platform == "macosx",
      // wave3/glass: macOS 26 (Darwin 25) draws Liquid Glass; it shows
      // through the transparency feature.
      "liquid-glass":
        AppConstants.isPlatformAndVersionAtLeast("macosx", "25") && Whimsy.featureEnabled("transparency"),
    };
    for (const row of [...group.querySelectorAll("[data-whimsy-feature]")]) {
      const id = row.dataset.whimsyFeature;
      if (!Whimsy.featureEnabled(id) || supported[id] === false) {
        row.remove();
      }
    }
    if (!group.querySelector("[data-whimsy-feature]")) {
      group.remove();
      return;
    }
    const prefs = [...group.querySelectorAll("[preference]")];
    if (prefs.length) {
      Preferences.addAll(
        prefs
          .filter(el => !Preferences.get(el.getAttribute("preference")))
          .map(el => ({
            id: el.getAttribute("preference"),
            type: el.dataset.prefType || (el.localName == "checkbox" ? "bool" : "string"),
          }))
      );
      Preferences.queueUpdateOfAllElements();
    }
    this.initTransparency();
    this.initUiFont();
  },

  // The font list: the system's families, after "System Font".
  async initUiFont() {
    const list = document.getElementById("whimsyUiFont");
    if (!list) {
      return;
    }
    const current = Services.prefs.getStringPref("whimsy.look.ui-font", "");
    const enumerator = Cc["@mozilla.org/gfx/fontenumerator;1"].getService(Ci.nsIFontEnumerator);
    const fonts = await enumerator.EnumerateAllFontsAsync();
    const families = [...new Set(fonts)].filter(f => !f.startsWith("."));
    if (current && !families.includes(current)) {
      families.unshift(current);
    }
    const fragment = document.createDocumentFragment();
    for (const family of families) {
      const item = document.createXULElement("menuitem");
      item.setAttribute("value", family);
      item.setAttribute("label", family);
      item.style.fontFamily = `"${family.replace(/"/g, "")}"`;
      fragment.appendChild(item);
    }
    list.menupopup.appendChild(fragment);
    list.value = current;
  },

  initTransparency() {
    const slider = document.getElementById("whimsyTransparency");
    if (!slider) {
      return;
    }
    const PREF = "whimsy.look.transparency";
    const output = document.getElementById("whimsyTransparencyValue");
    const show = () => {
      const value = Services.prefs.getIntPref(PREF, 0);
      slider.value = value;
      document.l10n.setAttributes(output, "whimsy-look-transparency-value", { value });
    };
    slider.addEventListener("input", () => {
      Services.prefs.setIntPref(PREF, parseInt(slider.value, 10) || 0);
    });
    Services.prefs.addObserver(PREF, show);
    window.addEventListener("unload", () => Services.prefs.removeObserver(PREF, show), { once: true });
    show();
  },

  initCookieBanners() {
    this.initPrefCheckbox("whimsyRejectCookieBanners", "whimsy.reject-cookie-banners");
  },

  // A checkbox bound to a bool pref, kept in sync both ways.
  // W11-14: the three lock switches go through WhimsyPrivateLock.setChoice,
  // which asks for Touch ID before turning a lock off while it's locked (d8).
  // "Not chosen yet" shows while any of them hasn't been answered.
  initPrivateLock() {
    const { WhimsyPrivateLock } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivateLock.sys.mjs");
    const chromeWin = () => window.browsingContext.topChromeWindow;
    const boxes = ["whimsyPrivateLockTabs", "whimsyPrivateLockSpace", "whimsyPrivateLockWindows"]
      .map(id => document.getElementById(id)).filter(Boolean);
    const notChosen = document.getElementById("whimsyPrivateLockNotChosen");
    const after = document.getElementById("whimsyPrivateLockAfter");
    const sharing = document.getElementById("whimsyPrivateLockSharing");
    const onLeave = document.getElementById("whimsyPrivateLockOnLeave");
    const update = () => {
      for (const box of boxes) {
        box.checked = WhimsyPrivateLock.choice(box.dataset.kind) == 1;
      }
      if (notChosen) {
        notChosen.hidden = !boxes.some(box => WhimsyPrivateLock.choice(box.dataset.kind) == -1);
      }
      if (after) {
        after.value = String(Services.prefs.getIntPref("whimsy.privateLock.afterSeconds", 0));
      }
      if (sharing) {
        sharing.checked = Services.prefs.getBoolPref("whimsy.privateLock.stayUnlockedWhileSharing", false);
      }
      if (onLeave) {
        onLeave.checked = Services.prefs.getBoolPref("whimsy.privateLock.onLeave", true);
      }
    };
    for (const box of boxes) {
      box.addEventListener("change", async () => {
        await WhimsyPrivateLock.setChoice(chromeWin(), box.dataset.kind, box.checked);
        update();
      });
    }
    after?.addEventListener("command", () =>
      Services.prefs.setIntPref("whimsy.privateLock.afterSeconds", parseInt(after.value, 10) || 0));
    sharing?.addEventListener("change", () =>
      Services.prefs.setBoolPref("whimsy.privateLock.stayUnlockedWhileSharing", sharing.checked));
    onLeave?.addEventListener("change", () =>
      Services.prefs.setBoolPref("whimsy.privateLock.onLeave", onLeave.checked));
    Services.prefs.addObserver("whimsy.privateLock.", update);
    window.addEventListener("unload", () => Services.prefs.removeObserver("whimsy.privateLock.", update), { once: true });
    update();
  },

  initPrefCheckbox(id, pref) {
    const checkbox = document.getElementById(id);
    const defaultValue = Services.prefs.getDefaultBranch("").getBoolPref(pref, false);
    const update = () => {
      checkbox.checked = Services.prefs.getBoolPref(pref, defaultValue);
    };
    checkbox.addEventListener("change", () => Services.prefs.setBoolPref(pref, checkbox.checked));
    Services.prefs.addObserver(pref, update);
    window.addEventListener("unload", () => Services.prefs.removeObserver(pref, update), {
      once: true,
    });
    update();
  },

  STRIP_PREFS: [
    "privacy.query_stripping.enabled",
    "privacy.query_stripping.enabled.pbmode",
    "privacy.query_stripping.strip_on_share.enabled",
  ],

  // One switch for stripping links you open (normal and private windows) and
  // links you copy (Copy Clean Link, and Whimsy's copy shortcuts). Turning it
  // back on restores the defaults, so Tracking Protection stays "Standard".
  initStripTracking() {
    const checkbox = document.getElementById("whimsyStripTracking");
    const [enabledPref] = this.STRIP_PREFS;
    const update = () => {
      checkbox.checked = Services.prefs.getBoolPref(enabledPref, false);
    };
    checkbox.addEventListener("change", () => {
      for (const pref of this.STRIP_PREFS) {
        if (checkbox.checked && Services.prefs.getDefaultBranch("").getBoolPref(pref, false)) {
          Services.prefs.clearUserPref(pref);
        } else {
          Services.prefs.setBoolPref(pref, checkbox.checked);
        }
      }
    });
    Services.prefs.addObserver(enabledPref, update);
    window.addEventListener("unload", () => Services.prefs.removeObserver(enabledPref, update), {
      once: true,
    });
    update();
  },

  // tierC-vpn: VPN (Firefox's built-in IP Protection). The checkbox IS the
  // real master switch (browser.ipProtection.enabled); the status line and
  // "Manage" button read/drive Firefox's own service and toolbar button, so
  // this never duplicates them with Whimsy UI of its own.
  initVpn() {
    this.initPrefCheckbox("whimsyVpnEnabled", "browser.ipProtection.enabled");
    // wave9/designfix (M7): one VPN section. Firefox's own VPN group has
    // no on/off switch, only what follows from it (start automatically,
    // website settings, data used), so it stays, right under
    // Whimsy's card, which holds the switch, the status and Manage.
    const card = document.getElementById("whimsyVpnGroup");
    const firefoxVpn = document.querySelector('setting-group[groupid="ipprotection"]');
    if (card && firefoxVpn && card.nextElementSibling != firefoxVpn) {
      firefoxVpn.before(card);
    }
    const status = document.getElementById("whimsyVpnStatus");
    const manage = document.getElementById("whimsyVpnManage");
    if (!status || this._vpnWired) {
      return;
    }
    this._vpnWired = true;
    const { IPProtectionService, IPProtectionStates, IPPProxyManager, IPPProxyStates, WhimsyVPN } = this.lazy;
    const win = window.browsingContext.topChromeWindow;
    // W10-50: "Open VPN panel" only works once Firefox's service has made
    // the panel; until then it's disabled and the status line says why.
    const update = () => {
      const enabled = Services.prefs.getBoolPref("browser.ipProtection.enabled", false);
      const state = IPProtectionService.state;
      if (manage) {
        manage.disabled = !enabled || (state != IPProtectionStates.UNAUTHENTICATED && state != IPProtectionStates.READY);
      }
      if (!enabled) {
        document.l10n.setAttributes(status, "whimsy-vpn-status-off");
        return;
      }
      if (state == IPProtectionStates.UNAVAILABLE) {
        document.l10n.setAttributes(status, "whimsy-vpn-status-unavailable");
      } else if (state == IPProtectionStates.UNINITIALIZED) {
        document.l10n.setAttributes(status, "whimsy-vpn-status-starting");
      } else if (state == IPProtectionStates.UNAUTHENTICATED) {
        // W10-50: a failed "Get started" (region, account, network) says
        // so here instead of silently showing the same button again.
        const error = WhimsyVPN.lastEnrollError;
        document.l10n.setAttributes(
          status,
          error ? WhimsyVPN.enrollErrorL10nId(error) : "whimsy-vpn-status-signed-out"
        );
      } else {
        const proxyState = IPPProxyManager.state;
        if (proxyState == IPPProxyStates.ACTIVE) {
          document.l10n.setAttributes(status, "whimsy-vpn-status-on");
        } else if (proxyState == IPPProxyStates.ACTIVATING) {
          document.l10n.setAttributes(status, "whimsy-vpn-status-connecting");
        } else if (proxyState == IPPProxyStates.ERROR) {
          document.l10n.setAttributes(status, "whimsy-vpn-status-error");
        } else {
          document.l10n.setAttributes(status, "whimsy-vpn-status-ready");
        }
      }
    };
    IPProtectionService.addEventListener("IPProtectionService:StateChanged", update);
    IPPProxyManager.addEventListener("IPPProxyManager:StateChanged", update);
    const prefObserver = () => update();
    Services.prefs.addObserver("browser.ipProtection.enabled", prefObserver);
    Services.obs.addObserver(prefObserver, "whimsy-vpn-enroll-error-changed");
    window.addEventListener(
      "unload",
      () => {
        IPProtectionService.removeEventListener("IPProtectionService:StateChanged", update);
        IPPProxyManager.removeEventListener("IPPProxyManager:StateChanged", update);
        Services.prefs.removeObserver("browser.ipProtection.enabled", prefObserver);
        Services.obs.removeObserver(prefObserver, "whimsy-vpn-enroll-error-changed");
      },
      { once: true }
    );
    update();
    manage?.addEventListener("command", async () => {
      if (!(await WhimsyVPN.openPanel(win))) {
        update();
        WhimsyVPN.explain(win);
      }
    });
    // W10-50: Firefox's "Try Firefox's built-in VPN → Get started" calls
    // IPProtection.getPanel(win)?.enroll(), which is a silent no-op while
    // the service hasn't made the panel. Never a dead button: say why.
    document.addEventListener(
      "click",
      event => {
        if (!event.target.closest?.("#getStartedButton") || WhimsyVPN.getPanel(win)) {
          return;
        }
        event.stopImmediatePropagation();
        event.preventDefault();
        update();
        WhimsyVPN.explain(win);
      },
      true
    );
  },

  initAppIcons() {
    const { WhimsyAppIcon } = this.lazy;
    const list = document.getElementById("whimsyAppIconList");
    for (const id of WhimsyAppIcon.ICONS) {
      const tile = document.createElement("button");
      tile.className = "whimsy-app-icon-tile";
      tile.setAttribute("role", "radio");
      tile.dataset.icon = id;
      const img = document.createElement("img");
      img.src = WhimsyAppIcon.previewURL(id);
      img.alt = "";
      const label = document.createElement("span");
      document.l10n.setAttributes(label, `whimsy-app-icon-${id}`);
      tile.append(img, label);
      tile.addEventListener("click", () => Services.prefs.setStringPref(WhimsyAppIcon.PREF, id));
      list.append(tile);
    }
    const update = () => {
      const selected = WhimsyAppIcon.selectedIcon;
      for (const tile of list.children) {
        tile.setAttribute("aria-checked", tile.dataset.icon == selected);
      }
    };
    Services.prefs.addObserver(WhimsyAppIcon.PREF, update);
    window.addEventListener("unload", () => Services.prefs.removeObserver(WhimsyAppIcon.PREF, update));
    update();
  },

  initUpdates() {
    const { WhimsyUpdates } = this.lazy;
    const showLog = document.getElementById("whimsyUpdatesShowLog");
    const rollback = document.getElementById("whimsyUpdatesRollback");
    const log = document.getElementById("whimsyUpdatesLog");

    showLog.addEventListener("command", async () => {
      log.hidden = !log.hidden;
      document.l10n.setAttributes(showLog, log.hidden ? "whimsy-updates-show-log" : "whimsy-updates-hide-log");
      if (!log.hidden) {
        await this.refreshLog();
        log.scrollTop = log.scrollHeight;
      }
    });
    rollback.addEventListener("command", async () => {
      const state = await WhimsyUpdates.readState();
      const version = state?.previous?.version;
      if (!version) {
        return;
      }
      const [title, message] = await document.l10n.formatValues([
        { id: "whimsy-updates-rollback-confirm-title" },
        { id: "whimsy-updates-rollback-confirm", args: { version } },
      ]);
      if (Services.prompt.confirm(window, title, message)) {
        await WhimsyUpdates.rollBack();
      }
    });

    this.refreshUpdates();
    const timer = setInterval(() => {
      this.refreshUpdates();
      if (!log.hidden) {
        this.refreshLog();
      }
    }, 4000);
    window.addEventListener("unload", () => clearInterval(timer));
  },

  // The local updater's state as a panel of Firefox's update-state.
  localPanel(state, control) {
    if (state?.status == "running") {
      return "checkingForUpdates";
    }
    if (this.localCheck) {
      return state?.last_result == "failed" ? "checkingFailed" : "noUpdatesFound";
    }
    return "checkForUpdates";
  },

  async refreshUpdates() {
    const { WhimsyUpdates } = this.lazy;
    const [state, control, version] = await Promise.all([
      WhimsyUpdates.readState(),
      WhimsyUpdates.readControl(),
      WhimsyUpdates.readVersion(),
    ]);
    const installed = WhimsyUpdates.isInstalled();
    this.localUpdater = installed;
    document.l10n.setAttributes(
      document.getElementById("whimsyUpdatesChannelNote"),
      WhimsyUpdates.channel == "dev" ? "whimsy-updates-channel-dev-note" : "whimsy-updates-channel-release-note"
    );
    await this.renderVersion(version);
    this.setUpdatePanel(installed ? this.localPanel(state, control) : null);

    const staged = document.getElementById("whimsyUpdatesStaged");
    staged.hidden = !(installed && state?.staged?.version);
    if (!staged.hidden) {
      document.l10n.setAttributes(staged, "whimsy-updates-staged", { version: state.staged.version });
    }
    document.getElementById("whimsyUpdatesShowLog").hidden = !installed;
    const rollback = document.getElementById("whimsyUpdatesRollback");
    const previous = state?.previous?.version;
    // Only offered when there's a previous build to go back to.
    rollback.hidden = !installed || !previous;
    if (previous) {
      document.l10n.setAttributes(rollback, "whimsy-updates-rollback", { version: previous });
    }
  },

  // Firefox's version line: the Whimsy version, with its Zen and Firefox
  // base underneath (Firefox's distribution line) and Whimsy's release notes.
  async renderVersion(info) {
    const key = JSON.stringify(info);
    if (this.renderedVersion == key) {
      return;
    }
    this.renderedVersion = key;
    const label = info.zen_label && info.zen_label != info.zen ? info.zen_label : null;
    const base = await document.l10n.formatValue(label ? "whimsy-updates-based-on-label" : "whimsy-updates-based-on", {
      zen: info.zen,
      label,
      firefox: info.firefox || Services.appinfo.platformVersion,
    });
    this.versionLine = {
      ".version": info.version,
      ".distribution": base,
      ".distributionId": "",
      ...(info.notes_url ? { ".releaseNotesURL": info.notes_url } : {}),
    };
    Preferences.getSetting("updateAppInfo")?.onChange();
  },

  // batch7: General → Performance → hardware video decoding. It's read at
  // startup only (gfxPlatform), so changing it shows a restart prompt.
  insertPerformanceGroup(category = "paneGeneral") {
    const template = document.getElementById("template-whimsyPerformance");
    if (!template) {
      const group = document.getElementById("whimsyPerformanceGroup");
      if (group) {
        group.dataset.category = category;
        group.hidden = false;
      }
      return;
    }
    const group = template.content.firstElementChild;
    if (!this.lazy.Whimsy.featureEnabled("hardware-video-decoding")) {
      template.remove();
      return;
    }
    Preferences.addAll([{ id: "media.hardware-video-decoding.enabled", type: "bool" }]);
    const anchor = document.querySelector('[groupid="performance"]');
    group.dataset.category = category;
    template.remove();
    if (anchor) {
      anchor.after(group);
    } else {
      document.getElementById("mainPrefPane").append(group);
    }
    group.hidden = false;
    Preferences.queueUpdateOfAllElements();
    this.initHardwareVideoDecoding();
  },

  initHardwareVideoDecoding() {
    const checkbox = document.getElementById("whimsyHardwareVideoDecoding");
    const note = document.getElementById("whimsyHwDecodeRestart");
    const button = document.getElementById("whimsyHwDecodeRestartButton");
    if (!checkbox || this._hwDecodeWired) {
      return;
    }
    this._hwDecodeWired = true;
    const startupValue = Services.prefs.getBoolPref("media.hardware-video-decoding.enabled", true);
    checkbox.addEventListener("command", () => {
      Preferences.get("media.hardware-video-decoding.enabled").value = checkbox.checked;
      note.hidden = checkbox.checked == startupValue;
    });
    button.addEventListener("command", () => {
      Services.startup.quit(Services.startup.eAttemptQuit | Services.startup.eRestart);
    });
  },

  async refreshLog() {
    const text = await this.lazy.WhimsyUpdates.readLog();
    const log = document.getElementById("whimsyUpdatesLog");
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
    log.textContent = text || (await document.l10n.formatValue("whimsy-updates-log-empty"));
    if (atBottom) {
      log.scrollTop = log.scrollHeight;
    }
  },
};

gWhimsySettings.init();

// batch9: spaces — Settings → Tab Management → Spaces: entry points for
// Zen's existing per-space manager and space-routing rules (Air Traffic
// Control), plus restoring a space Whimsy's archive feature hid. A second
// paneshown listener and methods appended via Object.assign (instead of
// editing gWhimsySettings.init/the object literal directly), so another
// batch extending the same pane doesn't collide with this one.
document.addEventListener("paneshown", event => {
  if (event.detail.category == "paneZenTabManagement") {
    gWhimsySettings.insertSpacesGroup();
    // Re-run on every later visit too, in case a space was hidden or
    // restored elsewhere (insertSpacesGroup only does anything once).
    gWhimsySettings.refreshHiddenSpaces();
  }
});

Object.assign(gWhimsySettings, {
  insertSpacesGroup() {
    const template = document.getElementById("template-whimsySpaces");
    if (!template) {
      return;
    }
    const fragment = template.content;
    const group = fragment.firstElementChild;
    for (const row of [...group.querySelectorAll("[data-whimsy-feature]")]) {
      if (!this.keepFeatureRow(row)) {
        row.remove();
      }
    }
    template.remove();
    const anchor = document.getElementById("whimsyTabsGroup") ?? document.getElementById("zenWorkspacesGroup");
    if (anchor) {
      anchor.after(fragment);
    } else {
      document.getElementById("mainPrefPane")?.append(fragment);
    }
    group.hidden = false;
    this.initSpacesGroup();
  },

  initSpacesGroup() {
    const chromeWin = () => window.browsingContext.topChromeWindow;
    document.getElementById("whimsySpacesManagerButton")?.addEventListener("command", () => {
      chromeWin().document.getElementById("cmd_zenManageWorkspaces")?.doCommand();
    });
    document.getElementById("whimsyHiddenSpacesButton")?.addEventListener("command", () => {
      const { WhimsyHiddenSpaces } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyHiddenSpaces.sys.mjs");
      const win = chromeWin();
      WhimsyHiddenSpaces.open(win, { onHidden: () => this.refreshHiddenSpaces() });
    });
    this.refreshHiddenSpaces();
  },

  // W11-15: "Hidden spaces · N" and a button that opens the Hidden Spaces
  // panel in the browser window, where hiding and showing happen.
  refreshHiddenSpaces() {
    const label = document.getElementById("whimsyHiddenSpacesLabel");
    if (!label) {
      return;
    }
    const { WhimsySpaceArchive } = this.lazy;
    const win = window.browsingContext.topChromeWindow;
    let count = 0;
    try {
      count = WhimsySpaceArchive.listHidden(win).length;
    } catch (e) {}
    document.l10n.setAttributes(label, "whimsy-hidden-spaces-count", { count });
  },
});

// wave4: calendar connections stay in Settings; permission is requested on click.
// wave5/uxfix: they live in General (one place), not Look and Feel.
// Firefox's settings redesign (on in Zen) folds General into its first
// pane: about:preferences#general opens paneSync there.
const whimsyGeneralPane = () =>
  Services.prefs.getBoolPref("browser.settings-redesign.enabled", false) ? "paneSync" : "paneGeneral";
document.addEventListener("paneshown", event => {
  if (event.detail.category == whimsyGeneralPane()) {
    gWhimsySettings.insertNextMeetingGroup(event.detail.category);
  }
});

Object.assign(gWhimsySettings, {
  insertNextMeetingGroup(pane = "paneGeneral") {
    const template = document.getElementById("template-whimsyNextMeeting");
    if (!template) {
      return;
    }
    const { WhimsyNextMeeting: service } = ChromeUtils.importESModule(
      "resource:///modules/whimsy/WhimsyNextMeeting.sys.mjs"
    );
    service.initWindow(window.browsingContext.topChromeWindow);
    const group = template.content.firstElementChild;
    group.dataset.category = pane;
    // After the last General group, so it sits with General's own groups.
    const anchor = [...document.querySelectorAll(`#mainPrefPane > [data-category="${pane}"]`)].at(-1);
    (anchor?.parentElement || document.getElementById("mainPrefPane")).insertBefore(
      template.content, anchor?.nextSibling || null
    );
    template.remove();
    group.hidden = false;
    const get = id => group.querySelector("#" + id);
    const l10n = (node, id) => document.l10n.setAttributes(node, id);
    const sync = () => {
      get("whimsyNextMeetingEnabled").checked = service.enabled;
      get("whimsyNextMeetingCard").checked = service.cardEnabled;
      get("whimsyNextMeetingCard").disabled = !service.enabled;
      for (const node of group.querySelectorAll("button, input")) {
        node.disabled = !service.enabled;
      }
      l10n(get("whimsyMeetingStatus"), !service.enabled ? "whimsy-meeting-paused" :
        !service.hasSources ? "whimsy-meeting-connect-empty" :
        service.next() ? "whimsy-meeting-ready" : "whimsy-meeting-empty");
    };
    for (const [id, pref] of [
      ["whimsyNextMeetingEnabled", "whimsy.feature.next-meeting"],
      ["whimsyNextMeetingCard", "whimsy.next-meeting.sidebar-card"],
    ]) {
      get(id).addEventListener("change", event => Services.prefs.setBoolPref(pref, event.target.checked));
    }
    // W23 connectors: calendars are connectors now (Apple Calendar,
    // Google, and Microsoft in Settings › AI › Connectors).
    get("whimsyMeetingOpenConnectors").addEventListener("click", () => {
      const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
      WhimsyAIProviders.openSettings(window.browsingContext.topChromeWindow, "connectors");
    });
    service.addListener(sync);
    window.addEventListener("unload", () => service.removeListener(sync), { once: true });
    service.refresh({ apple: true });
    sync();
  },
});

// ext: per-space extensions. Just the feature switch and its honest
// .description; the actual per-extension "Show in Spaces…" control lives on
// each extension's gear menu in the extensions panel, not here.
document.addEventListener("paneshown", event => {
  if (event.detail.category == "paneZenTabManagement") {
    gWhimsySettings.insertExtensionsGroup();
  }
});

Object.assign(gWhimsySettings, {
  insertExtensionsGroup() {
    const template = document.getElementById("template-whimsyExtensions");
    if (!template) {
      return;
    }
    const fragment = template.content;
    const group = fragment.firstElementChild;
    // Its one switch is the feature's own (W10-12: it stays when off).
    if (!Services.prefs.getDefaultBranch("").getBoolPref("whimsy.feature.space-extensions", true)) {
      template.remove();
      return;
    }
    template.remove();
    const anchor =
      document.getElementById("whimsySpacesGroup") ??
      document.getElementById("whimsyTabsGroup") ??
      document.getElementById("zenWorkspacesGroup");
    if (anchor) {
      anchor.after(fragment);
    } else {
      document.getElementById("mainPrefPane")?.append(fragment);
    }
    group.hidden = false;
  },
});

// wave3/cmdbar: Settings → Search → Bang Shortcuts. The list is plain text
// ("!w https://...{{{s}}}" per line). Save validates the whole list first,
// so a typo never replaces a working catalog.
document.addEventListener("paneshown", event => {
  if (event.detail.category == "paneSearch") {
    gWhimsySettings.insertBangsGroup();
  }
});

Object.assign(gWhimsySettings, {
});

// batch3glance: Cmd+T in a split. Arc's behavior is the default; unchecking
// it gives Zen's (a separate new tab).
document.addEventListener("paneshown", event => {
  if (event.detail.category == "paneZenTabManagement") {
    gWhimsySettings.insertSplitNewTabRow();
  }
});

Object.assign(gWhimsySettings, {
  insertSplitNewTabRow() {
    const template = document.getElementById("template-whimsySplitNewTab");
    const group = document.getElementById("whimsyTabsGroup");
    if (!template || !group) {
      return;
    }
    const row = template.content.firstElementChild;
    template.remove();
    Preferences.addAll([{ id: "whimsy.feature.split-new-tab", type: "bool" }]);
    const shiftClick = document.getElementById("whimsySplitLinkShiftClick");
    if (shiftClick?.parentElement == group) {
      shiftClick.after(row);
    } else {
      group.append(row);
    }
    Preferences.queueUpdateOfAllElements();
  },
});

Object.assign(gWhimsySettings, {
  insertBangsGroup() {
    const template = document.getElementById("template-whimsyBangs");
    if (!template) {
      return;
    }
    const fragment = template.content;
    const group = fragment.firstElementChild;
    template.remove();
    const { WhimsyBangs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyBangs.sys.mjs");
    Preferences.addAll([{ id: "whimsy.feature.offline-bangs", type: "bool" }]);
    const anchor = document.getElementById("oneClickSearchProvidersGroup");
    if (anchor) {
      anchor.after(fragment);
    } else {
      document.getElementById("mainPrefPane").append(fragment);
    }
    group.hidden = false;

    const list = document.getElementById("whimsyBangsList");
    const status = document.getElementById("whimsyBangsStatus");
    const report = (id, args) => {
      document.l10n.setAttributes(status, id, args);
      if (id == "whimsy-bangs-invalid" || id == "whimsy-bangs-too-long") {
        list.setAttribute("aria-invalid", "true");
      } else {
        list.removeAttribute("aria-invalid");
      }
    };
    list.value = WhimsyBangs.text;
    // Editing again clears a stale "saved" or error message.
    list.addEventListener("input", () => {
      status.removeAttribute("data-l10n-id");
      status.textContent = "";
      list.removeAttribute("aria-invalid");
    });
    document.getElementById("whimsyBangsSave").addEventListener("command", () => {
      try {
        WhimsyBangs.save(list.value);
        report("whimsy-bangs-saved");
      } catch (e) {
        const line = parseInt(e.message, 10);
        if (Number.isInteger(line)) {
          report("whimsy-bangs-invalid", { line });
        } else {
          report("whimsy-bangs-too-long");
        }
      }
    });
    document.getElementById("whimsyBangsReset").addEventListener("command", () => {
      WhimsyBangs.reset();
      list.value = WhimsyBangs.text;
      report("whimsy-bangs-restored");
    });
    const sync = () => {
      const on = Services.prefs.getBoolPref("whimsy.feature.offline-bangs", true);
      for (const id of ["whimsyBangsList", "whimsyBangsSave", "whimsyBangsReset"]) {
        document.getElementById(id).disabled = !on;
      }
    };
    Services.prefs.addObserver("whimsy.feature.offline-bangs", sync);
    window.addEventListener("unload", () => Services.prefs.removeObserver("whimsy.feature.offline-bangs", sync), {
      once: true,
    });
    sync();
    Preferences.queueUpdateOfAllElements();
  },
});

// batch hover: Settings → Tabs → "Hover cards", after Whimsy's Tabs group.
document.addEventListener("paneshown", event => {
  if (event.detail.category == "paneZenTabManagement") {
    gWhimsySettings.insertHoverGroup();
  }
});

Object.assign(gWhimsySettings, {
  insertHoverGroup() {
    const template = document.getElementById("template-whimsyHover");
    if (!template) {
      return;
    }
    const fragment = template.content;
    const group = fragment.firstElementChild;
    for (const row of [...group.querySelectorAll("[data-whimsy-feature]")]) {
      // A superseded feature (overlay.py defaults it off because Zen ships
      // its own) loses its row; the user's own choice keeps the checkbox.
      const pref = `whimsy.feature.${row.dataset.whimsyFeature}`;
      if (!Services.prefs.getDefaultBranch("").getBoolPref(pref, true)) {
        row.remove();
      }
    }
    template.remove();
    // Firefox's own Tabs settings already register
    // browser.tabs.hoverPreview.enabled; adding a pref twice throws.
    Preferences.addAll(
      [...group.querySelectorAll("[preference]")]
        .map(el => el.getAttribute("preference"))
        .filter(id => !Preferences.get(id))
        .map(id => ({ id, type: "bool" }))
    );
    const anchor =
      document.getElementById("whimsyTabsGroup") ?? document.getElementById("zenWorkspacesGroup");
    if (anchor) {
      anchor.after(fragment);
    } else {
      document.getElementById("mainPrefPane")?.append(fragment);
    }
    group.hidden = false;
    Preferences.queueUpdateOfAllElements();
  },
});

// W10-28: Settings → AI, its own pane (Arc's Max tab). Enable AI (on by
// default) heads it; while it's off everything below is dimmed and can't be
// used, with a note saying why. Then the provider (Apple on-device, Claude
// with your API key, or Ollama) as three cards, with only the chosen one's
// fields in a label/control grid; the features, Whimsy's then Firefox's;
// and Claude in Whimsy. The Claude key goes straight to OSKeyStore
// (WhimsyAIProviders) and is never shown again or written to a pref.
// Registered like Menus (register_module before init_all), so
// about:preferences#whimsyAI opens it; the old Privacy & Security links
// (#privacy-whimsyAI, …) land here.
const WHIMSY_AI_PANE = "paneWhimsyAI";
const WHIMSY_AI_OLD_ANCHORS = ["whimsyAI", "whimsyAIGroup", "whimsyAIProviders", "whimsyAIProvidersGroup", "whimsyClaude", "whimsyClaudeGroup"];

Object.assign(gWhimsySettings, {
  registerAIPane() {
    if (typeof register_module != "function" || document.getElementById("category-whimsy-ai")) {
      return;
    }
    const after =
      document.getElementById("category-whimsy-menus") ||
      document.getElementById("category-whimsy-links") ||
      document.getElementById("category-zen-tabs-management");
    if (!after || !this.lazy.Whimsy.featureEnabled("ai-kill-switch")) {
      return;
    }
    const button = document.createElementNS("http://www.w3.org/1999/xhtml", "moz-page-nav-button");
    button.id = "category-whimsy-ai";
    button.setAttribute("view", WHIMSY_AI_PANE);
    button.setAttribute("iconsrc", "chrome://global/skin/icons/highlights.svg");
    button.setAttribute("data-l10n-id", "whimsy-pane-ai-title");
    after.after(button);
    register_module(WHIMSY_AI_PANE, { init: () => this.buildAIPane() });
    // Links to where AI used to be (Privacy & Security) open this pane.
    document.addEventListener("paneshown", event => {
      const { category, subcategory } = event.detail ?? {};
      if (category == "panePrivacy" && WHIMSY_AI_OLD_ANCHORS.includes(subcategory)) {
        gotoPref(WHIMSY_AI_PANE);
      }
    });
  },

  // W23: one page (content/ai-settings/whimsy-ai-settings.js builds it).
  buildAIPane() {
    const template = document.getElementById("template-whimsyAI");
    const pane = document.getElementById("mainPrefPane");
    if (!template || !pane) {
      return;
    }
    if (!this.lazy.Whimsy.featureEnabled("ai-kill-switch")) {
      template.remove();
      return;
    }
    pane.append(template.content);
    template.remove();
    const root = document.getElementById("whimsyAIPage");
    root.hidden = globalThis.gLastCategory?.category != WHIMSY_AI_PANE;
    WhimsyAISettings.mount(root);
  },
});

document.addEventListener("DOMContentLoaded", () => gWhimsySettings.registerAIPane(), { once: true });

// system: Settings → Links, one pane for where links open: links from other
// apps (Mini Whimsy, a tab or Glance), Glance (Zen's own Glance group moves
// here from Look and Feel, with Whimsy's size and pinned-tab rows), split
// view (Shift-click, follower splits) and space routing (Air Traffic
// Control). Each setting lives only here. The pane is registered like
// Zen's own (register_module) before preferences.js's init_all runs, so
// about:preferences#whimsyLinks opens it directly.
const WHIMSY_LINKS_PANE = "paneWhimsyLinks";

Object.assign(gWhimsySettings, {
  registerLinksPane() {
    if (typeof register_module != "function" || document.getElementById("category-whimsy-links")) {
      return;
    }
    const after = document.getElementById("category-zen-tabs-management");
    if (!after) {
      return;
    }
    const button = document.createElementNS("http://www.w3.org/1999/xhtml", "moz-page-nav-button");
    button.id = "category-whimsy-links";
    button.setAttribute("view", WHIMSY_LINKS_PANE);
    button.setAttribute("iconsrc", "chrome://browser/skin/zen-icons/link.svg");
    button.setAttribute("data-l10n-id", "whimsy-pane-links-title");
    after.after(button);
    register_module(WHIMSY_LINKS_PANE, { init: () => this.buildLinksPane() });
  },

  // Moves the Links groups into the page (once) and Zen's Glance group into
  // them. Also runs when Look and Feel is shown, so Glance never shows there.
  buildLinksPane() {
    const template = document.getElementById("template-whimsyLinks");
    if (template) {
      const fragment = template.content;
      const { Whimsy } = this.lazy;
      // A checkbox that is its own feature switch (follower splits) stays
      // when the user turns it off; it goes only when Zen supersedes it.
      const own = new Set(
        [...fragment.querySelectorAll('[preference^="whimsy.feature."]')].map(el =>
          el.getAttribute("preference").slice("whimsy.feature.".length)
        )
      );
      const keep = id =>
        own.has(id)
          ? Services.prefs.getDefaultBranch("").getBoolPref(`whimsy.feature.${id}`, true)
          : Whimsy.featureEnabled(id);
      for (const row of [...fragment.querySelectorAll("[data-whimsy-feature]")]) {
        if (!keep(row.dataset.whimsyFeature)) {
          row.remove();
        }
      }
      template.remove();
      Preferences.addAll(
        [...fragment.querySelectorAll("[preference]")]
          .filter(el => !Preferences.get(el.getAttribute("preference")))
          .map(el => ({
            id: el.getAttribute("preference"),
            type: el.dataset.prefType || (el.localName == "checkbox" ? "bool" : "int"),
          }))
      );
      const groups = [...fragment.children];
      document.getElementById("mainPrefPane").append(fragment);
      document.getElementById("whimsyAtcButton")?.addEventListener("command", () => {
        window.browsingContext.topChromeWindow.document
          .getElementById("cmd_zenOpenSpaceRoutingSettings")
          ?.doCommand();
      });
      this.adoptZenGlance();
      // A group left with no setting goes (the Glance group keeps Zen's).
      for (const group of groups) {
        if (group.localName == "groupbox" && group.isConnected && !group.querySelector("[preference], button")) {
          group.remove();
        }
      }
      Preferences.queueUpdateOfAllElements();
    }
    this.adoptZenGlance();
  },

  // Zen's "Glance" heading and group sit in Look and Feel's template until
  // that pane is first shown; take them from wherever they are now.
  adoptZenGlance() {
    const holder = document.getElementById("whimsyLinksGlanceGroup");
    const looks = document.getElementById("template-paneZenLooks")?.content;
    const find = id => document.getElementById(id) || looks?.querySelector(`#${id}`);
    find("zenGlanceCategory")?.remove();
    const zenGroup = find("zenGlanceGroup");
    if (!zenGroup) {
      return;
    }
    if (!holder) {
      // Links isn't built yet (or Glance already joined it): just keep
      // Glance out of Look and Feel.
      if (zenGroup.getAttribute("data-category") == WHIMSY_LINKS_PANE) {
        return;
      }
      zenGroup.setAttribute("data-category", WHIMSY_LINKS_PANE);
      zenGroup.hidden = true;
      document.getElementById("mainPrefPane").append(zenGroup);
      return;
    }
    zenGroup.setAttribute("data-category", WHIMSY_LINKS_PANE);
    zenGroup.hidden = holder.hidden;
    zenGroup.append(...[...holder.children].filter(el => !el.classList.contains("whimsy-links-own-heading")));
    holder.replaceWith(zenGroup);
  },
});

document.addEventListener("DOMContentLoaded", () => gWhimsySettings.registerLinksPane(), { once: true });
document.addEventListener("paneshown", event => {
  if (event.detail.category == "paneZenLooks") {
    gWhimsySettings.adoptZenGlance();
  }
});

// wave5/profiles: Settings → Tab Management → Profiles (Arc's Settings →
// Profiles). One row per profile: its name, how many spaces use it, Rename
// and Delete this Profile; then Create a New Profile… and Delete Unused
// Profiles. Names are edited inline, checked on submit, with the reason
// under the field. Deleting asks first, because it removes the profile's
// browser data.
document.addEventListener("paneshown", event => {
  if (event.detail.category == "paneZenTabManagement") {
    gWhimsySettings.insertProfilesGroup();
  }
});

Object.assign(gWhimsySettings, {
  get profiles() {
    return ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyProfiles.sys.mjs").WhimsyProfiles;
  },

  insertProfilesGroup() {
    const template = document.getElementById("template-whimsyProfiles");
    if (!template) {
      return;
    }
    const fragment = template.content;
    const group = fragment.firstElementChild;
    template.remove();
    if (!this.lazy.Whimsy.featureEnabled("space-profiles")) {
      return;
    }
    const anchor = document.getElementById("whimsySpacesGroup") ??
      document.getElementById("whimsyTabsGroup") ?? document.getElementById("zenWorkspacesGroup");
    if (anchor) {
      anchor.after(fragment);
    } else {
      document.getElementById("mainPrefPane")?.append(fragment);
    }
    group.hidden = false;
    this.initProfilesGroup();
  },

  initProfilesGroup() {
    const chromeWin = window.browsingContext.topChromeWindow;
    const refresh = () => this.renderProfiles();
    // W10-23: a new profile starts as a row in editor mode at the end of
    // the list, its name field focused.
    document.getElementById("whimsyProfilesCreate").addEventListener("command", () => this.startNewProfile());
    document.getElementById("whimsyProfilesDeleteUnused").addEventListener("command", () =>
      this.deleteUnusedProfiles());
    const topics = ["contextual-identity-created", "contextual-identity-updated",
      "contextual-identity-deleted"];
    for (const topic of topics) {
      Services.obs.addObserver(refresh, topic);
    }
    chromeWin?.addEventListener("ZenWorkspaceDataChanged", refresh);
    window.addEventListener("unload", () => {
      for (const topic of topics) {
        Services.obs.removeObserver(refresh, topic);
      }
      chromeWin?.removeEventListener("ZenWorkspaceDataChanged", refresh);
    }, { once: true });
    // Engine names for the rows' summaries.
    this.visibleEngines().then(engines => {
      this._profileEngines = engines;
      this.renderProfiles();
    }).catch(console.error);
    this.renderProfiles();
  },

  renderProfiles() {
    const list = document.getElementById("whimsyProfilesList");
    if (!list) {
      return;
    }
    // Never pull a half-typed name out from under the person.
    const typing = document.activeElement?.closest?.(".whimsy-profile-row") &&
      document.activeElement.dataset.profileField == "name" &&
      document.activeElement.value != (document.activeElement.dataset.saved ?? "");
    if (typing || list.querySelector(".whimsy-profile-new")) {
      return;
    }
    const focusField = document.activeElement?.dataset?.profileField ?? null;
    const { profiles } = this;
    const chromeWin = window.browsingContext.topChromeWindow;
    list.replaceChildren();
    for (const profile of profiles.list()) {
      list.append(this.profileRow(profile, profiles.spacesFor(profile.id, chromeWin).length));
    }
    for (const hook of this._profileRowHooks ?? []) {
      hook(list);
    }
    document.getElementById("whimsyProfilesDeleteUnused").disabled =
      !profiles.unusedIds(chromeWin).length;
    // The open editor stays open, with the keyboard where it was.
    const open = this._openProfileEditor;
    if (open != null && list.querySelector(`.whimsy-profile-row[data-profile-id="${open}"]`)) {
      this.openProfileEditor(open, { focus: focusField });
    } else {
      this._openProfileEditor = null;
    }
  },

  profileEngineName(key) {
    const id = this.profileSettings.engineFor(key);
    return (id && this._profileEngines?.find(engine => engine.id == id)?.name) || null;
  },

  // ~/Downloads/Work rather than /Users/name/Downloads/Work.
  shortPath(path) {
    try {
      const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
      if (path == home || path.startsWith(home + "/")) {
        return "~" + path.slice(home.length);
      }
    } catch {}
    return path;
  },

  // W10-23: a row is the profile's colour, name and a one-line summary
  // (spaces · search engine · downloads), with one Edit button. Edit opens
  // the editor under it: Name, Search engine and Downloads in one
  // label/control grid (controls fixed-width, all starting at the same
  // edge), then Delete Profile… and Done. Default has no editor: it uses
  // Firefox's own Search and Downloads settings.
  profileRow(profile, spaceCount) {
    const html = tag => document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    const row = html("li");
    row.className = "whimsy-profile-row";
    row.dataset.profileId = profile.id;
    const head = html("div");
    head.className = "whimsy-profile-head";
    const dot = html("span");
    dot.className = "whimsy-profile-dot";
    dot.dataset.color = profile.isDefault ? "default" : profile.color ?? "";
    dot.setAttribute("aria-hidden", "true");
    const titles = html("div");
    titles.className = "whimsy-profile-titles";
    const name = html("h3");
    name.className = "whimsy-profile-name";
    name.id = `whimsyProfileName${profile.id}-title`;
    name.textContent = profile.name;
    const meta = document.createXULElement("description");
    meta.className = "description-deemphasized whimsy-profile-meta";
    titles.append(name, meta);
    head.append(dot, titles);
    row.append(head);
    if (profile.isDefault) {
      document.l10n.setAttributes(meta, "whimsy-profiles-default-meta", { count: spaceCount });
      return row;
    }
    const key = this.profiles.keyFor(profile.id);
    const path = this.profileSettings.downloadDirFor(key);
    const engine = this.profileEngineName(key);
    if (engine && path) {
      document.l10n.setAttributes(meta, "whimsy-profiles-meta", {
        count: spaceCount, engine, downloads: this.shortPath(path),
      });
    } else if (engine) {
      document.l10n.setAttributes(meta, "whimsy-profiles-meta-engine", { count: spaceCount, engine });
    } else if (path) {
      document.l10n.setAttributes(meta, "whimsy-profiles-meta-downloads", {
        count: spaceCount, downloads: this.shortPath(path),
      });
    } else {
      document.l10n.setAttributes(meta, "whimsy-profiles-meta-same", { count: spaceCount });
    }

    const editorId = `whimsyProfileEditor${profile.id}`;
    const edit = document.createXULElement("button");
    edit.className = "whimsy-profile-edit";
    document.l10n.setAttributes(edit, "whimsy-profiles-edit", { name: profile.name });
    edit.setAttribute("aria-controls", editorId);
    edit.setAttribute("aria-expanded", "false");
    edit.addEventListener("command", () => {
      if (row.getAttribute("aria-expanded") == "true") {
        this.closeProfileEditor({ focusEdit: true });
      } else {
        this.openProfileEditor(profile.id, { focus: "name" });
      }
    });
    head.append(edit);
    row.setAttribute("aria-expanded", "false");
    row.append(this.profileEditor(profile, spaceCount, editorId));
    return row;
  },

  profileEditor(profile, spaceCount, editorId) {
    const html = tag => document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    const { profiles, profileSettings } = this;
    const key = profiles.keyFor(profile.id);
    const editor = html("div");
    editor.id = editorId;
    editor.className = "whimsy-profile-editor";
    editor.setAttribute("role", "group");
    editor.setAttribute("aria-labelledby", `whimsyProfileName${profile.id}-title`);
    editor.hidden = true;

    // Name: saved when you leave the field or press Return.
    const nameId = `whimsyProfileName${profile.id}`;
    const nameLabel = html("label");
    nameLabel.className = "whimsy-profile-field-label";
    nameLabel.htmlFor = nameId;
    document.l10n.setAttributes(nameLabel, "whimsy-profiles-field-name");
    const nameInput = html("input");
    nameInput.id = nameId;
    nameInput.type = "text";
    nameInput.className = "whimsy-profile-field";
    nameInput.maxLength = 40;
    nameInput.value = profile.name;
    nameInput.dataset.saved = profile.name;
    nameInput.dataset.profileField = "name";
    nameInput.setAttribute("autocomplete", "off");
    const error = html("p");
    error.id = `${nameId}-error`;
    error.className = "whimsy-profile-name-error whimsy-profile-editor-note";
    error.hidden = true;
    nameInput.setAttribute("aria-describedby", error.id);
    const saveName = () => {
      const value = nameInput.value;
      if (value.trim() == profile.name) {
        return true;
      }
      // Saved first: renaming re-renders the list, which waits while a
      // name is being typed.
      const before = nameInput.dataset.saved;
      nameInput.dataset.saved = value;
      try {
        profiles.rename(profile.id, value);
        return true;
      } catch (e) {
        nameInput.dataset.saved = before;
        error.hidden = false;
        nameInput.setAttribute("aria-invalid", "true");
        document.l10n.setAttributes(error, e.message?.startsWith("whimsy-") ? e.message : "whimsy-profile-name-failed");
        return false;
      }
    };
    nameInput.addEventListener("input", () => {
      error.hidden = true;
      nameInput.removeAttribute("aria-invalid");
    });
    nameInput.addEventListener("change", saveName);
    // F24: Return saves and closes the editor (the editor's keydown, below);
    // an invalid name keeps it open with the error.

    // Search engine.
    const engineId = `whimsyProfileEngine${profile.id}`;
    const engineLabel = document.createXULElement("label");
    engineLabel.className = "whimsy-profile-field-label";
    engineLabel.setAttribute("control", engineId);
    document.l10n.setAttributes(engineLabel, "whimsy-profiles-field-engine");
    const menulist = document.createXULElement("menulist");
    menulist.id = engineId;
    menulist.className = "whimsy-profile-field";
    menulist.dataset.profileField = "engine";
    menulist.setAttribute("sizetopopup", "none");
    const popup = document.createXULElement("menupopup");
    const same = document.createXULElement("menuitem");
    same.setAttribute("value", "");
    document.l10n.setAttributes(same, "whimsy-profiles-same-as-default");
    popup.append(same);
    menulist.append(popup);
    menulist.value = "";
    this.visibleEngines().then(engines => {
      for (const engine of engines) {
        const item = document.createXULElement("menuitem");
        item.setAttribute("value", engine.id);
        item.setAttribute("label", engine.name);
        popup.append(item);
      }
      menulist.value = profileSettings.engineFor(key) ?? "";
    }).catch(console.error);
    menulist.addEventListener("command", () => {
      profileSettings.setEngine(key, menulist.value);
      this.renderProfiles();
    });

    // Downloads: the folder (shortened, the whole path on hover), Choose…,
    // and Use Default once one is set.
    const dirId = `whimsyProfileDir${profile.id}`;
    const dirLabel = html("span");
    dirLabel.id = `${dirId}-label`;
    dirLabel.className = "whimsy-profile-field-label";
    document.l10n.setAttributes(dirLabel, "whimsy-profiles-field-downloads");
    const dirControls = html("div");
    dirControls.className = "whimsy-profile-field-row";
    const dirValue = html("span");
    dirValue.id = dirId;
    dirValue.className = "whimsy-profile-path";
    const path = profileSettings.downloadDirFor(key);
    if (path) {
      dirValue.textContent = this.shortPath(path);
      dirValue.title = path;
    } else {
      document.l10n.setAttributes(dirValue, "whimsy-profiles-same-as-default-text");
    }
    const choose = document.createXULElement("button");
    choose.dataset.profileField = "choose";
    document.l10n.setAttributes(choose, "whimsy-profiles-download-choose");
    choose.setAttribute("aria-describedby", `${dirId}-label ${dirId}`);
    choose.addEventListener("command", () => this.chooseProfileDownloadDir(key));
    dirControls.append(dirValue, choose);
    if (path) {
      const reset = document.createXULElement("button");
      reset.dataset.profileField = "reset";
      document.l10n.setAttributes(reset, "whimsy-profiles-download-reset");
      reset.addEventListener("command", async () => {
        await profileSettings.setDownloadDir(key, null);
        this.renderProfiles();
      });
      dirControls.append(reset);
    }

    // Delete Profile… (only for a profile no space uses) and Done.
    const acts = html("div");
    acts.className = "whimsy-profile-editor-acts";
    const remove = document.createXULElement("button");
    remove.className = "whimsy-profile-delete ghost-button";
    document.l10n.setAttributes(remove, "whimsy-profiles-delete", { name: profile.name });
    remove.disabled = spaceCount > 0;
    remove.addEventListener("command", () => this.deleteProfile(profile));
    const spacer = html("span");
    spacer.className = "whimsy-profile-editor-spacer";
    const done = document.createXULElement("button");
    done.className = "primary whimsy-profile-done";
    done.dataset.profileField = "done";
    document.l10n.setAttributes(done, "whimsy-profiles-done");
    done.addEventListener("command", () => this.closeProfileEditor({ focusEdit: true }));
    acts.append(remove, spacer, done);

    editor.append(nameLabel, nameInput, error, engineLabel, menulist, dirLabel, dirControls, acts);
    if (remove.disabled) {
      const rule = document.createXULElement("description");
      rule.id = `whimsyProfileDeleteRule${profile.id}`;
      rule.className = "description-deemphasized whimsy-profile-editor-note";
      document.l10n.setAttributes(rule, "whimsy-profiles-delete-rule");
      remove.setAttribute("aria-describedby", rule.id);
      editor.append(rule);
    }
    // F24: Esc cancels (an unsaved name goes back to what it was) and Return
    // saves, both closing the editor, back to its Edit button. A menulist's
    // own popup takes Esc and Return first; buttons keep Return.
    editor.addEventListener("keydown", event => {
      if (event.target.open || (event.defaultPrevented && event.key == "Escape")) {
        return;
      }
      if (event.key == "Escape") {
        event.preventDefault();
        // Reverted before closing, so the blur's change event saves nothing.
        nameInput.value = profile.name;
        error.hidden = true;
        nameInput.removeAttribute("aria-invalid");
        this.closeProfileEditor({ focusEdit: true });
      } else if (event.key == "Enter" && (event.target == nameInput || event.target == menulist)) {
        event.preventDefault();
        if (saveName()) {
          this.closeProfileEditor({ focusEdit: true });
        }
      }
    });
    return editor;
  },

  // One editor open at a time.
  openProfileEditor(id, { focus = null } = {}) {
    const list = document.getElementById("whimsyProfilesList");
    for (const row of list?.querySelectorAll(".whimsy-profile-row") ?? []) {
      const open = row.dataset.profileId == String(id);
      if (row.getAttribute("aria-expanded") == null && !open) {
        continue;
      }
      row.setAttribute("aria-expanded", open);
      row.querySelector(".whimsy-profile-edit")?.setAttribute("aria-expanded", open);
      const editor = row.querySelector(".whimsy-profile-editor");
      if (editor) {
        editor.hidden = !open;
      }
      if (open && focus) {
        row.querySelector(`[data-profile-field="${focus}"]`)?.focus();
      }
    }
    this._openProfileEditor = id;
  },

  closeProfileEditor({ focusEdit = false } = {}) {
    const id = this._openProfileEditor;
    this._openProfileEditor = null;
    const row = document.querySelector(`.whimsy-profile-row[data-profile-id="${id}"]`);
    if (!row) {
      return;
    }
    row.setAttribute("aria-expanded", "false");
    row.querySelector(".whimsy-profile-edit")?.setAttribute("aria-expanded", "false");
    const editor = row.querySelector(".whimsy-profile-editor");
    if (editor) {
      editor.hidden = true;
    }
    if (focusEdit) {
      row.querySelector(".whimsy-profile-edit")?.focus();
    }
  },

  // W10-23: Create a New Profile… adds a row in editor mode: Name, then
  // Cancel and Create Profile. The new profile's editor opens after, for
  // its search engine and downloads.
  startNewProfile() {
    const list = document.getElementById("whimsyProfilesList");
    if (!list) {
      return;
    }
    const existing = list.querySelector(".whimsy-profile-new");
    if (existing) {
      existing.querySelector("input")?.focus();
      return;
    }
    this.closeProfileEditor();
    const html = tag => document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    const row = html("li");
    row.className = "whimsy-profile-row whimsy-profile-new";
    row.setAttribute("aria-expanded", "true");
    const head = html("div");
    head.className = "whimsy-profile-head";
    const dot = html("span");
    dot.className = "whimsy-profile-dot";
    dot.dataset.color = "default";
    dot.setAttribute("aria-hidden", "true");
    const titles = html("div");
    titles.className = "whimsy-profile-titles";
    const title = html("h3");
    title.className = "whimsy-profile-name";
    title.id = "whimsyProfileNew-title";
    document.l10n.setAttributes(title, "whimsy-profile-create-title");
    titles.append(title);
    head.append(dot, titles);

    const form = html("form");
    form.className = "whimsy-profile-editor whimsy-profile-name-form";
    form.setAttribute("aria-labelledby", title.id);
    const label = html("label");
    label.className = "whimsy-profile-field-label";
    label.htmlFor = "whimsyProfileNewName";
    document.l10n.setAttributes(label, "whimsy-profiles-field-name");
    const input = html("input");
    input.id = "whimsyProfileNewName";
    input.type = "text";
    input.className = "whimsy-profile-field";
    input.maxLength = 40;
    input.dataset.profileField = "name";
    input.setAttribute("autocomplete", "off");
    const error = html("p");
    error.id = "whimsyProfileNewName-error";
    error.className = "whimsy-profile-name-error whimsy-profile-editor-note";
    error.hidden = true;
    input.setAttribute("aria-describedby", error.id);
    const acts = html("div");
    acts.className = "whimsy-profile-editor-acts";
    const cancel = document.createXULElement("button");
    cancel.className = "ghost-button";
    document.l10n.setAttributes(cancel, "whimsy-profile-cancel");
    const spacer = html("span");
    spacer.className = "whimsy-profile-editor-spacer";
    const create = document.createXULElement("button");
    create.className = "primary";
    document.l10n.setAttributes(create, "whimsy-profile-create-button");
    acts.append(cancel, spacer, create);
    form.append(label, input, error, acts);
    row.append(head, form);
    list.append(row);

    const close = () => {
      row.remove();
      this.renderProfiles();
      document.getElementById("whimsyProfilesCreate")?.focus();
    };
    const submit = () => {
      let profile;
      try {
        profile = this.profiles.create(input.value);
      } catch (e) {
        error.hidden = false;
        input.setAttribute("aria-invalid", "true");
        document.l10n.setAttributes(error, e.message?.startsWith("whimsy-") ? e.message : "whimsy-profile-name-failed");
        input.focus();
        return;
      }
      row.remove();
      const id = typeof profile == "object" ? profile?.id ?? profile?.userContextId : profile;
      this._openProfileEditor = id ?? null;
      this.renderProfiles();
      if (id != null) {
        this.openProfileEditor(id, { focus: "engine" });
      }
    };
    cancel.addEventListener("command", close);
    create.addEventListener("command", submit);
    form.addEventListener("submit", event => {
      event.preventDefault();
      submit();
    });
    form.addEventListener("keydown", event => {
      if (event.key == "Escape") {
        event.preventDefault();
        close();
      }
    });
    input.addEventListener("input", () => {
      error.hidden = true;
      input.removeAttribute("aria-invalid");
    });
    input.focus();
    return form;
  },

  async deleteProfile(profile) {
    const chromeWin = window.browsingContext.topChromeWindow;
    const { WhimsyPanels } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPanels.sys.mjs");
    const [title, body, accept] = await document.l10n.formatValues([
      { id: "whimsy-profiles-delete-confirm-title", args: { name: profile.name } },
      { id: "whimsy-profiles-delete-confirm-body" },
      { id: "whimsy-profiles-delete-confirm-accept" },
    ]);
    if (await WhimsyPanels.confirm(chromeWin, { title, body, accept })) {
      await this.profiles.delete(profile.id, chromeWin);
      this.renderProfiles();
    }
  },

  async deleteUnusedProfiles() {
    const chromeWin = window.browsingContext.topChromeWindow;
    const { profiles } = this;
    const ids = profiles.unusedIds(chromeWin);
    if (!ids.length) {
      return;
    }
    const { WhimsyPanels } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPanels.sys.mjs");
    const names = new Intl.ListFormat(undefined, { type: "conjunction" })
      .format(ids.map(id => profiles.nameOf(id)));
    const [title, body, accept] = await document.l10n.formatValues([
      { id: "whimsy-profiles-delete-unused-confirm-title", args: { count: ids.length } },
      { id: "whimsy-profiles-delete-unused-confirm-body", args: { names } },
      { id: "whimsy-profiles-delete-unused-confirm-accept", args: { count: ids.length } },
    ]);
    if (await WhimsyPanels.confirm(chromeWin, { title, body, accept })) {
      await profiles.deleteUnused(chromeWin);
      this.renderProfiles();
    }
  },
});

// wave5/profiles, phase 4: Search Engine and Default Download Location per
// profile. W10-23: they live in each profile's editor (profileEditor);
// Default uses Firefox's own Search and Downloads settings.
Object.assign(gWhimsySettings, {
  get profileSettings() {
    return ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyProfileSettings.sys.mjs")
      .WhimsyProfileSettings;
  },

  async visibleEngines() {
    const { SearchService } = ChromeUtils.importESModule(
      "moz-src:///toolkit/components/search/SearchService.sys.mjs");
    await SearchService.init();
    return SearchService.getVisibleEngines();
  },

  async chooseProfileDownloadDir(key) {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    const title = await document.l10n.formatValue("whimsy-profiles-download-picker-title");
    picker.init(window.browsingContext, title, Ci.nsIFilePicker.modeGetFolder);
    const current = this.profileSettings.downloadDirFor(key);
    if (current) {
      try {
        picker.displayDirectory = new FileUtils.File(current);
      } catch {}
    }
    const result = await new Promise(resolve => picker.open(resolve));
    if (result == Ci.nsIFilePicker.returnOK && picker.file) {
      await this.profileSettings.setDownloadDir(key, picker.file.path);
      this.renderProfiles();
    }
  },
});

// wave6/search: Settings → Search → Instant Results, after Bang Shortcuts
// (inserted by the listener above, which runs first). The deck only applies
// while Shift+Enter is on.
document.addEventListener("paneshown", event => {
  if (event.detail.category == "paneSearch") {
    gWhimsySettings.insertSearchDeckGroup();
  }
});

// wave9/designfix (M8): a named step, so insertAllForSearch can add it too.
gWhimsySettings.insertSearchDeckGroup = function () {
  const template = document.getElementById("template-whimsySearchDeck");
  if (!template) {
    return;
  }
  const fragment = template.content;
  template.remove();
  Preferences.addAll([
    { id: "whimsy.feature.instant-result", type: "bool" },
    { id: "whimsy.feature.search-deck", type: "bool" },
  ]);
  const anchor = document.getElementById("whimsyBangsGroup") ?? document.getElementById("oneClickSearchProvidersGroup");
  if (anchor) {
    anchor.after(fragment);
  } else {
    document.getElementById("mainPrefPane").append(fragment);
  }
  const group = document.getElementById("whimsySearchDeckGroup");
  group?.removeAttribute("hidden");
  const sync = () => {
    const on = Services.prefs.getBoolPref("whimsy.feature.instant-result", true);
    document.getElementById("whimsySearchDeck")?.toggleAttribute("disabled", !on);
  };
  Services.prefs.addObserver("whimsy.feature.instant-result", sync);
  window.addEventListener("unload", () => Services.prefs.removeObserver("whimsy.feature.instant-result", sync), {
    once: true,
  });
  sync();
  Preferences.queueUpdateOfAllElements();
};

// wave6: navigation switches (Already open, Trails, Page actions), at the
// end of Tab Management -> Tabs. Each checkbox is the feature's own switch.
document.addEventListener("paneshown", event => {
  if (event.detail.category == "paneZenTabManagement") {
    gWhimsySettings.insertNavigationRows();
  }
});

gWhimsySettings.insertNavigationRows = function () {
  const template = document.getElementById("template-whimsyNavigation");
  const group = document.getElementById("whimsyTabsGroup");
  if (!template || !group) {
    return;
  }
  const rows = [...template.content.children];
  template.remove();
  Preferences.addAll(rows.map(row => ({ id: row.getAttribute("preference"), type: "bool" })));
  group.append(...rows);
  Preferences.queueUpdateOfAllElements();
};

// fix7 settings: search. Firefox's Settings search only looks at what is in
// #mainPrefPane once every pane's template is inserted (gSearchResultsPane.
// initializeCategories). Whimsy's groups wait in their own templates until
// their pane is first shown, so "Claude", "Liquid Glass" or "VPN" found
// nothing until you had opened that pane. After Firefox's own category
// setup, every Whimsy group goes in too, hidden unless it belongs to the
// pane on screen (the search reveals what matches).
Object.assign(gWhimsySettings, {
  insertAllForSearch() {
    const pane = document.getElementById("mainPrefPane");
    if (!pane) {
      return;
    }
    const before = new Set(pane.children);
    const steps = [
      // Look and Feel
      () => this.insertGroups(),
      () => this.insertNextMeetingGroup(),
      () => this.adoptZenGlance(),
      () => this.insertTeachGroup(), // wave9/designfix (H2)
      // Privacy & Security
      () => this.insertPrivacyGroups(),
      () => this.buildAIPane(), // W10-28: Settings → AI, with Claude in Whimsy
      // Tab Management
      () => this.insertTabsGroup(),
      () => this.insertSplitNewTabRow(),
      () => this.insertSpacesGroup(),
      () => this.insertExtensionsGroup(),
      () => this.insertHoverGroup(),
      () => this.insertNavigationRows(), // wave9/designfix (M8): Trails, Page actions, ...
      () => this.insertProfilesGroup(), // wave9/designfix (M8)
      // Search
      () => this.insertBangsGroup(),
      () => this.insertSearchDeckGroup(), // wave9/designfix (M8)
      // General (or Tab Management with the settings redesign)
      () =>
        this.insertPerformanceGroup(
          document.querySelector('[groupid="performance"]')?.getAttribute("data-category") || "paneGeneral"
        ),
      // wave9: Battery Saver, right after Performance
      () =>
        this.insertBatterySaverGroup?.(
          document.querySelector('[groupid="performance"]')?.getAttribute("data-category") || "paneGeneral"
        ),
      // About (async: it waits for Firefox's Updates group to render)
      () =>
        this.insertAboutGroup(
          Services.prefs.getBoolPref("browser.settings-redesign.enabled", false) ? "paneAbout" : "paneGeneral"
        ),
    ];
    for (const step of steps) {
      try {
        step();
      } catch (e) {
        console.error("Whimsy settings: inserting a group for search failed", e);
      }
    }
    const current = gLastCategory?.category;
    for (const el of pane.children) {
      if (!before.has(el) && el.dataset.category && el.dataset.category != current) {
        el.hidden = true;
      }
    }
  },

  hookSearch() {
    const search = typeof gSearchResultsPane == "object" ? gSearchResultsPane : null;
    if (!search || search.whimsyHooked) {
      return;
    }
    search.whimsyHooked = true;
    const settle = async () => {
      this.insertAllForSearch();
      this.hideHiddenHomeFromSearch();
      // W11-07: every pane is set up now, Home included.
      this.ensureFirefoxHomeGroup?.();
      if (document.hasPendingL10nMutations) {
        await new Promise(r => document.addEventListener("L10nMutationsFinished", r, { once: true }));
      }
      // wave10 (W10-12): each setting is found by its short name and other
      // words too ("Tidy Titles" for "Tidy tab titles").
      try {
        ChromeUtils.importESModule(
          "resource:///modules/whimsy/WhimsySettingsCommands.sys.mjs"
        ).WhimsySettingsCommands.applySearchKeywords(document);
      } catch (e) {
        console.error("Whimsy settings: search keywords", e);
      }
    };
    if (search._categoriesInitialized) {
      // Firefox already set up its panes: chain onto that.
      search._categoriesInitialized = search._categoriesInitialized.then(settle);
      return;
    }
    const original = search.runCategoryInitialization;
    search.runCategoryInitialization = async function (...args) {
      await original.apply(this, args);
      await settle();
    };
  },
});

gWhimsySettings.hookSearch();
document.addEventListener("DOMContentLoaded", () => gWhimsySettings.hookSearch(), { once: true });

// fix/panes: Firefox 159's Appearance and Tabs and browsing panes overlap
// Zen's Look and Feel and Tab Management. Their settings move into Zen's two
// panes as Firefox's own setting groups (same prefs, same behavior), the two
// panes leave the sidebar, and links to them (#appearance, #tabsBrowsing-drm,
// …) land where the setting went. Left out because Zen already has each one:
// Browser layout (sidebar.verticalTabs is locked; Zen's Layout chooser),
// Keyboard shortcuts (a link to about:keyboard; Zen's Keyboard Shortcuts)
// and Related settings (links to panes in the sidebar).
// docs/whimsy/settings-panes.md has the full inventory.
const WHIMSY_MERGED_PANES = {
  appearance: "zenLooks",
  tabsBrowsing: "zenTabManagement",
};

Object.assign(gWhimsySettings, {
  // Runs on DOMContentLoaded before preferences.js's init_all (this file's
  // listener is added first), so the panes are never built.
  mergeFirefoxPanes() {
    if (this._panesMerged || typeof SettingPaneManager != "object" || typeof register_module != "function") {
      return;
    }
    this._panesMerged = true;

    // Registered without groups: no page and no sidebar button. Their
    // sub-pages (Containers, Browser icon) hang off Zen's pane instead, for
    // the breadcrumb, the back arrow and the sidebar highlight.
    const registerPane = SettingPaneManager.registerPane;
    SettingPaneManager.registerPane = function (id, config) {
      if (id in WHIMSY_MERGED_PANES) {
        config = { ...config, groupIds: [] };
      } else if (config.parent in WHIMSY_MERGED_PANES) {
        config = { ...config, parent: WHIMSY_MERGED_PANES[config.parent] };
      }
      return registerPane.call(this, id, config);
    };
    registerPane.call(SettingPaneManager, "zenLooks", { l10nId: "whimsy-pane-looks-crumb", groupIds: [] });
    registerPane.call(SettingPaneManager, "zenTabManagement", { l10nId: "whimsy-pane-tabs-crumb", groupIds: [] });
    for (const id of ["category-appearance", "category-tabs-browsing"]) {
      document.getElementById(id)?.remove();
    }
    this.redirectMergedPanes();

    // Firefox's groups go in while Zen's pane is set up, before Firefox
    // shows the pane's elements and scrolls to a linked subcategory.
    const inserts = {
      paneZenLooks: () => this.insertFirefoxLooks(),
      paneZenTabManagement: () => this.insertFirefoxTabs(),
    };
    const registerModule = register_module;
    window.register_module = function (name, module) {
      const result = registerModule.call(this, name, module);
      const entry = inserts[name] && gCategoryInits.get(name);
      if (entry) {
        const init = entry.init;
        entry.init = function () {
          const first = !this._initted;
          init.call(this);
          if (first) {
            try {
              inserts[name]();
            } catch (e) {
              console.error("Whimsy settings: adding Firefox's groups failed", e);
            }
          }
        };
      }
      return result;
    };
  },

  redirectMergedPanes() {
    const { LEGACY_PANE_MAPPINGS } = ChromeUtils.importESModule(
      "chrome://browser/content/preferences/config/LegacyPaneMappings.mjs",
      { global: "current" }
    );
    const layout = { category: "zenLooks", subcategory: "layout" };
    // Firefox's own redirects into the two panes (#general-drm, …).
    for (const [key, dest] of LEGACY_PANE_MAPPINGS) {
      if (dest.category in WHIMSY_MERGED_PANES) {
        LEGACY_PANE_MAPPINGS.set(
          key,
          dest.subcategory == "layout"
            ? layout
            : { category: WHIMSY_MERGED_PANES[dest.category], subcategory: dest.subcategory }
        );
      }
    }
    // Any other #appearance-… or #tabsBrowsing-… falls back to these.
    LEGACY_PANE_MAPPINGS.set("appearance", { category: "zenLooks" });
    LEGACY_PANE_MAPPINGS.set("appearance-windowDensity", { category: "zenLooks", subcategory: "windowDensity" });
    LEGACY_PANE_MAPPINGS.set("tabsBrowsing", { category: "zenTabManagement", subcategory: "tabsBrowsing" });
    LEGACY_PANE_MAPPINGS.set("tabsBrowsing-layout", layout);
    for (const sub of ["drm", "link-preview", "cfraddons", "cfrfeatures"]) {
      LEGACY_PANE_MAPPINGS.set(`tabsBrowsing-${sub}`, { category: "zenTabManagement", subcategory: sub });
    }
  },

  // Look and Feel: Website appearance (Automatic/Light/Dark), Window density
  // and Browser icon, at the top of the pane. W8-39: no Browser theme group;
  // Firefox's lightweight themes don't reach Zen's chrome.
  insertFirefoxLooks() {
    let groups = this.takeFirefoxGroups("template-whimsyFirefoxLooks");
    if (!groups) {
      return;
    }
    // wave9/designfix (M7): one Density control. Whimsy's (Look group) sets
    // the same browser.uidensity and each space can override it, so
    // Firefox's Window density group only stays when that row is off.
    if (this.lazy.Whimsy.featureEnabled("space-look")) {
      groups = groups.filter(group => group.getAttribute("groupid") != "windowDensity");
    }
    const anchor = document.getElementById("zenVerticalTabsCategory") ?? document.getElementById("zenVerticalTabsGroup");
    this.placeFirefoxGroups(groups, anchor, "before");
    // Zen's "Manage themes" line links the same inert themes (W8-39).
    document.querySelector('#zenVerticalTabsGroup [data-l10n-id="preferences-web-appearance-footer"]')?.remove();
    // Old links to Firefox's Browser layout land on Zen's layout chooser.
    document.getElementById("zenVerticalTabsGroup")?.setAttribute("data-subcategory", "layout");
  },

  // Tab Management: a "Tabs and browsing" section after Pinned Tabs.
  insertFirefoxTabs() {
    const template = document.getElementById("template-whimsyFirefoxTabs");
    if (!template) {
      return;
    }
    // Startup and default browser also live in Firefox's Home pane, which
    // Zen hides while its URL bar replaces the new tab page. They come here
    // only then, so they're in one place either way.
    if (this.homePaneHidden) {
      ChromeUtils.importESModule("chrome://browser/content/preferences/config/home-startup.mjs", { global: "current" });
    } else {
      for (const id of ["startupHome", "defaultBrowserHome"]) {
        template.content.querySelector(`[groupid="${id}"]`)?.remove();
      }
    }
    const groups = this.takeFirefoxGroups("template-whimsyFirefoxTabs");
    this.placeFirefoxGroups(groups, document.getElementById("zenPinnedTabsManagerGroup"), "after");
  },

  get homePaneHidden() {
    return Services.prefs.getBoolPref("zen.urlbar.replace-newtab", true);
  },

  takeFirefoxGroups(templateId) {
    const template = document.getElementById(templateId);
    if (!template) {
      return null;
    }
    const fragment = template.content;
    template.remove();
    return [...fragment.children];
  },

  placeFirefoxGroups(groups, anchor, where) {
    if (anchor) {
      anchor[where](...groups);
    } else {
      document.getElementById("mainPrefPane")?.append(...groups);
    }
    for (const group of groups) {
      if (group.localName == "setting-group") {
        initSettingGroup(group.getAttribute("groupid"));
      }
    }
  },

  // Search: the Home pane's copies of Startup and Default browser stay out
  // of the results while that pane is hidden; Tab Management has them.
  hideHiddenHomeFromSearch() {
    if (!this.homePaneHidden) {
      return;
    }
    for (const group of document.querySelectorAll(
      'setting-pane[data-category="paneHome"] setting-group:is([groupid="startupHome"], [groupid="defaultBrowserHome"])'
    )) {
      group.setAttribute("data-hidden-from-search", "true");
    }
  },
});

document.addEventListener("DOMContentLoaded", () => gWhimsySettings.mergeFirefoxPanes(), { once: true });

// W11-07: Firefox's "Firefox Home" group (Search, Widgets, Shortcuts,
// Stories, Recent activity, wallpaper, logo) in Home and startup. Firefox's
// new tab add-on registers it when it hears "home-pane-loaded", which the
// Home pane sends once, when it first initializes; Firefox's search sets up
// every pane at idle right after Settings loads. The add-on starts listening
// only once Activity Stream has started, which waits for session restore,
// the terms-of-use check and Nimbus. A Settings tab that loads before that
// (a Settings tab restored at startup, which Whimsy's spaces keep) never
// gets the group, and Firefox has no second chance (bug 2051119 only stopped
// the pane from throwing). So once Activity Stream is up, if the Home pane
// is set up and the group is still missing, send the notice again; the
// pane's setting-group renders as soon as the group registers.
Object.assign(gWhimsySettings, {
  ensureFirefoxHomeGroup() {
    if (this._firefoxHomeWait || typeof SettingGroupManager != "object" || SettingGroupManager.has("home")) {
      return;
    }
    let newTab;
    try {
      newTab = ChromeUtils.importESModule("resource:///modules/AboutNewTab.sys.mjs").AboutNewTab;
    } catch (e) {
      return;
    }
    // Not started yet: the next paneshown tries again.
    if (!newTab.activityStreamPromise) {
      return;
    }
    this._firefoxHomeWait = newTab.activityStreamPromise
      .then(() => {
        // ActivityStream.init() runs right after the promise resolves; this
        // callback comes after it, with its feeds (and their observers) set up.
        if (window.closed || SettingGroupManager.has("home")) {
          return;
        }
        const pane = document.querySelector('setting-pane[data-category="paneHome"]');
        if (pane?.initialized) {
          Services.obs.notifyObservers(window, "home-pane-loaded");
        }
      })
      .catch(e => console.error("Whimsy settings: Firefox Home group", e))
      .finally(() => {
        this._firefoxHomeWait = null;
      });
  },
});

document.addEventListener("paneshown", event => {
  if (event.detail.category == "paneHome") {
    gWhimsySettings.ensureFirefoxHomeGroup();
  }
});

// wave7/teach: Tips ("Show tips", Teach once). wave9/designfix (H2): in
// Look and Feel, after Whimsy's Look group. It was in General, after
// Firefox's Browsing group, but the settings redesign hides General, which
// left tips with no reachable switch. insertAllForSearch adds it too.
document.addEventListener("paneshown", event => {
  if (event.detail.category == "paneZenLooks") {
    gWhimsySettings.insertTeachGroup();
  }
});

Object.assign(gWhimsySettings, {
  insertTeachGroup() {
    const template = document.getElementById("template-whimsyTeach");
    if (!template) {
      return;
    }
    const group = template.content.firstElementChild;
    template.remove();
    if (!Services.prefs.getBoolPref("whimsy.feature.teach-once", true)) {
      return;
    }
    Preferences.addAll([{ id: "whimsy.teach.enabled", type: "bool" }]);
    const anchor = document.getElementById("whimsyLookGroup");
    if (anchor) {
      anchor.after(group);
    } else {
      document.getElementById("mainPrefPane").append(group);
    }
    group.hidden = false;
    Preferences.queueUpdateOfAllElements();
  },
});

// wave7/menuprefs: Settings → Menus. Every right-click menu, each item a
// switch (on = it shows), in the menu's own order with a hairline where
// the menu has a separator; Restore Defaults per menu; a note when every
// item of a menu is off (that menu then doesn't open). The list comes from
// WhimsyMenuPrefs, so a row added there shows up here. Registered like
// Links (register_module before init_all), so about:preferences#whimsyMenus
// opens it and Settings search finds it.
const WHIMSY_MENUS_PANE = "paneWhimsyMenus";
// W10-21: the menu shown last in Settings → Menus (not synced).
const WHIMSY_MENUS_LAST_PREF = "whimsy.menus.settings-last";
// W10-21: the menu list's two groups, by where you right-click.
const WHIMSY_MENUS_NAV = [
  ["whimsy-menus-nav-sidebar", ["tab", "essential", "space", "folder", "sidebar", "split-row", "split-pane"]],
  ["whimsy-menus-nav-page", ["page", "link", "selection", "image", "media"]],
];

Object.assign(gWhimsySettings, {
  get menuPrefs() {
    return ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMenuPrefs.sys.mjs").WhimsyMenuPrefs;
  },

  registerMenusPane() {
    if (
      typeof register_module != "function" ||
      document.getElementById("category-whimsy-menus") ||
      !this.lazy.Whimsy.featureEnabled("menu-prefs")
    ) {
      return;
    }
    const after =
      document.getElementById("category-whimsy-links") || document.getElementById("category-zen-tabs-management");
    if (!after) {
      return;
    }
    const button = document.createElementNS("http://www.w3.org/1999/xhtml", "moz-page-nav-button");
    button.id = "category-whimsy-menus";
    button.setAttribute("view", WHIMSY_MENUS_PANE);
    button.setAttribute("iconsrc", "chrome://browser/skin/zen-icons/menu.svg");
    button.setAttribute("data-l10n-id", "whimsy-pane-menus-title");
    after.after(button);
    register_module(WHIMSY_MENUS_PANE, { init: () => this.buildMenusPane() });
  },

  // W10-21: one card. On the left, the menus (grouped by where you
  // right-click), each with how many of its rows show; on the right, the
  // chosen menu's rows in the menu's real order, a checkbox each, with the
  // menu's separators drawn in the same box so every edge lines up. A
  // submenu's rows sit indented under it. Narrow Settings: the list turns
  // into a menu picker above the rows. The chosen menu is remembered.
  buildMenusPane() {
    if (document.getElementById("whimsyMenusCategory")) {
      return;
    }
    const pane = document.getElementById("mainPrefPane");
    if (!pane) {
      return;
    }
    const prefs = this.menuPrefs;
    const html = tag => document.createElementNS("http://www.w3.org/1999/xhtml", tag);

    // The pane's title, and one line on what it does.
    const header = document.createXULElement("hbox");
    header.id = "whimsyMenusCategory";
    // Not .subcategory: Settings search always hides those, and searching
    // "Menus" should find this pane by its title.
    header.className = "whimsy-menus-header";
    header.setAttribute("data-category", WHIMSY_MENUS_PANE);
    header.hidden = true;
    const title = html("h1");
    document.l10n.setAttributes(title, "whimsy-menus-title");
    const intro = document.createXULElement("description");
    intro.id = "whimsyMenusIntro";
    intro.className = "description-deemphasized";
    document.l10n.setAttributes(intro, "whimsy-menus-intro");
    header.append(title, intro);

    const menus = prefs.menus.filter(menu => prefs.available(menu));
    const group = document.createXULElement("groupbox");
    group.id = "whimsyMenusGroup";
    group.className = "highlighting-group whimsy-menus-group";
    group.setAttribute("data-category", WHIMSY_MENUS_PANE);
    // The old per-menu anchors (#whimsyMenus-tab, …) still land here.
    group.setAttribute("data-subcategory", menus.map(menu => menu.id).join(" "));
    group.hidden = true;

    const card = html("div");
    card.className = "whimsy-menus-card";

    const nav = html("div");
    nav.className = "whimsy-menus-nav";
    nav.setAttribute("role", "listbox");
    document.l10n.setAttributes(nav, "whimsy-menus-nav");
    const picker = document.createXULElement("menulist");
    picker.id = "whimsyMenusPicker";
    picker.className = "whimsy-menus-picker";
    picker.setAttribute("sizetopopup", "none");
    document.l10n.setAttributes(picker, "whimsy-menus-nav");
    const pickerPopup = document.createXULElement("menupopup");
    picker.append(pickerPopup);

    const details = html("div");
    details.className = "whimsy-menus-details";
    details.append(picker);

    const addMenu = menu => {
      const option = html("div");
      option.id = `whimsyMenusNav-${menu.id}`;
      option.className = "whimsy-menus-nav-item";
      option.dataset.menu = menu.id;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      option.setAttribute("aria-controls", `whimsyMenus-${menu.id}`);
      option.tabIndex = -1;
      const name = html("span");
      name.className = "whimsy-menus-nav-name";
      document.l10n.setAttributes(name, menu.l10n);
      const count = html("span");
      count.className = "whimsy-menus-nav-count";
      option.append(name, count);
      option.addEventListener("click", () => this.selectMenu(menu.id, { focus: true }));
      nav.append(option);

      const item = document.createXULElement("menuitem");
      item.setAttribute("value", menu.id);
      item.dataset.l10nName = menu.l10n;
      pickerPopup.append(item);

      details.append(this.buildMenuGroup(menu));
    };
    const placed = new Set();
    for (const [heading, ids] of WHIMSY_MENUS_NAV) {
      const inGroup = ids.map(id => menus.find(menu => menu.id == id)).filter(Boolean);
      if (!inGroup.length) {
        continue;
      }
      const label = html("div");
      label.className = "whimsy-menus-nav-heading";
      label.setAttribute("role", "presentation");
      document.l10n.setAttributes(label, heading);
      nav.append(label);
      for (const menu of inGroup) {
        addMenu(menu);
        placed.add(menu.id);
      }
    }
    // A menu added to the registry but not to the list's groups goes last,
    // so nothing is ever unreachable.
    for (const menu of menus.filter(m => !placed.has(m.id))) {
      addMenu(menu);
    }

    // A listbox: Up/Down (and Home/End) move and show that menu.
    nav.addEventListener("keydown", event => {
      const options = [...nav.querySelectorAll(".whimsy-menus-nav-item")];
      const index = options.indexOf(event.target.closest?.(".whimsy-menus-nav-item"));
      if (index == -1 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      const next = {
        ArrowDown: Math.min(index + 1, options.length - 1),
        ArrowUp: Math.max(index - 1, 0),
        Home: 0,
        End: options.length - 1,
      }[event.key];
      if (next === undefined) {
        return;
      }
      event.preventDefault();
      this.selectMenu(options[next].dataset.menu, { focus: true });
    });
    picker.addEventListener("command", () => this.selectMenu(picker.value));

    const layout = html("div");
    layout.className = "whimsy-menus-layout";
    layout.append(nav, details);
    card.append(layout);
    group.append(card);
    pane.append(header, group);
    // The list's counts: its rows only exist now (each menu's detail was
    // filled in before the list was in the page).
    for (const detail of details.querySelectorAll(":scope > [data-menu]")) {
      this.refreshMenuGroup(detail);
    }

    // The picker's rows read the menus' names (menuitems take a label, not
    // text, so they're formatted here).
    document.l10n
      .formatValues([...pickerPopup.children].map(item => ({ id: item.dataset.l10nName })))
      .then(names => {
        [...pickerPopup.children].forEach((item, i) => item.setAttribute("label", names[i]));
      })
      .catch(console.error);

    const last = Services.prefs.getStringPref(WHIMSY_MENUS_LAST_PREF, "");
    this.selectMenu(menus.some(menu => menu.id == last) ? last : menus[0]?.id, { remember: false });

    const observer = {
      observe: (subject, topic, pref) => {
        const id = pref.slice(prefs.prefName("").length);
        const detail = document.getElementById(`whimsyMenus-${id}`);
        if (detail) {
          this.refreshMenuGroup(detail);
        }
      },
    };
    Services.prefs.addObserver(prefs.prefName(""), observer);
    window.addEventListener("unload", () => Services.prefs.removeObserver(prefs.prefName(""), observer), {
      once: true,
    });
    // about:preferences#whimsyMenus-<menu> opens on that menu.
    document.addEventListener("paneshown", event => {
      const { category, subcategory } = event.detail ?? {};
      if (category == WHIMSY_MENUS_PANE && subcategory && document.getElementById(`whimsyMenus-${subcategory}`)) {
        this.selectMenu(subcategory);
      }
    });
    // A search that finds a row shows the menu it's in.
    window.addEventListener("PreferencesSearchCompleted", event => {
      if (event.detail && !group.classList.contains("visually-hidden")) {
        this.selectMenuForQuery(event.detail);
      }
    });
    const hash = document.location.hash.match(/^#whimsyMenus-(.+)$/);
    if (hash && document.getElementById(`whimsyMenus-${hash[1]}`)) {
      this.selectMenu(hash[1], { remember: false });
    }
  },

  // Shows one menu's rows. `focus` moves the keyboard to its list entry
  // (selection follows focus, as in a listbox).
  selectMenu(menuId, { focus = false, remember = true } = {}) {
    const detail = document.getElementById(`whimsyMenus-${menuId}`);
    if (!detail) {
      return;
    }
    for (const option of document.querySelectorAll(".whimsy-menus-nav-item")) {
      const selected = option.dataset.menu == menuId;
      option.setAttribute("aria-selected", selected);
      option.tabIndex = selected ? 0 : -1;
      if (selected && focus) {
        option.focus();
      }
    }
    // Not `hidden`: Firefox's search skips hidden nodes, and every menu's
    // rows must stay searchable.
    for (const panel of document.querySelectorAll(".whimsy-menus-detail")) {
      panel.toggleAttribute("data-inactive", panel != detail);
    }
    const picker = document.getElementById("whimsyMenusPicker");
    if (picker && picker.value != menuId) {
      picker.value = menuId;
    }
    document.querySelector(".whimsy-menus-nav")?.setAttribute("aria-activedescendant", `whimsyMenusNav-${menuId}`);
    if (remember) {
      Services.prefs.setStringPref(WHIMSY_MENUS_LAST_PREF, menuId);
    }
  },

  // W10-21/W10-22: a search that matches a row's name shows the menu that
  // row is in. Returns that menu's id (or null).
  selectMenuForQuery(query) {
    const needle = query?.trim().toLowerCase();
    if (!needle) {
      return null;
    }
    const current = document.querySelector(".whimsy-menus-detail:not([data-inactive])");
    const panels = [current, ...document.querySelectorAll(".whimsy-menus-detail")].filter(Boolean);
    // A row whose own name matches the query exactly (e.g. "Live Folder")
    // wins over one where it's only part of a longer name in another menu
    // (e.g. "Live Folder Options"); only then fall back to any match.
    for (const matches of [(lower) => lower == needle, (lower) => lower?.includes(needle)]) {
      for (const panel of panels) {
        const hit = [...panel.querySelectorAll(".whimsy-menus-row")].find(row =>
          [".whimsy-menus-row-label", ".whimsy-menus-row-hint", ".whimsy-menus-row-alt"].map(sel => row.querySelector(sel)?.textContent)
            .some(text => matches(text?.toLowerCase()))
        );
        if (hit) {
          this.selectMenu(panel.dataset.menu, { remember: false });
          return panel.dataset.menu;
        }
      }
    }
    return null;
  },

  buildMenuGroup(menu) {
    const prefs = this.menuPrefs;
    const html = tag => document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    const base = `whimsyMenus-${menu.id}`;

    const detail = html("div");
    detail.id = base;
    detail.className = "whimsy-menus-detail";
    detail.dataset.menu = menu.id;
    detail.setAttribute("role", "tabpanel");
    detail.setAttribute("aria-labelledby", `whimsyMenusNav-${menu.id}`);
    detail.setAttribute("data-inactive", "");

    const heading = html("h3");
    heading.id = `${base}-header`;
    heading.className = "whimsy-menus-detail-title";
    document.l10n.setAttributes(heading, menu.l10n);
    const description = document.createXULElement("description");
    description.id = `${base}-description`;
    description.className = "description-deemphasized";
    document.l10n.setAttributes(description, `${menu.l10n}-description`);

    // Filled only while every row is off; a live region, so turning the
    // last one off is announced.
    const note = html("div");
    note.id = `${base}-note`;
    note.className = "whimsy-menus-note";
    note.setAttribute("role", "status");

    // Rows, separators and submenu rows share one grid, so checkboxes,
    // names, hints and separator lines all meet the same edges.
    const rows = html("div");
    rows.className = "whimsy-menus-rows";
    rows.setAttribute("role", "group");
    rows.setAttribute("aria-labelledby", heading.id);
    const labels = [];
    // W13 F06 (wave12 F06, option A): a submenu's rows fold out under its
    // row. The row gets a disclosure chevron and "2 of 3 on"; its rows sit
    // in a box under it (collapsed at first), indented past a hairline.
    // Every row has the chevron's column, so the names line up.
    const addRow = (entry, parent = null, into = rows) => {
      const row = html("label");
      row.className = "whimsy-menus-row";
      row.dataset.item = entry.id;
      if (parent) {
        row.classList.add("whimsy-menus-row-child");
        row.dataset.parent = parent.id;
      }
      const box = html("input");
      box.type = "checkbox";
      box.className = "whimsy-menus-check";
      box.dataset.item = entry.id;
      box.addEventListener("change", () => prefs.setHidden(menu.id, entry.id, !box.checked));
      const name = html("span");
      name.className = "whimsy-menus-row-label";
      name.id = `${base}-row-${entry.id}`;
      labels.push({ node: name, entry });
      const chevron = html("span");
      chevron.className = "whimsy-menus-chevron-slot";
      row.append(box, chevron, name);
      // A row whose menu label flips (Pin Tab / Unpin Tab): the other label.
      if (entry.altL10n) {
        const alt = html("span");
        alt.className = "whimsy-menus-row-alt";
        alt.id = `${base}-alt-${entry.id}`;
        document.l10n.setAttributes(alt, entry.altL10n);
        row.append(alt);
        box.setAttribute("aria-describedby", alt.id);
      }
      if (entry.hintL10n) {
        const hint = html("span");
        hint.className = "whimsy-menus-row-hint";
        document.l10n.setAttributes(hint, entry.hintL10n);
        row.append(hint);
        box.setAttribute("aria-describedby", hint.id = `${base}-hint-${entry.id}`);
      }
      into.append(row);
      return row;
    };
    const addSubmenu = (entry, row) => {
      const kids = html("div");
      kids.className = "whimsy-menus-kids";
      kids.id = `${base}-kids-${entry.id}`;
      kids.setAttribute("role", "group");
      kids.setAttribute("aria-labelledby", `${base}-row-${entry.id}`);
      kids.hidden = true;
      for (const child of entry.children) {
        if (!prefs.isSeparator(child)) {
          addRow(child, entry, kids);
        }
      }
      // A button inside the label: clicking it never toggles the checkbox.
      const disclose = html("button");
      disclose.type = "button";
      disclose.className = "whimsy-menus-disclose";
      disclose.setAttribute("aria-expanded", "false");
      disclose.setAttribute("aria-controls", kids.id);
      document.l10n.setAttributes(disclose, "whimsy-menus-disclose");
      disclose.addEventListener("click", event => {
        event.preventDefault();
        this.setMenuKidsOpen(row, kids.hidden);
      });
      row.querySelector(".whimsy-menus-chevron-slot").replaceWith(disclose);
      const count = html("span");
      count.className = "whimsy-menus-kids-count";
      row.classList.add("whimsy-menus-row-parent");
      row.querySelector(".whimsy-menus-row-label").after(count);
      rows.append(kids);
    };
    const addSeparator = () => {
      const last = rows.lastElementChild;
      if (last && !last.classList.contains("whimsy-menus-sep")) {
        const sep = html("div");
        sep.className = "whimsy-menus-sep";
        sep.setAttribute("aria-hidden", "true");
        rows.append(sep);
      }
    };
    for (const entry of prefs.groupedItems(menu.id)) {
      if (prefs.isSeparator(entry)) {
        addSeparator();
        continue;
      }
      const row = addRow(entry);
      if (entry.children?.some(child => !prefs.isSeparator(child))) {
        addSubmenu(entry, row);
      }
    }
    if (rows.lastElementChild?.classList.contains("whimsy-menus-sep")) {
      rows.lastElementChild.remove();
    }
    // A row's name is its menu row's own wording (".label" messages).
    document.l10n
      .formatMessages(labels.map(({ entry }) => ({ id: entry.l10n, args: this.menuRowArgs(entry) })))
      .then(messages => {
        labels.forEach(({ node }, i) => {
          const message = messages[i];
          node.textContent = message?.value ?? message?.attributes?.find(a => a.name == "label")?.value ?? "";
        });
      })
      .catch(console.error);

    // Up/Down (and Home/End) move between the checkboxes, as in a list; Tab
    // still visits each one.
    rows.addEventListener("keydown", event => {
      const boxes = [...rows.querySelectorAll(".whimsy-menus-check")].filter(box => !box.closest("[hidden]"));
      const index = boxes.indexOf(event.target);
      if (index == -1 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      // Right opens a submenu's rows, Left closes them (from a child: goes
      // back to its row), as in a tree.
      const row = event.target.closest(".whimsy-menus-row");
      const rtl = document.dir == "rtl";
      const open = event.key == (rtl ? "ArrowLeft" : "ArrowRight");
      const close = event.key == (rtl ? "ArrowRight" : "ArrowLeft");
      if (open && row.classList.contains("whimsy-menus-row-parent")) {
        event.preventDefault();
        this.setMenuKidsOpen(row, true);
        return;
      }
      if (close) {
        const parentRow = row.classList.contains("whimsy-menus-row-parent")
          ? row
          : row.closest(".whimsy-menus-kids")?.previousElementSibling;
        if (parentRow?.classList.contains("whimsy-menus-row-parent")) {
          event.preventDefault();
          if (parentRow != row) {
            parentRow.querySelector(".whimsy-menus-check").focus();
          }
          this.setMenuKidsOpen(parentRow, false);
        }
        return;
      }
      const next = {
        ArrowDown: Math.min(index + 1, boxes.length - 1),
        ArrowUp: Math.max(index - 1, 0),
        Home: 0,
        End: boxes.length - 1,
      }[event.key];
      if (next === undefined) {
        return;
      }
      event.preventDefault();
      boxes[next].focus();
    });

    const foot = html("div");
    foot.className = "whimsy-menus-foot";
    const count = html("span");
    count.className = "whimsy-menus-count";
    const restore = document.createXULElement("button");
    restore.id = `${base}-restore`;
    restore.className = "whimsy-menus-restore";
    document.l10n.setAttributes(restore, "whimsy-menus-restore");
    // "Restore Defaults, Tab": which menu it restores.
    restore.setAttribute("aria-describedby", heading.id);
    restore.addEventListener("command", () => {
      prefs.restoreDefaults(menu.id);
      // Focus stays in the menu (the button is now disabled).
      rows.querySelector(".whimsy-menus-check")?.focus();
    });
    foot.append(count, restore);

    detail.append(heading, description, note, rows, foot);
    this.refreshMenuGroup(detail);
    return detail;
  },

  // W13 F06: opens or closes a submenu row's rows.
  setMenuKidsOpen(row, open) {
    const kids = row?.nextElementSibling;
    if (!kids?.classList.contains("whimsy-menus-kids")) {
      return;
    }
    kids.hidden = !open;
    row.toggleAttribute("data-open", open);
    row.querySelector(".whimsy-menus-disclose")?.setAttribute("aria-expanded", String(open));
  },

  // W10-20: rows whose name has a part only known here ("Email with Mail").
  menuRowArgs(row) {
    if (row.l10nArgs == "mail-app") {
      const { WhimsyVerbs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVerbs.sys.mjs");
      return { app: WhimsyVerbs.mailAppName() };
    }
    return undefined;
  },

  // How many of the menu's rows show (a submenu's rows only while it does).
  menuCounts(menuId) {
    const prefs = this.menuPrefs;
    const hidden = prefs.hiddenIds(menuId);
    const items = prefs.items(menuId);
    const shown = items.filter(entry => {
      const parent = prefs.parentOf(menuId, entry.id);
      return !hidden.has(entry.id) && !(parent && hidden.has(parent.id));
    }).length;
    return { shown, total: items.length };
  },

  refreshMenuGroup(detail) {
    const prefs = this.menuPrefs;
    const menuId = detail.dataset.menu;
    const hidden = prefs.hiddenIds(menuId);
    for (const row of detail.querySelectorAll(".whimsy-menus-row")) {
      const box = row.querySelector(".whimsy-menus-check");
      box.checked = !hidden.has(row.dataset.item);
      // A submenu's rows can't show while it's off: disabled, not unchecked.
      box.disabled = !!row.dataset.parent && hidden.has(row.dataset.parent);
      row.toggleAttribute("data-off", !box.checked || box.disabled);
    }
    // A submenu row: how many of its rows are on.
    for (const row of detail.querySelectorAll(".whimsy-menus-row-parent")) {
      const children = prefs.items(menuId).filter(entry => prefs.parentOf(menuId, entry.id)?.id == row.dataset.item);
      document.l10n.setAttributes(row.querySelector(".whimsy-menus-kids-count"), "whimsy-menus-kids-count", {
        shown: children.filter(entry => !hidden.has(entry.id)).length,
        total: children.length,
      });
    }
    detail.querySelector(".whimsy-menus-restore").disabled = prefs.isDefault(menuId);
    const { shown, total } = this.menuCounts(menuId);
    document.l10n.setAttributes(detail.querySelector(".whimsy-menus-count"), "whimsy-menus-count", { shown, total });
    const allOff = prefs.allHidden(menuId);
    const navCount = document.querySelector(`#whimsyMenusNav-${CSS.escape(menuId)} .whimsy-menus-nav-count`);
    if (navCount) {
      if (allOff) {
        document.l10n.setAttributes(navCount, "whimsy-menus-nav-off");
      } else {
        document.l10n.setAttributes(navCount, "whimsy-menus-nav-count", { shown, total });
      }
      navCount.closest(".whimsy-menus-nav-item").toggleAttribute("data-all-off", allOff);
    }
    const note = detail.querySelector(".whimsy-menus-note");
    if (allOff) {
      if (note.getAttribute("data-l10n-id") != "whimsy-menus-all-off") {
        document.l10n.setAttributes(note, "whimsy-menus-all-off");
      }
    } else if (note.hasAttribute("data-l10n-id")) {
      note.removeAttribute("data-l10n-id");
      note.textContent = "";
    }
  },
});

document.addEventListener("DOMContentLoaded", () => gWhimsySettings.registerMenusPane(), { once: true });

// wave9: Battery Saver's switch sits right after Performance (Firefox's group,
// or Whimsy's Hardware video decoding below it). With the settings redesign
// that is Tab Management; General is hidden there (review design-full-5 H2).
Object.assign(gWhimsySettings, {
  insertBatterySaverGroup(category = "paneGeneral") {
    const template = document.getElementById("template-whimsyBatterySaver");
    if (!template) {
      const group = document.getElementById("whimsyBatterySaverGroup");
      if (group) {
        group.dataset.category = category;
        group.hidden = false;
      }
      return;
    }
    const group = template.content.firstElementChild;
    template.remove();
    if (!Services.prefs.getBoolPref("whimsy.feature.battery-saver", true)) {
      return;
    }
    Preferences.addAll([{ id: "whimsy.battery-saver.enabled", type: "bool" }]);
    const anchor =
      document.getElementById("whimsyPerformanceGroup") || document.querySelector('[groupid="performance"]');
    group.dataset.category = category;
    if (anchor) {
      anchor.after(group);
    } else {
      document.getElementById("mainPrefPane").append(group);
    }
    group.hidden = false;
    Preferences.queueUpdateOfAllElements();
  },
});
document.addEventListener("paneshown", event => {
  if (["paneGeneral", "paneZenTabManagement"].includes(event.detail.category)) {
    gWhimsySettings.insertBatterySaverGroup(event.detail.category);
  }
});

// W10-22: Settings search shows where the hit is. Firefox reveals whole
// groups (Whimsy's Tabs group has 30-odd rows), and its highlight can't
// reach a XUL checkbox's label or a `searchkeywords` match, so the matching
// row was impossible to spot ("trails"). After each search, in every group
// it revealed: the matching rows get a tinted box; when a row matched only
// a keyword, a "Matches “Trails”" tag says why; a group with three or more
// rows folds the others into one "Show 26 more in Whimsy tabs" button; a
// breadcrumb ("Tab Management › Whimsy tabs") with "Show in …" leads to the
// row in its pane. A count line says how many settings match where, the
// first hit scrolls into view, and Return in the search field moves
// between hits (Shift+Return back).
const WHIMSY_SEARCH_CONTROLS =
  "checkbox, moz-checkbox, moz-toggle, moz-select, moz-radio-group, menulist, radiogroup, input, textarea, button, select, [data-whimsy-row]";

Object.assign(gWhimsySettings, {
  searchState: null,

  initSearchAssist() {
    if (this._searchAssist || typeof gSearchResultsPane != "object") {
      return;
    }
    this._searchAssist = true;
    window.addEventListener("PreferencesSearchCompleted", event => {
      try {
        this.decorateSearch(event.detail ?? "");
      } catch (e) {
        console.error("Whimsy settings: search results", e);
      }
    });
    // Leaving the results (a pane in the sidebar, Show in …) clears them.
    document.addEventListener("paneshown", event => {
      if (event.detail?.category != "paneSearchResults") {
        this.clearSearchDecorations();
      }
    });
    const input = document.getElementById("searchInput");
    input?.addEventListener("keydown", event => {
      if (event.key == "Enter" && !event.altKey && !event.metaKey && !event.ctrlKey && this.searchState?.hits.length) {
        event.preventDefault();
        this.focusNextHit(event.shiftKey ? -1 : 1);
      }
    });
    // W10-22: from a hit's control, Return goes on to the next hit (and
    // Shift+Return back), as it does from the search field. Text fields
    // keep their own Return.
    document.addEventListener("keydown", event => {
      const state = this.searchState;
      if (event.key != "Enter" || event.altKey || event.metaKey || event.ctrlKey || !state?.hits.length) {
        return;
      }
      const target = event.target;
      if (target == input || target.closest?.("input:not([type=checkbox]):not([type=radio]), textarea, menulist[open]")) {
        return;
      }
      if (!state.hits[state.index]?.contains(target)) {
        return;
      }
      event.preventDefault();
      this.focusNextHit(event.shiftKey ? -1 : 1);
    }, true);
  },

  get reduceMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  },

  // The groups Firefox's search left showing.
  revealedGroups() {
    const pane = document.getElementById("mainPrefPane");
    return [...(pane?.children ?? [])].filter(
      el =>
        el.dataset.category &&
        el.dataset.category != "paneSearchResults" &&
        !el.hidden &&
        !el.classList.contains("visually-hidden") &&
        (el.localName == "groupbox" || el.classList.contains("whimsy-setting-card") || el.id == "whimsyAIPage")
    );
  },

  // A group's rows: each child (of the group, its fieldset, or an
  // On-demand features <details>) that holds a setting. A note right
  // under a row goes with that row.
  searchRows(group) {
    if (group.id == "whimsyMenusGroup") {
      // The menu a hit is in is shown (W10-21); its rows are the rows.
      this.selectMenuForQuery(this.searchState?.query);
      // A row's words (its name, other label and hint), not its submenu
      // count or the chevron's label.
      return [...group.querySelectorAll(".whimsy-menus-detail:not([data-inactive]) .whimsy-menus-row")].map(row => ({
        nodes: [...row.querySelectorAll(".whimsy-menus-row-label, .whimsy-menus-row-alt, .whimsy-menus-row-hint")],
        main: row,
      }));
    }
    // W23: Settings › AI is one page; each row, fact, and switch is a row.
    if (group.id == "whimsyAIPage") {
      return [...group.querySelectorAll(".whimsy-ai-item, .whimsy-ai-fact")]
        .map(row => ({ nodes: [row], main: row }))
        .filter(row => row.main.checkVisibility());
    }
    const container = group.querySelector("moz-fieldset") ?? group;
    const rows = [];
    const walk = parent => {
      for (const child of parent.children) {
        if (child.localName == "summary" || child.classList.contains("whimsy-search-added")) {
          continue;
        }
        if (child.localName == "label" && child.querySelector("h2, h3")) {
          continue;
        }
        if (child.localName == "details") {
          walk(child);
          continue;
        }
        const isRow = child.matches(WHIMSY_SEARCH_CONTROLS) || !!child.querySelector(WHIMSY_SEARCH_CONTROLS);
        if (isRow) {
          rows.push({ nodes: [child], main: child });
        } else if (rows.length && rows.at(-1).main.parentElement == parent) {
          rows.at(-1).nodes.push(child);
        }
      }
    };
    walk(container);
    return rows.filter(row => row.main.checkVisibility());
  },

  // Everything a row is found by: what it shows, its labels, and its
  // search keywords.
  searchTextOf(row) {
    const parts = [];
    for (const node of row.nodes) {
      parts.push(node.textContent);
      for (const el of [node, ...node.querySelectorAll("*")]) {
        for (const attr of ["label", "description", "searchkeywords", "aria-label"]) {
          const value = el.getAttribute?.(attr);
          if (value) {
            parts.push(value);
          }
        }
      }
    }
    return parts.join(" \n ").toLowerCase();
  },

  visibleTextOf(row) {
    const el = row.main;
    const label =
      el.getAttribute("label") ??
      el.querySelector("[label]")?.getAttribute("label") ??
      "";
    return `${label} ${el.textContent}`.toLowerCase();
  },

  // The keyword that matched, in its own casing ("Trails").
  keywordFor(row, query) {
    for (const node of row.nodes) {
      for (const el of [node, ...node.querySelectorAll("[searchkeywords]")]) {
        const keywords = el.getAttribute?.("searchkeywords");
        const at = keywords?.toLowerCase().indexOf(query) ?? -1;
        if (at != -1) {
          // The whole word around the match.
          let start = at;
          let end = at + query.length;
          while (start > 0 && /[\p{L}\p{N}-]/u.test(keywords[start - 1])) {
            start--;
          }
          while (end < keywords.length && /[\p{L}\p{N}-]/u.test(keywords[end])) {
            end++;
          }
          return keywords.slice(start, end);
        }
      }
    }
    return null;
  },

  groupName(group) {
    const heading = group.querySelector("h2, h3, .whimsy-menus-detail-title");
    // A group that is one switch with no heading (Settings → AI's Enable
    // AI) goes by the switch's name.
    const controls = group.querySelectorAll("moz-toggle, moz-checkbox, checkbox");
    return (
      heading?.textContent.trim() ||
      group.querySelector("moz-fieldset")?.getAttribute("label") ||
      (controls.length == 1 ? controls[0].getAttribute("label")?.trim() : "") ||
      ""
    );
  },

  paneName(category) {
    const button = document.querySelector(`moz-page-nav-button[view="${CSS.escape(category)}"]`);
    return button?.textContent.trim() || button?.getAttribute("label") || "";
  },

  clearSearchDecorations() {
    const state = this.searchState;
    this.searchState = null;
    for (const el of document.querySelectorAll(".whimsy-search-added")) {
      el.remove();
    }
    for (const el of document.querySelectorAll(".whimsy-search-hit, .whimsy-search-collapsed")) {
      el.classList.remove("whimsy-search-hit", "whimsy-search-collapsed");
    }
    for (const mark of document.querySelectorAll("mark.whimsy-search-mark")) {
      const parent = mark.parentNode;
      mark.replaceWith(...mark.childNodes);
      parent.normalize();
    }
    for (const details of state?.opened ?? []) {
      details.open = false;
    }
    const none = document.getElementById("no-results-message");
    none?.classList.remove("whimsy-search-none");
  },

  decorateSearch(query) {
    this.clearSearchDecorations();
    query = query.trim().toLowerCase();
    if (!query) {
      return;
    }
    const html = tag => document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    const state = { query, hits: [], opened: [], index: -1 };
    this.searchState = state;
    let count = 0;
    let places = 0;

    for (const group of this.revealedGroups()) {
      const rows = this.searchRows(group);
      const groupName = this.groupName(group);
      const headingHit = groupName.toLowerCase().includes(query);
      const hits = rows.filter(row => this.searchTextOf(row).includes(query));
      if (!hits.length) {
        // Firefox found it somewhere we don't read (a heading, a link): one
        // setting, in one place.
        count += 1;
        places += 1;
        continue;
      }
      count += hits.length;
      places += 1;

      for (const row of hits) {
        row.main.classList.add("whimsy-search-hit");
        state.hits.push(row.main);
        // In On-demand features: open it.
        const details = row.main.closest("details");
        if (details && !details.open) {
          details.open = true;
          state.opened.push(details);
        }
        // W13 F06: in a closed submenu of Settings → Menus: open it.
        const kids = row.main.closest(".whimsy-menus-kids");
        if (kids?.hidden) {
          const parentRow = kids.previousElementSibling;
          this.setMenuKidsOpen(parentRow, true);
          state.opened.push({ set open(value) { gWhimsySettings.setMenuKidsOpen(parentRow, value); } });
        }
        const keyword = !this.visibleTextOf(row).includes(query) && this.keywordFor(row, query);
        if (keyword) {
          const tag = html("span");
          tag.className = "whimsy-search-added whimsy-search-keyword";
          document.l10n.setAttributes(tag, "whimsy-search-keyword", { term: keyword });
          // Inside a XUL checkbox or an hbox row the tag sits after the
          // label; other controls draw their own content, so after them.
          if (row.main.localName == "checkbox" || row.main.localName == "hbox" || row.main.classList.contains("whimsy-menus-row")) {
            row.main.append(tag);
          } else {
            row.main.after(tag);
          }
          // Firefox's own floating bubble says the same thing; one is enough.
          for (const anchor of gSearchResultsPane.listSearchTooltips ?? []) {
            if (row.nodes.some(node => node == anchor || node.contains(anchor))) {
              anchor.tooltipNode?.remove();
              anchor.tooltipNode = null;
            }
          }
        }
        // The matched words, marked, where the name is plain text of ours
        // (Settings → Menus rows); XUL labels can't hold marks.
        const label = row.main.querySelector(".whimsy-menus-row-label");
        if (label) {
          this.markText(label, query);
        }
      }

      // Fold the rest of a long group.
      const rest = rows.filter(row => !hits.includes(row));
      if (rows.length >= 3 && rest.length && !headingHit && group.id != "whimsyMenusGroup") {
        for (const row of rest) {
          for (const node of row.nodes) {
            node.classList.add("whimsy-search-collapsed");
          }
        }
        // Folded rows' bubbles would float over the wrong rows.
        for (const anchor of gSearchResultsPane.listSearchTooltips ?? []) {
          if (anchor.tooltipNode && anchor.closest(".whimsy-search-collapsed")) {
            anchor.tooltipNode.hidden = true;
          }
        }
        // An On-demand features list with nothing left showing folds too.
        for (const details of group.querySelectorAll("details")) {
          const shown = [...details.children].some(
            child => child.localName != "summary" && !child.classList.contains("whimsy-search-collapsed")
          );
          details.classList.toggle("whimsy-search-collapsed", !shown);
        }
        const more = document.createXULElement("button");
        more.className = "whimsy-search-added whimsy-search-more";
        document.l10n.setAttributes(more, "whimsy-search-more", { count: rest.length, group: groupName || this.paneName(group.dataset.category) });
        more.addEventListener("command", () => {
          for (const el of group.querySelectorAll(".whimsy-search-collapsed")) {
            el.classList.remove("whimsy-search-collapsed");
          }
          for (const anchor of gSearchResultsPane.listSearchTooltips ?? []) {
            if (anchor.tooltipNode && group.contains(anchor)) {
              anchor.tooltipNode.hidden = false;
            }
          }
          more.remove();
          gSearchResultsPane._recomputeTooltipPositions?.();
        });
        const container = group.querySelector("moz-fieldset") ?? group;
        container.append(more);
      }

      // Where it is, and a way there.
      const crumb = document.createXULElement("hbox");
      crumb.className = "whimsy-search-added whimsy-search-crumb";
      crumb.setAttribute("align", "center");
      const where = html("span");
      where.className = "whimsy-search-crumb-path";
      const pane = html("b");
      pane.textContent = this.paneName(group.dataset.category);
      where.append(pane);
      if (groupName) {
        where.append(` › ${groupName}`);
      }
      const go = document.createXULElement("button");
      go.className = "whimsy-search-show-in text-link";
      document.l10n.setAttributes(go, "whimsy-search-show-in", { pane: pane.textContent || groupName });
      const first = hits[0].main;
      go.addEventListener("command", () => this.showInPane(group.dataset.category, first));
      crumb.append(where, go);
      group.before(crumb);
    }

    // How many, where.
    const header = document.getElementById("header-searchResults");
    if (header && count) {
      const line = html("div");
      line.className = "whimsy-search-added whimsy-search-count";
      line.setAttribute("role", "status");
      line.setAttribute("aria-live", "polite");
      document.l10n.setAttributes(line, "whimsy-search-count", { count, query, places });
      header.after(line);
    }
    // Nothing: Whimsy's words instead of Firefox's.
    const none = document.getElementById("no-results-message");
    if (none && !none.hidden) {
      none.classList.add("whimsy-search-none");
      const box = html("div");
      box.className = "whimsy-search-added whimsy-search-none-box";
      const title = html("div");
      title.className = "whimsy-search-none-title";
      document.l10n.setAttributes(title, "whimsy-search-none-title", { query });
      const hint = html("div");
      hint.className = "whimsy-search-none-hint";
      document.l10n.setAttributes(hint, "whimsy-search-none-hint");
      box.append(title, hint);
      none.append(box);
    }

    gSearchResultsPane._recomputeTooltipPositions?.();
    // The first hit, in view.
    state.hits[0]?.scrollIntoView({ block: "center", behavior: this.reduceMotion ? "instant" : "smooth" });
  },

  markText(el, query) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }
    for (const node of nodes) {
      const at = node.data.toLowerCase().indexOf(query);
      if (at == -1) {
        continue;
      }
      const match = node.splitText(at);
      match.splitText(query.length);
      const mark = document.createElementNS("http://www.w3.org/1999/xhtml", "mark");
      mark.className = "whimsy-search-mark";
      match.replaceWith(mark);
      mark.append(match);
    }
  },

  // Return / Shift+Return in the search field: the next (previous) hit's
  // control gets the keyboard.
  focusNextHit(step) {
    const state = this.searchState;
    if (!state?.hits.length) {
      return;
    }
    state.index = (state.index + step + state.hits.length) % state.hits.length;
    const hit = state.hits[state.index];
    const control = hit.matches(WHIMSY_SEARCH_CONTROLS) ? hit : hit.querySelector(WHIMSY_SEARCH_CONTROLS);
    hit.scrollIntoView({ block: "center", behavior: this.reduceMotion ? "instant" : "smooth" });
    (control ?? hit).focus();
  },

  // Show in …: leaves the results for the row's pane, scrolls the row to
  // the middle and marks it for two seconds.
  async showInPane(category, row) {
    const shown = new Promise(resolve => document.addEventListener("paneshown", resolve, { once: true }));
    gotoPref(category);
    await shown;
    // Pane changes can re-render the row's group; wait a frame.
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (!row.isConnected) {
      return;
    }
    const details = row.closest("details");
    if (details) {
      details.open = true;
    }
    if (row.classList.contains("whimsy-menus-row")) {
      this.selectMenu(row.closest(".whimsy-menus-detail")?.dataset.menu, { remember: false });
    }
    row.scrollIntoView({ block: "center", behavior: this.reduceMotion ? "instant" : "smooth" });
    row.classList.add("whimsy-search-flash");
    setTimeout(() => row.classList.remove("whimsy-search-flash"), 2000);
  },
});

document.addEventListener("DOMContentLoaded", () => gWhimsySettings.initSearchAssist(), { once: true });
