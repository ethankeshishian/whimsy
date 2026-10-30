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
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
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
};
