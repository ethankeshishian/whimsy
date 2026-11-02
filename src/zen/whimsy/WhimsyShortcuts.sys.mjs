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

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  CustomKeys: "moz-src:///browser/components/customkeys/CustomKeys.sys.mjs",
  ShortcutUtils: "resource://gre/modules/ShortcutUtils.sys.mjs",
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
  // DevTools' extra macOS Inspector key is Cmd+Shift+L in this Firefox, the
  // Library's (Arc) key above; the Inspector keeps Cmd+Opt+I and Cmd+Opt+C.
  key_inspectorMac: {},
  key_newNavigator: { modifiers: "accel,alt,shift", key: "N" },
};

// wave10 (W10-61): Arc's browser keys, "press again" model. These are
// Arc's browser-level menu keys (tabs, spaces, windows, the Library, the
// sidebar, Little Arc, copy URL), as Whimsy binds them. A page that doesn't
// use one never sees a difference: the browser acts on the first press. A
// page that does use it (its keydown handler cancels the key, e.g. ⌘S in
// Google Docs, ⇧⌘C in a code editor) gets the first press, a toast says
// "Press ⌘S again for Hide Sidebar", and a second press in a row runs the
// browser's command without reaching the page.
//
// W10-47 had reserved these keys (the page never saw them); the user chose
// Arc's model instead (TICKETS W10-61), so nothing here is reserved any
// more. Firefox's own reserved keys (New Tab, Close Tab/Window, Quit, New
// Window) stay Firefox's. Ids that don't exist (a feature switched off)
// are skipped, and the model follows each key whatever the person rebinds
// it to. The name RESERVED_KEYS is kept for the tests and tickets that
// cite it.
export const RESERVED_KEYS = [
  // Window: Open Library…, View Downloads…
  "zen-library-toggle",
  "key_openDownloads",
  // File: New Window, Blank Window, New Incognito Window, New Little Arc
  // Window, Restore Last Closed Tab, Open Command Bar (⌘L), New Space (⌘N)
  "key_newNavigator",
  "zen-new-unsynced-window",
  "key_privatebrowsing",
  "key_whimsyQuickWindow",
  "key_undoCloseTab",
  "focusURLBar",
  "key_whimsyNewSpace",
  // Tabs: Pin, Duplicate, Next/Previous Tab, Clear Today
  "zen-toggle-pin-tab",
  "zen-duplicate-tab",
  "key_whimsyTabNext",
  "key_whimsyTabPrev",
  "zen-close-all-unpinned-tabs",
  // Edit: Copy URL, as Markdown, as Quote (W10-41: copy-protected pages
  // cancel every Cmd key, so these take the second press there).
  "zen-copy-url",
  "zen-copy-url-markdown",
  "key_whimsyCopyURLQuote",
  // View: Hide Sidebar (⌘S, the Save key in every editor: those pages keep
  // the first press), Show Toolbar, Add Split View, Close this Split Pane
  "zen-compact-mode-toggle",
  "key_cmd_whimsyToggleToolbar",
  "key_whimsyAddSplitView",
  "key_whimsyCloseSplitPane",
  // Spaces: Next/Previous Space and the numbered spaces
  "zen-workspace-forward",
  "zen-workspace-backward",
  ...Array.from({ length: 10 }, (_, i) => `zen-workspace-switch-${i + 1}`),
];

const IS_MAC = AppConstants.platform == "macosx";
const PRESS_AGAIN_PREF = "whimsy.feature.press-again";
// How long the second press may come after the first (the hint's life).
export const PRESS_AGAIN_MS = 3000;
// The bindings the content side reports, shared with every process.
export const PRESS_AGAIN_SHARED_KEY = "Whimsy:PressAgainKeys";
// <key keycode="..."> names for the keys browser shortcuts use.
const VK_NAMES = {
  8: "VK_BACK", 9: "VK_TAB", 13: "VK_RETURN", 27: "VK_ESCAPE", 32: "VK_SPACE",
  33: "VK_PAGE_UP", 34: "VK_PAGE_DOWN", 35: "VK_END", 36: "VK_HOME",
  37: "VK_LEFT", 38: "VK_UP", 39: "VK_RIGHT", 40: "VK_DOWN", 46: "VK_DELETE",
};
for (let i = 1; i <= 24; i++) {
  VK_NAMES[111 + i] = `VK_F${i}`;
}
const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift", "CapsLock", "Fn", "OS", "AltGraph"]);

function normalizeModifiers(list) {
  const out = list.map(m => {
    m = m.trim().toLowerCase();
    if (m == "meta") {
      return IS_MAC ? "accel" : "meta";
    }
    if (m == "ctrl" || m == "control") {
      return IS_MAC ? "control" : "accel";
    }
    return m;
  });
  return [...new Set(out.filter(Boolean))].sort().join(",");
}

