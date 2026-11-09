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
const DEFAULT_ITEMS = {
  tabs: true, history: true, aiChats: true, agentActivity: true, index: true,
  memory: false, routineResults: false, downloads: false,
};
const ITEM_IDS = Object.keys(DEFAULT_ITEMS);
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
    const profile = lazy.WhimsyProfiles.nameOf(this.profileId(win)) || "";
    return { range, scope: profile ? "named" : "this", profile };
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
  clearSiteData(site, userContextId) {
    return new Promise(resolve => {
      Services.clearData.deleteDataFromSite(site, { userContextId, privateBrowsingId: 0 }, true, SITE_FLAGS, {
        onDataDeleted: resolve,
      });
    });
  },

  // Form & search history (and search bar/find bar text); only run when
  // every space everywhere is in scope (it isn't per-container).
  clearFormHistory() {
    return lazy.Sanitizer.sanitize(["formdata"]);
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

  // What settings would close, for the summary and the disabled state.
  async counts(win, settings) {
    const sum = groups => groups.reduce((n, [w, tabs]) => n + this.closableTabs(w, tabs).length, 0);
    const spaces = settings.allSpaces ? this.visibleSpaces(win) : this.profileSpaces(win, this.profileId(win), settings.spaceIds);
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
    const id = this.profileId(win);
    const spaces = settings.allSpaces ? this.visibleSpaces(win) : this.profileSpaces(win, id, settings.spaceIds);
    const groups = settings.items.tabs ? this.tabsOfSpaces(win, spaces) : [];
    let tabCount = 0;
    for (const [w, tabs] of groups) {
      tabCount += this.burnTabs(w, tabs, "fire");
    }
    const burnedIds = settings.allSpaces ? null : id;
    await this.purgeClosed((tab, closedAt) =>
      (since == null || closedAt >= since) &&
      (settings.allSpaces || (tab.userContextId || 0) == burnedIds));

    let visitCount = 0, siteCount = 0;
    if (settings.items.history) {
      if (settings.allSpaces) {
        await clearData(since == null ? null : rangeMs(settings.range));
        visitCount = -1; // Unknown exactly; the toast says "history" generically.
      } else {
        const sites = new Set();
        for (const [, tabs] of groups) {
          for (const tab of tabs) {
            const site = (since == null || (tab.lastAccessed || 0) >= since) ? siteOf(tab) : null;
            if (site) {
              sites.add(site);
            }
          }
        }
        const visits = await this.profileVisits(id, since);
        for (const visit of visits) {
          const site = siteOfURL(visit.url);
          if (site) {
            sites.add(site);
          }
        }
        await Promise.all([...sites].map(site => this.clearSiteData(site, id)));
        await Promise.all(visits.map(visit => this.removeVisit(visit)));
        visitCount = visits.length;
        siteCount = sites.size;
      }
    }
    if (settings.items.downloads) {
      await new Promise(resolve => Services.clearData.deleteData(Ci.nsIClearDataService.CLEAR_DOWNLOADS, { onDataDeleted: resolve }));
    }
    if (settings.allSpaces && settings.items.history) {
      await this.clearFormHistory();
    }
    if (settings.items.tabs) {
      if (settings.allSpaces) {
        await lazy.WhimsyFormDrafts.forgetAll();
      } else {
        await lazy.WhimsyFormDrafts.forgetContainer(id);
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
      profile: settings.allSpaces ? null : lazy.WhimsyProfiles.nameOf(id),
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

    // Range.
    const rangeRow = doc.createXULElement("hbox");
    rangeRow.className = "whimsy-fire-row";
    rangeRow.setAttribute("align", "center");
    const rangeLabel = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    doc.l10n.setAttributes(rangeLabel, "whimsy-fire-range-label");
    const rangeDropdown = lazy.WhimsySurface.dropdown(doc, {
      id: "whimsy-fire-range",
      options: RANGES.map(r => ({ value: r, l10nId: `whimsy-fire-range-${r}` })),
      value: current.range,
      onPick: v => {
        current.range = v;
        refresh();
      },
    });
    rangeRow.append(rangeLabel, rangeDropdown.button);

    // Scope: this profile's spaces (checked off one by one) or every space.
    const scopeGroup = doc.createXULElement("vbox");
    scopeGroup.className = "whimsy-fire-scope-group";
    const allSpacesRow = this.checkRow(doc, "whimsy-fire-all-spaces", current.allSpaces, on => {
      current.allSpaces = on;
      refresh();
    });
    scopeGroup.append(allSpacesRow.row);
    const spacesList = doc.createXULElement("vbox");
    spacesList.className = "whimsy-fire-spaces-list";
    const profileId = this.profileId(win);
    for (const space of this.profileSpaces(win, profileId)) {
      const checked = !current.spaceIds?.length || current.spaceIds.includes(space.uuid);
      const r = this.checkRow(doc, null, checked, on => {
        const all = this.profileSpaces(win, profileId).map(s => s.uuid);
        const set = new Set(current.spaceIds?.length ? current.spaceIds : all);
        if (on) {
          set.add(space.uuid);
        } else {
          set.delete(space.uuid);
        }
        current.spaceIds = set.size == all.length ? null : [...set];
        refresh();
      });
      r.label.textContent = space.name || "";
      spacesList.append(r.row);
    }
    scopeGroup.append(spacesList);
    const partialNote = doc.createElementNS("http://www.w3.org/1999/xhtml", "p");
    partialNote.className = "whimsy-fire-partial-note";
    doc.l10n.setAttributes(partialNote, "whimsy-fire-partial-note");

    // Items.
    const itemsList = doc.createXULElement("vbox");
    itemsList.className = "whimsy-fire-items";
    const itemRows = {};
    for (const id of ITEM_IDS) {
      const r = this.checkRow(doc, `whimsy-fire-item-${id}`, current.items[id], on => {
        current.items[id] = on;
        refresh();
      });
      itemRows[id] = r;
      itemsList.append(r.row);
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

    const undoneNote = doc.createElementNS("http://www.w3.org/1999/xhtml", "p");
    undoneNote.className = "whimsy-fire-undone-note";
    doc.l10n.setAttributes(undoneNote, "whimsy-fire-cant-undo");

    body.append(rangeRow, scopeGroup, partialNote, itemsList, kept, undoneNote);

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
      const fullProfile = this.profileSpaces(win, profileId).length;
      spacesList.hidden = current.allSpaces;
      const chosen = current.spaceIds?.length ?? fullProfile;
      partialNote.hidden = current.allSpaces || chosen >= fullProfile;
      const nothing = !anyItemOn(current);
      forget.disabled = nothing;
      doc.l10n.setAttributes(forget, "whimsy-fire-run");
    };
    refresh();
    return panel;
  },

  // A labelled checkbox row (plain HTML, inside the Whimsy surface; not a
  // native popup list).
  checkRow(doc, l10nId, checked, onChange) {
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
    return { row, input, label };
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
  async run(win, burn, kind, args = {}) {
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

  // What a burn() result cleared, as a locale-formatted list for the
  // toast's second line. Every word comes from Fluent (ids below); only
  // the list's conjunction ("3 tabs, 2 visits, and AI chats") is built in
  // code, with Intl.ListFormat, which is locale-aware grammar, not English
  // hardcoded.
  async describe(win, result) {
    const requests = [];
    if (result.tabs) {
      requests.push({ id: "whimsy-fire-done-tabs", args: { count: result.tabs } });
    }
    if (result.visits > 0) {
      requests.push({ id: "whimsy-fire-done-visits", args: { count: result.visits } });
    } else if (result.visits == -1) {
      requests.push({ id: "whimsy-fire-done-history" });
    }
    const itemIds = {
      aiChats: "whimsy-fire-done-item-aiChats", agentActivity: "whimsy-fire-done-item-agentActivity",
      index: "whimsy-fire-done-item-index", memory: "whimsy-fire-done-item-memory",
      routineResults: "whimsy-fire-done-item-routineResults", downloads: "whimsy-fire-done-item-downloads",
    };
    for (const id of result.items ?? []) {
      if (itemIds[id]) {
        requests.push({ id: itemIds[id] });
      }
    }
    if (!requests.length) {
      return win.document.l10n.formatValue("whimsy-fire-done-nothing");
    }
    const parts = await win.document.l10n.formatValues(requests);
    return new Intl.ListFormat(Services.locale.appLocalesAsBCP47[0] ?? "en", { type: "conjunction" }).format(parts);
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
