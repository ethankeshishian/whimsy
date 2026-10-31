/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave6/parity: Arc's Split View commands and keys (View menu, Arc Help
// Center). Zen's own split keys (Cmd+Opt+V/H/G/U, Cmd+Shift+*) stay as
// they are; these are extra.
//
// - Add Split View, Ctrl+Shift+=: a new empty pane beside this page, with
//   the command bar open to fill it (Zen's "new empty split").
// - Close this Split Pane, Ctrl+Shift+-: closes (archives) the focused pane.
// - Separate Page from Split View: takes the focused page out of the
//   split, as its own tab, and keeps it in front.
// - Expand Current Split: Zen's unsplit ("Expand current view"): every
//   pane goes back to being its own tab.
// - Ctrl+Shift+1-4 focus the first to fourth pane; Ctrl+Shift+[ and ]
//   focus the previous and next pane.
//
// The Ctrl+Shift keys are registered by keycode so about:keyboard lists
// and rebinds them, but a <key> only matches keypress, whose character is
// the shifted one ("+", "!", "{"), so they would never fire; and
// Ctrl+Shift+1 would fall through to Zen's Ctrl+1 (switch space). A
// keydown listener runs them by physical key while each <key> keeps its
// default binding, the way WhimsyPage runs Cmd+Shift+1/2.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.split-arc-keys";
const MODIFIERS = "control,shift";
const ICON = "chrome://browser/skin/zen-icons/split.svg";

// event.code → [key id, keycode].
const PHYSICAL_KEYS = {
  Equal: ["key_whimsyAddSplitView", "VK_EQUALS"],
  Minus: ["key_whimsyCloseSplitPane", "VK_HYPHEN_MINUS"],
  Digit1: ["key_whimsyFocusPane1", "VK_1"],
  Digit2: ["key_whimsyFocusPane2", "VK_2"],
  Digit3: ["key_whimsyFocusPane3", "VK_3"],
  Digit4: ["key_whimsyFocusPane4", "VK_4"],
  BracketLeft: ["key_whimsyPrevPane", "VK_OPEN_BRACKET"],
  BracketRight: ["key_whimsyNextPane", "VK_CLOSE_BRACKET"],
};

function enabled() {
  return Services.prefs.getBoolPref(FEATURE_PREF, true);
}

function keycodeFor(keyId) {
  return Object.values(PHYSICAL_KEYS).find(([id]) => id == keyId)?.[1];
}

