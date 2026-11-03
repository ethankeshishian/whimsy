/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W11-15: the Hidden Spaces panel. "Show Hidden Spaces…" was a short native
// menu (WhimsyAccessCommands.showChooser), which breaks the UI standard:
// feature UI is a WhimsySurface, in the Theme picker / Edit Space Look
// family. This is that surface:
//
// - One row per hidden space: a tile in the space's theme colour with its
//   icon, the name, "{count} tabs · {profile}" (the profile only when the
//   device has more than one) and a Locked pill for a locked space.
// - A row click or Return shows the space again and switches to it (the
//   user's pick, d15); the panel stays open (W14-B5) — the row leaves the
//   list and focus moves to its neighbour, or the empty state takes over
//   once the last one is gone. An always-visible Unhide pill marks that
//   this is what the row does; a locked row shows its Locked pill instead.
//   A locked space asks to unlock first, through
//   WhimsySpaceLock.ensureUnlocked; if that's cancelled the
//   space stays hidden. The toast says it's back in the switcher, with Undo.
// - Keys: Up/Down/Home/End move (WhimsySurface's listbox keys), typing
//   filters once there are 6 or more, Esc clears the filter, then closes.
// - The footer hides the current space ("Hide “Work”"), so hiding and
//   showing live in one place. Never shown for the last visible space.
// - The command is always available; with nothing hidden the panel shows
//   its empty state (d15).
// - Settings → Tab Management keeps one row, "Hidden spaces · N", whose
//   button opens this panel (d16), instead of a second list.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
  WhimsySpaceArchive: "resource:///modules/whimsy/WhimsySpaceArchive.sys.mjs",
  WhimsySpaceLock: "resource:///modules/whimsy/WhimsySpaceLock.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
  WhimsyUndo: "resource:///modules/whimsy/WhimsyUndo.sys.mjs",
});

const HTML_NS = "http://www.w3.org/1999/xhtml";
export const PANEL_ID = "whimsyHiddenSpaces";
const FILTER_FROM = 6;
const EYE_SLASH = "chrome://browser/content/whimsy/icons/eye-slash.svg";

function spaceColor(space) {
  const rgb = space?.theme?.gradientColors?.[0]?.c;
  return Array.isArray(rgb) && rgb.length >= 3 ? `rgb(${rgb.slice(0, 3).join(" ")})` : null;
}

