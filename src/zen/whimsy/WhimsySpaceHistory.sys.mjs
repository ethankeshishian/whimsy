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
  WhimsyQuickWindow: "resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs",
});
// Places can notify a visit up to this long before the tab's location
// change lands (slow commits, busy startup); later attempts let it catch up.
const RECORD_ATTEMPTS_MS = [250, 1000, 2500];
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
          this.captureOpenVisit(visit);
          // Places and progress notifications can arrive in either order.
          // A few one-shot tasks let the location change catch up; the
          // first one that finds a snapshot records it, the rest no-op.
          for (const delay of RECORD_ATTEMPTS_MS) {
            setTimeout(() => {
              this.enqueue(() => this.recordVisit(visit)).catch(console.error);
            }, delay);
          }
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
  // A space by id from any window: spaces are shared between windows, and
  // a window that has none of its own (Mini Whimsy, popups) still has
  // visits that belong to one.
  findSpace(spaceId) {
    if (!spaceId) {
      return null;
    }
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      const space = win.gZenWorkspaces?.getWorkspaceFromId?.(spaceId);
      if (space) {
        return space;
      }
    }
    return null;
  },
  // Which space a browser's navigation belongs to, or "" when nowhere.
  // Every way a page can be shown resolves to the space it's shown in:
  // - an essential is shared by every space, so its visit is in whichever
  //   space is showing it (its zen-workspace-id can be another space's);
  // - a Glance always opens over the active space, whatever its parent;
  // - a tab whose id isn't a known space falls back to the window's
  //   active space, except at startup, before the window's spaces load,
  //   when the id is kept and resolved when the visit is recorded;
  // - a window without spaces (Mini Whimsy, a site's popup) belongs to
  //   the page that opened it, or to the space Mini Whimsy would move into.
  spaceIdFor(win, browser, tab, depth = 0) {
    const spaces = win.gZenWorkspaces;
    const hasSpaces = !!spaces?.workspaceEnabled && !win._whimsyQuickWindow;
    const active = hasSpaces ? spaces.activeWorkspace || "" : "";
    if (hasSpaces) {
      if (tab.hasAttribute("zen-essential") || tab.hasAttribute("zen-glance-tab")) {
        return active;
      }
      const own = tab.getAttribute("zen-workspace-id");
      if (own && (spaces.getWorkspaceFromId(own) || !spaces.getWorkspaces().length)) {
        return own;
      }
      return active;
    }
    const opener = browser.browsingContext?.opener?.top?.embedderElement;
    const openerWin = opener?.documentGlobal;
    const openerTab = openerWin?.gBrowser?.getTabForBrowser?.(opener);
    if (openerTab && openerWin !== win && depth < 3) {
      return this.spaceIdFor(openerWin, opener, openerTab, depth + 1);
    }
    if (win._whimsyQuickWindow) {
      return lazy.WhimsyQuickWindow.defaultSpaceId(win) || "";
    }
    const main = Services.wm.getMostRecentNonPBWindow?.("navigator:browser") ||
      Services.wm.getMostRecentWindow("navigator:browser");
    return main && main !== win && main.gZenWorkspaces?.workspaceEnabled ?
      main.gZenWorkspaces.activeWorkspace || "" : "";
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
    const spaceId = this.spaceIdFor(win, browser, tab);
    const space = this.findSpace(spaceId);
    // A space that isn't loaded yet (session restore at startup) keeps its
    // id; recordVisit names it, or drops it if it never turns up.
    if (!spaceId || space?.whimsyScratch) {
      return;
    }
    const now = Date.now();
    this._candidates = this._candidates.filter(item => now - item.time < 10000);
    // A snapshot taken for a known Places visit belongs to that visit only;
    // an earlier visit to the same URL must not consume it.
    this._candidates.push({ url: uri.spec, time: now,
      spaceId, spaceName: space?.name || "", ...(visitId == null ? {} : { visitId }) });
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
    if (!candidates.length || new Set(candidates.map(item => item.spaceId)).size !== 1) {
      return;
    }
    const candidate = candidates.reduce((a, b) =>
      Math.abs(a.time - visit.time) < Math.abs(b.time - visit.time) ? a : b);
    const file = await this.file();
    if (!this.recording || file.data.visits[visit.id]) {
      return;
    }
    // A snapshot taken before its window's spaces loaded is named now; one
    // whose space never turned up (or is Scratch) is left unattributed.
    const space = this.findSpace(candidate.spaceId);
    const spaceName = space?.name || candidate.spaceName;
    if (space?.whimsyScratch || !spaceName) {
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
    file.data.visits[visit.id] = { id: visit.id, time: visit.time,
      guid: visit.guid, spaceId: candidate.spaceId, spaceName };
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
        AND (:search = '' OR AUTOCOMPLETE_MATCH(:search, p.url, p.title,
          NULL, 1, 1, 1, 1, :matchBehavior, :searchBehavior, NULL))
      ORDER BY ${sort === "mostvisited" ? "visits DESC," : ""} v.visit_date DESC, v.id DESC
      LIMIT :limit`, {
      metadata: JSON.stringify(file.data.visits), space: spaceId,
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
