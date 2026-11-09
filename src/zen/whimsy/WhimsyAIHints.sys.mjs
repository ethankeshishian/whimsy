/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23: discovery hints. One Zen toast per surface, once ever, never a halo.
//
// - A hint shows only while its surface is on screen (isVisible), waits for
//   real toasts to go, comes 2s after the last hint, and at most three show
//   a day. One more may wait in line; any other request is dropped (the
//   surface asks again next time).
// - It stays 6s, pauses on hover, offers only Got it, and Esc never
//   dismisses it.
// - Seen = shown for 1.5s, or the feature used (used()); seen ids go in
//   whimsy.ai.hints.seen and never show again.
// - With AI off, only hints marked aiOff (voice, image text) show.
//
// The copy and icons of every W23 hint live here; the lane that owns a
// surface registers its id with isVisible(win).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  WhimsyAI: "resource:///modules/whimsy/WhimsyAI.sys.mjs",
  WhimsyAIContext: "resource:///modules/whimsy/WhimsyAIContext.sys.mjs",
});

const SEEN_PREF = "whimsy.ai.hints.seen";
const TODAY_PREF = "whimsy.ai.hints.today";
const FEATURE = "whimsy.feature.ai-hints";
const DAILY_CAP = 3;
const ICONS = "chrome://browser/content/whimsy/icons/";

export const HINTS = {
  ask: { icon: "summarize" },
  "context-commands": { icon: "summarize" },
  chat: { icon: "chat" },
  updates: { icon: "updates" },
  "video-summary": { icon: "summarize" },
  voice: { icon: "mic", aiOff: true },
  "image-text": { icon: "image-text", aiOff: true },
  "agent-mode": { icon: "drive" },
};

const DEFAULT_TIMING = { gapMs: 2000, seenMs: 1500, timeoutMs: 6000, pollMs: 500 };
let timing = { ...DEFAULT_TIMING };
let today = () => new Date().toLocaleDateString("en-CA");

const registered = new Map();
// Tests: the surfaces' hints before the first _resetForTesting.
let productHints = null;
// The hint on screen: {id, win, toast, shownAt, seenTimer, poll}.
let current = null;
// The one hint waiting: {id, win}.
let waiting = null;
let lastClosedAt = -Infinity;
let pump = null;

function seenList() {
  return Services.prefs.getStringPref(SEEN_PREF, "").split(",").filter(Boolean);
}

function shownToday() {
  const [day, count] = Services.prefs.getStringPref(TODAY_PREF, "").split(":");
  return day == today() ? Number(count) || 0 : 0;
}

function countShown() {
  Services.prefs.setStringPref(TODAY_PREF, `${today()}:${shownToday() + 1}`);
}

// Not the window's own timers: a closed window drops them, and the line
// would wait forever on a hint asked for in a window that's gone.
function sleep(ms) {
  return new Promise(resolve => lazy.setTimeout(resolve, ms));
}

function alive(win) {
  return win && !win.closed && win.gZenUIManager?.toasts;
}

function realToastShowing(win) {
  return win.gZenUIManager.toasts.getToasts().some(t => !t.element.hasAttribute("whimsy-ai-hint"));
}

