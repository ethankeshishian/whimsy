/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Keyboard sidebar navigation (Arc): Cmd+Opt+Up/Down goes to the previous or
// next tab in sidebar order (across essentials, folders and pinned tabs,
// skipping collapsed folders), and "Focus Sidebar" moves keyboard focus into
// the tab strip so Up/Down/Enter/Delete/Esc work without a mouse. Firefox
// uses ariaFocusedItem for keyboard navigation while DOM focus stays on
// the selected tab. This also adds Space to open a Glance for the focused tab,
// a peek that doesn't change your selected tab.
// whimsy.feature.sidebar-nav; off hands all three keys back to Zen (unbound).
//
// w27-tabkeys: with the sidebar focused, Left collapses the focused tree-tab
// parent (WhimsyTreeTabs) or the Zen folder it sits in, or — on a leaf, or a
// parent/folder that's already collapsed — moves focus to its parent; Right
// is the reverse (expand). Option+Up/Down moves the focused tab, via
// WhimsyTabMove.move() (the same code as the Move Tab Up/Down commands).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyTabMove: "resource:///modules/whimsy/WhimsyTabMove.sys.mjs",
  WhimsyTreeTabs: "resource:///modules/whimsy/WhimsyTreeTabs.sys.mjs",
});

const focusedTabs = new WeakMap();

const FEATURE_PREF = "whimsy.feature.sidebar-nav";

// The sidebar-focus keys belong to a tab with keyboard focus, never to a
// field in the tab strip (the New Space form's name, a folder being
// renamed): there Space, Delete and the arrows edit text.
function onTab(win, el) {
  return el?.localName == "tab" && win.gBrowser.tabContainer.contains(el);
}

function visibleTabs(win) {
  return win.gBrowser.visibleTabs.filter(t => !t.collapsed && !t.hidden);
}

function cycle(win, direction) {
  const tabs = visibleTabs(win);
  if (tabs.length < 2) {
    return;
  }
  const index = tabs.indexOf(win.gBrowser.selectedTab);
  const next = tabs[(index + direction + tabs.length) % tabs.length];
  win.gBrowser.selectedTab = next;
}

function folderOf(tab) {
  return tab?.group?.isZenFolder ? tab.group : null;
}

// Nearest visible tab outside `group`, searching outward from `tab`'s
// current position (before collapsing hides the rest of the group). Used
// when Left collapses the group the focused tab is in.
function nearestOutside(win, tab, group) {
  const tabs = visibleTabs(win);
  const index = tabs.indexOf(tab);
  for (let i = index - 1; i >= 0; i--) {
    if (tabs[i].group != group) {
      return tabs[i];
    }
  }
  for (let i = index + 1; i < tabs.length; i++) {
    if (tabs[i].group != group) {
      return tabs[i];
    }
  }
  return null;
}

