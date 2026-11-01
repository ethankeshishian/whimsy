/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave5: Whimsy's command registry. Every user-facing Whimsy action is one
// named command, the way a Mac app's menu commands are: one name, one
// place to run it from the keyboard, one shortcut the person can change.
// Registering a command gives it, in one call:
//
// - a <command> element that runs it (or reuses Zen's or Firefox's own);
// - a <key> in Whimsy's keyset, bound to its default shortcut or empty,
//   so Settings → Keyboard Shortcuts (about:keyboard) lists it under
//   "Whimsy" and the person can assign or change a shortcut there;
// - an entry in the command bar, under the same name, showing its
//   current shortcut;
// - the same name in the shortcut cheat sheet (Cmd+/).
//
// Context menus and sidebar controls stay where they are and call the
// same command; Settings keeps passive preferences only.
//
// Default shortcuts follow Arc where Arc has one, or keep a shortcut
// Whimsy already shipped. A default that would take a key another
// command already uses is refused (left unbound and logged), so Whimsy
// never shadows a system, Firefox or Zen shortcut by accident; a module
// that takes over a key on purpose clears the other key first (see
// WhimsyShortcuts and WhimsyPrivate). Changing a shortcut goes through
// Firefox's CustomKeys, which saves it in customKeys.json and asks before
// it takes a key that's in use, as about:keyboard does for Zen's keys.
//
// about:keyboard reads the list through the "kbs-whimsy-commands" hook in
// whimsy/overlay.py (one line in ZenKeyboardShortcuts.addKeys).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  CustomKeys: "moz-src:///browser/components/customkeys/CustomKeys.sys.mjs",
  ShortcutUtils: "resource://gre/modules/ShortcutUtils.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["branding/brand.ftl", "browser/whimsy.ftl"], true));

const FEATURE_PREF = "whimsy.feature.command-registry";
const KEYSET_ID = "whimsyKeyset";
const AUTO_KEY_ATTR = "whimsy-command-key";
const GROUP_L10N_ID = "whimsy-cheatsheet-group-whimsy";
// wave10/mini: commands whose keys work only inside one kind of window
// (spec.scope) get their own group in about:keyboard, listed from every
// window; a shortcut there never conflicts with one outside that scope.
const SCOPE_GROUPS = { mini: "whimsy-keys-group-mini" };
// W10-39: every other bound <key> in any browser window (Zen's, Firefox's,
// DevTools', Mini's) that about:keyboard didn't list, so a shortcut one of
// them holds shows as a conflict and can be reassigned.
const OTHER_GROUP_L10N_ID = "whimsy-keys-group-other";
// Mini's disabled stand-ins in main windows (WhimsyQuickWindow); Mini's
// group lists them already.
const MINI_STANDIN_KEYSET_ID = "whimsyMiniKeyset";

// Session-wide: command id → { id, l10nId, keyId, defaultKey, variants }.
// Every window registers the same commands as it starts, so the entries
// describe all of them.
const entries = new Map();
// Documents inside batchKeys().
const batching = new WeakSet();

function normalizeModifiers(modifiers) {
  return (modifiers ?? "")
    .split(/[,\s]+/)
    .map(m => m.trim().toLowerCase())
    .filter(Boolean)
    .map(m => (m == "ctrl" ? "control" : m))
    .sort()
    .join(",");
}

// A comparable form of a binding: { modifiers, key | keycode } or a <key>.
function signature(binding) {
  const get = name =>
    typeof binding.getAttribute == "function" ? binding.getAttribute(name) : binding[name];
  const keycode = get("keycode");
  const key = get("key");
  if (!keycode && !key) {
    return null;
  }
  const what = keycode ? `code:${keycode.toUpperCase()}` : `key:${key.toUpperCase()}`;
  return `${normalizeModifiers(get("modifiers"))}|${what}`;
}

function bindingOf(spec) {
  if (!spec || (!spec.key && !spec.keycode)) {
    return null;
  }
  const binding = { modifiers: spec.modifiers ?? "" };
  if (spec.keycode) {
    binding.keycode = spec.keycode;
  } else {
    binding.key = spec.key;
  }
  return binding;
}