export const WhimsyHiddenSpaces = {
  PANEL_ID,

  enabled() {
    return Services.prefs.getBoolPref("whimsy.feature.archive-space", true);
  },

  hidden(win) {
    if (!this.enabled() || !win.gZenWorkspaces?.workspaceEnabled) {
      return [];
    }
    return lazy.WhimsySpaceArchive.listHidden(win);
  },

  tabCount(win, uuid) {
    return (win.gZenWorkspaces.allStoredTabs ?? win.gBrowser.tabs).filter(tab =>
      tab.getAttribute("zen-workspace-id") == uuid &&
      !tab.hasAttribute("zen-empty-tab") &&
      !tab.hasAttribute("zen-essential") &&
      !tab.closing).length;
  },

  activeSpace(win) {
    const { gZenWorkspaces } = win;
    return gZenWorkspaces.getWorkspaces().find(space => space.uuid == gZenWorkspaces.activeWorkspace) ?? null;
  },

  canHideCurrent(win) {
    const active = this.activeSpace(win);
    return !!active && !active.whimsyHidden && !active.whimsyScratch &&
      win.gZenWorkspaces.getWorkspaces().filter(space => !space.whimsyHidden && !space.whimsyScratch).length > 1;
  },

  isOpen(win) {
    return lazy.WhimsySurface.isOpen(win, PANEL_ID);
  },

  /**
   * Opens the panel. `at`: "beside-sidebar" (the command, the space menu,
   * Settings) or "page-top-center" (from the command bar).
   */
  open(win, { at = null, onHidden = null } = {}) {
    if (!this.enabled() || !win.gZenWorkspaces?.workspaceEnabled) {
      return null;
    }
    const doc = win.document;
    const S = lazy.WhimsySurface;
    let filterInput = null;
    const parts = S.create(win, {
      id: PANEL_ID,
      width: 380,
      titleL10nId: "whimsy-hidden-spaces-title",
      close: true,
      footer: true,
      className: "whimsy-hidden-spaces-panel",
      onHidden: () => onHidden?.(),
      onEscape: () => {
        if (filterInput?.value) {
          filterInput.value = "";
          this.filter(parts, "");
          return true;
        }
        return false;
      },
      initialFocus: () => filterInput ?? parts.view.querySelector("[role=option][tabindex='0']") ??
        parts.view.querySelector(".whimsy-hidden-spaces-empty button"),
    });
    const spaces = this.hidden(win);
    if (spaces.length >= FILTER_FROM) {
      const box = doc.createXULElement("hbox");
      box.className = "whimsy-surface-search whimsy-hidden-spaces-search";
      box.setAttribute("align", "center");
      const glass = doc.createXULElement("image");
      glass.className = "whimsy-sheet-search-icon";
      glass.setAttribute("src", "chrome://browser/skin/zen-icons/search-glass.svg");
      filterInput = doc.createElementNS(HTML_NS, "input");
      filterInput.type = "search";
      filterInput.className = "whimsy-hidden-spaces-filter";
      doc.l10n.setAttributes(filterInput, "whimsy-hidden-spaces-filter");
      filterInput.addEventListener("input", () => this.filter(parts, filterInput.value));
      filterInput.addEventListener("keydown", event => {
        // Down (or Return) from the field goes to the first match.
        if (event.key == "ArrowDown" || event.key == "Enter") {
          const first = this.visibleOptions(parts)[0];
          if (first) {
            event.preventDefault();
            if (event.key == "Enter") {
              this.unhideRow(win, parts, first);
            } else {
              this.focusOption(parts, first);
            }
          }
        }
      });
      box.append(glass, filterInput);
      parts.view.append(box);
    }
    if (spaces.length) {
      parts.view.append(this.buildList(win, parts, spaces));
    } else {
      parts.view.append(this.buildEmpty(win, parts));
    }
    if (spaces.length) {
      this.refreshFooter(win, parts);
    }
    S.open(win, parts.panel, { at: at ?? "beside-sidebar" });
    return parts;
  },

  /**
   * (Re)builds the footer's "Hide current space" button for the non-empty
   * list: at open() and again from unhideRow() once the active space has
   * changed. No button — and no footer bar at all — when hiding isn't
   * possible right now.
   */
  refreshFooter(win, parts) {
    const S = lazy.WhimsySurface;
    if (!parts.footer) {
      return;
    }
    parts.footer.replaceChildren();
    if (!this.canHideCurrent(win)) {
      if (parts.footer.isConnected) {
        parts.footer.remove();
      }
      return;
    }
    const doc = win.document;
    const active = this.activeSpace(win);
    parts.footer.append(S.footerButton(doc, {
      id: "whimsy-hidden-spaces-hide-current",
      l10nId: "whimsy-hidden-spaces-hide-current",
      l10nArgs: { space: active.name || "" },
      onCommand: () => {
        S.close(parts.panel);
        lazy.WhimsySpaceArchive.toggleHidden(win, active.uuid);
      },
    }));
    S.finish(parts);
  },

  buildList(win, parts, spaces) {
    const doc = win.document;
    const S = lazy.WhimsySurface;
    const list = doc.createElementNS(HTML_NS, "div");
    list.className = "whimsy-surface-listbox whimsy-hidden-spaces-list";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-labelledby", `${PANEL_ID}-title`);
    const manyProfiles = lazy.WhimsyProfiles.list().length > 1;
    spaces.forEach((space, index) => {
      const row = doc.createElementNS(HTML_NS, "div");
      row.className = "whimsy-surface-option whimsy-hidden-space";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", "false");
      row.dataset.uuid = space.uuid;
      row.dataset.name = (space.name || "").toLocaleLowerCase();
      row.tabIndex = index == 0 ? 0 : -1;
      // Zen's space icon is an emoji or an icon URL.
      const iconURL = /^[a-z-]+:\/\//.test(space.icon ?? "") ? space.icon : null;
      const tile = S.tile(doc, { icon: iconURL, text: iconURL ? null : (space.icon || (space.name || "?").slice(0, 1)) });
      const color = spaceColor(space);
      if (color) {
        tile.style.setProperty("--whimsy-tile-color", color);
      }
      const text = doc.createElementNS(HTML_NS, "div");
      text.className = "whimsy-hidden-space-text";
      const name = doc.createElementNS(HTML_NS, "span");
      name.className = "whimsy-hidden-space-name";
      name.id = `whimsy-hidden-space-${index}-name`;
      name.textContent = space.name || "";
      const detail = doc.createElementNS(HTML_NS, "span");
      detail.className = "whimsy-surface-option-detail whimsy-hidden-space-detail";
      const count = this.tabCount(win, space.uuid);
      if (manyProfiles) {
        const profile = lazy.WhimsyProfiles.nameOf(lazy.WhimsyProfiles.profileIdOfSpace(space));
        doc.l10n.setAttributes(detail, "whimsy-hidden-space-detail-profile", { count, profile });
      } else {
        doc.l10n.setAttributes(detail, "whimsy-hidden-space-detail", { count });
      }
      text.append(name, detail);
      row.append(tile, text);
      row.setAttribute("aria-labelledby", name.id);
      if (space.whimsyLocked) {
        row.append(S.pill(doc, { l10nId: "whimsy-hidden-space-locked" }));
        row.toggleAttribute("locked", true);
      } else {
        row.append(this.unhidePill(doc));
      }
      row.addEventListener("click", () => this.unhideRow(win, parts, row));
      row.addEventListener("keydown", event => {
        if (event.key == "Enter" || event.key == " ") {
          event.preventDefault();
          this.unhideRow(win, parts, row);
        } else if (filterKey(event)) {
          // Typing on a row goes to the filter, when there is one.
          const input = parts.view.querySelector(".whimsy-hidden-spaces-filter");
          if (input) {
            input.focus();
          }
        }
      });
      row.addEventListener("focus", () => {
        for (const option of list.querySelectorAll("[role=option]")) {
          option.setAttribute("aria-selected", option == row ? "true" : "false");
        }
      });
      list.append(row);
    });
    return list;
  },

  /** The always-visible "Unhide" pill (Wave 13 design, Option B): the same
   * trailing slot as the Locked pill, aria-hidden and not a tab stop — the
   * row's click/Enter/Space is the only trigger, unchanged. */
  unhidePill(doc) {
    const pill = doc.createElementNS(HTML_NS, "span");
    pill.className = "whimsy-surface-pill whimsy-hidden-space-unhide";
    pill.setAttribute("aria-hidden", "true");
    const icon = doc.createXULElement("image");
    icon.className = "whimsy-hidden-space-unhide-icon";
    icon.setAttribute("src", "chrome://browser/skin/zen-icons/selectable/eye.svg");
    const label = doc.createElementNS(HTML_NS, "span");
    doc.l10n.setAttributes(label, "whimsy-hidden-space-unhide");
    pill.append(icon, label);
    return pill;
  },

  /**
   * Row click/Return: unhides (and switches to) the space, then updates
   * the open panel instead of closing it (W14-B5) — the row leaves the
   * list, focus moves to its neighbour (the previous one if it was last),
   * and the empty state takes over once the last hidden space is gone.
   * An unlock that's cancelled (show() returning false) leaves the row
   * and the panel exactly as they were.
   */
  async unhideRow(win, parts, row) {
    const ok = await this.show(win, row.dataset.uuid);
    if (!ok || !row.isConnected) {
      return;
    }
    const list = row.closest(".whimsy-hidden-spaces-list");
    const rows = [...list.querySelectorAll(".whimsy-hidden-space")];
    const index = rows.indexOf(row);
    row.remove();
    const remaining = rows.filter(option => option != row);
    if (!remaining.length) {
      parts.view.querySelector(".whimsy-hidden-spaces-search")?.remove();
      list.replaceWith(this.buildEmpty(win, parts));
      if (parts.footer?.isConnected) {
        parts.footer.remove();
      }
      return;
    }
    this.focusOption(parts, remaining[Math.min(index, remaining.length - 1)]);
    this.refreshFooter(win, parts);
  },

  buildEmpty(win, parts) {
    const doc = win.document;
    const S = lazy.WhimsySurface;
    const box = doc.createXULElement("vbox");
    box.className = "whimsy-hidden-spaces-empty";
    box.setAttribute("align", "center");
    box.append(S.tile(doc, { icon: EYE_SLASH }), S.empty(doc, {
      l10nId: "whimsy-hidden-spaces-none",
      hintL10nId: "whimsy-hidden-spaces-none-hint",
    }));
    if (this.canHideCurrent(win)) {
      const active = this.activeSpace(win);
      const button = S.footerButton(doc, {
        id: "whimsy-hidden-spaces-empty-hide",
        l10nId: "whimsy-hidden-spaces-hide-current",
        l10nArgs: { space: active.name || "" },
        onCommand: () => {
          S.close(parts.panel);
          lazy.WhimsySpaceArchive.toggleHidden(win, active.uuid);
        },
      });
      button.setAttribute("tabindex", "0");
      box.append(button);
    }
    return box;
  },

  visibleOptions(parts) {
    return [...parts.view.querySelectorAll(".whimsy-hidden-space")].filter(row => !row.hidden);
  },

  focusOption(parts, row) {
    for (const option of parts.view.querySelectorAll(".whimsy-hidden-space")) {
      option.tabIndex = option == row ? 0 : -1;
    }
    row.focus();
  },

  filter(parts, text) {
    const query = text.trim().toLocaleLowerCase();
    let first = null;
    for (const row of parts.view.querySelectorAll(".whimsy-hidden-space")) {
      row.hidden = !!query && !row.dataset.name.includes(query);
      if (!row.hidden && !first) {
        first = row;
      }
      row.tabIndex = -1;
    }
    first?.setAttribute("tabindex", "0");
  },

  /**
   * Shows a hidden space again and switches to it. A locked space unlocks
   * first (WhimsySpaceLock.ensureUnlocked); if that's cancelled nothing changes.
   */
  async show(win, uuid) {
    const { gZenWorkspaces } = win;
    const space = gZenWorkspaces.getWorkspaces().find(w => w.uuid == uuid);
    if (!space?.whimsyHidden) {
      return false;
    }
    // W14-B5: the panel stays open — unhideRow() (the caller) updates the
    // row/list once this resolves. Only the ✕, Esc and the footer buttons
    // still close it.
    const before = gZenWorkspaces.activeWorkspace;
    if (!(await lazy.WhimsySpaceLock.ensureUnlocked(win, space))) {
      return false; // The unlock was cancelled.
    }
    await gZenWorkspaces.changeWorkspaceWithID(uuid);
    if (gZenWorkspaces.activeWorkspace != uuid) {
      return false; // The unlock was cancelled.
    }
    delete space.whimsyHidden;
    gZenWorkspaces.saveWorkspace(space);
    lazy.WhimsySpaceArchive.applyHidden(win);
    lazy.WhimsyUndo.showToast(win, "whimsy-hidden-space-shown-toast", {
      type: "show-space",
      undo: async () => {
        const again = gZenWorkspaces.getWorkspaces().find(w => w.uuid == uuid);
        if (!again || again.whimsyHidden) {
          return;
        }
        if (gZenWorkspaces.activeWorkspace == uuid && before != uuid &&
            gZenWorkspaces.getWorkspaces().some(w => w.uuid == before)) {
          await gZenWorkspaces.changeWorkspaceWithID(before);
        }
        again.whimsyHidden = true;
        gZenWorkspaces.saveWorkspace(again);
        lazy.WhimsySpaceArchive.applyHidden(win);
      },
      redo: null,
    }, { space: space.name || "" });
    return true;
  },
};

// A printable key with no modifier: starts filtering.
function filterKey(event) {
  return event.key.length == 1 && event.key != " " && !event.ctrlKey && !event.metaKey && !event.altKey;
}
