/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W29 "Open Mini Whimsy from any app" (owner, r3: "Opt space, enabled
// during onboarding"). One system-wide shortcut, ⌥Space unless you record
// another, opens the same bar-only Mini panel as ⌘⌥N, at the top right of
// the screen, over whatever app is in front. Esc or the shortcut again puts
// the panel away and hands focus back to that app; Return turns it into a
// Mini window, as ⌘⌥N's does.
//
// The key is a Carbon hot key (hotkey/nsWhimsyGlobalHotKey.mm), so it needs
// no Accessibility permission. It's off until turned on: onboarding offers
// it (on by default), and Settings → Look and Feel → Mini Whimsy has the
// checkbox and the recorder (WhimsyHotKeyField in the Settings page).
//
// The stored form is the modifiers, then a KeyboardEvent.code, joined with
// "+": "Alt+Space", "Cmd+Shift+KeyK", "F5".

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  WhimsyQuickWindow: "resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.global-hotkey";
export const ENABLED_PREF = "whimsy.mini.global-hotkey.enabled";
export const KEY_PREF = "whimsy.mini.global-hotkey";
const TOPIC = "whimsy-global-hotkey";

// nsIWhimsyGlobalHotKey's modifier mask.
export const MOD = { Cmd: 1, Shift: 2, Alt: 4, Ctrl: 8 };
// Stored order, and Apple's display order (⌃⌥⇧⌘).
const STORED_ORDER = ["Cmd", "Ctrl", "Alt", "Shift"];
const DISPLAY_ORDER = [["Ctrl", "⌃"], ["Alt", "⌥"], ["Shift", "⇧"], ["Cmd", "⌘"]];

const KEY_LABELS = {
  Space: "Space", Enter: "Return", Tab: "Tab",
  ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
};

// macOS's own shortcuts, by its symbolic hot key number, with the
// shortcut macOS uses when it has never written the entry. Only ids the
// copy can name are listed; the rest are matched without a name.
export const SYSTEM_DEFAULTS = [
  { id: 64, feature: "spotlight", code: "Space", modifiers: MOD.Cmd },
  { id: 65, feature: "finder-search", code: "Space", modifiers: MOD.Cmd | MOD.Alt },
  { id: 60, feature: "input-sources", code: "Space", modifiers: MOD.Ctrl },
  { id: 61, feature: "input-sources", code: "Space", modifiers: MOD.Ctrl | MOD.Alt },
  { id: 32, feature: "mission-control", code: "ArrowUp", modifiers: MOD.Ctrl },
  { id: 33, feature: "mission-control", code: "ArrowDown", modifiers: MOD.Ctrl },
  { id: 79, feature: "mission-control", code: "ArrowLeft", modifiers: MOD.Ctrl },
  { id: 81, feature: "mission-control", code: "ArrowRight", modifiers: MOD.Ctrl },
  { id: 28, feature: "screenshots", code: "Digit3", modifiers: MOD.Cmd | MOD.Shift },
  { id: 30, feature: "screenshots", code: "Digit4", modifiers: MOD.Cmd | MOD.Shift },
  { id: 184, feature: "screenshots", code: "Digit5", modifiers: MOD.Cmd | MOD.Shift },
];

const FEATURE_BY_ID = new Map(SYSTEM_DEFAULTS.map(d => [d.id, d.feature]));

// "Alt+Space" -> { code: "Space", modifiers: 4 }, or null.
export function parseShortcut(text) {
  const parts = String(text ?? "").split("+").filter(Boolean);
  const code = parts.pop();
  if (!code) {
    return null;
  }
  let modifiers = 0;
  for (const part of parts) {
    if (!(part in MOD)) {
      return null;
    }
    modifiers |= MOD[part];
  }
  return { code, modifiers };
}

export function serializeShortcut({ code, modifiers }) {
  return [...STORED_ORDER.filter(m => modifiers & MOD[m]), code].join("+");
}

// What Settings and onboarding show: "⌥Space", "⌘⇧K", "F5".
export function displayShortcut({ code, modifiers }) {
  const mods = DISPLAY_ORDER.filter(([m]) => modifiers & MOD[m]).map(([, s]) => s).join("");
  let key = KEY_LABELS[code];
  if (!key) {
    key = /^(?:Key|Digit)(.)$/.exec(code)?.[1] ?? code;
  }
  return mods + key;
}

// A shortcut needs ⌘, ⌃ or ⌥ (Shift alone isn't enough), or an F-key.
export function isAllowed({ code, modifiers }) {
  if (/^F\d+$/.test(code)) {
    return true;
  }
  return !!(modifiers & (MOD.Cmd | MOD.Ctrl | MOD.Alt));
}

// The KeyboardEvent a recorder sees, as a shortcut (null for a lone
// modifier press).
export function shortcutFromEvent(event) {
  if (["Meta", "Control", "Alt", "Shift", "CapsLock", "Fn"].includes(event.key)) {
    return null;
  }
  let modifiers = 0;
  if (event.metaKey) modifiers |= MOD.Cmd;
  if (event.ctrlKey) modifiers |= MOD.Ctrl;
  if (event.altKey) modifiers |= MOD.Alt;
  if (event.shiftKey) modifiers |= MOD.Shift;
  return { code: event.code, modifiers };
}

export const WhimsyGlobalHotKey = {
  // Tests replace this with a fake of nsIWhimsyGlobalHotKey.
  _native: null,

  get native() {
    if (!this._native && AppConstants.platform == "macosx") {
      try {
        this._native = Cc["@whimsy/global-hotkey;1"].getService(Ci.nsIWhimsyGlobalHotKey);
      } catch (e) {
        console.error("Whimsy: global shortcut unavailable", e);
      }
    }
    return this._native;
  },

  get supported() {
    return AppConstants.platform == "macosx" && Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  get enabled() {
    return this.supported && Services.prefs.getBoolPref(ENABLED_PREF, false);
  },

  get shortcut() {
    return parseShortcut(Services.prefs.getStringPref(KEY_PREF, ""));
  },

  init() {
    if (this._initialized || !this.supported) {
      return;
    }
    this._initialized = true;
    this._onPref = () => this.update();
    Services.prefs.addObserver(ENABLED_PREF, this._onPref);
    Services.prefs.addObserver(KEY_PREF, this._onPref);
    Services.obs.addObserver(this, TOPIC);
    Services.obs.addObserver(this, "quit-application");
    this.update();
  },

  uninit() {
    if (!this._initialized) {
      return;
    }
    this._initialized = false;
    Services.prefs.removeObserver(ENABLED_PREF, this._onPref);
    Services.prefs.removeObserver(KEY_PREF, this._onPref);
    Services.obs.removeObserver(this, TOPIC);
    Services.obs.removeObserver(this, "quit-application");
    this.native?.unregister();
  },

  observe(subject, topic) {
    if (topic == TOPIC) {
      this.onPress();
    } else if (topic == "quit-application") {
      this.uninit();
    }
  },

  // Registers the stored shortcut, or unregisters when the setting is off
  // or the shortcut is cleared. Returns register()'s answer, "off" or
  // "unavailable".
  update() {
    const native = this.native;
    if (!native) {
      return "unavailable";
    }
    const shortcut = this.shortcut;
    if (!this.enabled || !shortcut || !isAllowed(shortcut)) {
      native.unregister();
      return "off";
    }
    return native.register(shortcut.code, shortcut.modifiers);
  },

  // While Settings records a shortcut, the current one is let go, so
  // pressing it records it instead of opening Mini.
  pause() {
    this.native?.unregister();
  },

  resume() {
    return this.update();
  },

  // Checks a shortcut before it's stored: "ok", "not-allowed",
  // "system" (with `feature`, macOS's name for the action when known), or
  // "taken" by another app. "ok" and "taken" come from registering it
  // when the setting is on, so a refused key leaves the old one working.
  check(shortcut) {
    if (!isAllowed(shortcut)) {
      return { result: "not-allowed" };
    }
    const system = this.systemConflict(shortcut);
    if (system) {
      return { result: "system", feature: system.feature };
    }
    const native = this.native;
    if (!native || !Services.prefs.getBoolPref(ENABLED_PREF, false)) {
      return { result: "ok" };
    }
    const result = native.register(shortcut.code, shortcut.modifiers);
    return { result: result == "ok" ? "ok" : result == "taken" ? "taken" : "failed" };
  },

  // The first of `candidates` that neither macOS nor another app holds,
  // found by registering each for a moment; then the stored shortcut (or
  // none) is put back. Onboarding offers what this finds.
  firstFree(candidates) {
    const native = this.native;
    if (!native) {
      return null;
    }
    const current = this.enabled && native.registered ? this.shortcut : null;
    let found = null;
    for (const shortcut of candidates) {
      if (this.systemConflict(shortcut)) {
        continue;
      }
      if (current && current.code == shortcut.code && current.modifiers == shortcut.modifiers) {
        found = shortcut;
        break;
      }
      if (native.register(shortcut.code, shortcut.modifiers) == "ok") {
        found = shortcut;
        break;
      }
    }
    this.update();
    return found;
  },

  // The macOS shortcut `shortcut` collides with, if any: what the user has
  // set in System Settings › Keyboard › Keyboard Shortcuts, and macOS's
  // defaults for any entry it has never written.
  systemConflict(shortcut) {
    let written = [];
    try {
      written = JSON.parse(this.native?.systemHotKeys || "[]");
    } catch {}
    const writtenIds = new Set(written.map(w => w.id));
    const active = [
      ...written.filter(w => w.enabled),
      ...SYSTEM_DEFAULTS.filter(d => !writtenIds.has(d.id)),
    ];
    const hit = active.find(a => a.code == shortcut.code && a.modifiers == shortcut.modifiers);
    return hit ? { id: hit.id, feature: FEATURE_BY_ID.get(hit.id) ?? null } : null;
  },

  // The panel this shortcut opened, while it's still the bar-only panel.
  get openPanel() {
    const panel = this._panel;
    return panel && !panel.closed && panel._whimsyMiniBarOnly ? panel : null;
  },

  onPress() {
    const quick = lazy.WhimsyQuickWindow;
    const open = this.openPanel ?? quick.windows().find(w => !w.closed && w._whimsyMiniBarOnly);
    if (open) {
      // The shortcut again puts the panel away, like Esc.
      open.close();
      return;
    }
    this.native?.activate();
    const opener = lazy.BrowserWindowTracker.getTopWindow() ?? null;
    const panel = quick.open(null, { opener });
    if (!panel) {
      this.native?.restorePreviousApp();
      return;
    }
    this._panel = panel;
    // Esc (or the shortcut) closing the panel hands focus back to the app
    // that was in front. Once Return has made it a Mini window, it's a
    // window of its own and closing it later doesn't.
    const onClosed = subject => {
      if (subject != panel) {
        return;
      }
      Services.obs.removeObserver(onClosed, "domwindowclosed");
      if (this._panel == panel) {
        this._panel = null;
      }
      if (panel._whimsyMiniBarOnly) {
        this.native?.restorePreviousApp();
      }
    };
    Services.obs.addObserver(onClosed, "domwindowclosed");
  },
};