// wave10 (W10-12): `args` is an object, or a function returning one, for
// commands that share a message ("Turn { $name } On", one per setting).
function resolveArgs(args) {
  return typeof args == "function" ? args() : (args ?? undefined);
}

function formatSync(l10nId, args) {
  try {
    return lazy.l10n.formatValueSync(l10nId, resolveArgs(args)) ?? "";
  } catch (e) {
    console.error(`Whimsy: command name ${l10nId}`, e);
    return "";
  }
}

// wave8/cheatsheet: the menu-bar menu each command belongs to, by command
// id or <key> id, for commands that aren't (yet) items in the menu bar.
// The shortcut cheat sheet groups by these, so a shortcut is listed where
// a Mac user would look for it. A command that is a menu item is grouped
// by where it actually sits; this table is the fallback.
const MENU_OF = {
  "file-menu": [
    "cmd_whimsyNewPrivateTab", "cmd_whimsyQuickWindow", "Browser:Screenshot", "cmd_whimsyCopyFullPage",
    "cmd_whimsyCapturePortrait", "cmd_whimsyCaptureRedact", "whimsy-cmd-print-clean", "cmd_whimsyCast",
    "cmd_whimsyCastStop", "cmd_whimsyShowQRCode", "key_whimsyQuickWindowChooseSpace",
    "key_whimsyQuickWindowOpenInSpace",
  ],
  "edit-menu": [
    "cmd_whimsyCopyURLQuote", "cmd_whimsyCopyPageMarkdown", "cmd_whimsyTranslateSelection", "cmd_whimsyEditPage",
    "cmd_whimsyAllowCopy", "cmd_whimsyPasteGuard", "cmd_whimsyCreateEmailAlias", "cmd_whimsySelectionVerbs",
  ],
  "view-menu": [
    "whimsy-focus-sidebar", "cmd_whimsyToggleToolbar", "cmd_whimsySplitChangeOrientation", "cmd_whimsySplitPaneMenu",
    "cmd_whimsySwapPanes", "cmd_whimsyCloseOtherPanes", "cmd_whimsyFollowerSplit", "cmd_zenGlanceSplit",
    "whimsy-cmd-favorite-split", "whimsy-cmd-open-split-favorites", "cmd_whimsyDoNotDisturb", "key_whimsyLinkHints",
    "key_whimsyAddSplitView", "key_whimsyCloseSplitPane", "key_whimsyNextPane", "key_whimsyPrevPane",
    "key_whimsySplitGlance", "key_whimsySpeedUp", "key_whimsySlowDown", "whimsy-game-open", "whimsy-year-open",
    "cmd_whimsyToggleViewSourceWrap",
  ],
  "zen-spaces-menubar": [
    "cmd_zenOpenWorkspaceCreation", "cmd_whimsyNewScratch", "cmd_whimsyKeepScratch", "cmd_whimsyCloseScratch",
    "cmd_whimsyLockSpace", "cmd_whimsyHideSpace", "cmd_whimsyResetSpaceTabs", "cmd_whimsyMoveToNewSpace",
    "cmd_whimsyViewArchive", "cmd_whimsyClearArchive", "key_whimsyManageSpaces",
  ],
  "whimsy-tabs-menubar": [
    "whimsy-tab-next", "whimsy-tab-prev", "cmd_whimsyRevealTab", "cmd_whimsySnoozeTab", "cmd_whimsyGroupBySite",
    "cmd_whimsyTidyTabs", "cmd_whimsyMuteSite", "cmd_whimsyTabVolume", "cmd_whimsyHeavyTabs",
    "cmd_whimsyPlaylistSave", "key_whimsyNewFolder", "key_whimsyZap",
  ],
  "tools-menu": [
    "cmd_whimsyVPNToggle", "cmd_whimsyFireButton", "cmd_whimsyForgetSite", "cmd_whimsyWatchPage",
    "whimsy-useragent-picker", "whimsy-cookie-editor", "whimsy-devmode-toggle-site", "cmd_whimsyJoinMeeting",
    "cmd_whimsyToggleBatterySaver",
  ],
  "windowMenu": ["key_whimsyAirTrafficControl"],
  "helpMenu": ["whimsy-cheatsheet", "cmd_whimsyTeachReset"],
};
const MENU_BY_ID = new Map(Object.entries(MENU_OF).flatMap(([menu, ids]) => ids.map(id => [id, menu])));

