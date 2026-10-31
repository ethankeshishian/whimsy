/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave8/isolation: a tab never lives in a space of another profile.
//
// A space's profile is its container (Zen's workspace.containerTabId), and a
// tab's container (userContextId) is fixed for its life: it picks the cookie
// jar, storage and cache the page reads and writes. Zen moves a tab between
// spaces by changing its zen-workspace-id, so a tab moved to a space of
// another profile kept reading and writing its old profile's cookies there:
// signed-in accounts followed it, and signing in through it signed the old
// profile in (the dev.580 report).
//
// Arc: moving a tab into another profile warns first, then the page reloads
// in that profile without its cookies or logins. Whimsy does the same:
// - moves through Zen's moveTabsToWorkspace are held back, warned about and
//   reopened by WhimsyProfileMoves.wrapMoveTabs;
// - every other path (sidebar drag across spaces, folders moved to a space,
//   tabs adopted from another window, window sync, session restore, Zen's
//   share/migration, anything new) only sets the attribute. This module
//   watches that attribute in every window and repairs it at once:
//   * a move from another space of this window (the tab's own profile) goes
//     back where it came from, then gets the same warning and reopen;
//   * a tab with no earlier space here (new, restored, synced, adopted)
//     goes to a space of its own profile when one exists, else reopens
//     fresh in the space's profile;
//   * a normal tab moved into Scratch goes back: Scratch is private, and a
//     normal tab there would keep writing history and cookies.
// Reopening never carries session history, form data, sessionStorage or
// the page's principal across (WhimsyProfileMoves.reopen: a new tab at the
// same URL with a principal re-keyed to the new container).
//
// Always on: this is isolation, not a feature, and it holds with the
// Profiles switch off too (Zen's own space containers leak the same way).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
  WhimsyProfileMoves: "resource:///modules/whimsy/WhimsyProfileMoves.sys.mjs",
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
});

const ATTR = "zen-workspace-id";
const observers = new WeakMap();
// New tabs waiting their one turn in onRecords: the profile-change sweep
// leaves them alone, or a tab opened in another container (Open Link in New
// Container Tab, a note block's Open) was reopened in place, in the showing
// space's container, before it could go to a space of its own profile.
const pendingFresh = new WeakSet();

