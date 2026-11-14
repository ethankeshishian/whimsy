/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// w27-tabkeys: Move Tab Up / Move Tab Down. Ctrl+Shift+Up/Down (rebindable
// like any other Whimsy command) steps the current tab one place toward the
// start or end of the strip, the same way gBrowser.moveTabBackward/
// moveTabForward do (entering or skipping a collapsed tab group, leaving a
// group at its edge) — but never across the pinned/essentials boundary,
// since essential tabs also report pinned == true and the native filter
// alone can't tell them apart. WhimsySidebarNav's Option+Up/Down (keyboard
// tree navigation, w27-tabkeys item 2) reuses move() below to move the
// sidebar's focused tab, which isn't always gBrowser.selectedTab.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.move-tab";
export const DIRECTION_BACKWARD = -1;
export const DIRECTION_FORWARD = 1;

function edgeTab(tab, direction) {
  if (!tab.splitview) {
    return tab;
  }
  return direction > 0 ? tab.splitview.lastElementChild : tab.splitview.firstElementChild;
}

function neighborOf(win, tab, direction) {
  return win.gBrowser.tabContainer.findNextTab(edgeTab(tab, direction), {
    direction,
    filter: t => !t.hidden && tab.pinned == t.pinned,
  });
}

// Essentials are a subset of pinned tabs (essential tabs also report
// pinned == true), so the native pinned == pinned filter alone would let a
// move cross from the essentials row into the rest of the pinned row, or
// back. Treat that as the strip's edge: no move.
function crossesEssentialsBoundary(tab, neighbor) {
  return !!neighbor && neighbor.hasAttribute("zen-essential") != tab.hasAttribute("zen-essential");
}

export const WhimsyTabMove = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  initWindow(win) {
    const guard = fn => w => {
      if (this.enabled) {
        fn(w);
      }
    };
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyMoveTabUp",
      l10nId: "whimsy-action-move-tab-up",
      run: guard(w => this.moveSelected(w, DIRECTION_BACKWARD)),
      keyId: "key_whimsyMoveTabUp",
      key: { keycode: "VK_UP", modifiers: "control,shift" },
      icon: "chrome://browser/skin/zen-icons/arrow-up.svg",
      menu: "whimsy-tabs-menubar",
      isAvailable: w => this.enabled && this.canMove(w, w.gBrowser.selectedTab, DIRECTION_BACKWARD),
    });
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyMoveTabDown",
      l10nId: "whimsy-action-move-tab-down",
      run: guard(w => this.moveSelected(w, DIRECTION_FORWARD)),
      keyId: "key_whimsyMoveTabDown",
      key: { keycode: "VK_DOWN", modifiers: "control,shift" },
      icon: "chrome://browser/skin/zen-icons/arrow-down.svg",
      menu: "whimsy-tabs-menubar",
      isAvailable: w => this.enabled && this.canMove(w, w.gBrowser.selectedTab, DIRECTION_FORWARD),
    });
  },

  // Whether `tab` can move one step in `direction` without crossing the
  // pinned/essentials boundary. Moving out of the end of a tab group is
  // always allowed (there's no neighbor at that pinned level to compare).
  canMove(win, tab, direction) {
    if (!this.enabled || !tab || tab.closing || !tab.isConnected) {
      return false;
    }
    const neighbor = neighborOf(win, tab, direction);
    if (neighbor) {
      return !crossesEssentialsBoundary(tab, neighbor);
    }
    return !!tab.group;
  },

  moveSelected(win, direction) {
    return this.move(win, win.gBrowser.selectedTab, direction);
  },

  // Moves `tab` one step toward the start (-1) or end (+1) of the strip.
  // When `tab` is the selected tab this is exactly
  // gBrowser.moveTabBackward()/moveTabForward(); WhimsySidebarNav's
  // Option+Up/Down (item 2) calls it for its own focused tab, which can
  // differ from gBrowser.selectedTab, so the group-entry logic below
  // mirrors Tabbrowser.sys.mjs's moveTabForward/moveTabBackward for an
  // arbitrary tab via the public gBrowser.zenHandleTabMove.
  move(win, tab, direction) {
    if (!this.canMove(win, tab, direction)) {
      return false;
    }
    if (tab == win.gBrowser.selectedTab) {
      if (direction > 0) {
        win.gBrowser.moveTabForward();
      } else {
        win.gBrowser.moveTabBackward();
      }
      return true;
    }
    const { gBrowser } = win;
    const tabOrSplit = tab.splitview || tab;
    const neighbor = neighborOf(win, tab, direction);
    if (!neighbor) {
      // No same-pinned-state neighbor: tab is leaving its group at the edge
      // of the pinned or unpinned region. Route the raw DOM move through
      // zenHandleTabMove so cached indices/allItems stay correct afterward
      // (tab.mjs's `index` getter is a cached `_index`, only refreshed by
      // the housekeeping zenHandleTabMove runs).
      gBrowser.zenHandleTabMove(tab, () => {
        if (direction > 0) {
          tab.group.after(tabOrSplit);
        } else {
          tab.group.before(tabOrSplit);
        }
      });
      return true;
    }
    const neighborOrSplit = neighbor.splitview || neighbor;
    gBrowser.zenHandleTabMove(tab, () => {
      if (direction > 0) {
        if (!tab.group && neighbor.group) {
          if (neighborOrSplit.group.collapsed) {
            neighborOrSplit.group.after(tabOrSplit);
          } else {
            // Enter the front of an expanded group. neighborOrSplit is the
            // group's current first member, so insert relative to it
            // directly rather than via the group host: a Zen folder's
            // members live inside its groupContainer div, one level below
            // the host, and insertBefore()/append() called on the host
            // itself aren't redirected there the way appendChild() is (see
            // tabgroup.mjs), so they'd land the tab outside the folder.
            neighborOrSplit.before(tabOrSplit);
          }
        } else if (tab.group != neighbor.group) {
          tab.group.after(tabOrSplit);
        } else {
          neighborOrSplit.after(tabOrSplit);
        }
      } else if (!tab.group && neighbor.group) {
        if (neighbor.group.collapsed) {
          neighbor.group.before(tabOrSplit);
        } else {
          // Enter the back of an expanded group; see the comment above.
          neighborOrSplit.after(tabOrSplit);
        }
      } else if (tab.group != neighbor.group) {
        tab.group.before(tabOrSplit);
      } else {
        neighborOrSplit.before(tabOrSplit);
      }
    });
    return true;
  },
};
