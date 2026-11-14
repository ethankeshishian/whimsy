/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// w27-tabkeys: Paste Tabs. Copy already exists (WhimsyCopy, Cmd+Shift+C /
// Copy Links); this is the paste side, scoped to the sidebar's keyboard
// focus (WhimsySidebarNav) so it never competes with the native Cmd+V/Cmd+X
// that a text field or the page itself expects:
// - with the sidebar focused, Cmd+V reads the clipboard's http(s) URLs (one
//   per line, ignoring any other text, capped at MAX_PASTE_URLS) and opens
//   them as background tabs right below the focused tab;
// - Cmd+X marks the current tab (or the multi-selection, if several tabs are
//   selected) to move; the next Cmd+V with the sidebar focused moves them to
//   just after the newly focused tab instead of opening the clipboard,
//   crossing spaces if the focused tab is in a different one;
// - "Paste Tabs" is also a WhimsyCommands entry (command bar/about:keyboard),
//   with no default shortcut — Cmd+V/Cmd+X stay a sidebar-focus-only gesture.
// whimsy.feature.paste-tabs; off leaves Cmd+V/Cmd+X entirely to Zen/Firefox.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsySidebarNav: "resource:///modules/whimsy/WhimsySidebarNav.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.paste-tabs";
export const MAX_PASTE_URLS = 50;
const URL_LINE_RE = /^https?:\/\/\S+$/i;

// tab(s) a Cmd+X marked, per window; one-shot (cleared by the move it feeds,
// or replaced by a later Cmd+X).
const cutTabs = new WeakMap();

// http(s) URLs on the clipboard: one per line, other lines ignored, capped.
export function parseUrls(text) {
  const urls = [];
  if (!text) {
    return urls;
  }
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!line || !URL_LINE_RE.test(line)) {
      continue;
    }
    try {
      urls.push(Services.io.newURI(line).spec);
    } catch (e) {
      continue;
    }
    if (urls.length >= MAX_PASTE_URLS) {
      break;
    }
  }
  return urls;
}

export const WhimsyPasteTabs = {
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
      id: "cmd_whimsyPasteTabs",
      l10nId: "whimsy-action-paste-tabs",
      run: guard(w => this.paste(w)),
      icon: "chrome://browser/skin/zen-icons/edit-paste.svg",
      menu: "whimsy-tabs-menubar",
      isAvailable: w => this.enabled && !!this.anchorTab(w),
    });

    // Capture phase, ahead of the editor commandset: only ever acts while
    // the sidebar holds keyboard focus (WhimsySidebarNav.focusedTab), the
    // same guard that keeps its own arrow/Enter/Delete keys off a text
    // field or the page, so a plain Cmd+V/Cmd+X there is untouched.
    win.addEventListener("keydown", event => {
      if (!this.enabled || !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key != "v" && key != "x") {
        return;
      }
      const anchor = lazy.WhimsySidebarNav.focusedTab(win);
      if (!anchor) {
        return;
      }
      const handled = key == "x" ? this.cut(win, anchor) : this.paste(win, anchor);
      if (handled) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  },

  anchorTab(win) {
    return lazy.WhimsySidebarNav.focusedTab(win);
  },

  // The tabs a sidebar-focused Cmd+X marks: the multi-selection when
  // several tabs are selected (WhimsyCopy.shortcutTabs's rule), else just
  // the focused tab. Essentials are global to every space, so they're never
  // marked (there's nowhere meaningful to move them "below").
  tabsToCut(win, anchor) {
    const { gBrowser } = win;
    if (gBrowser.multiSelectedTabsCount > 1) {
      return gBrowser.selectedTabs.filter(tab => !tab.hasAttribute("zen-essential"));
    }
    return anchor.hasAttribute("zen-essential") ? [] : [anchor];
  },

  cut(win, anchor) {
    const tabs = this.tabsToCut(win, anchor);
    if (!tabs.length) {
      return false;
    }
    cutTabs.set(win, tabs);
    return true;
  },

  paste(win, anchor = this.anchorTab(win)) {
    if (!anchor) {
      return false;
    }
    const moved = this.moveCut(win, anchor);
    if (moved) {
      win.gZenUIManager?.showToast?.("whimsy-paste-tabs-move-toast", { l10nArgs: { count: moved } });
      return true;
    }
    const urls = parseUrls(this.readClipboardText(win));
    return urls.length > 0 && this.openUrls(win, anchor, urls) > 0;
  },

  // Moves a pending Cmd+X selection to just after `anchor`, crossing into
  // its space first if needed (gZenWorkspaces.moveTabsToWorkspace, the same
  // essentials-excluding convention as Move to New Space). One-shot: the
  // pending set is cleared whether or not anything was left to move.
  moveCut(win, anchor) {
    const pending = cutTabs.get(win);
    cutTabs.delete(win);
    if (!pending) {
      return 0;
    }
    const tabs = pending.filter(tab => tab?.isConnected && !tab.closing && tab != anchor);
    if (!tabs.length) {
      return 0;
    }
    const { gBrowser, gZenWorkspaces } = win;
    const targetSpace = anchor.getAttribute("zen-workspace-id");
    if (gZenWorkspaces?.workspaceEnabled && targetSpace) {
      const crossSpace = tabs.filter(
        tab => !tab.hasAttribute("zen-essential") && tab.getAttribute("zen-workspace-id") != targetSpace
      );
      if (crossSpace.length) {
        gZenWorkspaces.moveTabsToWorkspace(crossSpace, targetSpace);
      }
    }
    gBrowser.moveTabsAfter(tabs, anchor);
    return tabs.length;
  },

  // Opens `urls` as background tabs right after `anchor` (WhimsyLinkLasso's
  // openTabs pattern: same userContextId, keep the current selection).
  openUrls(win, anchor, urls) {
    const { gBrowser } = win;
    const browser = gBrowser.selectedBrowser;
    const selected = gBrowser.selectedTab;
    const userContextId = anchor.getAttribute("usercontextid") || 0;
    const tabs = [];
    for (const url of urls) {
      const tab = gBrowser.addTab(url, {
        inBackground: true,
        skipAnimation: true,
        userContextId: Number(userContextId),
        triggeringPrincipal: browser.contentPrincipal,
      });
      if (tab) {
        tabs.push(tab);
      }
    }
    if (!tabs.length) {
      return 0;
    }
    gBrowser.moveTabsAfter(tabs, anchor);
    if (selected && !selected.closing) {
      gBrowser.selectedTab = selected;
    }
    win.gZenUIManager?.showToast?.("whimsy-paste-tabs-open-toast", { l10nArgs: { count: tabs.length } });
    return tabs.length;
  },

  readClipboardText(win) {
    try {
      const xferable = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
      xferable.init(null);
      xferable.addDataFlavor("text/plain");
      Services.clipboard.getData(xferable, Ci.nsIClipboard.kGlobalClipboard);
      const data = {};
      xferable.getTransferData("text/plain", data);
      return data.value?.QueryInterface(Ci.nsISupportsString).data ?? "";
    } catch (e) {
      return "";
    }
  },
};
