/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The point (DuckDuckGo's Fire Button, which this follows): one press ends
// the session you're in, closing its tabs and erasing the traces they left,
// so you can start fresh.
//
// batch8 shipped it as four scopes (This Site / Last 15 Minutes / This Space
// / Everything). wave7/fire narrows it to what serves that point, in the
// user's words:
//   - "Fire in This Profile" (the default): the profile (container) the
//     current space uses. Closes the unpinned tabs of every space in that
//     profile, removes that profile's history visits from the last hour
//     (WhimsySpaceHistory's per-visit profile; unattributed visits count as
//     Default, as the History filter does), and clears cookies, site data
//     and cache for the sites those visits and tabs touched, only in that
//     container. Other profiles keep theirs. (Gecko can't clear one
//     container by time, so it's by site.)
//   - "Fire Everywhere": every profile, all time, behind a second confirm
//     with Cancel as the default.
// Per-site forgetting isn't ending a session; it's Firefox's "Forget About
// This Site" (History), and stays reachable as the "Forget About This Site…"
// command. The old "This Space" scope is the default row now; "Last 15
// Minutes" became the last hour (Clear Recent History has finer ranges).
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
  ContextualIdentityService: "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
  ForgetAboutSite: "moz-src:///toolkit/components/forgetaboutsite/ForgetAboutSite.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  Sanitizer: "resource:///modules/Sanitizer.sys.mjs",
  SessionSaver: "moz-src:///browser/components/sessionstore/SessionSaver.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  WhimsyPanels: "resource:///modules/whimsy/WhimsyPanels.sys.mjs",
  WhimsySpaceHistory: "resource:///modules/whimsy/WhimsySpaceHistory.sys.mjs",
  WhimsyUndo: "resource:///modules/whimsy/WhimsyUndo.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"]));

const FEATURE_PREF = "whimsy.feature.fire-button";
const PANEL_ID = "whimsyFirePanel";
const LAST_HOUR_MS = 60 * 60 * 1000;
// What Everything clears, and exactly what the sheet names: history,
// cookies, site data, cache and the download list. Bookmarks, passwords,
// downloaded files and site permissions stay. Fire in This Profile clears SITE_FLAGS per site, and
// that profile's history visits.
const FORGET_FLAGS =
  Ci.nsIClearDataService.CLEAR_HISTORY |
  Ci.nsIClearDataService.CLEAR_COOKIES_AND_SITE_DATA |
  Ci.nsIClearDataService.CLEAR_ALL_CACHES |
  // The download list (Clear History's "downloads"); files on disk stay.
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