export const WhimsyAIHints = {
  SEEN_PREF,
  HINTS,

  /** A surface's hint: {id, isVisible(win), l10nId?, aiOff?, icon?}. */
  register({ id, isVisible, l10nId, aiOff, icon }) {
    const base = HINTS[id] ?? {};
    registered.set(id, {
      id,
      isVisible: isVisible ?? (() => true),
      l10nId: l10nId ?? `whimsy-ai-hint-${id}`,
      aiOff: aiOff ?? !!base.aiOff,
      icon: icon ?? (base.icon ? `${ICONS}${base.icon}.svg` : null),
    });
    return () => registered.delete(id);
  },

  seen(id) {
    return seenList().includes(id);
  },

  _markSeen(id) {
    if (!this.seen(id)) {
      Services.prefs.setStringPref(SEEN_PREF, [...seenList(), id].join(","));
    }
  },

  /** The feature was used: its hint is seen, and goes if it's showing. */
  used(id) {
    this._markSeen(id);
    if (waiting?.id == id) {
      waiting = null;
    }
    if (current?.id == id) {
      current.toast.close();
    }
  },

  _allowed(win, hint) {
    if (!Services.prefs.getBoolPref(FEATURE, true) || !hint || this.seen(hint.id)) {
      return false;
    }
    if (!lazy.WhimsyAI.enabled && !hint.aiOff) {
      return false;
    }
    if (!alive(win) || lazy.WhimsyAIContext.isPrivate(win.gBrowser?.selectedTab)) {
      return false;
    }
    try {
      return !!hint.isVisible(win);
    } catch {
      return false;
    }
  },

  /**
   * A surface came on screen and asks for its hint.
   *
   * @returns {boolean} whether it's showing or waiting
   */
  request(win, id) {
    const hint = registered.get(id);
    if (!this._allowed(win, hint) || shownToday() >= DAILY_CAP) {
      return false;
    }
    if (current?.id == id || waiting?.id == id) {
      return true;
    }
    if (waiting) {
      return false;
    }
    waiting = { id, win };
    pump ??= this._run().finally(() => {
      pump = null;
    });
    return true;
  },

  async _run() {
    while (waiting) {
      if (current) {
        await current.closed;
        continue;
      }
      const { id, win } = waiting;
      const hint = registered.get(id);
      if (!this._allowed(win, hint) || shownToday() >= DAILY_CAP) {
        waiting = null;
        break;
      }
      const wait = lastClosedAt + timing.gapMs - Date.now();
      if (wait > 0) {
        await sleep(wait);
        continue;
      }
      if (realToastShowing(win)) {
        await sleep(timing.pollMs);
        continue;
      }
      waiting = null;
      await this._show(win, hint);
    }
  },

  _show(win, hint) {
    const toast = win.gZenUIManager.toasts.open(`${hint.l10nId}-title`, {
      key: "whimsy-ai-hint",
      descriptionId: `${hint.l10nId}-body`,
      icon: hint.icon ?? undefined,
      timeout: timing.timeoutMs,
      closable: false,
      buttons: [{ id: "whimsy-ai-hint-got-it", l10nId: "whimsy-ai-hint-got-it", command: () => this._markSeen(hint.id) }],
      onClose: () => finish(),
    });
    toast.element.setAttribute("whimsy-ai-hint", hint.id);
    // Esc never dismisses a hint: it stays with the surface underneath.
    toast.element.addEventListener("keydown", event => {
      if (event.key == "Escape") {
        event.stopImmediatePropagation();
      }
    }, { capture: true });
    countShown();
    let resolveClosed;
    const state = {
      id: hint.id,
      win,
      toast,
      closed: new Promise(r => (resolveClosed = r)),
    };
    const finish = () => {
      if (current != state) {
        return;
      }
      // The hint's own timers run on its window: a window that closed has
      // dropped them already.
      try {
        win.clearTimeout(state.seenTimer);
        win.clearInterval(state.poll);
        win.removeEventListener("unload", onUnload);
      } catch {}
      current = null;
      lastClosedAt = Date.now();
      resolveClosed();
    };
    // Its window closed: the toast went with it, cut short and not seen.
    const onUnload = () => {
      state.cut = true;
      finish();
    };
    win.addEventListener("unload", onUnload);
    current = state;
    toast.shown.then(() => {
      if (current == state && !state.cut) {
        state.seenTimer = win.setTimeout(() => this._markSeen(hint.id), timing.seenMs);
      }
    });
    // Gone with its surface.
    state.poll = win.setInterval(() => {
      let visible = false;
      try {
        visible = !win.closed && hint.isVisible(win);
      } catch {}
      if (!visible) {
        // Cut short: not seen, even if the close animation outlasts the timer.
        win.clearTimeout(state.seenTimer);
        state.cut = true;
        toast.close();
      }
    }, timing.pollMs);
    return state.closed;
  },

  /** The hint on screen, for tests and screenshots. */
  get current() {
    return current ? { id: current.id, toast: current.toast } : null;
  },

  get waiting() {
    return waiting?.id ?? null;
  },

  // Tests: whichever ids are registered right now, so an audit (W23
  // memory-fire's AI-off-everywhere test) doesn't need to hardcode the
  // full id list from the spec as later lanes merge their own hints.
  _registeredIdsForTesting() {
    return [...registered.keys()];
  },

  _registeredHintForTesting(id) {
    return registered.get(id) ?? null;
  },

  _setTimingForTesting(t) {
    timing = t ? { ...DEFAULT_TIMING, ...t } : { ...DEFAULT_TIMING };
  },

  _setTodayForTesting(fn) {
    today = fn ?? (() => new Date().toLocaleDateString("en-CA"));
  },

  // Between test files: no hint left waiting or showing to count itself
  // shown after the file's prefs are put back. Registrations stay.
  _settleForTesting() {
    waiting = null;
    current?.toast.close({ instant: true });
  },

  // Empties the registry for a test. The surfaces register once at startup,
  // so the first reset keeps their hints for _restoreForTesting: a later
  // file (the AI-off audit) sees every surface's hint again.
  _resetForTesting() {
    current?.toast.close({ instant: true });
    current = null;
    waiting = null;
    lastClosedAt = -Infinity;
    productHints ??= new Map(registered);
    registered.clear();
  },

  // A file's last cleanup: the state is reset, and the surfaces' own hints
  // are back as they were before the file's first reset.
  _restoreForTesting() {
    this._resetForTesting();
    for (const [id, hint] of productHints) {
      registered.set(id, hint);
    }
  },
};