export const WhimsySidebarNav = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  initWindow(win) {
    const guard = fn => w => {
      if (this.enabled) {
        fn(w);
      }
    };
    const icon = "chrome://browser/skin/zen-icons/sidebar.svg";
    lazy.WhimsyCommands.register(win, {
      id: "whimsy-tab-next",
      l10nId: "whimsy-action-tab-next",
      run: guard(w => cycle(w, 1)),
      keyId: "key_whimsyTabNext",
      key: { modifiers: "accel,alt", keycode: "VK_DOWN" },
      icon,
      // W26 audit: Zen's bar already lists Next Tab and Previous Tab; one row each.
      commandBar: false,
      isAvailable: () => this.enabled,
    });
    lazy.WhimsyCommands.register(win, {
      id: "whimsy-tab-prev",
      l10nId: "whimsy-action-tab-prev",
      run: guard(w => cycle(w, -1)),
      keyId: "key_whimsyTabPrev",
      key: { modifiers: "accel,alt", keycode: "VK_UP" },
      icon,
      commandBar: false,
      isAvailable: () => this.enabled,
    });
    // wave5: in the command bar and about:keyboard, unbound by default:
    // the Cmd+Opt+S once promised is Zen's "show sidebar" in compact mode,
    // and Arc has no default to follow.
    lazy.WhimsyCommands.register(win, {
      id: "whimsy-focus-sidebar",
      l10nId: "whimsy-action-focus-sidebar",
      run: guard(w => this.focusSidebar(w)),
      keyId: "key_whimsyFocusSidebar",
      icon,
      isAvailable: () => this.enabled,
    });

    // Firefox's tab-strip keyboard navigation requires Accel for arrows
    // and does not bind Delete. Our explicit sidebar-focus mode offers the
    // plain keys without changing normal tab-strip shortcuts.
    win.addEventListener("keydown", event => {
      if (!this.enabled) {
        return;
      }
      const tab = this.focusedTab(win);
      if (!tab) {
        return;
      }
      // Option+Up/Down: move the focused tab, same code as Move Tab Up/Down.
      if (
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        (event.key == "ArrowUp" || event.key == "ArrowDown")
      ) {
        lazy.WhimsyTabMove.move(win, tab, event.key == "ArrowUp" ? -1 : 1);
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) {
        return;
      }
      const tabs = visibleTabs(win);
      const index = tabs.indexOf(tab);
      if (index < 0) {
        return;
      }
      switch (event.key) {
        case "ArrowUp":
        case "ArrowDown": {
          const direction = event.key == "ArrowUp" ? -1 : 1;
          this.focusTab(tabs[(index + direction + tabs.length) % tabs.length]);
          break;
        }
        case "ArrowLeft":
          this.collapseOrFocusParent(win, tab);
          break;
        case "ArrowRight":
          this.expand(win, tab);
          break;
        case "Enter":
          win.gBrowser.selectedTab = tab;
          this.focusTab(tab);
          break;
        case "Delete":
        case "Backspace":
          win.gBrowser.removeTab(tab, { animate: true });
          break;
        case "Escape":
          this.clearFocus(win);
          win.gBrowser.selectedBrowser.focus();
          break;
        default:
          return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);

    win.gBrowser.tabContainer.addEventListener("focusout", event => {
      if (focusedTabs.has(win) && !onTab(win, event.relatedTarget)) {
        this.clearFocus(win);
      }
    });

    win.gBrowser.tabContainer.addEventListener(
      "keypress",
      event => {
        if (event.key != " " || !this.enabled || !onTab(win, event.target)) {
          return;
        }
        const tab = focusedTabs.get(win);
        if (tab) {
          event.preventDefault();
          this.glance(win, tab);
        }
      },
      true
    );
  },

  focusSidebar(win) {
    this.focusTab(win.gBrowser.selectedTab);
  },

  // The tab sidebar-keyboard-focus is on, or null if the sidebar doesn't
  // currently hold DOM focus (so a stray keydown after focus moved to a
  // field, the page, etc. is a no-op). WhimsyPasteTabs reuses this to gate
  // Cmd+V/Cmd+X on the sidebar being focused.
  focusedTab(win) {
    const tab = focusedTabs.get(win);
    return tab && onTab(win, win.document.activeElement) ? tab : null;
  },

  // Left: collapse the focused tree-tab parent (WhimsyTreeTabs) or the Zen
  // folder it's in; on a leaf, or one that's already collapsed, move focus
  // to its parent instead (the tree-tab opener, or the nearest tab outside
  // the folder).
  collapseOrFocusParent(win, tab) {
    if (lazy.WhimsyTreeTabs.hasChildren(win, tab) && !tab.hasAttribute("whimsy-tree-collapsed")) {
      lazy.WhimsyTreeTabs.toggleBranch(win, tab);
      return;
    }
    const group = folderOf(tab);
    if (group && !group.collapsed) {
      const fallback = nearestOutside(win, tab, group);
      group.collapsed = true;
      // Zen keeps the active/selected tab of a collapsed folder visible as
      // a stand-in (tab.mjs's `visible` getter); keep focus there when
      // that's this tab, otherwise fall back to a tab outside the folder.
      this.focusTab(tab.visible ? tab : fallback ?? win.gBrowser.selectedTab);
      return;
    }
    const parent = lazy.WhimsyTreeTabs.openerOf(tab);
    if (parent && visibleTabs(win).includes(parent)) {
      this.focusTab(parent);
      return;
    }
    if (group) {
      const fallback = nearestOutside(win, tab, group);
      if (fallback) {
        this.focusTab(fallback);
      }
    }
  },

  // Right: expand the focused tree-tab parent or Zen folder. No-op on a
  // leaf with nothing to expand.
  expand(win, tab) {
    if (tab.hasAttribute("whimsy-tree-collapsed")) {
      lazy.WhimsyTreeTabs.toggleBranch(win, tab);
      return;
    }
    const group = folderOf(tab);
    if (group?.collapsed) {
      group.collapsed = false;
    }
  },

  clearFocus(win) {
    focusedTabs.get(win)?.removeAttribute("whimsy-sidebar-focused");
    focusedTabs.delete(win);
    win.gBrowser.tabContainer.ariaFocusedItem = null;
  },

  focusTab(tab) {
    const win = tab.ownerDocument.defaultView;
    focusedTabs.get(win)?.removeAttribute("whimsy-sidebar-focused");
    // XUL's tab strip keeps DOM focus on the selected tab. Moving DOM focus
    // to an unselected tab can fail; key events still target the selected
    // tab. Keep the navigation cursor separately, as Firefox does.
    win.gBrowser.selectedTab.focus();
    win.gBrowser.tabContainer.ariaFocusedItem = tab;
    focusedTabs.set(win, tab);
    tab.setAttribute("whimsy-sidebar-focused", "");
  },

  glance(win, tab) {
    const browser = tab.linkedBrowser;
    const uri = browser?.currentURI;
    if (!uri || !win.gZenGlanceManager) {
      return;
    }
    win.gZenGlanceManager.openGlance({
      url: uri.spec,
      triggeringPrincipal: browser.contentPrincipal,
    });
  },
};
