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
// - W14 21.8 (design/ctrltab option A): every space's tabs, Essentials and
//   pinned ones too, newest first, kept across space switches (Zen rebuilds
//   the list from the current space on each switch); never a hidden or
//   locked space's tabs, glance or empty tabs, and private and other tabs
//   never together (Arc keeps incognito tabs to their window). The card shows 12 (three rows); pressing Tab past
//   them scrolls the grid a row at a time, with a fade at the bottom and
//   "13 of 31" under it.
//
// Everything here checks whimsy.feature.ctrl-tab on each open, so switching
// it off gives back Firefox's panel exactly.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsySpaceArchive: "resource:///modules/whimsy/WhimsySpaceArchive.sys.mjs",
  WhimsySpaceLock: "resource:///modules/whimsy/WhimsySpaceLock.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.ctrl-tab";
const PER_ROW = 4;
export const VISIBLE_ROWS = 3;
const FOOT_HEIGHT = 22;
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
export const MORE_ATTR = "whimsy-more";
const FOOT_ID = "whimsy-ctrltab-foot";
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

    // A tile for every tab in the list (the card shows three rows of them).
    Object.defineProperty(ctrlTab, "maxTabPreviews", {
      configurable: true,
      enumerable: true,
      get() {
        if (!self.enabled) {
          return Math.max(4, Math.min(49, Services.prefs.getIntPref("browser.ctrlTab.maxPreviews", 7)));
        }
        return Math.max(PER_ROW * VISIBLE_ROWS, this._recentlyUsedTabs ? this.tabCount : 0);
      },
    });

    // Every space's tabs, newest first.
    const initRecentlyUsedTabs = ctrlTab._initRecentlyUsedTabs;
    ctrlTab._initRecentlyUsedTabs = function () {
      if (!self.enabled) {
        return initRecentlyUsedTabs.apply(this, arguments);
      }
      this._recentlyUsedTabs = self.allTabs(win);
      this._sortRecentlyUsedTabs();
      return undefined;
    };
    const attachTab = ctrlTab.attachTab;
    ctrlTab.attachTab = function (tab) {
      if (self.enabled && !self.eligible(win, tab)) {
        return undefined;
      }
      return attachTab.apply(this, arguments);
    };
    const open = ctrlTab.open;
    ctrlTab.open = function () {
      if (self.enabled && this._recentlyUsedTabs) {
        // A space's lock or hiding can change between opens.
        this._recentlyUsedTabs = this._recentlyUsedTabs.filter(tab => self.eligible(win, tab));
        this._sortRecentlyUsedTabs();
      }
      const result = open.apply(this, arguments);
      this._whimsyFirstRow = 0;
      this.previewsContainer.scrollTop = 0;
      return result;
    };
    // Firefox opens the card only with three tabs showing in the tab strip;
    // the list (every space) is what counts.
    const onKeyDown = ctrlTab.onKeyDown;
    ctrlTab.onKeyDown = function (event) {
      if (
        !self.enabled ||
        this.isOpen ||
        event.shiftKey ||
        win.ShortcutUtils.getSystemActionForEvent(event) != win.ShortcutUtils.CYCLE_TABS ||
        event.defaultPrevented ||
        this.KeyboardLockUtils.mustWaitForKeyboardLockRequestedReply(event)
      ) {
        return onKeyDown.apply(this, arguments);
      }
      event.preventDefault();
      event.stopPropagation();
      win.document.addEventListener("keyup", this, { mozSystemGroup: true });
      const tabs = this.tabList;
      if (tabs.length > 2) {
        this.open();
      } else if (tabs.length == 2) {
        win.gBrowser.setSelectedTab(
          tabs[0].selected ? tabs[1] : tabs[0],
          win.gBrowser.TabMetrics.userTriggeredContext(win.gBrowser.TabMetrics.METRIC_SOURCE.CTRL_TAB)
        );
      }
      return undefined;
    };
    // Keep the selection in view, a row at a time.
    for (const name of ["advanceFocus", "setupGUI"]) {
      const original = ctrlTab[name];
      ctrlTab[name] = function () {
        const result = original.apply(this, arguments);
        if (self.enabled) {
          self.reveal(this);
        }
        return result;
      };
    }
    ctrlTab.previewsContainer.addEventListener("scroll", () => {
      // The wheel moves the rows too; the next Tab carries on from there.
      ctrlTab._whimsyFirstRow = Math.round(ctrlTab.previewsContainer.scrollTop / self.rowPitch(ctrlTab));
      self.updateMore(ctrlTab);
    }, { passive: true });
    if (ctrlTab._recentlyUsedTabs && this.enabled) {
      ctrlTab._initRecentlyUsedTabs();
    }

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
        self.layoutGrid(this);
        return openPanel.apply(this, arguments);
      }
      const { width, height } = self.cardSize(this);
      self.layoutGrid(this);
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

  /** Whether `tab` belongs in the list: see the header. */
  eligible(win, tab) {
    if (!tab || tab.closing || tab.hasAttribute("zen-empty-tab") || tab.hasAttribute("zen-glance-tab")) {
      return false;
    }
    if (tab.hidden && !tab.selected) {
      return false;
    }
    const spaces = win.gZenWorkspaces;
    const id = tab.getAttribute("zen-workspace-id");
    if (id && spaces && !tab.hasAttribute("zen-essential") && id != spaces.activeWorkspace) {
      if (!lazy.WhimsySpaceArchive.navigableSpaces(win).some(space => space.uuid == id)) {
        return false;
      }
    }
    if (lazy.WhimsySpaceLock.coveringSpace(tab) && !tab.selected) {
      return false;
    }
    if (!lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      const isPrivate = t => {
        try {
          return lazy.PrivateBrowsingUtils.isBrowserPrivate(t.linkedBrowser);
        } catch (e) {
          return false;
        }
      };
      // Like Arc's incognito windows: from a private tab only private tabs,
      // from any other tab no private ones, whatever space they're in.
      if (isPrivate(tab) != isPrivate(win.gBrowser.selectedTab)) {
        return false;
      }
    }
    return true;
  },

  allTabs(win) {
    const all = win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs;
    return [...new Set(all)].filter(tab => this.eligible(win, tab));
  },

  rowPitch(ctrlTab) {
    return ctrlTab.canvasHeight + 2 * TILE_PAD + LABEL_ROW + GAP;
  },

  /** Three rows of tiles show; the rest scroll. The foot counts them. */
  layoutGrid(ctrlTab) {
    const container = ctrlTab.previewsContainer;
    const more = this.enabled && ctrlTab.tabPreviewCount > PER_ROW * VISIBLE_ROWS;
    if (more) {
      container.style.setProperty("--whimsy-ctrltab-grid-height", `${VISIBLE_ROWS * this.rowPitch(ctrlTab) - GAP}px`);
    } else {
      container.style.removeProperty("--whimsy-ctrltab-grid-height");
    }
    this.foot(ctrlTab).hidden = !more;
    ctrlTab._whimsyFirstRow = 0;
    container.scrollTop = 0;
    this.updateMore(ctrlTab);
  },

  foot(ctrlTab) {
    const doc = ctrlTab.panel.ownerDocument;
    let foot = doc.getElementById(FOOT_ID);
    if (!foot) {
      foot = doc.createXULElement("hbox");
      foot.id = FOOT_ID;
      foot.setAttribute("align", "center");
      foot.hidden = true;
      const title = doc.createXULElement("label");
      title.className = "whimsy-ctrltab-title";
      title.setAttribute("crop", "end");
      title.setAttribute("flex", "1");
      const count = doc.createXULElement("label");
      count.className = "whimsy-ctrltab-count";
      foot.append(title, count);
      ctrlTab.previewsContainer.after(foot);
    }
    return foot;
  },

  /** Scrolls so the selected tile's row shows, moving a row at a time. */
  reveal(ctrlTab) {
    const container = ctrlTab.previewsContainer;
    const selected = ctrlTab.selected;
    const index = ctrlTab.previews.indexOf(selected);
    if (index < 0 || selected == ctrlTab.showAllButton) {
      return;
    }
    const foot = this.foot(ctrlTab);
    if (!foot.hidden) {
      const pitch = this.rowPitch(ctrlTab);
      const row = Math.floor(index / PER_ROW);
      // Not from scrollTop: focusing a tile has already scrolled it into view.
      let first = ctrlTab._whimsyFirstRow ?? 0;
      if (row < first) {
        first = row;
      } else if (row > first + VISIBLE_ROWS - 1) {
        first = row - VISIBLE_ROWS + 1;
      }
      ctrlTab._whimsyFirstRow = first;
      container.scrollTop = first * pitch;
      foot.querySelector(".whimsy-ctrltab-title").setAttribute("value", selected._tab?.label ?? "");
      ctrlTab.panel.ownerDocument.l10n.setAttributes(foot.querySelector(".whimsy-ctrltab-count"), "whimsy-ctrltab-position", {
        index: index + 1,
        count: ctrlTab.tabCount,
      });
    }
    this.updateMore(ctrlTab);
  },

  /** The bottom fade while rows are below. */
  updateMore(ctrlTab) {
    const container = ctrlTab.previewsContainer;
    const below = this.enabled && container.scrollHeight - container.clientHeight - container.scrollTop > 2;
    container.toggleAttribute(MORE_ATTR, below);
  },

  /** The card's width and height for the previews about to show. */
  cardSize(ctrlTab) {
    const columns = Math.max(1, ctrlTab.previewColumnCount);
    const allRows = Math.max(1, Math.ceil(ctrlTab.tabPreviewCount / ctrlTab.previewsPerRow));
    const rows = Math.min(allRows, VISIBLE_ROWS);
    const chrome = 2 * (CARD_PAD + BORDER);
    const width = columns * (ctrlTab.canvasWidth + 2 * TILE_PAD) + (columns - 1) * GAP + chrome;
    let height = rows * (ctrlTab.canvasHeight + 2 * TILE_PAD + LABEL_ROW) + (rows - 1) * GAP + chrome;
    if (allRows > VISIBLE_ROWS) {
      height += FOOT_HEIGHT;
    }
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
