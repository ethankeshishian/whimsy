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

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.cheatsheet";

// The <key> element id (not the command id) -> the label shown.
const SHEET_KEYS = [
  ["zen-duplicate-tab", "whimsy-cheatsheet-duplicate-tab"],
  ["zen-toggle-pin-tab", "whimsy-cheatsheet-pin-tab"],
  ["key_whimsyTabNext", "whimsy-cheatsheet-tab-next"],
  ["key_whimsyTabPrev", "whimsy-cheatsheet-tab-prev"],
  ["key_whimsyFocusSidebar", "whimsy-cheatsheet-focus-sidebar"],
  ["key_whimsyCheatsheet", "whimsy-cheatsheet-self"],
];

const DISPLAY_KEYCODE = { VK_UP: "↑", VK_DOWN: "↓", VK_LEFT: "←", VK_RIGHT: "→", VK_RETURN: "↵", VK_ESCAPE: "⎋" };

function keyLabel(keyEl) {
  const parts = [];
  const mods = (keyEl.getAttribute("modifiers") || "").split(/[,\s]+/).filter(Boolean);
  if (mods.some(m => ["accel", "meta", "control"].includes(m))) {
    parts.push("⌘");
  }
  if (mods.includes("alt")) {
    parts.push("⌥");
  }
  if (mods.includes("shift")) {
    parts.push("⇧");
  }
  const key = keyEl.getAttribute("key");
  const keycode = keyEl.getAttribute("keycode");
  parts.push(key ? key.toUpperCase() : DISPLAY_KEYCODE[keycode] || (keycode || "").replace("VK_", ""));
  return parts.join("");
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

  rows(win) {
    const { document } = win;
    return SHEET_KEYS.map(([keyId, l10nId]) => {
      const keyEl = document.getElementById(keyId);
      return keyEl ? { l10nId, label: keyLabel(keyEl) } : null;
    }).filter(Boolean);
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

    const render = () => {
      const query = search.value.trim().toLowerCase();
      list.replaceChildren();
      for (const row of this.rows(win)) {
        const line = document.createXULElement("hbox");
        line.className = "whimsy-cheatsheet-row";
        const name = document.createXULElement("label");
        document.l10n.setAttributes(name, row.l10nId);
        const key = document.createXULElement("label");
        key.className = "whimsy-cheatsheet-key";
        key.textContent = row.label;
        line.append(name, key);
        list.appendChild(line);
        if (query && !name.textContent?.toLowerCase().includes(query)) {
          line.hidden = true;
        }
      }
    };
    search.addEventListener("input", render);
    panel.addEventListener("popupshown", () => {
      render();
      search.focus();
    });
    panel.addEventListener("keydown", event => {
      if (event.key == "Escape") {
        panel.hidePopup();
      }
    });
    panel.addEventListener("popuphidden", () => panel.remove());

    document.documentElement.appendChild(panel);
    const { screenX, outerWidth, screenY, outerHeight } = win;
    panel.openPopupAtScreen(screenX + outerWidth / 2 - 180, screenY + outerHeight / 2 - 160, false);
  },
};
