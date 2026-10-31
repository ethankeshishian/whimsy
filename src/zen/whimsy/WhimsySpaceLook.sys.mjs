/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave5/look: a look per space (whimsy.feature.space-look).
//
// Arc and Zen give each space its own colours; Whimsy lets a space also
// keep its own interface font, density (compact, normal, roomy), tab title
// lines and, optionally, one Zen Mod: a dense monospace "Work" space next
// to a roomy serif "Reading" one. A space only stores what it changes
// (workspace.whimsyLook = { font, density, lines, mod }); everything else
// follows Settings → Look and Feel, so changing a global setting still
// changes every space that never overrode it.
//
// Where it applies:
// - Each space's tab list (its <zen-workspace>) carries that space's
//   font, density and title lines as attributes (whimsy-browser.css). The
//   lists slide past each other when you switch, or follow your fingers
//   when you swipe, so each one arrives already in its own look: the slide
//   is the morph, nothing pops at the end.
// - The rest of the window (address bar, Essentials, toolbars, menus,
//   panels) follows the active space. Zen marks the incoming space active
//   as the switch starts; the chrome dips and rises with the space's
//   gradient while the font, Firefox's own density (gUIDensity, made to
//   prefer the space's) and the mod change at the bottom of the dip.
//   Reduced motion: it just changes.
// - A Zen Mod is a stylesheet Zen merges for every window. A space mod is
//   one you've turned off in Zen Mods (on everywhere already means nothing
//   to add); Whimsy loads its chrome.css into this window only as a user
//   sheet, the same level Zen uses, and removes it when you leave the
//   space. No reload. Its settings apply as Zen writes them.
// - Mini Whimsy takes the look of the space "Open in" points at, and
//   Glance and split views live inside the window, so they wear the active
//   space's look. Zen never puts tabs of two spaces in one split.
// - New windows open on a space and take its look as they start; private
//   windows have no spaces and keep Settings' look.
// - The look is stored with the space, so it lands in Zen's session file
//   and reaches every window through Zen's window sync (and Zen's space
//   sync, whatever carries the space carries its look).
//
// Editing (W8-36): "Edit Look…" in the space's menu, the creation form and
// the command bar open an overlay built like Zen's theme picker: the same
// 380px arrowless panel beside the sidebar, the same dotted pad (here a
// type specimen), then font, density, tab title lines and Zen Mod. Every
// change previews live on the real sidebar and window without saving
// (state.preview); Done (or a click outside, as in Zen's picker) keeps it,
// Cancel or Esc puts back what the space had. Each control has "Use
// browser default"; Reset sets all four back.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyLook: "resource:///modules/whimsy/WhimsyLook.sys.mjs",
  WhimsyPanels: "resource:///modules/whimsy/WhimsyPanels.sys.mjs",
  WhimsyQuickWindow: "resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.space-look";
const DENSITY_PREF = "browser.uidensity";
const LINES_PREF = "whimsy.tabs.title-lines";
const LINES_FEATURE_PREF = "whimsy.feature.title-lines";
const FONT_PREF = "whimsy.look.ui-font";
const FONT_FEATURE_PREF = "whimsy.feature.ui-font";
const MODS_UPDATED_PREF = "zen.mods.updated-value-observer";
const MODS_OFF_PREF = "zen.themes.disable-all";
const SWITCH_DURATION_PREF = "zen.workspaces.switch-animation-duration";
const CHANGED_TOPIC = "whimsy-space-look-changed";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const MENU_ID = "whimsy-space-look-menuitem";
const PANEL_ID = "whimsy-space-look-panel";
const FORM_BUTTON_CLASS = "whimsy-space-look-button";
const COMMAND_ID = "cmd_whimsyEditSpaceLook";

// Firefox's density modes (gUIDensity.MODE_*): roomy is its "touch".
export const DENSITIES = { compact: 1, normal: 0, roomy: 2 };
export const LINES = [1, 2, 3];
// Shown first in the font menu, when installed.
const SUGGESTED_FONTS = ["Avenir Next", "Charter", "Georgia", "Menlo", "SF Mono"];

const states = new WeakMap();

function featureOn() {
  return Services.prefs.getBoolPref(FEATURE_PREF, true);
}

