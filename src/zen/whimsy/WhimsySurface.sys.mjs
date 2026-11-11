/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave10 design pass A: one surface for Whimsy's feature UI.
//
// The Edit Space Look overlay (WhimsySpaceLook) is the reference the user
// praised, with Zen's Theme picker: an arrowless 12px panel with 10px
// padding, a start-aligned 13px/600 title, grouped rows on a quiet track, a
// sliding segmented control, and Zen's footer buttons with one primary.
// This module generalises it so every feature surface (paste guard, the
// font card, the page tools, the cheat sheet, the easel picker, Fire,
// Trails, the form-unload prompt, This Site's dropdowns) is the same thing:
//
//   <panel class="whimsy-surface" type="arrow" hidepopovertail orient=vertical
//          role=dialog noautofocus aria-labelledby="<id>-title">
//     vbox.whimsy-surface-view
//       hbox.whimsy-surface-header      optional: h1 title + close button
//       ...content parts (group, row, caption, seg, switch, tile, pill, ...)
//       hbox.whimsy-surface-footer      optional: footer buttons, one primary
//
// No native menupopup, no arrow tail, no <toolbarseparator> (a separator in
// a horizontal box draws as a full-height line at the left edge: W10-24).
// Keyboard: Esc closes (also while focus is still in the page), Tab cycles
// inside, arrow keys move within radiogroups, listboxes, grids and segmented
// controls. Motion is Firefox's panel animation, which honours reduced
// motion; colours come from Zen's panel variables and light-dark(), so it
// follows light, dark and space themes.

const HTML_NS = "http://www.w3.org/1999/xhtml";

const FOCUSABLE =
  "toolbarbutton:not([disabled]):not([hidden]), button:not([disabled]):not([hidden]), " +
  "input:not([disabled]):not([hidden]), textarea:not([disabled]), select:not([disabled]), " +
  "a[href], [tabindex='0']:not([hidden]):not([disabled])";

const COPIED_MS = 1200;

function visible(el) {
  return !!el && el.isConnected && el.getClientRects().length > 0 && !el.closest("[hidden]");
}

function setL10n(doc, el, l10nId, args) {
  if (l10nId) {
    doc.l10n.setAttributes(el, l10nId, args ?? undefined);
  }
}

