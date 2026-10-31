/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave7/native1: Whimsy's own toasts follow macOS Focus.
//
// Site notifications already do: they go to Notification Center, and Focus
// holds them there. Whimsy's in-window toasts don't go through macOS, so
// the unprompted ones (a new season, Year in tabs, the inbox-zero
// celebration) now wait while a Focus is on and show when it ends. Toasts
// that confirm something the person just did still show.
//
// Reading Focus: Apple's API is INFocusStatusCenter, which only answers
// apps signed with the Communication Notifications entitlement. That
// entitlement needs a provisioning profile from a paid Apple developer
// team; Whimsy is ad-hoc signed, so the API answers nothing (the native
// component still asks it first, so it lights up if signing ever changes).
// What works today is Focus's own database, ~/Library/DoNotDisturb/DB:
// Assertions.json lists the Focus that's on, whether turned on by hand, by
// a schedule or by the sleep schedule (each with the end macOS shows,
// when there is one). It's undocumented, so anything unreadable or
// unexpected counts as "no Focus" and toasts behave as before. The native
// component (focus/, nsIWhimsyFocus) watches that directory with FSEvents
// and notifies "whimsy-focus-changed"; this module rereads then, and at the
// end time a Focus shows, never on a timer otherwise.
//
// The state goes out as "whimsy-focus-state" ("on"/"off"). Switch:
// whimsy.feature.macos-focus.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.macos-focus";
// From the native component: Focus's database changed ("database"), or
// INFocusStatusCenter answered ("system").
const NATIVE_TOPIC = "whimsy-focus-changed";
// From here: the Focus state Whimsy follows changed ("on"/"off").
const STATE_TOPIC = "whimsy-focus-state";
const ASSERTIONS = "Assertions.json";
// Focus stores dates as seconds since 2001-01-01 (Apple's reference date).
const APPLE_EPOCH_MS = 978307200000;
// setTimeout's limit; a later end is rechecked when this fires.
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The Focus Assertions.json says is on, at `now`.
 *
 * @param {object} json Assertions.json, parsed.
 * @param {number} [now] ms since the epoch.
 * @returns {{focused: boolean, mode: string|null, until: number|null}}
 *   until: the soonest end (ms) of the Focus that's on, if it shows one.
 */
export function focusFromAssertions(json, now = Date.now()) {
  const result = { focused: false, mode: null, until: null };
  const stores = Array.isArray(json?.data) ? json.data : [];
  for (const store of stores) {
    const records = Array.isArray(store?.storeAssertionRecords) ? store.storeAssertionRecords : [];
    for (const record of records) {
      if (!record || typeof record != "object") {
        continue;
      }
      const details = record.assertionDetails ?? {};
      const end = details.assertionDetailsUserVisibleEndDate;
      const endMs = typeof end == "number" && Number.isFinite(end) ? APPLE_EPOCH_MS + end * 1000 : null;
      if (endMs != null && endMs <= now) {
        // Ended; macOS hasn't tidied it away yet.
        continue;
      }
      result.focused = true;
      result.mode ??= typeof details.assertionDetailsModeIdentifier == "string" ? details.assertionDetailsModeIdentifier : null;
      if (endMs != null && (result.until == null || endMs < result.until)) {
        result.until = endMs;
      }
    }
  }
  return result;
}

let state = { focused: false, source: "none", mode: null };
let initialized = false;
let loaded = false;
let readyResolve = null;
let ready = null;
function newReady() {
  ready = new Promise(resolve => (readyResolve = resolve));
}
newReady();
let endTimer = null;
let refreshing = null;
// key → { win, show }: toasts waiting for Focus to end.
const held = new Map();

