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

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  CustomKeysParent: "moz-src:///browser/components/customkeys/CustomKeysParent.sys.mjs",
  ShortcutUtils: "resource://gre/modules/ShortcutUtils.sys.mjs",
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
  ZenKeyboardShortcuts: "resource:///modules/zen/kbs/ZenKeyboardShortcuts.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () =>
  new Localization(["browser/customkeys.ftl", "browser/whimsy.ftl"], true));

const FEATURE_PREF = "whimsy.feature.cheatsheet";

// Names for keys whose Whimsy wording differs from (or is missing in) the
// about:keyboard metadata. Bindings always come from the <key> elements.
const WHIMSY_TITLES = new Map([
  ["zen-duplicate-tab", "whimsy-cheatsheet-duplicate-tab"],
  ["zen-toggle-pin-tab", "whimsy-cheatsheet-pin-tab"],
  ["key_whimsyTabNext", "whimsy-cheatsheet-tab-next"],
  ["key_whimsyTabPrev", "whimsy-cheatsheet-tab-prev"],
  ["key_whimsyFocusSidebar", "whimsy-cheatsheet-focus-sidebar"],
  ["key_whimsyCheatsheet", "whimsy-cheatsheet-self"],
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
    const existing = win.document.getElementById("whimsy-cheatsheet-panel");
    if (existing) {
      existing.hidePopup();
      return;
    }
    this.open(win);
  },

  open(win) {
    if (!this.enabled) {
      return;
    }
    const { document } = win;
    const panel = document.createXULElement("panel");
    panel.id = "whimsy-cheatsheet-panel";
    panel.setAttribute("noautohide", "false");
    panel.setAttribute("type", "arrow");
    panel.className = "whimsy-cheatsheet";

    const search = document.createElementNS("http://www.w3.org/1999/xhtml", "input");
    search.setAttribute("type", "search");
    document.l10n.setAttributes(search, "whimsy-cheatsheet-search");
    panel.appendChild(search);

    const list = document.createXULElement("vbox");
    list.className = "whimsy-cheatsheet-list";
    panel.appendChild(list);

    const editLink = document.createXULElement("label");
    editLink.className = "whimsy-cheatsheet-edit text-link";
    document.l10n.setAttributes(editLink, "whimsy-cheatsheet-edit");
    editLink.addEventListener("click", () => {
      win.switchToTabHavingURI(Services.io.newURI("about:keyboard"), true);
      panel.hidePopup();
    });
    panel.appendChild(editLink);

    // Built once per opening; typing only filters it.
    let catalogue = null;
    const render = () => {
      list.replaceChildren();
      if (!catalogue) {
        return;
      }
      const query = search.value.trim().toLocaleLowerCase();
      for (const group of catalogue) {
        const headingMatches = query && group.heading.toLocaleLowerCase().includes(query);
        const rows = group.rows.filter(
          row => !query || headingMatches || `${row.title} ${row.label}`.toLocaleLowerCase().includes(query)
        );
        if (!rows.length) {
          continue;
        }
        const section = document.createXULElement("vbox");
        section.className = "whimsy-cheatsheet-group";
        section.setAttribute("role", "group");
        section.setAttribute("aria-label", group.heading);
        const heading = document.createXULElement("label");
        heading.className = "whimsy-cheatsheet-heading";
        heading.textContent = group.heading;
        section.appendChild(heading);
        for (const row of rows) {
          const line = document.createXULElement("hbox");
          line.className = "whimsy-cheatsheet-row";
          line.setAttribute("data-key-id", row.keyId);
          const name = document.createXULElement("label");
          name.textContent = row.title;
          const key = document.createXULElement("label");
          key.className = "whimsy-cheatsheet-key";
          key.textContent = row.label;
          line.append(name, key);
          section.appendChild(line);
        }
        list.appendChild(section);
      }
      if (!list.childElementCount) {
        const empty = document.createXULElement("label");
        empty.className = "whimsy-cheatsheet-empty";
        document.l10n.setAttributes(empty, "whimsy-cheatsheet-empty");
        list.appendChild(empty);
      }
    };
    search.addEventListener("input", render);
    panel.addEventListener("popupshown", () => {
      search.focus();
      this.catalogue(win)
        .then(result => {
          if (panel.isConnected) {
            catalogue = result;
            render();
          }
        })
        .catch(e => console.error("Whimsy: shortcut sheet", e));
    });
    panel.addEventListener("keydown", event => {
      if (event.key == "Escape") {
        panel.hidePopup();
      }
    });
    panel.addEventListener("popuphidden", () => panel.remove());

    document.documentElement.appendChild(panel);
    const { screenX, outerWidth, screenY, outerHeight } = win;
    panel.openPopupAtScreen(
      screenX + Math.max(24, outerWidth / 2 - 260),
      screenY + Math.max(24, outerHeight / 2 - 240),
      false
    );
  },
};
