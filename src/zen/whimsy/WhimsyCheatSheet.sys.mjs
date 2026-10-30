/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Shortcut cheat sheet: Cmd+/ (and the command bar's "Keyboard Shortcuts")
// open a small, searchable, centred panel showing Whimsy's own shortcuts
// with their *current* bindings (so a customized key shows the customized
// one), the way the macOS Cmd-hold Cheat Sheet or Gmail/GitHub/Linear's "?"
// overlay do: one glance, searchable, closes with Esc. about:keyboard
// (CustomKeys' own full editable list, with Zen's groups already merged in
// by ZenKeyboardShortcuts.addKeys) is one click away for anything not shown
// here, since rebuilding that whole grouped list outside the CustomKeys
// actor would just duplicate it.
// whimsy.feature.cheatsheet.

// fixB: rebuilt as a WhimsyPanels sheet, centred like the command bar:
// grouped (Tabs, Sidebar & Spaces, Split View, Page, Windows), each
// shortcut as key caps read from the window's live <key> elements (so a
// customized key shows its new binding, and an unbound one is left out).
// Typing filters; Enter or a click runs the shortcut's command, the way
// macOS's Help menu search does; "Edit Shortcuts…" opens about:keyboard.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ShortcutUtils: "resource://gre/modules/ShortcutUtils.sys.mjs",
  WhimsyPanels: "resource:///modules/whimsy/WhimsyPanels.sys.mjs",
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.cheatsheet";
const PANEL_ID = "whimsy-cheatsheet-panel";

// Groups of [<key> element id, label]. Missing or unbound keys are skipped.
const GROUPS = [
  [
    "whimsy-cheatsheet-group-tabs",
    [
      ["key_newNavigatorTab", "whimsy-cheatsheet-new-tab"],
      ["key_close", "whimsy-cheatsheet-close-tab"],
      ["key_restoreLastClosedTabOrWindowOrSession", "whimsy-cheatsheet-reopen-tab"],
      ["zen-duplicate-tab", "whimsy-cheatsheet-duplicate-tab"],
      ["zen-toggle-pin-tab", "whimsy-cheatsheet-pin-tab"],
      ["zen-copy-url", "whimsy-cheatsheet-copy-url"],
      ["key_whimsyTabNext", "whimsy-cheatsheet-tab-next"],
      ["key_whimsyTabPrev", "whimsy-cheatsheet-tab-prev"],
      ["key_whimsyNewPrivateTab", "whimsy-cheatsheet-private-tab"],
    ],
  ],
  [
    "whimsy-cheatsheet-group-sidebar",
    [
      ["focusURLBar", "whimsy-cheatsheet-address-bar"],
      ["zen-toggle-sidebar", "whimsy-cheatsheet-toggle-sidebar"],
      ["zen-compact-mode-toggle", "whimsy-cheatsheet-compact-mode"],
      ["key_whimsyFocusSidebar", "whimsy-cheatsheet-focus-sidebar"],
      ["zen-workspace-forward", "whimsy-cheatsheet-next-space"],
      ["zen-workspace-backward", "whimsy-cheatsheet-prev-space"],
      ["zen-library-toggle", "whimsy-cheatsheet-library"],
    ],
  ],
  [
    "whimsy-cheatsheet-group-split",
    [
      ["zen-split-view-vertical", "whimsy-cheatsheet-split-vertical"],
      ["zen-split-view-horizontal", "whimsy-cheatsheet-split-horizontal"],
      ["zen-split-view-grid", "whimsy-cheatsheet-split-grid"],
      ["zen-split-view-unsplit", "whimsy-cheatsheet-unsplit"],
      ["key_whimsySwapPanes", "whimsy-cheatsheet-swap-panes"],
      ["key_whimsyCloseOtherPanes", "whimsy-cheatsheet-close-other-panes"],
    ],
  ],
  [
    "whimsy-cheatsheet-group-page",
    [
      ["key_find", "whimsy-cheatsheet-find"],
      ["key_toggleReaderMode", "whimsy-cheatsheet-reader"],
      ["key_whimsyCopyFullPage", "whimsy-cheatsheet-copy-full-page"],
      ["key_whimsyScreenshotArc", "whimsy-cheatsheet-capture"],
      ["key_whimsyTranslateSelection", "whimsy-cheatsheet-translate"],
      ["key_whimsySpeedUp", "whimsy-cheatsheet-speed-up"],
      ["key_whimsySlowDown", "whimsy-cheatsheet-slow-down"],
    ],
  ],
  [
    "whimsy-cheatsheet-group-windows",
    [
      ["key_newNavigator", "whimsy-cheatsheet-new-window"],
      ["key_whimsyQuickWindow", "whimsy-cheatsheet-quick-window"],
      ["key_privatebrowsing", "whimsy-cheatsheet-private-window"],
      ["key_whimsyCheatsheet", "whimsy-cheatsheet-self"],
    ],
  ],
];

function bound(keyEl) {
  return (
    !!keyEl &&
    keyEl.getAttribute("disabled") != "true" &&
    (keyEl.hasAttribute("key") || keyEl.hasAttribute("keycode")) &&
    !!(keyEl.getAttribute("key") || keyEl.getAttribute("keycode"))
  );
}

export const WhimsyCheatSheet = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  initWindow(win) {
    lazy.WhimsyShortcuts.addCommand(win, {
      id: "whimsy-cheatsheet",
      run: w => {
        if (this.enabled) {
          this.toggle(w);
        }
      },
      key: { id: "key_whimsyCheatsheet", key: "/", modifiers: "accel" },
    });
  },

  // [{ l10nId, rows: [{ keyId, l10nId, label: "⌘⇧D" }] }], bound keys only.
  groups(win) {
    const { document } = win;
    return GROUPS.map(([l10nId, keys]) => ({
      l10nId,
      rows: keys
        .map(([keyId, rowL10nId]) => {
          const keyEl = document.getElementById(keyId);
          if (!bound(keyEl)) {
            return null;
          }
          let label = "";
          try {
            label = lazy.ShortcutUtils.prettifyShortcut(keyEl);
          } catch (e) {
            return null;
          }
          return label ? { keyId, l10nId: rowL10nId, label } : null;
        })
        .filter(Boolean),
    })).filter(group => group.rows.length);
  },

  // Kept for callers that want a flat list.
  rows(win) {
    return this.groups(win).flatMap(group => group.rows);
  },

  toggle(win) {
    const existing = win.document.getElementById(PANEL_ID);
    if (existing) {
      lazy.WhimsyPanels.close(existing);
      return;
    }
    this.open(win);
  },

  run(win, keyId) {
    const { document } = win;
    const keyEl = document.getElementById(keyId);
    const commandId = keyEl?.getAttribute("command");
    const target = commandId ? document.getElementById(commandId) : keyEl;
    try {
      target?.doCommand();
    } catch (e) {
      console.error("Whimsy: cheat sheet", keyId, e);
    }
  },

  async open(win) {
    const { document } = win;
    const groups = this.groups(win);
    const ids = [...new Set(groups.flatMap(g => [g.l10nId, ...g.rows.map(r => r.l10nId)]))];
    const values = await document.l10n.formatValues(ids.map(id => ({ id })));
    const text = Object.fromEntries(ids.map((id, i) => [id, values[i] ?? ""]));
    if (document.getElementById(PANEL_ID)) {
      return; // Opened twice in a row; the first one wins.
    }

    const entries = [];
    const render = query => {
      const q = query.trim().toLowerCase();
      for (const { caption, items } of entries) {
        let any = false;
        for (const { item, haystack } of items) {
          item.hidden = !!q && !haystack.includes(q);
          any ||= !item.hidden;
        }
        caption.hidden = !any;
      }
      empty.hidden = entries.some(e => !e.caption.hidden);
    };
    const { panel, body, footer } = lazy.WhimsyPanels.create(win, {
      id: PANEL_ID,
      titleL10nId: "whimsy-cheatsheet-title",
      size: "large",
      search: { l10nId: "whimsy-cheatsheet-search", onInput: render },
      footer: true,
    });
    panel.classList.add("whimsy-cheatsheet");

    for (const group of groups) {
      const caption = lazy.WhimsyPanels.caption(document, { text: text[group.l10nId] });
      body.append(caption);
      const items = [];
      for (const row of group.rows) {
        const label = text[row.l10nId] || row.l10nId;
        const item = lazy.WhimsyPanels.item(document, {
          label,
          keys: row.label,
          onCommand: () => {
            lazy.WhimsyPanels.close(panel);
            if (row.keyId != "key_whimsyCheatsheet") {
              this.run(win, row.keyId);
            }
          },
        });
        item.classList.add("whimsy-cheatsheet-row");
        item.setAttribute("whimsy-key", row.keyId);
        item.setAttribute("aria-label", `${label}, ${row.label}`);
        body.append(item);
        items.push({ item, haystack: `${label} ${row.label}`.toLowerCase() });
      }
      entries.push({ caption, items });
    }
    const empty = lazy.WhimsyPanels.empty(document, { l10nId: "whimsy-cheatsheet-no-match" });
    empty.hidden = true;
    body.append(empty);

    footer.append(
      lazy.WhimsyPanels.footerButton(document, {
        l10nId: "whimsy-cheatsheet-edit-button",
        onCommand: () => {
          lazy.WhimsyPanels.close(panel);
          win.switchToTabHavingURI(Services.io.newURI("about:keyboard"), true);
        },
      })
    );
    lazy.WhimsyPanels.open(win, panel);
  },
};
