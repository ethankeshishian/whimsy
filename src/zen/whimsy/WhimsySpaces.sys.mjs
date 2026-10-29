/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spaces (Arc parity). Zen's code is wrapped or listened to, never edited.
//
// Drop tabs on space icons (whimsy.feature.space-icon-drop): in Arc you drag
// a tab onto a space's icon at the bottom of the sidebar to send it there.
// Zen already switches to a space while a dragged tab hovers its icon, but
// letting go on the icon itself did nothing. Now the icon lights up as a
// drop target, and dropping moves the tab (every selected tab, or a folder)
// into that space, switches there, bounces the icon and confirms with a
// toast.

const TAB_DROP_TYPE = "application/x-moz-tabbrowser-tab";
const DROP_FEATURE_PREF = "whimsy.feature.space-icon-drop";
const DROP_TARGET_ATTR = "whimsy-drop-target";
const LANDED_ATTR = "whimsy-landed";

function featureOn(pref) {
  return Services.prefs.getBoolPref(pref, true);
}

export const WhimsySpaces = {
  initWindow(win) {
    if (!win.gZenWorkspaces?.workspaceEnabled) {
      return;
    }
    this.initIconDrop(win);
  },

  // --- Drop tabs on space icons ---

  // The dragged tab or folder label, if it can move to another space.
  draggedItem(win, event) {
    const dt = event.dataTransfer;
    if (!dt || dt.mozTypesAt(0)[0] != TAB_DROP_TYPE) {
      return null;
    }
    const item = dt.mozGetDataAt(TAB_DROP_TYPE, 0);
    if (!item || item.documentGlobal != win || item.hasAttribute("zen-essential")) {
      return null;
    }
    const { gBrowser } = win;
    if (gBrowser.isTab(item) || gBrowser.isTabGroupLabel?.(item)) {
      return item;
    }
    return null;
  },

  initIconDrop(win) {
    const icons = win.document.getElementById("zen-workspaces-button");
    if (!icons) {
      return;
    }
    let highlighted = null;
    const highlight = button => {
      if (highlighted == button) {
        return;
      }
      highlighted?.removeAttribute(DROP_TARGET_ATTR);
      highlighted = button;
      button?.setAttribute(DROP_TARGET_ATTR, "");
    };
    const buttonFor = event => event.target.closest?.("toolbarbutton[zen-workspace-id]");

    icons.addEventListener("dragover", event => {
      const button = buttonFor(event);
      if (!featureOn(DROP_FEATURE_PREF) || !button || !this.draggedItem(win, event)) {
        highlight(null);
        return;
      }
      // Accept the drop here; Zen's own listener still switches spaces.
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      highlight(button);
    });
    icons.addEventListener("dragleave", event => {
      if (highlighted && !highlighted.contains(event.relatedTarget)) {
        highlight(null);
      }
    });
    icons.addEventListener("drop", event => {
      const button = buttonFor(event);
      const item = this.draggedItem(win, event);
      highlight(null);
      if (!featureOn(DROP_FEATURE_PREF) || !button || !item) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.moveToSpace(win, item, button.getAttribute("zen-workspace-id"));
    });
    win.addEventListener("dragend", () => highlight(null), true);
  },

  // Moves a dragged tab (with the other selected tabs) or folder into a
  // space, switches there and selects it.
  async moveToSpace(win, item, spaceId) {
    const { gBrowser, gZenWorkspaces, gZenFolders } = win;
    const space = gZenWorkspaces.getWorkspaces().find(w => w.uuid == spaceId);
    if (!space) {
      return;
    }
    let count = 1;
    if (gBrowser.isTab(item)) {
      const selected = gBrowser.selectedTabs;
      let tabs =
        item._dragData?.movingTabs ?? (selected.length > 1 && selected.includes(item) ? selected : [item]);
      tabs = tabs.filter(tab => !tab.hasAttribute("zen-essential"));
      count = tabs.length;
      gZenWorkspaces.moveTabsToWorkspace(tabs, spaceId);
      gZenWorkspaces.lastSelectedWorkspaceTabs[spaceId] = win.gZenGlanceManager?.getTabOrGlanceParent(item) ?? item;
    } else {
      gZenFolders.changeFolderToSpace(item.group, spaceId, { hasDndSwitch: gZenWorkspaces.activeWorkspace == spaceId });
    }
    if (gZenWorkspaces.activeWorkspace != spaceId) {
      await gZenWorkspaces.changeWorkspace(space);
    }
    // Zen may still be finishing the switch it began on hover; select the
    // tab once it's done, or Zen's own pick would win.
    for (let i = 0; i < 40 && gZenWorkspaces._animatingChange; i++) {
      await new Promise(resolve => win.setTimeout(resolve, 50));
    }
    if (gBrowser.isTab(item) && gBrowser.selectedTab != item) {
      gBrowser.selectedTab = item;
    }
    gZenWorkspaces.updateTabsContainers?.();
    this.land(win, spaceId);
    win.gZenUIManager?.showToast?.("whimsy-space-drop-toast", {
      l10nArgs: { count, space: space.name || "" },
    });
  },

  // A short bounce on the icon that received the drop.
  land(win, spaceId) {
    const button = win.document.querySelector(`#zen-workspaces-button toolbarbutton[zen-workspace-id="${spaceId}"]`);
    if (!button) {
      return;
    }
    button.removeAttribute(LANDED_ATTR);
    // Restart the animation if it's still playing.
    void button.getBoundingClientRect();
    button.setAttribute(LANDED_ATTR, "");
    win.setTimeout(() => button.removeAttribute(LANDED_ATTR), 400);
  },
};
