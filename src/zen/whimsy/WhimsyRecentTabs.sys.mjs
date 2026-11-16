/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave3/cmdbar: Arc's empty command bar (Cmd+T / Cmd+L with nothing typed)
// shows the imminent meeting, recent open tabs, and documents from history.
// Tabs are most recent first, so getting
// back to "that tab from a minute ago" is Cmd+T, Down, Enter. Typing
// anything hands the bar back to Firefox/Zen's normal results (which
// already match open tabs). Rows are not preselected: Enter in an untouched
// bar must keep doing what it does (load the URL that's in it).
import { UrlbarProvider } from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import { UrlbarShared } from "chrome://browser/content/urlbar/UrlbarShared.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  ProvidersManager: "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  SyncedTabs: "resource://services-sync/SyncedTabs.sys.mjs",
  UIState: "resource://services-sync/UIState.sys.mjs",
  WhimsyNextMeeting: "resource:///modules/whimsy/WhimsyNextMeeting.sys.mjs",
  WhimsyPrivateLock: "resource:///modules/whimsy/WhimsyPrivateLock.sys.mjs",
  WhimsyTabs: "resource:///modules/whimsy/WhimsyTabs.sys.mjs",
  WhimsyTrails: "resource:///modules/whimsy/WhimsyTrails.sys.mjs",
});

const PREF = "whimsy.feature.command-bar-recent-tabs";
// W29/cmdrecent: Recently Closed and Synced Tabs join the empty bar after
// Recent Documents, so Recent Tabs drops from 5 to 4 to keep the empty bar
// to at most 11 rows (1 meeting + 4 tabs + 2 documents + 2 closed + 2 synced).
const MAX_TABS = 4;
const CLOSED_LIMIT = 2;
const SYNCED_LIMIT = 2;
const MAX_ROWS = 11;
const DYNAMIC_TYPE = "whimsy-recent-tab";
const SKIP_URLS = new Set(["about:blank", "about:newtab", "about:home", "about:whimsy"]);

// Results cross the parent/view boundary as plain data, so each row carries
// a number and the live tab stays here. Tab identity (not URL) matters: two
// tabs can show the same page.
let nextTarget = 0;
const targets = new Map();

const isPrivateTab = tab =>
  !!tab.linkedBrowser?.browsingContext?.usePrivateBrowsing || tab.hasAttribute("whimsy-private");

export function isDriveDocument(spec) {
  try {
    const url = new URL(spec);
    if (url.protocol != "https:") {
      return false;
    }
    switch (url.hostname) {
      case "docs.google.com":
        return /^\/(document|spreadsheets|presentation|forms|drawings)\/(?:u\/\d+\/)?d\/[^/]+/.test(url.pathname);
      case "drive.google.com":
        return /^\/file\/d\/[^/]+/.test(url.pathname) ||
          (url.pathname == "/open" && url.searchParams.has("id"));
      case "dropbox.com":
      case "www.dropbox.com":
        return /^\/(s|scl\/fi|home)\/[^/]+/.test(url.pathname);
      case "onedrive.live.com":
      case "onedrive.com":
        return url.searchParams.has("id") || url.searchParams.has("resid");
    }
  } catch {}
  return false;
}

export class WhimsyRecentTabsProvider extends UrlbarProvider {
  get name() {
    return "WhimsyRecentTabs";
  }

  get type() {
    return UrlbarShared.PROVIDER_TYPE.PROFILE;
  }

  // Above top sites (1): the empty bar shows recent tabs instead, like Arc.
  getPriority() {
    return 2;
  }

