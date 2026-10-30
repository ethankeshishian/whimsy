/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Shortcut cheat sheet: Cmd+/ (and the command bar's "Keyboard Shortcuts")
// open a small, searchable, centred panel listing the window's shortcuts
// with their *current* bindings (so a customized key shows the customized
// one), the way the macOS Cmd-hold Cheat Sheet or Gmail/GitHub/Linear's "?"
// overlay do: one glance, searchable, closes with Esc. about:keyboard stays
// one click away for editing. whimsy.feature.cheatsheet.
//
// wave3: the list is read from the window's live keysets, not a hardcoded
// list, so Zen's and Firefox's own shortcuts show up too, grouped the way
// about:keyboard groups them: Whimsy first, then Zen's groups
// (ZenKeyboardShortcuts.addKeys), then Firefox's menu-bar menus
// (CustomKeysParent.getKeys), then "Other" for any remaining key with a
// readable name. Both builders only read `browsingContext.topChromeWindow`
// and call `getKeyData(id)`, so they run against this window directly
// instead of through the about:keyboard actor. Cleared and disabled keys
// are left out, and a key appears once, in the first group that claims it.
//
// fixB: shown as a WhimsyPanels sheet, centred like the command bar, each
// shortcut as key caps. Typing filters; Enter or a click runs the
// shortcut's command, the way macOS's Help menu search does; "Edit
// Shortcuts…" opens about:keyboard.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  CustomKeysParent: "moz-src:///browser/components/customkeys/CustomKeysParent.sys.mjs",
  ShortcutUtils: "resource://gre/modules/ShortcutUtils.sys.mjs",
  WhimsyPanels: "resource:///modules/whimsy/WhimsyPanels.sys.mjs",
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
  ZenKeyboardShortcuts: "resource:///modules/zen/kbs/ZenKeyboardShortcuts.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () =>
  new Localization(["browser/customkeys.ftl", "browser/whimsy.ftl"], true));

const FEATURE_PREF = "whimsy.feature.cheatsheet";
const PANEL_ID = "whimsy-cheatsheet-panel";

// Names for keys whose Whimsy wording differs from (or is missing in) the
// about:keyboard metadata. Bindings always come from the <key> elements.
const WHIMSY_TITLES = new Map([
  ["zen-duplicate-tab", "whimsy-cheatsheet-duplicate-tab"],
  ["zen-toggle-pin-tab", "whimsy-cheatsheet-pin-tab"],
  ["key_whimsyTabNext", "whimsy-cheatsheet-tab-next"],
  ["key_whimsyTabPrev", "whimsy-cheatsheet-tab-prev"],
  ["key_whimsyFocusSidebar", "whimsy-cheatsheet-focus-sidebar"],
  ["key_whimsyCheatsheet", "whimsy-cheatsheet-self"],
  // fixB: clearer names for the shortcuts people use most.
  ["key_newNavigatorTab", "whimsy-cheatsheet-new-tab"],
  ["key_close", "whimsy-cheatsheet-close-tab"],
  ["key_restoreLastClosedTabOrWindowOrSession", "whimsy-cheatsheet-reopen-tab"],
  ["zen-copy-url", "whimsy-cheatsheet-copy-url"],
  ["key_whimsyNewPrivateTab", "whimsy-cheatsheet-private-tab"],
  ["focusURLBar", "whimsy-cheatsheet-address-bar"],
  ["zen-toggle-sidebar", "whimsy-cheatsheet-toggle-sidebar"],
  ["zen-compact-mode-toggle", "whimsy-cheatsheet-compact-mode"],
  ["zen-workspace-forward", "whimsy-cheatsheet-next-space"],
  ["zen-workspace-backward", "whimsy-cheatsheet-prev-space"],
  ["zen-library-toggle", "whimsy-cheatsheet-library"],
  ["zen-split-view-vertical", "whimsy-cheatsheet-split-vertical"],
  ["zen-split-view-horizontal", "whimsy-cheatsheet-split-horizontal"],
  ["zen-split-view-grid", "whimsy-cheatsheet-split-grid"],
  ["zen-split-view-unsplit", "whimsy-cheatsheet-unsplit"],
  ["key_whimsySwapPanes", "whimsy-cheatsheet-swap-panes"],
  ["key_whimsyCloseOtherPanes", "whimsy-cheatsheet-close-other-panes"],
  ["key_find", "whimsy-cheatsheet-find"],
  ["key_toggleReaderMode", "whimsy-cheatsheet-reader"],
  ["key_whimsyCopyFullPage", "whimsy-cheatsheet-copy-full-page"],
  ["key_whimsyScreenshotArc", "whimsy-cheatsheet-capture"],
  ["key_whimsyTranslateSelection", "whimsy-cheatsheet-translate"],
  ["key_whimsySpeedUp", "whimsy-cheatsheet-speed-up"],
  ["key_whimsySlowDown", "whimsy-cheatsheet-slow-down"],
  ["key_newNavigator", "whimsy-cheatsheet-new-window"],
  ["key_whimsyQuickWindow", "whimsy-cheatsheet-quick-window"],
  ["key_privatebrowsing", "whimsy-cheatsheet-private-window"],
  // wave5: Easel (Arc's File > New Easel, Ctrl+Shift+E).
  ["key_whimsyNewEasel", "whimsy-action-new-easel"],
]);

