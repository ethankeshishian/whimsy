/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// batch9: spaces
//
// Lock a space (whimsy.feature.space-lock): a space with sensitive tabs
// (banking, a work project) shouldn't be visible to someone who picks up
// the laptop. Locking it means switching there prompts Touch ID or a
// password first, same as revealing a saved password in Firefox's logins
// UI — both go through OSKeyStore.sys.mjs, which already wraps the macOS
// Keychain for that prompt. No native code needed.
//
// "Lock This Space" / "Unlock This Space" toggles from the workspace
// context menu (zenWorkspaceMoreActions, same injection pattern as
// WhimsySpaceArchive.sys.mjs); the gate itself wraps
// ZenSpaceManager#changeWorkspace, the one function every way of switching
// spaces (click, shortcut, command line, drag) funnels through. Canceling
// the prompt leaves the previous space active. A space you left less than
// RELOCK_MS ago doesn't re-prompt on returning to it; longer than that, or
// after a restart (lastLeft is in-memory only), it does.
//
// Known limitation: the switcher's own icon can still show a locked space's
// name and custom icon/color while it's inactive (no hover-preview of tab
// content exists to gate further, as far as this batch found); only the
// tabs themselves are gated behind the prompt.

const FEATURE_PREF = "whimsy.feature.space-lock";
const MENU_ID = "whimsy-lock-space-menuitem";
const LOCKED_ATTR = "whimsy-locked-space";
const RELOCK_MS = 5 * 60 * 1000;

// Module-level (not per-window): spaces are synced across every window via
// gZenWindowSync, so "left 2 minutes ago" has to mean the same thing
// everywhere.
const lastLeft = new Map();

function featureOn() {
  return Services.prefs.getBoolPref(FEATURE_PREF, true);
}

export const WhimsySpaceLock = {
  initWindow(win) {
    if (!win.gZenWorkspaces?.workspaceEnabled) {
      return;
    }
    this.wrapChangeWorkspace(win);
    this.initContextMenu(win);
    // wave5: the space menu's "Lock This Space" as a command for the
    // current space.
    const active = w => w.gZenWorkspaces.getWorkspaces().find(s => s.uuid == w.gZenWorkspaces.activeWorkspace);
    ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs").WhimsyCommands.register(win, {
      id: "cmd_whimsyLockSpace",
      l10nId: "whimsy-action-lock-space-toggle",
      run: w => featureOn() && active(w) && this.toggleLocked(w, active(w).uuid),
      icon: "chrome://browser/skin/zen-icons/selectable/lock-closed.svg",
      variants: [
        { l10nId: "whimsy-action-lock-space", isAvailable: w => featureOn() && !!active(w) && !active(w).whimsyLocked },
        { l10nId: "whimsy-action-unlock-space", isAvailable: w => featureOn() && !!active(w)?.whimsyLocked },
      ],
    });
    this.applyBadges(win);
    const refresh = () => this.applyBadges(win);
    win.addEventListener("ZenWorkspaceDataChanged", refresh);
    win.addEventListener("ZenWorkspacesUIUpdate", refresh);
    win.addEventListener("unload", () => {
      win.removeEventListener("ZenWorkspaceDataChanged", refresh);
      win.removeEventListener("ZenWorkspacesUIUpdate", refresh);
    }, { once: true });
  },

  wrapChangeWorkspace(win) {
    const workspaces = win.gZenWorkspaces;
    const original = workspaces.changeWorkspace;
    if (typeof original != "function" || original._whimsy) {
      return;
    }
    const self = this;
    const wrapped = async function (workspace, ...args) {
      const previousId = this.activeWorkspace;
      if (workspace && previousId != workspace.uuid) {
        lastLeft.set(previousId, Date.now());
      }
      if (
        featureOn() &&
        workspace?.whimsyLocked &&
        previousId != workspace.uuid &&
        !self.recentlyLeft(workspace.uuid)
      ) {
        if (!(await self.authenticate())) {
          return this.getActiveWorkspace();
        }
        // A fresh unlock, not a return within the grace window.
        lastLeft.delete(workspace.uuid);
      }
      return original.call(this, workspace, ...args);
    };
    wrapped._whimsy = true;
    workspaces.changeWorkspace = wrapped;
  },

  recentlyLeft(uuid) {
    const at = lastLeft.get(uuid);
    return !!at && Date.now() - at < RELOCK_MS;
  },

  async authenticate() {
    try {
      const { OSKeyStore } = ChromeUtils.importESModule("resource://gre/modules/OSKeyStore.sys.mjs");
      const { authenticated } = await OSKeyStore.ensureLoggedIn(true);
      return authenticated;
    } catch (e) {
      console.error("Whimsy: space lock authentication", e);
      return false;
    }
  },

  applyBadges(win) {
    const { document, gZenWorkspaces } = win;
    const lockedIds = new Set(
      featureOn() ? gZenWorkspaces.getWorkspaces().filter(w => w.whimsyLocked).map(w => w.uuid) : []
    );
    for (const button of document.querySelectorAll("#zen-workspaces-button toolbarbutton[zen-workspace-id]")) {
      button.toggleAttribute(LOCKED_ATTR, lockedIds.has(button.getAttribute("zen-workspace-id")));
    }
  },

  initContextMenu(win) {
    const popup = win.document.getElementById("zenWorkspaceMoreActions");
    popup?.addEventListener("popupshowing", event => {
      if (event.target == popup) {
        this.updateContextMenu(win, event);
      }
    });
  },

  menuTargetWorkspace(win, event) {
    const { gZenWorkspaces } = win;
    let target;
    try {
      target = event.explicitOriginalTarget?.closest?.("toolbarbutton");
    } catch (e) {
      target = null;
    }
    const id = target?.getAttribute("zen-workspace-id") || gZenWorkspaces.activeWorkspace;
    return gZenWorkspaces.getWorkspaces().find(w => w.uuid == id) ?? null;
  },

  updateContextMenu(win, event) {
    const { document } = win;
    const anchor = document.getElementById("context_zenDeleteWorkspace");
    if (!anchor) {
      return;
    }
    let item = document.getElementById(MENU_ID);
    if (!item) {
      item = document.createXULElement("menuitem");
      item.id = MENU_ID;
      item.addEventListener("command", () => this.toggleLocked(win, this._pendingUuid));
      anchor.after(item);
    }
    const workspace = this.menuTargetWorkspace(win, event);
    this._pendingUuid = workspace?.uuid;
    item.hidden = !featureOn() || !workspace;
    if (!item.hidden) {
      document.l10n.setAttributes(item, workspace.whimsyLocked ? "whimsy-unlock-space" : "whimsy-lock-space");
    }
  },

  toggleLocked(win, uuid) {
    const workspace = win.gZenWorkspaces.getWorkspaces().find(w => w.uuid == uuid);
    if (!workspace) {
      return;
    }
    workspace.whimsyLocked = !workspace.whimsyLocked;
    if (!workspace.whimsyLocked) {
      lastLeft.delete(workspace.uuid);
    }
    win.gZenWorkspaces.saveWorkspace(workspace);
    this.applyBadges(win);
    win.gZenUIManager?.showToast?.(
      workspace.whimsyLocked ? "whimsy-lock-space-toast" : "whimsy-unlock-space-toast",
      { l10nArgs: { space: workspace.name || "" } }
    );
  },
};