export const WhimsyCommands = {
  get listed() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  // Every registered command, for about:keyboard, the cheat sheet and tests.
  get entries() {
    return [...entries.values()];
  },

  get(id) {
    return entries.get(id) ?? null;
  },

  // The entry whose <key> has this id.
  forKey(keyId) {
    return this.entries.find(entry => entry.keyId == keyId) ?? null;
  },

  // wave8/cheatsheet: the menu-bar menu id a command or <key> belongs to
  // (see MENU_OF), or null. `spec.menu` on register() wins.
  menuOf(...ids) {
    for (const id of ids) {
      if (!id) {
        continue;
      }
      const entry = entries.get(id) ?? this.forKey(id);
      const menu = entry?.menu ?? MENU_BY_ID.get(id) ?? (entry && (MENU_BY_ID.get(entry.id) ?? MENU_BY_ID.get(entry.keyId)));
      if (menu) {
        return menu;
      }
    }
    return null;
  },

  // wave9/menus (design-full-4 M11): a command's extra search words, from a
  // comma-separated whimsy.ftl message, so they're localized like its name.
  keywords(l10nId) {
    return formatSync(l10nId)
      .split(",")
      .map(word => word.trim())
      .filter(Boolean);
  },

  // The command's name, as the command bar and about:keyboard show it.
  title(entry) {
    return entry?.l10nId ? formatSync(entry.l10nId, entry.l10nArgs) : "";
  },

  /**
   * Register a command in a window. Call it from the module's
   * initWindow(win), so every window gets the same commands.
   *
   * @param {Window} win
   * @param {object} spec
   * @param {string} spec.id The <command> id (Zen's or Firefox's own when
   *   there's no `run`).
   * @param {string} [spec.l10nId] Its name in whimsy.ftl: the command-bar
   *   label and its row in about:keyboard. Without one the command is
   *   internal: it gets a <key> only if it has a default.
   * @param {Function} [spec.run] run(win) when the command fires.
   * @param {string} [spec.keyId] The <key> id; kept stable, since
   *   customKeys.json stores customizations by it. Default "key_<id>".
   * @param {object} [spec.key] The default shortcut, { key | keycode,
   *   modifiers }, or null for none (still listed, so it can be assigned).
   * @param {string} [spec.icon] Command-bar icon.
   * @param {Function} [spec.isAvailable] isAvailable(win) for the command bar.
   * @param {Array} [spec.variants] State-aware command-bar names, e.g.
   *   "Turn VPN On" / "Turn VPN Off": [{ l10nId, isAvailable }]. The
   *   command keeps one neutral name (spec.l10nId) for its shortcut.
   * @param {boolean} [spec.commandBar=true] false to leave it out of the
   *   command bar (the module offers it there some other way).
   * @param {string} [spec.menu] The menu-bar menu id it belongs to, for
   *   the cheat sheet's grouping (else MENU_OF, else where it sits).
   * @param {object|Function} [spec.l10nArgs] Arguments for l10nId (and
   *   for each variant without its own), or a function returning them,
   *   called only when the name is shown. Lets one message name many
   *   commands (W10-12: "Turn { $name } On" for every setting).
   * @returns {Element|null} The <command>.
   */
  register(win, spec) {
    const keyId = spec.keyId ?? `key_${spec.id}`;
    const entry = this.describe({ ...spec, keyId });
    let command = null;
    try {
      command = spec.run ? this.addCommandElement(win, spec.id, spec.run) : win.document.getElementById(spec.id);
      // A Zen or Firefox command that already has a <key> keeps it (it's
      // listed and bindable in Zen's or Firefox's group); Whimsy adds a
      // second key only to give it an Arc default.
      const ownKey = !spec.run && !spec.key && this.existingKey(win, spec.id);
      if (ownKey) {
        entry.keyId = null;
        entry.elsewhere = ownKey.id;
      } else if (spec.l10nId || spec.key) {
        this.addKey(win, { ...(spec.key ?? {}), id: keyId, command: spec.id });
      }
    } catch (e) {
      console.error(`Whimsy: command ${spec.id}`, e);
    }
    // Whether the command bar offers it (some commands are keys and menu
    // items only, e.g. focusing split pane N).
    entry.inCommandBar = spec.commandBar !== false;
    if (spec.l10nId && entry.inCommandBar) {
      this.addToCommandBar(entry, spec);
    }
    return command;
  },

  // Records a command without touching a window (also used by the
  // WhimsyShortcuts shims). Later calls fill in what earlier ones lacked.
  describe(spec) {
    const entry = entries.get(spec.id) ?? { id: spec.id, l10nId: null, keyId: null, defaultKey: null, variants: [] };
    entry.l10nId ??= spec.l10nId ?? null;
    entry.keyId ??= spec.keyId ?? null;
    entry.defaultKey ??= bindingOf(spec.key);
    entry.menu ??= spec.menu ?? null;
    entry.scope ??= spec.scope ?? null;
    entry.l10nArgs ??= spec.l10nArgs ?? null;
    for (const variant of spec.variants ?? []) {
      if (!entry.variants.includes(variant.l10nId)) {
        entry.variants.push(variant.l10nId);
      }
    }
    entries.set(spec.id, entry);
    return entry;
  },

  // A key's or binding's shortcut, normalised ("accel,alt|key:T"), or null.
  keySignature(keyOrBinding) {
    return signature(keyOrBinding);
  },

  existingKey(win, commandId) {
    return (
      [...win.document.querySelectorAll(`key[command="${win.CSS.escape(commandId)}"]`)].find(
        keyEl => keyEl.parentElement?.id != KEYSET_ID
      ) ?? null
    );
  },

  addCommandElement(win, id, run) {
    const { document } = win;
    const existing = document.getElementById(id);
    if (existing) {
      return existing;
    }
    const command = document.createXULElement("command");
    command.id = id;
    command.addEventListener("command", () => {
      try {
        const result = run(win);
        result?.catch?.(e => console.error(`Whimsy: ${id} failed`, e));
      } catch (e) {
        console.error(`Whimsy: ${id} failed`, e);
      }
    });
    (document.getElementById("mainCommandSet") ?? document.documentElement).append(command);
    return command;
  },

  /**
   * A <key> for a command, in Whimsy's own keyset beside Firefox's (Zen
   * rebuilds its own). Bound to the default unless another key already
   * uses that shortcut; empty otherwise, ready to be assigned.
   */
  addKey(win, { id, command, key = null, keycode = null, modifiers = "", allowConflict = false }) {
    const { document } = win;
    if (document.getElementById(id)) {
      return document.getElementById(id);
    }
    const keyEl = document.createXULElement("key");
    keyEl.id = id;
    keyEl.setAttribute("command", command);
    keyEl.setAttribute(AUTO_KEY_ATTR, "true");
    const binding = bindingOf({ key, keycode, modifiers });
    if (binding) {
      const conflict = allowConflict ? null : this.findConflict(document, binding, id);
      if (conflict) {
        console.warn(`Whimsy: ${id} left unbound; ${conflict.id || "another key"} already uses that shortcut`);
      } else {
        keyEl.setAttribute("modifiers", binding.modifiers);
        keyEl.setAttribute(binding.keycode ? "keycode" : "key", binding.keycode ?? binding.key);
      }
    }
    let keyset = document.getElementById(KEYSET_ID);
    if (!keyset) {
      keyset = document.createXULElement("keyset");
      keyset.id = KEYSET_ID;
    }
    keyset.append(keyEl);
    // Inside batchKeys() the keyset is bound once, at the end.
    if (keyset.isConnected && batching.has(document)) {
      return keyEl;
    }
    // Gecko reads <key>s only when their keyset is (re)bound. CustomKeys
    // watches the body for keysets and applies saved customizations.
    keyset.remove();
    (document.getElementById("mainKeyset")?.parentElement ?? document.documentElement).append(keyset);
    return keyEl;
  },

  /**
   * wave10 (W10-12): runs fn(), registering many commands, with Whimsy's
   * keyset bound once at the end instead of once per <key>.
   */
  batchKeys(win, fn) {
    const { document } = win;
    if (batching.has(document)) {
      return fn();
    }
    batching.add(document);
    try {
      return fn();
    } finally {
      batching.delete(document);
      const keyset = document.getElementById(KEYSET_ID);
      if (keyset) {
        const parent = keyset.parentNode;
        keyset.remove();
        parent.append(keyset);
      }
    }
  },

  /**
   * The enabled <key> in this document already bound to `binding`, other
   * than `exceptId`, or null. Same test about:keyboard applies before it
   * assigns a shortcut.
   */
  findConflict(document, binding, exceptId = null) {
    const wanted = signature(binding);
    if (!wanted) {
      return null;
    }
    for (const keyEl of document.querySelectorAll("key")) {
      if (keyEl.id && keyEl.id == exceptId) {
        continue;
      }
      if (keyEl.getAttribute("disabled") == "true") {
        continue;
      }
      if (signature(keyEl) == wanted) {
        return keyEl;
      }
    }
    return null;
  },

  /**
   * Change a command's shortcut from code (what about:keyboard does when
   * the person types one). Refuses a shortcut another key uses, in any
   * open browser window. Saved by CustomKeys, so it lasts across restarts
   * and applies to every window. `binding` null clears it.
   *
   * @returns {{ ok: boolean, conflict: Element|null }}
   */
  rebind(id, binding) {
    const entry = entries.get(id) ?? this.forKey(id);
    const keyId = entry?.keyId ?? id;
    if (binding) {
      for (const win of Services.wm.getEnumerator("navigator:browser")) {
        const conflict = this.findConflict(win.document, binding, keyId);
        if (conflict) {
          return { ok: false, conflict };
        }
      }
      lazy.CustomKeys.changeKey(keyId, {
        modifiers: normalizeModifiers(binding.modifiers),
        key: binding.key?.toUpperCase(),
        keycode: binding.keycode,
      });
    } else {
      lazy.CustomKeys.clearKey(keyId);
    }
    return { ok: true, conflict: null };
  },

  reset(id) {
    const entry = entries.get(id) ?? this.forKey(id);
    lazy.CustomKeys.resetKey(entry?.keyId ?? id);
  },

  // Command-bar actions are session-wide (Zen keeps one list).
  addToCommandBar(entry, spec) {
    const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
    const actions = spec.variants?.length ? spec.variants : [{ l10nId: spec.l10nId, isAvailable: spec.isAvailable }];
    for (const variant of actions) {
      // A message shared by several commands (one with arguments) is told
      // apart by its command.
      const args = variant.l10nArgs ?? spec.l10nArgs ?? null;
      const argsKey = args ? entry.id : null;
      if (globalActions.some(a => a.l10nId == variant.l10nId && (a.whimsyArgsKey ?? null) == argsKey)) {
        continue;
      }
      let label = null;
      let keywords = null;
      const keywordSource = spec.whimsyKeywords ?? variant.whimsyKeywords;
      const isAvailable = variant.isAvailable ?? spec.isAvailable ?? (() => true);
      // A variant with its own run ("Turn Liquid Glass On") runs it; any
      // other row runs the registered <command>, so its shortcut shows.
      const run = variant.run;
      globalActions.push({
        l10nId: variant.l10nId,
        command: typeof run == "function" ? run : entry.id,
        commandId: entry.id,
        icon: spec.icon,
        extraPayload: {},
        whimsyCommand: entry.id,
        // An array, or a function giving one the first time it's needed.
        get whimsyKeywords() {
          keywords ??= typeof keywordSource == "function" ? keywordSource() : keywordSource;
          return keywords;
        },
        whimsyArgsKey: argsKey,
        isAvailable: win => {
          try {
            return !!isAvailable(win);
          } catch (e) {
            return false;
          }
        },
        get label() {
          label ??= formatSync(variant.l10nId, args);
          return label;
        },
      });
    }
  },

  /**
   * about:keyboard: adds the "Whimsy" group, first (so it opens expanded),
   * with every listed command, bound or not. Called from Zen's addKeys.
   */
  async addKeys(actor, keys) {
    const grouped = await this.groupKeys(actor, keys);
    // Only for the page itself; the shortcut cheat sheet reads these groups
    // too (with a stand-in actor) and builds its own list.
    if (typeof JSWindowActorParent == "undefined" || !(actor instanceof JSWindowActorParent)) {
      return grouped;
    }
    try {
      return await this.addUnlistedKeys(actor, grouped);
    } catch (e) {
      console.error("Whimsy: about:keyboard unlisted keys", e);
      return grouped;
    }
  },

  async groupKeys(actor, keys) {
    try {
      if (!this.listed) {
        return keys;
      }
      const win = actor.browsingContext.topChromeWindow;
      const { document } = win;
      // A command registered only through the old WhimsyShortcuts calls
      // has no recorded key id; its key (if any) is in Whimsy's keyset.
      const keyIdOf = entry =>
        entry.keyId ??
        document.querySelector(`#${KEYSET_ID} > key[command="${win.CSS.escape(entry.id)}"]`)?.id;
      const listed = this.entries
        .filter(entry => entry.l10nId && keyIdOf(entry))
        .map(entry => ({ ...entry, keyId: keyIdOf(entry) }));
      const scopes = Object.keys(SCOPE_GROUPS);
      const values = await lazy.l10n.formatValues([
        { id: GROUP_L10N_ID },
        ...scopes.map(scope => ({ id: SCOPE_GROUPS[scope] })),
        ...listed.map(entry => ({ id: entry.l10nId, args: resolveArgs(entry.l10nArgs) })),
      ]);
      const [heading, ...rest] = values;
      const scopeHeadings = rest.splice(0, scopes.length);
      const titles = rest;
      const group = {};
      const scoped = Object.fromEntries(scopes.map(scope => [scope, {}]));
      listed.forEach((entry, i) => {
        const data = actor.getKeyData(entry.keyId);
        if (data && titles[i]) {
          data.title = titles[i];
          if (entry.scope && scoped[entry.scope]) {
            // about:keyboard reads this to keep its conflicts in scope.
            data.scope = entry.scope;
            scoped[entry.scope][entry.keyId] = data;
          } else {
            group[entry.keyId] = data;
          }
        }
      });
      if (!heading || !Object.keys(group).length) {
        return keys;
      }
      // Whimsy's own keys belong here only, not also under "Other". The
      // scoped groups (Mini Whimsy) follow Whimsy's.
      const result = { [heading]: group };
      scopes.forEach((scope, i) => {
        if (scopeHeadings[i] && Object.keys(scoped[scope]).length) {
          result[scopeHeadings[i]] = scoped[scope];
        }
      });
      for (const [category, items] of Object.entries(keys)) {
        if (category == heading) {
          Object.assign(group, items);
          continue;
        }
        if (scopeHeadings.includes(category)) {
          continue;
        }
        // A scoped key never shows in another group as well.
        for (const id of Object.keys(items)) {
          if (scopes.some(scope => scoped[scope][id])) {
            delete items[id];
          }
        }
        result[category] = items;
      }
      return result;
    } catch (e) {
      console.error("Whimsy: about:keyboard commands", e);
      return keys;
    }
  },

  /**
   * W10-39: about:keyboard only looked for conflicts among the rows it
   * lists, so a shortcut held by any other key (a Zen or Firefox key it
   * doesn't list, DevTools', or one that exists only in Mini Whimsy
   * windows) was taken without a word, and the new shortcut silently lost
   * to the older key. Every bound <key> in every browser window that isn't
   * listed yet is added: the page's own conflict check then finds it, asks,
   * and can clear it, and the key can be reassigned like any other. Keys
   * of the window the page belongs to go under "Other Shortcuts"; keys
   * only Mini windows have go under Mini Whimsy's group, scoped to Mini.
   */
  async addUnlistedKeys(actor, keys) {
    const topWin = actor.browsingContext.topChromeWindow;
    const listed = new Set(Object.values(keys).flatMap(items => Object.keys(items)));
    const other = {};
    const mini = {};
    const windows = [topWin, ...Services.wm.getEnumerator("navigator:browser")].filter(
      (w, i, all) => w && !w.closed && all.indexOf(w) == i
    );
    for (const win of windows) {
      const inTop = win == topWin;
      for (const keyEl of win.document.querySelectorAll("key[id]")) {
        const id = keyEl.id;
        if (listed.has(id) || (!keyEl.hasAttribute("key") && !keyEl.hasAttribute("keycode"))) {
          continue;
        }
        if (keyEl.parentElement?.id == MINI_STANDIN_KEYSET_ID) {
          continue;
        }
        // A key every main window has is listed from the page's own window.
        if (!inTop && topWin.document.getElementById(id)) {
          continue;
        }
        const data = this.keyDataOf(keyEl);
        if (!data.shortcut) {
          continue;
        }
        data.title = this.keyTitle(win, keyEl);
        if (inTop) {
          other[id] = data;
        } else {
          data.scope = "mini";
          mini[id] = data;
        }
        listed.add(id);
      }
    }
    if (Object.keys(mini).length) {
      const heading = await lazy.l10n.formatValue(SCOPE_GROUPS.mini);
      Object.assign((keys[heading] ??= {}), mini);
    }
    if (Object.keys(other).length) {
      const heading = await lazy.l10n.formatValue(OTHER_GROUP_L10N_ID);
      const sorted = Object.entries(other).sort(([, a], [, b]) => a.title.localeCompare(b.title));
      keys[heading] = Object.assign(keys[heading] ?? {}, Object.fromEntries(sorted));
    }
    // A key that lives only in another window (Mini's) isn't in the page's
    // own window, where the actor looks it up after a change.
    this.wrapKeyData(actor);
    return keys;
  },

  // about:keyboard's row data for a <key> element, in any window.
  keyDataOf(keyEl) {
    return {
      shortcut:
        keyEl.hasAttribute("key") || keyEl.hasAttribute("keycode")
          ? lazy.ShortcutUtils.prettifyShortcut(keyEl)
          : "",
      isCustomized: !!lazy.CustomKeys.getDefaultKey(keyEl.id),
      internal: keyEl.getAttribute("internal") == "true",
    };
  },

  // The name a person knows a key by: a menu item that shows it, else its
  // command's label or its Whimsy command name, else words from its id.
  keyTitle(win, keyEl) {
    const { document } = win;
    const escaped = win.CSS.escape(keyEl.id);
    const item = [...document.querySelectorAll(`menuitem[key="${escaped}"], toolbarbutton[key="${escaped}"]`)].find(
      el => el.label || el.getAttribute("label")
    );
    const command = keyEl.getAttribute("command");
    const commandEl = command ? document.getElementById(command) : null;
    const name =
      item?.label ||
      item?.getAttribute("label") ||
      commandEl?.getAttribute("label") ||
      keyEl.getAttribute("label") ||
      (command && this.title(entries.get(command))) ||
      this.title(this.forKey(keyEl.id));
    if (name) {
      return name;
    }
    const words = keyEl.id
      .replace(/^(key_|key-|zen-|whimsy-|cmd_)/i, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .trim()
      .toLowerCase();
    return words ? words[0].toUpperCase() + words.slice(1) : keyEl.id;
  },

  // CustomKeysParent looks a key up in the page's own window after a
  // change; keys that only Mini windows have are found in those.
  wrapKeyData(actor) {
    if (actor._whimsyKeyData) {
      return;
    }
    actor._whimsyKeyData = true;
    const own = actor.getKeyData.bind(actor);
    actor.getKeyData = id => {
      const data = own(id);
      if (data) {
        return data;
      }
      for (const win of Services.wm.getEnumerator("navigator:browser")) {
        const keyEl = win.document.getElementById(id);
        if (keyEl?.localName == "key") {
          return this.keyDataOf(keyEl);
        }
      }
      return null;
    };
  },
};
