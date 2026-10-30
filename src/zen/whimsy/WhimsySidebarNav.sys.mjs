/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Keyboard sidebar navigation (Arc): Cmd+Opt+Up/Down goes to the previous or
// next tab in sidebar order (across essentials, folders and pinned tabs,
// skipping collapsed folders), and "Focus Sidebar" moves keyboard focus into
// the tab strip so Up/Down/Enter/Delete/Esc work without a mouse. Firefox
// already handles Up/Down/Enter/Delete/Esc once a tab has focus
// (tabs.mjs on_keydown); the hard part Zen doesn't solve is reaching the
// strip at all. This also adds Space to open a Glance for the focused tab,
// a peek that doesn't change your selected tab.
// whimsy.feature.sidebar-nav; off hands all three keys back to Zen (unbound).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
});

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
    lazy.WhimsyShortcuts.addCommand(win, {
      id: "whimsy-tab-next",
      run: guard(w => cycle(w, 1)),
      key: { id: "key_whimsyTabNext", modifiers: "accel,alt", keycode: "VK_DOWN" },
    });
    lazy.WhimsyShortcuts.addCommand(win, {
      id: "whimsy-tab-prev",
      run: guard(w => cycle(w, -1)),
      key: { id: "key_whimsyTabPrev", modifiers: "accel,alt", keycode: "VK_UP" },
    });
    lazy.WhimsyShortcuts.addCommand(win, {
      id: "whimsy-focus-sidebar",
      run: guard(w => this.focusSidebar(w)),
      // No default key: Cmd+Opt+S is Zen's "show sidebar" in compact mode.
    });

    // Firefox's tab-strip keyboard navigation requires Accel for arrows
    // and does not bind Delete. Our explicit sidebar-focus mode offers the
    // plain keys without changing normal tab-strip shortcuts.
    win.addEventListener("keydown", event => {
      if (!this.enabled || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) {
        return;
      }
      const tab = event.target.closest?.("tab, .tabbrowser-tab");
      if (!tab?.hasAttribute("whimsy-sidebar-focused")) {
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
          tab.removeAttribute("whimsy-sidebar-focused");
          win.gBrowser.selectedBrowser.focus();
          break;
        default:
          return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);

    win.gBrowser.tabContainer.addEventListener(
      "keypress",
      event => {
        if (event.key != " " || !this.enabled) {
          return;
        }
        const tab = event.target.closest?.("tab, .tabbrowser-tab");
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

  focusTab(tab) {
    tab.setAttribute("whimsy-sidebar-focused", "");
    tab.focus();
    const clear = () => tab.removeAttribute("whimsy-sidebar-focused");
    tab.addEventListener("blur", clear, { once: true });
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
