/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Zap mode, content side: blocks pointer interaction with the page underneath
// (crosshair cursor, prevents context menu, stops pointer interaction/selection),
// and allows Esc to exit zap mode.

const ZAP_SHEET =
  "data:text/css," +
  encodeURIComponent(
    "*, *::before, *::after { cursor: crosshair !important; user-select: none !important; -webkit-user-select: none !important; } " +
    "#select-component, #select-component * { cursor: default !important; user-select: auto !important; } " +
    "#select-component input[type='button'] { cursor: pointer !important; } " +
    "#hover-div { pointer-events: none !important; }"
  );

export const WhimsyZapChild = {
  _active: new WeakMap(),

  onStart(win, onEscape) {
    if (!win || this._active.has(win)) {
      return;
    }
    const cleanups = [];
    try {
      win.windowUtils?.loadSheetUsingURIString(ZAP_SHEET, win.windowUtils.USER_SHEET);
      cleanups.push(() => {
        try {
          win.windowUtils?.removeSheetUsingURIString(ZAP_SHEET, win.windowUtils.USER_SHEET);
        } catch {}
      });
    } catch (e) {
      console.error("Whimsy: load zap sheet failed", e);
    }

    const onKeyDown = event => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onEscape?.();
      }
    };
    win.addEventListener("keydown", onKeyDown, true);
    cleanups.push(() => win.removeEventListener("keydown", onKeyDown, true));

    const onContextMenu = event => {
      event.preventDefault();
      event.stopPropagation();
    };
    win.addEventListener("contextmenu", onContextMenu, true);
    cleanups.push(() => win.removeEventListener("contextmenu", onContextMenu, true));

    this._active.set(win, cleanups);
  },

  onStop(win) {
    if (!win) {
      return;
    }
    const cleanups = this._active.get(win);
    if (cleanups) {
      this._active.delete(win);
      for (const fn of cleanups) {
        try {
          fn();
        } catch {}
      }
    }
  },
};
