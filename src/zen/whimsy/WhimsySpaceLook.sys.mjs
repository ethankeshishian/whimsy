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

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
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

  // Everything back to Settings.
  reset(win, uuid) {
    const workspace = this.space(win, uuid);
    if (!workspace || !workspace.whimsyLook) {
      return;
    }
    delete workspace.whimsyLook;
    this.save(win, workspace);
  },

  save(win, workspace) {
    const state = this.state(win);
    // Zen announces the save (ZenWorkspaceDataChanged); this window
    // applies it below, with its tab list in the dip too.
    state.saving = true;
    try {
      win.gZenWorkspaces.saveWorkspace(workspace);
    } finally {
      state.saving = false;
    }
    this.refresh(win, { morph: true, includeTabs: true });
    // Other windows (Zen's sync already gave them the data) and Mini.
    Services.obs.notifyObservers(win, CHANGED_TOPIC, workspace.uuid);
  },

  // -- windows ---------------------------------------------------------

  state(win) {
    let state = states.get(win);
    if (!state) {
      state = { rootKey: null, density: null, mod: null, modGen: 0, morphGen: 0 };
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
    const looks = new Map(spaces.map(space => [space.uuid, this.lookOf(space)]));
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
      document.getElementById(PANEL_ID),
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
   * Opens the editor for a space. Every change applies (and is saved) at
   * once, like Zen's theme picker; Done or Esc closes it.
   */
  openEditor(win, uuid, { node = null, fromForm = false, triggerEvent = null } = {}) {
    const space = this.space(win, uuid);
    if (!space || !featureOn()) {
      return null;
    }
    const { document: doc } = win;
    const state = this.state(win);
    state.editorFromForm = fromForm;
    const { panel, body, footer } = lazy.WhimsyPanels.create(win, {
      id: PANEL_ID,
      titleL10nId: "whimsy-space-look-title",
      subtitleL10nId: "whimsy-space-look-subtitle",
      subtitleArgs: { space: space.name || "" },
      size: "medium",
      footer: true,
      onHidden: () => {
        state.editorFromForm = false;
        if (fromForm && node?.isConnected) {
          node.focus();
        }
      },
    });
    panel.classList.add("whimsy-space-look");
    panel.dataset.uuid = uuid;

    const current = () => this.lookOf(this.space(win, uuid));
    const set = changes => {
      this.setLook(win, uuid, changes);
      sync();
    };
    const syncers = [];
    const sync = () => {
      const look = current();
      for (const fn of syncers) {
        fn(look);
      }
      reset.disabled = !Object.keys(look).length;
    };

    // Interface font.
    const fontList = doc.createXULElement("menulist");
    fontList.className = "whimsy-space-look-menulist";
    fontList.setAttribute("sizetopopup", "none");
    fontList.setAttribute("crop", "end");
    const fontPopup = doc.createXULElement("menupopup");
    fontList.append(fontPopup);
    const fontDefault = doc.createXULElement("menuitem");
    fontDefault.setAttribute("value", "*default");
    const globalFont = this.globalFont();
    doc.l10n.setAttributes(
      fontDefault,
      globalFont ? "whimsy-space-look-font-default" : "whimsy-space-look-font-default-system",
      globalFont ? { font: globalFont } : undefined
    );
    const fontSystem = doc.createXULElement("menuitem");
    fontSystem.setAttribute("value", "");
    fontSystem.classList.add("whimsy-font-preview");
    fontSystem.style.fontFamily = "system-ui";
    doc.l10n.setAttributes(fontSystem, "whimsy-space-look-font-system");
    fontPopup.append(fontDefault, fontSystem, doc.createXULElement("menuseparator"));
    const addFamily = (family, before = null) => {
      const item = doc.createXULElement("menuitem");
      item.setAttribute("value", family);
      item.setAttribute("label", family);
      item.classList.add("whimsy-font-preview");
      item.style.fontFamily = `"${family}", system-ui`;
      fontPopup.insertBefore(item, before);
      return item;
    };
    const lookFont = current().font;
    if (lookFont) {
      addFamily(lookFont);
    }
    this.fontFamilies().then(families => {
      if (!fontList.isConnected) {
        return;
      }
      for (const family of families) {
        if (family != lookFont) {
          addFamily(family);
        }
      }
      sync();
    });
    fontList.addEventListener("command", () => {
      const value = fontList.value;
      set({ font: value == "*default" ? undefined : value });
    });
    body.append(this.section(doc, "font", "whimsy-space-look-font", fontList));
    syncers.push(look => {
      fontList.value = "font" in look ? look.font : "*default";
    });

    // Density.
    const density = this.chips(doc, "density", [
      { value: "*default", l10nId: "whimsy-space-look-default" },
      ...Object.keys(DENSITIES).map(name => ({ value: name, l10nId: `whimsy-space-look-density-${name}` })),
    ], value => set({ density: value == "*default" ? undefined : value }));
    const densitySection = this.section(doc, "density", "whimsy-space-look-density", density.group);
    body.append(densitySection);
    syncers.push(look => {
      density.select(look.density ?? "*default");
      this.setDetail(doc, densitySection, look.density ? null : `whimsy-space-look-density-${this.globalDensity()}`);
    });

    // Tab title lines.
    const lines = this.chips(doc, "lines", [
      { value: "*default", l10nId: "whimsy-space-look-default" },
      ...LINES.map(n => ({ value: String(n), l10nId: "whimsy-space-look-lines-count", l10nArgs: { lines: n } })),
    ], value => set({ lines: value == "*default" ? undefined : Number(value) }));
    const linesSection = this.section(doc, "lines", "whimsy-space-look-lines", lines.group);
    body.append(linesSection);
    syncers.push(look => {
      lines.select(look.lines ? String(look.lines) : "*default");
      this.setDetail(doc, linesSection, look.lines ? null : "whimsy-space-look-lines-count", {
        lines: this.globalLines(),
      });
    });

    // Zen Mod: only offered when there are mods; turned-off ones can be
    // turned on here for this space alone.
    const modList = doc.createXULElement("menulist");
    modList.className = "whimsy-space-look-menulist";
    modList.setAttribute("sizetopopup", "none");
    modList.setAttribute("crop", "end");
    const modPopup = doc.createXULElement("menupopup");
    modList.append(modPopup);
    const modNone = doc.createXULElement("menuitem");
    modNone.setAttribute("value", "");
    doc.l10n.setAttributes(modNone, "whimsy-space-look-mod-none");
    modPopup.append(modNone);
    const modHint = doc.createXULElement("description");
    modHint.className = "whimsy-space-look-hint";
    doc.l10n.setAttributes(modHint, "whimsy-space-look-mod-hint");
    const modSection = this.section(doc, "mod", "whimsy-space-look-mod", modList, modHint);
    modSection.hidden = true;
    body.append(modSection);
    modList.addEventListener("command", () => set({ mod: modList.value || undefined }));
    Promise.all([this.availableMods(win), this.installedModCount(win)]).then(([mods, installed]) => {
      if (!modList.isConnected) {
        return;
      }
      for (const mod of mods) {
        const item = doc.createXULElement("menuitem");
        item.setAttribute("value", mod.id);
        item.setAttribute("label", mod.name);
        modPopup.append(item);
      }
      modList.hidden = !mods.length;
      modSection.hidden = !installed && !current().mod;
      sync();
    });
    syncers.push(look => {
      modList.value = look.mod ?? "";
    });

    const note = doc.createXULElement("description");
    note.className = "whimsy-space-look-note";
    doc.l10n.setAttributes(note, "whimsy-space-look-note");
    body.append(note);

    const reset = lazy.WhimsyPanels.footerButton(doc, {
      l10nId: "whimsy-space-look-reset",
      onCommand: () => {
        this.reset(win, uuid);
        sync();
      },
    });
    reset.classList.add("whimsy-space-look-reset");
    const done = lazy.WhimsyPanels.footerButton(doc, {
      l10nId: "whimsy-space-look-done",
      primary: true,
      onCommand: () => lazy.WhimsyPanels.close(panel),
    });
    footer.append(reset, done);
    sync();

    // Beside the sidebar, where Zen's theme picker opens; on a Library
    // card, under its button; with no sidebar showing, over the page.
    const rightSide = !!win.gZenVerticalTabsManager?._prefsRightSide;
    const library = node?.closest?.(".zen-library-space") ? node : null;
    const sidebar = lazy.WhimsyPanels.visibleAnchor(win, [fromForm ? node : null, "navigator-toolbox"].filter(Boolean));
    if (library) {
      panel.openPopup(library, { position: "after_end", triggerEvent });
    } else if (sidebar) {
      panel.openPopup(sidebar, {
        position: fromForm
          ? rightSide ? "start_before" : "end_before"
          : rightSide ? "topleft topright" : "topright topleft",
        x: fromForm ? 0 : rightSide ? 10 : -10,
        triggerEvent,
      });
    } else {
      lazy.WhimsyPanels.open(win, panel, { triggerEvent });
    }
    return panel;
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

  section(doc, name, captionL10nId, ...controls) {
    const section = doc.createXULElement("vbox");
    section.className = "whimsy-space-look-section";
    section.dataset.section = name;
    const caption = doc.createXULElement("hbox");
    caption.className = "whimsy-space-look-caption";
    caption.setAttribute("align", "center");
    const label = doc.createXULElement("label");
    label.id = `${PANEL_ID}-${name}-label`;
    doc.l10n.setAttributes(label, captionL10nId);
    const detail = doc.createXULElement("label");
    detail.className = "whimsy-space-look-caption-detail";
    detail.hidden = true;
    caption.append(label, detail);
    for (const control of controls) {
      control.setAttribute?.("aria-labelledby", label.id);
    }
    section.append(caption, ...controls);
    return section;
  },

  // "Settings: Normal" beside a caption while the space follows Settings.
  setDetail(doc, section, valueL10nId, args = undefined) {
    const detail = section.querySelector(".whimsy-space-look-caption-detail");
    if (!valueL10nId) {
      detail.hidden = true;
      return;
    }
    detail.hidden = false;
    doc.l10n.formatValue(valueL10nId, args).then(value => {
      if (detail.isConnected) {
        doc.l10n.setAttributes(detail, "whimsy-space-look-follows", { value: value ?? "" });
      }
    });
  },

  // A segmented control: one choice of a few, arrow keys move along it.
  chips(doc, name, options, onPick) {
    const group = doc.createElementNS(HTML_NS, "div");
    group.className = "whimsy-space-look-chips";
    group.setAttribute("role", "radiogroup");
    group.dataset.group = name;
    const buttons = options.map(option => {
      const button = doc.createElementNS(HTML_NS, "button");
      button.type = "button";
      button.className = "whimsy-space-look-chip";
      button.setAttribute("role", "radio");
      button.dataset.value = option.value;
      doc.l10n.setAttributes(button, option.l10nId, option.l10nArgs);
      button.addEventListener("click", () => {
        if (button.getAttribute("aria-checked") != "true") {
          onPick(option.value);
        }
      });
      group.append(button);
      return button;
    });
    group.addEventListener("keydown", event => {
      if (event.key != "ArrowLeft" && event.key != "ArrowRight") {
        return;
      }
      event.preventDefault();
      const rtl = doc.dir == "rtl";
      const step = (event.key == "ArrowRight") != rtl ? 1 : -1;
      const at = buttons.indexOf(event.target);
      const next = buttons[(at + step + buttons.length) % buttons.length];
      next.focus();
      next.click();
    });
    const select = value => {
      for (const button of buttons) {
        const on = button.dataset.value == value;
        button.setAttribute("aria-checked", on ? "true" : "false");
        button.tabIndex = on ? 0 : -1;
      }
    };
    return { group, select };
  },
};
