/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W13 ctrltab (option B): Firefox's own Ctrl+Tab panel, restyled as one
// rounded Whimsy card. Firefox's browser-ctrlTab.js and ctrlTab.css stay
// as they are; the look is CSS (whimsy-browser.css, scoped to
// #ctrlTab-panel[whimsy-look]) and the three behaviour changes are small
// wrappers on the window's `ctrlTab` object:
//
// - rows of four: `previewsPerRow` reads 4 (Firefox: 7);
// - thumbnails capped at 200px: Firefox still computes `canvasWidth` from
//   the screen in open(); the setter caps what it stores, so
//   `canvasHeight` and every image follow the capped size;
// - the card's real size, centred: Firefox opens the panel at
//   canvasWidth × 1.25 per column, which isn't the card's width. For the
//   one openPopupAtScreen call inside Firefox's _openPanel, Whimsy passes
//   the card's own width and the screen-centred position instead, so the
//   panel opens once, in place;
// - the space badge: an updatePreview wrapper (installed like
//   WhimsyPrivateLock.guardPreviews; each wraps whatever is there and
//   calls through first, so they compose in any order) marks a tab from
//   another space with that space's name and colour.
//
// browser.ctrlTab.maxPreviews = 12 comes from the generated
// prefs/whimsy/features.yaml (whimsy/overlay.py). Everything here checks
// whimsy.feature.ctrl-tab on each open, so switching it off gives back
// Firefox's panel exactly.

const FEATURE_PREF = "whimsy.feature.ctrl-tab";
const PER_ROW = 4;
export const MAX_THUMB_WIDTH = 200;
// The card's geometry (whimsy-browser.css): tile padding 6, gap 4 between
// tiles, card padding 8, a 1px border; under each thumbnail a 7px gap and
// a 17px favicon-and-title row.
const TILE_PAD = 6;
const GAP = 4;
const CARD_PAD = 8;
const BORDER = 1;
const LABEL_ROW = 17 + 7;
export const LOOK_ATTR = "whimsy-look";
export const SPACE_NAME_ATTR = "whimsy-space-name";

function spaceColor(space) {
  const rgb = space?.theme?.gradientColors?.[0]?.c;
  return Array.isArray(rgb) && rgb.length >= 3 ? `rgb(${rgb.slice(0, 3).join(" ")})` : null;
}

export const WhimsyCtrlTab = {
  PER_ROW,
  MAX_THUMB_WIDTH,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  initWindow(win) {
    const ctrlTab = win.ctrlTab;
    if (!ctrlTab || ctrlTab._whimsyLook) {
      return;
    }
    ctrlTab._whimsyLook = true;
    const self = this;

    // Rows of four.
    const firefoxPerRow = ctrlTab.previewsPerRow;
    Object.defineProperty(ctrlTab, "previewsPerRow", {
      configurable: true,
      enumerable: true,
      get() {
        return self.enabled ? PER_ROW : firefoxPerRow;
      },
    });

    // Thumbnails at most 200px wide.
    let canvasWidth = ctrlTab.canvasWidth;
    Object.defineProperty(ctrlTab, "canvasWidth", {
      configurable: true,
      enumerable: true,
      get() {
        return canvasWidth;
      },
      set(value) {
        canvasWidth = self.enabled ? Math.min(value, MAX_THUMB_WIDTH) : value;
      },
    });

    // The card's own size, centred on the screen, for Firefox's one
    // openPopupAtScreen call.
    const openPanel = ctrlTab._openPanel;
    ctrlTab._openPanel = function () {
      const panel = this.panel;
      const on = self.enabled;
      panel.toggleAttribute(LOOK_ATTR, on);
      if (!on) {
        panel.style.removeProperty("--panel-width");
        return openPanel.apply(this, arguments);
      }
      const { width, height } = self.cardSize(this);
      panel.openPopupAtScreen = function (x, y, ...rest) {
        delete panel.openPopupAtScreen;
        // The card's width goes on the panel's content box (popup.css:
        // ::part(content) is var(--panel-width) wide, border-box); the
        // panel itself then fits it plus the room for the shadow.
        panel.style.removeProperty("width");
        panel.style.setProperty("--panel-width", `${width}px`);
        const screen = win.screen;
        return panel.openPopupAtScreen(
          Math.round(screen.availLeft + (screen.availWidth - width) / 2),
          Math.round(screen.availTop + (screen.availHeight - height) / 2),
          ...rest
        );
      };
      try {
        return openPanel.apply(this, arguments);
      } finally {
        // Firefox's own method again, whatever happened.
        if (Object.hasOwn(panel, "openPopupAtScreen")) {
          delete panel.openPopupAtScreen;
        }
      }
    };

    // The space badge.
    const updatePreview = ctrlTab.updatePreview;
    ctrlTab.updatePreview = function (preview, tab) {
      const result = updatePreview.apply(this, arguments);
      try {
        self.badge(win, preview, tab);
      } catch (e) {
        console.error("Whimsy: Ctrl+Tab space badge", e);
      }
      return result;
    };
    // Keep the private lock's marker reachable for anything that checks it.
    ctrlTab.updatePreview._whimsyLock = updatePreview._whimsyLock;
    ctrlTab.updatePreview._whimsySpaceBadge = true;
  },

  /** The card's width and height for the previews about to show. */
  cardSize(ctrlTab) {
    const columns = Math.max(1, ctrlTab.previewColumnCount);
    const rows = Math.max(1, Math.ceil(ctrlTab.tabPreviewCount / ctrlTab.previewsPerRow));
    const chrome = 2 * (CARD_PAD + BORDER);
    const width = columns * (ctrlTab.canvasWidth + 2 * TILE_PAD) + (columns - 1) * GAP + chrome;
    let height = rows * (ctrlTab.canvasHeight + 2 * TILE_PAD + LABEL_ROW) + (rows - 1) * GAP + chrome;
    // Firefox's "List All Tabs" button, when the toolbar's all-tabs button
    // is there to back it (Zen hides it).
    if (ctrlTab.showAllButton && !ctrlTab.showAllButton.hidden) {
      height += 40;
    }
    return { width: Math.round(width), height: Math.round(height) };
  },

  /** The tab's space when it isn't the active one, else null. */
  otherSpace(win, tab) {
    const spaces = win.gZenWorkspaces;
    if (!tab || !spaces || tab.hasAttribute("zen-essential")) {
      return null;
    }
    const id = tab.getAttribute("zen-workspace-id");
    if (!id || id == spaces.activeWorkspace) {
      return null;
    }
    return spaces.getWorkspaceFromId?.(id) ?? null;
  },

  badge(win, preview, tab) {
    const canvas = preview?._canvas;
    if (!canvas) {
      return;
    }
    const space = this.enabled ? this.otherSpace(win, tab) : null;
    if (!space?.name) {
      canvas.removeAttribute(SPACE_NAME_ATTR);
      canvas.style.removeProperty("--whimsy-space-color");
      return;
    }
    canvas.setAttribute(SPACE_NAME_ATTR, space.name);
    const color = spaceColor(space);
    if (color) {
      canvas.style.setProperty("--whimsy-space-color", color);
    } else {
      canvas.style.removeProperty("--whimsy-space-color");
    }
  },
};