export const WhimsyFireButton = {
  // What Everything clears (the sheet names exactly these), and what the
  // profile fire clears for each site it touched.
  forgetFlags: FORGET_FLAGS,
  siteFlags: SITE_FLAGS,

  // Clears FORGET_FLAGS from the last `sinceMs` (all time when null).
  clearData(sinceMs = null) {
    return clearData(sinceMs);
  },

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  initWindow(win) {
    const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
    WhimsyCommands.register(win, {
      id: "cmd_whimsyFireButton",
      l10nId: "whimsy-action-fire-button",
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
  // file so none of them stay on disk.
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
    await lazy.SessionSaver.run();
  },

  // wave7/fire: "profile" here is just the user-facing word for a space's
  // Zen container (userContextId); there's no profiles feature to ask
  // (WhimsyProfiles was reverted on dev). The current space's own
  // containerTabId; 0 is Default.
  profileId(win) {
    return win.gZenWorkspaces?.getActiveWorkspace?.()?.containerTabId || 0;
  },

  // The spaces using a container, in Zen's order. Several spaces can share
  // one container deliberately (Zen's own Set Profile), so this still
  // looks at every space, not just the active one.
  profileSpaces(win, id = this.profileId(win)) {
    const spaces = win.gZenWorkspaces?.getWorkspaces?.() || [];
    return spaces.filter(space => !space.whimsyScratch && (space.containerTabId || 0) == id);
  },

  // Every tab, in every ordinary window, that lives in one of the
  // container's spaces: [[window, tabs], ...].
  profileTabs(win, id = this.profileId(win)) {
    const uuids = new Set(this.profileSpaces(win, id).map(space => space.uuid));
    const result = [];
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      if (w.closed || !w.gBrowser || lazy.PrivateBrowsingUtils.isWindowPrivate(w)) {
        continue;
      }
      const tabs = w.gBrowser.tabs.filter(t => uuids.has(t.getAttribute("zen-workspace-id")));
      if (tabs.length) {
        result.push([w, tabs]);
      }
    }
    return result;
  },

  // The container's name: the container's own label (Zen's Set Profile),
  // or "Default profile" for userContextId 0 (or one that no longer
  // exists). WhimsySpaceHistory only tracks visits by space, so this
  // merges every space sharing the container.
  nameOf(id) {
    if (id && lazy.ContextualIdentityService.getPublicIdentityFromId(id)) {
      return lazy.ContextualIdentityService.getUserContextLabel(id);
    }
    return lazy.l10n.formatValueSync("whimsy-fire-profile-default-name");
  },

  // History visits of a container's spaces since `since` (ms).
  async profileVisits(win, id, since) {
    const days = (Date.now() - since) / 86400000;
    const rows = [];
    for (const space of this.profileSpaces(win, id)) {
      rows.push(...await lazy.WhimsySpaceHistory.query({ spaceId: space.uuid, days, limit: 100000 }));
    }
    return rows.filter(row => row.date.getTime() >= since);
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

  // The default: fire this profile. Removes its last hour of history,
  // clears the sites it touched in its container only, and closes the
  // unpinned tabs of its spaces. Returns what went, for the toast.
  async burnProfile(win) {
    const id = this.profileId(win);
    const since = Date.now() - LAST_HOUR_MS;
    const groups = this.profileTabs(win, id);
    const visits = await this.profileVisits(win, id, since);
    const sites = new Set();
    for (const visit of visits) {
      const site = siteOfURL(visit.url);
      if (site) {
        sites.add(site);
      }
    }
    for (const [, tabs] of groups) {
      for (const tab of tabs) {
        const site = (tab.lastAccessed || 0) >= since ? siteOf(tab) : null;
        if (site) {
          sites.add(site);
        }
      }
    }
    // H2: close and forget first, then clear.
    let count = 0;
    for (const [w, tabs] of groups) {
      count += this.burnTabs(w, tabs, "profile");
    }
    await this.purgeClosed((tab, closedAt) => (tab.userContextId || 0) == id && closedAt >= since);
    await Promise.all([...sites].map(site => this.clearSiteData(site, id)));
    await Promise.all(visits.map(visit => this.removeVisit(visit)));
    return { count, visits: visits.length, sites: sites.size, profile: this.nameOf(id) };
  },

  // Form & search history (and search bar/find bar text), all time, with
  // Firefox's own Clear History item, so Fire Everywhere covers what Clear
  // All History does. Saved passwords and bookmarks aren't touched.
  clearFormHistory() {
    return lazy.Sanitizer.sanitize(["formdata"]);
  },

  // Every ordinary window's tabs: [[window, tabs], ...].
  allTabs() {
    const result = [];
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      if (!w.closed && w.gBrowser && !lazy.PrivateBrowsingUtils.isWindowPrivate(w)) {
        result.push([w, [...w.gBrowser.tabs]]);
      }
    }
    return result;
  },

  // Fire Everywhere: close every unpinned tab in every window, forget every
  // closed tab and window, then clear (H2: that order).
  async burnEverything(win) {
    let count = 0;
    for (const [w, tabs] of this.allTabs(win)) {
      count += this.burnTabs(w, tabs, "everything");
    }
    await this.purgeClosed(() => true);
    await this.clearData();
    await this.clearFormHistory();
    return count;
  },

  // "Forget About This Site…" (command bar): ForgetAboutSite takes the base
  // domain, so every subdomain's history and data go, and its tabs close.
  async burnSite(win) {
    const site = siteOf(win.gBrowser.selectedTab);
    if (!site) {
      return 0;
    }
    let count = 0;
    for (const [w, tabs] of this.allTabs(win)) {
      count += this.burnTabs(w, tabs.filter(t => siteOf(t) == site), "site");
    }
    await this.purgeClosed(tab => (tab.entries ?? []).some(entry => siteOfURL(entry.url) == site));
    await lazy.ForgetAboutSite.removeDataFromBaseDomain(site);
    return count;
  },

  async forgetSite(win) {
    const site = siteOf(win.gBrowser.selectedTab);
    if (!site) {
      return;
    }
    const [title, body, accept] = await win.document.l10n.formatValues([
      { id: "whimsy-fire-site-confirm-title", args: { site } },
      { id: "whimsy-fire-site-confirm-body", args: { site } },
      { id: "whimsy-fire-site-confirm-accept" },
    ]);
    if (!(await lazy.WhimsyPanels.confirm(win, { title, body, accept, cancelDefault: true }))) {
      return;
    }
    await this.run(win, () => this.burnSite(win), "whimsy-fire-done-site", { site });
  },

  // A WhimsyPanels sheet, centred like the command bar it opens from. Two
  // radio rows say what each closes (with the count); a note under them
  // says exactly what's cleared and what stays; only the red footer button
  // acts, so Return on a row never clears anything.
  panel(win) {
    const { document } = win;
    const { panel, body, footer } = lazy.WhimsyPanels.create(win, {
      id: PANEL_ID,
      titleL10nId: "whimsy-fire-title",
      subtitleL10nId: "whimsy-fire-subtitle",
      size: "medium",
      footer: true,
    });
    const profileId = this.profileId(win);
    const profileCount = this.profileTabs(win, profileId)
      .reduce((sum, [w, tabs]) => sum + this.closableTabs(w, tabs).length, 0);
    const allCount = this.allTabs(win).reduce((sum, [w, tabs]) => sum + this.closableTabs(w, tabs).length, 0);
    const lang = Services.locale.appLocalesAsBCP47;
    const spaceNames = new Intl.ListFormat(lang, { style: "long", type: "conjunction" })
      .format(this.profileSpaces(win, profileId).map(space => space.name).filter(Boolean));
    panel._whimsyFireProfile = this.nameOf(profileId);
    const scopes = [
      {
        id: "profile",
        run: () => this.burnProfile(win),
        icon: "chrome://browser/skin/zen-icons/history.svg",
        subtitleL10nId: spaceNames ? "whimsy-fire-profile-detail" : "whimsy-fire-profile-detail-unnamed",
        subtitleArgs: { count: profileCount, ...(spaceNames ? { spaces: spaceNames } : {}) },
      },
      {
        id: "everything",
        run: () => this.burnEverything(win),
        icon: "chrome://browser/skin/zen-icons/forget.svg",
        subtitleL10nId: "whimsy-fire-everything-detail",
        subtitleArgs: { count: allCount },
        destructive: true,
      },
    ];
    const forget = lazy.WhimsyPanels.footerButton(document, {
      l10nId: "whimsy-fire-forget-profile",
      onCommand: () => this.forget(win, panel),
    });
    forget.id = "whimsy-fire-forget";
    forget.setAttribute("destructive", "true");
    footer.append(forget);
    panel._whimsyFireScopes = new Map();
    for (const scope of scopes) {
      const item = lazy.WhimsyPanels.item(document, {
        l10nId: `whimsy-fire-${scope.id}`,
        icon: scope.icon,
        subtitleL10nId: scope.subtitleL10nId,
        subtitleArgs: scope.subtitleArgs,
        destructive: scope.destructive,
        checked: false,
        onCommand: () => this.selectScope(win, panel, scope.id),
      });
      item.classList.add("whimsy-fire-scope");
      item.setAttribute("role", "radio");
      item.setAttribute("whimsy-fire-scope", scope.id);
      item.dataset.scope = scope.id;
      panel._whimsyFireScopes.set(scope.id, scope);
      body.append(item);
    }
    body.setAttribute("role", "radiogroup");
    document.l10n.formatValue("whimsy-fire-scopes").then(label => body.setAttribute("aria-label", label));
    // What the chosen row clears and keeps, in full (rows crop to a line).
    const summary = document.createXULElement("description");
    summary.id = "whimsy-fire-summary";
    summary.setAttribute("aria-live", "polite");
    body.after(summary);
    return panel;
  },

  // Marks one scope chosen, names it on the footer button, and spells out
  // what it clears in the note.
  selectScope(win, panel, id) {
    const { document } = win;
    for (const item of panel.querySelectorAll(".whimsy-fire-scope")) {
      const on = item.dataset.scope == id;
      item.setAttribute("aria-checked", on ? "true" : "false");
      if (on) {
        item.setAttribute("checked", "true");
      } else {
        item.removeAttribute("checked");
      }
    }
    panel.dataset.scope = id;
    document.l10n.setAttributes(panel.querySelector("#whimsy-fire-forget"), `whimsy-fire-forget-${id}`);
    const summary = panel.querySelector("#whimsy-fire-summary");
    if (summary) {
      document.l10n.setAttributes(summary, `whimsy-fire-${id}-summary`,
        id == "profile" ? { profile: panel._whimsyFireProfile } : null);
    }
  },

  // Flash, run, then say what went (or that it failed).
  async run(win, burn, doneL10nId, args = {}) {
    const root = win.document.documentElement;
    // A brief flame/burst overlay (whimsy-browser.css); reduced motion
    // skips it, and the toast confirms.
    root.setAttribute("whimsy-fire-burning", "");
    win.setTimeout(() => root.removeAttribute("whimsy-fire-burning"), 700);
    let result;
    try {
      result = (await burn()) || 0;
    } catch (e) {
      console.error("Whimsy: fire button", e);
      win.gZenUIManager?.showToast?.("whimsy-fire-failed-toast");
      return;
    }
    // A burn returns the tabs it closed, or { count, ...what else went }.
    const what = typeof result == "number" ? { count: result } : result;
    win.gZenUIManager?.showToast?.(doneL10nId, { l10nArgs: { ...args, ...what } });
  },

  // The footer button: close the sheet, confirm Everything, then run.
  async forget(win, panel) {
    const scope = panel._whimsyFireScopes?.get(panel.dataset.scope);
    if (!scope) {
      return;
    }
    lazy.WhimsyPanels.close(panel);
    // wave7/ux: "Everything" can't be undone, so it asks once more in the
    // window's own dialog (the one Delete Space uses), with Cancel as the
    // default: Return there keeps everything.
    if (scope.id == "everything" && !(await this.confirmEverything(win))) {
      return;
    }
    await this.run(win, scope.run, `whimsy-fire-done-${scope.id}`);
  },

  // wave7/ux: the second step for "Everything". Resolves true only when
  // the red "Clear Everything" button is chosen.
  async confirmEverything(win) {
    const [title, body, accept] = await win.document.l10n.formatValues([
      "whimsy-fire-everything-confirm-title",
      "whimsy-fire-everything-confirm-body",
      "whimsy-fire-everything-confirm-accept",
    ]);
    return lazy.WhimsyPanels.confirm(win, { title, body, accept, cancelDefault: true });
  },

  openPanel(win) {
    const panel = this.panel(win);
    // Start on this profile; nothing runs until the footer button is
    // pressed.
    this.selectScope(win, panel, "profile");
    lazy.WhimsyPanels.open(win, panel);
  },
};