function cleanFont(font) {
  // A family name only: no quotes, semicolons or braces reach the CSS.
  return String(font ?? "").replace(/["\\;{}<>]/g, "").trim();
}

function reduceMotion(win) {
  try {
    return !!win.gReduceMotion || win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) {
    return true;
  }
}

/**
 * A stored look with only known keys and valid values. A key that isn't
 * there follows Settings; font "" is the system font, a real choice.
 */
export function normalizeLook(raw) {
  const look = {};
  if (!raw || typeof raw != "object") {
    return look;
  }
  if (typeof raw.font == "string") {
    look.font = cleanFont(raw.font);
  }
  if (Object.hasOwn(DENSITIES, raw.density)) {
    look.density = raw.density;
  }
  const lines = Number(raw.lines);
  if (LINES.includes(lines)) {
    look.lines = lines;
  }
  if (typeof raw.mod == "string" && raw.mod) {
    look.mod = raw.mod;
  }
  return look;
}

export const WhimsySpaceLook = {
  CHANGED_TOPIC,

  get enabled() {
    return featureOn();
  },

  // -- values ----------------------------------------------------------

  lookOf(workspace) {
    return featureOn() ? normalizeLook(workspace?.whimsyLook) : {};
  },

  // What a space wears in this window: the editor's unsaved draft while
  // it's open on that space, else what's stored.
  shownLook(win, workspace) {
    const preview = this.state(win).preview;
    if (preview && workspace && preview.uuid == workspace.uuid && featureOn()) {
      return normalizeLook(preview.look);
    }
    return this.lookOf(workspace);
  },

  /** Shows `look` on a space in this window without saving it. */
  preview(win, uuid, look) {
    this.state(win).preview = { uuid, look: normalizeLook(look) };
    this.refresh(win);
  },

  endPreview(win) {
    const state = this.state(win);
    if (state.preview) {
      state.preview = null;
      this.refresh(win);
    }
  },

  globalFont() {
    return lazy.WhimsyLook.uiFont();
  },

  globalDensity() {
    const mode = Services.prefs.getIntPref(DENSITY_PREF, 0);
    return Object.keys(DENSITIES).find(name => DENSITIES[name] == mode) ?? "normal";
  },

  globalLines() {
    if (!Services.prefs.getBoolPref(LINES_FEATURE_PREF, true)) {
      return 1;
    }
    const lines = Services.prefs.getIntPref(LINES_PREF, 1);
    return LINES.includes(lines) ? lines : 1;
  },

  space(win, uuid) {
    return win.gZenWorkspaces?.getWorkspaces?.().find(w => w.uuid == uuid) ?? null;
  },

  /**
   * Changes a space's look. `changes` keys set to undefined go back to
   * following Settings. Returns the stored look.
   */
  setLook(win, uuid, changes) {
    const workspace = this.space(win, uuid);
    if (!workspace) {
      return null;
    }
    const look = normalizeLook({ ...normalizeLook(workspace.whimsyLook), ...changes });
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) {
        delete look[key];
      }
    }
    if (Object.keys(look).length) {
      workspace.whimsyLook = look;
    } else {
      delete workspace.whimsyLook;
    }
    this.save(win, workspace);
    return look;
  },

  /** Stores `look` as the space's whole look (the editor's Done). */
  replaceLook(win, uuid, look, { morph = true } = {}) {
    const workspace = this.space(win, uuid);
    if (!workspace) {
      return null;
    }
    const clean = normalizeLook(look);
    if (Object.keys(clean).length) {
      workspace.whimsyLook = clean;
    } else {
      delete workspace.whimsyLook;
    }
    this.save(win, workspace, { morph });
    return clean;
  },

  // Everything back to Settings.
  reset(win, uuid) {
    const workspace = this.space(win, uuid);
    if (!workspace || !workspace.whimsyLook) {
      return;
    }
    delete workspace.whimsyLook;
    this.save(win, workspace);
  },

  // `morph` dips the window while it changes; the editor saves what it
  // already shows, so it saves without one.
  save(win, workspace, { morph = true } = {}) {
    const state = this.state(win);
    // Zen announces the save (ZenWorkspaceDataChanged); this window
    // applies it below, with its tab list in the dip too.
    state.saving = true;
    try {
      win.gZenWorkspaces.saveWorkspace(workspace);
    } finally {
      state.saving = false;
    }
    this.refresh(win, { morph, includeTabs: morph });
    // Other windows (Zen's sync already gave them the data) and Mini.
    Services.obs.notifyObservers(win, CHANGED_TOPIC, workspace.uuid);
  },

  // -- windows ---------------------------------------------------------

  state(win) {
    let state = states.get(win);
    if (!state) {
      state = { rootKey: null, density: null, mod: null, modGen: 0, morphGen: 0, preview: null };
      states.set(win, state);
    }
    return state;
  },

  // Firefox re-reads the density on every resize; have it ask the space.
  wrapDensity(win) {
    const ui = win.gUIDensity;
    if (!ui || ui._whimsySpaceLook || typeof ui.getCurrentDensity != "function") {
      return;
    }
    const original = ui.getCurrentDensity;
    const state = this.state(win);
    ui.getCurrentDensity = function (...args) {
      if (state.density != null && featureOn()) {
        return { mode: state.density, overridden: true };
      }
      return original.apply(this, args);
    };
    ui._whimsySpaceLook = true;
  },

  initWindow(win) {
    if (win._whimsyQuickWindow) {
      this.initQuickWindow(win);
      return;
    }
    const { document, gZenWorkspaces } = win;
    if (!gZenWorkspaces) {
      return;
    }
    this.wrapDensity(win);
    const refresh = (opts = {}) => {
      try {
        this.refresh(win, opts);
      } catch (e) {
        console.error("Whimsy: space look", e);
      }
    };

    const cleanups = [];
    const strip = document.getElementById("tabbrowser-arrowscrollbox");
    if (strip) {
      // Zen marks the incoming space active right as a switch starts.
      const switching = new win.MutationObserver(records => {
        if (records.some(r => r.target.localName == "zen-workspace" && r.target.hasAttribute("active"))) {
          refresh({ morph: true });
        }
      });
      switching.observe(strip, { attributes: true, attributeFilter: ["active"], subtree: true });
      // A new space's list.
      const added = new win.MutationObserver(() => refresh());
      added.observe(strip, { childList: true });
      cleanups.push(() => switching.disconnect(), () => added.disconnect());
    }

    // The creation form: a "Look and Feel" button under Zen's "Theme".
    const creating = new win.MutationObserver(() => this.watchCreation(win));
    creating.observe(document.documentElement, { attributes: true, attributeFilter: ["zen-creating-workspace"] });
    cleanups.push(() => creating.disconnect());

    const onData = () => {
      if (!this.state(win).saving) {
        refresh({ morph: true });
      }
    };
    const onUI = () => refresh();
    win.addEventListener("ZenWorkspaceDataChanged", onData);
    win.addEventListener("ZenWorkspacesUIUpdate", onUI);
    cleanups.push(() => {
      win.removeEventListener("ZenWorkspaceDataChanged", onData);
      win.removeEventListener("ZenWorkspacesUIUpdate", onUI);
    });

    const onPref = () => refresh();
    const onMods = () => {
      this.state(win).rootKey = null;
      refresh();
    };
    const prefs = [FEATURE_PREF, DENSITY_PREF, LINES_PREF, LINES_FEATURE_PREF, FONT_PREF, FONT_FEATURE_PREF];
    for (const pref of prefs) {
      Services.prefs.addObserver(pref, onPref);
    }
    Services.prefs.addObserver(MODS_UPDATED_PREF, onMods);
    Services.prefs.addObserver(MODS_OFF_PREF, onMods);
    cleanups.push(() => {
      for (const pref of prefs) {
        Services.prefs.removeObserver(pref, onPref);
      }
      Services.prefs.removeObserver(MODS_UPDATED_PREF, onMods);
      Services.prefs.removeObserver(MODS_OFF_PREF, onMods);
    });

    // Another window changed a look (this one applies its own).
    const observer = {
      observe: subject => {
        if (subject != win) {
          refresh();
        }
      },
      QueryInterface: ChromeUtils.generateQI(["nsIObserver", "nsISupportsWeakReference"]),
    };
    Services.obs.addObserver(observer, CHANGED_TOPIC);
    cleanups.push(() => Services.obs.removeObserver(observer, CHANGED_TOPIC));

    this.initContextMenu(win);
    // The command bar (and a shortcut, if the person gives it one).
    lazy.WhimsyCommands.register(win, {
      id: COMMAND_ID,
      l10nId: "whimsy-action-space-look",
      run: w => this.openEditor(w, w.gZenWorkspaces?.activeWorkspace),
      icon: "chrome://browser/skin/zen-icons/sliders.svg",
      isAvailable: w => featureOn() && !w.gZenWorkspaces?.privateWindowOrDisabled,
    });
    win.addEventListener(
      "unload",
      () => {
        for (const cleanup of cleanups) {
          cleanup();
        }
      },
      { once: true }
    );
    refresh();
    this.watchCreation(win);
  },

  /**
   * Applies every space's look to its tab list and the active space's look
   * to the window. `morph` dips the chrome while it changes; on an edit
   * (`includeTabs`) the active tab list dips and changes with it. On a
   * switch the lists change at once: the incoming one has to arrive in its
   * own look.
   */
  refresh(win, { morph = false, includeTabs = false } = {}) {
    const { gZenWorkspaces } = win;
    if (!gZenWorkspaces) {
      return;
    }
    const on = featureOn() && gZenWorkspaces.workspaceEnabled && !gZenWorkspaces.privateWindowOrDisabled;
    const spaces = on ? gZenWorkspaces.getWorkspaces() : [];
    const looks = new Map(spaces.map(space => [space.uuid, this.shownLook(win, space)]));
    const active = looks.get(gZenWorkspaces.activeWorkspace) ?? {};
    if (morph && includeTabs && this.state(win).rootKey !== null && !reduceMotion(win)) {
      this.morph(
        win,
        () => {
          this.applyLists(win, looks);
          this.applyWindow(win, active);
        },
        true
      );
      return;
    }
    this.applyLists(win, looks);
    this.applyWindow(win, active, { morph });
  },

  applyLists(win, looks) {
    const all = [...looks.values()];
    const anyFont = all.some(look => "font" in look);
    const anyLines = all.some(look => "lines" in look);
    const anyDensity = all.some(look => "density" in look);
    const font = anyFont ? this.globalFont() : "";
    const lines = anyLines ? this.globalLines() : 1;
    const density = anyDensity ? this.globalDensity() : "normal";
    for (const element of win.document.querySelectorAll("zen-workspace")) {
      const look = looks.get(element.id);
      // A space Whimsy doesn't know (or the switch is off): Zen's look.
      const family = look && anyFont ? (look.font ?? font) : null;
      if (family === null) {
        element.removeAttribute("whimsy-look-font");
        element.style.removeProperty("--whimsy-space-font");
      } else {
        element.setAttribute("whimsy-look-font", "");
        element.style.setProperty("--whimsy-space-font", family ? `"${family}"` : "system-ui");
      }
      if (look && anyLines) {
        const value = String(look.lines ?? lines);
        element.setAttribute("whimsy-look-lines", value);
        element.style.setProperty("--whimsy-title-lines", value);
      } else {
        element.removeAttribute("whimsy-look-lines");
        element.style.removeProperty("--whimsy-title-lines");
      }
      if (look && anyDensity) {
        element.setAttribute("whimsy-look-density", look.density ?? density);
      } else {
        element.removeAttribute("whimsy-look-density");
      }
    }
  },

  // The window-wide part: font, density and mod of `look`.
  applyWindow(win, look, { morph = false } = {}) {
    const state = this.state(win);
    const font = "font" in look ? look.font : undefined;
    const density = look.density ? DENSITIES[look.density] : null;
    const mod = look.mod ?? null;
    const key = JSON.stringify([font ?? null, font !== undefined, density, mod]);
    if (key == state.rootKey) {
      return false;
    }
    const first = state.rootKey === null;
    state.rootKey = key;
    const apply = () => {
      lazy.WhimsyLook.setSpaceFont(win, font);
      state.density = density;
      try {
        win.gUIDensity?.update();
      } catch (e) {
        console.error("Whimsy: space density", e);
      }
      this.applyMod(win, mod);
    };
    if (morph && !first && !reduceMotion(win)) {
      this.morph(win, apply, false);
    } else {
      state.morphGen++;
      apply();
    }
    if (!win._whimsyQuickWindow) {
      Services.obs.notifyObservers(win, CHANGED_TOPIC, "active");
    }
    return true;
  },

  // The chrome dips, changes at the bottom and rises again, alongside
  // Zen's slide and gradient crossfade.
  morph(win, apply, includeTabs) {
    const { document } = win;
    const state = this.state(win);
    const generation = ++state.morphGen;
    const candidates = [
      document.getElementById("zen-essentials"),
      win.gURLBar?.querySelector?.(".urlbar-input-container"),
      document.getElementById("zen-sidebar-top-buttons"),
      document.getElementById("zen-sidebar-foot-buttons"),
      document.getElementById("nav-bar"),
      document.getElementById("PersonalToolbar"),
      includeTabs ? win.gZenWorkspaces.activeWorkspaceElement : null,
    ].filter(el => el?.isConnected && el.checkVisibility?.());
    const targets = candidates.filter(el => !candidates.some(other => other != el && other.contains(el)));
    const duration = Math.min(360, Math.max(180, Services.prefs.getIntPref(SWITCH_DURATION_PREF, 300)));
    for (const el of targets) {
      el.animate([{ opacity: 1 }, { opacity: 0.2, offset: 0.45 }, { opacity: 1 }], {
        duration,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
      });
    }
    win.setTimeout(() => {
      if (generation == state.morphGen) {
        apply();
      }
    }, duration * 0.45);
  },

  // -- Zen Mods --------------------------------------------------------

  // Installed mods that are off in Zen Mods: the ones a space can add.
  async availableMods(win) {
    if (!win.gZenMods || Services.prefs.getBoolPref(MODS_OFF_PREF, false) || Services.appinfo.inSafeMode) {
      return [];
    }
    try {
      const mods = await win.gZenMods.getMods();
      return Object.values(mods)
        .filter(mod => mod?.id && mod.enabled === false)
        .map(mod => ({ id: mod.id, name: mod.name || mod.id }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      console.error("Whimsy: space look mods", e);
      return [];
    }
  },

  async installedModCount(win) {
    try {
      return Object.keys((await win.gZenMods?.getMods()) ?? {}).length;
    } catch (e) {
      return 0;
    }
  },

  async applyMod(win, modId) {
    const state = this.state(win);
    const generation = ++state.modGen;
    let next = null;
    const zenMods = win.gZenMods ?? this.mainWindow(win)?.gZenMods;
    if (modId && zenMods && !Services.prefs.getBoolPref(MODS_OFF_PREF, false) && !Services.appinfo.inSafeMode) {
      try {
        const mods = await zenMods.getMods();
        const mod = mods[modId];
        // On everywhere already: nothing to add.
        if (mod && mod.enabled === false) {
          const path = PathUtils.join(zenMods.getModFolder(modId), "chrome.css");
          if (await IOUtils.exists(path)) {
            next = {
              id: modId,
              uri: PathUtils.toFileURI(path),
              prefs: await zenMods.getModPreferences(mod),
              block: zenMods.sanitizeModName(mod.name || modId),
            };
          }
        }
      } catch (e) {
        console.error("Whimsy: space mod", e);
      }
    }
    if (generation != state.modGen || win.closed) {
      return;
    }
    this.removeMod(win);
    if (next) {
      this.addMod(win, next);
    }
  },

  addMod(win, mod) {
    const { document } = win;
    const utils = win.windowUtils;
    try {
      utils.loadSheetUsingURIString(mod.uri, utils.USER_SHEET);
    } catch (e) {
      console.error("Whimsy: space mod sheet", e);
      return;
    }
    // The mod's settings, as Zen writes them for a mod that's on.
    const root = document.documentElement;
    const vars = [];
    let block = null;
    for (const { property, type, defaultValue } of mod.prefs ?? []) {
      if (!property || (type != "string" && type != "dropdown")) {
        continue;
      }
      const name = property.replace(/\./g, "-");
      let value = Services.prefs.getStringPref(property, "");
      if (!value && defaultValue !== undefined && typeof defaultValue != "object") {
        value = String(defaultValue);
      }
      if (!value) {
        continue;
      }
      if (type == "string") {
        if (!root.style.getPropertyValue(`--${name}`)) {
          root.style.setProperty(`--${name}`, value);
          vars.push(`--${name}`);
        }
      } else {
        if (!block && !document.getElementById(mod.block)) {
          block = document.createElementNS(HTML_NS, "div");
          block.id = mod.block;
          block.style.display = "none";
          (document.body ?? root).appendChild(block);
        }
        block?.setAttribute(name, value);
      }
    }
    root.setAttribute("whimsy-space-mod", mod.id);
    this.state(win).mod = { ...mod, vars, block };
  },

  removeMod(win) {
    const state = this.state(win);
    const mod = state.mod;
    if (!mod) {
      return;
    }
    state.mod = null;
    const utils = win.windowUtils;
    try {
      utils.removeSheetUsingURIString(mod.uri, utils.USER_SHEET);
    } catch (e) {
      // Already gone.
    }
    const root = win.document.documentElement;
    for (const name of mod.vars) {
      root.style.removeProperty(name);
    }
    mod.block?.remove();
    root.removeAttribute("whimsy-space-mod");
  },

  // -- Mini Whimsy -----------------------------------------------------

  mainWindow(win) {
    try {
      return lazy.WhimsyQuickWindow.mainWindow(win.opener);
    } catch (e) {
      return null;
    }
  },

  // Mini wears the look of the space "Open in" points at.
  initQuickWindow(win) {
    this.wrapDensity(win);
    const update = () => {
      try {
        const space = featureOn() ? this.mainWindow(win)?.gZenWorkspaces?.getActiveWorkspace?.() : null;
        this.applyWindow(win, this.lookOf(space));
      } catch (e) {
        console.error("Whimsy: Mini space look", e);
      }
    };
    const observer = {
      observe: () => update(),
      QueryInterface: ChromeUtils.generateQI(["nsIObserver", "nsISupportsWeakReference"]),
    };
    Services.obs.addObserver(observer, CHANGED_TOPIC);
    Services.prefs.addObserver(FEATURE_PREF, update);
    win.addEventListener("focus", update);
    win.addEventListener(
      "unload",
      () => {
        Services.obs.removeObserver(observer, CHANGED_TOPIC);
        Services.prefs.removeObserver(FEATURE_PREF, update);
        win.removeEventListener("focus", update);
      },
      { once: true }
    );
    update();
  },

  // -- the editor ------------------------------------------------------

  initContextMenu(win) {
    const popup = win.document.getElementById("zenWorkspaceMoreActions");
    popup?.addEventListener("popupshowing", event => {
      if (event.target == popup) {
        // Zen gives only "Delete Space" an access key in this menu, so the
        // menu has mixed access keys (Firefox's AccessKeyConflictError).
        // macOS menus don't show them; drop that one, as Firefox advises.
        popup.querySelector(":scope > #context_zenDeleteWorkspace")?.removeAttribute("accesskey");
        this.updateContextMenu(win, popup, event);
      }
    });
  },

  // The space a context menu or button acts on: the space's own button,
  // its Library card, or the tab list it was opened on.
  targetSpace(win, nodes) {
    const { gZenWorkspaces } = win;
    for (const node of nodes) {
      const el = node?.closest?.("[zen-workspace-id], zen-workspace");
      const id = el?.getAttribute("zen-workspace-id") || (el?.localName == "zen-workspace" ? el.id : null);
      const space = id && this.space(win, id);
      if (space) {
        return space;
      }
    }
    return gZenWorkspaces.getActiveWorkspace?.() ?? null;
  },

  updateContextMenu(win, popup, event) {
    const { document } = win;
    const anchor = document.getElementById("context_zenChangeWorkspaceTheme");
    if (!anchor) {
      return;
    }
    let item = document.getElementById(MENU_ID);
    if (!item) {
      item = document.createXULElement("menuitem");
      item.id = MENU_ID;
      document.l10n.setAttributes(item, "whimsy-space-look-menu");
      item.addEventListener("command", () => {
        const { uuid, node } = this._menuTarget ?? {};
        if (uuid) {
          this.openEditor(win, uuid, { node });
        }
      });
      anchor.after(item);
    }
    let node = null;
    try {
      node = popup.triggerNode ?? popup.anchorNode ?? event.explicitOriginalTarget;
    } catch (e) {
      node = null;
    }
    const space = this.targetSpace(win, [popup.triggerNode, popup.anchorNode, event.explicitOriginalTarget]);
    this._menuTarget = space ? { uuid: space.uuid, node } : null;
    item.hidden = !featureOn() || !space || !!win.gZenWorkspaces.privateWindowOrDisabled;
  },

  watchCreation(win) {
    const { document } = win;
    const state = this.state(win);
    if (!document.documentElement.hasAttribute("zen-creating-workspace")) {
      state.creationObserver?.disconnect();
      state.creationObserver = null;
      // Created or cancelled: the form's editor goes with it.
      if (state.editorFromForm) {
        lazy.WhimsyPanels.close(document.getElementById(PANEL_ID));
      }
      return;
    }
    const find = () => {
      const form = document.querySelector("zen-workspace-creation");
      if (!form) {
        return false;
      }
      state.creationObserver?.disconnect();
      state.creationObserver = null;
      Promise.resolve(form.promiseInitialized)
        .then(() => this.addFormButton(win, form))
        .catch(e => console.error("Whimsy: space look form", e));
      return true;
    };
    if (find() || state.creationObserver) {
      return;
    }
    const strip = document.getElementById("tabbrowser-arrowscrollbox");
    if (!strip) {
      return;
    }
    state.creationObserver = new win.MutationObserver(find);
    state.creationObserver.observe(strip, { childList: true, subtree: true });
  },

  addFormButton(win, form) {
    const { document } = win;
    if (!featureOn() || !form.isConnected || form.querySelector(`.${FORM_BUTTON_CLASS}`)) {
      return;
    }
    const theme = form.querySelector(".zen-workspace-creation-edit-theme-button");
    if (!theme) {
      return;
    }
    // Zen's own button class, so it looks and focuses like "Theme…".
    const button = document.createXULElement("button");
    button.className = `zen-workspace-creation-edit-theme-button ${FORM_BUTTON_CLASS}`;
    document.l10n.setAttributes(button, "whimsy-space-look-form-button");
    button.addEventListener("command", event => {
      this.openEditor(win, form.workspaceId || win.gZenWorkspaces.activeWorkspace, {
        node: button,
        fromForm: true,
        triggerEvent: event,
      });
    });
    theme.after(button);
    // Leave with the rest of the form when it closes.
    const getter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(form), "elementsToAnimate")?.get;
    if (getter) {
      Object.defineProperty(form, "elementsToAnimate", {
        configurable: true,
        get() {
          const list = getter.call(this);
          const at = list.indexOf(theme);
          list.splice(at < 0 ? list.length : at + 1, 0, button);
          return list;
        },
      });
    }
  },

  /**
   * Opens the look editor for a space: an overlay beside the sidebar,
   * built like Zen's theme picker. Changes preview live and save on Done
   * (or a click outside, as Zen's picker does); Cancel and Esc put the
   * space back as it was. A space that isn't showing is switched to
   * first, so the preview is on the real sidebar. Returns the panel.
   */
  openEditor(win, uuid, { node = null, fromForm = false, triggerEvent = null } = {}) {
    const space = uuid && this.space(win, uuid);
    if (!space || !featureOn() || win.gZenWorkspaces.privateWindowOrDisabled) {
      return null;
    }
    const { document: doc } = win;
    const state = this.state(win);
    // One editor at a time: a second open cancels the first.
    const previous = doc.getElementById(PANEL_ID);
    if (previous) {
      previous._whimsyFinish?.("cancel");
      // It leaves as it would on Cancel; its id goes now so the new one
      // has it.
      previous.removeAttribute("id");
      previous.querySelectorAll("[id]").forEach(el => el.removeAttribute("id"));
      if (previous.state == "open" || previous.state == "showing") {
        previous.hidePopup();
      } else {
        previous.remove();
      }
    }
    state.editorFromForm = fromForm;

    const original = this.lookOf(space);
    let draft = { ...original };
    // How the editor ended: "done", "cancel", or null (a click outside,
    // which keeps the change, like Zen's theme picker).
    let ending = null;

    const panel = doc.createXULElement("panel");
    panel.id = PANEL_ID;
    panel.className = "whimsy-look-picker";
    panel.setAttribute("type", "arrow");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("noautofocus", "true");
    panel.setAttribute("hidepopovertail", "true");
    panel.setAttribute("aria-labelledby", `${PANEL_ID}-title`);
    panel.dataset.uuid = uuid;

    const view = doc.createXULElement("vbox");
    view.className = "whimsy-look-picker-view";
    panel.append(view);

    // The space it's for, in Zen's picker's quiet heading weight.
    const header = doc.createXULElement("hbox");
    header.className = "whimsy-look-picker-header";
    header.setAttribute("align", "center");
    const title = doc.createElementNS(HTML_NS, "h1");
    title.id = `${PANEL_ID}-title`;
    title.className = "whimsy-look-picker-title";
    if (space.name) {
      doc.l10n.setAttributes(title, "whimsy-space-look-title", { space: space.name });
    } else {
      doc.l10n.setAttributes(title, "whimsy-space-look-title-unnamed");
    }
    header.append(title);
    view.append(header);

    // The pad: where Zen's picker has its dotted colour field, a type
    // specimen in the font the space will use.
    const pad = doc.createXULElement("vbox");
    pad.className = "whimsy-look-pad";
    pad.setAttribute("aria-hidden", "true");
    const specimen = doc.createXULElement("label");
    specimen.className = "whimsy-look-specimen";
    doc.l10n.setAttributes(specimen, "whimsy-space-look-specimen");
    const sample = doc.createXULElement("description");
    sample.className = "whimsy-look-specimen-sample";
    doc.l10n.setAttributes(sample, "whimsy-space-look-specimen-sample");
    const fontName = doc.createXULElement("label");
    fontName.className = "whimsy-look-specimen-name";
    const fontNameSystem = doc.createXULElement("label");
    fontNameSystem.className = "whimsy-look-specimen-name";
    doc.l10n.setAttributes(fontNameSystem, "whimsy-space-look-font-system");
    pad.append(specimen, sample, fontName, fontNameSystem);
    view.append(pad);

    const sections = doc.createXULElement("vbox");
    sections.className = "whimsy-look-sections";
    view.append(sections);

    const syncers = [];
    const sync = () => {
      for (const fn of syncers) {
        fn(draft);
      }
      reset.disabled = !Object.keys(draft).length;
    };
    const update = changes => {
      const next = { ...draft, ...changes };
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined) {
          delete next[key];
        }
      }
      draft = normalizeLook(next);
      this.preview(win, uuid, draft);
      sync();
    };

    // Interface font: a search field over a list, each family drawn in
    // itself. The space's font, else Settings', is the one ticked.
    const font = this.section(doc, "font", "whimsy-space-look-font", () => update({ font: undefined }));
    const search = doc.createElementNS(HTML_NS, "input");
    search.type = "search";
    search.className = "whimsy-look-search";
    doc.l10n.setAttributes(search, "whimsy-space-look-font-search");
    const fontList = this.listbox(doc, "font", value => update({ font: value }));
    fontList.list.setAttribute("aria-labelledby", font.labelId);
    const systemRow = fontList.add("", { l10nId: "whimsy-space-look-font-system", family: "system-ui" });
    systemRow.classList.add("whimsy-look-option-system");
    const noMatch = doc.createXULElement("description");
    noMatch.className = "whimsy-look-empty";
    noMatch.hidden = true;
    doc.l10n.setAttributes(noMatch, "whimsy-space-look-font-empty");
    font.section.append(search, fontList.list, noMatch);
    sections.append(font.section);
    const shownFont = look => ("font" in look ? look.font : this.globalFont());
    const ensureFont = family => {
      if (family && !fontList.has(family)) {
        fontList.add(family, { family: `"${family}", system-ui` });
      }
    };
    ensureFont(shownFont(draft));
    this.fontFamilies().then(families => {
      if (!panel.isConnected) {
        return;
      }
      for (const family of families) {
        ensureFont(family);
      }
      filter();
      sync();
    });
    const filter = () => {
      const query = search.value.trim().toLowerCase();
      const shown = fontList.filter(row => !query || row.textContent.toLowerCase().includes(query));
      noMatch.hidden = shown > 0;
    };
    search.addEventListener("input", filter);
    search.addEventListener("keydown", event => {
      if (event.key == "ArrowDown") {
        event.preventDefault();
        fontList.focusCurrent();
      } else if (event.key == "Enter") {
        event.preventDefault();
        fontList.pickFirstVisible();
      }
    });
    syncers.push(look => {
      const family = shownFont(look);
      ensureFont(family);
      fontList.select(family);
      font.setDefault(!("font" in look));
      const cssFamily = family ? `"${family}", system-ui` : "system-ui";
      specimen.style.fontFamily = cssFamily;
      sample.style.fontFamily = cssFamily;
      fontName.hidden = !family;
      fontNameSystem.hidden = !!family;
      if (family) {
        fontName.setAttribute("value", family);
      }
    });

    // Density and tab title lines: segmented, one choice of three.
    const density = this.section(doc, "density", "whimsy-space-look-density", () => update({ density: undefined }));
    const densityChips = this.segmented(
      doc,
      "density",
      Object.keys(DENSITIES).map(name => ({ value: name, l10nId: `whimsy-space-look-density-${name}` })),
      value => update({ density: value })
    );
    densityChips.group.setAttribute("aria-labelledby", density.labelId);
    density.section.append(densityChips.group);
    sections.append(density.section);
    syncers.push(look => {
      densityChips.select(look.density ?? this.globalDensity());
      density.setDefault(!look.density);
    });

    const lines = this.section(doc, "lines", "whimsy-space-look-lines", () => update({ lines: undefined }));
    const lineChips = this.segmented(
      doc,
      "lines",
      LINES.map(n => ({ value: String(n), l10nId: "whimsy-space-look-lines-count", l10nArgs: { lines: n } })),
      value => update({ lines: Number(value) })
    );
    lineChips.group.setAttribute("aria-labelledby", lines.labelId);
    lines.section.append(lineChips.group);
    sections.append(lines.section);
    syncers.push(look => {
      lineChips.select(String(look.lines ?? this.globalLines()));
      lines.setDefault(!look.lines);
    });

    // Zen Mod: only when mods are installed. One that's off in Zen Mods
    // can be on for this space alone.
    const mod = this.section(doc, "mod", "whimsy-space-look-mod", () => update({ mod: undefined }));
    mod.section.hidden = true;
    const modList = this.listbox(doc, "mod", value => update({ mod: value || undefined }));
    modList.list.setAttribute("aria-labelledby", mod.labelId);
    modList.add("", { l10nId: "whimsy-space-look-mod-none" });
    const modHint = doc.createXULElement("description");
    modHint.className = "whimsy-look-hint";
    doc.l10n.setAttributes(modHint, "whimsy-space-look-mod-hint");
    mod.section.append(modList.list, modHint);
    sections.append(mod.section);
    Promise.all([this.availableMods(win), this.installedModCount(win)]).then(([mods, installed]) => {
      if (!panel.isConnected) {
        return;
      }
      for (const item of mods) {
        modList.add(item.id, { text: item.name });
      }
      if (draft.mod && !modList.has(draft.mod)) {
        modList.add(draft.mod, { text: draft.mod });
      }
      mod.section.hidden = !installed && !draft.mod;
      sync();
    });
    syncers.push(look => {
      modList.select(look.mod ?? "");
      mod.setDefault(!look.mod);
    });

    // Reset on the left, away from Done; Cancel beside Done.
    const footer = doc.createXULElement("hbox");
    footer.className = "panel-footer whimsy-look-footer";
    footer.setAttribute("align", "center");
    const button = (l10nId, onCommand, primary = false) => {
      const el = doc.createXULElement("button");
      el.className = "footer-button";
      if (primary) {
        el.classList.add("primary");
        el.setAttribute("default", "true");
      }
      doc.l10n.setAttributes(el, l10nId);
      el.addEventListener("command", onCommand);
      return el;
    };
    const reset = button("whimsy-space-look-reset", () => update({ font: undefined, density: undefined, lines: undefined, mod: undefined }));
    reset.classList.add("whimsy-look-reset");
    const spacer = doc.createXULElement("spacer");
    spacer.setAttribute("flex", "1");
    const cancel = button("whimsy-space-look-cancel", () => finish("cancel"));
    cancel.classList.add("whimsy-look-cancel");
    const done = button("whimsy-space-look-done", () => finish("done"), true);
    done.classList.add("whimsy-look-done");
    footer.append(reset, spacer, cancel, done);
    view.append(footer);

    const finish = how => {
      ending ??= how;
      lazy.WhimsyPanels.close(panel);
    };
    panel._whimsyFinish = how => {
      ending ??= how;
      settle();
    };
    let settled = false;
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (ending == "cancel") {
        this.endPreview(win);
        return;
      }
      if (JSON.stringify(normalizeLook(draft)) == JSON.stringify(original)) {
        this.endPreview(win);
        return;
      }
      // Stored first, so the refresh after the preview ends changes nothing.
      this.state(win).preview = null;
      this.replaceLook(win, uuid, draft, { morph: false });
    };

    // Esc cancels from anywhere while it's open; a search with text in it
    // clears first. Return in the search picks; elsewhere it's Done.
    const onKey = event => {
      if (event.defaultPrevented || panel.state != "open") {
        return;
      }
      if (event.key == "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (event.target == search && search.value) {
          search.value = "";
          filter();
          return;
        }
        finish("cancel");
      } else if (event.key == "Enter" && panel.contains(event.target) && event.target.localName != "button" && event.target != search) {
        event.preventDefault();
        finish("done");
      }
    };
    panel.addEventListener("popupshown", event => {
      if (event.target != panel) {
        return;
      }
      win.addEventListener("keydown", onKey, true);
      search.focus();
    });
    panel.addEventListener("popuphidden", event => {
      if (event.target != panel) {
        return;
      }
      win.removeEventListener("keydown", onKey, true);
      settle();
      if (doc.getElementById(PANEL_ID) == panel) {
        state.editorFromForm = false;
      }
      if (fromForm && node?.isConnected) {
        node.focus();
      }
      panel.remove();
    });

    (doc.getElementById("mainPopupSet") ?? doc.documentElement).append(panel);
    sync();

    const open = () => {
      if (!panel.isConnected || settled) {
        return;
      }
      // Where Zen's theme picker opens: beside the sidebar, its top level
      // with the sidebar's, so the sidebar it previews on stays in view.
      const rightSide = !!win.gZenVerticalTabsManager?._prefsRightSide;
      const sidebar = lazy.WhimsyPanels.visibleAnchor(win, ["TabsToolbar", "navigator-toolbox"]);
      if (sidebar) {
        panel.openPopup(sidebar, {
          position: rightSide ? "topleft topright" : "topright topleft",
          x: rightSide ? 10 : -10,
          y: fromForm ? -160 : 0,
          triggerEvent,
        });
      } else {
        lazy.WhimsyPanels.open(win, panel, { triggerEvent });
      }
    };
    if (win.gZenWorkspaces.activeWorkspace == uuid) {
      open();
    } else {
      Promise.resolve(win.gZenWorkspaces.changeWorkspaceWithID(uuid))
        .catch(e => console.error("Whimsy: space look switch", e))
        .then(open);
    }
    return panel;
  },

  // A section: its name on the left; on the right, in one fixed place,
  // either "Browser default" (it follows Settings) or the button that
  // makes it follow Settings again.
  section(doc, name, captionL10nId, onUseDefault) {
    const section = doc.createXULElement("vbox");
    section.className = "whimsy-look-section";
    section.dataset.section = name;
    const caption = doc.createXULElement("hbox");
    caption.className = "whimsy-look-caption";
    caption.setAttribute("align", "center");
    const label = doc.createXULElement("label");
    label.id = `${PANEL_ID}-${name}-label`;
    label.className = "whimsy-look-caption-label";
    doc.l10n.setAttributes(label, captionL10nId);
    const tag = doc.createXULElement("label");
    tag.className = "whimsy-look-default-tag";
    doc.l10n.setAttributes(tag, "whimsy-space-look-default-tag");
    const useDefault = doc.createElementNS(HTML_NS, "button");
    useDefault.type = "button";
    useDefault.className = "whimsy-look-use-default";
    doc.l10n.setAttributes(useDefault, "whimsy-space-look-use-default");
    useDefault.addEventListener("click", () => {
      onUseDefault();
      // The button goes; keep the keyboard in the section.
      section.querySelector("[tabindex='0']:not(.whimsy-look-use-default)")?.focus();
    });
    caption.append(label, tag, useDefault);
    section.append(caption);
    const setDefault = following => {
      section.toggleAttribute("following-default", following);
      tag.hidden = !following;
      useDefault.hidden = following;
    };
    return { section, labelId: label.id, setDefault };
  },

  // A segmented control (one tab stop, arrow keys move and pick) whose
  // thumb slides to the choice.
  segmented(doc, name, options, onPick) {
    const group = doc.createElementNS(HTML_NS, "div");
    group.className = "whimsy-look-segmented";
    group.setAttribute("role", "radiogroup");
    group.dataset.group = name;
    group.style.setProperty("--count", String(options.length));
    const thumb = doc.createElementNS(HTML_NS, "div");
    thumb.className = "whimsy-look-segment-thumb";
    group.append(thumb);
    const buttons = options.map(option => {
      const button = doc.createElementNS(HTML_NS, "button");
      button.type = "button";
      button.className = "whimsy-look-segment";
      button.setAttribute("role", "radio");
      button.dataset.value = option.value;
      doc.l10n.setAttributes(button, option.l10nId, option.l10nArgs);
      button.addEventListener("click", () => onPick(option.value));
      group.append(button);
      return button;
    });
    group.addEventListener("keydown", event => {
      const keys = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
      if (!(event.key in keys)) {
        return;
      }
      event.preventDefault();
      // Left and right follow the reading direction.
      const flip = doc.dir == "rtl" && (event.key == "ArrowLeft" || event.key == "ArrowRight");
      const step = flip ? -keys[event.key] : keys[event.key];
      const at = Math.max(0, buttons.indexOf(event.target));
      const next = buttons[Math.min(buttons.length - 1, Math.max(0, at + step))];
      next.focus();
      onPick(next.dataset.value);
    });
    const select = value => {
      let index = 0;
      buttons.forEach((button, i) => {
        const on = button.dataset.value == value;
        button.setAttribute("aria-checked", on ? "true" : "false");
        button.tabIndex = on ? 0 : -1;
        if (on) {
          index = i;
        }
      });
      if (!buttons.some(b => b.tabIndex == 0)) {
        buttons[0].tabIndex = 0;
      }
      group.style.setProperty("--index", String(index));
    };
    return { group, select };
  },

  // A short list of choices (fonts, mods): one tab stop, arrow keys move
  // and pick, so every step previews.
  listbox(doc, name, onPick) {
    const list = doc.createElementNS(HTML_NS, "div");
    list.className = "whimsy-look-list";
    list.setAttribute("role", "listbox");
    list.dataset.list = name;
    const rows = new Map();
    let current = null;
    const visibleRows = () => [...rows.values()].filter(row => !row.hidden);
    const add = (value, { l10nId = null, text = null, family = null } = {}) => {
      const row = doc.createElementNS(HTML_NS, "div");
      row.className = "whimsy-look-option";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", "false");
      row.tabIndex = -1;
      row.dataset.value = value;
      if (l10nId) {
        doc.l10n.setAttributes(row, l10nId);
      } else {
        row.textContent = text ?? value;
      }
      if (family) {
        row.style.fontFamily = family;
      }
      row.addEventListener("click", () => onPick(value));
      list.append(row);
      rows.set(value, row);
      return row;
    };
    const roving = () => {
      const shown = visibleRows();
      const target = current && !current.hidden ? current : shown[0];
      for (const row of rows.values()) {
        row.tabIndex = row == target ? 0 : -1;
      }
    };
    const select = value => {
      for (const row of rows.values()) {
        row.setAttribute("aria-selected", row.dataset.value == value ? "true" : "false");
      }
      current = rows.get(value) ?? null;
      roving();
      if (current && !current.hidden) {
        // Keep the choice in view, inside the list only.
        const top = current.offsetTop - list.offsetTop;
        if (top < list.scrollTop || top + current.offsetHeight > list.scrollTop + list.clientHeight) {
          list.scrollTop = top - (list.clientHeight - current.offsetHeight) / 2;
        }
      }
    };
    list.addEventListener("keydown", event => {
      const shown = visibleRows();
      const at = shown.indexOf(event.target);
      let next = null;
      if (event.key == "ArrowDown") {
        next = shown[Math.min(shown.length - 1, at + 1)];
      } else if (event.key == "ArrowUp") {
        next = shown[Math.max(0, at - 1)];
      } else if (event.key == "Home") {
        next = shown[0];
      } else if (event.key == "End") {
        next = shown.at(-1);
      } else if (event.key == "PageDown" || event.key == "PageUp") {
        const step = Math.max(1, Math.floor(list.clientHeight / (event.target.offsetHeight || 28)) - 1);
        next = shown[Math.min(shown.length - 1, Math.max(0, at + (event.key == "PageDown" ? step : -step)))];
      } else if (event.key == " ") {
        next = event.target;
      }
      if (!next || at < 0) {
        return;
      }
      event.preventDefault();
      next.focus();
      onPick(next.dataset.value);
    });
    return {
      list,
      add,
      select,
      has: value => rows.has(value),
      filter(test) {
        let shown = 0;
        for (const row of rows.values()) {
          row.hidden = !test(row);
          shown += row.hidden ? 0 : 1;
        }
        roving();
        return shown;
      },
      focusCurrent() {
        (current && !current.hidden ? current : visibleRows()[0])?.focus();
      },
      pickFirstVisible() {
        const first = visibleRows()[0];
        if (first) {
          first.focus();
          onPick(first.dataset.value);
        }
      },
    };
  },

  // Every installed family, suggestions first.
  async fontFamilies() {
    let families = [];
    try {
      const enumerator = Cc["@mozilla.org/gfx/fontenumerator;1"].getService(Ci.nsIFontEnumerator);
      families = [...new Set(await enumerator.EnumerateAllFontsAsync())].filter(f => f && !f.startsWith("."));
    } catch (e) {
      console.error("Whimsy: space look fonts", e);
    }
    const suggested = SUGGESTED_FONTS.filter(f => families.includes(f));
    return [...suggested, ...families.filter(f => !suggested.includes(f))];
  },
};
