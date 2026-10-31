/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Live folders: tabs that refresh themselves. Zen ships GitHub and RSS;
// this adds Jira. Zen's `ZenLiveFoldersManager.registry` is a plain,
// public Map built for exactly this -- a provider class keyed by its
// `static type` -- so a new provider is registered into it, never patched
// into Zen's own `providers` array. `ZenLiveFoldersManager.init()` is
// wrapped (public method, never edited) to add Jira to the registry next to
// Zen's own two (before its restore; see wave7/folders); this re-runs every init()/uninit()
// cycle (e.g. closing the last window), so the entry survives that.
//
// The "+" toolbar menu's "Create a live folder" list (built once by Zen's
// ZenFolders.mjs, #zen-panel-ui-live-folder-create) is Zen-owned XUL we
// never edit either: a Jira entry is spliced in lazily, on first
// popupshowing, the same technique WhimsyFolderColors uses for its own
// folder-context-menu entry.
//
// batch11: "Push" refresh option. The fetch-interval menu
// (ZenLiveFoldersUI#intervalOptions) only offers 15 minutes and up; the
// user wants a "Push" choice like iOS Mail's, alongside it. There's no
// real server push a browser can register for here, so "Push" means what
// it means in that iOS Mail picker: check often (every minute) but cheaply
// -- a conditional GET (If-None-Match) that gets back a 304 with no body
// when nothing changed, so an unchanged folder costs a cheap round trip,
// not a full re-fetch and re-render. `#intervalOptions` is a true private
// method, unreachable from outside the class, so the *public*
// `buildContextMenu` is wrapped instead: call it to build the normal
// menu, then splice one more radio into the interval submenu it already
// built. Never refreshes on window focus -- the base class's existing
// 1-minute DeferredTask is the only trigger, same as a mail client ticking
// in the background.
//
// batch11: RSS feed autodiscovery. Today, adding an RSS live folder only
// ever works with a feed URL you already have in hand -- RssLiveFolder
// just fetches whatever URL it's given and expects a feed. Most sites
// advertise their feed on an ordinary page instead, via
// `<link rel="alternate" type="application/rss+xml">` in the `<head>`
// (the same thing a browser's own "subscribe" button used to look for).
// `promptForFeedUrl` (a public static method) is wrapped so that, after
// asking for a URL exactly the way Zen does, a non-feed page is
// transparently upgraded to its advertised feed; a genuine feed URL, or a
// page advertising none, passes through unchanged -- no regression on
// today's behavior either way.
//
// linear: Linear live folder ("My Issues": assigned to you, open states).
// Registered into the same registry as Jira, right below it; see
// WhimsyLinearLiveFolder.sys.mjs for the auth model (session first, a
// pasted personal API key as the fallback).
//
// wave5/lan: Local servers live folder (dev servers on localhost, polled
// only while the folder is visible). See WhimsyLocalServersLiveFolder.sys.mjs,
// including why Bonjour/LAN discovery is deferred. Registered *before*
// Zen's init() runs its #restoreState(), so saved folders of this type come
// back after a restart (registering after, as Jira/Linear do, misses that).
//
// wave7/folders: restarts lost Jira, Linear and Local Servers folders. The
// init() wrap above was only installed from Whimsy.initWindow, which runs
// after SessionStore.promiseAllWindowsRestored -- long after the first
// window's browser-window-delayed-startup has already run Zen's init() and
// its #restoreState(). Zen skips a saved entry whose type isn't in the
// registry, and its next saveState() writes only what it knows, so the
// folder fell back to a plain folder for good. Two fixes:
//  1. WhimsyStartup installs the wrap at profile-after-change (before any
//     window), and the wrap registers every Whimsy provider *before* Zen's
//     init(), so #restoreState() finds them.
//  2. A saved entry whose provider still isn't registered (its feature is
//     switched off, or a provider registers late) is held as an inert
//     placeholder in the manager's liveFolders -- never fetching, saved back
//     exactly as read -- and swapped for the real provider as soon as that
//     type registers (registerProviders, a feature switch turning on).

