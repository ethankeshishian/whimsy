/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave5/profiles, phase 4: a search engine and a download folder per profile
// (Arc's Settings → Profiles → Search Engine / Default Download Location).
//
// Firefox has one default engine and one download folder, read without any
// tab or window (SearchService.defaultEngine, browser.download.dir), so a
// profile's choice is applied while that profile is in front: the selected
// tab of the frontmost window. Leaving it puts back the person's own
// choice, which Default always uses. While a profile's choice is applied,
// changing Firefox's own setting makes that the new everyday choice. A
// download that starts from a background window's tab follows the front
// window's profile; that's the honest limit of applying a global setting.
//
// Both choices sync (keyed by profile key, WhimsyProfileSync: merged per
// entry, newest wins). A folder that doesn't exist on this Mac, or an engine
// it doesn't have, falls back to the person's own.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
  WhimsySyncedMap: "resource:///modules/whimsy/WhimsyProfileSync.sys.mjs",
});

const ENGINES_PREF = "whimsy.profiles.search-engines";
const DIRS_PREF = "whimsy.profiles.download-dirs";
const SAVED_ENGINE_PREF = "whimsy.profiles.saved-search-engine";
const SAVED_DOWNLOAD_PREF = "whimsy.profiles.saved-download";
const DIR_PREF = "browser.download.dir";
const FOLDER_LIST_PREF = "browser.download.folderList";