function formatSync(id) {
  try {
    const [message] = lazy.l10n.formatMessagesSync([{ id }]);
    return (
      message?.value ??
      message?.attributes?.find(a => a.name == "heading" || a.name == "label")?.value ??
      ""
    );
  } catch (e) {
    console.error(`Whimsy: shortcut sheet string ${id}`, e);
    return "";
  }
}

// about:keyboard titles are either text or a "customkeys-" Fluent id.
function text(title) {
  return typeof title == "string" && title.startsWith("customkeys-") ? formatSync(title) : title || "";
}

// "key_whimsyCopyFullPage" -> "Copy Full Page": only for Whimsy's own keys,
// which may not have a cheat-sheet string yet.
function readableId(id) {
  const words = id
    .replace(/^(?:key|cmd)[_-]?/i, "")
    .replace(/^whimsy[_-]?/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
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

  // [{ heading, rows: [{ keyId, title, label }] }], in display order.
  async catalogue(win) {
    const { document } = win;
    const source = {
      browsingContext: { topChromeWindow: win },
      getKeyData: id => (document.getElementById(id)?.localName == "key" ? {} : null),
    };
    let zen = {};
    try {
      zen = await lazy.ZenKeyboardShortcuts.addKeys(source, {});
    } catch (e) {
      console.error("Whimsy: shortcut sheet (Zen groups)", e);
    }
    let firefox = {};
    try {
      // Also tells DevTools to fill the Browser Tools menu, as about:keyboard does.
      firefox = lazy.CustomKeysParent.prototype.getKeys.call(source);
    } catch (e) {
      console.error("Whimsy: shortcut sheet (Firefox groups)", e);
    }

    const groups = new Map();
    const placed = new Set();
    const add = (heading, keyEl, title) => {
      if (!heading || !title || keyEl?.localName != "key" || placed.has(keyEl)) {
        return;
      }
      placed.add(keyEl);
      if (
        keyEl.getAttribute("disabled") == "true" ||
        (!keyEl.getAttribute("key") && !keyEl.getAttribute("keycode"))
      ) {
        return;
      }
      const label = lazy.ShortcutUtils.prettifyShortcut(keyEl);
      if (!label) {
        return;
      }
      let group = groups.get(heading);
      if (!group) {
        group = { heading, rows: [], seen: new Set() };
        groups.set(heading, group);
      }
      // Firefox has alternates (e.g. two Reload keys) with the same binding.
      const identity = `${title}\n${label}`;
      if (!group.seen.has(identity)) {
        group.seen.add(identity);
        group.rows.push({ keyId: keyEl.id, title, label });
      }
    };
    const titleOf = keyEl => {
      const l10nId = WHIMSY_TITLES.get(keyEl.id);
      const command = keyEl.getAttribute("command");
      return (
        (l10nId && formatSync(l10nId)) ||
        keyEl.getAttribute("label") ||
        (command && document.getElementById(command)?.getAttribute("label")) ||
        (keyEl.id && document.querySelector(`menuitem[key="${win.CSS.escape(keyEl.id)}"]`)?.label) ||
        ""
      );
    };

    const whimsyHeading = formatSync("whimsy-cheatsheet-group-whimsy");
    for (const keyEl of document.querySelectorAll("#whimsyKeyset > key")) {
      add(whimsyHeading, keyEl, titleOf(keyEl) || readableId(keyEl.id));
    }
    for (const categories of [zen, firefox]) {
      for (const [heading, entries] of Object.entries(categories ?? {})) {
        for (const [id, data] of Object.entries(entries)) {
          const keyEl = document.getElementById(id);
          const title = WHIMSY_TITLES.has(id) ? titleOf(keyEl) : text(data.title);
          add(text(heading), keyEl, title);
        }
      }
    }
    const otherHeading = formatSync("whimsy-cheatsheet-group-other");
    const others = [...document.querySelectorAll("keyset > key")]
      .filter(keyEl => !placed.has(keyEl))
      .map(keyEl => [keyEl, titleOf(keyEl)])
      .filter(([, title]) => title)
      .sort(([, a], [, b]) => a.localeCompare(b));
    for (const [keyEl, title] of others) {
      add(otherHeading, keyEl, title);
    }

    return [...groups.values()]
      .filter(group => group.rows.length)
      .map(({ heading, rows }) => ({ heading, rows }));
  },

  // Flat list, for tests and callers that don't need the grouping.
  async rows(win) {
    return (await this.catalogue(win)).flatMap(group =>
      group.rows.map(row => ({ ...row, group: group.heading }))
    );
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
    if (!this.enabled) {
      return;
    }
    const { document } = win;
    if (document.getElementById(PANEL_ID)) {
      return;
    }
    let catalogue = [];
    try {
      catalogue = await this.catalogue(win);
    } catch (e) {
      console.error("Whimsy: shortcut sheet", e);
    }
    if (document.getElementById(PANEL_ID)) {
      return; // Opened twice in a row; the first one wins.
    }

    let body = null;
    let panel = null;
    // Typing rebuilds the list from the catalogue, read once per opening.
    const render = (query = "") => {
      body.replaceChildren();
      const q = query.trim().toLocaleLowerCase();
      for (const group of catalogue) {
        const headingMatches = q && group.heading.toLocaleLowerCase().includes(q);
        const rows = group.rows.filter(
          row => !q || headingMatches || `${row.title} ${row.label}`.toLocaleLowerCase().includes(q)
        );
        if (!rows.length) {
          continue;
        }
        const section = document.createXULElement("vbox");
        section.className = "whimsy-cheatsheet-group";
        section.setAttribute("role", "group");
        section.setAttribute("aria-label", group.heading);
        const caption = lazy.WhimsyPanels.caption(document, { text: group.heading });
        caption.classList.add("whimsy-cheatsheet-heading");
        section.append(caption);
        for (const row of rows) {
          const item = lazy.WhimsyPanels.item(document, {
            label: row.title,
            keys: row.label,
            onCommand: () => {
              lazy.WhimsyPanels.close(panel);
              if (row.keyId != "key_whimsyCheatsheet") {
                this.run(win, row.keyId);
              }
            },
          });
          item.classList.add("whimsy-cheatsheet-row");
          item.setAttribute("data-key-id", row.keyId);
          item.setAttribute("whimsy-key", row.keyId);
          item.setAttribute("aria-label", `${row.title}, ${row.label}`);
          section.append(item);
        }
        body.append(section);
      }
      if (!body.childElementCount) {
        const empty = lazy.WhimsyPanels.empty(document, { l10nId: "whimsy-cheatsheet-empty" });
        empty.classList.add("whimsy-cheatsheet-empty");
        body.append(empty);
      }
    };
    let footer;
    ({ panel, body, footer } = lazy.WhimsyPanels.create(win, {
      id: PANEL_ID,
      titleL10nId: "whimsy-cheatsheet-title",
      size: "large",
      search: { l10nId: "whimsy-cheatsheet-search", onInput: render },
      footer: true,
    }));
    panel.classList.add("whimsy-cheatsheet");
    // Filled once it shows, after the sheet has focused its search field.
    panel.addEventListener("popupshown", () => render(), { once: true });

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
