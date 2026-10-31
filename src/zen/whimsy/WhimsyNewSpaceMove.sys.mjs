/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave7/small: Move to ▸ New Space…. Arc's Move to menu ends with New
// Space…, which makes a space and puts the tab (a split: the whole split)
// in it. Zen's New Space only opened the creation form, so the split stayed
// behind. Here the tabs move once the form is confirmed (a cancelled form
// leaves them where they were):
// - the tab menu's Move To ▸ New Space… (after Zen's list of spaces);
// - the command bar's "Move to New Space…" for the current tab;
// - the split row menu's Move to ▸ New Space… (wave7/split2), whose item
//   is picked up here by its id so neither module has to know the other.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.move-to-new-space";
const MENU_ID = "context_whimsyMoveToNewSpace";
const SPLIT_ROW_ITEM_ID = "whimsySplitRow-newSpace";

export const WhimsyNewSpaceMove = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  spacesUsable(win) {
    const spaces = win.gZenWorkspaces;
    return !!spaces?.workspaceEnabled && !spaces.privateWindowOrDisabled;
  },

  initWindow(win) {
    if (!this.spacesUsable(win)) {
      return;
    }
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyMoveToNewSpace",
      l10nId: "whimsy-action-move-to-new-space",
      run: w => this.moveToNewSpace(w, [w.gBrowser.selectedTab]),
      icon: "chrome://browser/skin/zen-icons/arrow-right.svg",
      isAvailable: w =>
        this.enabled && this.spacesUsable(w) && !w.gBrowser.selectedTab?.hasAttribute("zen-essential"),
    });
    this.initTabMenu(win);
    // The split row menu's New Space… (when that menu exists): run here
    // instead, so the split goes along.
    win.addEventListener(
      "command",
      event => {
        if (event.target?.id != SPLIT_ROW_ITEM_ID || !this.enabled) {
          return;
        }
        const tab = this.menuTab(event.target);
        if (!tab) {
          return;
        }
        event.stopPropagation();
        this.moveToNewSpace(win, [tab]);
      },
      true
    );
  },

  // The tab a Whimsy menu was opened for (the split row menu keeps it on
  // its root popup as whimsyTab).
  menuTab(item) {
    for (let node = item.parentNode; node; node = node.parentNode) {
      if (node.whimsyTab) {
        return node.whimsyTab;
      }
    }
    return null;
  },

  initTabMenu(win) {
    const { document } = win;
    const popup = document.getElementById("moveTabOptionsMenu");
    if (!popup) {
      return;
    }
    popup.addEventListener("popupshowing", event => {
      if (event.target != popup) {
        return;
      }
      let item = document.getElementById(MENU_ID);
      if (!item) {
        item = document.createXULElement("menuitem");
        item.id = MENU_ID;
        item.setAttribute("data-l10n-id", "whimsy-menu-move-to-new-space");
        item.addEventListener("command", () => {
          const context = win.TabContextMenu?.contextTab;
          if (!context) {
            return;
          }
          const tabs = context.multiselected ? win.gBrowser.selectedTabs : [context];
          this.moveToNewSpace(win, tabs);
        });
      }
      // Right after Zen's list of spaces (its separator closes the list),
      // or first when there's no other space to list.
      const zenItems = popup.querySelectorAll(":scope > .zen-workspace-context-menu-item");
      const after = zenItems[zenItems.length - 1];
      if (after) {
        after.after(item);
      } else {
        popup.prepend(item);
      }
      const context = win.TabContextMenu?.contextTab;
      item.hidden = !this.enabled || !this.spacesUsable(win);
      item.disabled = !context || context.hasAttribute("zen-essential");
    });
  },

  /**
   * Opens Zen's New Space form; once it's confirmed, moves `tabs` (a split
   * tab brings its whole split) into the new space and selects them.
   * Resolves to "moved", "cancelled" or "off".
   */
  async moveToNewSpace(win, tabs) {
    const { gBrowser, gZenWorkspaces } = win;
    tabs = tabs.filter(tab => tab && !tab.closing && !tab.hasAttribute("zen-essential"));
    if (!this.enabled || !this.spacesUsable(win) || !tabs.length) {
      return "off";
    }
    win.document.getElementById("tabContextMenu")?.hidePopup();
    await gZenWorkspaces.openWorkspaceCreation();
    const form = win.document.querySelector("zen-workspace-creation");
    const spaceId = form?.getAttribute("workspace-id") || gZenWorkspaces.creatingWorkspaceId;
    if (!form || !spaceId) {
      return "cancelled";
    }
    await new Promise(resolve => {
      if (!form.isConnected) {
        resolve();
        return;
      }
      const observer = new win.MutationObserver(() => {
        if (!form.isConnected) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(form.parentNode, { childList: true });
    });
    // Confirmed: the new space is still there and showing. Cancelled: Zen
    // has already switched back (and removes the space).
    const created =
      gZenWorkspaces.activeWorkspace == spaceId && gZenWorkspaces.getWorkspaces().some(w => w.uuid == spaceId);
    tabs = tabs.filter(tab => tab.isConnected && !tab.closing);
    if (!created || !tabs.length) {
      return "cancelled";
    }
    gZenWorkspaces.moveTabsToWorkspace(tabs, spaceId);
    const last = tabs.at(-1);
    gZenWorkspaces.lastSelectedWorkspaceTabs[spaceId] = win.gZenGlanceManager?.getTabOrGlanceParent(last) ?? last;
    gBrowser.selectedTab = last;
    gZenWorkspaces.updateTabsContainers?.();
    return "moved";
  },
};