import { nsZenLiveFolderProvider } from "resource:///modules/zen/ZenLiveFolder.sys.mjs";
import { WhimsyJiraLiveFolderProvider, DEFAULT_JQL } from "resource:///modules/whimsy/WhimsyJiraLiveFolder.sys.mjs";
import { WhimsyLinearLiveFolderProvider } from "resource:///modules/whimsy/WhimsyLinearLiveFolder.sys.mjs";
import {
  WhimsyLocalServersLiveFolderProvider,
  FOLDER_ICON as LOCAL_SERVERS_ICON,
} from "resource:///modules/whimsy/WhimsyLocalServersLiveFolder.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
});

const JIRA_FEATURE_PREF = "whimsy.feature.live-folders-jira";
const LINEAR_FEATURE_PREF = "whimsy.feature.live-folders-linear";
const PUSH_FEATURE_PREF = "whimsy.feature.live-folders-push";
const RSS_AUTODISCOVER_PREF = "whimsy.feature.live-folders-rss-autodiscover";
const PUSH_INTERVAL_MS = 60 * 1000;
const LOCAL_SERVERS_FEATURE_PREF = "whimsy.feature.live-folders-local-servers";
// wave7/folders: Zen's live-folder store (ZenLiveFoldersManager#saveFilename).
const STORE_FILENAME = "zen-live-folders.jsonlz4";
const DEFAULT_FETCH_INTERVAL = 30 * 60 * 1000;
const PROVIDER_PREFS = [JIRA_FEATURE_PREF, LINEAR_FEATURE_PREF, LOCAL_SERVERS_FEATURE_PREF];

// wave7/folders: an inert stand-in for a saved live folder whose provider
// isn't registered (yet). Keeps the folder's saved type and state so Zen's
// saveState() writes it back unchanged; never fetches, so the folder's tabs
// are left exactly as session restore brought them back.
function makePendingLiveFolder(entry, manager) {
  const Pending = class extends nsZenLiveFolderProvider {
    static type = entry.type;
    get whimsyPending() {
      return true;
    }
    start() {}
    stop() {}
    async refresh() {
      return null;
    }
    fetchItems() {
      return null;
    }
    onOptionTrigger() {}
    onActionButtonClick() {}
    serialize() {
      return { state: this.state };
    }
  };
  const pending = new Pending({ id: entry.id, manager, state: entry.data?.state || {} });
  pending.tabsState = entry.tabsState || [];
  return pending;
}

