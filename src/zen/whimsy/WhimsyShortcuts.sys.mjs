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
};