  // Most recently used tabs of the current space (plus visible Essentials),
  // never the selected tab, never across the private/normal boundary.
  // W14-9: the side is the query's, not the selected tab's: the Private
  // Space's bar sits over Zen's empty tab, which isn't private, and listed
  // every normal tab and Essential. A private query lists private tabs only.
  tabs(win, queryIsPrivate) {
    const gBrowser = win?.gBrowser;
    if (!gBrowser) {
      return [];
    }
    const selected = gBrowser.selectedTab;
    const selectedPrivate = queryIsPrivate ?? isPrivateTab(selected);
    const space = win.gZenWorkspaces?.activeWorkspace;
    return Array.from(gBrowser.tabs)
      .filter(tab => {
        if (tab == selected || tab.closing || tab.hasAttribute("zen-empty-tab") || tab.hasAttribute("zen-glance-tab")) {
          return false;
        }
        if (lazy.WhimsyPrivateLock.isTabHidden(win, tab)) {
          return false;
        }
        if (isPrivateTab(tab) != selectedPrivate) {
          return false;
        }
        if (selectedPrivate && tab.hasAttribute("zen-essential")) {
          return false;
        }
        if (space && !tab.hasAttribute("zen-essential") && tab.getAttribute("zen-workspace-id") != space) {
          return false;
        }
        const url = tab.linkedBrowser?.currentURI?.spec;
        return !!url && !SKIP_URLS.has(url.split(/[?#]/)[0]);
      })
      .sort((a, b) => b.lastAccessed - a.lastAccessed)
      .slice(0, MAX_TABS);
  }

  meeting(context) {
    return !context.isPrivate && lazy.WhimsyNextMeeting.soonMeeting(Date.now(), { joinable: true });
  }

  async drives(context) {
    if (context.isPrivate) {
      return [];
    }
    try {
      const db = await lazy.PlacesUtils.promiseDBConnection();
      const rows = await db.executeCached(`
        SELECT url, title FROM moz_places
        WHERE last_visit_date IS NOT NULL AND hidden = 0 AND rev_host IN (
          'moc.elgoog.scod.', 'moc.elgoog.evird.', 'moc.xobpord.',
          'moc.xobpord.www.', 'moc.evil.evirdeno.', 'moc.evirdeno.'
        ) ORDER BY last_visit_date DESC, id DESC
      `);
      const documents = [];
      for (const row of rows) {
        const url = row.getResultByName("url");
        if (isDriveDocument(url)) {
          documents.push({ url, title: row.getResultByName("title") || url });
          if (documents.length == 2) {
            break;
          }
        }
      }
      return documents;
    } catch {
      // History being unavailable must not hide tabs or the next meeting.
      return [];
    }
  }

  // Up to 2 of the window's most recently closed tabs. Never in a private
  // window (R.3): closed private tabs aren't tracked at all, and the design
  // keeps the private empty bar exactly as it is today (Recent Tabs only).
  closed(win, context) {
    if (context.isPrivate || !win) {
      return [];
    }
    try {
      return lazy.SessionStore.getClosedTabDataForWindow(win).slice(0, CLOSED_LIMIT);
    } catch {
      return [];
    }
  }

  // Up to 2 most recent tabs from other devices, only when signed in to
  // Sync with another device, and never in a private window.
  async synced(context) {
    if (context.isPrivate) {
      return [];
    }
    try {
      if (lazy.UIState.get().status != lazy.UIState.STATUS_SIGNED_IN) {
        return [];
      }
      return (await lazy.SyncedTabs.getRecentTabs(SYNCED_LIMIT)) || [];
    } catch {
      // Sync being unavailable must not hide tabs, documents or the meeting.
      return [];
    }
  }

  async isActive(context) {
    return (
      Services.prefs.getBoolPref(PREF, true) &&
      !context.searchString?.trim() &&
      !context.searchMode &&
      !context.restrictSource &&
      (!!this.meeting(context) ||
        this.tabs(lazy.BrowserWindowTracker.getTopWindow(), !!context.isPrivate).length > 0 ||
        this.closed(lazy.BrowserWindowTracker.getTopWindow(), context).length > 0 ||
        (await this.drives(context)).length > 0 ||
        (await this.synced(context)).length > 0)
    );
  }

  async startQuery(context, addCallback) {
    const query = this._query = {};
    const win = lazy.BrowserWindowTracker.getTopWindow();
    targets.clear();
    const rows = [];
    const meeting = this.meeting(context);
    if (meeting) {
      rows.push({
        kind: "meeting", meeting,
        title: meeting.title || new Localization(["browser/whimsy.ftl"], true).formatValueSync("whimsy-meeting-untitled"),
        url: meeting.join.url,
        until: lazy.WhimsyNextMeeting.formatUntil(meeting),
        icon: "chrome://browser/skin/zen-icons/video-fill.svg",
        label: "whimsy-command-upcoming-meeting",
      });
    }
    for (const tab of this.tabs(win, !!context.isPrivate)) {
      rows.push({
        kind: "tab", tab: new WeakRef(tab),
        title: tab.label || tab.linkedBrowser.currentURI.spec,
        // A payload.url would also make the urlbar load this page on pick.
        // Tab rows must only engage the existing tab by its target identity.
        tabUrl: tab.linkedBrowser.currentURI.spec,
        unread: lazy.WhimsyTabs.mailUnreadCount(tab),
        icon: tab.getAttribute("image") || "chrome://global/skin/icons/defaultFavicon.svg",
        label: "whimsy-command-recent-tabs",
      });
    }
    const drives = await this.drives(context);
    if (this._query != query) {
      return;
    }
    for (const doc of drives) {
      rows.push({ ...doc, kind: "drive", label: "whimsy-command-recent-documents",
        icon: "chrome://global/skin/icons/defaultFavicon.svg" });
    }
    for (const tab of this.closed(win, context)) {
      rows.push({
        kind: "closed", closedId: tab.closedId,
        title: tab.title || "",
        icon: tab.image || "chrome://global/skin/icons/defaultFavicon.svg",
        label: "whimsy-command-recently-closed",
        ago: lazy.WhimsyTrails.ago(tab.closedAt),
      });
    }
    const synced = await this.synced(context);
    if (this._query != query) {
      return;
    }
    for (const tab of synced) {
      rows.push({
        kind: "synced", url: tab.url, device: tab.device,
        title: tab.title || tab.url,
        icon: tab.icon || "chrome://global/skin/icons/defaultFavicon.svg",
        label: "whimsy-command-synced-tabs",
      });
    }
    for (const [index, row] of rows.slice(0, context.maxResults || MAX_ROWS).entries()) {
      const target = ++nextTarget;
      const { tab, meeting: event, label, ...payload } = row;
      targets.set(target, {
        tab, meeting: event, kind: row.kind, url: row.url,
        closedId: row.closedId, window: new WeakRef(win),
      });
      addCallback(this, new lazy.UrlbarResult({
        type: UrlbarShared.RESULT_TYPE.DYNAMIC,
        source: row.kind == "tab" ? UrlbarShared.RESULT_SOURCE.TABS :
          row.kind == "drive" ? UrlbarShared.RESULT_SOURCE.HISTORY : UrlbarShared.RESULT_SOURCE.OTHER_LOCAL,
        suggestedIndex: index,
        rowLabel: { id: label },
        payload: { dynamicType: DYNAMIC_TYPE, target, ...payload },
      }));
    }
  }

  cancelQuery() {
    this._query = null;
  }

  getViewTemplate() {
    return {
      attributes: { selectable: true },
      children: [
        { name: "icon", tag: "img", classList: ["urlbarView-favicon"] },
        { name: "title", tag: "span", classList: ["urlbarView-title"] },
        { name: "action", tag: "span", classList: ["urlbarView-action"] },
      ],
    };
  }

  getViewUpdate(result) {
    const { kind, unread, until, ago, device } = result.payload;
    let action = { id: "whimsy-command-switch-tab" };
    if (kind == "meeting") {
      action = until ? { id: "whimsy-command-meeting-until", args: { until } }
        : { id: "whimsy-command-join-meeting" };
    } else if (kind == "drive") {
      action = { id: "whimsy-command-open-document" };
    } else if (kind == "closed") {
      action = { id: "whimsy-command-reopen-tab", args: { ago } };
    } else if (kind == "synced") {
      action = { id: "whimsy-command-open-tab", args: { device } };
    } else if (unread != null) {
      action = { id: "whimsy-command-mail-unread", args: { count: unread } };
    }
    return {
      icon: { attributes: { src: result.payload.icon } },
      title: { textContent: result.payload.title },
      action: { l10n: action },
    };
  }

  onEngagement(context, _controller, details) {
    const target = targets.get(details.result?.payload.target);
    if (!target || !Services.prefs.getBoolPref(PREF, true)) {
      return;
    }
    if (target.kind != "tab") {
      const win = target.window.deref();
      if (context?.isPrivate || !win || win.closed) {
        return;
      }
      if (target.kind == "meeting") {
        const meeting = this.meeting(context || {});
        if (meeting?.join.url == target.url && meeting.start == target.meeting.start) {
          lazy.WhimsyNextMeeting.join(win, meeting);
        }
      } else if (target.kind == "closed") {
        // Restores with back history, like Shift+Cmd+T but for this tab.
        lazy.SessionStore.undoCloseById(target.closedId, true, win);
      } else {
        win.openTrustedLinkIn(target.url, "tab");
      }
      return;
    }
    const tab = target.tab?.deref();
    const win = tab?.documentGlobal;
    // The tab may have closed (or moved space) since the bar opened.
    if (!win || !tab.isConnected || tab.closing || !Services.prefs.getBoolPref(PREF, true)) {
      return;
    }
    if (context && isPrivateTab(tab) != !!context.isPrivate) {
      return;
    }
    if (win.gZenWorkspaces && tab.hasAttribute("zen-workspace-id") && !tab.hasAttribute("zen-essential")) {
      const space = tab.getAttribute("zen-workspace-id");
      if (space != win.gZenWorkspaces.activeWorkspace) {
        return;
      }
    }
    win.gBrowser.selectedTab = tab;
    win.gBrowser.selectedBrowser.focus();
  }
}

export const WhimsyRecentTabs = {
  provider: null,

  // Registered once even when the switch is off; isActive checks it on each
  // query, so the Settings checkbox applies live.
  init() {
    if (this.provider) {
      return;
    }
    const manager = lazy.ProvidersManager.getInstanceForSap("urlbar");
    this.provider = manager.getProvider("WhimsyRecentTabs");
    if (!this.provider) {
      this.provider = new WhimsyRecentTabsProvider();
      manager.registerProvider(this.provider);
    }
  },
};
