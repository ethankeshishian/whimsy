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

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  CustomKeys: "moz-src:///browser/components/customkeys/CustomKeys.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));

const FEATURE_PREF = "whimsy.feature.duplicate-shortcut";

// key id → the default binding; {} means no shortcut.
export const SHORTCUTS = {
  "zen-duplicate-tab": { modifiers: "accel,shift", key: "D" },
  "zen-toggle-pin-tab": { modifiers: "accel", key: "D" },
  addBookmarkAsKb: {},
};

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
    const keysets = new Set();
    for (const [id, binding] of Object.entries(SHORTCUTS)) {
      const keyEl = win.document.getElementById(id);
      if (!keyEl || this.isCustomized(id)) {
        continue;
      }
      for (const attr of ATTRS) {
        keyEl.removeAttribute(attr);
      }
      for (const [attr, value] of Object.entries(binding)) {
        keyEl.setAttribute(attr, value);
      }
      keysets.add(keyEl.parentElement);
    }
    // Gecko reads <key> elements only when their keyset is bound, so re-add
    // the keysets (what CustomKeys does too).
    for (const keyset of keysets) {
      const parent = keyset.parentElement;
      keyset.remove();
      parent.append(keyset);
    }
  },

  isCustomized(id) {
    try {
      return !!lazy.CustomKeys.getDefaultKey(id);
    } catch (e) {
      return false;
    }
  },

  // A Whimsy command for a window: a <command> that runs `run(win)`, and,
  // with `key`, a <key> for it (shown in the command bar and menus).
  addCommand(win, { id, run, key = null }) {
    const { document } = win;
    if (document.getElementById(id)) {
      return document.getElementById(id);
    }
    const command = document.createXULElement("command");
    command.id = id;
    command.addEventListener("command", () => {
      try {
        run(win);
      } catch (e) {
        console.error(`Whimsy: ${id} failed`, e);
      }
    });
    (document.getElementById("mainCommandSet") ?? document.documentElement).append(command);
    if (key) {
      this.addKey(win, { ...key, command: id });
    }
    return command;
  },

  // A <key> for an existing command, in Whimsy's own keyset beside
  // Firefox's (Zen rebuilds its own).
  addKey(win, { id, command, key = null, keycode = null, modifiers }) {
    const { document } = win;
    if (document.getElementById(id)) {
      return;
    }
    const keyEl = document.createXULElement("key");
    keyEl.id = id;
    keyEl.setAttribute("command", command);
    keyEl.setAttribute("modifiers", modifiers);
    keyEl.setAttribute(keycode ? "keycode" : "key", keycode ?? key);
    let keyset = document.getElementById("whimsyKeyset");
    if (!keyset) {
      keyset = document.createXULElement("keyset");
      keyset.id = "whimsyKeyset";
    }
    keyset.append(keyEl);
    // Gecko reads <key>s only when their keyset is (re)bound.
    keyset.remove();
    (document.getElementById("mainKeyset")?.parentElement ?? document.documentElement).append(keyset);
  },

  // Adds actions to Zen's command bar (once per session): { l10nId (in
  // whimsy.ftl), command (a <command> id or a function of the window),
  // icon, isAvailable(win) }.
  addActions(actions) {
    const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
    for (const action of actions) {
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
};