export const WhimsyIsolation = {
  // -- the rule -----------------------------------------------------------

  spaceOf(win, id) {
    const spaces = win.gZenWorkspaces;
    if (!id || !spaces) {
      return null;
    }
    return spaces.getWorkspaceFromId?.(id) ?? spaces.getWorkspaces?.().find(space => space.uuid == id) ?? null;
  },

  /** The container a tab in space `id` must use; null for an unknown space. */
  containerOf(win, id) {
    const space = this.spaceOf(win, id);
    return space ? lazy.WhimsyProfiles.profileIdOfSpace(space) : null;
  },

  // Tabs the rule doesn't apply to: Essentials (Zen keeps one strip per
  // container, zen.workspaces.separate-essentials), Zen's shared empty tab
  // (never loads a page: typing in it opens a new tab), glance tabs (they
  // follow their parent tab) and tabs on their way out.
  exempt(tab) {
    return !tab?.isConnected || tab.closing || tab.hasAttribute("zen-essential") ||
      tab.hasAttribute("zen-empty-tab") || tab.hasAttribute("zen-glance-tab");
  },

  /**
   * Whether `tab` sits in a space of another profile. A tab of a container
   * that is no profile (deleted, or never one: Firefox closes a deleted
   * container's tabs) holds no profile's data, so it doesn't count.
   */
  violates(win, tab) {
    if (this.exempt(tab)) {
      return false;
    }
    const own = tab.userContextId ?? 0;
    if (own && !lazy.WhimsyProfiles.exists(own)) {
      return false;
    }
    const expected = this.containerOf(win, tab.getAttribute(ATTR));
    return expected != null && own != expected;
  },

  // -- the watch ----------------------------------------------------------

  initWindow(win) {
    if (observers.has(win) || !win.gZenWorkspaces?.workspaceEnabled || win._whimsyQuickWindow ||
        lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      return;
    }
    // Zen's own move API first (warn, then reopen).
    lazy.WhimsyProfileMoves.wrapMoveTabs(win);
    const observer = new win.MutationObserver(records => this.onRecords(win, records));
    observer.observe(win.document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: [ATTR],
      attributeOldValue: true,
    });
    observers.set(win, observer);
    // A space can change profile without any tab moving (Set Profile from
    // another device through Sync, Zen's own Set Container): its tabs are
    // reopened in place. Set Profile here does that itself (moveSpace).
    let pending = 0;
    const onDataChanged = () => {
      win.clearTimeout(pending);
      pending = win.setTimeout(() => {
        if (!win.closed && !lazy.WhimsyProfileMoves._movingSpace) {
          this.sweep(win);
        }
      }, 0);
    };
    win.addEventListener("ZenWorkspaceDataChanged", onDataChanged);
    // Last line: a tab is never shown in front while it crosses.
    const onSelect = event => {
      const tab = event.target;
      if (!lazy.WhimsyProfileMoves._movingSpace && this.violates(win, tab)) {
        // Not from inside the tab switch itself.
        win.setTimeout(() => {
          if (this.violates(win, tab) && !lazy.WhimsyProfileMoves._movingSpace) {
            // As a new tab: to its own profile's space, else reopened.
            this.repair(win, new Map([[tab, null]]), { interactive: true });
          }
        }, 0);
      }
    };
    win.gBrowser.tabContainer.addEventListener("TabSelect", onSelect);
    // A space's remembered tab must never be one that's gone: Zen selects it
    // on the next switch to that space, and selecting a removed tab leaves
    // the tab switcher on a null browser (every later tab switch hangs).
    // Reopens close tabs often, so clear such entries as tabs close.
    const onClose = event => {
      const last = win.gZenWorkspaces?.lastSelectedWorkspaceTabs;
      for (const [id, tab] of Object.entries(last ?? {})) {
        if (tab == event.target) {
          const replacement = lazy.WhimsyProfileMoves.replacementOf(tab);
          if (replacement != tab && !replacement.closing && replacement.getAttribute(ATTR) == id) {
            last[id] = replacement;
          } else {
            delete last[id];
          }
        }
      }
    };
    win.gBrowser.tabContainer.addEventListener("TabClose", onClose);
    win.addEventListener("unload", () => {
      observer.disconnect();
      observers.delete(win);
      win.removeEventListener("ZenWorkspaceDataChanged", onDataChanged);
      win.gBrowser?.tabContainer?.removeEventListener("TabSelect", onSelect);
      win.gBrowser?.tabContainer?.removeEventListener("TabClose", onClose);
    }, { once: true });
    // Session restore and window sync ran before this window's spaces were
    // ready, and a session saved by an older build can hold tabs that
    // already crossed (dev.580): sort those out once.
    this.sweep(win);
  },

  /** Runs `fn` (a move this module asked for) without reacting to it. */
  quietly(win, fn) {
    const observer = observers.get(win);
    if (observer) {
      this.onRecords(win, observer.takeRecords());
    }
    try {
      return fn();
    } finally {
      observer?.takeRecords();
    }
  },

  sweep(win) {
    const tabs = win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs;
    const crossing = tabs.filter(tab => !pendingFresh.has(tab) && this.violates(win, tab));
    if (crossing.length) {
      this.repair(win, new Map(crossing.map(tab => [tab, null])), { inPlace: true });
    }
  },

  onRecords(win, records) {
    if (!records?.length || win.closed) {
      return;
    }
    // The first old value is where the tab was before this task touched it.
    const from = new Map();
    for (const record of records) {
      const tab = record.target;
      if (win.gBrowser.isTab?.(tab) && !from.has(tab)) {
        from.set(tab, record.oldValue);
      }
    }
    for (const tab of [...from.keys()]) {
      if (!this.violates(win, tab) && !this.intoScratch(win, tab, from.get(tab))) {
        from.delete(tab);
      }
    }
    if (!from.size) {
      return;
    }
    // A move between spaces is put right at once. A tab with no earlier
    // space here waits one turn: openers often add a tab in the showing
    // space and move it to its own right after (Open Link in Space, undo),
    // and nothing can reach the page in between.
    const fresh = new Map([...from].filter(([tab, old]) => !old || !this.spaceOf(win, old)));
    for (const tab of fresh.keys()) {
      from.delete(tab);
    }
    if (from.size) {
      this.repair(win, from, { interactive: true });
    }
    if (fresh.size) {
      for (const tab of fresh.keys()) {
        pendingFresh.add(tab);
      }
      win.setTimeout(() => {
        for (const tab of fresh.keys()) {
          pendingFresh.delete(tab);
        }
        const still = new Map([...fresh].filter(([tab]) => this.violates(win, tab)));
        if (still.size && !win.closed) {
          this.repair(win, still, { interactive: true });
        }
      }, 0);
    }
  },

  // A normal tab moved from a space of this window into Scratch.
  intoScratch(win, tab, from) {
    const to = tab.getAttribute(ATTR);
    return !this.exempt(tab) && !!from && from != to && !!this.spaceOf(win, from) &&
      lazy.WhimsyPrivate.isScratchId(win, to) && !lazy.WhimsyProfileMoves.isPrivate(tab) &&
      !lazy.WhimsyPrivate.isScratchId(win, from);
  },

  // -- the repair ---------------------------------------------------------

  /** `tabs`: Map of tab → the space it came from (null: none here). */
  // `interactive`: it just happened in this window (not the startup sweep),
  // so a selected tab is followed to its space.
  // `inPlace`: the tab didn't move, its space changed profile (or an older
  // session saved it crossed): it reopens where it is.
  repair(win, tabs, { interactive = false, inPlace = false } = {}) {
    const moves = new Map();
    const homeless = [];
    let sorted = 0;
    let reopened = 0;
    let scratch = 0;
    for (const [tab, from] of tabs) {
      if (tab.closing || !tab.isConnected) {
        continue;
      }
      const to = tab.getAttribute(ATTR);
      const own = tab.userContextId ?? 0;
      if (this.intoScratch(win, tab, from) && !this.violates(win, tab)) {
        this.putBack(win, [tab], from);
        scratch++;
        continue;
      }
      if (inPlace) {
        homeless.push(tab);
        continue;
      }
      if (from && from != to && this.containerOf(win, from) === own) {
        // Moved here from its own profile's space: back, then ask.
        const entry = moves.get(to) ?? { tabs: [], from: new Map() };
        entry.tabs.push(tab);
        entry.from.set(tab, from);
        moves.set(to, entry);
        continue;
      }
      // No earlier space here: its own profile's space, if this window has one.
      const home = this.homeFor(win, tab);
      if (home) {
        const selected = win.gBrowser.selectedTab == tab;
        this.quietly(win, () => this.moveTo(win, [tab], home.uuid));
        if (interactive && selected && home.uuid != win.gZenWorkspaces.activeWorkspace) {
          win.gZenWorkspaces.lastSelectedWorkspaceTabs[home.uuid] = tab;
          win.gZenWorkspaces.changeWorkspace(home).catch?.(e => console.error("Whimsy: isolation", e));
        }
        sorted++;
      } else {
        homeless.push(tab);
      }
    }

    for (const [to, { tabs: moved, from }] of moves) {
      for (const [back, group] of this.bySource(moved, from)) {
        this.putBack(win, group, back);
      }
      // Window sync mirrors a move into the other windows; only the window
      // the person acted in asks (the others just put it back).
      if (interactive && this.isFront(win)) {
        const entries = moved.map(tab => ({ tab, from: from.get(tab), item: tab }));
        lazy.WhimsyProfileMoves.confirmTabMove(win, entries, to)
          .catch(e => console.error("Whimsy: isolation", e));
      }
    }

    // No space of its profile here: it stays in its space, reopened fresh
    // in that space's profile.
    for (const tab of homeless) {
      const to = tab.getAttribute(ATTR);
      const id = this.containerOf(win, to);
      if (id != null && !tab.closing) {
        lazy.WhimsyProfileMoves.reopen(win, tab, id, to);
        reopened++;
      }
    }

    if (sorted) {
      win.gZenUIManager?.showToast?.("whimsy-isolation-sorted-toast", { l10nArgs: { count: sorted } });
    }
    if (reopened) {
      win.gZenUIManager?.showToast?.("whimsy-isolation-reopened-toast", { l10nArgs: { count: reopened } });
    }
    if (scratch) {
      win.gZenUIManager?.showToast?.("whimsy-isolation-scratch-toast", { l10nArgs: { count: scratch } });
    }
  },

  isFront(win) {
    return Services.wm.getMostRecentWindow("navigator:browser") == win;
  },

  bySource(tabs, from) {
    const out = new Map();
    for (const tab of tabs) {
      const key = from.get(tab);
      out.set(key, [...(out.get(key) ?? []), tab]);
    }
    return out;
  },

  /** A space of this window in `tab`'s profile (its last one first). */
  homeFor(win, tab) {
    const own = tab.userContextId ?? 0;
    const spaces = (win.gZenWorkspaces.getWorkspaces?.() ?? []).filter(space =>
      lazy.WhimsyProfiles.profileIdOfSpace(space) === own && !space.whimsyScratch);
    if (!spaces.length) {
      return null;
    }
    const active = spaces.find(space => space.uuid == win.gZenWorkspaces.activeWorkspace);
    return active ?? spaces[0];
  },

  // Zen's own move, unwrapped: these tabs are already known to fit.
  moveTo(win, tabs, spaceId) {
    const workspaces = win.gZenWorkspaces;
    const move = workspaces.moveTabsToWorkspace._whimsyOriginal ?? workspaces.moveTabsToWorkspace;
    move.call(workspaces, tabs, spaceId);
    for (const tab of tabs) {
      if (!tab.closing && tab.getAttribute(ATTR) != spaceId) {
        tab.setAttribute(ATTR, spaceId);
      }
    }
  },

  // Zen's changeFolderToSpace, without its switch to that space and the
  // async re-index that follows (it threw on a folder whose tab was being
  // reopened meanwhile): the folder moves into the space's pinned list.
  moveFolder(win, folder, spaceId) {
    const pinned = win.gZenWorkspaces.workspaceElement(spaceId)?.pinnedTabsContainer;
    if (pinned && folder.parentElement != pinned) {
      pinned.insertBefore(folder, pinned.lastChild);
    }
    win.gZenFolders.changeFolderToSpace(folder, spaceId, { hasDndSwitch: true });
  },

  /** Puts `tabs` back in space `from` (a folder goes back whole). */
  putBack(win, tabs, from) {
    this.quietly(win, () => {
      const folders = new Set();
      const loose = [];
      for (const tab of tabs) {
        const group = tab.group;
        if (group?.isZenFolder && group.getAttribute(ATTR) != from) {
          folders.add(group);
        } else {
          loose.push(tab);
        }
      }
      for (const folder of folders) {
        try {
          this.moveFolder(win, folder, from);
        } catch (e) {
          console.error("Whimsy: isolation, folder back", e);
        }
        loose.push(...folder.tabs.filter(tab => tab.getAttribute(ATTR) != from));
      }
      if (loose.length) {
        this.moveTo(win, loose, from);
      }
    });
    // A tab dropped onto a space was selected there; the showing space keeps
    // a tab of its own selected.
    const { gBrowser, gZenWorkspaces } = win;
    if (tabs.includes(gBrowser.selectedTab) && from != gZenWorkspaces.activeWorkspace) {
      const live = lazy.WhimsyProfileMoves.liveTabInView(win, tabs);
      if (live) {
        gBrowser.selectedTab = live;
      }
    }
  },
};
