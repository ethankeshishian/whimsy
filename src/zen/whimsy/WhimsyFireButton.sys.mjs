/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The point (DuckDuckGo's Fire Button, which this follows): one press ends
// the session you're in, closing its tabs and erasing the traces they left,
// so you can start fresh.
//
// W23 memory-fire redesign: three separate rows (This Profile / Everywhere /
// Forget About This Site) become one row with remembered settings: a range
// (Last hour / Today / 7 days / All time), a space scope (this profile's
// spaces, picked one by one, or every space everywhere) and a checklist of
// what to erase, AI data included. The settings persist in whimsy.fire.last
// (JSON) and are reused next time without re-asking, except that pressing
// still asks once more, inside the same surface, for the riskiest choices:
// All time, All spaces, or Memory. "Forget About This Site…" is unrelated
// (it isn't ending a session) and keeps its own command and flow.
//
// Build-plan answer: pinned tabs and Essentials survive (DuckDuckGo's
// Fireproof): they're left out of the close step, not the clear.
//
// Security review H2: burned tabs must not come back. Each burn closes its
// tabs FIRST, with skipSessionStore (so they never enter the closed-tab
// list, the Archive or Undo), forgets the closed tabs/windows in its scope
// that are already there, writes the session file, and only then clears
// data.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ForgetAboutSite: "moz-src:///toolkit/components/forgetaboutsite/ForgetAboutSite.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  Sanitizer: "resource:///modules/Sanitizer.sys.mjs",
  SessionSaver: "moz-src:///browser/components/sessionstore/SessionSaver.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  WhimsyAIStore: "resource:///modules/whimsy/WhimsyAIStore.sys.mjs",
  WhimsyArchive: "resource:///modules/whimsy/WhimsyArchive.sys.mjs",
  WhimsyFormDrafts: "resource:///modules/whimsy/WhimsyFormProtection.sys.mjs",
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
  WhimsySpaceHistory: "resource:///modules/whimsy/WhimsySpaceHistory.sys.mjs",
  WhimsySpaceLock: "resource:///modules/whimsy/WhimsySpaceLock.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
  WhimsyUndo: "resource:///modules/whimsy/WhimsyUndo.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.fire-button";
const LAST_PREF = "whimsy.fire.last";
const PANEL_ID = "whimsyFirePanel";
const PANEL_WIDTH = 420;
const FLAME_ICON = "chrome://browser/skin/zen-icons/selectable/flame.svg";
const WORKING_TIMEOUT_MS = 120 * 1000;
const DONE_TIMEOUT_MS = 6000;
const DAY_MS = 86400000;
const RANGES = ["hour", "today", "week", "all"];
// "Today's browsing items plus that hour's AI chats..." (fire-2.1): the
// first-time AI items use the same hour as the browsing default, not the
// browsing range, which is why ranges are stored once and applied to both.
// fire-2.1: Browsing in the mockup's order (open tabs, history, cookies and
// sign-ins, cache, form and search history, closed tabs and the Archive,
// the download list), then the AI's own.
const DEFAULT_ITEMS = {
  tabs: true, history: true, cookies: true, cache: true, form: true, closed: true, downloads: false,
  aiChats: true, agentActivity: true, index: true, memory: false, routineResults: false,
};
const ITEM_IDS = Object.keys(DEFAULT_ITEMS);
// The small words after an item: what it keeps, or that it isn't per profile.
const ITEM_DETAILS = {
  downloads: "whimsy-fire-item-downloads-detail",
  form: "whimsy-fire-item-form-detail",
};
// "Forget everything…" (Settings › AI, turned off) opens Fire with only
// these ticked, range All time, this profile (fire dec-16).
const AI_ITEM_IDS = ["aiChats", "agentActivity", "index", "memory", "routineResults"];
// What Fire never erases, now including the AI items themselves
// (providers, connectors, commands, routines; fire dec-10).
const KEPT_IDS = ["passwords", "bookmarks", "files", "permissions", "essentials", "ai-settings"];

const FORGET_FLAGS =
  Ci.nsIClearDataService.CLEAR_HISTORY |
  Ci.nsIClearDataService.CLEAR_COOKIES_AND_SITE_DATA |
  Ci.nsIClearDataService.CLEAR_ALL_CACHES |
  Ci.nsIClearDataService.CLEAR_DOWNLOADS;
const SITE_FLAGS = Ci.nsIClearDataService.CLEAR_COOKIES_AND_SITE_DATA | Ci.nsIClearDataService.CLEAR_ALL_CACHES;

function siteOfURL(url) {
  try {
    const uri = Services.io.newURI(url);
    if (!/^https?$/.test(uri.scheme)) {
      return null;
    }
    try {
      return Services.eTLD.getBaseDomain(uri);
    } catch {
      return uri.host || null;
    }
  } catch {
    return null;
  }
}

function siteOf(tab) {
  const uri = tab.linkedBrowser?.currentURI;
  if (!uri || !/^https?$/.test(uri.scheme)) {
    return null;
  }
  try {
    return Services.eTLD.getBaseDomain(uri);
  } catch {
    return uri.host || null;
  }
}

function clearData(sinceMs = null) {
  return new Promise(resolve => {
    const callback = { onDataDeleted: resolve };
    if (sinceMs == null) {
      Services.clearData.deleteData(FORGET_FLAGS, callback);
    } else {
      const now = Date.now();
      Services.clearData.deleteDataInTimeRange((now - sinceMs) * 1000, now * 1000, true, FORGET_FLAGS, callback);
    }
  });
}

// Last hour / today (local midnight) / 7 days / all time, as a duration in
// ms (null for all time).
function rangeMs(range) {
  if (range == "hour") {
    return 60 * 60 * 1000;
  }
  if (range == "week") {
    return 7 * DAY_MS;
  }
  if (range == "today") {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    return Date.now() - midnight.getTime();
  }
  return null;
}

function defaultSettings() {
  return { range: "hour", allSpaces: false, spaceIds: null, items: { ...DEFAULT_ITEMS } };
}

function loadSettings() {
  try {
    const saved = JSON.parse(Services.prefs.getStringPref(LAST_PREF, ""));
    const d = defaultSettings();
    if (!saved || typeof saved != "object") {
      return d;
    }
    return {
      range: RANGES.includes(saved.range) ? saved.range : d.range,
      allSpaces: !!saved.allSpaces,
      spaceIds: Array.isArray(saved.spaceIds) ? saved.spaceIds : null,
      items: { ...d.items, ...(saved.items && typeof saved.items == "object" ? saved.items : {}) },
    };
  } catch {
    return defaultSettings();
  }
}

function saveSettings(settings) {
  Services.prefs.setStringPref(LAST_PREF, JSON.stringify(settings));
}

// Firefox's Sanitizer takes a range as [from, to] in microseconds; null
// clears all time.
function sanitizerRange(since) {
  return since == null ? null : [since * 1000, Date.now() * 1000];
}

function anyItemOn(settings) {
  return ITEM_IDS.some(id => settings.items[id]);
}

// Asks once more, inside the same surface, only for the riskiest choices.
function needsConfirm(settings) {
  return settings.range == "all" || settings.allSpaces || settings.items.memory;
}

export const WhimsyFireButton = {
  forgetFlags: FORGET_FLAGS,
  siteFlags: SITE_FLAGS,
  ITEM_IDS,
  RANGES,

  clearData(sinceMs = null) {
    return clearData(sinceMs);
  },

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  lastSettings() {
    return loadSettings();
  },

  initWindow(win) {
    const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
    WhimsyCommands.register(win, {
      id: "cmd_whimsyFireButton",
      l10nId: "whimsy-action-fire-button",
      l10nArgs: () => this.summaryArgs(win, loadSettings()),
      run: w => this.openPanel(w),
      icon: "chrome://browser/skin/forget.svg",
      isAvailable: () => this.enabled,
    });
    // wave7/fire: the per-site clear that left the sheet. Not part of ending
    // a session, so it lives here, named as Firefox names it.
    WhimsyCommands.register(win, {
      id: "cmd_whimsyForgetSite",
      l10nId: "whimsy-action-forget-site",
      run: w => this.forgetSite(w),
      icon: "chrome://browser/skin/forget.svg",
      isAvailable: w => this.enabled && !!siteOf(w.gBrowser.selectedTab),
    });
  },

  // The command-bar row's tag: what pressing it (then ⌘Return to repeat)
  // will do, in words.
  // What Fire will do with `settings`, as Fluent args (range, scope, and
  // the profile's name): the command row's tag and the toasts' titles
  // select their words from these (whimsy-action-fire-button,
  // whimsy-fire-working-burn, whimsy-fire-done-burn-title).
  summaryArgs(win, settings = loadSettings()) {
    const range = ["hour", "today", "week", "all"].includes(settings.range) ? settings.range : "hour";
    if (settings.allSpaces) {
      return { range, scope: "all", profile: "" };
    }
    const profile = this.scopeName(win, settings);
    return { range, scope: profile ? "named" : "this", profile };
  },

  // The spaces a burn acts on (fire-2.3): every visible space, the ones
  // picked under Change (any profile's), or by default the current
  // profile's.
  scopeSpaces(win, settings) {
    if (settings.allSpaces) {
      return this.visibleSpaces(win);
    }
    if (settings.spaceIds?.length) {
      const picked = this.visibleSpaces(win).filter(space => settings.spaceIds.includes(space.uuid));
      if (picked.length) {
        return picked;
      }
    }
    return this.profileSpaces(win, this.profileId(win));
  },

  // The profiles (containers) the picked spaces use.
  scopeProfiles(win, settings) {
    const ids = [...new Set(this.scopeSpaces(win, settings).map(space => lazy.WhimsyProfiles.profileIdOfSpace(space)))];
    return ids.length ? ids : [this.profileId(win)];
  },

  // How the scope reads: a whole profile by its name, else the spaces'
  // names ("Work and Side Projects").
  scopeName(win, settings) {
    const spaces = this.scopeSpaces(win, settings);
    const [id] = this.scopeProfiles(win, settings);
    if (this.scopeProfiles(win, settings).length == 1 && spaces.length == this.profileSpaces(win, id).length) {
      return lazy.WhimsyProfiles.nameOf(id) || "";
    }
    return new Intl.ListFormat(Services.locale.appLocalesAsBCP47[0] ?? "en", { type: "conjunction" })
      .format(spaces.map(space => space.name || "").filter(Boolean));
  },

  // Whether a picked space shares its profile with one left out: cookies
  // and site data are per profile, so those spaces lose theirs too.
  scopeIsPartial(win, settings) {
    if (settings.allSpaces) {
      return false;
    }
    const spaces = this.scopeSpaces(win, settings);
    return this.scopeProfiles(win, settings).some(id =>
      this.profileSpaces(win, id).some(space => !spaces.includes(space)));
  },

  closableTabs(win, tabs) {
    return tabs.filter(tab => tab && !tab.pinned && !tab.hasAttribute("zen-essential") && !tab.closing);
  },

  // Closes tabs for good: no closed-tab entry (Cmd+Shift+T, Recently
  // Closed), no Archive entry (it skips skipSessionStore closes) and no
  // Undo. Returns how many closed.
  burnTabs(win, tabs, reason) {
    const closable = this.closableTabs(win, tabs);
    if (closable.length) {
      lazy.WhimsyUndo.runSuppressed(() =>
        win.gBrowser.removeTabs(closable, { animate: false, skipSessionStore: true }));
    }
    return closable.length;
  },

  // Forgets already-closed tabs and windows that `matches(tabState,
  // closedAt)` accepts, in every ordinary window, then writes the session
  // file so none of them stay on disk. wave9/secfix (security-full-1 H2):
  // the Archive's and Snooze's own stores too, so nothing burned can be
  // restored from History → Closed, View Archive or a snooze waking up.
  async purgeClosed(matches) {
    const SS = lazy.SessionStore;
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      if (w.closed || lazy.PrivateBrowsingUtils.isWindowPrivate(w)) {
        continue;
      }
      for (const item of SS.getClosedTabDataForWindow(w)) {
        if (matches(item.state ?? {}, item.closedAt ?? 0)) {
          try {
            SS.forgetClosedTabById(item.closedId, w);
          } catch (e) {
            console.error("Whimsy: fire forget closed tab", e);
          }
        }
      }
    }
    for (const winData of SS.getClosedWindowData()) {
      const tabs = [...(winData.tabs ?? []), ...(winData._closedTabs ?? []).map(item => item.state ?? {})];
      if (tabs.some(tab => matches(tab, winData.closedAt ?? 0))) {
        try {
          SS.forgetClosedWindowById(winData.closedId);
        } catch (e) {
          console.error("Whimsy: fire forget closed window", e);
        }
      }
    }
    try {
      await lazy.WhimsyArchive.purge(matches);
    } catch (e) {
      console.error("Whimsy: fire purge archive", e);
    }
    await lazy.SessionSaver.run();
  },

  // The profile (container id) the current space uses; 0 is Default.
  profileId(win) {
    return lazy.WhimsyProfiles.activeProfileId(win);
  },

  // Every non-scratch space, hidden ones included only while unlocked
  // (fire dec-11: Fire never unlocks one).
  visibleSpaces(win) {
    return lazy.WhimsyProfiles.spaces(win).filter(space =>
      !space.whimsyScratch && !(space.whimsyHidden && lazy.WhimsySpaceLock.isCovered(space.uuid)));
  },

  // The spaces a profile-scoped burn would act on: every space of the
  // profile when spaceIds is null/empty, else just those (a partial pick).
  profileSpaces(win, id = this.profileId(win), spaceIds = null) {
    const all = this.visibleSpaces(win).filter(space => lazy.WhimsyProfiles.profileIdOfSpace(space) === id);
    return spaceIds?.length ? all.filter(space => spaceIds.includes(space.uuid)) : all;
  },

  // Every tab, in every ordinary window, that lives in one of `spaces`:
  // [[window, tabs], ...].
  tabsOfSpaces(win, spaces) {
    const uuids = new Set(spaces.map(space => space.uuid));
    const result = [];
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      if (w.closed || !w.gBrowser || lazy.PrivateBrowsingUtils.isWindowPrivate(w)) {
        continue;
      }
      const tabs = (w.gZenWorkspaces?.allStoredTabs ?? w.gBrowser.tabs).filter(t =>
        uuids.has(t.getAttribute("zen-workspace-id")) && !t.hasAttribute("zen-empty-tab"));
      if (tabs.length) {
        result.push([w, tabs]);
      }
    }
    return result;
  },

  profileTabs(win, id = this.profileId(win)) {
    return this.tabsOfSpaces(win, this.profileSpaces(win, id));
  },

  // History visits of a profile since `since` (ms since the epoch, or 0
  // for all time), as the History profile filter sees them.
  async profileVisits(id, since) {
    const rows = await lazy.WhimsySpaceHistory.query({
      profile: lazy.WhimsyProfiles.keyFor(id), days: (Date.now() - (since || 0)) / DAY_MS, limit: 100000,
    });
    return since ? rows.filter(row => row.date.getTime() >= since) : rows;
  },

  // One visit, not the page: other profiles' visits to the same URL stay.
  removeVisit(visit) {
    const ms = visit.date.getTime();
    return lazy.PlacesUtils.history.removeVisitsByFilter({
      url: visit.url, beginDate: new Date(ms), endDate: new Date(ms + 1),
    });
  },

  // Cookies, site data and cache for one site (base domain, subdomains and
  // its partitioned third-party data), in one container only.
  clearSiteData(site, userContextId, flags = SITE_FLAGS) {
    return new Promise(resolve => {
      Services.clearData.deleteDataFromSite(site, { userContextId, privateBrowsingId: 0 }, true, flags, {
        onDataDeleted: resolve,
      });
    });
  },

  // Form & search history (and search bar/find bar text); only run when
  // every space everywhere is in scope (it isn't per-container).
  clearFormHistory() {
    return lazy.Sanitizer.sanitize(["formdata"]);
  },

  // Firefox's Sanitizer items ("history", "cookies", "offlineApps",
  // "cache", "formdata", "downloads"), each over `range` (see
  // sanitizerRange). Gecko's cache can't clear by time, so with a range
  // "cache" empties it, as Firefox's own Clear Recent History does.
  sanitize(items, range) {
    return lazy.Sanitizer.sanitize(items, { range });
  },

  // Every profile's history visits since `since` (ms; null for all time).
  clearHistory(since) {
    return since == null
      ? lazy.PlacesUtils.history.clear()
      : lazy.PlacesUtils.history.removeVisitsByFilter({ beginDate: new Date(since), endDate: new Date() });
  },

  allTabs() {
    const result = [];
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      if (!w.closed && w.gBrowser && !lazy.PrivateBrowsingUtils.isWindowPrivate(w)) {
        result.push([w, (w.gZenWorkspaces?.allStoredTabs ?? w.gBrowser.tabs).filter(t => !t.hasAttribute("zen-empty-tab"))]);
      }
    }
    return result;
  },

  // fire-2.1: the red note says, before the press, exactly what goes: "Closes
  // 7 tabs and erases history, AI chats, and agent activity from the last
  // hour, in Work. Can't be undone." Words from Fluent; only the list's
  // conjunction is built here, with Intl.ListFormat.
  async summarize(win, settings, note) {
    const token = (note._whimsyToken = (note._whimsyToken ?? 0) + 1);
    const { tabs } = await this.counts(win, settings);
    const ids = ITEM_IDS.filter(id => id != "tabs" && settings.items[id]);
    const words = ids.length ? await win.document.l10n.formatValues(ids.map(id => ({ id: id == "history" ? "whimsy-fire-done-history" : `whimsy-fire-done-item-${id}` }))) : [];
    if (token != note._whimsyToken) {
      return;
    }
    const list = words.length ? new Intl.ListFormat(Services.locale.appLocalesAsBCP47[0] ?? "en", { type: "conjunction" }).format(words) : "";
    const args = { ...this.summaryArgs(win, settings), tabs, list };
    const id = tabs && list ? "whimsy-fire-summary-both" : tabs ? "whimsy-fire-summary-close" : list ? "whimsy-fire-summary-erase" : "whimsy-fire-cant-undo";
    win.document.l10n.setAttributes(note, id, args);
  },

  // What settings would close, for the summary and the disabled state.
  async counts(win, settings) {
    const sum = groups => groups.reduce((n, [w, tabs]) => n + this.closableTabs(w, tabs).length, 0);
    const spaces = this.scopeSpaces(win, settings);
    return {
      tabs: settings.items.tabs ? sum(this.tabsOfSpaces(win, spaces)) : 0,
      spaces,
    };
  },

  // Runs one Fire with `settings` (see loadSettings): closes tabs, then
  // clears what's ticked, within the range and space scope. H2: tabs close
  // and are forgotten first; only then does anything else clear.
  async burn(win, settings) {
    const since = rangeMs(settings.range) == null ? null : Date.now() - rangeMs(settings.range);
    const range = sanitizerRange(since);
    const items = settings.items;
    const spaces = this.scopeSpaces(win, settings);
    const profiles = settings.allSpaces ? [] : this.scopeProfiles(win, settings);
    const scopeTabs = items.tabs || (!settings.allSpaces && (items.cookies || items.cache)) ? this.tabsOfSpaces(win, spaces) : [];
    // Sites the scope's tabs used in the range, per profile, read before
    // the tabs close.
    const tabSites = new Map(profiles.map(id => [id, new Set()]));
    if (!settings.allSpaces && (items.cookies || items.cache)) {
      const profileOf = new Map(spaces.map(space => [space.uuid, lazy.WhimsyProfiles.profileIdOfSpace(space)]));
      for (const [, tabs] of scopeTabs) {
        for (const tab of tabs) {
          const site = (since == null || (tab.lastAccessed || 0) >= since) ? siteOf(tab) : null;
          tabSites.get(profileOf.get(tab.getAttribute("zen-workspace-id")))?.add(site);
        }
      }
    }
    let tabCount = 0;
    if (items.tabs) {
      for (const [w, tabs] of scopeTabs) {
        tabCount += this.burnTabs(w, tabs, "fire");
      }
    }
    if (items.closed) {
      await this.purgeClosed((tab, closedAt) =>
        (since == null || closedAt >= since) &&
        (settings.allSpaces || profiles.includes(tab.userContextId || 0)));
    }

    let visitCount = 0, siteCount = 0;
    if (settings.allSpaces) {
      // Every profile: Firefox's Sanitizer, one item per box, over the range.
      // History goes through Places, not the Sanitizer's "history": Gecko's
      // history flag also wipes every closed tab and window (session
      // history), which is the Closed tabs and Archive box's job.
      if (items.history) {
        await this.clearHistory(since);
      }
      const names = [
        ...(items.cookies ? ["cookies", "offlineApps"] : []),
        ...(items.cache ? ["cache"] : []),
        ...(items.form ? ["formdata"] : []),
        ...(items.downloads ? ["downloads"] : []),
      ];
      if (names.length) {
        await this.sanitize(names, range);
      }
      if (items.history) {
        visitCount = -1; // Unknown exactly; the toast says "history" generically.
      }
    } else {
      // Cookies, site data and cache are per profile (container): cleared
      // for the sites its spaces used in the range; history visit by visit.
      const flags = (items.cookies ? Ci.nsIClearDataService.CLEAR_COOKIES_AND_SITE_DATA : 0) |
        (items.cache ? Ci.nsIClearDataService.CLEAR_ALL_CACHES : 0);
      for (const id of profiles) {
        const visits = items.history || flags ? await this.profileVisits(id, since) : [];
        const sites = new Set([...tabSites.get(id)].filter(Boolean));
        if (flags) {
          for (const visit of visits) {
            const site = siteOfURL(visit.url);
            if (site) {
              sites.add(site);
            }
          }
          await Promise.all([...sites].map(site => this.clearSiteData(site, id, flags)));
          if (items.cookies) {
            siteCount += sites.size;
          }
        }
        if (items.history) {
          await Promise.all(visits.map(visit => this.removeVisit(visit)));
          visitCount += visits.length;
        }
      }
      // Form history and the download list aren't kept per profile; the
      // rows say so (whimsy-fire-item-*-detail).
      const shared = [...(items.form ? ["formdata"] : []), ...(items.downloads ? ["downloads"] : [])];
      if (shared.length) {
        await this.sanitize(shared, range);
      }
    }
    if (items.tabs) {
      if (settings.allSpaces) {
        await lazy.WhimsyFormDrafts.forgetAll();
      } else {
        for (const id of profiles) {
          await lazy.WhimsyFormDrafts.forgetContainer(id);
        }
      }
    }
    const kinds = [];
    if (settings.items.aiChats) {
      kinds.push("chats", "reports");
    }
    if (settings.items.agentActivity) {
      kinds.push("activity");
    }
    if (settings.items.index) {
      kinds.push("index");
    }
    if (settings.items.memory) {
      kinds.push("memory");
    }
    if (settings.items.routineResults) {
      kinds.push("routineResults");
    }
    if (kinds.length) {
      await lazy.WhimsyAIStore.clear({ since, kinds });
    }
    return {
      tabs: tabCount, visits: visitCount, sites: siteCount,
      profile: settings.allSpaces ? null : this.scopeName(win, settings),
      items: ITEM_IDS.filter(i => settings.items[i]),
    };
  },

  // "Forget About This Site…" (command bar): ForgetAboutSite takes the base
  // domain, so every subdomain's history and data go, and its tabs close.
  async burnSite(win) {
    const site = siteOf(win.gBrowser.selectedTab);
    if (!site) {
      return { tabs: 0 };
    }
    let count = 0;
    for (const [w, tabs] of this.allTabs(win)) {
      count += this.burnTabs(w, tabs.filter(t => siteOf(t) == site), "site");
    }
    await this.purgeClosed(tab => (tab.entries ?? []).some(entry => siteOfURL(entry.url) == site));
    await lazy.ForgetAboutSite.removeDataFromBaseDomain(site);
    await lazy.WhimsyFormDrafts.forgetSite(site);
    return { tabs: count };
  },

  // "Forget About This Site…": its own small surface (W10-30: it replaced
  // the system dialog), unrelated to the Fire settings above since it
  // isn't ending a session. Nothing runs until its button; no second ask.
  forgetSite(win) {
    const site = siteOf(win.gBrowser.selectedTab);
    if (!site) {
      return null;
    }
    const doc = win.document;
    const parts = lazy.WhimsySurface.create(win, {
      id: PANEL_ID, width: 360, titleL10nId: "whimsy-fire-site-heading", close: true, footer: true,
      className: "whimsy-fire whimsy-fire-site",
    });
    const { panel, view, footer, title } = parts;
    doc.l10n.setAttributes(title, "whimsy-fire-site-heading", { site });
    const body = doc.createElementNS("http://www.w3.org/1999/xhtml", "p");
    doc.l10n.setAttributes(body, "whimsy-fire-site-body", { site });
    view.append(body);
    const cancel = lazy.WhimsySurface.footerButton(doc, {
      l10nId: "whimsy-fire-cancel", id: "whimsy-fire-cancel", onCommand: () => lazy.WhimsySurface.close(panel),
    });
    const forget = lazy.WhimsySurface.footerButton(doc, {
      l10nId: "whimsy-fire-run-site", l10nArgs: { site }, id: "whimsy-fire-forget", destructive: true,
      onCommand: () => {
        lazy.WhimsySurface.close(panel);
        this.run(win, () => this.burnSite(win), "site", { site });
      },
    });
    footer.append(cancel, forget);
    lazy.WhimsySurface.finish(parts);
    lazy.WhimsySurface.open(win, panel, { at: "page-center" });
    return panel;
  },

  // A private window: that window only, with a fresh session; never
  // crosses between private and normal (fire dec-8). No profile, spaces
  // or items picker; just a single confirm.
  //
  // Verified assumption (handoff risk #7): Firefox's private browsing
  // session (originAttributes.privateBrowsingId) is ONE shared cookie jar
  // and cache across every private window, not one per window (see
  // WhimsyPrivate.sys.mjs's header comment) — Gecko wipes it all together
  // when the last private tab anywhere closes ("last-pb-context-exited").
  // There is no id to scope a clear to just this window, so an explicit
  // Services.clearData call here would reach every OTHER private window
  // too, which "that window only" forbids. Closing this window's tabs
  // (skipSessionStore, below) is itself that window's fresh session; when
  // it was the only private window open, Gecko's own automatic wipe has
  // already run by the time this returns.
  async burnPrivateWindow(win) {
    const tabs = (win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs).filter(t => !t.hasAttribute("zen-empty-tab"));
    const count = this.burnTabs(win, tabs, "private");
    win.BrowserCommands?.openTab?.() ?? win.gBrowser.addTrustedTab("about:privatebrowsing", { inBackground: false });
    return { tabs: count };
  },

  // W10-30: a WhimsySurface (the Edit Look family). One row of settings
  // (range, scope, items) replaces the old three cards; the explicit red
  // button always says "Can't be undone", and the riskiest choices (All
  // time, All spaces, Memory) ask once more inside the same surface.
  panel(win, { settings = loadSettings(), aiOnly = false } = {}) {
    const doc = win.document;
    const isPrivate = lazy.PrivateBrowsingUtils.isWindowPrivate(win);
    let step = "choose";
    const parts = lazy.WhimsySurface.create(win, {
      id: PANEL_ID,
      width: PANEL_WIDTH,
      titleL10nId: "whimsy-fire-heading",
      close: true,
      footer: true,
      className: "whimsy-fire",
      onEscape: () => {
        if (step == "confirm") {
          showChoose();
          return true;
        }
        return false;
      },
    });
    const { panel, view, footer, title } = parts;

    if (isPrivate) {
      return this.privatePanel(win, parts);
    }

    const body = doc.createXULElement("vbox");
    body.className = "whimsy-fire-step whimsy-fire-settings";
    const current = {
      ...settings,
      items: aiOnly
        ? Object.fromEntries(ITEM_IDS.map(id => [id, AI_ITEM_IDS.includes(id)]))
        : { ...settings.items },
    };

    // fire-2.1: each part under its own small heading.
    const heading = (l10nId, trailing = null) => {
      const row = doc.createXULElement("hbox");
      row.className = "whimsy-fire-heading-row";
      row.setAttribute("align", "baseline");
      const h = doc.createElementNS("http://www.w3.org/1999/xhtml", "h3");
      h.className = "whimsy-fire-heading";
      h.id = `${l10nId}-heading`;
      doc.l10n.setAttributes(h, l10nId);
      row.append(h);
      if (trailing) {
        row.append(trailing);
      }
      return { row, h };
    };

    // Range: a segmented control, Firefox's Clear Recent History buckets.
    const rangeHead = heading("whimsy-fire-range-label");
    const rangeSeg = lazy.WhimsySurface.seg(doc, {
      name: "whimsy-fire-range",
      options: RANGES.map(r => ({ value: r, l10nId: `whimsy-fire-range-${r}` })),
      onPick: v => {
        current.range = v;
        rangeSeg.select(v);
        refresh();
      },
    });
    rangeSeg.group.id = "whimsy-fire-range";
    rangeSeg.group.setAttribute("aria-labelledby", rangeHead.h.id);
    rangeSeg.select(current.range);

    // Scope (fire-2.3): the picked spaces in one row, and Change opens a
    // menu of every space by profile, which stays open while you tick.
    const scopeHead = heading("whimsy-fire-spaces-heading");
    const scopeGroup = doc.createXULElement("hbox");
    scopeGroup.className = "whimsy-fire-scope-group whimsy-fire-box";
    scopeGroup.setAttribute("align", "center");
    const scopeIcons = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    scopeIcons.className = "whimsy-fire-scope-icons";
    scopeIcons.setAttribute("aria-hidden", "true");
    const scopeText = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    scopeText.className = "whimsy-fire-scope-text";
    scopeText.id = "whimsy-fire-scope-text";
    const scopeName = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    scopeName.className = "whimsy-fire-scope-name";
    const scopeDetail = doc.createElementNS("http://www.w3.org/1999/xhtml", "small");
    scopeDetail.className = "whimsy-fire-scope-detail";
    scopeText.append(scopeName, scopeDetail);
    const change = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
    change.type = "button";
    change.id = "whimsy-fire-spaces-change";
    change.className = "whimsy-surface-dropdown whimsy-fire-spaces-change";
    change.setAttribute("aria-haspopup", "listbox");
    change.setAttribute("aria-expanded", "false");
    change.setAttribute("aria-describedby", scopeText.id);
    const changeText = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    changeText.className = "whimsy-surface-dropdown-value";
    doc.l10n.setAttributes(changeText, "whimsy-fire-spaces-change");
    const chevron = doc.createXULElement("image");
    chevron.className = "whimsy-surface-dropdown-chevron";
    chevron.setAttribute("src", "chrome://global/skin/icons/arrow-down.svg");
    change.append(changeText, chevron);
    change.addEventListener("click", event => {
      event.stopPropagation();
      change.setAttribute("aria-expanded", "true");
      this.openSpacesMenu(win, {
        anchor: change,
        current,
        onChange: () => refresh(),
        onHidden: () => change.setAttribute("aria-expanded", "false"),
      });
    });
    scopeGroup.append(scopeIcons, scopeText, change);
    const partialNote = doc.createElementNS("http://www.w3.org/1999/xhtml", "p");
    partialNote.className = "whimsy-fire-partial-note";
    doc.l10n.setAttributes(partialNote, "whimsy-fire-partial-note");

    // Items, in two boxes: browsing traces, then the AI's own.
    const itemsList = doc.createXULElement("vbox");
    itemsList.className = "whimsy-fire-items";
    const groups = [
      ["whimsy-fire-group-browsing", ITEM_IDS.filter(id => !AI_ITEM_IDS.includes(id))],
      ["whimsy-fire-group-ai", ITEM_IDS.filter(id => AI_ITEM_IDS.includes(id))],
    ];
    const counts = [];
    for (const [l10nId, ids] of groups) {
      const count = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
      count.className = "whimsy-fire-group-count";
      counts.push({ count, ids });
      const head = heading(l10nId, count);
      const box = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      box.className = "whimsy-fire-box whimsy-fire-grid";
      box.setAttribute("role", "group");
      box.setAttribute("aria-labelledby", head.h.id);
      for (const id of ids) {
        const r = this.checkRow(doc, `whimsy-fire-item-${id}`, current.items[id], on => {
          current.items[id] = on;
          refresh();
        }, ITEM_DETAILS[id]);
        box.append(r.row);
      }
      itemsList.append(head.row, box);
    }

    const kept = doc.createXULElement("hbox");
    kept.className = "whimsy-fire-kept";
    kept.setAttribute("align", "start");
    const check = doc.createXULElement("image");
    check.className = "whimsy-fire-kept-icon";
    check.setAttribute("src", "chrome://global/skin/icons/check.svg");
    const keptText = doc.createElementNS("http://www.w3.org/1999/xhtml", "p");
    keptText.id = "whimsy-fire-kept";
    doc.l10n.setAttributes(keptText, "whimsy-fire-kept");
    kept.append(check, keptText);

    // What Fire is about to do can't be undone: said in red, before the press.
    const undone = doc.createXULElement("hbox");
    undone.className = "whimsy-fire-undone";
    undone.setAttribute("align", "start");
    const flame = doc.createXULElement("image");
    flame.className = "whimsy-fire-undone-icon";
    flame.setAttribute("src", FLAME_ICON);
    const undoneNote = doc.createElementNS("http://www.w3.org/1999/xhtml", "p");
    undoneNote.className = "whimsy-fire-undone-note";
    doc.l10n.setAttributes(undoneNote, "whimsy-fire-cant-undo");
    undone.append(flame, undoneNote);

    body.append(rangeHead.row, rangeSeg.group, scopeHead.row, scopeGroup, partialNote, itemsList, undone, kept);

    // Step 2: the extra ask for the riskiest choices.
    const confirm = doc.createXULElement("hbox");
    confirm.className = "whimsy-fire-step whimsy-fire-confirm";
    confirm.setAttribute("align", "start");
    confirm.hidden = true;
    const confirmText = doc.createXULElement("vbox");
    confirmText.setAttribute("flex", "1");
    const confirmTitle = doc.createElementNS("http://www.w3.org/1999/xhtml", "h2");
    confirmTitle.id = "whimsy-fire-confirm-title";
    confirmTitle.className = "whimsy-fire-confirm-title";
    doc.l10n.setAttributes(confirmTitle, "whimsy-fire-confirm-title-2");
    const confirmBody = doc.createElementNS("http://www.w3.org/1999/xhtml", "p");
    confirmBody.className = "whimsy-fire-confirm-body";
    doc.l10n.setAttributes(confirmBody, "whimsy-fire-confirm-body-2");
    confirmText.append(confirmTitle, confirmBody);
    confirm.append(lazy.WhimsySurface.tile(doc, { icon: FLAME_ICON, tone: "destructive" }), confirmText);
    view.append(body, confirm);

    const cancel = lazy.WhimsySurface.footerButton(doc, {
      l10nId: "whimsy-fire-cancel", id: "whimsy-fire-cancel",
      onCommand: () => lazy.WhimsySurface.close(panel),
    });
    const forget = lazy.WhimsySurface.footerButton(doc, {
      l10nId: "whimsy-fire-run", id: "whimsy-fire-forget", destructive: true,
      onCommand: () => this.pressFire(win, panel, current),
    });
    const back = lazy.WhimsySurface.footerButton(doc, {
      l10nId: "whimsy-fire-back", id: "whimsy-fire-back", primary: true,
      onCommand: () => showChoose(),
    });
    const accept = lazy.WhimsySurface.footerButton(doc, {
      l10nId: "whimsy-fire-confirm-accept-2", id: "whimsy-fire-confirm-accept", destructive: true,
      onCommand: () => {
        lazy.WhimsySurface.close(panel);
        saveSettings(current);
        this.run(win, () => this.burn(win, current), "burn", this.summaryArgs(win, current));
      },
    });
    back.hidden = true;
    accept.hidden = true;
    footer.append(cancel, forget, back, accept);
    lazy.WhimsySurface.finish(parts);

    const showChoose = () => {
      step = "choose";
      panel.dataset.step = step;
      title.hidden = false;
      body.hidden = false;
      confirm.hidden = true;
      cancel.hidden = forget.hidden = false;
      back.hidden = accept.hidden = true;
      panel.setAttribute("aria-labelledby", title.id);
      if (panel.state == "open") {
        back.focus();
      }
    };
    const showConfirm = () => {
      step = "confirm";
      panel.dataset.step = step;
      title.hidden = true;
      body.hidden = true;
      confirm.hidden = false;
      cancel.hidden = forget.hidden = true;
      back.hidden = accept.hidden = false;
      panel.setAttribute("aria-labelledby", confirmTitle.id);
      if (panel.state == "open") {
        back.focus();
      }
    };
    panel._whimsyFireConfirm = showConfirm;
    panel._whimsyFireChoose = showChoose;
    panel._whimsyFireCurrent = () => current;

    const refresh = () => {
      const spaces = this.scopeSpaces(win, current);
      scopeIcons.textContent = spaces.map(space => space.icon).filter(Boolean).slice(0, 4).join(" ");
      if (current.allSpaces) {
        doc.l10n.setAttributes(scopeName, "whimsy-fire-scope-all");
        doc.l10n.setAttributes(scopeDetail, "whimsy-fire-scope-all-detail");
      } else {
        scopeName.removeAttribute("data-l10n-id");
        scopeName.textContent = new Intl.ListFormat(Services.locale.appLocalesAsBCP47[0] ?? "en", { type: "conjunction" })
          .format(spaces.map(space => space.name || "").filter(Boolean));
        const ids = this.scopeProfiles(win, current);
        if (ids.length == 1) {
          doc.l10n.setAttributes(scopeDetail, "whimsy-fire-scope-profile", { profile: lazy.WhimsyProfiles.nameOf(ids[0]) || "" });
        } else {
          doc.l10n.setAttributes(scopeDetail, "whimsy-fire-scope-profiles", { count: ids.length });
        }
      }
      partialNote.hidden = !this.scopeIsPartial(win, current);
      const nothing = !anyItemOn(current);
      forget.disabled = nothing;
      // fire-2.7: the label gains an ellipsis when pressing it asks once more.
      doc.l10n.setAttributes(forget, needsConfirm(current) ? "whimsy-fire-run-ask" : "whimsy-fire-run");
      for (const { count, ids } of counts) {
        doc.l10n.setAttributes(count, "whimsy-fire-group-count", { on: ids.filter(id => current.items[id]).length, total: ids.length });
      }
      this.summarize(win, current, undoneNote).catch(e => console.error("Whimsy: Fire summary", e));
    };
    refresh();
    return panel;
  },

  // A labelled checkbox row (plain HTML, inside the Whimsy surface; not a
  // native popup list).
  checkRow(doc, l10nId, checked, onChange, detailL10nId = null) {
    const row = doc.createElementNS("http://www.w3.org/1999/xhtml", "label");
    row.className = "whimsy-fire-check-row";
    const input = doc.createElementNS("http://www.w3.org/1999/xhtml", "input");
    input.type = "checkbox";
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));
    const label = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    if (l10nId) {
      doc.l10n.setAttributes(label, l10nId);
    }
    row.append(input, label);
    if (detailL10nId) {
      // "Form and search history · every profile": the words and their
      // detail wrap as one line of text, each with its own Fluent id.
      const text = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
      text.className = "whimsy-fire-check-text";
      const detail = doc.createElementNS("http://www.w3.org/1999/xhtml", "small");
      detail.className = "whimsy-fire-check-detail";
      doc.l10n.setAttributes(detail, detailL10nId);
      text.append(label, detail);
      row.append(text);
    }
    return { row, input, label };
  },

  // fire-2.3: Change's menu. All spaces, then each profile's spaces with
  // checks (hidden ones only while unlocked); it stays open while you
  // tick, and Esc or a click outside closes it. Edits `current` in place.
  openSpacesMenu(win, { anchor, current, onChange, onHidden = null }) {
    const doc = win.document;
    const XHTML = "http://www.w3.org/1999/xhtml";
    const visible = this.visibleSpaces(win);
    const activeUuid = win.gZenWorkspaces?.activeWorkspace;
    const parts = lazy.WhimsySurface.create(win, {
      id: "whimsyFireSpacesMenu",
      width: 260,
      className: "whimsy-surface-listbox-panel whimsy-fire-spaces-menu",
      onHidden,
      initialFocus: () => list.querySelector("[role=option]"),
    });
    const list = doc.createElementNS(XHTML, "div");
    list.className = "whimsy-surface-listbox";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-multiselectable", "true");
    doc.l10n.setAttributes(list, "whimsy-fire-spaces-menu");
    const rows = [];
    const option = (value, { l10nId = null, l10nArgs = null, text = null, detailL10nId = null, detailArgs = null }) => {
      const row = doc.createElementNS(XHTML, "div");
      row.className = "whimsy-surface-option";
      row.setAttribute("role", "option");
      row.dataset.value = value;
      row.tabIndex = rows.length ? -1 : 0;
      const check = doc.createXULElement("image");
      check.className = "whimsy-surface-option-check";
      check.setAttribute("src", "chrome://global/skin/icons/check.svg");
      const label = doc.createElementNS(XHTML, "span");
      label.className = "whimsy-surface-option-label";
      if (l10nId) {
        doc.l10n.setAttributes(label, l10nId, l10nArgs);
      } else {
        label.textContent = text;
      }
      row.append(check, label);
      if (detailL10nId) {
        const d = doc.createElementNS(XHTML, "span");
        d.className = "whimsy-surface-option-detail";
        doc.l10n.setAttributes(d, detailL10nId, detailArgs);
        row.append(d);
      }
      const toggle = () => {
        this.toggleSpace(win, current, value);
        sync();
        onChange();
      };
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", event => {
        if (event.key == "Enter" || event.key == " ") {
          event.preventDefault();
          toggle();
        } else if (event.key == "ArrowDown" || event.key == "ArrowUp") {
          event.preventDefault();
          const at = rows.indexOf(row) + (event.key == "ArrowDown" ? 1 : -1);
          rows[Math.max(0, Math.min(rows.length - 1, at))]?.focus();
        }
      });
      rows.push(row);
      list.append(row);
    };
    option("all", { l10nId: "whimsy-fire-scope-all", detailL10nId: "whimsy-fire-spaces-menu-count", detailArgs: { count: visible.length } });
    const profiles = [...new Set(visible.map(space => lazy.WhimsyProfiles.profileIdOfSpace(space)))];
    for (const id of profiles) {
      list.append(lazy.WhimsySurface.rule(doc));
      const caption = doc.createElementNS(XHTML, "div");
      caption.className = "whimsy-fire-spaces-menu-profile";
      caption.setAttribute("role", "presentation");
      doc.l10n.setAttributes(caption, "whimsy-fire-spaces-menu-profile", { profile: lazy.WhimsyProfiles.nameOf(id) || "" });
      list.append(caption);
      for (const space of visible.filter(sp => lazy.WhimsyProfiles.profileIdOfSpace(sp) === id)) {
        option(space.uuid, {
          text: [space.icon, space.name].filter(Boolean).join(" "),
          detailL10nId: space.uuid == activeUuid ? "whimsy-fire-spaces-menu-current" : null,
        });
      }
    }
    list.append(lazy.WhimsySurface.rule(doc));
    const foot = doc.createElementNS(XHTML, "p");
    foot.className = "whimsy-fire-spaces-menu-note";
    doc.l10n.setAttributes(foot, "whimsy-fire-spaces-menu-note");
    list.append(foot);
    const sync = () => {
      const picked = new Set(this.scopeSpaces(win, current).map(space => space.uuid));
      for (const row of rows) {
        const on = row.dataset.value == "all" ? !!current.allSpaces : !current.allSpaces && picked.has(row.dataset.value);
        row.setAttribute("aria-selected", on ? "true" : "false");
      }
    };
    sync();
    parts.view.append(list);
    lazy.WhimsySurface.open(win, parts.panel, { anchor, position: "after_end", y: 4 });
    return parts.panel;
  },

  // One tick in Change's menu. All spaces on covers everything; a space
  // ticked off it leaves every other space. At least one space stays.
  toggleSpace(win, current, value) {
    const visible = this.visibleSpaces(win).map(space => space.uuid);
    if (value == "all") {
      current.allSpaces = !current.allSpaces;
      current.spaceIds = null;
      return;
    }
    const picked = new Set(current.allSpaces ? visible : this.scopeSpaces(win, current).map(space => space.uuid));
    current.allSpaces = false;
    if (picked.has(value)) {
      if (picked.size == 1) {
        return;
      }
      picked.delete(value);
    } else {
      picked.add(value);
    }
    const own = this.profileSpaces(win, this.profileId(win)).map(space => space.uuid);
    const isOwn = picked.size == own.length && own.every(uuid => picked.has(uuid));
    current.spaceIds = isOwn ? null : visible.filter(uuid => picked.has(uuid));
  },

  // A simplified surface for a private window: one question, one button.
  privatePanel(win, parts) {
    const doc = win.document;
    const { panel, view, footer, title } = parts;
    doc.l10n.setAttributes(title, "whimsy-fire-private-heading");
    const body = doc.createElementNS("http://www.w3.org/1999/xhtml", "p");
    doc.l10n.setAttributes(body, "whimsy-fire-private-body");
    view.append(body);
    const cancel = lazy.WhimsySurface.footerButton(doc, {
      l10nId: "whimsy-fire-cancel", id: "whimsy-fire-cancel",
      onCommand: () => lazy.WhimsySurface.close(panel),
    });
    const forget = lazy.WhimsySurface.footerButton(doc, {
      l10nId: "whimsy-fire-private-run", id: "whimsy-fire-forget", destructive: true,
      onCommand: () => {
        lazy.WhimsySurface.close(panel);
        this.run(win, () => this.burnPrivateWindow(win), "private", {});
      },
    });
    footer.append(cancel, forget);
    lazy.WhimsySurface.finish(parts);
    return panel;
  },

  // The red footer button: the riskiest choices ask once more; the rest
  // close the surface and run.
  pressFire(win, panel, settings) {
    if (needsConfirm(settings)) {
      panel._whimsyFireConfirm?.();
      return;
    }
    lazy.WhimsySurface.close(panel);
    saveSettings(settings);
    this.run(win, () => this.burn(win, settings), "burn", this.summaryArgs(win, settings));
  },

  // Says it's clearing at once, runs, then the same toast says what went
  // (or that it failed, with Try Again).
  // `args` fill the toasts' titles; a burn without them describes the last
  // settings, which is what a burn with none runs.
  async run(win, burn, kind, args = kind == "burn" ? this.summaryArgs(win) : {}) {
    const root = win.document.documentElement;
    root.setAttribute("whimsy-fire-burning", "");
    win.setTimeout(() => root.removeAttribute("whimsy-fire-burning"), 700);
    const working = win.gZenUIManager?.toasts?.open(`whimsy-fire-working-${kind}`, {
      key: "whimsy-fire", l10nArgs: args, icon: FLAME_ICON, timeout: WORKING_TIMEOUT_MS,
    });
    const report = async ({ messageId, ...o }) => {
      if (working && !working.closing && !working.closed) {
        working.update({ messageId, ...o, timeout: DONE_TIMEOUT_MS });
        return working;
      }
      await new Promise(resolve => win.setTimeout(resolve, 0));
      return win.closed
        ? null
        : (win.gZenUIManager?.toasts?.open(messageId, { key: "whimsy-fire", ...o, icon: FLAME_ICON, timeout: DONE_TIMEOUT_MS }) ?? null);
    };
    let result;
    try {
      result = (await burn()) || {};
    } catch (e) {
      console.error("Whimsy: fire button", e);
      await report({
        messageId: "whimsy-fire-failed-title",
        l10nArgs: undefined,
        descriptionId: "whimsy-fire-failed-detail",
        buttons: [{ l10nId: "whimsy-fire-retry", command: () => this.run(win, burn, kind, args) }],
      });
      return;
    }
    const summary = await this.describe(win, result);
    await report({
      messageId: `whimsy-fire-done-${kind}-title`,
      l10nArgs: args,
      descriptionId: "whimsy-fire-done-detail",
      descriptionArgs: { summary },
      buttons: null,
    });
  },

  // What a burn() result cleared, for the toast's second line, in two
  // clauses: "Closed 7 tabs · erased 142 visits, sign-ins on 18 sites, and
  // 3 chats". Every word comes from Fluent (ids below); only the list's
  // conjunction is built in code, with Intl.ListFormat, which is
  // locale-aware grammar, not English hardcoded.
  async describe(win, result) {
    const l10n = win.document.l10n;
    const requests = [];
    if (result.visits > 0) {
      requests.push({ id: "whimsy-fire-done-visits", args: { count: result.visits } });
    } else if (result.visits == -1) {
      requests.push({ id: "whimsy-fire-done-history" });
    }
    if (result.sites > 0) {
      requests.push({ id: "whimsy-fire-done-sites", args: { count: result.sites } });
    }
    const itemIds = {
      aiChats: "whimsy-fire-done-item-aiChats", agentActivity: "whimsy-fire-done-item-agentActivity",
      index: "whimsy-fire-done-item-index", memory: "whimsy-fire-done-item-memory",
      routineResults: "whimsy-fire-done-item-routineResults", downloads: "whimsy-fire-done-item-downloads",
      cookies: "whimsy-fire-done-item-cookies", cache: "whimsy-fire-done-item-cache",
      form: "whimsy-fire-done-item-form", closed: "whimsy-fire-done-item-closed",
    };
    for (const id of result.items ?? []) {
      // Counted sign-ins ("sign-ins on 18 sites") already say it.
      if (id == "cookies" && result.sites > 0) {
        continue;
      }
      if (itemIds[id]) {
        requests.push({ id: itemIds[id] });
      }
    }
    const list = requests.length
      ? new Intl.ListFormat(Services.locale.appLocalesAsBCP47[0] ?? "en", { type: "conjunction" }).format(await l10n.formatValues(requests))
      : "";
    if (result.tabs && list) {
      return l10n.formatValue("whimsy-fire-done-closed-erased", { tabs: result.tabs, list });
    }
    if (result.tabs) {
      return l10n.formatValue("whimsy-fire-done-closed", { tabs: result.tabs });
    }
    if (list) {
      return l10n.formatValue("whimsy-fire-done-erased", { list });
    }
    return l10n.formatValue("whimsy-fire-done-nothing");
  },

  // Opens the surface: under `anchor` when given, else over the page where
  // the command bar sits.
  openPanel(win, { anchor = null, triggerEvent = null, aiOnly = false } = {}) {
    const panel = this.panel(win, { aiOnly });
    if (anchor) {
      lazy.WhimsySurface.open(win, panel, { anchor, position: "after_start", y: 6, triggerEvent });
    } else {
      lazy.WhimsySurface.open(win, panel, { at: "page-center", triggerEvent });
    }
    return panel;
  },
};
