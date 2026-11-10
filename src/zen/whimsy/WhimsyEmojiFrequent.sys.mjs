/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W24 emoji: frequent emoji for the command bar's ":" surface, remembered
// on this Mac only (a local pref, never synced) and never recorded from a
// private window. Ranked by use count, most recent first on a tie.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

const PREF = "whimsy.emoji.frequent";
const MAX_STORED = 50;

function read() {
  try {
    const list = JSON.parse(Services.prefs.getStringPref(PREF, "") || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list) {
  Services.prefs.setStringPref(PREF, JSON.stringify(list.slice(0, MAX_STORED)));
}

export const WhimsyEmojiFrequent = {
  // Never records a pick made from a private window (win may be null in
  // tests that don't care about that check).
  record(win, emoji) {
    if (win && lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      return;
    }
    const list = read();
    const existing = list.find(item => item.emoji == emoji);
    if (existing) {
      existing.count++;
      existing.last = Date.now();
    } else {
      list.push({ emoji, count: 1, last: Date.now() });
    }
    list.sort((a, b) => b.count - a.count || b.last - a.last);
    write(list);
  },

  top(n) {
    return read()
      .sort((a, b) => b.count - a.count || b.last - a.last)
      .slice(0, n)
      .map(item => item.emoji);
  },

  clear() {
    Services.prefs.clearUserPref(PREF);
  },
};
