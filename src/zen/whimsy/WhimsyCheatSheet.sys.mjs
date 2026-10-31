/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Shortcut cheat sheet: Cmd+/ (Help > Keyboard Shortcuts, or the command
// bar's "Keyboard Shortcuts") opens a centred, searchable reference of
// every shortcut in the window, with its *current* binding.
// whimsy.feature.cheatsheet.
//
// wave8/cheatsheet (W8-47), a redesign. The model is the Mac menu bar, not
// a command palette: Arc has no cheat sheet (it lists shortcuts beside
// commands in its command bar and in Settings), and Whimsy already has
// both of those (the command bar shows each command's shortcut;
// about:keyboard edits them). What neither does is let you *scan* what
// exists, so this is a reference card:
//
// - Groups are the menu-bar menus, in menu-bar order (File, Edit, View,
//   Spaces, Tabs, History, Bookmarks, Tools, Window, Help), then "Other".
//   A shortcut sits under the menu where its item is; one that isn't a
//   menu item goes where WhimsyCommands.menuOf() (the registry) or Zen's
//   group says it belongs. Within a menu, rows follow the menu's order.
// - Names come from the registry (WhimsyCommands.title), so a command has
//   one name in the menu, the command bar, about:keyboard and here.
// - Each shortcut is drawn as separate key caps in the platform's order
//   (macOS: Control, Option, Shift, Command, then the key).
// - A shortcut the person changed says "Custom", with the default in its
//   tooltip and its accessible name.
// - Rows are read-only: running things is the command bar's job, and an
//   Enter that closes a tab from a reference card is a trap. The one
//   action is "Edit Shortcuts…" (about:keyboard).
// - Keyboard: typing filters at once (title, menu, key names such as
//   "cmd shift d" or "⇧⌘D", or "custom"); Down moves into the list, Up/Down,
//   Page Up/Down, Home/End move through it, typing on a row goes back to
//   the search; Esc clears the search, a second Esc closes.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  CustomKeys: "moz-src:///browser/components/customkeys/CustomKeys.sys.mjs",
  CustomKeysParent: "moz-src:///browser/components/customkeys/CustomKeysParent.sys.mjs",
  ShortcutUtils: "resource://gre/modules/ShortcutUtils.sys.mjs",
  WhimsyPanels: "resource:///modules/whimsy/WhimsyPanels.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  ZenKeyboardShortcuts: "resource:///modules/zen/kbs/ZenKeyboardShortcuts.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () =>
  new Localization(["browser/customkeys.ftl", "browser/whimsy.ftl"], true));

const FEATURE_PREF = "whimsy.feature.cheatsheet";
const PANEL_ID = "whimsy-cheatsheet-panel";
const HTML_NS = "http://www.w3.org/1999/xhtml";
const OTHER = "other";
const PAGE_STEP = 8;
const SHEET_WIDTH = 680;

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
  // wave6: Cmd+Shift+N is Scratch, not a private window; Cmd+N a new space.
  ["key_whimsyNewScratch", "whimsy-cheatsheet-new-scratch"],
  ["key_whimsyNewSpace", "whimsy-cheatsheet-new-space"],
]);

// Zen's shortcuts that aren't menu items: the menu a Mac user would look
// in (Arc's menu bar, where Arc has the command).
const ZEN_MENUS = new Map([
  ["zen-compact-mode-toggle", "view-menu"],
  ["zen-compact-mode-show-sidebar", "view-menu"],
  ["zen-toggle-sidebar", "view-menu"],
  ["zen-glance-expand", "view-menu"],
  ["zen-split-view-grid", "view-menu"],
  ["zen-split-view-vertical", "view-menu"],
  ["zen-split-view-horizontal", "view-menu"],
  ["zen-split-view-unsplit", "view-menu"],
  ["zen-new-empty-split-view", "view-menu"],
  ["zen-workspace-forward", "zen-spaces-menubar"],
  ["zen-workspace-backward", "zen-spaces-menubar"],
  ["zen-workspace-create", "zen-spaces-menubar"],
  ["zen-close-all-unpinned-tabs", "whimsy-tabs-menubar"],
  ["zen-toggle-pin-tab", "whimsy-tabs-menubar"],
  ["zen-pinned-tab-reset-shortcut", "whimsy-tabs-menubar"],
  ["zen-duplicate-tab", "whimsy-tabs-menubar"],
  ["zen-copy-url", "edit-menu"],
  ["zen-copy-url-markdown", "edit-menu"],
  ["zen-library-toggle", "windowMenu"],
]);
// Firefox's "Navigation" shortcuts, which aren't menu items either: where
// Safari keeps them (Back/Forward/Home in History, Reload/Stop in View).
const NAV_MENUS = [
  [/^(?:goBackKb|goForwardKb|goHome)/, "history-menu"],
  [/^key_(?:reload|stop)/, "view-menu"],
  [/^key_(?:selectTab\d|selectLastTab|toggleMute)/, "whimsy-tabs-menubar"],
];
function fixedMenu(keyId) {
  return ZEN_MENUS.get(keyId) ?? NAV_MENUS.find(([pattern]) => pattern.test(keyId ?? ""))?.[1] ?? null;
}
// When a menu isn't in this window's menu bar (Arc menus switched off).
const MENU_FALLBACK = new Map([
  ["whimsy-tabs-menubar", "file-menu"],
  ["zen-spaces-menubar", "view-menu"],
]);

