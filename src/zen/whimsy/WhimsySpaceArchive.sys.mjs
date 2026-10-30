/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// batch9: spaces
//
// Archive (hide) a space (whimsy.feature.archive-space, Arc parity): a space
// you aren't using right now drops out of the space switcher without
// deleting its tabs, settings or position — unlike Zen's only "space goes
// away" path (ZenSpaceManager#removeWorkspace), which is destructive. People
// reach for Arc's version of this for a seasonal or project space ("Taxes
// 2026") they don't want cluttering the switcher year-round but don't want
// to lose either.
//
// A hidden space is a plain workspace object with `whimsyHidden: true` set
// on it — ZenSpaceManager already round-trips unknown fields through
// saveWorkspace()/SessionStore the same way it does icon, name and theme, so
// this needs no Zen file changes. "Hide This Space" is added to Zen's own
// workspace context menu (zenWorkspaceMoreActions, via a popupshowing
// listener, the same pattern WhimsySpaces.sys.mjs uses for other menus);
// restoring happens from Whimsy's "Hidden spaces" list (Settings → Tab
// Management → Spaces), since a hidden space has no menu of its own once
// it's out of the switcher.
//
// wave3: Cmd+1-9 (and Zen's tenth switch shortcut) count only the spaces
// visible in the switcher, so a hidden space's number goes to the next one
// (Arc numbers what the sidebar shows). Wraps gZenWorkspaces.shortcutSwitchTo,
// the single entry point Zen's cmd_zenWorkspaceSwitchN commands call; direct
// changeWorkspace calls (restore, Settings) are untouched. Next/previous
// space cycling (changeWorkspaceShortcut) still steps through hidden spaces.

const FEATURE_PREF = "whimsy.feature.archive-space";
const HIDDEN_ATTR = "whimsy-hidden-space";
const MENU_ID = "whimsy-hide-space-menuitem";

function featureOn() {
  return Services.prefs.getBoolPref(FEATURE_PREF, true);
}

export const WhimsySpaceArchive = {
  initWindow(win) {
    if (!win.gZenWorkspaces?.workspaceEnabled) {
      return;
    }
    this.wrapShortcutSwitch(win);
    const refresh = () => this.applyHidden(win);
    this.applyHidden(win);
    win.addEventListener("ZenWorkspaceDataChanged", refresh);
    win.addEventListener("ZenWorkspacesUIUpdate", refresh);
    Services.prefs.addObserver(FEATURE_PREF, refresh);
    win.addEventListener(
      "unload",
      () => {
        win.removeEventListener("ZenWorkspaceDataChanged", refresh);
        win.removeEventListener("ZenWorkspacesUIUpdate", refresh);
        Services.prefs.removeObserver(FEATURE_PREF, refresh);
      },
      { once: true }
    );
    this.initContextMenu(win);
    // wave5: the space menu's "Hide This Space" as a command for the
    // current space.
    ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs").WhimsyCommands.register(win, {
      id: "cmd_whimsyHideSpace",
      l10nId: "whimsy-action-hide-space",
      run: w => featureOn() && this.toggleHidden(w, w.gZenWorkspaces.activeWorkspace),
      icon: "chrome://browser/skin/zen-icons/selectable/eye.svg",
      isAvailable: w => featureOn() && w.gZenWorkspaces.getWorkspaces().filter(s => !s.whimsyHidden).length > 1,
    });
  },

  wrapShortcutSwitch(win) {
    const spaces = win.gZenWorkspaces;
    const original = spaces.shortcutSwitchTo;
    if (typeof original != "function" || original._whimsyVisibleSpaces) {
      return;
    }
    const wrapped = function (index) {
      if (!featureOn()) {
        return original.apply(this, arguments);
      }
      const visible = this.getWorkspaces().filter(space => !space.whimsyHidden);
      const target = Number.isInteger(index) && index >= 0 ? visible[index] : null;
      return target ? this.changeWorkspace(target) : undefined;
    };
    wrapped._whimsyVisibleSpaces = true;
    spaces.shortcutSwitchTo = wrapped;
  },

  // Every hidden space's switcher icon gets `hidden`; everything else loses
  // it. Never touches tabs — that's the whole difference from deleting a
  // space.
  applyHidden(win) {
    const { document } = win;
    const hiddenIds = new Set(
      featureOn() ? win.gZenWorkspaces.getWorkspaces().filter(w => w.whimsyHidden).map(w => w.uuid) : []
    );
    for (const button of document.querySelectorAll("#zen-workspaces-button toolbarbutton[zen-workspace-id]")) {
      const isHidden = hiddenIds.has(button.getAttribute("zen-workspace-id"));
      button.toggleAttribute(HIDDEN_ATTR, isHidden);
      button.hidden = isHidden;
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

  // The workspace a popupshowing targets: the one whose icon opened the
  // menu, or the active one when it's opened without a specific icon
  // (keyboard, or the current space's own corner button).
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
      item.addEventListener("command", () => this.toggleHidden(win, this._pendingUuid));
      anchor.after(item);
    }
    const workspace = this.menuTargetWorkspace(win, event);
    this._pendingUuid = workspace?.uuid;
    const hide = !featureOn() || !workspace || workspace.whimsyHidden;
    item.hidden = hide;
    if (!hide) {
      document.l10n.setAttributes(item, "whimsy-hide-space");
    }
  },

  async toggleHidden(win, uuid) {
    const { gZenWorkspaces } = win;
    const workspace = gZenWorkspaces.getWorkspaces().find(w => w.uuid == uuid);
    if (!workspace || workspace.whimsyHidden) {
      return;
    }
    const visible = gZenWorkspaces.getWorkspaces().filter(w => !w.whimsyHidden);
    if (visible.length <= 1) {
      win.gZenUIManager?.showToast?.("whimsy-hide-space-last-toast");
      return;
    }
    if (workspace.uuid == gZenWorkspaces.activeWorkspace) {
      const next = visible.find(w => w.uuid != workspace.uuid);
      if (next) {
        await gZenWorkspaces.changeWorkspaceWithID(next.uuid);
      }
    }
    workspace.whimsyHidden = true;
    gZenWorkspaces.saveWorkspace(workspace);
    this.applyHidden(win);
    win.gZenUIManager?.showToast?.("whimsy-hide-space-toast", { l10nArgs: { space: workspace.name || "" } });
  },

  // The hidden spaces in `win`, for Settings' list.
  listHidden(win) {
    return win.gZenWorkspaces.getWorkspaces().filter(w => w.whimsyHidden);
  },

  restore(win, uuid) {
    const workspace = win.gZenWorkspaces.getWorkspaces().find(w => w.uuid == uuid);
    if (!workspace) {
      return;
    }
    delete workspace.whimsyHidden;
    win.gZenWorkspaces.saveWorkspace(workspace);
    this.applyHidden(win);
    win.gZenUIManager?.showToast?.("whimsy-restore-space-toast", { l10nArgs: { space: workspace.name || "" } });
  },
};
