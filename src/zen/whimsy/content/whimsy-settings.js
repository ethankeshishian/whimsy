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
  describe(state, control, installed) {
    if (!installed) {
      const auto = this.firefoxAutoUpdate;
      return [
        [auto ? "whimsy-updates-browser" : "whimsy-updates-browser-manual", { version: Services.appinfo.version }],
        [auto ? "whimsy-updates-browser-detail" : "whimsy-updates-browser-manual-detail"],
      ];
    }
    const current = state?.installed?.version || "?";
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
    const [state, control, installed] = await Promise.all([
      WhimsyUpdates.readState(),
      WhimsyUpdates.readControl(),
      WhimsyUpdates.isInstalled(),
    ]);
    const [headline, detail] = this.describe(state, control, installed);
    document.l10n.setAttributes(document.getElementById("whimsyUpdatesHeadline"), ...headline);
    document.l10n.setAttributes(document.getElementById("whimsyUpdatesDetail"), ...detail);

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
