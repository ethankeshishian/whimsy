/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Whimsy's groups in Settings → Look and Feel: updates, app icon and
// interface zoom. They live in #template-whimsyLooks and are moved into the
// pane the first time it's shown, so Zen's settings code stays untouched.

"use strict";

var gWhimsySettings = {
  PANE: "paneZenLooks",

  init() {
    document.addEventListener("paneshown", event => {
      if (event.detail.category == this.PANE) {
        this.insertGroups();
      } else if (event.detail.category == "panePrivacy") {
        this.insertPrivacyGroups();
      }
    });
  },

  get lazy() {
    const lazy = {};
    ChromeUtils.defineESModuleGetters(lazy, {
      Whimsy: "resource:///modules/whimsy/Whimsy.sys.mjs",
      WhimsyAppIcon: "resource:///modules/whimsy/WhimsyAppIcon.sys.mjs",
      WhimsyUpdates: "resource:///modules/whimsy/WhimsyUpdates.sys.mjs",
      UpdateUtils: "resource://gre/modules/UpdateUtils.sys.mjs",
    });
    Object.defineProperty(this, "lazy", { value: lazy });
    return lazy;
  },

  insertGroups() {
    const template = document.getElementById("template-whimsyLooks");
    if (!template) {
      return;
    }
    Preferences.addAll([
      { id: "whimsy.ui-zoom", type: "int" },
      { id: "whimsy.update-channel", type: "string" },
    ]);
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
      whimsyUpdatesGroup: AppConstants.platform == "macosx",
    };
    for (const [id, enabled] of Object.entries(keep)) {
      if (!enabled) {
        document.getElementById(id)?.remove();
      }
    }
    if (keep.whimsyAppIconGroup) {
      this.initAppIcons();
    }
    if (keep.whimsyUpdatesGroup) {
      this.initUpdates();
    }
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
  initCookieBanners() {
    const checkbox = document.getElementById("whimsyRejectCookieBanners");
    const pref = "whimsy.reject-cookie-banners";
    const update = () => {
      checkbox.checked = Services.prefs.getBoolPref(pref, true);
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
    const auto = document.getElementById("whimsyUpdatesAuto");
    const check = document.getElementById("whimsyUpdatesCheck");
    const showLog = document.getElementById("whimsyUpdatesShowLog");
    const rollback = document.getElementById("whimsyUpdatesRollback");
    const log = document.getElementById("whimsyUpdatesLog");

    auto.addEventListener("command", async () => {
      if (this.localUpdater) {
        await WhimsyUpdates.setPaused(!auto.checked);
      } else {
        await this.lazy.UpdateUtils.setAppUpdateAutoEnabled(auto.checked);
        this.firefoxAutoUpdate = auto.checked;
      }
      this.refreshUpdates();
    });
    check.addEventListener("command", async () => {
      if (!this.localUpdater) {
        // The About dialog checks for, downloads and offers to restart for updates.
        window.browsingContext.topChromeWindow.openAboutDialog();
        return;
      }
      check.disabled = true;
      await WhimsyUpdates.checkNow();
      this.refreshUpdates();
    });
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

  formatDate(iso) {
    if (!iso) {
      return "";
    }
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  },

  // The status lines for the current updater state: [headline, detail], each
  // [l10n id, args]. Without the local updater (an install from a published
  // build), Firefox's own updater keeps Whimsy current.
  describe(state, control, installed, version) {
    if (!installed) {
      const auto = this.firefoxAutoUpdate;
      return [
        [auto ? "whimsy-updates-browser" : "whimsy-updates-browser-manual", { version: version.version }],
        [auto ? "whimsy-updates-browser-detail" : "whimsy-updates-browser-manual-detail"],
      ];
    }
    const current = version.version;
    const checked = { date: this.formatDate(state?.last_run) };
    if (state?.status == "running") {
      return [
        ["whimsy-updates-running", { step: state.message || "" }],
        ["whimsy-updates-current", { version: current }],
      ];
    }
    if (state?.staged?.version) {
      return [
        ["whimsy-updates-ready", { version: state.staged.version }],
        ["whimsy-updates-ready-detail"],
      ];
    }
    const headline = control?.paused
      ? ["whimsy-updates-paused", { version: current }]
      : ["whimsy-updates-up-to-date", { version: current }];
    if (state?.last_result == "failed" || state?.last_result == "skipped") {
      return [headline, ["whimsy-updates-last-problem", { message: state.message || "", ...checked }]];
    }
    return [headline, state?.last_run ? ["whimsy-updates-checked", checked] : ["whimsy-updates-never-checked"]];
  },

  firefoxAutoUpdate: true,

  async refreshUpdates() {
    const { WhimsyUpdates, UpdateUtils } = this.lazy;
    try {
      this.firefoxAutoUpdate = await UpdateUtils.getAppUpdateAutoEnabled();
    } catch {}
    const [state, control, installed, version] = await Promise.all([
      WhimsyUpdates.readState(),
      WhimsyUpdates.readControl(),
      WhimsyUpdates.isInstalled(),
      WhimsyUpdates.readVersion(),
    ]);
    const [headline, detail] = this.describe(state, control, installed, version);
    document.l10n.setAttributes(
      document.getElementById("whimsyUpdatesChannelNote"),
      WhimsyUpdates.channel == "dev" ? "whimsy-updates-channel-dev-note" : "whimsy-updates-channel-release-note"
    );
    document.l10n.setAttributes(document.getElementById("whimsyUpdatesHeadline"), ...headline);
    document.l10n.setAttributes(document.getElementById("whimsyUpdatesDetail"), ...detail);
    this.renderVersion(version);

    const auto = document.getElementById("whimsyUpdatesAuto");
    auto.checked = installed ? !control?.paused : this.firefoxAutoUpdate;
    document.getElementById("whimsyUpdatesCheck").disabled =
      installed && (state?.status == "running" || !!control?.paused);
    document.getElementById("whimsyUpdatesShowLog").hidden = !installed;
    this.localUpdater = installed;

    const rollback = document.getElementById("whimsyUpdatesRollback");
    const previous = state?.previous?.version;
    rollback.hidden = !installed;
    rollback.disabled = !previous;
    if (previous) {
      document.l10n.setAttributes(rollback, "whimsy-updates-rollback", { version: previous });
    } else {
      document.l10n.setAttributes(rollback, "whimsy-updates-rollback-none");
    }
  },

  formatDay(day) {
    // "2026-10-28" is a calendar day: read it as local, not UTC midnight.
    const [y, m, d] = (day || "").split("-").map(Number);
    return y ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(y, m - 1, d)) : "";
  },

  // "Based on Zen ..." and the version history (newest first). Only redrawn
  // when the version changes.
  renderVersion(info) {
    const key = JSON.stringify(info);
    if (this.renderedVersion == key) {
      return;
    }
    this.renderedVersion = key;
    const base = document.getElementById("whimsyUpdatesBase");
    const label = info.zen_label && info.zen_label != info.zen ? info.zen_label : null;
    document.l10n.setAttributes(base, label ? "whimsy-updates-based-on-label" : "whimsy-updates-based-on", {
      zen: info.zen,
      label,
      firefox: info.firefox || Services.appinfo.platformVersion,
    });

    const list = document.getElementById("whimsyUpdatesHistoryList");
    const entries = [...info.history];
    if (!info.released) {
      entries.unshift({ version: info.version, zen: info.zen, dev: true, commit: info.commit });
    }
    const items = entries.map((entry, index) => {
      const item = document.createElement("li");
      const heading = document.createElement("div");
      heading.className = "whimsy-history-heading";
      const name = document.createElement("strong");
      name.textContent = entry.version;
      heading.append(name);
      const meta = [];
      if (entry.date) {
        meta.push(Object.assign(document.createElement("span"), { textContent: this.formatDay(entry.date) }));
      }
      const previous = entries[index + 1];
      if (previous && previous.zen != entry.zen) {
        const zen = document.createElement("span");
        document.l10n.setAttributes(zen, "whimsy-updates-history-zen", { zen: entry.zen });
        meta.push(zen);
      }
      if (entry.version == info.version) {
        const current = document.createElement("span");
        current.className = "whimsy-history-current";
        document.l10n.setAttributes(current, "whimsy-updates-history-this");
        meta.push(current);
      }
      heading.append(...meta);
      item.append(heading);

      const notes = document.createElement("ul");
      if (entry.dev) {
        const note = document.createElement("li");
        document.l10n.setAttributes(note, "whimsy-updates-history-dev", { commit: entry.commit || "?" });
        notes.append(note);
      } else if (!entry.notes?.length) {
        const note = document.createElement("li");
        document.l10n.setAttributes(note, "whimsy-updates-history-same-code");
        notes.append(note);
      }
      for (const line of entry.notes ?? []) {
        notes.append(Object.assign(document.createElement("li"), { textContent: line }));
      }
      item.append(notes);
      return item;
    });
    if (!items.length) {
      const none = document.createElement("li");
      document.l10n.setAttributes(none, "whimsy-updates-history-none");
      items.push(none);
    }
    list.replaceChildren(...items);
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