// "modifiers|KEY" for a <key>, with the modifiers sorted and Cmd as accel
// (Ctrl too, outside macOS); "modifiers|VK_..." for a keycode.
export function bindingOf(keyEl) {
  const key = (keyEl.getAttribute("key") || keyEl.getAttribute("keycode") || "").toUpperCase();
  return `${normalizeModifiers((keyEl.getAttribute("modifiers") || "").split(/[,\s]+/))}|${key}`;
}

// The bindings a keydown could be, in bindingOf()'s form: by the character
// it types, by the key it is (⌥ changes the character on a Mac), and by its
// keycode. Works in any process (the content side uses it too).
export function eventSignatures(event) {
  const mods = [];
  if (event.metaKey) {
    mods.push("meta");
  }
  if (event.ctrlKey) {
    mods.push("control");
  }
  if (event.altKey) {
    mods.push("alt");
  }
  if (event.shiftKey) {
    mods.push("shift");
  }
  const prefix = `${normalizeModifiers(mods)}|`;
  const out = new Set();
  if (typeof event.key == "string" && event.key.length == 1) {
    out.add(prefix + event.key.toUpperCase());
  }
  const code = /^(?:Key|Digit)([A-Z0-9])$/.exec(event.code || "");
  if (code) {
    out.add(prefix + code[1]);
  }
  if (VK_NAMES[event.keyCode]) {
    out.add(prefix + VK_NAMES[event.keyCode]);
  }
  return [...out];
}

