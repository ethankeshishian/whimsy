/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W32 perf: dev-only timing of each window's Whimsy init steps. Off unless
// whimsy.perf.marks is true; then each step is timed, shows in the Firefox
// Profiler as a "Whimsy init" marker, and WhimsyPerfMarks.snapshot() returns
// the numbers as JSON (per window: each step's tier and milliseconds, and
// how many steps were planned for each tier). No UI.

const PREF = "whimsy.perf.marks";
// Windows kept in the snapshot, newest last.
const MAX_WINDOWS = 32;

let enabled = null;
let records = new WeakMap();
const recent = [];

function isEnabled() {
  if (enabled === null) {
    enabled = Services.prefs.getBoolPref(PREF, false);
    Services.prefs.addObserver(PREF, () => {
      enabled = Services.prefs.getBoolPref(PREF, false);
    });
  }
  return enabled;
}

function recordFor(win) {
  let record = records.get(win);
  if (!record) {
    let id = 0;
    try {
      id = win.windowUtils.outerWindowID;
    } catch {
      // A window that's already gone.
    }
    record = { id, win: Cu.getWeakReference(win), initMs: null, planned: null, ran: {}, steps: [] };
    records.set(win, record);
    recent.push(record);
    if (recent.length > MAX_WINDOWS) {
      recent.shift();
    }
  }
  return record;
}

export const WhimsyPerfMarks = {
  PREF,

  get enabled() {
    return isEnabled();
  },

  // Runs fn() as the init step `name` of win in `tier` ("window", "idle"
  // or "first-use") and returns its result. Timed only while enabled.
  step(win, name, tier, fn) {
    if (!isEnabled()) {
      return fn();
    }
    const start = ChromeUtils.now();
    try {
      return fn();
    } finally {
      const ms = ChromeUtils.now() - start;
      const record = recordFor(win);
      record.steps.push({ name, tier, ms: Math.round(ms * 1000) / 1000 });
      record.ran[tier] = (record.ran[tier] ?? 0) + 1;
      try {
        ChromeUtils.addProfilerMarker("Whimsy init", { startTime: start, category: "JavaScript" }, `${tier} ${name}`);
      } catch {
        // No profiler in this build.
      }
    }
  },

  // How many steps win planned per tier, and how long its synchronous
  // window init took (startTime from ChromeUtils.now()).
  planned(win, counts, startTime = null) {
    if (!isEnabled()) {
      return;
    }
    const record = recordFor(win);
    record.planned = { ...counts };
    if (startTime !== null) {
      record.initMs = Math.round((ChromeUtils.now() - startTime) * 1000) / 1000;
      try {
        ChromeUtils.addProfilerMarker("Whimsy init", { startTime, category: "JavaScript" }, "window init");
      } catch {
        // No profiler in this build.
      }
    }
  },

  // The record of one window, or null.
  forWindow(win) {
    const record = records.get(win);
    return record ? this.toJSON(record) : null;
  },

  toJSON(record) {
    const win = record.win.get();
    return {
      id: record.id,
      closed: !win || win.closed,
      initMs: record.initMs,
      planned: record.planned ? { ...record.planned } : null,
      ran: { ...record.ran },
      steps: record.steps.map(step => ({ ...step })),
    };
  },

  // Plain JSON of every recent window's steps.
  snapshot() {
    return { enabled: isEnabled(), windows: recent.map(record => this.toJSON(record)) };
  },

  // Tests: forget every record.
  reset() {
    records = new WeakMap();
    recent.length = 0;
  },
};
