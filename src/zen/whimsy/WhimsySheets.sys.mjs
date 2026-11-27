/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Feature sheets that load the first time their feature shows something in a
// window, rather than with every window (W32 P2). One record per window, so
// modules that share a sheet load it once.
const loaded = new WeakMap();

export const WhimsySheets = {
  load(win, url) {
    if (!win) {
      return;
    }
    let urls = loaded.get(win);
    if (!urls) {
      urls = new Set();
      loaded.set(win, urls);
    }
    if (urls.has(url)) {
      return;
    }
    urls.add(url);
    try {
      win.windowUtils.loadSheetUsingURIString(url, win.windowUtils.AUTHOR_SHEET);
    } catch (e) {
      console.error("Whimsy: sheet", url, e);
    }
  },

  isLoaded(win, url) {
    return !!loaded.get(win)?.has(url);
  },
};
