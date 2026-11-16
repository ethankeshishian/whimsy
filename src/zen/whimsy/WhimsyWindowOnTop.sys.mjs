/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W28: Keep Window on Top (Settings → Look and Feel, macOS only). The
// design (float-on-top.md) proposed a per-window, session-only toggle; the
// owner's sign-off overrode that with "Need for mini whimsy as a global
// setting. Generally the user only has one window open." So this is one
// pref that applies to every open Whimsy window, including Mini Whimsy,
// and it persists across restarts. The command keeps the design's two
// names: "Keep Window on Top" while off, "Stop Keeping Window on Top"
// while on.
//
// The native level comes from nsIAppWindow.alwaysOnTop, which forwards to
// nsIWidget.SetAlwaysOnTop/GetAlwaysOnTop (whimsy-nsIWidget-h.patch,
// whimsy-nsCocoaWindow-h.patch, whimsy-nsCocoaWindow-mm.patch,
// whimsy-nsIAppWindow-idl.patch, whimsy-AppWindow-cpp.patch): Cocoa already
// floats a window created on top (nsCocoaWindow.mm), but had no runtime
// setter, and reset the level unconditionally when a modal ended.
//
// Full screen can't float: the command is unavailable there, and entering
// full screen drops this window's own bit (it's restored on leaving, since
// the pref itself never changed). Per the design's open question, a
// floating window stays on the desktop it's on; it doesn't join every
// Space like Picture-in-Picture.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.window-on-top";
const ON_PREF = "whimsy.window-on-top.enabled";
const ICON = "chrome://browser/skin/zen-icons/pin.svg";

let observing = false;

function browserWindows() {
  return [...Services.wm.getEnumerator("navigator:browser")].filter(win => !win.closed && win._whimsyWindowOnTop);
}

// win's nsIAppWindow, or null while the widget isn't ready yet (very early
// in a window's life, or after it's torn down).
function appWindow(win) {
  try {
    return win.docShell?.treeOwner.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIAppWindow) ?? null;
  } catch (e) {
    return null;
  }
}

export const WhimsyWindowOnTop = {
  FEATURE_PREF,

  get enabled() {
    return AppConstants.platform == "macosx" && Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  get on() {
    return this.enabled && Services.prefs.getBoolPref(ON_PREF, false);
  },

  setOn(value) {
    Services.prefs.setBoolPref(ON_PREF, !!value);
  },

  // Whether the command can run in `win` right now: not full screen, there
  // (full screen windows can't float, and leaving it reapplies the pref).
  isAvailable(win) {
    return this.enabled && !win.fullScreen;
  },

  // Applies the pref (and full-screen rule) to one window's native widget.
  apply(win) {
    const aw = appWindow(win);
    if (aw) {
      aw.alwaysOnTop = this.on && !win.fullScreen;
    }
  },

  applyAll() {
    for (const win of browserWindows()) {
      this.apply(win);
    }
  },

  // The neutral command (its shortcut, assignable even with no command
  // bar row showing): flips the global pref.
  toggle(win) {
    this.on ? this.turnOff(win) : this.turnOn(win);
  },

  // Each command bar row sets the global pref to an absolute value (not a
  // flip), with its own toast, like Liquid Glass's On/Off rows.
  turnOn(win) {
    this.setOn(true);
    win?.gZenUIManager?.showToast?.("whimsy-window-on-top-on-toast", {
      descriptionId: "whimsy-window-on-top-on-toast-description",
    });
  },

  turnOff(win) {
    this.setOn(false);
    win?.gZenUIManager?.showToast?.("whimsy-window-on-top-off-toast");
  },

  initWindow(win) {
    if (!win.gBrowser || win._whimsyWindowOnTop || AppConstants.platform != "macosx") {
      return;
    }
    win._whimsyWindowOnTop = true;

    const reapply = () => this.apply(win);
    win.addEventListener("willenterfullscreen", reapply);
    win.addEventListener("willexitfullscreen", reapply);
    win.addEventListener("fullscreen", reapply);
    win.addEventListener(
      "unload",
      () => {
        win.removeEventListener("willenterfullscreen", reapply);
        win.removeEventListener("willexitfullscreen", reapply);
        win.removeEventListener("fullscreen", reapply);
      },
      { once: true }
    );

    if (!observing) {
      observing = true;
      const all = () => this.applyAll();
      Services.prefs.addObserver(FEATURE_PREF, all);
      Services.prefs.addObserver(ON_PREF, all);
    }
    this.apply(win);

    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyKeepWindowOnTop",
      l10nId: "whimsy-action-window-on-top-toggle",
      run: w => this.toggle(w),
      icon: ICON,
      whimsyKeywords: () => lazy.WhimsyCommands.keywords("whimsy-keywords-window-on-top"),
      variants: [
        { l10nId: "whimsy-action-window-on-top-on", run: w => this.turnOn(w), isAvailable: w => this.isAvailable(w) && !this.on },
        { l10nId: "whimsy-action-window-on-top-off", run: w => this.turnOff(w), isAvailable: w => this.isAvailable(w) && this.on },
      ],
    });
  },
};