const IS_MAC = AppConstants.platform == "macosx";
// Key-cap order: Apple's (⌃⌥⇧⌘) on macOS; Ctrl, Alt, Shift elsewhere.
const MODIFIER_ORDER = IS_MAC
  ? ["control", "access", "alt", "shift", "meta", "accel"]
  : ["accel", "control", "access", "meta", "alt", "shift"];
// Words people type for each cap, so "cmd shift d" finds ⇧⌘D.
const SYNONYMS = {
  "⌘": "command cmd",
  "⇧": "shift",
  "⌥": "option opt alt",
  "⌃": "control ctrl",
  Ctrl: "control ctrl",
  Alt: "option opt alt",
  Shift: "shift",
};

function formatSync(id, args) {
  try {
    const [message] = lazy.l10n.formatMessagesSync([{ id, args }]);
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

/**
 * A binding as separate key caps, in the platform's order:
 * { modifiers: "accel,shift", key: "d" } -> ["⇧", "⌘", "D"] on macOS.
 *
 * @param {{ modifiers?: string, key?: string, keycode?: string }} binding
 * @returns {string[]} empty when nothing is bound
 */
export function keyCaps({ modifiers = "", key = "", keycode = "" } = {}) {
  const keyText = lazy.ShortcutUtils.getKeyString(keycode || null, key || null);
  if (!keyText) {
    return [];
  }
  const tokens = new Set(
    (modifiers ?? "").split(/[,\s]+/).map(m => m.trim().toLowerCase()).map(m => (m == "ctrl" ? "control" : m))
  );
  const caps = [];
  for (const name of MODIFIER_ORDER) {
    if (!tokens.has(name)) {
      continue;
    }
    const cap = lazy.ShortcutUtils.getModifierString(name).replace(/[\s+]+$/, "");
    if (cap && !caps.includes(cap)) {
      caps.push(cap);
    }
  }
  caps.push(keyText);
  return caps;
}

function bindingOf(keyEl) {
  return {
    modifiers: keyEl.getAttribute("modifiers") ?? "",
    key: keyEl.getAttribute("key") ?? "",
    keycode: keyEl.getAttribute("keycode") ?? "",
  };
}

// What a row is found by: its name, its menu, its caps and their words.
function haystack(row, heading, customWord) {
  const words = row.caps.map(cap => `${cap} ${SYNONYMS[cap] ?? ""}`).join(" ");
  return `${row.title} ${heading} ${words} ${row.customized ? customWord : ""}`.toLocaleLowerCase();
}

// Every query word must match; one letter or digit must be the key itself
// or start a word of the name ("d" finds ⌘D and "Duplicate", not "Add").
function matches(query, row, hay) {
  const tokens = query
    .toLocaleLowerCase()
    .replace(/([⌘⇧⌥⌃])/g, " $1 ")
    .split(/[\s+]+/)
    .filter(Boolean);
  return tokens.every(token => {
    if (/^[\p{L}\p{N}]$/u.test(token)) {
      const key = row.caps.at(-1)?.toLocaleLowerCase();
      return key == token || hay.split(/[^\p{L}\p{N}]+/u).some(word => word.startsWith(token));
    }
    return hay.includes(token);
  });
}

export const WhimsyCheatSheet = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  initWindow(win) {
    lazy.WhimsyCommands.register(win, {
      id: "whimsy-cheatsheet",
      l10nId: "whimsy-action-cheatsheet",
      run: w => {
        if (this.enabled) {
          this.toggle(w);
        }
      },
      keyId: "key_whimsyCheatsheet",
      key: { key: "/", modifiers: "accel" },
      icon: "chrome://browser/skin/zen-icons/selectable/key.svg",
      isAvailable: () => this.enabled,
      menu: "helpMenu",
    });
  },

  /**
   * The window's shortcuts by menu-bar menu, in menu-bar order:
   * [{ id, heading, rows: [{ keyId, title, label, caps, customized,
   *    defaultLabel }] }]. `label` is the prettified binding; `defaultLabel`
   * is set for a customized key ("" when it had none).
   */
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

    // The menu bar, in order: id -> { heading, items in menu order }.
    const menubar = document.getElementById("main-menubar");
    const menus = new Map();
    for (const menu of menubar?.children ?? []) {
      if (menu.localName == "menu" && menu.id && !menu.hidden && menu.label) {
        menus.set(menu.id, { heading: menu.label, element: menu });
      }
    }
    const topMenu = item => {
      let menu = item?.closest("menu");
      while (menu && menu.parentElement != menubar) {
        menu = menu.parentElement?.closest("menu");
      }
      return menu && menus.has(menu.id) ? menu.id : null;
    };
    // about:keyboard's group names are menu (or submenu) labels: the
    // Sidebar and Browser Tools submenus belong to View and Tools.
    const menuByLabel = new Map();
    for (const menu of menubar?.querySelectorAll("menu") ?? []) {
      const top = topMenu(menu);
      if (top && menu.label && !menuByLabel.has(menu.label)) {
        menuByLabel.set(menu.label, top);
      }
    }
    // A menu item's place in the whole menu bar, so rows follow the menus.
    const menuItems = menubar ? [...menubar.querySelectorAll("menuitem")] : [];
    const order = new Map(menuItems.map((item, i) => [item, i]));
    const itemFor = keyEl => {
      const id = win.CSS.escape(keyEl.id);
      const command = keyEl.getAttribute("command");
      return (
        menubar?.querySelector(`menuitem[key="${id}"]`) ??
        (command ? menubar?.querySelector(`menuitem[command="${win.CSS.escape(command)}"]`) : null)
      );
    };
    const present = id => {
      if (menus.has(id)) {
        return id;
      }
      const fallback = MENU_FALLBACK.get(id);
      return fallback && menus.has(fallback) ? fallback : null;
    };
    const placeOf = (keyEl, heading) => {
      const item = itemFor(keyEl);
      const inMenu = topMenu(item);
      if (inMenu) {
        return { menu: inMenu, position: order.get(item) };
      }
      const command = keyEl.getAttribute("command");
      const hinted =
        present(lazy.WhimsyCommands.menuOf(keyEl.id, command)) ??
        present(fixedMenu(keyEl.id)) ??
        (heading && menuByLabel.get(heading));
      return { menu: hinted || OTHER, position: Infinity };
    };

    const titleOf = keyEl => {
      const l10nId = WHIMSY_TITLES.get(keyEl.id);
      const command = keyEl.getAttribute("command");
      return (
        // wave5: a Whimsy command has one name everywhere.
        lazy.WhimsyCommands.title(lazy.WhimsyCommands.forKey(keyEl.id)) ||
        (l10nId && formatSync(l10nId)) ||
        keyEl.getAttribute("label") ||
        (command && document.getElementById(command)?.getAttribute("label")) ||
        (keyEl.id && document.querySelector(`menuitem[key="${win.CSS.escape(keyEl.id)}"]`)?.label) ||
        ""
      );
    };

    const groups = new Map();
    const placed = new Set();
    const add = (keyEl, title, heading = null) => {
      if (!title || keyEl?.localName != "key" || placed.has(keyEl)) {
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
      const caps = keyCaps(bindingOf(keyEl));
      if (!label || !caps.length) {
        return;
      }
      const { menu, position } = placeOf(keyEl, heading);
      let group = groups.get(menu);
      if (!group) {
        group = { id: menu, rows: [], seen: new Set() };
        groups.set(menu, group);
      }
      // Firefox has alternates (e.g. two Reload keys) with the same name.
      // Keep the first binding; the other is the same command.
      if (group.seen.has(title)) {
        return;
      }
      group.seen.add(title);
      let defaultKey = null;
      try {
        defaultKey = keyEl.id ? lazy.CustomKeys.getDefaultKey(keyEl.id) : null;
      } catch (e) {
        console.error("Whimsy: shortcut sheet (custom keys)", e);
      }
      const row = { keyId: keyEl.id, title, label, caps, customized: !!defaultKey, position };
      if (defaultKey) {
        row.defaultLabel = keyCaps(defaultKey).join(IS_MAC ? "" : "+");
      }
      group.rows.push(row);
    };

    for (const keyEl of document.querySelectorAll("#whimsyKeyset > key")) {
      add(keyEl, titleOf(keyEl) || readableId(keyEl.id));
    }
    for (const categories of [zen, firefox]) {
      for (const [heading, entries] of Object.entries(categories ?? {})) {
        for (const [id, data] of Object.entries(entries)) {
          const keyEl = document.getElementById(id);
          const title = WHIMSY_TITLES.has(id) || lazy.WhimsyCommands.forKey(id) ? titleOf(keyEl) : text(data.title);
          add(keyEl, title, text(heading));
        }
      }
    }
    for (const keyEl of document.querySelectorAll("keyset > key")) {
      if (!placed.has(keyEl)) {
        add(keyEl, titleOf(keyEl));
      }
    }

    const otherHeading = formatSync("whimsy-cheatsheet-group-other");
    const ids = [...menus.keys(), OTHER];
    return ids
      .map(id => groups.get(id))
      .filter(group => group?.rows.length)
      .map(({ id, rows }) => ({
        id,
        heading: id == OTHER ? otherHeading : menus.get(id).heading,
        rows: rows
          .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title))
          .map(({ position, ...row }) => row),
      }));
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

    const customWord = formatSync("whimsy-cheatsheet-custom");
    const rows = [];
    const filter = query => {
      const q = query.trim();
      let shown = 0;
      for (const section of list.children) {
        let any = false;
        for (const entry of rows.filter(r => r.section == section)) {
          const visible = !q || matches(q, entry.row, entry.hay);
          entry.element.hidden = !visible;
          any ||= visible;
          shown += visible ? 1 : 0;
        }
        section.hidden = !any;
      }
      empty.hidden = shown > 0;
      list.hidden = !shown;
      status.textContent = q ? formatSync("whimsy-cheatsheet-results", { count: shown }) : "";
    };

    const { panel, body, footer, search } = lazy.WhimsyPanels.create(win, {
      id: PANEL_ID,
      titleL10nId: "whimsy-cheatsheet-title",
      size: "large",
      search: { l10nId: "whimsy-cheatsheet-search", onInput: value => filter(value) },
      footer: true,
      onHidden: () => win.removeEventListener("keydown", onWindowKey, true),
    });
    panel.classList.add("whimsy-cheatsheet");
    // Wide enough for two columns; WhimsyPanels centres by this width.
    const area = lazy.WhimsyPanels.visibleAnchor(win, ["tabbrowser-tabbox", "browser", "appcontent"]);
    const room = (area ?? document.documentElement).getBoundingClientRect().width - 48;
    panel.style.setProperty("--whimsy-sheet-width", `${Math.round(Math.max(320, Math.min(SHEET_WIDTH, room)))}px`);

    // The list: one section per menu, in two columns when there's room.
    const list = document.createElementNS(HTML_NS, "div");
    list.className = "whimsy-cheatsheet-columns";
    for (const group of catalogue) {
      const section = document.createElementNS(HTML_NS, "section");
      section.className = "whimsy-cheatsheet-group";
      section.dataset.menu = group.id;
      const headingId = `whimsy-cheatsheet-heading-${group.id}`;
      section.setAttribute("aria-labelledby", headingId);
      const heading = document.createElementNS(HTML_NS, "h2");
      heading.id = headingId;
      heading.className = "whimsy-cheatsheet-heading";
      heading.textContent = group.heading;
      const ul = document.createElementNS(HTML_NS, "ul");
      ul.className = "whimsy-cheatsheet-rows";
      for (const row of group.rows) {
        const li = document.createElementNS(HTML_NS, "li");
        li.className = "whimsy-cheatsheet-row";
        li.tabIndex = -1;
        li.dataset.keyId = row.keyId;
        li.setAttribute("whimsy-key", row.keyId);
        const title = document.createElementNS(HTML_NS, "span");
        title.className = "whimsy-cheatsheet-title";
        title.textContent = row.title;
        li.append(title);
        if (row.customized) {
          li.setAttribute("customized", "true");
          const badge = document.createElementNS(HTML_NS, "span");
          badge.className = "whimsy-cheatsheet-custom";
          badge.textContent = customWord;
          badge.setAttribute("aria-hidden", "true");
          li.append(badge);
          li.title = row.defaultLabel
            ? formatSync("whimsy-cheatsheet-custom-tooltip", { shortcut: row.defaultLabel })
            : formatSync("whimsy-cheatsheet-custom-tooltip-none");
        }
        const keys = document.createElementNS(HTML_NS, "span");
        keys.className = "whimsy-cheatsheet-keys";
        keys.setAttribute("aria-hidden", "true");
        for (const cap of row.caps) {
          const kbd = document.createElementNS(HTML_NS, "kbd");
          kbd.textContent = cap;
          if ([...cap].length > 1) {
            kbd.setAttribute("wide", "true");
          }
          keys.append(kbd);
        }
        li.append(keys);
        li.setAttribute(
          "aria-label",
          !row.customized
            ? formatSync("whimsy-cheatsheet-row", { title: row.title, shortcut: row.label })
            : row.defaultLabel
              ? formatSync("whimsy-cheatsheet-row-custom", { title: row.title, shortcut: row.label, default: row.defaultLabel })
              : formatSync("whimsy-cheatsheet-row-added", { title: row.title, shortcut: row.label })
        );
        ul.append(li);
        rows.push({ row, element: li, section, hay: haystack(row, group.heading, customWord) });
      }
      section.append(heading, ul);
      list.append(section);
    }

    const empty = lazy.WhimsyPanels.empty(document, { l10nId: "whimsy-cheatsheet-empty" });
    empty.classList.add("whimsy-cheatsheet-empty");
    empty.hidden = true;
    // Read out how many shortcuts a search leaves.
    const status = document.createElementNS(HTML_NS, "div");
    status.className = "whimsy-cheatsheet-status";
    status.setAttribute("role", "status");
    body.append(list, empty, status);
    body.classList.add("whimsy-cheatsheet-body");
    if (!rows.length) {
      list.hidden = true;
      empty.hidden = false;
    }

    // The one action: edit them, in about:keyboard.
    const edit = lazy.WhimsyPanels.footerButton(document, {
      l10nId: "whimsy-cheatsheet-edit-button",
      onCommand: () => {
        lazy.WhimsyPanels.close(panel);
        win.switchToTabHavingURI(Services.io.newURI("about:keyboard"), true);
      },
    });
    edit.classList.add("whimsy-cheatsheet-edit");
    footer.append(edit);

    const visibleRows = () => rows.filter(r => !r.element.hidden && !r.section.hidden).map(r => r.element);
    const focusRow = element => {
      element.focus();
      element.scrollIntoView({ block: "nearest" });
    };
    // Runs before WhimsyPanels' own keys (capture, on the panel): rows are
    // a read-only list, and Esc clears a search before it closes.
    panel.addEventListener(
      "keydown",
      event => {
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
          return;
        }
        const onRow = event.target.classList?.contains("whimsy-cheatsheet-row");
        const onSearch = event.target == search;
        if (!onRow && !onSearch) {
          return;
        }
        const items = visibleRows();
        const index = onRow ? items.indexOf(event.target) : -1;
        const step = { ArrowDown: 1, ArrowUp: -1, PageDown: PAGE_STEP, PageUp: -PAGE_STEP }[event.key];
        if (step && items.length) {
          event.preventDefault();
          event.stopPropagation();
          if (onSearch) {
            if (step > 0) {
              focusRow(items[0]);
            }
            return;
          }
          const next = index + step;
          if (next < 0) {
            search.focus();
            body.scrollTop = 0;
          } else {
            focusRow(items[Math.min(next, items.length - 1)]);
          }
          return;
        }
        if (onRow && (event.key == "Home" || event.key == "End") && items.length) {
          event.preventDefault();
          event.stopPropagation();
          focusRow(items[event.key == "Home" ? 0 : items.length - 1]);
          return;
        }
        if (event.key == "Enter") {
          // Nothing to run: this is a reference, not a palette.
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (onRow && (event.key.length == 1 || event.key == "Backspace")) {
          // Typing on a row goes back to the search; the key lands there.
          search.focus();
        }
      },
      true
    );
    // Esc: clear the search first (WhimsyPanels' window listener closes
    // the sheet on any Esc; this runs before it, being added first).
    const onWindowKey = event => {
      if (event.key == "Escape" && panel.state == "open" && search.value) {
        event.preventDefault();
        event.stopPropagation();
        search.value = "";
        filter("");
        search.focus();
        body.scrollTop = 0;
      }
    };
    win.addEventListener("keydown", onWindowKey, true);
    lazy.WhimsyPanels.open(win, panel);
  },
};
