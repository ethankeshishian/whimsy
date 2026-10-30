/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Playlist v1 (whimsy.feature.playlist), after Brave Playlist: "Save to
// Playlist" on a video, audio or media link (context menu or the command
// bar) keeps it in Library -> Playlist to play later. v1 handles direct
// files only (http(s) URLs a <video>/<audio> plays or a link points to);
// streamed (blob:/MSE) and DRM media can't be saved. Each item is either a
// "Saved link" or, once its file is downloaded into the profile, "Available
// offline" (whimsy.playlist.offline-download, on by default). Downloads use
// Firefox's download machinery with the page's principal and cookie jar,
// stay out of the Downloads list, and stream to disk. Nothing is saved from
// private browsing.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  JSONFile: "resource://gre/modules/JSONFile.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.playlist";
const OFFLINE_PREF = "whimsy.playlist.offline-download";
export const PLAYLIST_CHANGED_TOPIC = "whimsy-playlist-changed";
const STORE_FILE = "whimsy-playlist.json";
const MEDIA_DIR = "whimsy-playlist";
const CONTEXT_MENU_ID = "context-whimsy-save-playlist";
const AUDIO_EXT = /\.(mp3|m4a|aac|oga|ogg|opus|wav|flac)$/i;
const MEDIA_EXT = /\.(mp4|m4v|webm|mov|ogv|mp3|m4a|aac|oga|ogg|opus|wav|flac)$/i;

const ReferrerInfo = Components.Constructor("@mozilla.org/referrer-info;1", "nsIReferrerInfo", "init");

function notify(id = "") {
  Services.obs.notifyObservers(null, PLAYLIST_CHANGED_TOPIC, id);
}

