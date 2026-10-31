/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// New season toast. The Whimsy balloon dresses for the season (homepage,
// offline page, Balloon Dash); the first window opened in a new season says
// so once, with one small Zen toast carrying the balloon in its costume,
// the way a calendar surprise (Google's doodles, Arc's seasonal touches)
// is noticed once and then gets out of the way. Never in Mini Whimsy or
// under test automation, never twice in a season, and nothing at all when
// seasonal colors and costumes are off (WhimsySeasons) or this switch is.
// The toast itself is Zen's; the balloon bobs once unless reduced motion
// is on (whimsy-browser.css).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsySeasons: "resource:///modules/whimsy/WhimsySeasons.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.season-toast";
const SEEN_PREF = "whimsy.seasons.last-toast";
const BALLOON_URL = "chrome://browser/content/whimsy/whimsy-season-balloon.svg";
const SETTLE_MS = 1500;
const TOAST_MS = 5000;

export const WhimsySeasonToast = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  // "2026-autumn"; winter belongs to the year it starts in (Dec 2026 and
  // Feb 2027 are both "2026-winter").
  seasonKey(season, now = lazy.WhimsySeasons._now()) {
    const year = season.id == "winter" && now.getMonth() < 2 ? now.getFullYear() - 1 : now.getFullYear();
    return `${year}-${season.id}`;
  },

  // The season to announce in this window, or null.
  pending(win) {
    if (!this.enabled || win._whimsyQuickWindow) {
      return null;
    }
    const season = lazy.WhimsySeasons.current();
    if (!season) {
      return null;
    }
    const key = this.seasonKey(season);
    return Services.prefs.getStringPref(SEEN_PREF, "") == key ? null : { season, key };
  },

  initWindow(win) {
    if (!this.pending(win) || win.gZenUIManager?.testingEnabled) {
      return;
    }
    const ready = win.gZenWorkspaces?.promiseInitialized ?? Promise.resolve();
    ready
      .then(() => new Promise(resolve => lazy.setTimeout(resolve, SETTLE_MS)))
      .then(() => {
        if (!win.closed) {
          this.maybeShow(win);
        }
      })
      .catch(e => console.error("Whimsy: new season toast", e));
  },

  // Shows the toast if this season hasn't had one. Returns the toast
  // element, or null.
  maybeShow(win) {
    const pending = this.pending(win);
    if (!pending || !win.gZenUIManager?.showToast) {
      return null;
    }
    // wave7/native1: waits (unclaimed) during a macOS Focus; shown when it
    // ends.
    if (
      ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFocus.sys.mjs").WhimsyFocus.holdToast(
        win,
        "season",
        w => this.maybeShow(w)
      )
    ) {
      return null;
    }
    // Claimed first, so a second window opening now doesn't repeat it.
    Services.prefs.setStringPref(SEEN_PREF, pending.key);
    const id = pending.season.id;
    const messageId = `whimsy-season-toast-${id}`;
    win.gZenUIManager.showToast(messageId, {
      descriptionId: `whimsy-season-toast-${id}-description`,
      timeout: TOAST_MS,
    });
    // Zen adds the toast synchronously; give it the balloon.
    const toast = [...(win.document.getElementById("zen-toast-container")?.children ?? [])].find(
      el => el._messageId == messageId
    );
    if (toast && !toast.querySelector(".whimsy-season-toast-balloon")) {
      const img = win.document.createElementNS("http://www.w3.org/1999/xhtml", "img");
      img.className = "whimsy-season-toast-balloon";
      img.src = `${BALLOON_URL}#${id}`;
      img.alt = "";
      toast.classList.add("whimsy-season-toast");
      toast.prepend(img);
    }
    return toast ?? null;
  },
};
