/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The point (DuckDuckGo's Fire Button, which this follows): one press ends
// the session you're in, closing its tabs and erasing the traces they left,
// so you can start fresh.
//
// batch8 shipped it as four scopes (This Site / Last 15 Minutes / This Space
// / Everything). wave7/fire narrows it to what serves that point, as
// DuckDuckGo does (this tab or window / everything):
//   - "Close this space's tabs and clear its last hour" (the default): closes
//     this space's unpinned tabs, removes the history visits recorded in this
//     space in the last hour (WhimsySpaceHistory), and clears cookies, site
//     data and cache for the sites those visits and tabs touched, only in the
//     space's container(s). Other spaces' history, and other containers'
//     data, stay. (Gecko can't clear one container by time, so it's by site.)
//   - "Close all tabs and clear everything": every space, all time, behind a
//     second confirm with Cancel as the default.
// Per-site forgetting isn't ending a session; it's Firefox's "Forget About
// This Site" (History), and stays reachable as the "Forget About This Site…"
// command. The old "This Space" scope is the default row now; "Last 15
// Minutes" became the last hour (Clear Recent History has finer ranges).
//
// Build-plan answer: pinned tabs and Essentials survive (DuckDuckGo's
// Fireproof): they're left out of the close step, not the clear.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ForgetAboutSite: "moz-src:///toolkit/components/forgetaboutsite/ForgetAboutSite.sys.mjs",
  WhimsyArchive: "resource:///modules/whimsy/WhimsyArchive.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  WhimsyPanels: "resource:///modules/whimsy/WhimsyPanels.sys.mjs",
  WhimsySpaceHistory: "resource:///modules/whimsy/WhimsySpaceHistory.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.fire-button";
const PANEL_ID = "whimsyFirePanel";
const LAST_HOUR_MS = 60 * 60 * 1000;
// What Everything clears, and exactly what the sheet names: history,
// cookies, site data and cache. Bookmarks, passwords, downloads and site
// permissions stay. The space session clears SITE_FLAGS per site and its
// own history visits.
const FORGET_FLAGS =
  Ci.nsIClearDataService.CLEAR_HISTORY |
  Ci.nsIClearDataService.CLEAR_COOKIES_AND_SITE_DATA |
  Ci.nsIClearDataService.CLEAR_ALL_CACHES;
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
  // space session clears for each site it touched.
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

  burnTabs(win, tabs, reason) {
    const closable = this.closableTabs(win, tabs);
    if (closable.length) {
      lazy.WhimsyArchive.archiveTabs(win, closable, { reason: "fire", groupId: `fire-${reason}-${Date.now()}` });
    }
    return closable.length;
  },

  // The tabs of the space you're in (all visible tabs without spaces).
  spaceTabs(win) {
    const space = win.gZenWorkspaces?.activeWorkspace;
    if (!space) {
      return [...win.gBrowser.visibleTabs];
    }
    return win.gBrowser.tabs.filter(t => t.getAttribute("zen-workspace-id") == space);
  },

  // The containers whose data belongs to this space: the one it uses
  // (Zen's containerTabId) plus any its open tabs actually run in.
  spaceContainers(win, tabs = this.spaceTabs(win)) {
    const space = win.gZenWorkspaces?.getActiveWorkspace?.();
    return [...new Set([space?.containerTabId || 0, ...tabs.map(t => t.userContextId || 0)])];
  },

  // True when another space uses one of these containers, so clearing a
  // site there signs those spaces out of it too (the note says so).
  sharesContainer(win, containers = this.spaceContainers(win)) {
    const spaces = win.gZenWorkspaces;
    const active = spaces?.activeWorkspace;
    return !!spaces?.getWorkspaces?.()?.some(item =>
      item.uuid != active && !item.whimsyScratch && containers.includes(item.containerTabId || 0));
  },

  // History visits recorded in this space since `since` (ms). Only visits
  // Whimsy attributed to the space count; unknown ones stay.
  async spaceVisits(spaceId, since) {
    if (!spaceId) {
      return [];
    }
    const rows = await lazy.WhimsySpaceHistory.query({
      spaceId, days: (Date.now() - since) / 86400000, limit: 100000,
    });
    return rows.filter(row => row.spaceId == spaceId && row.date.getTime() >= since);
  },

  // One visit, not the page: other spaces' visits to the same URL stay.
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

  // The default: end this space's session. Removes its last hour of
  // history, clears the sites it touched in its own container(s), and
  // closes its tabs. Returns what went, for the toast.
  async burnSession(win) {
    const tabs = this.spaceTabs(win);
    const since = Date.now() - LAST_HOUR_MS;
    const visits = await this.spaceVisits(win.gZenWorkspaces?.activeWorkspace, since);
    const sites = new Set();
    for (const visit of visits) {
      const site = siteOfURL(visit.url);
      if (site) {
        sites.add(site);
      }
    }
    for (const tab of tabs) {
      const site = (tab.lastAccessed || 0) >= since ? siteOf(tab) : null;
      if (site) {
        sites.add(site);
      }
    }
    const containers = this.spaceContainers(win, tabs);
    await Promise.all([...sites].flatMap(site => containers.map(id => this.clearSiteData(site, id))));
    await Promise.all(visits.map(visit => this.removeVisit(visit)));
    const count = this.burnTabs(win, tabs, "session");
    return { count, visits: visits.length, sites: sites.size };
  },

  async burnEverything(win) {
    await this.clearData();
    return this.burnTabs(win, win.gBrowser.tabs, "everything");
  },

  // "Forget About This Site…" (command bar): ForgetAboutSite takes the base
  // domain, so every subdomain's history and data go, and its tabs close.
  async burnSite(win) {
    const site = siteOf(win.gBrowser.selectedTab);
    if (!site) {
      return 0;
    }
    await lazy.ForgetAboutSite.removeDataFromBaseDomain(site);
    return this.burnTabs(win, win.gBrowser.tabs.filter(t => siteOf(t) == site), "site");
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
    const spaceName = win.gZenWorkspaces?.getActiveWorkspace?.()?.name || "";
    const { panel, body, footer } = lazy.WhimsyPanels.create(win, {
      id: PANEL_ID,
      titleL10nId: "whimsy-fire-title",
      subtitleL10nId: "whimsy-fire-subtitle",
      size: "medium",
      footer: true,
    });
    const sessionCount = this.closableTabs(win, this.spaceTabs(win)).length;
    const allCount = this.closableTabs(win, win.gBrowser.tabs).length;
    const scopes = [
      {
        id: "session",
        run: () => this.burnSession(win),
        icon: "chrome://browser/skin/zen-icons/history.svg",
        subtitleL10nId: spaceName ? "whimsy-fire-session-detail" : "whimsy-fire-session-detail-unnamed",
        subtitleArgs: { count: sessionCount, ...(spaceName ? { space: spaceName } : {}) },
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
      l10nId: "whimsy-fire-forget-session",
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
      // The space session warns when another space shares its container.
      const shared = id == "session" && this.sharesContainer(win);
      document.l10n.setAttributes(summary, `whimsy-fire-${id}-summary${shared ? "-shared" : ""}`);
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
    // Start on ending this space's session; nothing runs until the footer
    // button is pressed.
    this.selectScope(win, panel, "session");
    lazy.WhimsyPanels.open(win, panel);
  },
};