export const WhimsyProfileSettings = {
  QueryInterface: ChromeUtils.generateQI(["nsIObserver", "nsISupportsWeakReference"]),
  ENGINES_PREF,
  DIRS_PREF,
  _applying: 0,
  _queue: Promise.resolve(),

  get enabled() {
    return lazy.WhimsyProfiles.enabled;
  },

  // -- stored choices ------------------------------------------------------

  get engines() {
    this._engines ??= new lazy.WhimsySyncedMap({ pref: ENGINES_PREF, file: "whimsy-profile-engines.json" });
    return this._engines;
  },

  get dirs() {
    this._dirs ??= new lazy.WhimsySyncedMap({ pref: DIRS_PREF, file: "whimsy-profile-download-dirs.json" });
    return this._dirs;
  },

  engineFor(key) {
    return this.engines.get(key) || null;
  },

  setEngine(key, engineId) {
    this.engines.set(key, engineId || null);
    return this.applyFront();
  },

  downloadDirFor(key) {
    return this.dirs.get(key) || null;
  },

  setDownloadDir(key, path) {
    this.dirs.set(key, path || null);
    return this.applyFront();
  },

  forget(key) {
    for (const map of [this.engines, this.dirs]) {
      if (map.get(key)) {
        map.set(key, null);
      }
    }
  },

  // -- applying ------------------------------------------------------------

  /** The profile key of what's in front: the top window's selected tab. */
  frontKey() {
    const win = lazy.BrowserWindowTracker.getTopWindow({ private: false });
    const tab = win?.gBrowser?.selectedTab;
    return lazy.WhimsyProfiles.keyFor(tab?.userContextId ?? 0);
  },

  applyFront() {
    const run = this._queue.then(() => this.apply(this.enabled ? this.frontKey() : null));
    this._queue = run.catch(e => console.error("Whimsy: profile settings", e));
    return run;
  },

  // Runs `fn` while marking pref/engine changes as Whimsy's own.
  async quietly(fn) {
    this._applying++;
    try {
      return await fn();
    } finally {
      this._applying--;
    }
  },

  /** Applies `key`'s choices (null: the person's own everywhere). */
  async apply(key) {
    await this.applyEngine(key ? this.engineFor(key) : null);
    let dir = key ? this.downloadDirFor(key) : null;
    // Synced from another Mac where that folder exists, but not here.
    if (dir && !(await IOUtils.exists(dir).catch(() => false))) {
      dir = null;
    }
    await this.applyDownloadDir(dir);
  },

  async applyEngine(engineId) {
    await lazy.SearchService.init();
    const engine = engineId ? lazy.SearchService.getEngineById(engineId) : null;
    const saved = Services.prefs.getStringPref(SAVED_ENGINE_PREF, "");
    if (engine) {
      if (!saved) {
        Services.prefs.setStringPref(SAVED_ENGINE_PREF, lazy.SearchService.defaultEngine.id);
      }
      if (lazy.SearchService.defaultEngine.id != engine.id) {
        await this.quietly(() =>
          lazy.SearchService.setDefault(engine, lazy.SearchService.CHANGE_REASON.USER));
      }
      return;
    }
    if (saved) {
      Services.prefs.clearUserPref(SAVED_ENGINE_PREF);
      const own = lazy.SearchService.getEngineById(saved);
      if (own && lazy.SearchService.defaultEngine.id != own.id) {
        await this.quietly(() =>
          lazy.SearchService.setDefault(own, lazy.SearchService.CHANGE_REASON.USER));
      }
    }
  },

  async applyDownloadDir(path) {
    const savedRaw = Services.prefs.getStringPref(SAVED_DOWNLOAD_PREF, "");
    await this.quietly(() => {
      if (path) {
        if (!savedRaw) {
          const user = name => Services.prefs.prefHasUserValue(name);
          Services.prefs.setStringPref(SAVED_DOWNLOAD_PREF, JSON.stringify({
            dir: user(DIR_PREF) ? Services.prefs.getStringPref(DIR_PREF, "") : null,
            folderList: user(FOLDER_LIST_PREF) ? Services.prefs.getIntPref(FOLDER_LIST_PREF, 1) : null,
          }));
        }
        if (Services.prefs.getStringPref(DIR_PREF, "") != path) {
          Services.prefs.setStringPref(DIR_PREF, path);
        }
        if (Services.prefs.getIntPref(FOLDER_LIST_PREF, 1) != 2) {
          Services.prefs.setIntPref(FOLDER_LIST_PREF, 2);
        }
        return;
      }
      if (!savedRaw) {
        return;
      }
      Services.prefs.clearUserPref(SAVED_DOWNLOAD_PREF);
      let saved = {};
      try {
        saved = JSON.parse(savedRaw);
      } catch {}
      if (typeof saved.dir == "string") {
        Services.prefs.setStringPref(DIR_PREF, saved.dir);
      } else {
        Services.prefs.clearUserPref(DIR_PREF);
      }
      if (Number.isInteger(saved.folderList)) {
        Services.prefs.setIntPref(FOLDER_LIST_PREF, saved.folderList);
      } else {
        Services.prefs.clearUserPref(FOLDER_LIST_PREF);
      }
    });
  },

  // The person changed Firefox's own setting while a profile's was in
  // place: theirs is now the everyday one, nothing to put back.
  observe(subject, topic, data) {
    if (this._applying) {
      return;
    }
    if (topic == "browser-search-engine-modified" && data == "engine-default") {
      Services.prefs.clearUserPref(SAVED_ENGINE_PREF);
    } else if (topic == "nsPref:changed" && (data == DIR_PREF || data == FOLDER_LIST_PREF)) {
      Services.prefs.clearUserPref(SAVED_DOWNLOAD_PREF);
    } else if (topic == "nsPref:changed") {
      this.applyFront();
    }
  },

  initWindow(win) {
    if (!this._initialized) {
      this._initialized = true;
      Services.obs.addObserver(this, "browser-search-engine-modified", true);
      for (const pref of [DIR_PREF, FOLDER_LIST_PREF, ENGINES_PREF, DIRS_PREF,
        lazy.WhimsyProfiles.FEATURE_PREF]) {
        Services.prefs.addObserver(pref, this, true);
      }
      lazy.WhimsyProfiles.onDelete((id, key) => this.forget(key));
    }
    const update = () => this.applyFront();
    win.addEventListener("activate", update);
    win.gBrowser.tabContainer.addEventListener("TabSelect", update);
    win.addEventListener("ZenWorkspacesUIUpdate", update);
    win.addEventListener("unload", () => {
      win.removeEventListener("activate", update);
      win.gBrowser.tabContainer.removeEventListener("TabSelect", update);
      win.removeEventListener("ZenWorkspacesUIUpdate", update);
      // The last window going away: leave the person's own settings behind.
      if (!lazy.WhimsyProfiles.mainWindow()) {
        this._queue = this._queue.then(() => this.apply(null)).catch(console.error);
      }
    }, { once: true });
    update();
  },
};
