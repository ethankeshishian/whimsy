/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// batch3glance: new tab in a split (scout batch6 #8, Zen discussion #2137).
// Arc: with a split focused, Cmd+T opens the command bar and what you pick
// opens in the focused pane, so the split stays together like one tab.
// Zen opens it as a separate tab, which leaves the split. Here Cmd+T in a
// split opens Zen's floating URL bar as usual, and a plain Enter (or click)
// loads the result into the focused pane. Alt/Shift/Cmd+Enter keep their
// meaning (a new tab outside the split); Escape changes nothing.

const FEATURE_PREF = "whimsy.feature.split-new-tab";
const CLEAR_EVENTS = ["ZenURLBarClosed", "TabSelect", "TabClose"];
const installed = new WeakSet();

function enabled() {
  return Services.prefs.getBoolPref(FEATURE_PREF, true);
}

export const WhimsySplitFlow = {
  initWindow(win) {
    if (installed.has(win) || !win.BrowserCommands || !win.gURLBar?.controller) {
      return;
    }
    installed.add(win);
    // The pane Cmd+T was pressed in, while its URL bar is open.
    let pending = null;
    const clear = () => {
      pending = null;
    };

    const commands = win.BrowserCommands;
    const openTab = commands.openTab;
    commands.openTab = function (options = {}) {
      const { event, url } = options;
      const tab = win.gBrowser.selectedTab;
      // Only the user's Cmd+T / new tab button (they carry an event); Zen's
      // own internal openTab() calls and modified clicks stay as they are.
      if (
        !enabled() ||
        !event ||
        url ||
        !tab?.splitView ||
        event.altKey ||
        event.shiftKey ||
        event.button > 0 ||
        win.gZenUIManager.newTabButtonWantsClipboard(event)
      ) {
        return openTab.call(this, options);
      }
      // A second Cmd+T closes the bar, as it does for a normal new tab.
      if (pending && win.gURLBar.hasAttribute("zen-newtab")) {
        clear();
        win.gURLBar._zenHandleUrlbarClose?.();
        return undefined;
      }
      pending = tab;
      // Force Zen's floating bar even when Zen's "new tab opens the URL bar"
      // setting is off: the result has to land in the pane, not a new tab.
      if (!win.gZenUIManager.handleNewTab(false, false, "tab", true)) {
        clear();
        return openTab.call(this, options);
      }
      return undefined;
    };

    const controller = win.gURLBar.controller;
    const whereToOpen = controller.whereToOpen;
    controller.whereToOpen = function (event) {
      const where = whereToOpen.call(this, event);
      if (
        enabled() &&
        pending &&
        pending === win.gBrowser.selectedTab &&
        pending.splitView &&
        !pending.closing &&
        win.gURLBar.hasAttribute("zen-newtab") &&
        !event?.altKey &&
        !event?.shiftKey &&
        !event?.ctrlKey &&
        !event?.metaKey &&
        !event?.button
      ) {
        return "current";
      }
      return where;
    };

    for (const type of CLEAR_EVENTS) {
      win.addEventListener(type, clear);
    }
    Services.prefs.addObserver(FEATURE_PREF, clear);
    win.addEventListener(
      "unload",
      () => {
        Services.prefs.removeObserver(FEATURE_PREF, clear);
        for (const type of CLEAR_EVENTS) {
          win.removeEventListener(type, clear);
        }
      },
      { once: true }
    );
  },
};
