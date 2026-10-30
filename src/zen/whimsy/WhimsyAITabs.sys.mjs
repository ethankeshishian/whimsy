/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Feature 1: Arc Tidy Tabs + auto-rename new tabs to short titles.
// - Tidy Tabs: Click broom or menu to organize unpinned tabs into topic folders.
//   Arc documentation strictly requires more than six Today Tabs.
// - Auto-rename new tabs: Automatically shortens noisy titles when tabs load.
//   Manual renames (zenStaticLabel) are strictly preserved!

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyAI: "resource:///modules/whimsy/WhimsyAI.sys.mjs",
  WhimsyAIProviders: "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs",
});

const PREF_TIDY_FEATURE = "whimsy.feature.tidy-tabs";
const PREF_AUTO_RENAME = "whimsy.ai.auto-rename-tabs";
const BROOM_ID = "whimsy-tidy-tabs-broom";
const MENU_ID = "context_whimsyTidyTabs";

export const WhimsyAITabs = {
  initWindow(win) {
    if (!Services.prefs.getBoolPref(PREF_TIDY_FEATURE, true)) {
      return;
    }

    this.addBroomButton(win);
    this.initMenu(win);

    // Auto-rename tabs when page title updates
    const container = win.gBrowser?.tabContainer;
    if (container) {
      container.addEventListener("TabAttrModified", event => {
        if (event.detail?.changed?.includes("label")) {
          this.onTabTitleModified(event.target);
        }
      });
    }
  },

  addBroomButton(win) {
    const doc = win.document;
    if (doc.getElementById(BROOM_ID)) {
      return;
    }

    const button = doc.createXULElement("toolbarbutton");
    button.id = BROOM_ID;
    button.className = "toolbarbutton-1 whimsy-broom-button";
    button.setAttribute("tooltiptext", "Tidy Tabs");
    button.setAttribute("label", "Tidy Tabs");
    button.addEventListener("command", () => this.tidyTabs(win));

    const periphery = doc.getElementById("tabbrowser-arrowscrollbox-periphery");
    if (periphery) {
      periphery.appendChild(button);
    }
  },

  initMenu(win) {
    const { document } = win;
    const menu = document.getElementById("tabContextMenu");
    menu?.addEventListener("popupshowing", event => {
      if (event.target == menu) {
        this.updateMenu(win);
      }
    });
  },

  updateMenu(win) {
    const { document } = win;
    let item = document.getElementById(MENU_ID);
    const enabled = Services.prefs.getBoolPref(PREF_TIDY_FEATURE, true) && !lazy.WhimsyAI.blocked;
    if (!enabled) {
      if (item) {
        item.hidden = true;
      }
      return;
    }

    if (!item) {
      item = document.createXULElement("menuitem");
      item.id = MENU_ID;
      document.l10n.setAttributes(item, "tab-context-whimsy-tidy-tabs");
      item.addEventListener("command", () => this.tidyTabs(win));
      const anchor = document.getElementById("context_zenMoveToFolder") || document.getElementById("context_moveTabOptions");
      if (anchor) {
        anchor.after(item);
      } else {
        document.getElementById("tabContextMenu")?.appendChild(item);
      }
    }
    item.hidden = false;
  },

  getTodayTabs(win) {
    const activeSpaceId = win.gZenWorkspaces?.activeWorkspaceId;
    return win.gBrowser.tabs.filter(tab => {
      if (tab.pinned || tab.hasAttribute("zen-essential") || tab.hidden || tab.closing) {
        return false;
      }
      if (tab.closest?.("zen-folder") || tab.group) {
        return false;
      }
      if (activeSpaceId && tab.getAttribute("zen-workspace-id") && tab.getAttribute("zen-workspace-id") !== activeSpaceId) {
        return false;
      }
      return true;
    });
  },

  async tidyTabs(win) {
    if (lazy.WhimsyAI.blocked || !Services.prefs.getBoolPref(PREF_TIDY_FEATURE, true)) {
      return { success: false, reason: "blocked" };
    }

    const tabs = this.getTodayTabs(win);
    // Arc boundary: strictly more than six Today Tabs
    if (tabs.length <= 6) {
      win.gZenUIManager?.showToast?.("whimsy-tidy-tabs-min-tabs");
      return { success: false, reason: "min-tabs", count: tabs.length };
    }

    const tabData = tabs.map((t, idx) => ({
      index: idx,
      title: t.label,
      url: t.linkedBrowser?.currentURI?.spec || "",
    }));

    const prompt = `You are Arc's Tidy Tabs assistant. Organize these browser tabs into 2 to 5 topic folders.
Tabs:
${JSON.stringify(tabData, null, 2)}

Respond with a JSON array ONLY, where each item has "name" (a 1-3 word topic name) and "indices" (an array of tab index integers belonging to that topic). Each folder must contain at least 2 tabs.
Example: [{"name": "Articles", "indices": [0, 2]}, {"name": "Shopping", "indices": [1, 3]}]`;

    try {
      const { text } = await lazy.WhimsyAIProviders.complete({
        system: "You group browser tabs into coherent topic clusters. Output JSON only.",
        prompt,
      });

      const match = text.match(/\[[\s\S]*\]/);
      if (!match) {
        throw new Error("Invalid response format from AI");
      }

      const clusters = JSON.parse(match[0]);
      let createdFolders = 0;
      const workspaceId = win.gZenWorkspaces?.activeWorkspaceId;

      for (const cluster of clusters) {
        if (!cluster.name || !Array.isArray(cluster.indices) || cluster.indices.length < 2) {
          continue;
        }
        const clusterTabs = cluster.indices.map(i => tabs[i]).filter(Boolean);
        if (clusterTabs.length >= 2 && win.gZenFolders) {
          win.gZenFolders.createFolder(clusterTabs, {
            label: cluster.name,
            renameFolder: false,
            workspaceId,
          });
          createdFolders++;
        }
      }

      win.gZenUIManager?.showToast?.("whimsy-tidy-tabs-success", { l10nArgs: { count: createdFolders } });
      return { success: true, groupsCreated: createdFolders };
    } catch (e) {
      console.error("WhimsyAITabs: tidyTabs error", e);
      return { success: false, error: e.message };
    }
  },

  async autoRenameTab(tab) {
    if (lazy.WhimsyAI.blocked || !Services.prefs.getBoolPref(PREF_AUTO_RENAME, true)) {
      return null;
    }
    // Chesterton's fence & Arc parity: Preserve manual names!
    if (tab.zenStaticLabel && !tab._whimsyAutoRenamed) {
      return null;
    }
    if (tab.pinned || tab.hasAttribute("zen-essential") || tab.closing) {
      return null;
    }

    const title = tab.label;
    const url = tab.linkedBrowser?.currentURI?.spec || "";
    if (!title || url.startsWith("about:") || title.length <= 15) {
      return null;
    }

    const prompt = `Shorten this web page title into a clean, concise tab title of 2 to 4 words (max 25 characters). Remove brand suffixes, breadcrumbs, and clutter.
Title: "${title}"
URL: "${url}"
Return ONLY the shortened title without quotes or punctuation.`;

    try {
      const { text } = await lazy.WhimsyAIProviders.complete({ prompt });
      const shortTitle = (text || "").trim().replace(/^["']|["']$/g, "");
      if (!shortTitle || shortTitle.length >= title.length) {
        return null;
      }

      // Re-verify before setting to ensure user didn't manually rename in the meantime
      if (tab.zenStaticLabel && !tab._whimsyAutoRenamed) {
        return null;
      }

      tab.zenStaticLabel = shortTitle;
      tab._whimsyAutoRenamed = true;
      tab.ownerGlobal?.gBrowser?._setTabLabel?.(tab, shortTitle, { _zenChangeLabelFlag: true });
      return shortTitle;
    } catch (e) {
      console.debug("WhimsyAITabs: autoRename error", e);
      return null;
    }
  },

  onTabTitleModified(tab) {
    if (!tab || tab._whimsyRenaming || tab._whimsyAutoRenamed) {
      return;
    }
    tab._whimsyRenaming = true;
    tab.ownerGlobal.setTimeout(() => {
      tab._whimsyRenaming = false;
      this.autoRenameTab(tab);
    }, 1200);
  },
};
