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
// the prompt keeps the cover (d14). See W13-C2 below for when it's covered.
//
// Known limitation: the switcher's own icon can still show a locked space's
// name and custom icon/color while it's inactive (no hover-preview of tab
// content exists to gate further, as far as this batch found); only the
// tabs themselves are gated behind the prompt.
//
// W13-C2 (wave13/c2-lock-design.md): whether a locked space is covered is
// computed, not remembered from the last switch into it. It's covered
// unless you unlocked it (`open`) and either it's still active in some
// window or you left it less than "Lock after" ago (whimsy.privateLock.
// afterSeconds, default right away). The old rule only covered on entry
// and never within a minute of leaving (RELOCK_MIN_MS), so "Lock Space,
// switch away and back" (11-04) showed it unlocked. Every covered space's
// tab strip is hidden (swipe previews too), sleep re-covers, a restart
// starts covered, and removing the lock from a covered space asks first.

const FEATURE_PREF = "whimsy.feature.space-lock";
const AFTER_PREF = "whimsy.privateLock.afterSeconds";
const MENU_ID = "whimsy-lock-space-menuitem";
const LOCKED_ATTR = "whimsy-locked-space";
function afterMs() {
  return Math.max(0, Services.prefs.getIntPref(AFTER_PREF, 0)) * 1000;
}

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyPrivateLock: "resource:///modules/whimsy/WhimsyPrivateLock.sys.mjs",
});