export const WhimsySplitKeys = {
  get enabled() {
    return enabled();
  },

  // The selected tab's split, or null.
  currentGroup(win) {
    const tab = win.gBrowser.selectedTab;
    return (tab?.splitView && win.gZenViewSplitter?._data.find(g => g.tabs.includes(tab))) || null;
  },

  // The split's panes in the order they're laid out (left to right, top to
  // bottom), which is what "first pane" means to the person looking.
  panes(group) {
    const out = [];
    const walk = node => {
      if (!node) {
        return;
      }
      if (node.tab) {
        out.push(node.tab);
      }
      for (const child of node.children ?? []) {
        walk(child);
      }
    };
    walk(group.layoutTree);
    return out.length == group.tabs.length ? out : [...group.tabs];
  },

  addSplitView(win) {
    win.document.getElementById("cmd_zenNewEmptySplit")?.doCommand();
  },

  closePane(win) {
    const tab = win.gBrowser.selectedTab;
    if (!this.currentGroup(win)) {
      return false;
    }
    win.gZenViewSplitter.removeTabFromGroup(tab, undefined, { forUnsplit: true, changeTab: true });
    win.gBrowser.removeTab(tab, { animate: true });
    return true;
  },

  separatePage(win) {
    const tab = win.gBrowser.selectedTab;
    if (!this.currentGroup(win)) {
      return false;
    }
    win.gZenViewSplitter.removeTabFromGroup(tab, undefined, { forUnsplit: true, changeTab: false });
    win.gBrowser.selectedTab = tab;
    return true;
  },

  expandSplit(win) {
    win.document.getElementById("cmd_zenSplitViewUnsplit")?.doCommand();
  },

  focusPane(win, index) {
    const group = this.currentGroup(win);
    const tab = group && this.panes(group)[index];
    if (tab) {
      win.gBrowser.selectedTab = tab;
    }
    return !!tab;
  },

  cyclePane(win, step) {
    const group = this.currentGroup(win);
    if (!group) {
      return false;
    }
    const panes = this.panes(group);
    const i = panes.indexOf(win.gBrowser.selectedTab);
    win.gBrowser.selectedTab = panes[(i + step + panes.length) % panes.length];
    return true;
  },

  initWindow(win) {
    const { WhimsyCommands } = lazy;
    const inSplit = w => enabled() && !!this.currentGroup(w);
    const commands = [
      {
        id: "cmd_whimsyAddSplitView",
        l10nId: "whimsy-action-add-split-view",
        run: w => this.addSplitView(w),
        keyId: "key_whimsyAddSplitView",
        isAvailable: () => enabled(),
      },
      {
        id: "cmd_whimsyCloseSplitPane",
        l10nId: "whimsy-action-close-split-pane",
        run: w => this.closePane(w),
        keyId: "key_whimsyCloseSplitPane",
        isAvailable: inSplit,
      },
      {
        id: "cmd_whimsySeparatePage",
        l10nId: "whimsy-action-separate-page",
        run: w => this.separatePage(w),
        isAvailable: inSplit,
      },
      {
        id: "cmd_whimsyExpandSplit",
        l10nId: "whimsy-action-expand-split",
        run: w => this.expandSplit(w),
        isAvailable: inSplit,
      },
      ...[1, 2, 3, 4].map(n => ({
        id: `cmd_whimsyFocusPane${n}`,
        l10nId: `whimsy-action-focus-pane-${n}`,
        run: w => this.focusPane(w, n - 1),
        keyId: `key_whimsyFocusPane${n}`,
        commandBar: false,
      })),
      {
        id: "cmd_whimsyPrevPane",
        l10nId: "whimsy-action-prev-pane",
        run: w => this.cyclePane(w, -1),
        keyId: "key_whimsyPrevPane",
        commandBar: false,
      },
      {
        id: "cmd_whimsyNextPane",
        l10nId: "whimsy-action-next-pane",
        run: w => this.cyclePane(w, 1),
        keyId: "key_whimsyNextPane",
        commandBar: false,
      },
    ];
    for (const spec of commands) {
      const keycode = spec.keyId && keycodeFor(spec.keyId);
      WhimsyCommands.register(win, {
        icon: ICON,
        ...spec,
        key: keycode && enabled() ? { keycode, modifiers: MODIFIERS } : null,
      });
    }
    win.addEventListener("keydown", event => this.onKeyDown(win, event), true);
    this.initViewMenu(win);
  },

  // Arc's View menu lists the four split commands before the zoom items.
  initViewMenu(win) {
    const { document } = win;
    const anchor = document.getElementById("viewFullZoomMenu");
    if (!anchor || document.getElementById("menu_whimsyAddSplitView")) {
      return;
    }
    const items = [
      ["menu_whimsyAddSplitView", "whimsy-menu-add-split-view", "cmd_whimsyAddSplitView", "key_whimsyAddSplitView"],
      ["menu_whimsyCloseSplitPane", "whimsy-menu-close-split-pane", "cmd_whimsyCloseSplitPane", "key_whimsyCloseSplitPane"],
      ["menu_whimsySeparatePage", "whimsy-menu-separate-page", "cmd_whimsySeparatePage", null],
      ["menu_whimsyExpandSplit", "whimsy-menu-expand-split", "cmd_whimsyExpandSplit", null],
    ].map(([id, l10nId, command, key]) => {
      const item = document.createXULElement("menuitem");
      item.id = id;
      item.setAttribute("data-l10n-id", l10nId);
      item.setAttribute("command", command);
      if (key) {
        item.setAttribute("key", key);
      }
      return item;
    });
    const separator = document.createXULElement("menuseparator");
    separator.id = "menu_whimsySplitSeparator";
    anchor.before(...items, separator);
    // The pane commands only apply inside a split; dim them otherwise (the
    // items stay put, so the menu never shifts).
    anchor.parentElement.addEventListener("popupshowing", event => {
      if (event.target != anchor.parentElement) {
        return;
      }
      const on = enabled();
      const inSplit = on && !!this.currentGroup(win);
      for (const item of items) {
        item.hidden = !on;
        item.disabled = item.id != "menu_whimsyAddSplitView" && !inSplit;
      }
      separator.hidden = !on;
    });
  },

  onKeyDown(win, event) {
    if (
      event.defaultPrevented ||
      !enabled() ||
      !event.ctrlKey ||
      !event.shiftKey ||
      event.altKey ||
      event.metaKey
    ) {
      return;
    }
    const [keyId, keycode] = PHYSICAL_KEYS[event.code] ?? [];
    const keyEl = keyId && win.document.getElementById(keyId);
    // Only while the key still has its default; a person who rebound it
    // in about:keyboard gets their binding through the normal <key> path.
    if (
      !keyEl ||
      keyEl.getAttribute("disabled") == "true" ||
      keyEl.getAttribute("keycode") != keycode ||
      keyEl.getAttribute("modifiers") != MODIFIERS
    ) {
      return;
    }
    const command = win.document.getElementById(keyEl.getAttribute("command"));
    if (!command || command.getAttribute("disabled") == "true") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) {
      command.doCommand();
    }
  },
};
