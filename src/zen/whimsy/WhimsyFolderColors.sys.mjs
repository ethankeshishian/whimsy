/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Folder colors (Arc parity-ish). Arc lets a folder carry its own color so
// a sidebar full of folders can be told apart at a glance. Zen draws every
// folder icon in the space's accent color. Whimsy adds Color to the folder
// context menu (after Change Icon): Default (the space's color) and nine
// swatches; the folder's icon takes that color in every window.
//
// Choices live in whimsy.folders.colors ({folderId: color}); folder ids
// survive restarts and window sync. Each window loads one generated sheet
// with a rule per colored folder, so folders created, restored or synced
// later pick their color up without any bookkeeping. With
// whimsy.feature.folder-colors off, the menu hides and the sheet unloads.

const FEATURE_PREF = "whimsy.feature.folder-colors";
const COLORS_PREF = "whimsy.folders.colors";
const MENU_ID = "context_whimsyFolderColor";

// Arc-like hues: saturated enough to read on a small icon in both themes.
export const FOLDER_COLORS = {
  gray: "#8e8e93",
  red: "#f0524f",
  orange: "#f5923e",
  yellow: "#f2c230",
  green: "#4cbf6b",
  teal: "#3cbcc0",
  blue: "#4a8ff7",
  purple: "#9a6cf0",
  pink: "#ec68ad",
};

function cssString(text) {
  return `"${String(text).replace(/["\\\n]/g, c => `\\${c.charCodeAt(0).toString(16)} `)}"`;
}

export const WhimsyFolderColors = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  get colors() {
    try {
      const value = JSON.parse(Services.prefs.getStringPref(COLORS_PREF, "{}"));
      return value && typeof value == "object" ? value : {};
    } catch {
      return {};
    }
  },

  colorOf(folder) {
    const color = this.colors[folder?.id];
    return FOLDER_COLORS[color] ? color : null;
  },

  setColor(folder, color) {
    if (!folder?.id) {
      return;
    }
    const colors = this.colors;
    if (color && FOLDER_COLORS[color]) {
      colors[folder.id] = color;
    } else {
      delete colors[folder.id];
    }
    Services.prefs.setStringPref(COLORS_PREF, JSON.stringify(colors));
  },

  // The sheet: each colored folder redefines Zen's three folder-icon colors
  // (zen-folders.css) from its own hue, on its own label only, so subfolders
  // keep theirs.
  sheetText() {
    const rules = [];
    for (const [id, color] of Object.entries(this.colors)) {
      const hex = FOLDER_COLORS[color];
      if (!hex) {
        continue;
      }
      rules.push(`zen-folder[id=${cssString(id)}] > .tab-group-label-container {
  --whimsy-folder-color: ${hex};
  --zen-folder-behind-bgcolor: light-dark(color-mix(in srgb, var(--whimsy-folder-color) 70%, gray), color-mix(in srgb, var(--whimsy-folder-color) 65%, #c1c1c1));
  --zen-folder-front-bgcolor: light-dark(color-mix(in srgb, var(--whimsy-folder-color), white 55%), color-mix(in srgb, var(--whimsy-folder-color), black 35%));
  --zen-folder-stroke: light-dark(color-mix(in srgb, var(--whimsy-folder-color) 55%, black), color-mix(in srgb, var(--whimsy-folder-color) 30%, #ebebeb));
}`);
    }
    return rules.join("\n");
  },

  initWindow(win) {
    let sheet = null;
    const apply = () => {
      const utils = win.windowUtils;
      if (sheet) {
        utils.removeSheetUsingURIString(sheet, utils.AUTHOR_SHEET);
        sheet = null;
      }
      win.document.documentElement.toggleAttribute("whimsy-folder-colors", this.enabled);
      const text = this.enabled ? this.sheetText() : "";
      if (text) {
        sheet = `data:text/css;charset=utf-8,${encodeURIComponent(text)}`;
        utils.loadSheetUsingURIString(sheet, utils.AUTHOR_SHEET);
      }
    };
    const observer = () => apply();
    Services.prefs.addObserver(COLORS_PREF, observer);
    Services.prefs.addObserver(FEATURE_PREF, observer);
    win.addEventListener(
      "unload",
      () => {
        Services.prefs.removeObserver(COLORS_PREF, observer);
        Services.prefs.removeObserver(FEATURE_PREF, observer);
      },
      { once: true }
    );
    apply();

    const menu = win.document.getElementById("zenFolderActions");
    menu?.addEventListener("popupshowing", event => {
      if (event.target == menu) {
        this.updateMenu(win, this.folderFor(menu, event));
      }
    });
  },

  // The folder the menu was opened on, found the way Zen's handler does.
  folderFor(menu, event) {
    const target = menu.triggerNode ?? event.explicitOriginalTarget;
    let folder = null;
    if (target?.closest) {
      folder = target.closest("zen-folder");
    }
    return folder?.isZenFolder ? folder : null;
  },

  updateMenu(win, folder) {
    const { document } = win;
    let item = document.getElementById(MENU_ID);
    if (!this.enabled || !folder) {
      if (item) {
        item.hidden = true;
      }
      return;
    }
    if (!item) {
      item = this.createMenu(win);
    }
    item.hidden = false;
    item._whimsyFolder = folder;
    const current = this.colorOf(folder) ?? "default";
    for (const option of item.querySelectorAll("menuitem")) {
      option.toggleAttribute("checked", option.getAttribute("value") == current);
    }
  },

  createMenu(win) {
    const { document } = win;
    const item = document.createXULElement("menu");
    item.id = MENU_ID;
    document.l10n.setAttributes(item, "whimsy-folder-color");
    const popup = document.createXULElement("menupopup");
    popup.id = "whimsyFolderColorPopup";
    for (const value of ["default", ...Object.keys(FOLDER_COLORS)]) {
      const option = document.createXULElement("menuitem");
      option.setAttribute("type", "radio");
      option.setAttribute("name", "whimsy-folder-color");
      option.setAttribute("value", value);
      option.classList.add("whimsy-folder-color-option");
      if (FOLDER_COLORS[value]) {
        option.style.setProperty("--whimsy-swatch", FOLDER_COLORS[value]);
      }
      document.l10n.setAttributes(option, `whimsy-folder-color-${value}`);
      popup.appendChild(option);
    }
    // Zen's menu handles "command" for its own ids; stop ours there.
    popup.addEventListener("command", event => {
      event.stopPropagation();
      const value = event.target.getAttribute("value");
      this.setColor(item._whimsyFolder, value == "default" ? null : value);
    });
    item.appendChild(popup);
    const anchor = document.getElementById("context_zenFolderChangeIcon");
    if (anchor) {
      anchor.after(item);
    } else {
      document.getElementById("zenFolderActions").appendChild(item);
    }
    return item;
  },
};
