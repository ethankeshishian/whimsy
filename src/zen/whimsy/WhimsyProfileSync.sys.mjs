/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave5/profiles: per-profile facts that must reach every device signed into
// the same Firefox Account, carried by Firefox Sync's prefs engine (the
// Sync-backed store in this tree that Whimsy can write to without touching
// Zen's files). Each map is one synced string pref:
//
//   { "<id>": ["<value or null>", <ms timestamp>], ... }
//
// with null as a tombstone. The prefs engine replaces the whole pref on a
// download, so each map also keeps a local cache file holding the same
// entries; every change on either side is merged entry by entry —
// the newer timestamp wins, an exact tie goes to the smaller JSON value —
// and the merge is written to both, so devices converge whatever order the
// syncs happen in. Tombstones and old entries age out; the newest entries
// are kept when a map is over its size cap.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  JSONFile: "resource://gre/modules/JSONFile.sys.mjs",
});

/** Deterministic per-entry merge of two maps (see the banner). */
export function mergeEntries(a = {}, b = {}) {
  const out = { ...a };
  for (const [id, entry] of Object.entries(b)) {
    const mine = out[id];
    if (!Array.isArray(entry) || entry.length != 2) {
      continue;
    }
    if (!Array.isArray(mine)) {
      out[id] = entry;
      continue;
    }
    if (entry[1] > mine[1] ||
        (entry[1] == mine[1] && JSON.stringify(entry[0]) < JSON.stringify(mine[0]))) {
      out[id] = entry;
    }
  }
  return out;
}

export class WhimsySyncedMap {
  /**
   * @param {object} o
   * @param {string} o.pref - the synced pref (needs services.sync.prefs.sync.<pref>)
   * @param {string} o.file - the local cache file name in the profile folder
   * @param {number} [o.maxEntries]
   * @param {number} [o.maxAgeMs] - drop entries (and tombstones) older than this
   * @param {number} [o.tombstoneMs]
   */
  constructor({ pref, file, maxEntries = 5000, maxAgeMs = Infinity, tombstoneMs = 60 * 86400000 }) {
    this.pref = pref;
    this.fileName = file;
    this.maxEntries = maxEntries;
    this.maxAgeMs = maxAgeMs;
    this.tombstoneMs = tombstoneMs;
    this._listeners = new Set();
    this._writing = 0;
  }

  get file() {
    if (!this._file) {
      this._file = new lazy.JSONFile({
        path: PathUtils.join(PathUtils.profileDir, this.fileName),
        dataPostProcessor: data => ({ entries: data?.entries || {} }),
      });
      this._file.ensureDataReady();
      this._startObserving();
      this.sync();
    }
    return this._file;
  }

  readPref() {
    try {
      const value = JSON.parse(Services.prefs.getStringPref(this.pref, "") || "{}");
      return value && typeof value == "object" ? value : {};
    } catch {
      return {};
    }
  }

  prune(entries, now = Date.now()) {
    let list = Object.entries(entries).filter(([, [value, time]]) =>
      now - time < (value === null ? this.tombstoneMs : this.maxAgeMs));
    if (list.length > this.maxEntries) {
      list.sort((x, y) => y[1][1] - x[1][1]);
      list = list.slice(0, this.maxEntries);
    }
    return Object.fromEntries(list);
  }

  /** Merges the synced pref and the cache, and writes the result to both. */
  sync() {
    const file = this._file ?? this.file;
    const merged = this.prune(mergeEntries(file.data.entries, this.readPref()));
    const json = JSON.stringify(merged);
    if (JSON.stringify(file.data.entries) != json) {
      file.data.entries = merged;
      file.saveSoon();
    }
    const current = Services.prefs.getStringPref(this.pref, "");
    const wanted = Object.keys(merged).length ? json : "";
    if (current != wanted) {
      this._writing++;
      try {
        if (wanted) {
          Services.prefs.setStringPref(this.pref, wanted);
        } else {
          Services.prefs.clearUserPref(this.pref);
        }
      } finally {
        this._writing--;
      }
    }
    for (const listener of this._listeners) {
      try {
        listener();
      } catch (e) {
        console.error(e);
      }
    }
  }

  _startObserving() {
    // An incoming sync (or another window) rewrote the pref: merge it.
    Services.prefs.addObserver(this.pref, () => {
      if (!this._writing) {
        this.sync();
      }
    });
  }

  onChange(listener) {
    this._listeners.add(listener);
  }

  get(id) {
    const entry = this.file.data.entries[id];
    return Array.isArray(entry) ? entry[0] : undefined;
  }

  /** When an entry last changed (ms), or 0. */
  time(id) {
    const entry = this.file.data.entries[id];
    return Array.isArray(entry) ? entry[1] : 0;
  }

  /** Sets (or, with null, deletes) one entry, stamped now. */
  set(id, value, time = Date.now()) {
    const entries = this.file.data.entries;
    const entry = entries[id];
    if (Array.isArray(entry) && JSON.stringify(entry[0]) == JSON.stringify(value)) {
      return;
    }
    entries[id] = [value, Math.max(time, (entry?.[1] ?? 0) + 1)];
    this.file.saveSoon();
    this.sync();
  }

  entries() {
    return Object.entries(this.file.data.entries)
      .filter(([, [value]]) => value !== null)
      .map(([id, [value]]) => [id, value]);
  }
}
