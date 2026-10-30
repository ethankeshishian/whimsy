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

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
});

const focusedTabs = new WeakMap();

const FEATURE_PREF = "whimsy.feature.sidebar-nav";

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
      isAvailable: () => this.enabled,
    });
    lazy.WhimsyCommands.register(win, {
      id: "whimsy-tab-prev",
      l10nId: "whimsy-action-tab-prev",
      run: guard(w => cycle(w, -1)),
      keyId: "key_whimsyTabPrev",
      key: { modifiers: "accel,alt", keycode: "VK_UP" },
      icon,
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
      if (!this.enabled || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) {
        return;
      }
      const tab = focusedTabs.get(win);
      const focus = win.document.activeElement;
      if (!tab || !win.gBrowser.tabContainer.contains(focus)) {
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
      if (focusedTabs.has(win) && !win.gBrowser.tabContainer.contains(event.relatedTarget)) {
        this.clearFocus(win);
      }
    });

    win.gBrowser.tabContainer.addEventListener(
      "keypress",
      event => {
        if (event.key != " " || !this.enabled) {
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