// Only the press-again watcher's own per-key observers.
const watched = new WeakSet();
// window -> { keyId, signature, browser, until, toast }
const pendingPress = new WeakMap();

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
    this.initPressAgain(win);
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
    const inspectorMac = document.getElementById("key_inspectorMac");
    if (inspectorMac && !this.isCustomized("key_inspectorMac")) {
      this.setBinding(inspectorMac, {});
      keysets.add(inspectorMac.parentElement);
    }
    const libraryKey = document.getElementById("zen-library-toggle");
    if (libraryKey && !this.isCustomized("zen-library-toggle")) {
      this.setBinding(libraryKey, SHORTCUTS["zen-library-toggle"]);
      keysets.add(libraryKey.parentElement);
    }
    this.rebindKeysets(keysets);
    this.publishPressAgainKeys(document);
    return result;
  },

  // --- W10-61: press again (Arc) ---
  //
  // Gecko sends a key that isn't reserved to the page first; when the page
  // cancels its keydown, the browser's <key> never runs. The page's side
  // (WhimsyPageChild, a system-group keydown listener that runs after every
  // page listener) tells us when that happened to one of these keys; we
  // remember it and show the hint. The next press of the same key, in the
  // same tab, within PRESS_AGAIN_MS and with no other key between, is taken
  // here in the window's capture phase, before the page sees it: its
  // preventDefault() also keeps it from being sent to the page's process.

  get pressAgainEnabled() {
    return Services.prefs.getBoolPref(PRESS_AGAIN_PREF, true);
  },

  initPressAgain(win) {
    const { document } = win;
    this.publishPressAgainKeys(document);
    win.addEventListener("keydown", event => this.onChromeKeyDown(win, event), true);
    // Another tab in between starts over, even when the same tab comes back
    // before the next press (Arc).
    win.addEventListener("TabSelect", () => this.cancelPressAgain(win), true);
    // A rebinding in about:keyboard (CustomKeys) changes a key in place.
    for (const id of RESERVED_KEYS) {
      const keyEl = document.getElementById(id);
      if (keyEl?.localName != "key" || watched.has(keyEl)) {
        continue;
      }
      watched.add(keyEl);
      new win.MutationObserver(() => this.publishPressAgainKeys(document)).observe(keyEl, {
        attributes: true,
        attributeFilter: ["key", "keycode", "modifiers"],
      });
    }
  },

  // The bindings the page's side should report, for every process. Keys
  // that other modules add later are picked up at delayed startup
  // (moveConsoleAndDownloads) and on every rebinding.
  publishPressAgainKeys(document) {
    const bindings = new Set();
    for (const id of RESERVED_KEYS) {
      const keyEl = document.getElementById(id);
      if (keyEl?.localName == "key") {
        const binding = bindingOf(keyEl);
        if (!binding.endsWith("|")) {
          bindings.add(binding);
        }
      }
    }
    try {
      const old = Services.ppmm.sharedData.get(PRESS_AGAIN_SHARED_KEY) ?? [];
      const all = [...new Set([...old, ...bindings])].sort();
      if (all.join("\n") != old.join("\n")) {
        Services.ppmm.sharedData.set(PRESS_AGAIN_SHARED_KEY, all);
        Services.ppmm.sharedData.flush();
      }
    } catch (e) {
      console.error("Whimsy: press again keys", e);
    }
  },

  // The browser key a binding belongs to in this window, if it can run.
  pressAgainKeyFor(document, signatures) {
    for (const id of RESERVED_KEYS) {
      const keyEl = document.getElementById(id);
      if (keyEl?.localName != "key" || keyEl.getAttribute("disabled") == "true") {
        continue;
      }
      const binding = bindingOf(keyEl);
      if (binding.endsWith("|") || !signatures.includes(binding)) {
        continue;
      }
      const commandId = keyEl.getAttribute("command");
      const command = commandId ? document.getElementById(commandId) : null;
      if (command?.getAttribute("disabled") == "true") {
        continue;
      }
      return keyEl;
    }
    return null;
  },

  // From WhimsyPageParent: the page in `browser` cancelled a keydown that
  // could be one of these keys (`signatures`, from eventSignatures()).
  // Returns the key it was, or null.
  onPageTookKey(browser, signatures) {
    const win = browser?.ownerDocument?.defaultView;
    if (!this.pressAgainEnabled || !win?.gBrowser || win.closed || !Array.isArray(signatures)) {
      return null;
    }
    signatures = signatures.filter(s => typeof s == "string" && s.length < 64).slice(0, 8);
    const keyEl = this.pressAgainKeyFor(win.document, signatures);
    if (!keyEl || win.gBrowser.selectedBrowser != browser) {
      return null;
    }
    const pending = {
      keyId: keyEl.id,
      signature: bindingOf(keyEl),
      browser,
      until: Date.now() + PRESS_AGAIN_MS,
      toast: null,
    };
    pendingPress.set(win, pending);
    pending.toast = this.showPressAgainHint(win, keyEl, browser);
    return keyEl;
  },

  // "Press ⌘S again for Hide Sidebar". Arc's own hint text can't be read
  // from Arc (it's in the binary), so this is Whimsy's wording.
  showPressAgainHint(win, keyEl, browser) {
    let shortcut = "";
    try {
      shortcut = lazy.ShortcutUtils.prettifyShortcut(keyEl);
    } catch (e) {}
    const action = lazy.WhimsyCommands.keyTitle(win, keyEl).replace(/\s*(…|\.\.\.)$/, "");
    // A newer hint replaces the one showing, in place.
    return (
      win.gZenUIManager?.toasts?.open("whimsy-press-again-toast", {
        key: "whimsy-press-again",
        l10nArgs: { shortcut, action },
        browser,
        timeout: PRESS_AGAIN_MS,
      }) ?? null
    );
  },

  // Whether a press-again is waiting in this window (tests).
  pendingPressAgain(win) {
    const pending = pendingPress.get(win);
    return pending && Date.now() <= pending.until ? { keyId: pending.keyId, signature: pending.signature } : null;
  },

  cancelPressAgain(win) {
    const pending = pendingPress.get(win);
    pendingPress.delete(win);
    pending?.toast?.close();
  },

  // Every keydown in the window, before the page gets it.
  onChromeKeyDown(win, event) {
    const pending = pendingPress.get(win);
    if (!pending || !event.isTrusted || event.repeat || MODIFIER_KEYS.has(event.key)) {
      return;
    }
    pendingPress.delete(win);
    const dismiss = () => pending.toast?.close();
    if (
      !this.pressAgainEnabled ||
      Date.now() > pending.until ||
      win.gBrowser?.selectedBrowser != pending.browser ||
      !eventSignatures(event).includes(pending.signature)
    ) {
      // Another key in between, another tab, or too late: start over.
      dismiss();
      return;
    }
    const keyEl = win.document.getElementById(pending.keyId);
    if (!keyEl || this.pressAgainKeyFor(win.document, [pending.signature]) != keyEl) {
      dismiss();
      return;
    }
    // The browser's turn. preventDefault() from chrome also stops the key
    // from being sent to the page's process, and a cancelled keydown has no
    // keypress, so the <key> doesn't run a second time.
    event.preventDefault();
    event.stopPropagation();
    dismiss();
    this.runKey(win, keyEl);
  },

  // Runs a <key> as pressing it does: its <command>, else its oncommand.
  runKey(win, keyEl) {
    try {
      const commandId = keyEl.getAttribute("command");
      const command = commandId ? win.document.getElementById(commandId) : null;
      if (command) {
        command.doCommand();
      } else {
        keyEl.doCommand();
      }
    } catch (e) {
      console.error(`Whimsy: press again ${keyEl.id}`, e);
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
