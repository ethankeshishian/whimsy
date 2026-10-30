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
    // on paneGeneral independently of the About-group branch above.
    document.addEventListener("paneshown", event => {
      if (["paneGeneral", "paneTabsBrowsing"].includes(event.detail.category)) {
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
    template.remove();
    if (!group.querySelector("[preference]")) {
      return;
    }
    Preferences.addAll(
      [...group.querySelectorAll("[preference]")].map(el => ({
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
        prefs.map(el => ({ id: el.getAttribute("preference"), type: el.localName == "checkbox" ? "bool" : "string" }))
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
    document.getElementById("whimsyAtcButton")?.addEventListener("command", () => {
      chromeWin().document.getElementById("cmd_zenOpenSpaceRoutingSettings")?.doCommand();
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
    const $ = id => document.getElementById(id);
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
    $("whimsyClaudeNewToken").addEventListener("command", () => {
      WhimsyClaude.regenerateToken();
      document.l10n.setAttributes(status, "whimsy-claude-new-token-note");
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