export const WhimsyFocus = {
  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
  FEATURE_PREF,
  NATIVE_TOPIC,
  STATE_TOPIC,

  // Tests point this at their own directory; null means Focus's own.
  _databaseDir: null,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  get supported() {
    return Services.appinfo.OS == "Darwin";
  },

  // A Focus is on (whatever the switch says).
  get focused() {
    return state.focused;
  },

  // Whimsy's unprompted toasts should wait.
  get quiet() {
    return this.enabled && state.focused;
  },

  // { focused, source: "system" | "database" | "unreadable" | "none", mode }
  get state() {
    return { ...state };
  },

  // Resolves once the first read is done.
  get ready() {
    return ready;
  },

  get databaseDir() {
    if (this._databaseDir) {
      return this._databaseDir;
    }
    // Never the real Focus under test automation: the machine running the
    // tests may well be in a Focus.
    if (Cu.isInAutomation) {
      return null;
    }
    try {
      return PathUtils.join(Services.dirsvc.get("Home", Ci.nsIFile).path, "Library", "DoNotDisturb", "DB");
    } catch (e) {
      return null;
    }
  },

  // The native component, or null (another platform, or not built).
  native() {
    try {
      return Cc["@whimsy/focus;1"]?.getService(Ci.nsIWhimsyFocus) ?? null;
    } catch (e) {
      return null;
    }
  },

  // Once per session (also from holdToast). Nothing on other platforms.
  init() {
    if (initialized) {
      return;
    }
    initialized = true;
    if (!this.supported) {
      loaded = true;
      readyResolve();
      return;
    }
    Services.obs.addObserver(this, NATIVE_TOPIC);
    Services.prefs.addObserver(FEATURE_PREF, this);
    Services.obs.addObserver(this, "quit-application-granted");
    if (this.enabled) {
      this.start();
    } else {
      loaded = true;
      readyResolve();
    }
  },

  start() {
    const dir = this.databaseDir;
    const native = this.native();
    if (dir && native) {
      try {
        native.startWatching(dir);
      } catch (e) {
        console.error("Whimsy: watching Focus", e);
      }
    }
    return this.refresh();
  },

  stop() {
    try {
      this.native()?.stopWatching();
    } catch (e) {
      console.error("Whimsy: watching Focus", e);
    }
    lazy.clearTimeout(endTimer);
    endTimer = null;
    this._set({ focused: false, source: "none", mode: null });
  },

  /** Reads Focus again; resolves to the new state. */
  refresh() {
    // One file read at a time; a change during it reads once more after.
    if (refreshing) {
      refreshing.again = true;
      return refreshing.promise;
    }
    // Without a file to read (Apple's API answered, no database under test
    // automation, switch off) the state lands right away, so a toast asking
    // at that moment doesn't wait for nothing.
    const quick = this._readQuick();
    if (quick) {
      this._land(quick);
      return Promise.resolve(this.state);
    }
    const run = { again: false, promise: null };
    run.promise = (async () => {
      let next;
      do {
        run.again = false;
        next = this._readQuick() ?? (await this._readDatabase(this.databaseDir));
      } while (run.again);
      refreshing = null;
      this._land(next);
      return this.state;
    })();
    refreshing = run;
    return run.promise;
  },

  _land(next) {
    // Loaded before the state lands, so held toasts that show now go
    // through holdToast() as usual.
    const first = !loaded;
    loaded = true;
    this._set(next);
    if (first) {
      readyResolve();
    }
  },

  // The state when there's no file to read, else null.
  _readQuick() {
    if (!this.enabled) {
      this._scheduleEnd(null);
      return { focused: false, source: "none", mode: null };
    }
    try {
      const system = this.native()?.systemFocusStatus;
      if (system == "focused" || system == "notFocused") {
        this._scheduleEnd(null);
        return { focused: system == "focused", source: "system", mode: null };
      }
    } catch (e) {
      // Fall through to the database.
    }
    if (!this.databaseDir) {
      this._scheduleEnd(null);
      return { focused: false, source: "none", mode: null };
    }
    return null;
  },

  async _readDatabase(dir) {
    try {
      const json = await IOUtils.readJSON(PathUtils.join(dir, ASSERTIONS));
      const now = Date.now();
      const found = focusFromAssertions(json, now);
      this._scheduleEnd(found.focused ? found.until : null, now);
      return { focused: found.focused, source: "database", mode: found.mode };
    } catch (e) {
      // Missing, unreadable (privacy settings) or not JSON: no Focus.
      this._scheduleEnd(null);
      return { focused: false, source: "unreadable", mode: null };
    }
  },

  // A Focus with an end: read again then (macOS may not touch the file).
  _scheduleEnd(until, now = Date.now()) {
    lazy.clearTimeout(endTimer);
    endTimer = null;
    if (until == null) {
      return;
    }
    const delay = Math.min(Math.max(until - now, 0) + 1000, MAX_TIMER_MS);
    endTimer = lazy.setTimeout(() => {
      endTimer = null;
      this.refresh();
    }, delay);
  },

  _set(next) {
    const changed = next.focused != state.focused;
    state = next;
    if (changed) {
      Services.obs.notifyObservers(null, STATE_TOPIC, next.focused ? "on" : "off");
    }
    if (!this.quiet) {
      this._flush();
    }
  },

  /**
   * For an unprompted toast: true when it should wait (a Focus is on, or
   * the first read isn't done), in which case `show` runs again once it
   * can (with `win`, or the frontmost window if that one closed). One
   * waiting toast per `key`.
   *
   * @param {Window} win
   * @param {string} key
   * @param {(win: Window) => void} show
   */
  holdToast(win, key, show) {
    if (!this.enabled || !this.supported) {
      return false;
    }
    this.init();
    if (loaded && !state.focused) {
      return false;
    }
    // Until the first read lands, or until Focus ends (_set flushes).
    held.set(key, { win, show });
    return true;
  },

  _flush() {
    if (!held.size) {
      return;
    }
    const waiting = [...held.values()];
    held.clear();
    for (const { win, show } of waiting) {
      const target = win && !win.closed ? win : lazy.BrowserWindowTracker.getTopWindow();
      if (!target) {
        continue;
      }
      try {
        show(target);
      } catch (e) {
        console.error("Whimsy: a toast held for Focus", e);
      }
    }
  },

  observe(subject, topic, data) {
    if (topic == NATIVE_TOPIC) {
      if (this.enabled) {
        this.refresh();
      }
    } else if (topic == "nsPref:changed" && data == FEATURE_PREF) {
      if (this.enabled) {
        this.start();
      } else {
        this.stop();
      }
    } else if (topic == "quit-application-granted") {
      try {
        this.native()?.stopWatching();
      } catch (e) {
        // Shutting down.
      }
    }
  },

  // Tests: back to before init().
  _reset() {
    try {
      this.native()?.stopWatching();
    } catch (e) {
      // Not watching.
    }
    if (initialized && this.supported) {
      Services.obs.removeObserver(this, NATIVE_TOPIC);
      Services.prefs.removeObserver(FEATURE_PREF, this);
      Services.obs.removeObserver(this, "quit-application-granted");
    }
    initialized = false;
    lazy.clearTimeout(endTimer);
    endTimer = null;
    held.clear();
    state = { focused: false, source: "none", mode: null };
    loaded = false;
    refreshing = null;
    newReady();
  },
};
