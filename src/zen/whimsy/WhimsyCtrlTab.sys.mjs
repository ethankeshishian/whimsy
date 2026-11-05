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
// - W16-8: with hundreds of tabs it opened slowly (a tile and a thumbnail
//   for every tab). The grid is a fixed pool of 20 tiles (five rows) over
//   the list, with spacers above and below that keep the scroll height
//   true; scrolling or Tab past the pool's rows moves it a row and fills
//   it again. Selection is a tab index mapped to a tile.
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
// W16-8: the tiles that exist, five rows: the three in view and one each
// side.
export const POOL_ROWS = VISIBLE_ROWS + 2;
export const POOL_SIZE = PER_ROW * POOL_ROWS;
const SPACER_CLASS = "whimsy-ctrltab-spacer";
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

    // W16-8: a fixed pool of tiles (the card shows three rows of them).
    Object.defineProperty(ctrlTab, "maxTabPreviews", {
      configurable: true,
      enumerable: true,
      get() {
        if (!self.enabled) {
          return Math.max(4, Math.min(49, Services.prefs.getIntPref("browser.ctrlTab.maxPreviews", 7)));
        }
        return POOL_SIZE;
      },
    });
    ctrlTab._whimsyBase = 0;
    // The spacers above and below the pool.
    const buildPreviews = ctrlTab._buildPreviews;
    ctrlTab._buildPreviews = function () {
      const result = buildPreviews.apply(this, arguments);
      const doc = win.document;
      for (const where of ["before", "after"]) {
        const spacer = doc.createXULElement("box");
        spacer.className = SPACER_CLASS;
        spacer.hidden = true;
        this.previewsContainer[where == "before" ? "prepend" : "append"](spacer);
      }
      return result;
    };
    // The pool, filled from the list once (Firefox's reads tabList, which
    // filters every tab, for each tile).
    const updatePreviews = ctrlTab.updatePreviews;
    ctrlTab.updatePreviews = function () {
      if (!self.enabled) {
        return updatePreviews.apply(this, arguments);
      }
      self.fillPool(win, this);
      return undefined;
    };
    // The selection, by tab index.
    const advanceFocus = ctrlTab.advanceFocus;
    ctrlTab.advanceFocus = function (forward) {
      if (!self.enabled) {
        return advanceFocus.apply(this, arguments);
      }
      return self.advance(win, this, forward);
    };

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
      this._whimsyBase = 0;
      if (self.enabled && this._recentlyUsedTabs) {
        // A space's lock or hiding can change between opens.
        const navigable = self.navigableIds(win);
        this._recentlyUsedTabs = this._recentlyUsedTabs.filter(tab => self.eligible(win, tab, navigable));
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
      if (self.enabled && ctrlTab.isOpen) {
        self.ensurePool(win, ctrlTab, ctrlTab._whimsyFirstRow);
      }
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

  // W16-8: the spaces whose tabs may show, worked out once per pass.
  navigableIds(win) {
    try {
      return new Set(lazy.WhimsySpaceArchive.navigableSpaces(win).map(space => space.uuid));
    } catch (e) {
      return null;
    }
  },

  /** Whether `tab` belongs in the list: see the header. */
  eligible(win, tab, navigable = null) {
    if (!tab || tab.closing || tab.hasAttribute("zen-empty-tab") || tab.hasAttribute("zen-glance-tab")) {
      return false;
    }
    if (tab.hidden && !tab.selected) {
      return false;
    }
    const spaces = win.gZenWorkspaces;
    const id = tab.getAttribute("zen-workspace-id");
    if (id && spaces && !tab.hasAttribute("zen-essential") && id != spaces.activeWorkspace) {
      if (navigable ? !navigable.has(id) : !lazy.WhimsySpaceArchive.navigableSpaces(win).some(space => space.uuid == id)) {
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
    const navigable = this.navigableIds(win);
    return [...new Set(all)].filter(tab => this.eligible(win, tab, navigable));
  },

  // W16-8: the pool's tiles show tabList[base …]; the spacers stand in for
  // the rows above and below it.
  fillPool(win, ctrlTab, list = ctrlTab.tabList) {
    const container = ctrlTab.previewsContainer;
    container.style.setProperty("--ctrlTab-previews-per-row", ctrlTab.previewColumnCount);
    const base = ctrlTab._whimsyBase ?? 0;
    for (let i = 0; i < ctrlTab.previews.length; i++) {
      const preview = ctrlTab.previews[i];
      if (preview == ctrlTab.showAllButton) {
        continue;
      }
      ctrlTab.updatePreview(preview, list[base + i]);
    }
    const pitch = this.rowPitch(ctrlTab);
    const totalRows = Math.ceil(list.length / PER_ROW);
    const above = base / PER_ROW;
    const below = Math.max(0, totalRows - above - POOL_ROWS);
    const [lead, trail] = [container.firstElementChild, container.lastElementChild];
    for (const [spacer, rows] of [[lead, above], [trail, below]]) {
      if (spacer?.classList.contains(SPACER_CLASS)) {
        spacer.hidden = !rows;
        spacer.style.height = rows ? `${rows * pitch - GAP}px` : "";
      }
    }
    win.document.l10n.setAttributes(ctrlTab.showAllButton, "tabbrowser-ctrl-tab-list-all-tabs", { tabCount: list.length });
    ctrlTab.showAllButton.hidden = !win.gTabsPanel?.canOpen;
  },

  /** The tab index the selected tile shows (the list's length for List All Tabs). */
  selectedIndex(ctrlTab) {
    const selected = ctrlTab.selected;
    if (selected == ctrlTab.showAllButton) {
      return ctrlTab.tabCount;
    }
    const tile = ctrlTab.previews.indexOf(selected);
    return tile < 0 ? 0 : (ctrlTab._whimsyBase ?? 0) + tile;
  },

  // The first row in view once tab `index` is revealed (see reveal()).
  firstRowFor(ctrlTab, index) {
    const row = Math.floor(index / PER_ROW);
    let first = ctrlTab._whimsyFirstRow ?? 0;
    if (row < first) {
      first = row;
    } else if (row > first + VISIBLE_ROWS - 1) {
      first = row - VISIBLE_ROWS + 1;
    }
    return first;
  },

  /**
   * Moves the pool so it covers rows `first` … first + 2, keeping the
   * selected tab selected. Returns whether it moved.
   */
  ensurePool(win, ctrlTab, first) {
    const baseRow = (ctrlTab._whimsyBase ?? 0) / PER_ROW;
    if (first >= baseRow && first + VISIBLE_ROWS - 1 <= baseRow + POOL_ROWS - 1) {
      return false;
    }
    const list = ctrlTab.tabList;
    const totalRows = Math.ceil(list.length / PER_ROW);
    const newBaseRow = Math.max(0, Math.min(first - 1, totalRows - POOL_ROWS));
    if (newBaseRow == baseRow) {
      return false;
    }
    const selectedTab = ctrlTab.selected?._tab ?? null;
    const focused = ctrlTab._selectedIndex == -1;
    ctrlTab._whimsyBase = newBaseRow * PER_ROW;
    this.fillPool(win, ctrlTab, list);
    let tile = selectedTab ? ctrlTab.previews.find(p => p._tab == selectedTab && !p.hidden) : null;
    if (!tile) {
      // The wheel took the selection out of the pool: the nearest tile in view.
      tile = ctrlTab.previews[Math.max(0, Math.min(first * PER_ROW - ctrlTab._whimsyBase, ctrlTab.previews.length - 2))];
    }
    if (tile) {
      if (focused) {
        tile.focus({ preventScroll: true });
      } else {
        ctrlTab._selectedIndex = ctrlTab.previews.indexOf(tile);
      }
    }
    return true;
  },

  // Tab and Shift+Tab: the next or previous tab in the list, wrapping (with
  // List All Tabs when it shows), the pool moving with it.
  advance(win, ctrlTab, forward) {
    const count = ctrlTab.tabCount;
    const showAll = !ctrlTab.showAllButton.hidden;
    const total = count + (showAll ? 1 : 0);
    if (!total) {
      return;
    }
    const index = (this.selectedIndex(ctrlTab) + (forward ? 1 : -1) + total) % total;
    let target = ctrlTab.showAllButton;
    if (index < count) {
      this.ensurePool(win, ctrlTab, this.firstRowFor(ctrlTab, index));
      target = ctrlTab.previews[index - ctrlTab._whimsyBase];
    }
    if (!target) {
      return;
    }
    if (ctrlTab._selectedIndex == -1) {
      target.focus({ preventScroll: true });
    } else {
      ctrlTab._selectedIndex = ctrlTab.previews.indexOf(target);
    }
    if (target._tab) {
      win.gBrowser.warmupTab(target._tab);
    }
    if (ctrlTab._timer) {
      win.clearTimeout(ctrlTab._timer);
      ctrlTab._timer = null;
      ctrlTab._openPanel();
    }
  },

  rowPitch(ctrlTab) {
    return ctrlTab.canvasHeight + 2 * TILE_PAD + LABEL_ROW + GAP;
  },

  /** Three rows of tiles show; the rest scroll. The foot counts them. */
  layoutGrid(ctrlTab) {
    const container = ctrlTab.previewsContainer;
    const more = this.enabled && ctrlTab.tabCount > PER_ROW * VISIBLE_ROWS;
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
    if (ctrlTab.previews.indexOf(selected) < 0 || selected == ctrlTab.showAllButton) {
      return;
    }
    const index = this.selectedIndex(ctrlTab);
    const foot = this.foot(ctrlTab);
    if (!foot.hidden) {
      const pitch = this.rowPitch(ctrlTab);
      // Not from scrollTop: focusing a tile has already scrolled it into view.
      const first = this.firstRowFor(ctrlTab, index);
      ctrlTab._whimsyFirstRow = first;
      container.scrollTop = first * pitch;
      foot.querySelector(".whimsy-ctrltab-title").setAttribute("value", selected._tab?.label ?? "");
      // W16-21: formatted here and set as text (the newest result only):
      // a Fluent attribute update drew the label empty for a frame on some
      // Tab presses.
      const count = foot.querySelector(".whimsy-ctrltab-count");
      const token = (ctrlTab._whimsyCountToken = (ctrlTab._whimsyCountToken ?? 0) + 1);
      ctrlTab.panel.ownerDocument.l10n
        .formatValue("whimsy-ctrltab-position", { index: index + 1, count: ctrlTab.tabCount })
        .then(text => {
          if (token == ctrlTab._whimsyCountToken) {
            count.textContent = text;
          }
        })
        .catch(e => console.error("Whimsy: Ctrl+Tab count", e));
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
    const allRows = Math.max(1, Math.ceil(ctrlTab.tabCount / ctrlTab.previewsPerRow));
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