function html(doc, tag, className) {
  const el = doc.createElementNS(HTML_NS, tag);
  if (className) {
    el.className = className;
  }
  return el;
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

// F07: where each draggable surface was left this session, and where it
// opened by itself, keyed by surface, relative to the window's content.
const dragPositions = new Map();
const DOUBLE_PRESS_MS = 500;
const dragHomes = new Map();

function relativeRect(win, panel) {
  const rect = panel.getOuterScreenRect();
  return { x: rect.left - win.mozInnerScreenX, y: rect.top - win.mozInnerScreenY, width: rect.width };
}

export const WhimsySurface = {
  COPIED_MS,

  /**
   * Builds (or rebuilds) a surface. The panel removes itself once hidden,
   * so every open starts fresh.
   *
   * @param {Window} win
   * @param {object} o
   * @param {string} o.id - the <panel>'s id
   * @param {number} [o.width] - px (default 380)
   * @param {string} [o.titleL10nId] / [o.title] - the heading; no header without one
   * @param {object} [o.titleArgs]
   * @param {boolean} [o.close] - a ✕ in the header
   * @param {boolean} [o.footer] - an (empty) footer
   * @param {boolean} [o.closeOnOutsideClick] - default true; false = noautohide
   * @param {string} [o.className] - extra class(es) on the panel
   * @param {Function} [o.onEscape] - return true when it handled Esc itself
   * @param {Function} [o.onShown]
   * @param {Function} [o.onHidden]
   * @param {Element|Function|false} [o.initialFocus] - focused on popupshown
   *   (false: keep focus where it is)
   */
  create(win, o) {
    const doc = win.document;
    doc.getElementById(o.id)?.remove();

    const panel = doc.createXULElement("panel");
    panel.id = o.id;
    panel.className = "whimsy-surface" + (o.className ? ` ${o.className}` : "");
    panel.setAttribute("type", "arrow");
    panel.setAttribute("hidepopovertail", "true");
    // A panel's content box is a row by default; without this a stray
    // child (or a separator) lays out sideways.
    panel.setAttribute("orient", "vertical");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("noautofocus", "true");
    if (o.closeOnOutsideClick === false) {
      panel.setAttribute("noautohide", "true");
    }
    panel.style.setProperty("--whimsy-surface-width", `${o.width ?? 380}px`);

    const view = doc.createXULElement("vbox");
    view.className = "whimsy-surface-view";
    panel.append(view);

    let header = null;
    let title = null;
    let close = null;
    if (o.titleL10nId || o.title || o.close) {
      header = doc.createXULElement("hbox");
      header.className = "whimsy-surface-header";
      header.setAttribute("align", "center");
      title = html(doc, "h1", "whimsy-surface-title");
      title.id = `${o.id}-title`;
      if (o.titleL10nId) {
        setL10n(doc, title, o.titleL10nId, o.titleArgs);
      } else if (o.title) {
        title.textContent = o.title;
      }
      header.append(title);
      if (o.close) {
        close = doc.createXULElement("toolbarbutton");
        close.className = "whimsy-sheet-icon-button whimsy-surface-close";
        close.setAttribute("image", "chrome://browser/skin/zen-icons/close.svg");
        close.setAttribute("tabindex", "0");
        setL10n(doc, close, "whimsy-surface-close");
        close.addEventListener("command", event => {
          event.stopPropagation();
          this.close(panel);
        });
        header.append(close);
      }
      view.append(header);
      panel.setAttribute("aria-labelledby", title.id);
    }

    let footer = null;
    if (o.footer) {
      footer = doc.createXULElement("hbox");
      footer.className = "panel-footer whimsy-surface-footer";
      footer.setAttribute("align", "center");
      footer.setAttribute("pack", "end");
      // Appended by the caller once the content is in (see finish()).
    }

    panel.addEventListener("keydown", event => this._onKeyDown(panel, event, o));
    const onWindowKey = event => {
      if (event.key != "Escape" || event.defaultPrevented || panel.state != "open") {
        return;
      }
      // A surface opened from a shortcut or the command bar: focus may
      // still be in the page. Only the topmost surface answers.
      const open = [...doc.querySelectorAll("panel.whimsy-surface")].filter(p => p.state == "open");
      if (open.at(-1) != panel) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!o.onEscape?.(event)) {
        this.close(panel);
      }
    };
    panel.addEventListener("popupshown", event => {
      if (event.target != panel) {
        return;
      }
      win.addEventListener("keydown", onWindowKey, true);
      // initialFocus: false (F04's capture card) leaves focus where it is.
      if (o.initialFocus !== false) {
        const initial = typeof o.initialFocus == "function" ? o.initialFocus() : o.initialFocus;
        const first = initial ?? footer?.querySelector("[default='true']") ?? this.focusables(view)[0];
        first?.focus({ focusVisible: false });
      }
      o.onShown?.();
    });
    panel.addEventListener("popuphidden", event => {
      if (event.target != panel) {
        return;
      }
      win.removeEventListener("keydown", onWindowKey, true);
      try {
        o.onHidden?.();
      } finally {
        panel.remove();
      }
    });

    (doc.getElementById("mainPopupSet") ?? doc.documentElement).append(panel);
    return { panel, view, header, title, close, footer };
  },

  /** Appends the footer last, after the caller filled the view. */
  finish(parts) {
    if (parts.footer && !parts.footer.isConnected) {
      parts.view.append(parts.footer);
    }
    return parts;
  },

  focusables(root) {
    // Roving items set tabindex="-1" on all but one; XUL controls report
    // no tabIndex of their own, so go by the attribute.
    return [...root.querySelectorAll(FOCUSABLE)].filter(el => visible(el) && el.getAttribute("tabindex") != "-1");
  },

  _onKeyDown(panel, event, o) {
    const target = event.target;
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        if (!o.onEscape?.(event)) {
          this.close(panel);
        }
        return;
      case "Enter": {
        // A focused footer button takes Return, as in a macOS sheet (XUL
        // buttons on macOS only answer Space), so the default button (the
        // safe choice, focused first) is what Return runs.
        if (
          target.localName == "button" &&
          target.namespaceURI == "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul" &&
          !target.disabled &&
          !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
        ) {
          event.preventDefault();
          event.stopPropagation();
          target.doCommand();
        }
        return;
      }
      case "Tab": {
        if (event.ctrlKey || event.altKey || event.metaKey) {
          return;
        }
        const items = this.focusables(panel);
        if (!items.length) {
          return;
        }
        // Inside composite widgets only the roving item is a tab stop.
        const at = items.indexOf(target);
        event.preventDefault();
        const next = at < 0 ? (event.shiftKey ? items.length - 1 : 0) :
          (at + (event.shiftKey ? -1 : 1) + items.length) % items.length;
        items[next].focus();
        return;
      }
      case "ArrowDown":
      case "ArrowUp":
      case "ArrowLeft":
      case "ArrowRight":
      case "Home":
      case "End": {
        if (target.localName == "textarea" || (target.localName == "input" && target.type != "checkbox")) {
          return;
        }
        const group = target.closest?.("[role=radiogroup], [role=listbox], [role=grid], [role=tablist], .whimsy-surface-seg");
        if (!group || !panel.contains(group) || group._whimsyOwnKeys) {
          return;
        }
        this.moveWithin(group, target, event);
      }
    }
  },

  /** The items arrow keys move between inside a composite widget. */
  _items(group) {
    const role = group.getAttribute("role");
    const sel = role == "listbox" ? "[role=option]" :
      role == "tablist" ? "[role=tab]" :
      role == "grid" ? "[role=gridcell], .whimsy-surface-cell" :
      "[role=radio]";
    return [...group.querySelectorAll(sel)].filter(el => visible(el) && !el.hasAttribute("disabled") &&
      el.getAttribute("aria-disabled") != "true");
  },

  moveWithin(group, target, event) {
    const items = this._items(group);
    if (!items.length) {
      return;
    }
    const current = items.indexOf(target.closest?.("[role=radio], [role=option], [role=tab], [role=gridcell], .whimsy-surface-cell") ?? target);
    const doc = group.ownerDocument;
    const rtl = doc.dir == "rtl";
    const horizontal = group.classList.contains("whimsy-surface-seg") || group.getAttribute("aria-orientation") == "horizontal";
    const columns = Number(group.dataset.columns) || 1;
    let step = 0;
    switch (event.key) {
      // A grid, or a radiogroup laid out in rows (data-columns, F07's
      // swatches): up and down move a row.
      case "ArrowDown":
        step = group.getAttribute("role") == "grid" || group.dataset.columns ? columns : 1;
        break;
      case "ArrowUp":
        step = group.getAttribute("role") == "grid" || group.dataset.columns ? -columns : -1;
        break;
      case "ArrowRight":
        step = rtl ? -1 : 1;
        break;
      case "ArrowLeft":
        step = rtl ? 1 : -1;
        break;
    }
    if (!horizontal && group.getAttribute("role") != "grid" && (event.key == "ArrowLeft" || event.key == "ArrowRight") &&
      group.getAttribute("role") == "listbox") {
      return;
    }
    let next;
    if (event.key == "Home") {
      next = 0;
    } else if (event.key == "End") {
      next = items.length - 1;
    } else {
      next = clamp((current < 0 ? (step > 0 ? -1 : items.length) : current) + step, 0, items.length - 1);
    }
    event.preventDefault();
    event.stopPropagation();
    const item = items[next];
    for (const el of items) {
      el.tabIndex = el == item ? 0 : -1;
    }
    item.focus();
    // Radios and tabs follow focus (as the Look picker's segments do);
    // options and grid cells only move.
    const role = item.getAttribute("role");
    if ((role == "radio" || role == "tab") && !group.hasAttribute("data-manual")) {
      item.click();
    }
  },

  /** The first of these elements that is actually on screen. */
  visibleAnchor(win, ids) {
    for (const id of ids) {
      const el = typeof id == "string" ? win.document.getElementById(id) : id;
      if (el && visible(el) && el.checkVisibility?.({ visibilityProperty: true }) !== false) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          return el;
        }
      }
    }
    return null;
  },

  width(panel) {
    return parseInt(panel.style.getPropertyValue("--whimsy-surface-width"), 10) || 380;
  },

  pageArea(win) {
    return this.visibleAnchor(win, ["tabbrowser-tabbox", "browser", "appcontent"]) ?? win.document.documentElement;
  },

  sidebarOnRight(win) {
    return !!win.gZenVerticalTabsManager?._prefsRightSide;
  },

  /**
   * Opens a surface.
   *  - anchor (+ position, x, y): hangs off an element.
   *  - screenRect {left, top, width, height} (+ position, gap): hangs off a
   *    rectangle on screen (a text field, a selection in the page).
   *  - at "page-top-center": over the page, centred, near the top (where
   *    the command bar sits); "page-center": centred both ways on the
   *    window, sidebar or not (a prompt that asks before anything happens;
   *    W16-12: opened at a screen point, not over an anchor, so nothing
   *    anchored, such as the compact sidebar, takes it as its own);
   *    "page-top-end":
   *    top end corner of the page;
   *    "beside-sidebar": where the Look picker opens (y = optional offset).
   */
  open(win, panel, { anchor = null, position = "after_start", x = 0, y = 0, at = null, screenRect = null, gap = 0, triggerEvent = null } = {}) {
    // F07: a surface that was dragged this session opens where it was left.
    if (this.reopenWhereLeft(win, panel, triggerEvent)) {
      return;
    }
    if (screenRect) {
      const ry = position.startsWith("before") ? screenRect.top - gap : screenRect.top + gap;
      panel.openPopupAtScreenRect(position, screenRect.left, ry, screenRect.width, screenRect.height, false, false, triggerEvent);
      return;
    }
    if (anchor && !at) {
      if (position == "overlap") {
        this.openOver(panel, anchor, { x, y, triggerEvent });
      } else {
        panel.openPopup(anchor, { position, x, y, triggerEvent });
      }
      return;
    }
    if (at == "beside-sidebar") {
      const rightSide = this.sidebarOnRight(win);
      const sidebar = this.visibleAnchor(win, ["TabsToolbar", "navigator-toolbox"]);
      if (sidebar) {
        panel.openPopup(sidebar, {
          position: rightSide ? "topleft topright" : "topright topleft",
          x: rightSide ? 10 : -10,
          y,
          triggerEvent,
        });
        return;
      }
      at = "page-top-center";
    }
    const area = this.pageArea(win);
    const rect = area.getBoundingClientRect();
    const width = Math.min(this.width(panel), Math.max(0, rect.width - 20));
    if (at == "page-top-end") {
      const startSide = this.sidebarOnRight(win) != (win.document.dir == "rtl");
      const px = startSide ? 10 : Math.max(0, Math.round(rect.width - width - 10));
      this.openOver(panel, area, { x: px, y: y || 10, triggerEvent });
      return;
    }
    const px = Math.max(0, Math.round((rect.width - width) / 2));
    if (at == "page-center") {
      this.centerWhenShown(win, panel);
      this.keepFocusOutOfSidebar(win, panel);
      const wx = Math.max(0, Math.round((win.innerWidth - Math.min(this.width(panel), win.innerWidth)) / 2));
      const wy = Math.max(0, Math.round((win.innerHeight - 260) / 2));
      panel.openPopupAtScreen(Math.round(win.mozInnerScreenX + wx), Math.round(win.mozInnerScreenY + wy), false, triggerEvent);
      return;
    }
    const py = y || Math.round(clamp(rect.height * 0.1, 12, 96));
    this.openOver(panel, area, { x: px, y: py, triggerEvent });
  },

  /** Once its size is known, moves the panel to the middle of the window. */
  centerWhenShown(win, panel) {
    const onShown = () => {
      panel.removeEventListener("popuphidden", onHidden);
      const box = panel.getOuterScreenRect();
      const left = Math.round(win.mozInnerScreenX + Math.max(0, (win.innerWidth - box.width) / 2));
      const top = Math.round(win.mozInnerScreenY + Math.max(0, (win.innerHeight - box.height) / 2));
      if (Math.abs(box.top - top) > 1 || Math.abs(box.left - left) > 1) {
        panel.moveTo(left, top);
      }
    };
    const onHidden = () => panel.removeEventListener("popupshown", onShown, { capture: true });
    // Capture: before a drag handle records where it opened.
    panel.addEventListener("popupshown", onShown, { once: true, capture: true });
    panel.addEventListener("popuphidden", onHidden, { once: true });
  },

  // W16-12: when a centred prompt closes, focus goes back to the page, not
  // to the sidebar (which a focused toolbox keeps open in compact mode).
  keepFocusOutOfSidebar(win, panel) {
    panel.addEventListener("popuphidden", () => {
      win.setTimeout(() => {
        const active = win.document.activeElement;
        const toolbox = win.gNavToolbox;
        if (toolbox && active && toolbox.contains(active) && !win.gURLBar?.focused) {
          win.gBrowser?.selectedBrowser?.focus();
        }
      }, 0);
    }, { once: true });
  },

  /**
   * Opens a panel over `anchor`, its top-left corner at (x, y) inside it.
   * Zen turns on widget.macos.native-popovers (and its patch makes every
   * panel an NSPopover), and an NSPopover can only hang off one edge of its
   * anchor, centred: it ignores "overlap" and the offsets, so a sheet meant
   * to sit inside the page landed centred under it on its first show
   * (W13 F03's cheat sheet, 183px off). Panels placed by coordinates are
   * nonnative, as Firefox's own openPopupAtScreen/AtScreenRect make them.
   * Used by every overlap placement above (page-top-center/-end,
   * anchor+overlap) and by WhimsyPanels' sheet, so every styled surface
   * opened by coordinates (Move Out of Private, the lock prompt, the
   * Fire popup, and the rest) lands where asked instead of hanging off
   * one edge of its anchor (B4).
   */
  openOver(panel, anchor, { x = 0, y = 0, triggerEvent = null } = {}) {
    panel.setAttribute("nonnative", "true");
    panel.openPopup(anchor, { position: "overlap", x, y, triggerEvent });
  },

  close(panel) {
    if (panel && (panel.state == "open" || panel.state == "showing")) {
      panel.hidePopup();
    }
  },

  /**
   * F07 (W13, wave12 F07): a floating surface drags by its header. A
   * primary press on `handle` (not on a button or field in it) captures
   * the pointer; each move puts the panel where the pointer is, less where
   * it was grabbed. getOuterScreenRect() and moveTo() use the same frame,
   * so the panel never jumps on the first move.
   *
   * The design's rest, for every surface that uses it:
   *  - a 6-dot grip before the title (unless `grip` is false or the
   *    handle has one), `cursor: grab` / `grabbing`;
   *  - [dragging] while it moves, which lifts the surface's shadow (CSS);
   *  - it stays where you leave it for the rest of the session: the spot
   *    (relative to the window) is kept per `key` (the panel's id), and
   *    the next open() or reopenWhereLeft() goes there. `remember: false`
   *    (a card that opens at the text it describes) keeps a drag for that
   *    open only;
   *  - a double-click on the header puts it back where it opened by
   *    itself, and forgets the spot.
   *
   * @param {Element} panel
   * @param {Element} handle - the header
   * @param {object} [options]
   * @param {string} [options.key] - default panel.id
   * @param {boolean} [options.remember] - default true
   * @param {boolean} [options.grip] - default true
   */
  makeDraggable(panel, handle, { key = panel.id, remember = true, grip = true } = {}) {
    const doc = panel.ownerDocument;
    // ownerGlobal isn't defined on elements seen from a module.
    const win = doc.defaultView;
    const state = { key, remember, home: null };
    panel._whimsyDrag = state;
    handle.classList.add("whimsy-surface-drag-handle");
    if (grip && !handle.querySelector(".whimsy-surface-grip")) {
      const dots = doc.createElementNS(HTML_NS, "span");
      dots.className = "whimsy-surface-grip";
      dots.setAttribute("aria-hidden", "true");
      dots.textContent = "⋮⋮";
      handle.prepend(dots);
    }
    // Where it opened by itself: what a double-click goes back to. An open
    // at a remembered spot keeps the home it had.
    panel.addEventListener("popupshown", event => {
      if (event.target != panel) {
        return;
      }
      if (!panel.hasAttribute("whimsy-reopened")) {
        state.home = relativeRect(win, panel);
        if (remember) {
          dragHomes.set(key, state.home);
        }
      } else {
        state.home = dragHomes.get(key) ?? state.home;
      }
      panel.removeAttribute("whimsy-reopened");
    });
    const onHandle = target => !target.closest?.("toolbarbutton, button, input, textarea, select, a");
    // A second press soon after a press that didn't move it, in the same
    // spot, is a double-click (told apart here: the press is the drag's,
    // so the page never sees a dblclick of its own).
    let lastPress = null;
    const putBack = () => {
      dragPositions.delete(key);
      const home = state.home;
      if (home) {
        panel.moveTo(Math.round(win.mozInnerScreenX + home.x), Math.round(win.mozInnerScreenY + home.y));
      }
    };
    handle.addEventListener("pointerdown", event => {
      if (event.button != 0 || !onHandle(event.target)) {
        return;
      }
      const now = Date.now();
      if (lastPress && now - lastPress.time < DOUBLE_PRESS_MS &&
        Math.hypot(event.screenX - lastPress.x, event.screenY - lastPress.y) < 4) {
        lastPress = null;
        event.preventDefault();
        putBack();
        return;
      }
      lastPress = { time: now, x: event.screenX, y: event.screenY };
      const start = panel.getOuterScreenRect();
      const dx = event.screenX - start.left;
      const dy = event.screenY - start.top;
      const pointerId = event.pointerId;
      event.preventDefault();
      try {
        handle.setPointerCapture(pointerId);
      } catch (e) {
        // Not capturable (a synthetic event): moves over the panel still work.
      }
      panel.setAttribute("dragging", "true");
      let moved = false;
      let target = null;
      const move = e => {
        if (e.pointerId == pointerId && (moved || Math.hypot(e.screenX - event.screenX, e.screenY - event.screenY) >= 1)) {
          moved = true;
          lastPress = null;
          target = { x: Math.round(e.screenX - dx), y: Math.round(e.screenY - dy) };
          panel.moveTo(target.x, target.y);
        }
      };
      const end = e => {
        if (e.pointerId != pointerId) {
          return;
        }
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
        handle.removeEventListener("lostpointercapture", end);
        try {
          handle.releasePointerCapture(pointerId);
        } catch (err) {}
        panel.removeAttribute("dragging");
        if (moved && remember) {
          // moveTo lands asynchronously, so the panel's own rect may still be the old spot.
          dragPositions.set(key, { x: target.x - win.mozInnerScreenX, y: target.y - win.mozInnerScreenY, width: panel.getOuterScreenRect().width });
        }
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
      handle.addEventListener("lostpointercapture", end);
    });
  },

  /**
   * Opens a draggable surface where it was left this session, if it was.
   * Returns whether it did (the caller opens it the usual way otherwise).
   */
  reopenWhereLeft(win, panel, triggerEvent = null) {
    const key = panel._whimsyDrag?.remember ? panel._whimsyDrag.key : null;
    const spot = key ? dragPositions.get(key) : null;
    if (!spot) {
      return false;
    }
    // Kept inside the window, which may have moved or shrunk since.
    const width = spot.width || this.width(panel);
    const x = clamp(spot.x, 0, Math.max(0, win.innerWidth - Math.min(width, win.innerWidth)));
    const y = clamp(spot.y, 0, Math.max(0, win.innerHeight - 40));
    panel.setAttribute("whimsy-reopened", "true");
    panel.openPopupAtScreen(Math.round(win.mozInnerScreenX + x), Math.round(win.mozInnerScreenY + y), false, triggerEvent);
    return true;
  },

  /** Forgets every remembered spot (tests). */
  forgetDragPositions() {
    dragPositions.clear();
    dragHomes.clear();
  },

  isOpen(win, id) {
    const panel = win.document.getElementById(id);
    return !!panel && (panel.state == "open" || panel.state == "showing");
  },

  // ---- parts ----------------------------------------------------------

  /** A track holding rows. */
  group(doc, { role = null, label = null } = {}) {
    const el = doc.createXULElement("vbox");
    el.className = "whimsy-surface-group";
    if (role) {
      el.setAttribute("role", role);
    }
    if (label) {
      el.setAttribute("aria-labelledby", label);
    }
    return el;
  },

  /** A 1px hairline, for the rare place a rule is really needed. */
  rule(doc) {
    const el = html(doc, "div", "whimsy-surface-rule");
    el.setAttribute("role", "presentation");
    return el;
  },

  /**
   * A row: label (Fluent or text) on the start, `trailing` controls on the
   * end. With onCommand the row itself is a button.
   */
  row(doc, { l10nId = null, l10nArgs = null, text = null, detail = null, detailL10nId = null, detailArgs = null, trailing = [], onCommand = null, id = null } = {}) {
    const row = doc.createXULElement("hbox");
    row.className = "whimsy-surface-row";
    row.setAttribute("align", "center");
    if (id) {
      row.id = id;
    }
    const text_ = doc.createXULElement("vbox");
    text_.className = "whimsy-surface-row-text";
    text_.setAttribute("flex", "1");
    const label = html(doc, "span", "whimsy-surface-row-label");
    if (l10nId) {
      setL10n(doc, label, l10nId, l10nArgs);
    } else if (text != null) {
      label.textContent = text;
    }
    text_.append(label);
    if (detail != null || detailL10nId) {
      const d = html(doc, "span", "whimsy-surface-row-detail");
      if (detailL10nId) {
        setL10n(doc, d, detailL10nId, detailArgs);
      } else {
        d.textContent = detail;
      }
      text_.append(d);
    }
    row.append(text_, ...trailing);
    if (onCommand) {
      row.setAttribute("tabindex", "0");
      row.setAttribute("role", "button");
      row.addEventListener("click", event => onCommand(event));
      row.addEventListener("keydown", event => {
        if ((event.key == "Enter" || event.key == " ") && event.target == row) {
          event.preventDefault();
          onCommand(event);
        }
      });
    }
    return { row, label };
  },

  /** A small group heading, with an optional trailing detail. */
  caption(doc, { l10nId = null, l10nArgs = null, text = null, detail = null, detailL10nId = null, detailArgs = null, id = null, tag = "h2" } = {}) {
    const box = doc.createXULElement("hbox");
    box.className = "whimsy-surface-caption";
    box.setAttribute("align", "center");
    const label = html(doc, tag, "whimsy-surface-caption-label");
    if (id) {
      label.id = id;
    }
    if (l10nId) {
      setL10n(doc, label, l10nId, l10nArgs);
    } else {
      label.textContent = text ?? "";
    }
    box.append(label);
    let d = null;
    if (detail != null || detailL10nId) {
      d = html(doc, "span", "whimsy-surface-caption-detail");
      if (detailL10nId) {
        setL10n(doc, d, detailL10nId, detailArgs);
      } else {
        d.textContent = detail;
      }
      box.append(d);
    }
    return { caption: box, label, detail: d };
  },

  /**
   * A segmented control: one tab stop, arrows move and pick, a thumb slides
   * to the choice. `tabs: true` makes it a tablist (role=tab, aria-selected).
   */
  seg(doc, { name, options, onPick, tabs = false, small = false, label = null }) {
    const group = html(doc, "div", "whimsy-surface-seg");
    if (small) {
      group.classList.add("whimsy-surface-seg-small");
    }
    group.setAttribute("role", tabs ? "tablist" : "radiogroup");
    if (label) {
      group.setAttribute("aria-label", label);
    }
    group.dataset.group = name;
    group.style.setProperty("--count", String(options.length));
    const thumb = html(doc, "div", "whimsy-surface-seg-thumb");
    group.append(thumb);
    const buttons = options.map(option => {
      const button = html(doc, "button", "whimsy-surface-segment");
      button.type = "button";
      button.setAttribute("role", tabs ? "tab" : "radio");
      button.dataset.value = option.value;
      if (option.id) {
        button.id = option.id;
      }
      if (option.controls) {
        button.setAttribute("aria-controls", option.controls);
      }
      // A hidden bold twin reserves the button's width, so the control
      // doesn't resize when the selection (and so which label goes
      // bold) changes.
      for (const part of ["label", "ghost"]) {
        const span = html(doc, "span", `whimsy-surface-segment-${part}`);
        if (option.l10nId) {
          setL10n(doc, span, option.l10nId, option.l10nArgs);
        } else {
          span.textContent = option.text ?? option.value;
        }
        if (part == "ghost") {
          span.setAttribute("aria-hidden", "true");
        }
        button.append(span);
      }
      button.addEventListener("click", () => onPick(option.value));
      group.append(button);
      return button;
    });
    const attr = tabs ? "aria-selected" : "aria-checked";
    const select = value => {
      let index = -1;
      buttons.forEach((button, i) => {
        const on = button.dataset.value == value;
        button.setAttribute(attr, on ? "true" : "false");
        button.tabIndex = on ? 0 : -1;
        if (on) {
          index = i;
        }
      });
      if (index < 0) {
        buttons[0].tabIndex = 0;
      }
      group.toggleAttribute("nothing-checked", index < 0);
      group.style.setProperty("--index", String(Math.max(0, index)));
    };
    const setDisabled = disabled => {
      group.toggleAttribute("disabled", disabled);
      group.setAttribute("aria-disabled", disabled ? "true" : "false");
      for (const b of buttons) {
        b.disabled = disabled;
      }
    };
    return { group, select, buttons, setDisabled };
  },

  /** A switch: <input type=checkbox role=switch>. */
  switch(doc, { checked = false, disabled = false, l10nId = null, l10nArgs = null, labelledBy = null, id = null, onChange = null }) {
    const input = html(doc, "input", "whimsy-surface-switch");
    input.type = "checkbox";
    input.setAttribute("role", "switch");
    input.checked = !!checked;
    input.disabled = !!disabled;
    if (id) {
      input.id = id;
    }
    if (labelledBy) {
      input.setAttribute("aria-labelledby", labelledBy);
    } else if (l10nId) {
      setL10n(doc, input, l10nId, l10nArgs);
    }
    if (onChange) {
      input.addEventListener("change", event => onChange(input.checked, event));
    }
    return input;
  },

  /** A 28px rounded icon tile; tone: warning | destructive. */
  tile(doc, { icon, tone = null, l10nId = null, text = null }) {
    const el = doc.createXULElement("hbox");
    el.className = "whimsy-surface-tile";
    el.setAttribute("align", "center");
    el.setAttribute("pack", "center");
    if (tone) {
      el.setAttribute("tone", tone);
    }
    if (icon) {
      const image = doc.createXULElement("image");
      image.setAttribute("src", icon);
      el.append(image);
    } else if (text != null) {
      const span = html(doc, "span", "whimsy-surface-tile-text");
      span.textContent = text;
      el.append(span);
    }
    if (l10nId) {
      setL10n(doc, el, l10nId);
    } else {
      el.setAttribute("aria-hidden", "true");
    }
    return el;
  },

  /** A small pill; tone: pass | fail. */
  pill(doc, { l10nId = null, l10nArgs = null, text = null, tone = null }) {
    const el = html(doc, "span", "whimsy-surface-pill");
    if (tone) {
      el.setAttribute("tone", tone);
    }
    if (l10nId) {
      setL10n(doc, el, l10nId, l10nArgs);
    } else {
      el.textContent = text ?? "";
    }
    return el;
  },

  /**
   * A choice card (a radio): tile, a name and a detail that wraps (never
   * cropped), and a radio dot.
   */
  choice(doc, { value, icon, tone = null, nameL10nId, nameArgs, detailL10nId, detailArgs, onPick }) {
    const card = html(doc, "div", "whimsy-surface-choice");
    card.setAttribute("role", "radio");
    card.setAttribute("aria-checked", "false");
    card.tabIndex = -1;
    card.dataset.value = value;
    const tile = this.tile(doc, { icon, tone });
    const text = html(doc, "div", "whimsy-surface-choice-text");
    const name = html(doc, "span", "whimsy-surface-choice-name");
    name.id = `whimsy-choice-${value}-name`;
    setL10n(doc, name, nameL10nId, nameArgs);
    const detail = html(doc, "span", "whimsy-surface-choice-detail");
    detail.id = `whimsy-choice-${value}-detail`;
    setL10n(doc, detail, detailL10nId, detailArgs);
    text.append(name, detail);
    const dot = html(doc, "span", "whimsy-surface-choice-dot");
    dot.setAttribute("aria-hidden", "true");
    card.append(tile, text, dot);
    card.setAttribute("aria-labelledby", name.id);
    card.setAttribute("aria-describedby", detail.id);
    card.addEventListener("click", () => onPick?.(value));
    return card;
  },

  /** Marks one card of a radiogroup as checked (roving tabindex). */
  check(group, value) {
    const cards = [...group.querySelectorAll("[role=radio]")];
    for (const card of cards) {
      const on = card.dataset.value == value;
      card.setAttribute("aria-checked", on ? "true" : "false");
      card.tabIndex = on ? 0 : -1;
    }
  },

  /** The empty state: a sentence (and a hint), centred. */
  empty(doc, { l10nId, l10nArgs, hintL10nId = null, hintArgs = null }) {
    const box = doc.createXULElement("vbox");
    box.className = "whimsy-surface-empty";
    box.setAttribute("align", "center");
    const text = html(doc, "p", "whimsy-surface-empty-text");
    setL10n(doc, text, l10nId, l10nArgs);
    box.append(text);
    if (hintL10nId) {
      const hint = html(doc, "p", "whimsy-surface-empty-hint");
      setL10n(doc, hint, hintL10nId, hintArgs);
      box.append(hint);
    }
    return box;
  },

  /** A skeleton bar (no shimmer). */
  skeleton(doc, { width = "100%", height = 10 } = {}) {
    const el = html(doc, "span", "whimsy-surface-skeleton");
    el.style.width = typeof width == "number" ? `${width}px` : width;
    el.style.height = `${height}px`;
    el.setAttribute("aria-hidden", "true");
    return el;
  },

  /** A 12px spinner ring (static with reduced motion). */
  spinner(doc) {
    const el = html(doc, "span", "whimsy-surface-spinner");
    el.setAttribute("aria-hidden", "true");
    return el;
  },

  /** A footer button: `primary` is the one filled default, `destructive` red. */
  footerButton(doc, { l10nId, l10nArgs = null, primary = false, destructive = false, id = null, onCommand = null }) {
    const button = doc.createXULElement("button");
    button.className = "footer-button whimsy-surface-button";
    if (id) {
      button.id = id;
    }
    if (primary) {
      button.classList.add("primary");
      button.setAttribute("default", "true");
    }
    if (destructive) {
      button.setAttribute("destructive", "true");
    }
    setL10n(doc, button, l10nId, l10nArgs);
    if (onCommand) {
      button.addEventListener("command", onCommand);
    }
    return button;
  },

  /** A quiet text button (Forget All, Custom…, Highlight on Page). */
  textButton(doc, { l10nId = null, l10nArgs = null, text = null, id = null, ghost = false, onCommand = null }) {
    const button = html(doc, "button", "whimsy-surface-text-button");
    button.type = "button";
    if (ghost) {
      button.classList.add("whimsy-surface-ghost");
    }
    if (id) {
      button.id = id;
    }
    if (l10nId) {
      setL10n(doc, button, l10nId, l10nArgs);
    } else {
      button.textContent = text ?? "";
    }
    if (onCommand) {
      button.addEventListener("click", event => {
        event.stopPropagation();
        onCommand(event);
      });
    }
    return button;
  },

  /**
   * Copy-in-place: a button that copies `value`, swaps its text for
   * "✓ Copied" for 1.2s and announces it (aria-live). No toast.
   * `content` is the element(s) shown normally; the swap targets
   * `.whimsy-surface-copy-value` inside it (or the whole button).
   */
  copyButton(doc, { value, content = [], className = "", label = null, onCopied = null, liveIn = null, liveBefore = null }) {
    const button = html(doc, "button", `whimsy-surface-copy ${className}`.trim());
    button.type = "button";
    button.append(...content);
    if (label) {
      button.setAttribute("aria-label", label);
    }
    // "✓ Copied" takes the value's place: by default after the content, or
    // where the caller says (inside `liveIn`, before `liveBefore`).
    const live = html(doc, "span", "whimsy-surface-copy-live");
    live.setAttribute("aria-live", "polite");
    (liveIn ?? liveBefore?.parentNode ?? button).insertBefore(live, liveBefore);
    let timer = null;
    button.addEventListener("click", event => {
      event.stopPropagation();
      const v = typeof value == "function" ? value() : value;
      this.copyText(v);
      const win = doc.defaultView;
      button.setAttribute("copied", "true");
      button.classList.add("whimsy-surface-copied");
      setL10n(doc, live, "whimsy-surface-copied");
      win.clearTimeout(timer);
      timer = win.setTimeout(() => {
        button.removeAttribute("copied");
        button.classList.remove("whimsy-surface-copied");
        live.removeAttribute("data-l10n-id");
        live.textContent = "";
      }, COPIED_MS);
      onCopied?.(v);
    });
    return button;
  },

  copyText(text) {
    Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(String(text ?? ""));
  },

  /**
   * A dropdown button that opens a small listbox surface under it (This
   * Site's Autoplay and Pretend to Be). Options: [{value, l10nId, l10nArgs,
   * shortL10nId, detailL10nId, rule, disabled, expand}] (rule: a hairline
   * before this option; shortL10nId: the button's label; expand: builds an
   * editor that replaces the menu in place).
   * Returns { button, setValue(value, l10nId, l10nArgs) }.
   */
  dropdown(doc, { id, label = null, options, value, onPick, width = 240, position = "after_end" }) {
    const button = html(doc, "button", "whimsy-surface-dropdown");
    button.type = "button";
    button.id = id;
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");
    if (label) {
      button.setAttribute("aria-labelledby", `${label} ${id}-value`);
    }
    const text = html(doc, "span", "whimsy-surface-dropdown-value");
    text.id = `${id}-value`;
    const chevron = doc.createXULElement("image");
    chevron.className = "whimsy-surface-dropdown-chevron";
    chevron.setAttribute("src", "chrome://global/skin/icons/arrow-down.svg");
    // W23 routines-ui: options with an icon show the picked one's icon too.
    const icon = options.some(o => o.icon) ? doc.createXULElement("image") : null;
    if (icon) {
      icon.className = "whimsy-surface-dropdown-icon";
      button.append(icon);
    }
    button.append(text, chevron);
    let current = value;
    const setValue = v => {
      current = v;
      const option = options.find(o => o.value == v) ?? options[0];
      icon?.setAttribute("src", option.icon ?? "");
      if (option.shortL10nId ?? option.l10nId) {
        setL10n(doc, text, option.shortL10nId ?? option.l10nId, option.l10nArgs);
      } else {
        text.removeAttribute("data-l10n-id");
        text.textContent = option.text ?? "";
      }
    };
    setValue(value);
    button.addEventListener("click", event => {
      event.stopPropagation();
      this.openListbox(doc.defaultView, {
        id: `${id}-list`,
        anchor: button,
        options,
        value: current,
        width,
        position,
        onPick: v => {
          setValue(v);
          onPick(v);
        },
        onHidden: () => button.setAttribute("aria-expanded", "false"),
      });
      button.setAttribute("aria-expanded", "true");
    });
    button.addEventListener("keydown", event => {
      if (event.key == "ArrowDown" && !event.altKey) {
        event.preventDefault();
        button.click();
      }
    });
    return { button, setValue, get value() {
      return current;
    } };
  },

  /** A small listbox surface anchored to `anchor` (after_end). */
  openListbox(win, { id, anchor, options, value, width = 240, position = "after_end", onPick, onHidden }) {
    const doc = win.document;
    const parts = this.create(win, {
      id,
      width,
      className: "whimsy-surface-listbox-panel",
      onHidden,
      initialFocus: () => list.querySelector("[aria-selected='true']") ?? list.querySelector("[role=option]"),
    });
    const list = html(doc, "div", "whimsy-surface-listbox");
    list.setAttribute("role", "listbox");
    for (const option of options) {
      if (option.rule) {
        list.append(this.rule(doc));
        // A bare { rule: true } is only the line, not a blank option under it.
        if (option.value === undefined) {
          continue;
        }
      }
      const row = html(doc, "div", "whimsy-surface-option");
      row.setAttribute("role", "option");
      row.dataset.value = option.value;
      const on = option.value == value;
      row.setAttribute("aria-selected", on ? "true" : "false");
      row.tabIndex = on ? 0 : -1;
      // An option with its own icon shows it where the check goes; the
      // picked one reads bold instead.
      const check = doc.createXULElement("image");
      check.className = option.icon ? "whimsy-surface-option-icon" : "whimsy-surface-option-check";
      check.setAttribute("src", option.icon ?? "chrome://global/skin/icons/check.svg");
      const label = html(doc, "span", "whimsy-surface-option-label");
      if (option.l10nId) {
        setL10n(doc, label, option.l10nId, option.l10nArgs);
      } else {
        label.textContent = option.text ?? "";
      }
      row.append(check, label);
      if (option.detailL10nId) {
        const d = html(doc, "span", "whimsy-surface-option-detail");
        setL10n(doc, d, option.detailL10nId, option.detailL10nArgs);
        row.append(d);
      }
      // W23 routines-ui: an option that can't be picked says why in its detail.
      if (option.disabled) {
        row.setAttribute("aria-disabled", "true");
      }
      const pick = () => {
        if (option.disabled) {
          return;
        }
        // W23 routines-ui: an option with `expand` turns the menu into its
        // editor in place; the editor picks with done(value).
        if (option.expand) {
          const editor = option.expand({
            done: v => {
              this.close(parts.panel);
              onPick(v);
            },
          });
          list.replaceWith(editor);
          editor.querySelector("[autofocus], button, input")?.focus();
          return;
        }
        this.close(parts.panel);
        onPick(option.value);
      };
      row.addEventListener("click", pick);
      row.addEventListener("keydown", event => {
        if (event.key == "Enter" || event.key == " ") {
          event.preventDefault();
          pick();
        }
      });
      list.append(row);
    }
    if (!list.querySelector("[tabindex='0']")) {
      list.querySelector("[role=option]")?.setAttribute("tabindex", "0");
    }
    parts.view.append(list);
    this.open(win, parts.panel, { anchor, position, y: 4 });
    return parts;
  },
};
