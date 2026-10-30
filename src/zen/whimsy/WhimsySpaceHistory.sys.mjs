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
});
const PREF = "whimsy.feature.space-history";
const TOPIC = "whimsy-space-history-changed";
const EVENTS = ["page-visited", "page-removed", "history-cleared", "purge-caches"];

export const WhimsySpaceHistory = {
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
  capture(win, browser, uri) {
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
    const now = Date.now();
    this._candidates = this._candidates.filter(item => now - item.time < 10000);
    this._candidates.push({ url: uri.spec, time: now,
      spaceId, spaceName: space.name });
    this._candidates = this._candidates.slice(-256);
  },
  async recordVisit(visit) {
    if (!this.recording) {
      return;
    }
    // Gecko's PlacesVisit has no browsingContext id. Only attribute a visit
    // when the navigation snapshots agree. Concurrent visits to the same URL
    // in different spaces remain unknown, rather than attaching a wrong space.
    const candidates = this._candidates.filter(item => item.url === visit.url &&
      Math.abs(item.time - visit.time) < 2000);
    if (!candidates.length || new Set(candidates.map(item => item.spaceId)).size !== 1) {
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
    this._candidates = this._candidates.filter(item => !candidates.includes(item));
    file.data.visits[visit.id] = { id: visit.id, time: visit.time,
      guid: visit.guid, spaceId: candidate.spaceId, spaceName: candidate.spaceName };
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
    file.saveSoon();
    this.changed();
  },
  async query({ spaceId = "", search = "", days = 120, sort = "date", limit = 100 } = {}) {
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
          OR (:space = 'unknown' AND m.key IS NULL))
        AND (:search = '' OR instr(lower(COALESCE(p.title, '') || ' ' || p.url), :search) > 0)
      ORDER BY ${sort === "mostvisited" ? "visits DESC," : ""} v.visit_date DESC, v.id DESC
      LIMIT :limit`, {
      metadata: JSON.stringify(file.data.visits), space: spaceId,
      cutoff: (Date.now() - days * 86400000) * 1000,
      search: search.toLowerCase(), limit,
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
    win.addEventListener("unload", () => {
      win.gBrowser.removeTabsProgressListener(listener);
    }, { once: true });
  },
};
