/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Whimsy's default shortcuts where they differ from Zen's and Firefox's
// (Arc parity first). Applied to each window's <key> elements before anyone
// customizes them, so Settings → Keyboard Shortcuts shows them as the
// defaults, and a key the user already customized is left alone.
//
// - Duplicate Tab: Cmd+Shift+D (Zen ships it unbound): a copy of the
//   current tab, with its history, next to it.
// - Pin/Unpin Tab: Cmd+D, as in Arc (Zen had it on Cmd+Shift+D).
// - Bookmark This Page loses Cmd+D to pinning (still in the Bookmarks menu
//   and the star), since Whimsy's pinned tabs are its bookmarks.
//
// wave6: Cmd+N makes a new space (BUILD-PLAN answer 1, confirmed by the
// user over Arc's New Window). New Window keeps working on
// Cmd+Opt+Shift+N (and the File menu, Dock menu and command bar).
//
// wave6/parity, Arc's menu keys:
// - Open Library...: Cmd+Shift+L (Zen's Opt+Shift+L).
// - Save Page As: Cmd+Shift+S (Zen moved it to Cmd+Opt+Shift+S). Firefox's
//   Screenshots gives up Cmd+Shift+S and keeps Arc's Cmd+Shift+2 (Capture,
//   WhimsyPage) and the command bar; only while Capture is on, so
//   Screenshots always has a key.
// - View Downloads...: Cmd+Shift+J (Firefox's Cmd+J). Firefox's Browser
//   Console had Cmd+Shift+J; it moves to Cmd+Opt+J (Chrome's console key),
//   but only when that's free. Otherwise both stay where Firefox put them.
//   DevTools adds its keys after the window starts, so this runs at
//   delayed startup.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  CustomKeys: "moz-src:///browser/components/customkeys/CustomKeys.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));

const FEATURE_PREF = "whimsy.feature.duplicate-shortcut";

// key id → the default binding; {} means no shortcut.
export const SHORTCUTS = {
  "zen-duplicate-tab": { modifiers: "accel,shift", key: "D" },
  "zen-toggle-pin-tab": { modifiers: "accel", key: "D" },
  addBookmarkAsKb: {},
  "zen-library-toggle": { modifiers: "accel,shift", key: "L" },
  key_newNavigator: { modifiers: "accel,alt,shift", key: "N" },
};

export const NEW_SPACE_KEY = { key: "N", modifiers: "accel" };

// Applied only while Whimsy's Capture (Cmd+Shift+2) is on.
export const CAPTURE_SHORTCUTS = {
  key_savePage: { modifiers: "accel,shift", key: "S" },
  key_screenshot: {},
};
const CAPTURE_FEATURE_PREF = "whimsy.feature.capture";

export const CONSOLE_KEY_ID = "key_browserConsole";
export const CONSOLE_BINDING = { modifiers: "accel,alt", key: "J" };
export const DOWNLOADS_BINDING = { modifiers: "accel,shift", key: "J" };

const ATTRS = ["data-l10n-id", "key", "keycode", "modifiers"];

