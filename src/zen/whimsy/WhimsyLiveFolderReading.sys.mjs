/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave3: reading RSS live folders.
//
// Unread counts (whimsy.feature.live-folders-unread): an RSS live folder
// shows how many of its items you haven't opened yet, as a small count on
// the folder's row, and each unopened item's tab carries a dot. It's what
// every feed reader (NetNewsWire, Reeder, Google Reader before them) shows
// next to a feed, so you can tell at a glance whether a folder has anything
// new. An item counts as read once its tab is selected. The read item ids
// live in the folder's own state (`whimsyRead`), which Zen's live-folder
// store already saves, and are pruned to the items the feed still lists on
// every fetch. "Mark All as Read" in the folder's options clears the count.
//
// Reader view (whimsy.feature.live-folders-rss-reader): RSS items open in
// Firefox's Reader View (about:reader), so an article reads like it would
// in a feed reader: just the text, in your reader settings. A per-folder
// "Open in Reader View" checkbox in the folder's options turns it off for
// feeds whose pages don't suit it; it applies to items the feed adds after.
// Items are rewritten as Zen's manager turns them into tabs
// (onLiveFolderFetch), after the RSS provider has looked up their favicons
// and ids from the real links.
//
// Everything wraps public methods of Zen's live-folder classes; Zen's files
// are not edited.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const UNREAD_FEATURE_PREF = "whimsy.feature.live-folders-unread";
const READER_FEATURE_PREF = "whimsy.feature.live-folders-rss-reader";
const ITEM_ATTR = "zen-live-folder-item-id";
const UNREAD_ATTR = "whimsy-unread";
const BADGE_CLASS = "whimsy-live-unread";
const READER_PREFIX = "about:reader?url=";
const READ_KEY = "whimsyRead";
const READER_KEY = "whimsyReader";
const MARK_READ_KEY = "whimsyMarkAllRead";