export const WhimsyPlaylist = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  get mediaDir() {
    return PathUtils.join(PathUtils.profileDir, MEDIA_DIR);
  },

  _file: null,
  _loading: null,
  _downloads: new Map(), // id -> Download

  async _store() {
    if (!this._file) {
      this._loading ??= (async () => {
        const file = new lazy.JSONFile({
          path: PathUtils.join(PathUtils.profileDir, STORE_FILE),
          dataPostProcessor: data => (Array.isArray(data?.items) ? data : { items: [] }),
        });
        await file.load();
        // A download that was running when the app quit starts over as a link.
        for (const item of file.data.items) {
          if (item.state == "downloading") {
            item.state = "link";
          }
        }
        this._file = file;
      })();
      await this._loading;
    }
    return this._file;
  },

  async list() {
    const file = await this._store();
    return [...file.data.items].sort((a, b) => b.added - a.added);
  },

  async get(id) {
    return (await this._store()).data.items.find(i => i.id == id) ?? null;
  },

  async _update(id, changes) {
    const file = await this._store();
    const item = file.data.items.find(i => i.id == id);
    if (item) {
      Object.assign(item, changes);
      file.saveSoon();
      notify(id);
    }
    return item ?? null;
  },

  // Whether a URL is a direct media file Playlist v1 can keep.
  isSavableURL(url) {
    try {
      const uri = Services.io.newURI(url);
      return uri.schemeIs("https") || uri.schemeIs("http");
    } catch {
      return false;
    }
  },

  isMediaLink(url) {
    try {
      return this.isSavableURL(url) && MEDIA_EXT.test(new URL(url).pathname);
    } catch {
      return false;
    }
  },

  // The URL to play: the downloaded file when there is one.
  playbackURL(item) {
    return item.state == "offline" && item.file ? PathUtils.toFileURI(item.file) : item.url;
  },

  // Adds media to the playlist. `browser` is the tab it came from: its
  // principal and cookie jar are used for the download, and nothing is kept
  // from private browsing. Returns the item, or null (with a toast).
  async add(win, { url, title = "", type = null, browser = win.gBrowser.selectedBrowser }) {
    if (!this.enabled) {
      return null;
    }
    if (
      lazy.PrivateBrowsingUtils.isWindowPrivate(win) ||
      lazy.PrivateBrowsingUtils.isBrowserPrivate(browser)
    ) {
      win.gZenUIManager?.showToast("whimsy-playlist-private-toast");
      return null;
    }
    if (!this.isSavableURL(url)) {
      win.gZenUIManager?.showToast("whimsy-playlist-unsupported-toast");
      return null;
    }
    const file = await this._store();
    const existing = file.data.items.find(i => i.url == url);
    if (existing) {
      win.gZenUIManager?.showToast("whimsy-playlist-exists-toast");
      return existing;
    }
    const path = new URL(url).pathname;
    const item = {
      id: Services.uuid.generateUUID().toString().slice(1, -1),
      url,
      title: title || decodeURIComponent(path.split("/").pop() || "") || url,
      site: browser?.currentURI?.host?.replace(/^www\./, "") || new URL(url).hostname,
      pageURL: browser?.currentURI?.spec ?? "",
      type: type || (AUDIO_EXT.test(path) ? "audio" : "video"),
      added: Date.now(),
      position: 0,
      state: "link", // link | downloading | offline | failed
    };
    file.data.items.push(item);
    file.saveSoon();
    notify(item.id);
    win.gZenUIManager?.showToast("whimsy-playlist-added-toast");
    if (Services.prefs.getBoolPref(OFFLINE_PREF, true)) {
      this.download(item.id, browser).catch(e => console.error("Whimsy: playlist download", e));
    }
    return item;
  },

  // Downloads an item's file into the profile, streaming to disk.
  async download(id, browser = null) {
    const item = await this.get(id);
    if (!item || this._downloads.has(id) || item.state == "offline") {
      return;
    }
    await IOUtils.makeDirectory(this.mediaDir);
    const ext = (new URL(item.url).pathname.match(MEDIA_EXT)?.[1] ?? (item.type == "audio" ? "mp3" : "mp4")).toLowerCase();
    const target = PathUtils.join(this.mediaDir, `${item.id}.${ext}`);
    const source = { url: item.url };
    if (browser?.contentPrincipal) {
      source.loadingPrincipal = browser.contentPrincipal;
      source.cookieJarSettings = browser.cookieJarSettings;
      if (browser.currentURI) {
        source.referrerInfo = new ReferrerInfo(
          Ci.nsIReferrerInfo.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          true,
          browser.currentURI
        );
      }
    }
    const dl = await lazy.Downloads.createDownload({ source, target });
    this._downloads.set(id, dl);
    await this._update(id, { state: "downloading", progress: 0 });
    let lastProgress = 0;
    dl.onchange = () => {
      if (dl.hasProgress && dl.progress - lastProgress >= 5) {
        lastProgress = dl.progress;
        this._update(id, { progress: dl.progress });
      }
    };
    try {
      await dl.start();
      await this._update(id, { state: "offline", file: target, size: dl.target.size ?? 0, progress: 100 });
    } catch (e) {
      console.error("Whimsy: playlist download failed", item.url, e);
      await IOUtils.remove(target, { ignoreAbsent: true }).catch(() => {});
      // Still a saved link; the Library row offers to try again.
      await this._update(id, { state: "failed" });
    } finally {
      this._downloads.delete(id);
    }
  },

  async remove(id) {
    const dl = this._downloads.get(id);
    if (dl) {
      await dl.finalize(true).catch(() => {});
      this._downloads.delete(id);
    }
    const file = await this._store();
    const index = file.data.items.findIndex(i => i.id == id);
    if (index < 0) {
      return false;
    }
    const [item] = file.data.items.splice(index, 1);
    file.saveSoon();
    if (item.file) {
      await IOUtils.remove(item.file, { ignoreAbsent: true }).catch(e => console.error(e));
    }
    notify(id);
    return true;
  },

  async savePosition(id, seconds) {
    const file = await this._store();
    const item = file.data.items.find(i => i.id == id);
    if (item && Number.isFinite(seconds)) {
      item.position = seconds;
      file.saveSoon();
    }
  },

  // The first direct media file the page's frames play or link to. With
  // { streamed: true } when there's none but the page plays streamed media.
  async findPageMedia(browser, result = {}) {
    const contexts = browser?.browsingContext?.getAllBrowsingContextsInSubtree() ?? [];
    for (const context of contexts) {
      try {
        const found = await context.currentWindowGlobal?.getActor("WhimsyPage").sendQuery("Whimsy:GetPageMedia");
        const media = found?.find(m => m.url && this.isSavableURL(m.url));
        if (media) {
          return media;
        }
        if (found?.some(m => m.streamed)) {
          result.streamed = true;
        }
      } catch {
        // The frame went away or has no actor.
      }
    }
    return null;
  },

  async saveFromPage(win) {
    const browser = win.gBrowser.selectedBrowser;
    const result = {};
    const media = await this.findPageMedia(browser, result);
    if (!media) {
      // fix7: on YouTube this said there was no video at all.
      win.gZenUIManager?.showToast(result.streamed ? "whimsy-playlist-streamed-toast" : "whimsy-playlist-no-media-toast");
      return null;
    }
    return this.add(win, { url: media.url, title: media.title, type: media.type, browser });
  },

  initWindow(win) {
    const { document } = win;
    const menu = document.getElementById("contentAreaContextMenu");
    if (!menu) {
      return;
    }
    const item = document.createXULElement("menuitem");
    item.id = CONTEXT_MENU_ID;
    item.hidden = true;
    document.l10n.setAttributes(item, "whimsy-context-playlist-add");
    // gContextMenu is read when the item is used, never kept.
    item.addEventListener("command", () => {
      const context = win.gContextMenu;
      if (!context) {
        return;
      }
      const onMedia = context.onVideo || context.onAudio;
      this.add(win, {
        url: onMedia ? context.mediaURL : context.linkURL,
        title: onMedia ? context.browser?.contentTitle : context.linkTextStr,
        type: context.onAudio ? "audio" : null,
        browser: context.browser,
      }).catch(e => console.error("Whimsy: playlist", e));
    });
    const anchor = document.getElementById("context-video-pictureinpicture") ?? document.getElementById("context-savevideo");
    if (anchor) {
      anchor.after(item);
    } else {
      menu.append(item);
    }
    menu.addEventListener("popupshowing", event => {
      if (event.target != menu) {
        return;
      }
      const context = win.gContextMenu;
      const onMedia = context && (context.onVideo || context.onAudio) && this.isSavableURL(context.mediaURL);
      const onLink = context?.onLink && this.isMediaLink(context.linkURL);
      item.hidden = !this.enabled || !(onMedia || onLink) || !!context?.browser?.browsingContext?.usePrivateBrowsing;
    });

    lazy.WhimsyShortcuts.addCommand(win, {
      id: "cmd_whimsyPlaylistSave",
      run: w => this.saveFromPage(w).catch(e => console.error("Whimsy: playlist", e)),
    });
    lazy.WhimsyShortcuts.addActions([
      {
        l10nId: "whimsy-action-playlist-save",
        command: "cmd_whimsyPlaylistSave",
        icon: "chrome://browser/skin/zen-icons/selectable/video.svg",
        isAvailable: () => this.enabled,
      },
    ]);
  },
};