export const WhimsyShortcuts = {
  SHORTCUTS,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  initWindow(win) {
    if (!this.enabled) {
      return;
    }
    const all = { ...SHORTCUTS };
    if (Services.prefs.getBoolPref(CAPTURE_FEATURE_PREF, true)) {
      Object.assign(all, CAPTURE_SHORTCUTS);
    }
    const keysets = new Set();
    for (const [id, binding] of Object.entries(all)) {
      const keyEl = win.document.getElementById(id);
      if (!keyEl || this.isCustomized(id)) {
        continue;
      }
      this.setBinding(keyEl, binding);
      keysets.add(keyEl.parentElement);
    }
    this.rebindKeysets(keysets);
    // Cmd+N: Zen's "create space" command, now that New Window has moved.
    // Zen's command bar already lists "New Space", so not added there again.
    lazy.WhimsyCommands.register(win, {
      id: "cmd_zenOpenWorkspaceCreation",
      l10nId: "whimsy-action-new-space",
      keyId: "key_whimsyNewSpace",
      key: NEW_SPACE_KEY,
      commandBar: false,
    });
    // The Browser Console's key exists only after DevTools hooks the window.
    const onReady = subject => {
      if (subject != win) {
        return;
      }
      Services.obs.removeObserver(onReady, "browser-delayed-startup-finished");
      win.setTimeout(() => this.moveConsoleAndDownloads(win), 0);
    };
    if (win.gBrowserInit?.delayedStartupFinished) {
      this.moveConsoleAndDownloads(win);
    } else {
      Services.obs.addObserver(onReady, "browser-delayed-startup-finished");
      win.addEventListener("unload", () => {
        try {
          Services.obs.removeObserver(onReady, "browser-delayed-startup-finished");
        } catch (e) {
          // Already removed.
        }
      }, { once: true });
    }
  },

  setBinding(keyEl, binding) {
    for (const attr of ATTRS) {
      keyEl.removeAttribute(attr);
    }
    for (const [attr, value] of Object.entries(binding)) {
      keyEl.setAttribute(attr, value);
    }
  },

  // Gecko reads <key> elements only when their keyset is bound, so re-add
  // the keysets (what CustomKeys does too).
  rebindKeysets(keysets) {
    for (const keyset of keysets) {
      const parent = keyset?.parentElement;
      if (parent) {
        keyset.remove();
        parent.append(keyset);
      }
    }
  },

  // Returns "moved", "kept" (Cmd+Opt+J is taken, so the console and
  // Downloads stay on Firefox's keys) or "no-console".
  moveConsoleAndDownloads(win) {
    if (!this.enabled) {
      return "kept";
    }
    const { document } = win;
    const consoleKey = document.getElementById(CONSOLE_KEY_ID);
    const keysets = new Set();
    let result = "no-console";
    if (consoleKey) {
      const onDownloadsKey =
        consoleKey.getAttribute("key")?.toUpperCase() == "J" &&
        lazy.WhimsyCommands.findConflict(document, DOWNLOADS_BINDING) == consoleKey;
      if (onDownloadsKey) {
        const taken = lazy.WhimsyCommands.findConflict(document, CONSOLE_BINDING, CONSOLE_KEY_ID);
        if (taken || this.isCustomized(CONSOLE_KEY_ID)) {
          console.warn(`Whimsy: Browser Console keeps Cmd+Shift+J; ${taken?.id || "a custom key"} has Cmd+Opt+J`);
          return "kept";
        }
        consoleKey.setAttribute("modifiers", CONSOLE_BINDING.modifiers);
        keysets.add(consoleKey.parentElement);
        result = "moved";
      } else {
        result = "moved"; // Customized elsewhere already: Cmd+Shift+J is free.
      }
    }
    const downloads = document.getElementById("key_openDownloads");
    if (
      downloads &&
      !this.isCustomized("key_openDownloads") &&
      !lazy.WhimsyCommands.findConflict(document, DOWNLOADS_BINDING, "key_openDownloads")
    ) {
      this.setBinding(downloads, DOWNLOADS_BINDING);
      keysets.add(downloads.parentElement);
    }
    this.rebindKeysets(keysets);
    return result;
  },

  isCustomized(id) {
    try {
      return !!lazy.CustomKeys.getDefaultKey(id);
    } catch (e) {
      return false;
    }
  },

  // wave5: the helpers below are kept for code that hasn't moved to
  // WhimsyCommands.register yet (and for Mini Whimsy's window-only keys,
  // which take Cmd+O and Cmd+Shift+O there on purpose, so they skip the
  // conflict check). They feed the same registry, so their keys are
  // recorded and their command-bar names listed. New code calls
  // WhimsyCommands.register(win, { id, l10nId, run, key, ... }) instead.
  addCommand(win, { id, run, key = null }) {
    const command = lazy.WhimsyCommands.addCommandElement(win, id, run);
    lazy.WhimsyCommands.describe({ id, keyId: key?.id, key });
    if (key) {
      lazy.WhimsyCommands.addKey(win, { ...key, command: id, allowConflict: true });
    }
    return command;
  },

  addKey(win, spec) {
    lazy.WhimsyCommands.describe({ id: spec.command, keyId: spec.id, key: spec });
    lazy.WhimsyCommands.addKey(win, { ...spec, allowConflict: true });
  },

  // Adds actions to Zen's command bar (once per session): { l10nId (in
  // whimsy.ftl), command (a <command> id or a function of the window),
  // icon, isAvailable(win) }. A function command can't take a shortcut;
  // use WhimsyCommands.register for anything new.
  addActions(actions) {
    const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
    for (const action of actions) {
      if (typeof action.command == "string") {
        lazy.WhimsyCommands.describe({ id: action.command, l10nId: action.l10nId });
      }
      if (globalActions.some(a => a.l10nId == action.l10nId)) {
        continue;
      }
      let label = null;
      globalActions.push({
        commandId: typeof action.command == "string" ? action.command : `whimsy:${action.l10nId}`,
        extraPayload: {},
        isAvailable: () => true,
        ...action,
        get label() {
          label ??= lazy.l10n.formatValueSync(action.l10nId);
          return label;
        },
      });
    }
  },

  // wave6/zap: takes a Firefox or Zen <key>'s binding away so a Whimsy
  // shortcut can use it, unless the person customized that key.
  releaseKey(win, id) {
    const keyEl = win.document.getElementById(id);
    if (!keyEl || this.isCustomized(id)) {
      return;
    }
    for (const attr of ATTRS) {
      keyEl.removeAttribute(attr);
    }
    const keyset = keyEl.parentElement;
    const parent = keyset?.parentElement;
    if (parent) {
      keyset.remove();
      parent.append(keyset);
    }
  },
};