export const WhimsyLiveFolderReading = {
  get unreadEnabled() {
    return Services.prefs.getBoolPref(UNREAD_FEATURE_PREF, true);
  },

  get readerEnabled() {
    return Services.prefs.getBoolPref(READER_FEATURE_PREF, true);
  },

  get manager() {
    return ChromeUtils.importESModule("resource:///modules/zen/ZenLiveFoldersManager.sys.mjs")
      .ZenLiveFoldersManager;
  },

  // --- Once per session ---

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    try {
      const { nsRssLiveFolderProvider } = ChromeUtils.importESModule(
        "resource:///modules/zen/RssLiveFolder.sys.mjs"
      );
      this.wrapRssProvider(nsRssLiveFolderProvider.prototype);
    } catch (e) {
      console.error("Whimsy: RSS reading hooks", e);
    }
    try {
      this.wrapManager(this.manager);
    } catch (e) {
      console.error("Whimsy: live folder unread hooks", e);
    }
    Services.prefs.addObserver(UNREAD_FEATURE_PREF, () => this.updateAllWindows());
  },

  isRss(liveFolder) {
    return liveFolder?.constructor?.type == "rss";
  },

  readerURL(url) {
    if (!url || url.startsWith(READER_PREFIX)) {
      return url;
    }
    return READER_PREFIX + encodeURIComponent(url);
  },

  wrapRssProvider(proto) {
    const self = this;

    // The folder's options menu: "Open in Reader View" and "Mark All as
    // Read". RssLiveFolder.onOptionTrigger ignores keys it doesn't list, so
    // the keys go through `options`, and are handled before it.
    const desc = Object.getOwnPropertyDescriptor(proto, "options");
    if (desc?.get && !desc.get.whimsyWrapped) {
      const get = function () {
        const options = desc.get.call(this);
        const extra = [];
        if (self.readerEnabled) {
          extra.push({
            key: READER_KEY,
            l10nId: "whimsy-live-folder-rss-option-reader",
            checked: this.state[READER_KEY] !== false,
          });
        }
        if (self.unreadEnabled) {
          extra.push({ key: MARK_READ_KEY, l10nId: "whimsy-live-folder-option-mark-read" });
        }
        return extra.length ? [...options, { type: "separator" }, ...extra] : options;
      };
      get.whimsyWrapped = true;
      Object.defineProperty(proto, "options", { ...desc, get });
    }

    const onOptionTrigger = proto.onOptionTrigger;
    if (typeof onOptionTrigger == "function" && !onOptionTrigger.whimsyReadingWrapped) {
      proto.onOptionTrigger = function (option) {
        const key = option.getAttribute("option-key");
        if (key == READER_KEY) {
          this.state[READER_KEY] = this.state[READER_KEY] === false;
          this.requestSave();
          return undefined;
        }
        if (key == MARK_READ_KEY) {
          self.markAllRead(this);
          return undefined;
        }
        return onOptionTrigger.call(this, option);
      };
      proto.onOptionTrigger.whimsyReadingWrapped = true;
    }
  },

  wrapManager(manager) {
    const self = this;
    const onFetch = manager.onLiveFolderFetch;
    if (typeof onFetch == "function" && !onFetch.whimsyUnreadWrapped) {
      manager.onLiveFolderFetch = function (liveFolder, items) {
        try {
          items = self.maybeReaderItems(liveFolder, items);
        } catch (e) {
          console.error("Whimsy: RSS reader view", e);
        }
        const result = onFetch.call(this, liveFolder, items);
        try {
          if (Array.isArray(items) && items.length) {
            self.pruneRead(liveFolder, items);
          }
        } catch (e) {
          console.error("Whimsy: live folder unread", e);
        }
        // Zen adds the new item tabs in a 0ms timeout it set just before
        // this one.
        lazy.setTimeout(() => self.updateAllWindows(liveFolder.id), 0);
        return result;
      };
      manager.onLiveFolderFetch.whimsyUnreadWrapped = true;
    }
    manager.stateRestored?.promise?.then(() => this.updateAllWindows()).catch(console.error);
  },

  // New item tabs open their page in Reader View. Only the URL Zen opens
  // changes; item ids (the feed's guid or link) stay the same, so existing
  // tabs are matched as before.
  maybeReaderItems(liveFolder, items) {
    if (
      !Array.isArray(items) ||
      !this.readerEnabled ||
      !this.isRss(liveFolder) ||
      liveFolder.state[READER_KEY] === false
    ) {
      return items;
    }
    return items.map(item => ({ ...item, url: this.readerURL(item.url) }));
  },

  // --- Read state ---

  readSet(liveFolder) {
    if (!(liveFolder._whimsyRead instanceof Set)) {
      liveFolder._whimsyRead = new Set(
        Array.isArray(liveFolder.state[READ_KEY]) ? liveFolder.state[READ_KEY] : []
      );
    }
    return liveFolder._whimsyRead;
  },

  saveRead(liveFolder) {
    liveFolder.state[READ_KEY] = [...this.readSet(liveFolder)];
    liveFolder.requestSave();
  },

  // Keeps only ids the feed still lists, so the list can't grow forever.
  pruneRead(liveFolder, items) {
    const read = this.readSet(liveFolder);
    if (!read.size) {
      return;
    }
    const current = new Set(items.map(item => `${liveFolder.id}:${item.id}`));
    let changed = false;
    for (const id of read) {
      if (!current.has(id)) {
        read.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.saveRead(liveFolder);
    }
  },

  // The RSS live folder an item tab belongs to, if any.
  liveFolderForTab(tab) {
    const itemId = tab?.getAttribute?.(ITEM_ATTR);
    if (!itemId) {
      return null;
    }
    const folderId = tab.group?.id;
    const liveFolder = folderId ? this.manager.getFolder(folderId) : null;
    if (liveFolder && itemId.startsWith(`${liveFolder.id}:`)) {
      return liveFolder;
    }
    for (const candidate of this.manager.liveFolders?.values() ?? []) {
      if (itemId.startsWith(`${candidate.id}:`)) {
        return candidate;
      }
    }
    return null;
  },

  markRead(tab) {
    const liveFolder = this.liveFolderForTab(tab);
    if (!this.isRss(liveFolder)) {
      return;
    }
    const read = this.readSet(liveFolder);
    const itemId = tab.getAttribute(ITEM_ATTR);
    if (read.has(itemId)) {
      return;
    }
    read.add(itemId);
    this.saveRead(liveFolder);
    this.updateAllWindows(liveFolder.id);
  },

  markAllRead(liveFolder) {
    const read = this.readSet(liveFolder);
    for (const win of this.windows()) {
      const folder = this.folderInWindow(win, liveFolder.id);
      for (const tab of this.itemTabs(folder)) {
        read.add(tab.getAttribute(ITEM_ATTR));
      }
    }
    this.saveRead(liveFolder);
    this.updateAllWindows(liveFolder.id);
  },

  unreadCount(win, liveFolder) {
    const read = this.readSet(liveFolder);
    return this.itemTabs(this.folderInWindow(win, liveFolder.id)).filter(
      tab => !read.has(tab.getAttribute(ITEM_ATTR))
    ).length;
  },

  // --- Windows ---

  windows() {
    return [...Services.wm.getEnumerator("navigator:browser")].filter(win => !win.closed && win.gZenWorkspaces);
  },

  folderInWindow(win, folderId) {
    return win.gZenWorkspaces?.allTabGroups?.find(group => group.id == folderId) ?? null;
  },

  itemTabs(folder) {
    return (folder?.tabs ?? []).filter(tab => tab.hasAttribute(ITEM_ATTR) && !tab.closing);
  },

  initWindow(win) {
    this.init();
    const { gBrowser } = win;
    if (!gBrowser || gBrowser._whimsyLiveReading) {
      return;
    }
    gBrowser._whimsyLiveReading = true;
    const container = gBrowser.tabContainer;
    container.addEventListener("TabSelect", event => {
      if (this.unreadEnabled && event.target.hasAttribute(ITEM_ATTR)) {
        this.markRead(event.target);
      }
    });
    // A dismissed item (its tab closed) leaves the count.
    container.addEventListener("TabClose", event => {
      const tab = event.target;
      if (tab.hasAttribute(ITEM_ATTR)) {
        const folderId = this.liveFolderForTab(tab)?.id;
        win.setTimeout(() => this.updateWindow(win, folderId), 0);
      }
    });
    win.gZenWorkspaces?.promiseInitialized?.then(() => this.updateWindow(win)).catch(console.error);
  },

  updateAllWindows(folderId = null) {
    for (const win of this.windows()) {
      try {
        this.updateWindow(win, folderId);
      } catch (e) {
        console.error("Whimsy: live folder unread", e);
      }
    }
  },

  // Draws the counts and dots for one live folder, or all of them.
  updateWindow(win, folderId = null) {
    const manager = this.manager;
    const liveFolders = folderId
      ? [manager.getFolder(folderId)].filter(Boolean)
      : [...(manager.liveFolders?.values() ?? [])];
    for (const liveFolder of liveFolders) {
      const folder = this.folderInWindow(win, liveFolder.id);
      if (!folder) {
        continue;
      }
      const on = this.unreadEnabled && this.isRss(liveFolder);
      const read = this.readSet(liveFolder);
      let count = 0;
      for (const tab of this.itemTabs(folder)) {
        const unread = on && !read.has(tab.getAttribute(ITEM_ATTR));
        tab.toggleAttribute(UNREAD_ATTR, unread);
        if (unread) {
          count++;
        }
      }
      this.drawBadge(win, folder, count);
    }
  },

  drawBadge(win, folder, count) {
    const label = folder.querySelector(":scope > .tab-group-label-container");
    if (!label) {
      return;
    }
    let badge = label.querySelector(`:scope > .${BADGE_CLASS}`);
    if (!count) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = win.document.createElement("span");
      badge.className = BADGE_CLASS;
      // Before the reset button, so it sits right after the folder's name.
      label.insertBefore(badge, label.querySelector(":scope > .tab-reset-button"));
    }
    const text = count > 99 ? "99+" : String(count);
    if (badge.textContent != text) {
      badge.textContent = text;
      win.document.l10n
        .formatValue("whimsy-live-folder-unread", { count })
        .then(description => {
          badge.setAttribute("title", description);
          badge.setAttribute("aria-label", description);
        })
        .catch(console.error);
    }
  },
};
