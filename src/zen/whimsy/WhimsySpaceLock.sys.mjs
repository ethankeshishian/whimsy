/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// batch9: spaces
//
// W11-14 (d14): a locked space now opens behind the shared lock cover
// instead of refusing the switch; see wrapChangeWorkspace.
//
// Lock a space (whimsy.feature.space-lock): a space with sensitive tabs
// (banking, a work project) shouldn't be visible to someone who picks up
// the laptop. Locking it means switching there prompts Touch ID or a
// password first, same as revealing a saved password in Firefox's logins
// UI: both ask Firefox's OSReauthenticator (W11-17: through WhimsyAuth).
// No native code needed.
//
// "Lock This Space" / "Unlock This Space" toggles from the workspace
// context menu (zenWorkspaceMoreActions, same injection pattern as
// WhimsySpaceArchive.sys.mjs); the gate itself wraps
// ZenSpaceManager#changeWorkspace, the one function every way of switching
// spaces (click, shortcut, command line, drag) funnels through. Canceling
// the prompt leaves the previous space active. A space you left less than
// relockMs() ago doesn't re-prompt on returning to it; longer than that, or
// after a restart (lastLeft is in-memory only), it does.
//
// Known limitation: the switcher's own icon can still show a locked space's
// name and custom icon/color while it's inactive (no hover-preview of tab
// content exists to gate further, as far as this batch found); only the
// tabs themselves are gated behind the prompt.

const FEATURE_PREF = "whimsy.feature.space-lock";
const MENU_ID = "whimsy-lock-space-menuitem";
const LOCKED_ATTR = "whimsy-locked-space";
// W11-14: the same timing as the private lock ("Lock after"), at least a
// minute so returning to a space you just left doesn't ask again.
const RELOCK_MIN_MS = 60 * 1000;
function relockMs() {
  return Math.max(RELOCK_MIN_MS, Services.prefs.getIntPref("whimsy.privateLock.afterSeconds", 0) * 1000);
}

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyPrivateLock: "resource:///modules/whimsy/WhimsyPrivateLock.sys.mjs",
});

// Module-level (not per-window): spaces are synced across every window via
// gZenWindowSync, so "left 2 minutes ago" has to mean the same thing
// everywhere.
const lastLeft = new Map();
// Locked spaces entered but not unlocked yet (they show the cover).
const covered = new Set();

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

  // d14 (W11-14): switching to a locked space is no longer refused. The
  // space opens behind the shared lock cover (WhimsyPrivateLock's), its tab
  // list hidden, and Touch ID is asked for at once (as the private lock
  // does); Unlock on the cover asks again. Returning within the grace
  // window, or after an unlock, shows it straight away.
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
      const needsUnlock = featureOn() && workspace?.whimsyLocked && previousId != workspace.uuid &&
        !self.recentlyLeft(workspace.uuid);
      if (needsUnlock) {
        covered.add(workspace.uuid);
      }
      const result = await original.call(this, workspace, ...args);
      self.renderCover(win);
      if (needsUnlock && this.activeWorkspace == workspace.uuid) {
        self.unlockCovered(win, workspace);
      }
      return result;
    };
    wrapped._whimsy = true;
    workspaces.changeWorkspace = wrapped;
  },

  recentlyLeft(uuid) {
    const at = lastLeft.get(uuid);
    return !!at && Date.now() - at < relockMs();
  },

  isCovered(uuid) {
    return covered.has(uuid);
  },

  // The cover over the active space while it's locked, and its tab list
  // hidden; gone in every window once it's unlocked.
  renderCover(win) {
    if (win.closed || !win.gZenWorkspaces) {
      return;
    }
    const active = win.gZenWorkspaces.getActiveWorkspace?.();
    for (const el of win.document.querySelectorAll("zen-workspace[whimsy-space-covered]")) {
      el.removeAttribute("whimsy-space-covered");
    }
    const isCovered = featureOn() && !!active?.whimsyLocked && covered.has(active.uuid);
    win.document.documentElement.toggleAttribute("whimsy-space-covered", isCovered);
    const lock = lazy.WhimsyPrivateLock;
    if (!isCovered) {
      lock.hideCover(win, "space-lock");
      return;
    }
    win.gZenWorkspaces.workspaceElement?.(active.uuid)?.setAttribute("whimsy-space-covered", "");
    lock.showCoverFor(win, {
      kind: "space-lock",
      titleL10nId: "whimsy-space-lock-cover-title",
      detailL10nId: "whimsy-space-lock-cover-detail",
      args: { space: active.name || "" },
      onUnlock: () => this.unlockCovered(win, active),
    });
  },

  renderAll() {
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      this.renderCover(w);
    }
  },

  async unlockCovered(win, workspace) {
    if (!covered.has(workspace.uuid)) {
      return true;
    }
    // Paint the cover before the system sheet.
    await new Promise(resolve => win.requestAnimationFrame(() => resolve()));
    if (!(await this.authenticate(win, workspace))) {
      win.document.querySelector(".whimsy-lock-cover")?.toggleAttribute("failed", true);
      return false;
    }
    covered.delete(workspace.uuid);
    lastLeft.delete(workspace.uuid);
    this.renderAll();
    return true;
  },

  /**
   * For flows that bring something into a locked space or show it (Show
   * Hidden Spaces, Move Out of Private): asks first unless it's open
   * already. False when cancelled.
   */
  async ensureUnlocked(win, workspace) {
    if (!featureOn() || !workspace?.whimsyLocked || this.recentlyLeft(workspace.uuid) ||
        win.gZenWorkspaces.activeWorkspace == workspace.uuid && !covered.has(workspace.uuid)) {
      return true;
    }
    if (!(await this.authenticate(win, workspace))) {
      return false;
    }
    covered.delete(workspace.uuid);
    // Counts as just left, so the switch that follows doesn't ask again.
    lastLeft.set(workspace.uuid, Date.now());
    this.renderAll();
    return true;
  },

  // W11-17: through WhimsyAuth (OSReauthenticator). It used
  // OSKeyStore.ensureLoggedIn(true), which throws on `true`, so a locked
  // space never opened. A platform without OS authentication opens it, as
  // OSKeyStore did.
  async authenticate(win = null, space = null) {
    const { WhimsyAuth } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAuth.sys.mjs");
    const result = await WhimsyAuth.unlock(win, "whimsy-auth-reason-space", { space: space?.name || "" });
    return result != "cancel";
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
      covered.delete(workspace.uuid);
      this.renderAll();
    }
    win.gZenWorkspaces.saveWorkspace(workspace);
    this.applyBadges(win);
    win.gZenUIManager?.showToast?.(
      workspace.whimsyLocked ? "whimsy-lock-space-toast" : "whimsy-unlock-space-toast",
      { l10nArgs: { space: workspace.name || "" } }
    );
  },
};
