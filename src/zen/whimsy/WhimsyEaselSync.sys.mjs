/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave7: Easels on every device signed into the same Firefox Account, the
// way Arc's easels followed the account. Carried by Firefox Sync's prefs
// engine (the Sync-backed store Whimsy can write without touching Zen's or
// Firefox's files): one string pref, whimsy.easel.synced, synced through
// services.sync.prefs.sync.whimsy.easel.synced.
//
//   { "v": 1, "easels": { "<id>": [<easel or null>, <ms timestamp>] } }
//
// An easel is { title, items, updated }; null is a deletion (tombstone).
// The prefs engine replaces the whole pref on a download, so each side
// merges entry by entry: the newer timestamp wins.
//
// Size limits. Every synced pref travels in one Sync record, which the
// server caps (256 KB by default) and which Firefox's other synced prefs
// share; string prefs over 4 KB are also kept out of content processes.
// So: images never sync (an image item stays on the device that has the
// file; a capture keeps its page, crop and container, so Play shows it live
// anywhere); one easel is at most MAX_EASEL_BYTES, after dropping its
// longest drawings if it has to; the whole pref is at most MAX_BYTES,
// most recently edited easels first. An easel over its cap stays local.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  gWhimsyEaselStore: "resource:///modules/whimsy/WhimsyEasel.sys.mjs",
});

export const SYNC_PREF = "whimsy.easel.synced";
export const SYNC_SWITCH_PREF = "whimsy.easel.sync";
const FEATURE_PREF = "whimsy.feature.easel";
// The easel ids this device has written to the synced pref (local only):
// one of those that's gone here was deleted here, not new from elsewhere.
const KNOWN_PREF = "whimsy.easel.sync-known";
export const MAX_BYTES = 64 * 1024;
export const MAX_EASEL_BYTES = 16 * 1024;
const TOMBSTONE_MS = 30 * 86400000;
const UPLOAD_DELAY_MS = 2000;

const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * An easel's items as they sync: no image files, and, when the easel is
 * still too big, without its longest drawings. Returns null when it can't
 * fit at all.
 */
export function syncableEasel(easel, maxBytes = MAX_EASEL_BYTES) {
  let items = (easel.items ?? [])
    .filter(item => item.type != "image")
    .map(item => {
      if (item.type == "capture") {
        const { image, ...rest } = item;
        return rest;
      }
      return item;
    });
  const pack = () => ({ title: easel.title ?? "", items, updated: easel.updated ?? 0 });
  let packed = pack();
  if (bytes(packed) > maxBytes) {
    // Drawings carry the most data; drop the longest first.
    const pens = items.filter(i => i.type == "pen").sort((a, b) => (b.d?.length ?? 0) - (a.d?.length ?? 0));
    for (const pen of pens) {
      items = items.filter(i => i != pen);
      packed = pack();
      if (bytes(packed) <= maxBytes) {
        break;
      }
    }
  }
  return bytes(packed) <= maxBytes ? packed : null;
}

/**
 * The synced map for a list of local easels, newest first within MAX_BYTES,
 * keeping `tombstones` ({id: time}) that are still young.
 */
export function packEasels(easels, tombstones = {}, { maxBytes = MAX_BYTES, maxEaselBytes = MAX_EASEL_BYTES, now = Date.now() } = {}) {
  const out = { v: 1, easels: {} };
  for (const [id, time] of Object.entries(tombstones)) {
    if (now - time < TOMBSTONE_MS) {
      out.easels[id] = [null, time];
    }
  }
  const sorted = [...easels].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  for (const easel of sorted) {
    const packed = syncableEasel(easel, maxEaselBytes);
    if (!packed) {
      continue;
    }
    out.easels[easel.id] = [packed, packed.updated];
    if (bytes(out) > maxBytes) {
      delete out.easels[easel.id];
    }
  }
  return out;
}

