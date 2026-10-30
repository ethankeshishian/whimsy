/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// batch hist: Places owns the visits; this sidecar stores only their space.
// Never infer a space from a container (several spaces can share one).
import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  JSONFile: "resource://gre/modules/JSONFile.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
  WhimsySyncedMap: "resource:///modules/whimsy/WhimsyProfileSync.sys.mjs",
});
const PREF = "whimsy.feature.space-history";
const TOPIC = "whimsy-space-history-changed";
const EVENTS = ["page-visited", "page-removed", "history-cleared", "purge-caches"];

// Several snapshots that disagree on the space still name one profile only
// when they all carry one.
function allNameAProfile(candidates) {
  return candidates.every(item => item.profile);
}

export const HISTORY_PROFILES_PREF = "whimsy.profiles.history-places";

export const WhimsySpaceHistory = {
  // wave5/profiles: which profiles visited a page (Places guid → profile
  // keys), synced so another device filters the same way. Firefox Sync's
  // history records carry no profile, and the visit sidecar is per device,
  // so this page-level map (recent pages only, newest wins) is what travels.
  get placeProfiles() {
    if (!this._placeProfiles) {
      this._placeProfiles = new lazy.WhimsySyncedMap({
        pref: HISTORY_PROFILES_PREF, file: "whimsy-history-profiles.json",
        maxEntries: 1500, maxAgeMs: 90 * 86400000,
      });
      this._placeProfiles.onChange(() => {
        if (this._filePromise) {
          this.file().then(file => this.rebuildIndex(file)).catch(console.error);
        }
      });
    }
    return this._placeProfiles;
  },
  _candidates: [],
  _queue: Promise.resolve(),
  get enabled() {
    return Services.prefs.getBoolPref(PREF, true);
  },
  get recording() {
    return this.enabled && Services.prefs.getBoolPref("places.history.enabled", true);
  },
  async file() {
    this._filePromise ??= (async () => {
      const file = new lazy.JSONFile({
        path: PathUtils.join(PathUtils.profileDir, "whimsy-space-history.json"),
        dataPostProcessor: data => ({ visits: data?.visits || {} }),
      });
      await file.load();
      await this.rebuildIndex(file).catch(console.error);
      return file;
    })();
    return this._filePromise;
  },
  enqueue(task) {
    const result = this._queue.then(task);
    this._queue = result.catch(console.error);
    return result;
  },
  changed() {
    Services.obs.notifyObservers(null, TOPIC);
  },
  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    this._placesListener = events => {
      // Copy event data before crossing an async boundary.
      for (const event of events) {
        if (event.type === "page-visited") {
          if (event.hidden) {
            continue;
          }
          const visit = { id: event.visitId, time: event.visitTime,
            guid: event.pageGuid, url: event.url };
          this.captureOpenVisit(visit);
          // Places and progress notifications can arrive in either order.
          // A one-shot task lets the corresponding location change catch up.
          setTimeout(() => {
            this.enqueue(() => this.recordVisit(visit)).catch(console.error);
          }, 250);
        } else {
          this.enqueue(() => this.prune()).catch(console.error);
        }
      }
    };
    lazy.PlacesUtils.observers.addListener(EVENTS, this._placesListener);
    this._prefObserver = () => {
      this._candidates = [];
      this.changed();
    };
    Services.prefs.addObserver(PREF, this._prefObserver);
    Services.prefs.addObserver("places.history.enabled", this._prefObserver);
    // Prune stale sidecar entries from expiry/deletion while we were closed.
    IOUtils.exists(PathUtils.join(PathUtils.profileDir, "whimsy-space-history.json"))
      .then(exists => exists && this.enqueue(() => this.prune())).catch(console.error);
  },
  capture(win, browser, uri, visitId = null) {
    if (!this.recording || !uri || !lazy.PlacesUtils.history.canAddURI(uri)) {
      return;
    }
    const tab = win.gBrowser.getTabForBrowser(browser);
    if (!tab || lazy.PrivateBrowsingUtils.isWindowPrivate(win) ||
        browser.browsingContext?.usePrivateBrowsing ||
        lazy.WhimsyPrivate.isPrivateTab(tab)) {
      return;
    }
    const spaces = win.gZenWorkspaces;
    const spaceId = tab.getAttribute("zen-workspace-id") || spaces?.activeWorkspace;
    const space = spaces?.getWorkspaces().find(item => item.uuid === spaceId);
    if (!space || space.whimsyScratch) {
      return;
    }
    // wave5/profiles: the profile is the tab's own container (what Gecko
    // really used), not the space's current one.
    const profile = lazy.WhimsyProfiles.keyFor(tab.userContextId ?? 0);
    const now = Date.now();
    this._candidates = this._candidates.filter(item => now - item.time < 10000);
    // A snapshot taken for a known Places visit belongs to that visit only;
    // an earlier visit to the same URL must not consume it.
    this._candidates.push({ url: uri.spec, time: now,
      spaceId, spaceName: space.name, profile, ...(visitId == null ? {} : { visitId }) });
    this._candidates = this._candidates.slice(-256);
  },
  captureOpenVisit(visit) {
    if (!this.recording) {
      return;
    }
    // Snapshot synchronously, before the queued write: tabs can close or move
    // while Places is being queried. Restored/already-open browsers may not
    // have emitted a location change after initWindow. Only consider browsers
    // displaying this new visit's URL; never backfill older history.
    if (!this._candidates.some(item => item.url === visit.url &&
        (item.visitId == null || item.visitId === visit.id) &&
        Math.abs(item.time - visit.time) < 2000)) {
      for (const win of Services.wm.getEnumerator("navigator:browser")) {
        for (const browser of win.gBrowser?.browsers || []) {
          if (browser.currentURI?.spec === visit.url) {
            this.capture(win, browser, browser.currentURI, visit.id);
          }
        }
      }
    }
  },
  async recordVisit(visit) {
    if (!this.recording) {
      return;
    }
    // Gecko's PlacesVisit has no browsingContext id. Only attribute a visit
    // when the navigation snapshots agree. Concurrent visits to the same URL
    // in different spaces remain unknown, rather than attaching a wrong space.
    const candidates = this._candidates.filter(item => item.url === visit.url &&
      (item.visitId == null || item.visitId === visit.id) &&
      Math.abs(item.time - visit.time) < 2000);
    if (!candidates.length) {
      return;
    }
    // wave5/profiles: two spaces of one profile can't tell the space, but
    // still tell the profile.
    const oneSpace = new Set(candidates.map(item => item.spaceId)).size === 1;
    if (!oneSpace && (!allNameAProfile(candidates) ||
        new Set(candidates.map(item => item.profile)).size !== 1)) {
      return;
    }
    const candidate = candidates.reduce((a, b) =>
      Math.abs(a.time - visit.time) < Math.abs(b.time - visit.time) ? a : b);
    const file = await this.file();
    if (!this.recording) {
      return;
    }
    const db = await lazy.PlacesUtils.promiseDBConnection();
    const live = await db.execute(`SELECT v.id FROM moz_historyvisits v
      JOIN moz_places p ON p.id = v.place_id WHERE v.id = :id
      AND CAST(v.visit_date / 1000 AS INTEGER) = :time AND p.guid = :guid`,
    { id: visit.id, time: visit.time, guid: visit.guid });
    if (!live.length || !this.recording) {
      return;
    }
    // Consume one snapshot per visit. Removing every matching snapshot loses
    // later same-URL visits delivered in the same Places notification batch.
    this._candidates = this._candidates.filter(item => item !== candidate);
    file.data.visits[visit.id] = { id: visit.id, time: visit.time, guid: visit.guid,
      spaceId: oneSpace ? candidate.spaceId : null, spaceName: oneSpace ? candidate.spaceName : null,
      ...(candidate.profile ? { profile: candidate.profile } : {}) };
    this.indexVisit(file.data.visits[visit.id], visit.url);
    if (candidate.profile) {
      const keys = this.placeProfiles.get(visit.guid) ?? [];
      if (!keys.includes(candidate.profile)) {
        this.placeProfiles.set(visit.guid, [...keys, candidate.profile].sort());
      }
    }
    file.saveSoon();
    this.changed();
  },
  async prune() {
    const file = await this.file();
    const db = await lazy.PlacesUtils.promiseDBConnection();
    const rows = await db.execute(`
      SELECT v.id FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id
      JOIN json_each(:metadata) m ON v.id = CAST(m.key AS INTEGER)
        AND CAST(v.visit_date / 1000 AS INTEGER) = json_extract(m.value, '$.time')
        AND p.guid = json_extract(m.value, '$.guid')`,
    { metadata: JSON.stringify(file.data.visits) });
    const live = new Set(rows.map(row => row.getResultByName("id")));
    for (const id of Object.keys(file.data.visits)) {
      if (!live.has(Number(id))) {
        delete file.data.visits[id];
      }
    }
    // Pages gone from history (deleted here, or by history sync) leave the
    // synced page map too.
    const mapped = this.placeProfiles.entries().map(([guid]) => guid);
    if (mapped.length) {
      const existing = new Set((await db.execute(`SELECT guid FROM moz_places
        WHERE guid IN (SELECT value FROM json_each(:guids))`, { guids: JSON.stringify(mapped) }))
        .map(row => row.getResultByName("guid")));
      for (const guid of mapped) {
        // A day's grace: history sync may not have brought the page yet.
        if (!existing.has(guid) && Date.now() - this.placeProfiles.time(guid) > 86400000) {
          this.placeProfiles.set(guid, null);
        }
      }
    }
    await this.rebuildIndex(file);
    file.saveSoon();
    this.changed();
  },
  // wave5/profiles: which profiles visited a URL (and an origin), from the
  // visits recorded since profiles, kept in memory only (the sidecar never
  // copies URLs: they're looked up in Places). Unattributed history isn't in
  // here.
  async rebuildIndex(file) {
    const attributed = Object.values(file.data.visits).filter(visit => visit.profile);
    // Pages other devices attributed (synced), as visit-like entries.
    for (const [guid, keys] of this.placeProfiles.entries()) {
      for (const profile of Array.isArray(keys) ? keys : []) {
        attributed.push({ guid, profile });
      }
    }
    const urls = new Map();
    if (attributed.length) {
      const db = await lazy.PlacesUtils.promiseDBConnection();
      const rows = await db.execute(`SELECT p.guid, p.url FROM moz_places p
        WHERE p.guid IN (SELECT value FROM json_each(:guids))`,
      { guids: JSON.stringify([...new Set(attributed.map(visit => visit.guid))]) });
      for (const row of rows) {
        urls.set(row.getResultByName("guid"), row.getResultByName("url"));
      }
    }
    this._urlProfiles = new Map();
    this._originProfiles = new Map();
    for (const visit of attributed) {
      this.indexVisit(visit, urls.get(visit.guid));
    }
  },
  indexVisit(visit, url) {
    if (!url || !visit?.profile || !this._urlProfiles) {
      return;
    }
    const add = (map, key) => {
      let set = map.get(key);
      if (!set) {
        set = new Set();
        map.set(key, set);
      }
      set.add(visit.profile);
    };
    add(this._urlProfiles, url);
    try {
      add(this._originProfiles, new URL(url).origin);
    } catch {}
  },
  /** Profile keys that visited `url` (or its origin), or null if unknown. */
  profilesFor(url, { origin = false } = {}) {
    if (!this._urlProfiles) {
      return null;
    }
    if (origin) {
      try {
        return this._originProfiles.get(new URL(url).origin) ?? null;
      } catch {
        return null;
      }
    }
    return this._urlProfiles.get(url) ?? null;
  },
  async query({ spaceId = "", search = "", days = 120, sort = "date", limit = 100, profile = "" } = {}) {
    await this._queue;
    const file = await this.file();
    const db = await lazy.PlacesUtils.promiseDBConnection();
    const rows = await db.execute(`
      SELECT v.id, v.visit_date, p.guid, p.url, p.title,
        json_extract(m.value, '$.spaceId') AS space_id,
        json_extract(m.value, '$.spaceName') AS space_name,
        COUNT(*) OVER (PARTITION BY p.id) AS visits
      FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id
      LEFT JOIN json_each(:metadata) m ON v.id = CAST(m.key AS INTEGER)
        AND CAST(v.visit_date / 1000 AS INTEGER) = json_extract(m.value, '$.time')
        AND p.guid = json_extract(m.value, '$.guid')
      WHERE p.hidden = 0 AND v.visit_date >= :cutoff
        AND (:space = '' OR json_extract(m.value, '$.spaceId') = :space
          OR (:space = 'unknown' AND json_extract(m.value, '$.spaceId') IS NULL))
        AND (:profile = '' OR (json_extract(m.value, '$.profile') IS NOT NULL
            AND json_extract(m.value, '$.profile') = :profile)
          OR (json_extract(m.value, '$.profile') IS NULL AND (
            CASE WHEN json_type(:places, '$."' || p.guid || '"') IS NULL THEN :profile = 'default'
              ELSE EXISTS (SELECT 1 FROM json_each(:places, '$."' || p.guid || '"') WHERE value = :profile)
            END)))
        AND (:search = '' OR AUTOCOMPLETE_MATCH(:search, p.url, p.title,
          NULL, 1, 1, 1, 1, :matchBehavior, :searchBehavior, NULL))
      ORDER BY ${sort === "mostvisited" ? "visits DESC," : ""} v.visit_date DESC, v.id DESC
      LIMIT :limit`, {
      metadata: JSON.stringify(file.data.visits), space: spaceId, profile,
      places: JSON.stringify(Object.fromEntries(this.placeProfiles.entries())),
      cutoff: (Date.now() - days * 86400000) * 1000,
      search, limit,
      matchBehavior: Ci.mozIPlacesAutoComplete.MATCH_ANYWHERE_UNMODIFIED,
      searchBehavior: Ci.mozIPlacesAutoComplete.BEHAVIOR_HISTORY,
    });
    return rows.map(row => {
      const get = name => row.getResultByName(name);
      return { visitId: get("id"), guid: `${get("guid")}-${get("id")}`,
        date: new Date(get("visit_date") / 1000), url: get("url"), title: get("title"),
        spaceId: get("space_id"), spaceName: get("space_name") };
    });
  },
  initWindow(win) {
    this._windows ??= new WeakSet();
    if (this._windows.has(win) || !win.gBrowser || lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      return;
    }
    this._windows.add(win);
    this.init();
    const listener = {
      onLocationChange: (browser, progress, request, uri, flags) => {
        if (!progress.isTopLevel || flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_ERROR_PAGE) {
          return;
        }
        this.capture(win, browser, uri);
      },
    };
    win.gBrowser.addTabsProgressListener(listener);
    const restored = event => {
      const browser = event.target.linkedBrowser;
      if (browser) {
        this.capture(win, browser, browser.currentURI);
      }
    };
    win.gBrowser.tabContainer.addEventListener("SSTabRestored", restored);
    win.addEventListener("unload", () => {
      win.gBrowser.removeTabsProgressListener(listener);
      win.gBrowser.tabContainer.removeEventListener("SSTabRestored", restored);
    }, { once: true });
  },
};
