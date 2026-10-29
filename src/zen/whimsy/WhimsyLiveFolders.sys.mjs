/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Live folders: tabs that refresh themselves. Zen ships GitHub and RSS;
// this adds Jira. Zen's `ZenLiveFoldersManager.registry` is a plain,
// public Map built for exactly this -- a provider class keyed by its
// `static type` -- so a new provider is registered into it, never patched
// into Zen's own `providers` array. `ZenLiveFoldersManager.init()` is
// wrapped (public method, never edited) to add Jira to the registry right
// after Zen populates its own two; this re-runs every init()/uninit()
// cycle (e.g. closing the last window), so the entry survives that.
//
// The "+" toolbar menu's "Create a live folder" list (built once by Zen's
// ZenFolders.mjs, #zen-panel-ui-live-folder-create) is Zen-owned XUL we
// never edit either: a Jira entry is spliced in lazily, on first
// popupshowing, the same technique WhimsyFolderColors uses for its own
// folder-context-menu entry.

import { WhimsyJiraLiveFolderProvider, DEFAULT_JQL } from "resource:///modules/whimsy/WhimsyJiraLiveFolder.sys.mjs";

const JIRA_FEATURE_PREF = "whimsy.feature.live-folders-jira";

export const WhimsyLiveFolders = {
  get jiraEnabled() {
    return Services.prefs.getBoolPref(JIRA_FEATURE_PREF, true);
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    try {
      const { ZenLiveFoldersManager } = ChromeUtils.importESModule(
        "resource:///modules/zen/ZenLiveFoldersManager.sys.mjs"
      );
      this.wrapManagerInit(ZenLiveFoldersManager);
    } catch (e) {
      console.error("Whimsy: live folders registry hook failed", e);
    }
  },

  // Patches the manager instance's own prototype (nsZenLiveFoldersManager),
  // not the singleton itself, so it keeps working across uninit()/init()
  // cycles (e.g. the last window closing, then a new one opening).
  wrapManagerInit(managerInstance) {
    const proto = Object.getPrototypeOf(managerInstance);
    const original = proto.init;
    if (typeof original != "function" || original.whimsyWrapped) {
      return;
    }
    proto.init = async function (...args) {
      const result = await original.apply(this, args);
      if (WhimsyLiveFolders.jiraEnabled) {
        this.registry.set(WhimsyJiraLiveFolderProvider.type, WhimsyJiraLiveFolderProvider);
      }
      return result;
    };
    proto.init.whimsyWrapped = true;
  },

  initWindow(win) {
    this.initCreateMenu(win);
  },

  initCreateMenu(win) {
    const { document } = win;

    document.addEventListener(
      "popupshowing",
      event => {
        const menu = event.target.closest?.("#zen-panel-ui-live-folder-create");
        if (!menu) {
          return;
        }
        let item = menu.querySelector(".whimsy-live-folder-jira-create");
        if (!item) {
          item = document.createXULElement("menuitem");
          item.classList.add("whimsy-live-folder-jira-create");
          item.setAttribute("command", "cmd_zenNewLiveFolder");
          item.setAttribute("image", "chrome://browser/skin/zen-icons/selectable/ticket.svg");
          document.l10n.setAttributes(item, "whimsy-live-folder-jira-create");
          menu.appendChild(item);
        }
        item.hidden = !this.jiraEnabled;
      },
      { capture: true }
    );

    const command = document.getElementById("cmd_zenNewLiveFolder");
    command?.addEventListener("command", event => {
      const target = event.sourceEvent?.target;
      if (!this.jiraEnabled || target?.getAttribute("data-l10n-id") != "whimsy-live-folder-jira-create") {
        return;
      }
      this.createJiraFolder(win);
    });
  },

  async createJiraFolder(win) {
    try {
      const site = await WhimsyJiraLiveFolderProvider.promptForSite(win);
      if (!site) {
        return;
      }

      const { ZenLiveFoldersManager } = ChromeUtils.importESModule(
        "resource:///modules/zen/ZenLiveFoldersManager.sys.mjs"
      );

      const folder = win.gZenFolders.createFolder([], {
        label: "Jira",
        isLiveFolder: true,
        collapsed: true,
      });
      win.gZenFolders.setFolderUserIcon(folder, "chrome://browser/skin/zen-icons/selectable/ticket.svg");

      const state = {
        type: WhimsyJiraLiveFolderProvider.type,
        site,
        jql: DEFAULT_JQL,
        interval: 30 * 60 * 1000,
        lastFetched: 0,
        options: {},
      };
      const liveFolder = new WhimsyJiraLiveFolderProvider({
        id: folder.id,
        state,
        manager: ZenLiveFoldersManager,
      });

      ZenLiveFoldersManager.liveFolders.set(folder.id, liveFolder);
      liveFolder.start();
      ZenLiveFoldersManager.saveState();
    } catch (e) {
      console.error("Whimsy: creating a Jira live folder failed", e);
    }
  },
};
