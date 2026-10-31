/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave5/profiles, phase 6: moving a space or a tab into another profile.
//
// Arc warns first, then the page really changes profile (its cookies and
// logins don't come along). In Zen, "Set Profile" only changed the space's
// container field and "Move to Space" only changed the tab's space: open
// tabs kept their old container, i.e. their old profile's cookies. Here:
// - Set Profile (and Create a New Profile… in it) asks with Arc's warning,
//   then reopens every tab of the space in the new container;
// - moving tabs to a space of another profile (Move to Space, dragging onto
//   a space) asks with Arc's warning, then reopens them there; saying no
//   puts them back where they were.
// Reopening is Firefox's own "Reopen in Container" technique: a new tab
// with the target userContextId and a principal re-keyed to it, in the old
// tab's place (space, pin, folder, selection, mute), then the old one closes.
// Essentials never move: each profile has its own.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  E10SUtils: "resource://gre/modules/E10SUtils.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  WhimsyPanels: "resource:///modules/whimsy/WhimsyPanels.sys.mjs",
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
});

export const WhimsyProfileMoves = {
  // Tests replace this to answer without a dialog.
  async confirm(win, { titleId, titleArgs, bodyId, bodyArgs, acceptId, acceptArgs }) {
    const [title, body, accept] = await win.document.l10n.formatValues([
      { id: titleId, args: titleArgs },
      { id: bodyId, args: bodyArgs },
      { id: acceptId, args: acceptArgs },
    ]);
    return lazy.WhimsyPanels.confirm(win, { title, body, accept });
  },

  // -- reopening a tab in another container ---------------------------------

  principalFor(tab, userContextId) {
    let principal = null;
    if (tab.linkedPanel) {
      principal = tab.linkedBrowser.contentPrincipal;
    } else {
      try {
        const state = JSON.parse(lazy.SessionStore.getTabState(tab));
        principal = lazy.E10SUtils.deserializePrincipal(state.triggeringPrincipal_base64);
      } catch {}
    }
    return this.rekey(principal, userContextId, this.isPrivate(tab));
  },

  // A private tab stays private in its new profile: it keeps its other
  // origin attributes (privateBrowsingId) and opens as a private tab, so
  // its page never reaches history, the session or Sync.
  isPrivate(tab) {
    return lazy.WhimsyPrivate.isPrivateTab(tab) || lazy.WhimsyPrivate.isPrivateBrowser(tab?.linkedBrowser);
  },

  rekey(principal, userContextId, isPrivate = false) {
    const privateBrowsingId = isPrivate ? 1 : 0;
    if (!principal || principal.isNullPrincipal) {
      return Services.scriptSecurityManager.createNullPrincipal({ userContextId, privateBrowsingId });
    }
    if (principal.isContentPrincipal) {
      return Services.scriptSecurityManager.principalWithOA(principal, {
        ...principal.originAttributes,
        userContextId,
        privateBrowsingId: Math.max(privateBrowsingId, principal.originAttributes.privateBrowsingId || 0),
      });
    }
    return principal;
  },

  // The tab's saved state (works for lazy tabs too); {} if SessionStore
  // doesn't track it.
  tabState(tab) {
    try {
      return JSON.parse(lazy.SessionStore.getTabState(tab)) ?? {};
    } catch {
      return {};
    }
  },

  urlOf(tab, state = null) {
    if (tab.linkedPanel) {
      return tab.linkedBrowser.currentURI?.spec || "about:blank";
    }
    state ??= this.tabState(tab);
    return state.entries?.[(state.index || 1) - 1]?.url || "about:blank";
  },

  // Zen keeps a tab's space, renamed title, custom icon, pinned reset page
  // and live-folder link as tab attributes/properties, saved in its
  // SessionStore state (TabState.collect: zenWorkspace, zenStaticLabel...).
  // A plain addTab starts without them, so the reopened tab copies them from
  // the old tab's state. The sync id isn't copied: the old tab still has it
  // until it closes, and Zen's window sync gives the new tab its own.
  copyZenState(oldTab, newTab, state, spaceId) {
    newTab.setAttribute("zen-workspace-id", spaceId);
    const label = typeof state.zenStaticLabel == "string" ? state.zenStaticLabel : oldTab.zenStaticLabel;
    if (label) {
      newTab.zenStaticLabel = label;
    }
    const icon = state.zenHasStaticIcon && state.image ? state.image : oldTab.zenStaticIcon;
    if (icon) {
      newTab.zenStaticIcon = icon;
    }
    const pinnedIcon = state.zenPinnedIcon || oldTab.getAttribute("zen-pinned-icon");
    if (pinnedIcon) {
      newTab.setAttribute("zen-pinned-icon", pinnedIcon);
    }
    const liveItem = state.zenLiveFolderItemId || oldTab.getAttribute("zen-live-folder-item-id");
    if (liveItem) {
      newTab.setAttribute("zen-live-folder-item-id", liveItem);
    }
    // A pin's reset page: only its URL and title (Zen's window sync trims it
    // the same way), so no principal of the old profile comes along. Set
    // before pinTab, which otherwise records the new tab's current page.
    const initial = state._zenPinnedInitialState ?? oldTab._zenPinnedInitialState;
    if (initial?.entry?.url) {
      newTab._zenPinnedInitialState = {
        ...initial,
        entry: { url: initial.entry.url, title: initial.entry.title },
      };
    }
  },

  // Zen remembers each space's last selected tab and selects it again on a
  // switch; pointing at the closed tab would hand the tab switcher a
  // destroyed tab.
  replaceLastSelected(win, oldTab, newTab) {
    const last = win.gZenWorkspaces.lastSelectedWorkspaceTabs;
    for (const [id, tab] of Object.entries(last ?? {})) {
      if (tab == oldTab) {
        last[id] = newTab;
      }
    }
  },

  /** Reopens `tab` in container `userContextId`, in space `spaceId`. */
  reopen(win, tab, userContextId, spaceId) {
    const { gBrowser, gZenWorkspaces } = win;
    if (tab.closing || tab.hasAttribute("zen-essential")) {
      return null;
    }
    const selected = gBrowser.selectedTab == tab;
    const isPrivate = this.isPrivate(tab);
    const state = this.tabState(tab);
    const newTab = gBrowser.addTab(this.urlOf(tab, state), {
      userContextId,
      whimsyPrivate: isPrivate,
      tabIndex: tab._tPos + 1,
      triggeringPrincipal: this.principalFor(tab, userContextId),
      skipAnimation: true,
      // The tab that will be selected needs a live browser for the switcher.
      createLazyBrowser: !selected,
      lazyTabTitle: tab.label,
    });
    // Before any move: Zen's moveTabsToWorkspace skips a tab that already
    // sits in the space's container (tabIndex put it there), so without this
    // the new tab never got its zen-workspace-id.
    this.copyZenState(tab, newTab, state, spaceId);
    if (tab.pinned) {
      gBrowser.pinTab(newTab);
    }
    gZenWorkspaces.moveTabToWorkspace(newTab, spaceId);
    if (newTab.getAttribute("zen-workspace-id") != spaceId) {
      newTab.setAttribute("zen-workspace-id", spaceId);
    }
    try {
      if (tab.group && tab.group != newTab.group) {
        tab.group.addTabs?.([newTab]);
      }
    } catch (e) {
      console.error("Whimsy: keep the tab in its folder", e);
    }
    if (tab.muted && !newTab.muted) {
      newTab.toggleMuteAudio(tab.muteReason);
    }
    this.replaceLastSelected(win, tab, newTab);
    // Select a live tab before the old one closes, so the tab switcher never
    // targets a tab that's gone: the new tab when its space is showing, else
    // the most recent tab of the showing space (Zen's empty tab if none), so
    // a move doesn't switch spaces by itself.
    if (gBrowser.selectedTab == tab) {
      gBrowser.selectedTab = spaceId == gZenWorkspaces.activeWorkspace ? newTab :
        this.liveTabInView(win, [tab, newTab]) ?? newTab;
    }
    if (gBrowser.selectedTab == tab) {
      // Zen refused the switch (mid space change): don't close the selected
      // tab under the switcher; it closes once something else is selected.
      this.closeWhenDeselected(win, tab);
      return newTab;
    }
    gBrowser.removeTab(tab, { animate: false, skipPermitUnload: true });
    return newTab;
  },

  liveTabInView(win, exclude) {
    const { gBrowser, gZenWorkspaces } = win;
    let best = null;
    for (const t of gBrowser.visibleTabs) {
      if (exclude.includes(t) || t.closing || t.hasAttribute("zen-glance-tab") ||
          gZenWorkspaces._shouldChangeToTab?.(t) === false) {
        continue;
      }
      if (!best || (t.lastAccessed ?? 0) > (best.lastAccessed ?? 0)) {
        best = t;
      }
    }
    const empty = gZenWorkspaces._emptyTab;
    return best ?? (empty && !empty.closing && !exclude.includes(empty) ? empty : null);
  },

  closeWhenDeselected(win, tab) {
    const { gBrowser } = win;
    const onSelect = () => {
      if (tab.closing || !tab.isConnected) {
        gBrowser.tabContainer.removeEventListener("TabSelect", onSelect);
      } else if (gBrowser.selectedTab != tab) {
        gBrowser.tabContainer.removeEventListener("TabSelect", onSelect);
        gBrowser.removeTab(tab, { animate: false, skipPermitUnload: true });
      }
    };
    gBrowser.tabContainer.addEventListener("TabSelect", onSelect);
  },

  // -- spaces ---------------------------------------------------------------

  spaceTabs(win, space) {
    // gBrowser.tabs holds only the showing space's tabs (Zen); a space
    // being moved is often another one.
    return (win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs).filter(tab =>
      tab.getAttribute("zen-workspace-id") == space.uuid && !tab.hasAttribute("zen-essential"));
  },

  async moveSpace(win, space, id) {
    const { WhimsyProfiles } = lazy;
    id = Number(id) || 0;
    if (!space || WhimsyProfiles.profileIdOfSpace(space) == id) {
      return false;
    }
    if (!WhimsyProfiles.enabled) {
      return WhimsyProfiles.assignSpace(win, space, id);
    }
    const ok = await this.confirm(win, {
      titleId: "whimsy-profile-move-space-title",
      titleArgs: { space: space.name, profile: WhimsyProfiles.nameOf(id) },
      bodyId: "whimsy-profile-move-space-body",
      acceptId: "whimsy-profile-move-space-accept",
    });
    if (!ok) {
      return false;
    }
    await WhimsyProfiles.assignSpace(win, space, id);
    this._moving = true;
    try {
      for (const tab of this.spaceTabs(win, space)) {
        if ((tab.userContextId ?? 0) != id) {
          this.reopen(win, tab, id, space.uuid);
        }
      }
    } finally {
      this._moving = false;
    }
    win.gZenUIManager?.showToast?.("whimsy-profile-moved-space-toast", {
      l10nArgs: { space: space.name, profile: WhimsyProfiles.nameOf(id) },
    });
    return true;
  },

  // Zen's Set Profile list: its own command handler (bound at startup)
  // only changes the field. Answer the command first, Arc's way.
  initSetProfile(win) {
    win.addEventListener("command", event => {
      const item = event.target;
      if (!lazy.WhimsyProfiles.enabled || item.hasAttribute?.("data-whimsy-create-profile") ||
          item.parentNode?.parentNode?.id != "context_zenWorkspacesOpenInContainerTab") {
        return;
      }
      const id = parseInt(item.getAttribute("data-usercontextid"), 10);
      if (isNaN(id)) {
        return;
      }
      event.stopPropagation();
      const space = lazy.WhimsyProfiles.contextMenuSpace(win);
      this.moveSpace(win, space, id).catch(e => console.error("Whimsy: move space", e));
    }, true);
  },

  // -- tabs -----------------------------------------------------------------

  crossing(win, tabs, spaceId) {
    const space = win.gZenWorkspaces.getWorkspaceFromId?.(spaceId) ??
      win.gZenWorkspaces.getWorkspaces().find(item => item.uuid == spaceId);
    if (!space) {
      return [];
    }
    const id = lazy.WhimsyProfiles.profileIdOfSpace(space);
    const out = [];
    for (const item of tabs) {
      const members = item.tabs ?? [item];
      for (const tab of members) {
        const from = tab.getAttribute?.("zen-workspace-id");
        if (from && from != spaceId && !tab.hasAttribute("zen-essential") &&
            (tab.userContextId ?? 0) != id) {
          out.push({ tab, from });
        }
      }
    }
    return out;
  },

  async confirmTabMove(win, moved, spaceId, original) {
    const { WhimsyProfiles } = lazy;
    const space = win.gZenWorkspaces.getWorkspaceFromId?.(spaceId) ??
      win.gZenWorkspaces.getWorkspaces().find(item => item.uuid == spaceId);
    const id = WhimsyProfiles.profileIdOfSpace(space);
    const ok = await this.confirm(win, {
      titleId: "whimsy-profile-move-tab-title",
      titleArgs: { count: moved.length, space: space?.name ?? "" },
      bodyId: "whimsy-profile-move-tab-body",
      bodyArgs: { count: moved.length, profile: WhimsyProfiles.nameOf(id) },
      acceptId: "whimsy-profile-move-tab-accept",
      acceptArgs: { count: moved.length },
    });
    this._moving = true;
    try {
      if (ok) {
        for (const { tab } of moved) {
          this.reopen(win, tab, id, spaceId);
        }
        return true;
      }
      // No: put them back.
      const back = new Map();
      for (const { tab, from } of moved) {
        if (!tab.closing) {
          back.set(from, [...(back.get(from) ?? []), tab]);
        }
      }
      for (const [from, tabs] of back) {
        original.call(win.gZenWorkspaces, tabs, from);
      }
      return false;
    } finally {
      this._moving = false;
    }
  },

  wrapMoveTabs(win) {
    const workspaces = win.gZenWorkspaces;
    const original = workspaces.moveTabsToWorkspace;
    if (typeof original != "function" || original._whimsyProfiles) {
      return;
    }
    const self = this;
    const wrapped = function (tabs, workspaceID, ...rest) {
      const moved = !self._moving && lazy.WhimsyProfiles.enabled ?
        self.crossing(win, tabs ?? [], workspaceID) : [];
      const result = original.call(this, tabs, workspaceID, ...rest);
      if (moved.length) {
        self.confirmTabMove(win, moved, workspaceID, original)
          .catch(e => console.error("Whimsy: move tab across profiles", e));
      }
      return result;
    };
    wrapped._whimsyProfiles = true;
    workspaces.moveTabsToWorkspace = wrapped;
  },

  initWindow(win) {
    this.initSetProfile(win);
    this.wrapMoveTabs(win);
  },
};