// Module-level (not per-window): spaces are synced across every window via
// gZenWindowSync, so "left 2 minutes ago" has to mean the same thing
// everywhere.
// Locked spaces unlocked with Touch ID or the password.
const open = new Set();
// When an unlocked locked space stopped being active in every window.
const lastLeft = new Map();
// Unlocked from outside (Show Hidden Spaces, Move To) for the switch that
// follows: when.
const tickets = new Map();
const TICKET_MS = 10 * 1000;
let relockTimer = null;

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
    this.initGlobal();
    // A restored locked space starts covered. Selecting a tab in a covered
    // space (the switch itself, a link routed there) draws the cover before
    // the page paints: WhimsyPrivateLock.render runs on every TabSelect and
    // ends with renderCover, so the address bar and window title follow.
    lazy.WhimsyPrivateLock.render(win);
    const refresh = () => {
      this.applyBadges(win);
      lazy.WhimsyPrivateLock.render(win);
    };
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
  // does); Unlock on the cover asks again. W13-C2: whether it's covered is
  // isCovered(); this only settles the target and starts the clock on the
  // space you left.
  wrapChangeWorkspace(win) {
    const workspaces = win.gZenWorkspaces;
    const original = workspaces.changeWorkspace;
    if (typeof original != "function" || original._whimsy) {
      return;
    }
    const self = this;
    const wrapped = async function (workspace, ...args) {
      const previousId = this.activeWorkspace;
      const switching = !!workspace && previousId != workspace.uuid;
      if (switching && featureOn() && workspace.whimsyLocked && !self.isOpen(workspace.uuid)) {
        // Left too long ago: it's closed again before it's shown.
        open.delete(workspace.uuid);
      }
      const result = await original.call(this, workspace, ...args);
      if (switching) {
        self.noteLeft(previousId);
        if (this.activeWorkspace == workspace.uuid) {
          lastLeft.delete(workspace.uuid);
          tickets.delete(workspace.uuid);
        }
      }
      self.renderAll();
      if (switching && this.activeWorkspace == workspace.uuid && self.isCovered(workspace.uuid)) {
        // Landing on it asks at once (d6), as the private lock does.
        self.unlockCovered(win, workspace);
      }
      return result;
    };
    wrapped._whimsy = true;
    workspaces.changeWorkspace = wrapped;
  },

  initGlobal() {
    if (this._global) {
      return;
    }
    this._global = true;
    // Mac sleep closes every unlocked space again (d4).
    Services.obs.addObserver(() => this.lockAll(), "sleep_notification");
    Services.prefs.addObserver(AFTER_PREF, () => this.renderAll());
  },

  windows() {
    return [...Services.wm.getEnumerator("navigator:browser")].filter(w => !w.closed && w.gZenWorkspaces);
  },

  activeAnywhere(uuid) {
    return this.windows().some(w => w.gZenWorkspaces.activeWorkspace == uuid);
  },

  space(uuid) {
    for (const w of this.windows()) {
      const found = w.gZenWorkspaces.getWorkspaces?.().find(s => s.uuid == uuid);
      if (found) {
        return found;
      }
    }
    return null;
  },

  // Unlocked, and in front somewhere, left less than "Lock after" ago, or
  // unlocked for a switch that's about to happen. Anything else (a path
  // that left it without going through changeWorkspace) is covered.
  isOpen(uuid) {
    if (!open.has(uuid)) {
      return false;
    }
    if (this.activeAnywhere(uuid)) {
      return true;
    }
    const now = Date.now();
    if (now - (tickets.get(uuid) ?? -Infinity) < TICKET_MS) {
      return true;
    }
    return now - (lastLeft.get(uuid) ?? -Infinity) < afterMs();
  },

  isCovered(uuid) {
    return !!uuid && featureOn() && !!this.space(uuid)?.whimsyLocked && !this.isOpen(uuid);
  },

  // An unlocked locked space left the screen: its "Lock after" clock
  // starts, and it's covered again when that runs out.
  noteLeft(uuid) {
    if (!uuid || !open.has(uuid) || this.activeAnywhere(uuid)) {
      return;
    }
    if (!afterMs()) {
      open.delete(uuid);
      lastLeft.delete(uuid);
      return;
    }
    lastLeft.set(uuid, Date.now());
    relockTimer?.cancel();
    relockTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    relockTimer.initWithCallback(() => {
      relockTimer = null;
      this.renderAll();
    }, afterMs() + 50, Ci.nsITimer.TYPE_ONE_SHOT);
  },

  lockAll() {
    if (!open.size) {
      return;
    }
    open.clear();
    lastLeft.clear();
    tickets.clear();
    this.renderAll();
  },

  // The cover over the active space while it's locked, and its tab list
  // hidden; gone in every window once it's unlocked.
  renderCover(win) {
    if (win.closed || !win.gZenWorkspaces?.workspaceEnabled) {
      return;
    }
    // Every covered space's tab list is hidden, not only the active one's:
    // a swipe slides the next space's strip in before it switches.
    for (const space of win.gZenWorkspaces.getWorkspaces?.() ?? []) {
      win.gZenWorkspaces.workspaceElement?.(space.uuid)
        ?.toggleAttribute("whimsy-space-covered", this.isCovered(space.uuid));
    }
    const active = win.gZenWorkspaces.getActiveWorkspace?.();
    const isCovered = this.isCovered(active?.uuid);
    win.document.documentElement.toggleAttribute("whimsy-space-covered", isCovered);
    const lock = lazy.WhimsyPrivateLock;
    if (!isCovered) {
      lock.hideCover(win, "space-lock");
      return;
    }
    // A locked private tab in front keeps its own cover; this one follows
    // once that unlocks (WhimsyPrivateLock.render calls back here).
    if (lock.hasPrivateCover(win)) {
      return;
    }
    lock.showCoverFor(win, {
      kind: "space-lock",
      titleL10nId: "whimsy-space-lock-cover-title",
      detailL10nId: "whimsy-space-lock-cover-detail",
      args: { space: active.name || "" },
      onUnlock: () => this.unlockCovered(win, active),
    });
  },

  renderAll() {
    for (const w of this.windows()) {
      lazy.WhimsyPrivateLock.render(w);
    }
  },

  async unlockCovered(win, workspace) {
    if (!this.isCovered(workspace.uuid)) {
      return true;
    }
    // Paint the cover before the system sheet.
    await new Promise(resolve => win.requestAnimationFrame(() => resolve()));
    if (!(await this.authenticate(win, workspace))) {
      win.document.querySelector(".whimsy-lock-cover")?.toggleAttribute("failed", true);
      return false;
    }
    this.markOpen(workspace.uuid);
    return true;
  },

  markOpen(uuid, { forSwitch = false } = {}) {
    open.add(uuid);
    lastLeft.delete(uuid);
    if (forSwitch) {
      tickets.set(uuid, Date.now());
    }
    this.renderAll();
  },

  /**
   * For flows that bring something into a locked space or show it (Show
   * Hidden Spaces, Move Out of Private): asks first unless it's open
   * already. False when cancelled.
   */
  async ensureUnlocked(win, workspace) {
    if (!this.isCovered(workspace?.uuid)) {
      return true;
    }
    if (!(await this.authenticate(win, workspace))) {
      return false;
    }
    // Open for the switch that follows, so it doesn't ask again.
    this.markOpen(workspace.uuid, { forSwitch: true });
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

  /**
   * Lock This Space / Unlock This Space. Removing the lock from a covered
   * space asks first (otherwise the menu is a way around the lock). Locking
   * a space you're in leaves it showing until you leave it.
   */
  async toggleLocked(win, uuid) {
    const workspace = win.gZenWorkspaces.getWorkspaces().find(w => w.uuid == uuid);
    if (!workspace) {
      return false;
    }
    if (workspace.whimsyLocked && this.isCovered(uuid) && !(await this.authenticate(win, workspace))) {
      return false;
    }
    workspace.whimsyLocked = !workspace.whimsyLocked;
    open.delete(uuid);
    lastLeft.delete(uuid);
    tickets.delete(uuid);
    if (workspace.whimsyLocked && this.activeAnywhere(uuid)) {
      open.add(uuid);
    }
    win.gZenWorkspaces.saveWorkspace(workspace);
    this.renderAll();
    this.applyBadges(win);
    win.gZenUIManager?.showToast?.(
      workspace.whimsyLocked ? "whimsy-lock-space-toast" : "whimsy-unlock-space-toast",
      { l10nArgs: { space: workspace.name || "" } }
    );
    return true;
  },
};
