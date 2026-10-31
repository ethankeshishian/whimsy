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
      IPProtectionService: "moz-src:///toolkit/components/ipprotection/IPProtectionService.sys.mjs",
      IPProtectionStates: "moz-src:///toolkit/components/ipprotection/IPProtectionService.sys.mjs",
      IPPProxyManager: "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs",
      IPPProxyStates: "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs",
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

  insertTabsGroup() {
    const template = document.getElementById("template-whimsyTabs");
    if (!template) {
      return;
    }
    const fragment = template.content;
    const group = fragment.firstElementChild;
    for (const row of [...group.querySelectorAll("[data-whimsy-feature]")]) {
      if (!this.lazy.Whimsy.featureEnabled(row.dataset.whimsyFeature)) {
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
      "ai-kill-switch": () => this.initPrefCheckbox("whimsyBlockAI", "whimsy.ai.blocked"),
      "strip-tracking": () => this.initStripTracking(),
      // batch9p: Scratch and private tabs
      scratch: () => this.initPrefCheckbox("whimsyPrivateInWindow", "whimsy.private.in-window"),
      // tierC-vpn: VPN (Firefox's built-in IP Protection).
      vpn: () => this.initVpn(),
      // wave3: email-aliases
      "email-aliases": () => this.initPrefCheckbox("whimsyEmailAliasesButton", "whimsy.email-aliases.button"),

      // wave3: handoff. Handoff only exists on macOS.
      handoff: () =>
        AppConstants.platform == "macosx"
          ? this.initPrefCheckbox("whimsyHandoffSend", "whimsy.handoff.send")
          : document.getElementById("whimsyHandoffGroup")?.remove(),

      // wave3/ai: the AI provider picker.
      "ai-providers": () => this.initAIProviders(),
    };
    for (const group of groups) {
      const feature = group.dataset.whimsyFeature;
      if (!this.lazy.Whimsy.featureEnabled(feature)) {
        group.remove();
        continue;
      }
      group.hidden = false;
      inits[feature]?.();
    }
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
    const status = document.getElementById("whimsyVpnStatus");
    const manage = document.getElementById("whimsyVpnManage");
    if (!status || this._vpnWired) {
      return;
    }
    this._vpnWired = true;
    const { IPProtectionService, IPProtectionStates, IPPProxyManager, IPPProxyStates } = this.lazy;
    const update = () => {
      if (!Services.prefs.getBoolPref("browser.ipProtection.enabled", false)) {
        document.l10n.setAttributes(status, "whimsy-vpn-status-off");
        return;
      }
      const state = IPProtectionService.state;
      if (state == IPProtectionStates.UNAVAILABLE || state == IPProtectionStates.UNINITIALIZED) {
        document.l10n.setAttributes(status, "whimsy-vpn-status-unavailable");
      } else if (state == IPProtectionStates.UNAUTHENTICATED) {
        document.l10n.setAttributes(status, "whimsy-vpn-status-signed-out");
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
    window.addEventListener(
      "unload",
      () => {
        IPProtectionService.removeEventListener("IPProtectionService:StateChanged", update);
        IPPProxyManager.removeEventListener("IPPProxyManager:StateChanged", update);
        Services.prefs.removeObserver("browser.ipProtection.enabled", prefObserver);
      },
      { once: true }
    );
    update();
    manage?.addEventListener("command", () => {
      const win = window.browsingContext.topChromeWindow;
      this.lazy.CustomizableUI.getWidget("ipprotection-button")?.forWindow(win)?.node?.click();
    });
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
      if (!this.lazy.Whimsy.featureEnabled(row.dataset.whimsyFeature)) {
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
    this.refreshHiddenSpaces();
  },

  refreshHiddenSpaces() {
    const list = document.getElementById("whimsyHiddenSpacesList");
    const empty = document.getElementById("whimsyHiddenSpacesEmpty");
    if (!list) {
      return;
    }
    const { WhimsySpaceArchive } = this.lazy;
    const win = window.browsingContext.topChromeWindow;
    const hidden = WhimsySpaceArchive.listHidden(win);
    list.replaceChildren();
    if (empty) {
      empty.hidden = !!hidden.length;
    }
    for (const workspace of hidden) {
      const row = document.createXULElement("hbox");
      row.setAttribute("align", "center");
      row.className = "whimsy-spaces-row";
      const label = document.createXULElement("label");
      label.setAttribute("flex", "1");
      label.textContent = workspace.name || "";
      const button = document.createXULElement("button");
      document.l10n.setAttributes(button, "whimsy-restore-space-button");
      button.addEventListener("command", () => {
        WhimsySpaceArchive.restore(win, workspace.uuid);
        this.refreshHiddenSpaces();
      });
      row.append(label, button);
      list.append(row);
    }
  },
});

// tierC-claude: Settings → Privacy & Security → Claude. Its own paneshown
// listener and Object.assign, like the spaces group above.
document.addEventListener("paneshown", event => {
  if (event.detail.category == "panePrivacy") {
    gWhimsySettings.insertClaudeGroup();
  }
});

Object.assign(gWhimsySettings, {
  insertClaudeGroup() {
    const template = document.getElementById("template-whimsyClaude");
    if (!template) {
      return;
    }
    const group = template.content.firstElementChild;
    const featureOn = this.lazy.Whimsy.featureEnabled("claude-space");
    template.remove();
    if (!featureOn) {
      return;
    }
    const anchor =
      document.getElementById("whimsyPrivateGroup") ||
      document.getElementById("whimsyStripTrackingGroup");
    if (anchor) {
      anchor.after(group);
    } else {
      const before =
        document.getElementById("nonTechnicalPrivacyGroup") ||
        document.querySelector('[groupid="nonTechnicalPrivacy2"]');
      if (before) {
        before.before(group);
      } else {
        document.getElementById("mainPrefPane").append(group);
      }
    }
    group.hidden = false;
    this.initClaudeGroup();
  },

  initClaudeGroup() {
    const { WhimsyClaude } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyClaude.sys.mjs");
    this.initPrefCheckbox("whimsyClaudeEnable", "whimsy.claude.enabled");
    this.initPrefCheckbox("whimsyClaudeWholeBrowser", "whimsy.claude.whole-browser");
    this.initPrefCheckbox("whimsyClaudeAsk", "whimsy.claude.ask-per-site");
    this.initPrefCheckbox("whimsyClaudeReplay", "whimsy.claude.replay");
    const $ = id => document.getElementById(id);
    // wave5/safety: Claude runs (agent replay).
    $("whimsyClaudeShowRuns").addEventListener("command", () =>
      window.browsingContext.topChromeWindow.openTrustedLinkIn("about:whimsy?replay", "tab")
    );
    const status = $("whimsyClaudeStatus");
    const copy = value => {
      if (!value) {
        return;
      }
      Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(value);
      document.l10n.setAttributes(status, "whimsy-claude-copied");
    };
    // The command and JSON only exist while the server runs; it starts a
    // moment after the switch is turned on.
    const refresh = () => {
      const enabled = Services.prefs.getBoolPref("whimsy.claude.enabled", false);
      const blocked = Services.prefs.getBoolPref("whimsy.ai.blocked", false);
      $("whimsyClaudeAIBlocked").hidden = !blocked;
      $("whimsyClaudeEnable").disabled = blocked;
      $("whimsyClaudeWholeBrowser").disabled = !enabled || blocked;
      $("whimsyClaudeAsk").disabled = !enabled || blocked;
      const info = WhimsyClaude.connectInfo();
      $("whimsyClaudeConnect").hidden = !info;
      $("whimsyClaudeCommand").textContent = info?.command ?? "";
      $("whimsyClaudeJSON").textContent = info?.json ?? "";
    };
    $("whimsyClaudeCopyCommand").addEventListener("command", () => copy(WhimsyClaude.connectInfo()?.command));
    $("whimsyClaudeCopyJSON").addEventListener("command", () => copy(WhimsyClaude.connectInfo()?.json));
    $("whimsyClaudeNewToken").addEventListener("command", async () => {
      const button = $("whimsyClaudeNewToken");
      button.disabled = true;
      try {
        await WhimsyClaude.regenerateToken();
        document.l10n.setAttributes(status, "whimsy-claude-new-token-note");
      } catch (e) {
        console.error("Whimsy: Claude token", e);
        document.l10n.setAttributes(status, "whimsy-claude-token-error");
      } finally {
        button.disabled = false;
      }
    });
    $("whimsyClaudeForgetSites").addEventListener("command", () => WhimsyClaude.forgetSitePermissions());
    const prefs = ["whimsy.claude.enabled", "whimsy.ai.blocked"];
    for (const pref of prefs) {
      Services.prefs.addObserver(pref, refresh);
    }
    Services.obs.addObserver(refresh, "whimsy-claude-changed");
    window.addEventListener(
      "unload",
      () => {
        for (const pref of prefs) {
          Services.prefs.removeObserver(pref, refresh);
        }
        Services.obs.removeObserver(refresh, "whimsy-claude-changed");
      },
      { once: true }
    );
    // Settings may open before any browser window started the module.
    WhimsyClaude.init();
    refresh();
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
      get("whimsyMeetingApple").hidden = AppConstants.platform != "macosx";
      const status = service.appleStatus;
      const denied = ["denied", "restricted"].includes(status);
      l10n(get("whimsyMeetingAppleStatus"), denied ? "whimsy-meeting-apple-denied" :
        ["unavailable", "missing-usage-description"].includes(status) ? "whimsy-meeting-apple-unsupported" :
        status == "fullAccess" ? "whimsy-meeting-connected" : "whimsy-meeting-apple-detail");
      const connect = get("whimsyMeetingAppleConnect");
      l10n(connect, denied ? "whimsy-meeting-apple-open-settings" :
        service.appleEnabled ? "whimsy-meeting-apple-allow" : "whimsy-meeting-apple-connect");
      connect.hidden = status == "fullAccess" || status == "unavailable" || status == "missing-usage-description";
      get("whimsyMeetingAppleRemove").hidden = !service.appleEnabled;
      const list = get("whimsyMeetingGoogleAccounts");
      list.replaceChildren();
      for (const calendar of service.googleCalendars) {
        const row = document.createElement("div");
        row.className = "whimsy-calendar-row";
        const name = document.createElement("span");
        // Never show the secret URL, including for malformed saved accounts.
        if (calendar.label) {
          name.textContent = calendar.label;
        } else {
          l10n(name, "whimsy-meeting-google-title");
        }
        const detail = document.createElement("span");
        detail.className = "description-deemphasized";
        l10n(detail, service.sourceState("google:" + calendar.id)?.error ?
          "whimsy-meeting-google-error" : "whimsy-meeting-connected");
        const remove = document.createElement("button");
        remove.type = "button";
        remove.disabled = !service.enabled;
        l10n(remove, "whimsy-meeting-disconnect");
        remove.addEventListener("click", () => service.removeGoogleCalendar(calendar.id));
        row.append(name, detail, remove);
        list.append(row);
      }
    };
    for (const [id, pref] of [
      ["whimsyNextMeetingEnabled", "whimsy.feature.next-meeting"],
      ["whimsyNextMeetingCard", "whimsy.next-meeting.sidebar-card"],
    ]) {
      get(id).addEventListener("change", event => Services.prefs.setBoolPref(pref, event.target.checked));
    }
    get("whimsyMeetingAppleConnect").addEventListener("click", () => {
      if (["denied", "restricted"].includes(service.appleStatus)) {
        const uri = Services.io.newURI("x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars");
        Cc["@mozilla.org/uriloader/external-protocol-service;1"]
          .getService(Ci.nsIExternalProtocolService).loadURI(uri);
      } else if (service.appleEnabled) {
        service.requestAppleAccess();
      } else {
        service.setAppleEnabled(true);
      }
    });
    get("whimsyMeetingAppleRemove").addEventListener("click", () => service.setAppleEnabled(false));
    get("whimsyMeetingGoogleForm").addEventListener("submit", event => {
      event.preventDefault();
      const input = get("whimsyMeetingGoogleURL");
      const valid = service.addGoogleCalendar(input.value);
      get("whimsyMeetingGoogleError").hidden = valid;
      input.setAttribute("aria-invalid", String(!valid));
      if (valid) {
        input.value = "";
      }
      input.focus();
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
    if (!this.lazy.Whimsy.featureEnabled("space-extensions")) {
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

// wave3/ai: Settings → Privacy & Security → AI provider. Apple on-device,
// Claude (API key) or Ollama; the card hides while the AI kill switch is on.
// The Claude key goes straight to OSKeyStore (WhimsyAIProviders) and is
// never shown again or written to a pref.
Object.assign(gWhimsySettings, {
  initAIProviders() {
    const group = document.getElementById("whimsyAIProvidersGroup");
    const picker = document.getElementById("whimsyAIProvider");
    if (!group || !picker || this._aiProvidersWired) {
      return;
    }
    this._aiProvidersWired = true;
    const { WhimsyAIProviders } = ChromeUtils.importESModule(
      "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs"
    );
    Preferences.addAll([{ id: "whimsy.ai.provider", type: "string" }]);
    const rows = {
      apple: document.getElementById("whimsyAIAppleRow"),
      claude: document.getElementById("whimsyAIClaudeRow"),
      ollama: document.getElementById("whimsyAIOllamaRow"),
    };
    const setStatus = (id, l10nId, args) => {
      const el = document.getElementById(id);
      if (el) {
        document.l10n.setAttributes(el, l10nId, args);
      }
    };

    // Apple: connecting builds a small helper once (a minute or so), so it
    // only happens when the person clicks Set Up.
    const appleButton = document.getElementById("whimsyAIAppleCheck");
    const checkApple = async ({ build }) => {
      setStatus("whimsyAIAppleStatus", "whimsy-ai-apple-status-checking");
      appleButton.disabled = true;
      const status = await WhimsyAIProviders.appleStatus({ build });
      appleButton.disabled = false;
      setStatus("whimsyAIAppleStatus", `whimsy-ai-apple-status-${status}`);
      document.l10n.setAttributes(
        appleButton,
        status == "not-set-up" ? "whimsy-ai-apple-set-up" : "whimsy-ai-apple-check"
      );
    };
    appleButton?.addEventListener("command", () => checkApple({ build: true }));

    // Claude: the key field stays empty; the status says whether one is saved.
    const keyInput = document.getElementById("whimsyAIClaudeKey");
    const showKeyStatus = async () => {
      const saved = await WhimsyAIProviders.hasClaudeKey();
      setStatus("whimsyAIClaudeStatus", saved ? "whimsy-ai-claude-key-saved" : "whimsy-ai-claude-key-missing");
      document.getElementById("whimsyAIClaudeRemove").disabled = !saved;
    };
    document.getElementById("whimsyAIClaudeSave")?.addEventListener("command", async () => {
      if (!keyInput.value.trim()) {
        return;
      }
      try {
        await WhimsyAIProviders.setClaudeKey(keyInput.value);
        keyInput.value = "";
      } catch (error) {
        console.error("Whimsy: saving the Claude API key failed", error);
        setStatus("whimsyAIClaudeStatus", "whimsy-ai-claude-key-error");
        return;
      }
      showKeyStatus();
    });
    keyInput?.addEventListener("keydown", event => {
      if (event.key == "Enter") {
        document.getElementById("whimsyAIClaudeSave")?.doCommand?.();
      }
    });
    document.getElementById("whimsyAIClaudeRemove")?.addEventListener("command", async () => {
      await WhimsyAIProviders.setClaudeKey("");
      showKeyStatus();
    });

    // Ollama: the server address and one of its models.
    const endpoint = document.getElementById("whimsyAIOllamaEndpoint");
    const modelList = document.getElementById("whimsyAIOllamaModel");
    endpoint.value = Services.prefs.getStringPref("whimsy.ai.ollama.endpoint", "");
    endpoint.addEventListener("change", () => {
      Services.prefs.setStringPref("whimsy.ai.ollama.endpoint", endpoint.value.trim());
      loadOllamaModels();
    });
    modelList.addEventListener("command", () => {
      Services.prefs.setStringPref("whimsy.ai.ollama.model", modelList.value || "");
    });
    const loadOllamaModels = async () => {
      const current = Services.prefs.getStringPref("whimsy.ai.ollama.model", "");
      modelList.removeAllItems();
      let models = [];
      try {
        models = await WhimsyAIProviders.ollamaModels();
      } catch {
        setStatus("whimsyAIOllamaStatus", "whimsy-ai-ollama-status-offline");
      }
      for (const name of new Set([...models, ...(current ? [current] : [])])) {
        modelList.appendItem(name, name);
      }
      modelList.disabled = !modelList.itemCount;
      if (current) {
        modelList.value = current;
      } else if (models.length) {
        modelList.selectedIndex = 0;
        Services.prefs.setStringPref("whimsy.ai.ollama.model", models[0]);
      }
      if (models.length) {
        setStatus("whimsyAIOllamaStatus", "whimsy-ai-ollama-status-ready", { count: models.length });
      } else if (!modelList.disabled || !current) {
        setStatus("whimsyAIOllamaStatus", "whimsy-ai-ollama-status-offline");
      }
    };
    document.getElementById("whimsyAIOllamaRefresh")?.addEventListener("command", () => loadOllamaModels());

    const showRows = () => {
      const provider = WhimsyAIProviders.provider;
      for (const [id, row] of Object.entries(rows)) {
        row.hidden = id != provider;
      }
      if (provider == "apple") {
        checkApple({ build: false });
      } else if (provider == "claude") {
        showKeyStatus();
      } else if (provider == "ollama") {
        loadOllamaModels();
      }
    };
    // The whole card goes away while every AI feature is turned off.
    const showGroup = () => {
      group.hidden = Services.prefs.getBoolPref("whimsy.ai.blocked", false);
    };
    const prefs = { "whimsy.ai.provider": showRows, "whimsy.ai.blocked": showGroup };
    for (const [pref, fn] of Object.entries(prefs)) {
      Services.prefs.addObserver(pref, fn);
    }
    window.addEventListener(
      "unload",
      () => {
        for (const [pref, fn] of Object.entries(prefs)) {
          Services.prefs.removeObserver(pref, fn);
        }
      },
      { once: true }
    );
    // The AI features' own switches (a row each, added with each feature).
    for (const box of group.querySelectorAll("[data-feature-pref]")) {
      this.initPrefCheckbox(box.id, box.dataset.featurePref);
    }
    this.initAIWatchList?.();
    showGroup();
    showRows();
    Preferences.queueUpdateOfAllElements();
  },
});

// wave3/ai: Watch a page — the list of watches under its switch, each with
// its condition, last result and a Stop button.
Object.assign(gWhimsySettings, {
  initAIWatchList() {
    const list = document.getElementById("whimsyAIWatchList");
    if (!list || this._aiWatchWired) {
      return;
    }
    this._aiWatchWired = true;
    const { WhimsyPageWatch } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPageWatch.sys.mjs");
    const render = async () => {
      const watches = await WhimsyPageWatch.list();
      list.replaceChildren();
      list.hidden = !watches.length;
      for (const watch of watches) {
        const row = document.createElement("li");
        row.className = "whimsy-ai-watch";
        const text = document.createElement("div");
        const what = document.createElement("div");
        what.className = "whimsy-ai-watch-condition";
        what.textContent = watch.condition;
        const where = document.createElement("div");
        where.className = "whimsy-updates-detail";
        let host = watch.url;
        try {
          host = new URL(watch.url).host;
        } catch {}
        document.l10n.setAttributes(
          where,
          watch.error ? "whimsy-ai-watch-row-error" : watch.met ? "whimsy-ai-watch-row-met" : "whimsy-ai-watch-row",
          { page: watch.title || host, minutes: watch.interval }
        );
        text.append(what, where);
        const stop = document.createXULElement("button");
        document.l10n.setAttributes(stop, "whimsy-ai-watch-stop");
        stop.addEventListener("command", () => WhimsyPageWatch.remove(watch.id));
        row.append(text, stop);
        list.append(row);
      }
    };
    WhimsyPageWatch.addListener(render);
    window.addEventListener("unload", () => WhimsyPageWatch.removeListener(render), { once: true });
    render();
  },
});

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
    document.getElementById("whimsyProfilesCreate").addEventListener("command", () => {
      this.showProfileNameForm(document.getElementById("whimsyProfilesCreateSlot"), {
        submitL10nId: "whimsy-profile-create-button",
        onSubmit: name => this.profiles.create(name),
      });
    });
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
    this.renderProfiles();
  },

  renderProfiles() {
    const list = document.getElementById("whimsyProfilesList");
    if (!list || list.querySelector(".whimsy-profile-name-form")) {
      // Never pull a half-typed name out from under the person.
      return;
    }
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
  },

  profileRow(profile, spaceCount) {
    const html = tag => document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    const row = html("li");
    row.className = "whimsy-profile-row";
    row.dataset.profileId = profile.id;
    const head = document.createXULElement("hbox");
    head.setAttribute("align", "center");
    head.className = "whimsy-profile-head";
    const dot = html("span");
    dot.className = "whimsy-profile-dot";
    dot.dataset.color = profile.isDefault ? "default" : profile.color ?? "";
    dot.setAttribute("aria-hidden", "true");
    const titles = document.createXULElement("vbox");
    titles.setAttribute("flex", "1");
    const name = html("h3");
    name.className = "whimsy-profile-name";
    name.textContent = profile.name;
    const meta = document.createXULElement("description");
    meta.className = "description-deemphasized whimsy-profile-meta";
    document.l10n.setAttributes(meta, profile.isDefault ? "whimsy-profiles-spaces-default" :
      "whimsy-profiles-spaces", { count: spaceCount });
    titles.append(name, meta);
    head.append(dot, titles);
    if (!profile.isDefault) {
      const rename = document.createXULElement("button");
      document.l10n.setAttributes(rename, "whimsy-profiles-rename", { name: profile.name });
      rename.addEventListener("command", () => {
        this.showProfileNameForm(row, {
          initial: profile.name,
          submitL10nId: "whimsy-profile-rename-button",
          onSubmit: value => this.profiles.rename(profile.id, value),
        });
      });
      const remove = document.createXULElement("button");
      remove.className = "whimsy-profile-delete";
      document.l10n.setAttributes(remove, "whimsy-profiles-delete", { name: profile.name });
      remove.disabled = spaceCount > 0;
      if (remove.disabled) {
        remove.setAttribute("aria-describedby", "whimsyProfilesDeleteRule");
      }
      remove.addEventListener("command", () => this.deleteProfile(profile));
      head.append(rename, remove);
    }
    row.append(head);
    return row;
  },

  // An inline "Profile Name" field with its submit/cancel buttons, in
  // `slot`. onSubmit throws an Error whose message is the l10n id of the
  // reason; it's shown under the field, which keeps focus.
  showProfileNameForm(slot, { initial = "", submitL10nId, onSubmit }) {
    const html = tag => document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    slot.querySelector(".whimsy-profile-name-form")?.remove();
    const form = html("form");
    form.className = "whimsy-profile-name-form";
    const id = `whimsyProfileName${Date.now()}`;
    const label = html("label");
    label.htmlFor = id;
    document.l10n.setAttributes(label, "whimsy-profile-name-label");
    const input = html("input");
    input.id = id;
    input.type = "text";
    input.maxLength = 40;
    input.value = initial;
    input.setAttribute("autocomplete", "off");
    input.setAttribute("aria-describedby", `${id}-error`);
    const error = html("p");
    error.id = `${id}-error`;
    error.className = "whimsy-profile-name-error";
    error.hidden = true;
    const buttons = html("div");
    buttons.className = "whimsy-profile-name-buttons";
    const cancel = html("button");
    cancel.type = "button";
    document.l10n.setAttributes(cancel, "whimsy-profile-cancel-text");
    const submit = html("button");
    submit.type = "submit";
    submit.className = "primary";
    document.l10n.setAttributes(submit, `${submitL10nId}-text`);
    buttons.append(cancel, submit);
    form.append(label, input, error, buttons);
    const close = () => {
      form.remove();
      this.renderProfiles();
    };
    cancel.addEventListener("click", close);
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
    form.addEventListener("submit", event => {
      event.preventDefault();
      try {
        onSubmit(input.value);
      } catch (e) {
        error.hidden = false;
        input.setAttribute("aria-invalid", "true");
        document.l10n.setAttributes(error,
          e.message?.startsWith("whimsy-") ? e.message : "whimsy-profile-name-failed");
        input.focus();
        return;
      }
      close();
    });
    slot.append(form);
    input.focus();
    input.select();
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

// wave5/profiles, phase 4: Search Engine and Default Download Location on
// each profile's row. Default uses Firefox's own Search and Downloads
// settings, so its row says so instead of repeating them.
gWhimsySettings._profileRowHooks = gWhimsySettings._profileRowHooks ?? [];
gWhimsySettings._profileRowHooks.push(list => gWhimsySettings.addProfileSettings(list));

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

  addProfileSettings(list) {
    const { profiles, profileSettings } = this;
    for (const row of list.querySelectorAll(".whimsy-profile-row")) {
      const id = Number(row.dataset.profileId);
      if (id === 0) {
        const note = document.createXULElement("description");
        note.className = "description-deemphasized whimsy-profile-default-note";
        document.l10n.setAttributes(note, "whimsy-profiles-default-settings");
        row.append(note);
        continue;
      }
      const key = profiles.keyFor(id);
      const box = document.createXULElement("vbox");
      box.className = "whimsy-profile-settings";

      const engineRow = document.createXULElement("hbox");
      engineRow.setAttribute("align", "center");
      const engineLabel = document.createXULElement("label");
      const engineListId = `whimsyProfileEngine${id}`;
      engineLabel.setAttribute("control", engineListId);
      document.l10n.setAttributes(engineLabel, "whimsy-profiles-search-engine");
      const menulist = document.createXULElement("menulist");
      menulist.id = engineListId;
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
      menulist.addEventListener("command", () => profileSettings.setEngine(key, menulist.value));
      engineRow.append(engineLabel, menulist);

      const dirRow = document.createXULElement("hbox");
      dirRow.setAttribute("align", "center");
      const dirLabel = document.createXULElement("label");
      const dirValueId = `whimsyProfileDir${id}`;
      dirLabel.id = `${dirValueId}-label`;
      document.l10n.setAttributes(dirLabel, "whimsy-profiles-download-dir");
      const dirValue = document.createXULElement("description");
      dirValue.id = dirValueId;
      dirValue.className = "whimsy-profile-dir";
      dirValue.setAttribute("flex", "1");
      dirValue.setAttribute("crop", "center");
      const path = profileSettings.downloadDirFor(key);
      if (path) {
        dirValue.textContent = path;
        dirValue.setAttribute("tooltiptext", path);
      } else {
        document.l10n.setAttributes(dirValue, "whimsy-profiles-same-as-default-text");
      }
      const choose = document.createXULElement("button");
      document.l10n.setAttributes(choose, "whimsy-profiles-download-choose");
      choose.setAttribute("aria-describedby", `${dirValueId}-label ${dirValueId}`);
      choose.addEventListener("command", () => this.chooseProfileDownloadDir(key));
      dirRow.append(dirLabel, dirValue, choose);
      if (path) {
        const reset = document.createXULElement("button");
        document.l10n.setAttributes(reset, "whimsy-profiles-download-reset");
        reset.addEventListener("command", async () => {
          await profileSettings.setDownloadDir(key, null);
          this.renderProfiles();
        });
        dirRow.append(reset);
      }
      box.append(engineRow, dirRow);
      row.append(box);
    }
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
  if (event.detail.category != "paneSearch") {
    return;
  }
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
});

// wave6: navigation switches (Already open, Trails, Page actions), at the
// end of Tab Management -> Tabs. Each checkbox is the feature's own switch.
document.addEventListener("paneshown", event => {
  if (event.detail.category != "paneZenTabManagement") {
    return;
  }
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
});

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
      // Privacy & Security
      () => this.insertPrivacyGroups(),
      () => this.insertClaudeGroup(),
      // Tab Management
      () => this.insertTabsGroup(),
      () => this.insertSplitNewTabRow(),
      () => this.insertSpacesGroup(),
      () => this.insertExtensionsGroup(),
      () => this.insertHoverGroup(),
      // Search
      () => this.insertBangsGroup(),
      // General (or Tab Management with the settings redesign)
      () =>
        this.insertPerformanceGroup(
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
      if (document.hasPendingL10nMutations) {
        await new Promise(r => document.addEventListener("L10nMutationsFinished", r, { once: true }));
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

  // Look and Feel: Website appearance (Automatic/Light/Dark), Browser theme,
  // Window density and Browser icon, at the top of the pane.
  insertFirefoxLooks() {
    const groups = this.takeFirefoxGroups("template-whimsyFirefoxLooks");
    if (!groups) {
      return;
    }
    const anchor = document.getElementById("zenVerticalTabsCategory") ?? document.getElementById("zenVerticalTabsGroup");
    this.placeFirefoxGroups(groups, anchor, "before");
    // Zen's "Manage themes" line repeats Firefox's Browser theme link.
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

// wave7/teach: General → Tips ("Show tips", Teach once), after Firefox's
// Browsing group, where its own "Recommend features as you browse" lives.
document.addEventListener("paneshown", event => {
  if (event.detail.category != "paneGeneral") {
    return;
  }
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
  const anchor = document.querySelector('[groupid="browsing"]');
  if (anchor) {
    anchor.after(group);
  } else {
    document.getElementById("mainPrefPane").append(group);
  }
  group.hidden = false;
  Preferences.queueUpdateOfAllElements();
});

// wave7/menuprefs: Settings → Menus. Every right-click menu, each item a
// switch (on = it shows), in the menu's own order with a hairline where
// the menu has a separator; Restore Defaults per menu; a note when every
// item of a menu is off (that menu then doesn't open). The list comes from
// WhimsyMenuPrefs, so a row added there shows up here. Registered like
// Links (register_module before init_all), so about:preferences#whimsyMenus
// opens it and Settings search finds it.
const WHIMSY_MENUS_PANE = "paneWhimsyMenus";

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

    const groups = prefs.menus.filter(menu => prefs.available(menu)).map(menu => this.buildMenuGroup(menu));
    pane.append(header, ...groups);

    const observer = {
      observe: (subject, topic, pref) => {
        const id = pref.slice(prefs.prefName("").length);
        const group = document.getElementById(`whimsyMenus-${id}`);
        if (group) {
          this.refreshMenuGroup(group);
        }
      },
    };
    Services.prefs.addObserver(prefs.prefName(""), observer);
    window.addEventListener("unload", () => Services.prefs.removeObserver(prefs.prefName(""), observer), {
      once: true,
    });
  },

  buildMenuGroup(menu) {
    const prefs = this.menuPrefs;
    const html = tag => document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    const base = `whimsyMenus-${menu.id}`;

    const group = document.createXULElement("groupbox");
    group.id = base;
    group.className = "highlighting-group whimsy-menus-group";
    group.setAttribute("data-category", WHIMSY_MENUS_PANE);
    group.dataset.menu = menu.id;
    group.hidden = true;

    const label = document.createXULElement("label");
    const heading = html("h2");
    heading.id = `${base}-header`;
    document.l10n.setAttributes(heading, menu.l10n);
    label.append(heading);

    const description = document.createXULElement("description");
    description.id = `${base}-description`;
    description.className = "description-deemphasized";
    document.l10n.setAttributes(description, `${menu.l10n}-description`);

    // Filled only while every item is off; a live region, so turning the
    // last one off is announced.
    const note = html("div");
    note.id = `${base}-note`;
    note.className = "whimsy-menus-note";
    note.setAttribute("role", "status");

    const list = html("div");
    list.className = "whimsy-menus-list";
    list.setAttribute("role", "group");
    list.setAttribute("aria-labelledby", heading.id);
    let previous = null;
    for (const entry of prefs.groupedItems(menu.id)) {
      if (prefs.isSeparator(entry)) {
        // Only between two rows.
        if (previous && !prefs.isSeparator(previous)) {
          const divider = html("div");
          divider.className = "whimsy-menus-divider";
          divider.setAttribute("aria-hidden", "true");
          list.append(divider);
        }
        previous = entry;
        continue;
      }
      const toggle = html("moz-toggle");
      toggle.dataset.item = entry.id;
      document.l10n.setAttributes(toggle, entry.l10n);
      toggle.addEventListener("toggle", () => prefs.setHidden(menu.id, entry.id, !toggle.pressed));
      list.append(toggle);
      previous = entry;
    }
    if (list.lastElementChild?.classList.contains("whimsy-menus-divider")) {
      list.lastElementChild.remove();
    }
    // Up/Down (and Home/End) move between the switches, as in a list; Tab
    // still visits each one.
    list.addEventListener("keydown", event => {
      const toggles = [...list.querySelectorAll("moz-toggle")];
      const index = toggles.indexOf(event.target.closest?.("moz-toggle") ?? event.target);
      if (index == -1 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      const next = {
        ArrowDown: Math.min(index + 1, toggles.length - 1),
        ArrowUp: Math.max(index - 1, 0),
        Home: 0,
        End: toggles.length - 1,
      }[event.key];
      if (next === undefined) {
        return;
      }
      event.preventDefault();
      toggles[next].focus();
    });

    const actions = document.createXULElement("hbox");
    actions.className = "whimsy-menus-actions";
    const restore = document.createXULElement("button");
    restore.id = `${base}-restore`;
    restore.className = "whimsy-menus-restore";
    document.l10n.setAttributes(restore, "whimsy-menus-restore");
    // "Restore Defaults, Tab": which menu it restores.
    restore.setAttribute("aria-describedby", heading.id);
    restore.addEventListener("command", () => {
      prefs.restoreDefaults(menu.id);
      // Focus stays in the group (the button is now disabled).
      list.querySelector("moz-toggle")?.focus();
    });
    actions.append(restore);

    group.append(label, description, note, list, actions);
    this.refreshMenuGroup(group);
    return group;
  },

  refreshMenuGroup(group) {
    const prefs = this.menuPrefs;
    const menuId = group.dataset.menu;
    const hidden = prefs.hiddenIds(menuId);
    for (const toggle of group.querySelectorAll("moz-toggle")) {
      toggle.pressed = !hidden.has(toggle.dataset.item);
    }
    group.querySelector(".whimsy-menus-restore").disabled = prefs.isDefault(menuId);
    const note = group.querySelector(".whimsy-menus-note");
    if (prefs.allHidden(menuId)) {
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