export function readSynced(text) {
  try {
    const value = JSON.parse(text || "{}");
    if (value && typeof value == "object" && value.easels && typeof value.easels == "object") {
      return value;
    }
  } catch {}
  return { v: 1, easels: {} };
}

function validEntry(entry) {
  if (!Array.isArray(entry) || entry.length != 2 || !Number.isFinite(entry[1])) {
    return false;
  }
  const [easel] = entry;
  return easel === null || (typeof easel == "object" && Array.isArray(easel.items) && typeof (easel.title ?? "") == "string");
}

export const WhimsyEaselSync = {
  _initialized: false,
  _writing: 0,
  _timer: null,
  _busy: null,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true) && Services.prefs.getBoolPref(SYNC_SWITCH_PREF, true);
  },

  get known() {
    try {
      return new Set(JSON.parse(Services.prefs.getStringPref(KNOWN_PREF, "") || "[]"));
    } catch {
      return new Set();
    }
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    // An incoming sync rewrote the pref: take what's new.
    Services.prefs.addObserver(SYNC_PREF, () => {
      if (!this._writing) {
        this.sync().catch(e => console.error("Whimsy: easel sync", e));
      }
    });
    lazy.setTimeout(() => this.sync().catch(e => console.error("Whimsy: easel sync", e)), 5000);
  },

  scheduleUpload() {
    if (!this._initialized || !this.enabled) {
      return;
    }
    lazy.clearTimeout(this._timer);
    this._timer = lazy.setTimeout(() => this.sync().catch(e => console.error("Whimsy: easel sync", e)), UPLOAD_DELAY_MS);
  },

  /** Takes the synced copy, then writes this device's easels back. */
  async sync() {
    if (!this.enabled) {
      return null;
    }
    // One at a time; a call while one runs waits for it.
    while (this._busy) {
      await this._busy;
    }
    let done;
    this._busy = new Promise(resolve => (done = resolve));
    try {
      return await this._sync();
    } finally {
      this._busy = null;
      done();
    }
  },

  async _sync() {
    const store = lazy.gWhimsyEaselStore;
    const remote = readSynced(Services.prefs.getStringPref(SYNC_PREF, ""));
    const known = this.known;
    const local = new Map((await store.list()).map(e => [e.id, e]));
    const tombstones = {};

    for (const [id, entry] of Object.entries(remote.easels)) {
      if (!validEntry(entry)) {
        continue;
      }
      const [easel, time] = entry;
      const mine = local.get(id);
      if (easel === null) {
        tombstones[id] = time;
        if (mine && (mine.updated ?? 0) <= time) {
          await store.removeRemote(id);
          local.delete(id);
        }
        continue;
      }
      if (!mine) {
        // Written by this device before and gone here since: deleted here.
        if (known.has(id)) {
          tombstones[id] = Date.now();
          continue;
        }
        await store.applyRemote({ id, ...easel, updated: time });
        continue;
      }
      if (time > (mine.updated ?? 0)) {
        await store.applyRemote({ id, ...easel, updated: time });
      }
    }

    const easels = await store.list();
    const packed = packEasels(easels.filter(e => !(e.id in tombstones) || (e.updated ?? 0) > tombstones[e.id]), tombstones);
    const text = Object.keys(packed.easels).length ? JSON.stringify(packed) : "";
    if (text != Services.prefs.getStringPref(SYNC_PREF, "")) {
      this._writing++;
      try {
        if (text) {
          Services.prefs.setStringPref(SYNC_PREF, text);
        } else {
          Services.prefs.clearUserPref(SYNC_PREF);
        }
      } finally {
        this._writing--;
      }
    }
    const ids = JSON.stringify(Object.entries(packed.easels).filter(([, [easel]]) => easel).map(([id]) => id));
    if (ids != Services.prefs.getStringPref(KNOWN_PREF, "")) {
      Services.prefs.setStringPref(KNOWN_PREF, ids);
    }
    return packed;
  },
};