export const WhimsyLiveFolders = {
  get jiraEnabled() {
    return Services.prefs.getBoolPref(JIRA_FEATURE_PREF, true);
  },

  get linearEnabled() {
    return Services.prefs.getBoolPref(LINEAR_FEATURE_PREF, true);
  },

  get pushEnabled() {
    return Services.prefs.getBoolPref(PUSH_FEATURE_PREF, true);
  },

  get localServersEnabled() {
    return Services.prefs.getBoolPref(LOCAL_SERVERS_FEATURE_PREF, true);
  },

  get rssAutodiscoverEnabled() {
    return Services.prefs.getBoolPref(RSS_AUTODISCOVER_PREF, true);
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    try {
      const { ZenLiveFoldersManager } = ChromeUtils.importESModule(
        "resource:///modules/zen/ZenLiveFoldersManager.sys.mjs"
      );
      this.installManagerHooks();
      // wave7/folders: a provider switched on later registers right away and
      // picks up any folder held for it since startup.
      this._prefObserver = () => this.registerProviders(ZenLiveFoldersManager);
      for (const pref of PROVIDER_PREFS) {
        Services.prefs.addObserver(pref, this._prefObserver);
      }
    } catch (e) {
      console.error("Whimsy: live folders registry hook failed", e);
    }

    try {
      const { ZenLiveFoldersUI } = ChromeUtils.importESModule(
        "resource:///modules/zen/ZenLiveFoldersUI.sys.mjs"
      );
      this.wrapBuildContextMenu(ZenLiveFoldersUI.prototype);
    } catch (e) {
      console.error("Whimsy: live folders push menu hook failed", e);
    }

    try {
      const { nsZenLiveFolderProvider } = ChromeUtils.importESModule(
        "resource:///modules/zen/ZenLiveFolder.sys.mjs"
      );
      this.wrapOnOptionTrigger(nsZenLiveFolderProvider.prototype);
    } catch (e) {
      console.error("Whimsy: live folders push option hook failed", e);
    }

    try {
      const { nsGithubLiveFolderProvider } = ChromeUtils.importESModule(
        "resource:///modules/zen/GithubLiveFolder.sys.mjs"
      );
      this.wrapPushableFetchItems(nsGithubLiveFolderProvider.prototype, provider => provider.state.url);
    } catch (e) {
      console.error("Whimsy: github push hook failed", e);
    }

    try {
      const { nsRssLiveFolderProvider } = ChromeUtils.importESModule(
        "resource:///modules/zen/RssLiveFolder.sys.mjs"
      );
      this.wrapPushableFetchItems(nsRssLiveFolderProvider.prototype, provider => provider.state.url);
      this.wrapRssAutodiscovery(nsRssLiveFolderProvider);
    } catch (e) {
      console.error("Whimsy: rss push hook failed", e);
    }
  },

  // Wraps the static promptForFeedUrl Zen's manager calls when creating an
  // RSS folder: ask for a URL exactly as Zen does, then (feature on, a URL
  // was given, and it isn't a feed itself) try to discover the page's
  // advertised feed and use that instead.
  wrapRssAutodiscovery(RssProviderClass) {
    const original = RssProviderClass.promptForFeedUrl;
    if (typeof original != "function" || original.whimsyWrapped) {
      return;
    }
    RssProviderClass.promptForFeedUrl = async function (window, initialUrl = "") {
      const url = await original.call(this, window, initialUrl);
      if (!url || !WhimsyLiveFolders.rssAutodiscoverEnabled) {
        return url;
      }
      try {
        const discovered = await WhimsyLiveFolders.discoverFeed(url);
        return discovered || url;
      } catch (e) {
        console.error("Whimsy: feed autodiscovery failed", e);
        return url;
      }
    };
    RssProviderClass.promptForFeedUrl.whimsyWrapped = true;
  },

  // Returns the page's advertised feed URL, or null if `url` is already a
  // feed, advertises none, or can't be fetched/parsed at all -- in every
  // one of those cases the caller just keeps using `url` as given.
  async discoverFeed(url) {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    const contentType = response.headers.get("content-type") || "";
    if (/(?:rss|atom|xml)/i.test(contentType)) {
      return null; // Already a feed; nothing to discover.
    }
    const text = await response.text();
    const doc = new DOMParser().parseFromString(text, "text/html");
    const link = doc.querySelector(
      'link[rel="alternate"][type="application/rss+xml"], link[rel="alternate"][type="application/atom+xml"]'
    );
    const href = link?.getAttribute("href");
    if (!href) {
      return null;
    }
    try {
      return new URL(href, url).href;
    } catch {
      return null;
    }
  },

  // Splices a "Push" radio into the fetch-interval submenu Zen's own
  // buildContextMenu() just built. Zen's own radios (15 min..8 hr) are
  // left exactly as built; none of them can ever read as checked at the
  // same time as this one, since Push's 1-minute interval doesn't match
  // any of their values.
  wrapBuildContextMenu(proto) {
    const original = proto.buildContextMenu;
    if (typeof original != "function" || original.whimsyWrapped) {
      return;
    }
    proto.buildContextMenu = function (folder) {
      original.call(this, folder);
      // wave5/lan: providers that schedule themselves hide Zen's interval menu.
      try {
        const { ZenLiveFoldersManager } = ChromeUtils.importESModule(
          "resource:///modules/zen/ZenLiveFoldersManager.sys.mjs"
        );
        const hides = folder.isLiveFolder && ZenLiveFoldersManager.getFolder(folder.id)?.constructor.hidesIntervalMenu;
        const intervalMenu = this.document
          .getElementById("context_zenLiveFolderOptions")
          ?.querySelector('menu[option-key="setInterval"]');
        if (hides) {
          intervalMenu?.setAttribute("hidden", "true");
          return;
        }
      } catch (e) {
        console.error("Whimsy: hiding the live folder interval menu failed", e);
      }
      if (!WhimsyLiveFolders.pushEnabled || !folder.isLiveFolder) {
        return;
      }
      try {
        WhimsyLiveFolders.addPushMenuItem(this, folder);
      } catch (e) {
        console.error("Whimsy: adding the Push menu item failed", e);
      }
    };
    proto.buildContextMenu.whimsyWrapped = true;
  },

  addPushMenuItem(ui, folder) {
    const { ZenLiveFoldersManager } = ChromeUtils.importESModule(
      "resource:///modules/zen/ZenLiveFoldersManager.sys.mjs"
    );
    const liveFolder = ZenLiveFoldersManager.getFolder(folder.id);
    if (!liveFolder) {
      return;
    }
    const popup = ui.document.getElementById("context_zenLiveFolderOptions")?.querySelector("menupopup");
    const intervalMenu = popup?.querySelector('menu[option-key="setInterval"] > menupopup');
    if (!intervalMenu) {
      return;
    }
    const item = ui.document.createXULElement("menuitem");
    item.setAttribute("type", "radio");
    ui.document.l10n.setAttributes(item, "whimsy-live-folder-push-interval");
    item.setAttribute("option-folder", folder.id);
    item.setAttribute("option-key", "whimsyPush");
    item.setAttribute("option-value", String(PUSH_INTERVAL_MS));
    if (liveFolder.state.whimsyPush) {
      item.setAttribute("checked", "true");
    }
    intervalMenu.insertBefore(item, intervalMenu.firstChild);
  },

  // The base class's onOptionTrigger (public, called by
  // ZenLiveFoldersUI#on_command for every provider's menu items) is
  // wrapped once here so every provider -- Zen's own and Whimsy's --
  // understands the "whimsyPush" key our spliced-in radio uses, since
  // subclasses all call `super.onOptionTrigger(option)` first.
  wrapOnOptionTrigger(proto) {
    const original = proto.onOptionTrigger;
    if (typeof original != "function" || original.whimsyWrapped) {
      return;
    }
    proto.onOptionTrigger = function (option) {
      const key = option.getAttribute("option-key");
      if (key === "whimsyPush") {
        this.state.whimsyPush = true;
        this.state.interval = PUSH_INTERVAL_MS;
        this.requestSave();
        this.stop();
        this.start();
        return;
      }
      if (key === "setInterval") {
        // Picking a normal, fixed interval leaves Push mode.
        this.state.whimsyPush = false;
      }
      return original.call(this, option);
    };
    proto.onOptionTrigger.whimsyWrapped = true;
  },

  // Wraps a provider's fetchItems so that, in Push mode, a cheap
  // conditional probe runs first: a 304 (nothing changed) returns the
  // same items fetchItems returned last time -- no re-parse, no tab
  // churn -- instead of doing the real, full fetch. Not wired up for
  // Jira yet (left for a follow-up): this only covers Zen's own two
  // providers, the ones named in the live-folders research as wanting it.
  wrapPushableFetchItems(proto, urlOf) {
    const original = proto.fetchItems;
    if (typeof original != "function" || original.whimsyPushWrapped) {
      return;
    }
    proto.fetchItems = async function (...args) {
      if (!this.state.whimsyPush || !WhimsyLiveFolders.pushEnabled) {
        const items = await original.apply(this, args);
        if (Array.isArray(items)) {
          this._whimsyLastItems = items;
        }
        return items;
      }

      const url = urlOf(this);
      if (url && Array.isArray(this._whimsyLastItems)) {
        const probe = await WhimsyLiveFolders.conditionalFetch(this, url, this.state.whimsyEtag);
        if (probe.status === 304) {
          return this._whimsyLastItems;
        }
        if (probe.etag) {
          this.state.whimsyEtag = probe.etag;
        }
      }

      const items = await original.apply(this, args);
      if (Array.isArray(items)) {
        this._whimsyLastItems = items;
      }
      return items;
    };
    proto.fetchItems.whimsyPushWrapped = true;
  },

  // A minimal conditional-HEAD probe: sends If-None-Match when an ETag is
  // already known, reads the response status and ETag, then aborts the
  // request without reading its body either way -- the real fetch (via
  // the shared base-class fetch()) runs separately only when something
  // actually changed. Uses the same NetUtil/channel primitives
  // ZenLiveFolder.sys.mjs's own fetch() does, as its own, Whimsy-owned
  // copy: that shared method isn't a Zen file we can edit to expose
  // response headers.
  conditionalFetch(liveFolder, url, etag) {
    return new Promise(resolve => {
      let resolved = false;
      const finish = result => {
        if (!resolved) {
          resolved = true;
          resolve(result);
        }
      };
      try {
        const uri = lazy.NetUtil.newURI(url);
        let userContextId = 0;
        const folder = liveFolder.manager.getFolderForLiveFolder?.(liveFolder);
        if (folder) {
          const space = folder.documentGlobal.gZenWorkspaces.getWorkspaceFromId(
            folder.getAttribute("zen-workspace-id")
          );
          if (space) {
            userContextId = space.containerTabId || 0;
          }
        }
        const principal = Services.scriptSecurityManager.createContentPrincipal(uri, { userContextId });
        const channel = lazy.NetUtil.newChannel({
          uri,
          contentPolicyType: Ci.nsIContentPolicy.TYPE_SAVEAS_DOWNLOAD,
          loadingPrincipal: principal,
          securityFlags:
            Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL | Ci.nsILoadInfo.SEC_COOKIES_INCLUDE,
          triggeringPrincipal: principal,
        }).QueryInterface(Ci.nsIHttpChannel);
        // HEAD obtains validators without downloading a duplicate feed body.
        channel.requestMethod = "HEAD";
        if (etag) {
          channel.setRequestHeader("If-None-Match", etag, false);
        }
        channel.asyncOpen({
          onStartRequest: request => {
            const http = request.QueryInterface(Ci.nsIHttpChannel);
            let status = null;
            try {
              status = http.responseStatus;
            } catch {
              status = null;
            }
            let newEtag = null;
            try {
              newEtag = http.getResponseHeader("ETag");
            } catch {
              newEtag = null;
            }
            // Headers are all that's needed either way: not-modified
            // means "use the cached items", modified means "fetch()
            // will re-run for real". Abort before the body downloads.
            request.cancel(Cr.NS_BINDING_ABORTED);
            finish({ status, etag: status === 304 ? (etag ?? null) : newEtag });
          },
          onDataAvailable: (request, stream, _offset, count) => {
            try {
              lazy.NetUtil.readInputStream(stream, count);
            } catch {
              // Ignore: the request is already being cancelled.
            }
          },
          onStopRequest: () => {
            finish({ status: null, etag: null });
          },
        });
      } catch (e) {
        console.error("Whimsy: live folder conditional probe failed", e);
        finish({ status: null, etag: null });
      }
    });
  },

  // wave7/folders: installs the init() wrap. Called from WhimsyStartup at
  // profile-after-change, so it is in place before the first window's
  // browser-window-delayed-startup runs Zen's init(). If Zen's init() has
  // already run unwrapped (Zen fills its registry synchronously as init()
  // starts), catch up once its restore is done: hold the saved folders it
  // skipped, then register, which re-attaches them.
  installManagerHooks() {
    const { ZenLiveFoldersManager } = ChromeUtils.importESModule(
      "resource:///modules/zen/ZenLiveFoldersManager.sys.mjs"
    );
    const proto = Object.getPrototypeOf(ZenLiveFoldersManager);
    const alreadyWrapped = proto.init?.whimsyWrapped;
    this.wrapManagerInit(ZenLiveFoldersManager);
    if (alreadyWrapped || !ZenLiveFoldersManager.registry.size) {
      return;
    }
    const saved = this.readSavedFolders();
    ZenLiveFoldersManager.stateRestored.promise
      .then(async () => {
        await this.holdUnknownSavedFolders(ZenLiveFoldersManager, await saved);
        this.registerProviders(ZenLiveFoldersManager);
      })
      .catch(e => console.error("Whimsy: live folders late restore failed", e));
  },

  // Registers every enabled Whimsy provider into Zen's registry, then swaps
  // any placeholder held for a now-registered type for the real provider.
  registerProviders(manager) {
    const providers = [
      // wave5/lan:
      [this.localServersEnabled, WhimsyLocalServersLiveFolderProvider],
      [this.jiraEnabled, WhimsyJiraLiveFolderProvider],
      // linear:
      [this.linearEnabled, WhimsyLinearLiveFolderProvider],
    ];
    for (const [enabled, Provider] of providers) {
      if (enabled) {
        manager.registry.set(Provider.type, Provider);
      }
    }
    this.upgradePendingFolders(manager);
  },

  // The saved store, read the same way Zen reads it (mozlz4 JSON). Null if
  // missing or unreadable.
  async readSavedFolders() {
    try {
      const data = await IOUtils.readJSON(PathUtils.join(PathUtils.profileDir, STORE_FILENAME), {
        decompress: true,
      });
      return Array.isArray(data) ? data : null;
    } catch {
      return null;
    }
  },

  // After Zen's restore: every saved entry Zen skipped (provider not in its
  // registry) whose folder still exists is held as a placeholder, so the
  // next saveState() keeps it instead of dropping it.
  async holdUnknownSavedFolders(manager, data) {
    const win = manager.window;
    if (!Array.isArray(data) || !win?.gZenWorkspaces) {
      return;
    }
    await win.gZenWorkspaces.promiseInitialized;
    const folders = win.gZenWorkspaces.allTabGroups;
    for (const entry of data) {
      if (!entry?.id || !entry.type || manager.liveFolders.has(entry.id)) {
        continue;
      }
      if (manager.registry.has(entry.type) || !folders.some(f => f.id === entry.id)) {
        // Registered types were Zen's to restore; a missing folder is gone.
        continue;
      }
      manager.liveFolders.set(entry.id, makePendingLiveFolder(entry, manager));
      if (Array.isArray(entry.dismissedItems)) {
        entry.dismissedItems.forEach(id => manager.dismissedItems.add(id));
      }
    }
  },

  // Swaps each placeholder whose type is now registered for the real
  // provider, built the way Zen's #restoreState() builds one, and starts it.
  upgradePendingFolders(manager) {
    let changed = false;
    for (const [id, liveFolder] of manager.liveFolders) {
      if (!liveFolder.whimsyPending) {
        continue;
      }
      const Provider = manager.registry.get(liveFolder.constructor.type);
      if (!Provider) {
        continue;
      }
      const state = { ...liveFolder.state };
      state.interval ||= DEFAULT_FETCH_INTERVAL;
      state.lastFetched ||= 0;
      state.options ||= {};
      const real = new Provider({ id, state, manager });
      real.tabsState = liveFolder.tabsState || [];
      real.state.lastErrorId = state.lastErrorId;
      manager.liveFolders.set(id, real);
      real.start();
      changed = true;
    }
    if (changed) {
      manager.saveState();
    }
  },

  // Patches the manager instance's own prototype (nsZenLiveFoldersManager),
  // not the singleton itself, so it keeps working across uninit()/init()
  // cycles (e.g. the last window closing, then a new one opening).
  wrapManagerInit(managerInstance) {
    const proto = Object.getPrototypeOf(managerInstance);
    const original = proto.init;
    if (typeof original != "function" || original.whimsyWrapped) {
      return;
    }
    proto.init = async function (...args) {
      // wave7/folders: every Whimsy provider registers before Zen's own init
      // so #restoreState() finds its type. Zen's init() fills its registry
      // with set(), so these entries stay. The store is read up front, before
      // anything Zen restores can save over it.
      WhimsyLiveFolders.registerProviders(this);
      const saved = WhimsyLiveFolders.readSavedFolders();
      const result = await original.apply(this, args);
      try {
        await WhimsyLiveFolders.holdUnknownSavedFolders(this, await saved);
      } catch (e) {
        console.error("Whimsy: holding unregistered live folders failed", e);
      }
      return result;
    };
    proto.init.whimsyWrapped = true;
  },

  registerProviders(manager) {
    const providers = [
      [this.jiraEnabled, WhimsyJiraLiveFolderProvider],
      [this.linearEnabled, WhimsyLinearLiveFolderProvider],
      [this.localServersEnabled, WhimsyLocalServersLiveFolderProvider],
    ];
    for (const [enabled, Provider] of providers) {
      if (enabled) {
        manager.registry.set(Provider.type, Provider);
      }
    }
  },

  // Called at profile-after-change by WhimsyStartup, before any window: Zen
  // runs ZenLiveFoldersManager.init() from browser-window-delayed-startup,
  // which is earlier than Whimsy.initWindow, so wrapping it from init()
  // below would come too late for the first window's restore.
  installManagerHook() {
    try {
      const { ZenLiveFoldersManager } = ChromeUtils.importESModule(
        "resource:///modules/zen/ZenLiveFoldersManager.sys.mjs"
      );
      this.wrapManagerInit(ZenLiveFoldersManager);
    } catch (e) {
      console.error("Whimsy: live folders registry hook failed", e);
    }
  },

  initWindow(win) {
    this.initCreateMenu(win);
  },

  initCreateMenu(win) {
    const { document } = win;

    document.addEventListener(
      "popupshowing",
      event => {
        // The items go in the submenu's popup: a menuitem appended to the
        // <menu> itself (outside its menupopup) is never shown, which is why
        // Jira and Linear were missing from the menu.
        const menu = event.target;
        if (menu.localName != "menupopup" || menu.parentElement?.id != "zen-panel-ui-live-folder-create") {
          return;
        }
        let item = menu.querySelector(".whimsy-live-folder-jira-create");
        if (!item) {
          item = document.createXULElement("menuitem");
          item.classList.add("whimsy-live-folder-jira-create");
          item.setAttribute("command", "cmd_zenNewLiveFolder");
          item.setAttribute("image", "chrome://browser/skin/zen-icons/selectable/ticket.svg");
          document.l10n.setAttributes(item, "whimsy-live-folder-jira-create");
          menu.appendChild(item);
        }
        item.hidden = !this.jiraEnabled;

        // linear:
        let linearItem = menu.querySelector(".whimsy-live-folder-linear-create");
        if (!linearItem) {
          linearItem = document.createXULElement("menuitem");
          linearItem.classList.add("whimsy-live-folder-linear-create");
          linearItem.setAttribute("command", "cmd_zenNewLiveFolder");
          linearItem.setAttribute("image", "chrome://browser/skin/zen-icons/selectable/ticket.svg");
          document.l10n.setAttributes(linearItem, "whimsy-live-folder-linear-create");
          menu.appendChild(linearItem);
        }
        linearItem.hidden = !this.linearEnabled;

        // wave5/lan:
        let localItem = menu.querySelector(".whimsy-live-folder-local-servers-create");
        if (!localItem) {
          localItem = document.createXULElement("menuitem");
          localItem.classList.add("whimsy-live-folder-local-servers-create");
          localItem.setAttribute("command", "cmd_zenNewLiveFolder");
          localItem.setAttribute("image", LOCAL_SERVERS_ICON);
          document.l10n.setAttributes(localItem, "whimsy-live-folder-local-servers-create");
          menu.appendChild(localItem);
        }
        localItem.hidden = !this.localServersEnabled;
      },
      { capture: true }
    );

    const command = document.getElementById("cmd_zenNewLiveFolder");
    command?.addEventListener("command", event => {
      const target = event.sourceEvent?.target;
      const l10nId = target?.getAttribute("data-l10n-id");
      if (this.jiraEnabled && l10nId == "whimsy-live-folder-jira-create") {
        this.createJiraFolder(win);
        return;
      }
      if (this.linearEnabled && l10nId == "whimsy-live-folder-linear-create") {
        this.createLinearFolder(win);
      }
      // wave5/lan:
      if (this.localServersEnabled && l10nId == "whimsy-live-folder-local-servers-create") {
        this.createLocalServersFolder(win);
      }
    });
  },

  async createJiraFolder(win) {
    try {
      const site = await WhimsyJiraLiveFolderProvider.promptForSite(win);
      if (!site) {
        return;
      }

      const { ZenLiveFoldersManager } = ChromeUtils.importESModule(
        "resource:///modules/zen/ZenLiveFoldersManager.sys.mjs"
      );

      const folder = win.gZenFolders.createFolder([], {
        label: "Jira",
        isLiveFolder: true,
        collapsed: true,
      });
      win.gZenFolders.setFolderUserIcon(folder, "chrome://browser/skin/zen-icons/selectable/ticket.svg");

      const state = {
        type: WhimsyJiraLiveFolderProvider.type,
        site,
        jql: DEFAULT_JQL,
        interval: 30 * 60 * 1000,
        lastFetched: 0,
        options: {},
      };
      const liveFolder = new WhimsyJiraLiveFolderProvider({
        id: folder.id,
        state,
        manager: ZenLiveFoldersManager,
      });

      ZenLiveFoldersManager.liveFolders.set(folder.id, liveFolder);
      liveFolder.start();
      ZenLiveFoldersManager.saveState();
    } catch (e) {
      console.error("Whimsy: creating a Jira live folder failed", e);
    }
  },

  // linear: Unlike Jira, nothing has to be asked up front: "My Issues" needs no
  // site, and the optional team filter can be set afterwards from the
  // folder's own options menu. Auth (session, then a pasted API key) is
  // only discovered on the first fetch, surfaced as the folder's error
  // state if neither works.
  async createLinearFolder(win) {
    try {
      const { ZenLiveFoldersManager } = ChromeUtils.importESModule(
        "resource:///modules/zen/ZenLiveFoldersManager.sys.mjs"
      );

      const folder = win.gZenFolders.createFolder([], {
        label: "Linear",
        isLiveFolder: true,
        collapsed: true,
      });
      win.gZenFolders.setFolderUserIcon(folder, "chrome://browser/skin/zen-icons/selectable/ticket.svg");

      const state = {
        type: WhimsyLinearLiveFolderProvider.type,
        team: "",
        interval: 30 * 60 * 1000,
        lastFetched: 0,
        options: {},
      };
      const liveFolder = new WhimsyLinearLiveFolderProvider({
        id: folder.id,
        state,
        manager: ZenLiveFoldersManager,
      });

      ZenLiveFoldersManager.liveFolders.set(folder.id, liveFolder);
      liveFolder.start();
      ZenLiveFoldersManager.saveState();
    } catch (e) {
      console.error("Whimsy: creating a Linear live folder failed", e);
    }
  },

  // wave5/lan: nothing to ask. Created expanded, so it probes at once and
  // shows what's running; collapsing it stops all polling.
  async createLocalServersFolder(win) {
    try {
      const { ZenLiveFoldersManager } = ChromeUtils.importESModule(
        "resource:///modules/zen/ZenLiveFoldersManager.sys.mjs"
      );
      const [label] = await win.document.l10n.formatValues(["whimsy-live-folder-local-servers-name"]);
      const folder = win.gZenFolders.createFolder([], {
        label: label || "Local Servers",
        isLiveFolder: true,
        collapsed: false,
      });
      win.gZenFolders.setFolderUserIcon(folder, LOCAL_SERVERS_ICON);

      const liveFolder = new WhimsyLocalServersLiveFolderProvider({
        id: folder.id,
        state: {
          type: WhimsyLocalServersLiveFolderProvider.type,
          interval: 30 * 60 * 1000,
          lastFetched: 0,
          options: {},
        },
        manager: ZenLiveFoldersManager,
      });

      ZenLiveFoldersManager.liveFolders.set(folder.id, liveFolder);
      liveFolder.start();
      ZenLiveFoldersManager.saveState();
      return liveFolder;
    } catch (e) {
      console.error("Whimsy: creating a Local Servers live folder failed", e);
      return null;
    }
  },
};
