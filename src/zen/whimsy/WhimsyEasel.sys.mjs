/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave5: Easel (Arc's Easels, Dec 2021; Live Captures July 2022). An easel
// is a canvas of text, drawings, shapes, images, links and captures. Each
// one is a page (about:whimsy?easel&id=<id>, whimsy://easel for a new one)
// that opens as a tab, pinned when it's new, like Arc. They are listed in the
// Library (Easels), created from the command bar ("New Easel", Arc's
// Ctrl+Shift+E) and from the capture tool (Cmd+Shift+2, drag a region, "Add
// to Easel", pick an easel or a new one). Captures keep their page and
// container, so pressing Play turns one into a live, cropped view of the
// page (the Notes live-block browser); private tabs can't add captures.
//
// Storage is the profile: whimsy-easels.json (the easels and their items)
// and whimsy-easels/<easel id>/ (image files); WhimsyEaselSync carries a
// small copy through Firefox Sync. No public links (Arc shared to arc.net;
// Whimsy has no server): the page copies its own address, exports PNG/PDF
// and copies itself as an image instead. docs/whimsy/easel.md has the
// parity notes.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  JSONFile: "resource://gre/modules/JSONFile.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  ScreenshotsUtils: "moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs",
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyEaselSync: "resource:///modules/whimsy/WhimsyEaselSync.sys.mjs",
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
  WhimsyToast: "resource:///modules/whimsy/WhimsyToast.sys.mjs",
});

// wave9: easels are per profile, like Notes (W8-49). Each easel has the
// synced key of its profile (WhimsyProfiles.keyFor); one without a key is
// from before profiles and belongs to Default.
export const DEFAULT_PROFILE_KEY = "default";
export function profileKeyOf(easel) {
  return (typeof easel?.profileKey == "string" && easel.profileKey) || DEFAULT_PROFILE_KEY;
}

// Easels saved before profiles move to Default. Returns whether any did.
export function migrateEasels(easels) {
  let migrated = false;
  for (const easel of easels) {
    if (typeof easel.profileKey != "string" || !easel.profileKey) {
      easel.profileKey = DEFAULT_PROFILE_KEY;
      migrated = true;
    }
  }
  return migrated;
}

export const FEATURE_PREF = "whimsy.feature.easel";
export const CHANGED_TOPIC = "whimsy-easels-changed";
const STORE_FILENAME = "whimsy-easels.json";
const IMAGES_DIR = "whimsy-easels";
const PAGE_URL = "about:whimsy?easel";
const PICKER_ID = "whimsy-easel-picker";
const PICKER_WIDTH = 340;
const PICKER_EASELS = 8;
const HTML_NS = "http://www.w3.org/1999/xhtml";
// Captures land on the canvas at most this wide (canvas px).
const CAPTURE_MAX_WIDTH = 520;
// Anything bigger is not a real selection.
const MAX_REGION = 30000;
// A deleted easel's images stay this long, for Undo.
const TRASH_MS = 30000;
// wave7: "Add Page to Easel" captures at most this much of a page's height
// (CSS px), at most 2x, so a very long page stays a reasonable image.
const FULL_PAGE_MAX_HEIGHT = 12000;

export function easelURL(id) {
  return `${PAGE_URL}&id=${encodeURIComponent(id)}`;
}

// The easel id in an about:whimsy?easel&id=... address, or null.
export function easelIdFromURL(spec) {
  const match = /^about:whimsy\?easel(?:&|$)(?:.*&)?id=([0-9a-f-]{8,64})(?:&|$)/i.exec(spec ?? "");
  return match ? decodeURIComponent(match[1]) : null;
}

function newId() {
  return Services.uuid.generateUUID().toString().slice(1, -1);
}

// The bounding box of items ({x, y, w, h} in canvas px), or null.
export function itemsBounds(items) {
  if (!items?.length) {
    return null;
  }
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const item of items) {
    left = Math.min(left, item.x);
    top = Math.min(top, item.y);
    right = Math.max(right, item.x + item.w);
    bottom = Math.max(bottom, item.y + item.h);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

class EaselStore {
  #file = null;
  #trash = new Map();
  #loading = null;

  async #ensureLoaded() {
    if (this.#file) {
      return this.#file;
    }
    this.#loading ??= (async () => {
      const file = new lazy.JSONFile({
        path: PathUtils.join(PathUtils.profileDir, STORE_FILENAME),
        dataPostProcessor(data) {
          if (!data || typeof data != "object" || !Array.isArray(data.easels)) {
            return { easels: [] };
          }
          return data;
        },
      });
      await file.load();
      // wave9: easels from before profiles move to Default, once.
      if (migrateEasels(file.data.easels)) {
        file.saveSoon();
      }
      this.#file = file;
    })();
    await this.#loading;
    return this.#file;
  }

  #notify(id, source = "") {
    Services.obs.notifyObservers(null, CHANGED_TOPIC, JSON.stringify({ id, source }));
    // wave7: Sync carries a small copy of each easel (WhimsyEaselSync).
    if (source != "sync") {
      try {
        lazy.WhimsyEaselSync.scheduleUpload();
      } catch (e) {
        console.error("Whimsy: easel sync", e);
      }
    }
  }

  // wave7: an easel from another device (WhimsyEaselSync). Creates it or
  // replaces its title and items when the incoming copy is newer.
  async applyRemote(remote) {
    const file = await this.#ensureLoaded();
    if (!remote?.id || this.#trash.has(remote.id)) {
      return false;
    }
    let easel = file.data.easels.find(e => e.id == remote.id);
    if (easel && (easel.updated ?? 0) >= remote.updated) {
      return false;
    }
    if (!easel) {
      easel = { id: remote.id, title: "", items: [], view: null, created: remote.updated };
      file.data.easels.push(easel);
    }
    // A copy from a device without profiles belongs to Default.
    easel.profileKey = profileKeyOf(remote);
    // Images don't sync: keep this device's own files for items it has.
    const local = new Map(easel.items.map(i => [i.id, i]));
    easel.title = remote.title ?? "";
    easel.items = remote.items.map(item => {
      const mine = local.get(item.id);
      if (mine?.image && item.type == "capture") {
        return { ...item, image: mine.image };
      }
      if (mine?.src && item.type == "image") {
        return { ...item, src: mine.src };
      }
      return item;
    });
    easel.updated = remote.updated;
    file.saveSoon();
    this.#notify(easel.id, "sync");
    return true;
  }

  // wave7: an easel deleted on another device.
  async removeRemote(id) {
    const file = await this.#ensureLoaded();
    if (!file.data.easels.some(e => e.id == id)) {
      return false;
    }
    file.data.easels = file.data.easels.filter(e => e.id != id);
    file.saveSoon();
    this.#notify(id, "sync");
    return true;
  }

  // Newest first. With a profile key, only that profile's easels.
  async list(profileKey = null) {
    const file = await this.#ensureLoaded();
    let easels = file.data.easels;
    if (profileKey) {
      easels = easels.filter(e => profileKeyOf(e) === profileKey);
    }
    return [...easels].sort((a, b) => b.updated - a.updated);
  }

  async get(id) {
    const file = await this.#ensureLoaded();
    return file.data.easels.find(e => e.id == id) ?? null;
  }

  async create({ title = "", profileKey = DEFAULT_PROFILE_KEY } = {}) {
    const file = await this.#ensureLoaded();
    const now = Date.now();
    const easel = { id: newId(), title, profileKey: profileKey || DEFAULT_PROFILE_KEY, items: [], view: null, created: now, updated: now };
    file.data.easels.push(easel);
    file.saveSoon();
    this.#notify(easel.id);
    return easel;
  }

  // changes: any of title, items, view. `source` lets a page skip its own
  // change notifications.
  async update(id, changes, source = "") {
    const file = await this.#ensureLoaded();
    const easel = file.data.easels.find(e => e.id == id);
    if (!easel) {
      return null;
    }
    for (const key of ["title", "items", "view"]) {
      if (key in changes) {
        easel[key] = changes[key];
      }
    }
    // Panning and zooming alone doesn't make an easel "recently edited".
    if ("title" in changes || "items" in changes) {
      easel.updated = Date.now();
    }
    file.saveSoon();
    this.#notify(id, source);
    return easel;
  }

  // Adds an item below everything already on the easel (or at the origin).
  async addItem(id, item, source = "") {
    const easel = await this.get(id);
    if (!easel) {
      return null;
    }
    const bounds = itemsBounds(easel.items);
    const placed = { id: newId(), ...item, x: bounds ? bounds.x : 0, y: bounds ? bounds.y + bounds.h + 40 : 0 };
    await this.update(id, { items: [...easel.items, placed] }, source);
    return placed;
  }

  // Removes an easel; restore(id) brings it back within a short while,
  // after which its images are deleted too.
  async remove(id) {
    const file = await this.#ensureLoaded();
    const easel = file.data.easels.find(e => e.id == id);
    file.data.easels = file.data.easels.filter(e => e.id != id);
    file.saveSoon();
    if (easel) {
      lazy.clearTimeout(this.#trash.get(id)?.timer);
      const timer = lazy.setTimeout(() => this.#purge(id), TRASH_MS);
      this.#trash.set(id, { easel, timer });
    }
    this.#notify(id);
  }

  // A deleted profile takes its easels and their images with it (no undo:
  // the profile itself is gone). Default's easels always stay.
  async removeForProfile(profileKey) {
    if (!profileKey || profileKey === DEFAULT_PROFILE_KEY) {
      return [];
    }
    const file = await this.#ensureLoaded();
    const gone = file.data.easels.filter(e => profileKeyOf(e) === profileKey);
    if (!gone.length) {
      return [];
    }
    file.data.easels = file.data.easels.filter(e => profileKeyOf(e) !== profileKey);
    file.saveSoon();
    for (const easel of gone) {
      await this.#purge(easel.id);
      this.#notify(easel.id);
    }
    return gone.map(e => e.id);
  }

  async restore(id) {
    const entry = this.#trash.get(id);
    if (!entry) {
      return null;
    }
    lazy.clearTimeout(entry.timer);
    this.#trash.delete(id);
    const file = await this.#ensureLoaded();
    // Newer than the deletion Sync may already carry, so it comes back
    // everywhere too.
    entry.easel.updated = Date.now();
    file.data.easels.push(entry.easel);
    file.saveSoon();
    this.#notify(id);
    return entry.easel;
  }

  async #purge(id) {
    this.#trash.delete(id);
    try {
      await IOUtils.remove(this.imagesDir(id), { recursive: true, ignoreAbsent: true });
    } catch (e) {
      console.error("Whimsy: remove easel images", e);
    }
  }

  // Flushes pending writes (tests, shutdown).
  async flush() {
    const file = await this.#ensureLoaded();
    await file._save();
  }

  imagesDir(id) {
    return PathUtils.join(PathUtils.profileDir, IMAGES_DIR, id.replace(/[^0-9a-f-]/gi, ""));
  }

  // Saves image bytes for an easel; returns the file name to store on the item.
  async saveImage(id, bytes, type = "image/png") {
    const ext = { "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" }[type] ?? "png";
    const name = `${newId()}.${ext}`;
    const dir = this.imagesDir(id);
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    await IOUtils.write(PathUtils.join(dir, name), bytes);
    return name;
  }

  // W10-24: a picture for the easel in the Add to Easel picker: its first
  // image (a capture or a dropped image). { bytes, type } or null.
  async thumbnail(id) {
    const easel = await this.get(id);
    const item = easel?.items?.find(i => (i.type == "capture" || i.type == "image") && i.image);
    if (!item) {
      return null;
    }
    const bytes = await this.readImage(id, item.image);
    if (!bytes) {
      return null;
    }
    const ext = item.image.split(".").pop().toLowerCase();
    const type = { jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" }[ext] ?? "image/png";
    return { bytes, type };
  }

  async readImage(id, name) {
    if (!/^[0-9a-f-]+\.(png|jpg|gif|webp|svg)$/i.test(name ?? "")) {
      return null;
    }
    try {
      return await IOUtils.read(PathUtils.join(this.imagesDir(id), name));
    } catch {
      return null;
    }
  }

  // Deletes image files no item uses any more (run when an easel opens, so
  // undo within a session never loses an image).
  async prune(id, keep) {
    const dir = this.imagesDir(id);
    try {
      for (const path of await IOUtils.getChildren(dir)) {
        if (!keep.has(PathUtils.filename(path))) {
          await IOUtils.remove(path);
        }
      }
    } catch {
      // No images yet.
    }
  }
}

export const gWhimsyEaselStore = new EaselStore();

// wave9: a deleted profile's easels go with it (as its notes do).
try {
  lazy.WhimsyProfiles.onDelete?.((id, key) => gWhimsyEaselStore.removeForProfile(key));
} catch (e) {
  console.error("Whimsy: easel profile hook", e);
}

// Items copied in one easel, pasted in another (the system clipboard holds
// their text; `text` tells a later paste whether it is still ours).
export const gWhimsyEaselClipboard = { payload: null, text: null };

let actorRegistered = false;
let screenshotsHooked = false;

export const WhimsyEasel = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  initWindow(win) {
    this.registerActor();
    this.hookScreenshots();
    this.initExtras(win);
    const { WhimsyShortcuts } = lazy;
    const mac = Services.appinfo.OS == "Darwin";
    WhimsyShortcuts.addCommand(win, {
      id: "cmd_whimsyNewEasel",
      run: w => this.newEasel(w),
      // Arc's File > New Easel. Ctrl+Shift+E is the Network panel elsewhere.
      key: mac ? { id: "key_whimsyNewEasel", key: "E", modifiers: "control,shift" } : null,
    });
    WhimsyShortcuts.addActions([
      {
        l10nId: "whimsy-action-new-easel",
        command: "cmd_whimsyNewEasel",
        icon: "chrome://browser/skin/zen-icons/paintbrush.svg",
        isAvailable: () => this.enabled,
      },
    ]);
  },

  registerActor() {
    if (actorRegistered) {
      return;
    }
    actorRegistered = true;
    ChromeUtils.registerWindowActor("WhimsyEasel", {
      parent: { esModuleURI: "resource:///modules/whimsy/WhimsyEaselParent.sys.mjs" },
      child: { esModuleURI: "resource:///modules/whimsy/WhimsyEaselChild.sys.mjs" },
      // The child only acts on a message from the parent, after the capture
      // overlay opened in that page; it never reads the page itself.
      safeForUntrustedWebProcess: true,
    });
  },

  // Firefox Screenshots' region toolbar (Cancel, Copy, Download) lives in
  // the page; once Firefox shows the overlay, ask the page's Whimsy child to
  // add "Add to Easel" beside Copy.
  hookScreenshots() {
    if (screenshotsHooked) {
      return;
    }
    screenshotsHooked = true;
    const utils = lazy.ScreenshotsUtils;
    const original = utils.showPanelAndOverlay;
    const easel = this;
    utils.showPanelAndOverlay = function (browser, ...args) {
      const result = original.call(this, browser, ...args);
      try {
        easel.offerCaptureButton(browser);
      } catch (e) {
        console.error("Whimsy: easel capture button", e);
      }
      return result;
    };
  },

  offerCaptureButton(browser) {
    if (!this.enabled || !browser?.browsingContext || lazy.PrivateBrowsingUtils.isBrowserPrivate(browser)) {
      return;
    }
    const state = lazy.ScreenshotsUtils.browserToScreenshotsState?.get(browser);
    if (state?.mode && state.mode != "screenshots") {
      return;
    }
    browser.browsingContext.currentWindowGlobal?.getActor("WhimsyEasel").sendAsyncMessage("WhimsyEasel:OfferButton");
  },

  // -- profiles (wave9) ---------------------------------------------------

  /** The profile key of the space in front of `win`. */
  profileKeyForWindow(win) {
    return lazy.WhimsyProfiles.keyFor(lazy.WhimsyProfiles.activeProfileId(win));
  },

  /** The profile key of a page's tab (its container). */
  profileKeyForBrowser(browser) {
    const tab = browser?.documentGlobal?.gBrowser?.getTabForBrowser(browser);
    return lazy.WhimsyProfiles.keyFor(tab?.userContextId ?? browser?.browsingContext?.originAttributes?.userContextId ?? 0);
  },

  /**
   * Whether `win` may make a persistent easel now: never from a private
   * window, a private tab or Scratch (they keep nothing).
   */
  canPersistIn(win) {
    if (!win || lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      return false;
    }
    try {
      if (lazy.WhimsyPrivate.isPrivateTab(win.gBrowser?.selectedTab) || lazy.WhimsyPrivate.activeSpaceIsScratch(win)) {
        return false;
      }
    } catch (e) {
      console.error("Whimsy: easel private check", e);
      return false;
    }
    return true;
  },

  // Opens the easel (selecting its tab if one is open) in its profile's
  // container, so the tab belongs in a space of that profile (wave8
  // isolation) and the page knows whose easel it shows. New easels open
  // pinned, like Arc. `profileKey` defaults to the window's profile.
  openEasel(win, id, { pin = false, profileKey = null } = {}) {
    const url = easelURL(id);
    const existing = win.gBrowser.tabs.find(tab => easelIdFromURL(tab.linkedBrowser?.currentURI?.spec) == id);
    if (existing) {
      win.gBrowser.selectedTab = existing;
      return existing;
    }
    const userContextId = lazy.WhimsyProfiles.idForKey(profileKey ?? this.profileKeyForWindow(win));
    if (userContextId == null) {
      // A profile this device doesn't have.
      return null;
    }
    const tab = win.gBrowser.addTrustedTab(url, { inBackground: false, userContextId });
    win.gBrowser.selectedTab = tab;
    if (pin) {
      win.gBrowser.pinTab(tab);
    }
    return tab;
  },

  async newEasel(win, { title = "", items = [] } = {}) {
    if (!this.enabled) {
      return null;
    }
    if (!this.canPersistIn(win)) {
      win?.gZenUIManager?.showToast?.("whimsy-easel-new-private");
      return null;
    }
    const profileKey = this.profileKeyForWindow(win);
    const easel = await gWhimsyEaselStore.create({ title, profileKey });
    if (items.length) {
      await gWhimsyEaselStore.update(easel.id, { items });
    }
    this.openEasel(win, easel.id, { pin: true, profileKey });
    return easel;
  },

  // wave7: View Easels… (Arc's Window menu) and Add Page to Easel, as
  // registered commands (command bar, about:keyboard), plus the Window menu
  // item; and Sync of easels.
  initExtras(win) {
    const { WhimsyCommands } = lazy;
    try {
      lazy.WhimsyEaselSync.init();
    } catch (e) {
      console.error("Whimsy: easel sync", e);
    }
    WhimsyCommands.register(win, {
      id: "cmd_whimsyViewEasels",
      l10nId: "whimsy-action-view-easels",
      run: w => this.viewEasels(w),
      icon: "chrome://browser/skin/zen-icons/paintbrush.svg",
      isAvailable: () => this.enabled,
    });
    WhimsyCommands.register(win, {
      id: "cmd_whimsyAddPageToEasel",
      l10nId: "whimsy-action-add-page-to-easel",
      run: w => this.addPageToEasel(w.gBrowser.selectedBrowser),
      icon: "chrome://browser/skin/zen-icons/paintbrush.svg",
      isAvailable: w => this.enabled && this.canCapture(w.gBrowser?.selectedBrowser),
    });
    // Arc lists View Easels… in its Window menu, with the Library's other
    // sections. The menu bar is built after this runs, so add it on show.
    const popup = win.document.getElementById("windowPopup");
    popup?.addEventListener("popupshowing", () => this.addWindowMenuItem(win.document));
  },

  addWindowMenuItem(doc) {
    let item = doc.getElementById("menu_whimsyViewEasels");
    if (item) {
      item.hidden = !this.enabled;
    } else if (!this.enabled) {
      return;
    } else {
      item = doc.createXULElement("menuitem");
      item.id = "menu_whimsyViewEasels";
      item.setAttribute("data-l10n-id", "whimsy-menu-view-easels");
      item.setAttribute("command", "cmd_whimsyViewEasels");
    }
    // Arc's order (arc-ref/menus.txt): Open Library…, View Downloads…,
    // View Easels…, View Media…, View Boosts… (wave10, W10-53: it used to
    // land after Boosts). Placed again on every open, in case the Arc menu
    // rows arrived after it.
    const before = doc.getElementById("menu_whimsyViewMedia");
    const after = doc.getElementById("menu_whimsyViewDownloads");
    if (before) {
      if (item.nextElementSibling != before) {
        before.before(item);
      }
    } else if (after) {
      if (item.previousElementSibling != after) {
        after.after(item);
      }
    } else if (!item.parentNode) {
      doc.getElementById("sep-window-list")?.before(item);
    }
  },

  // Opens the Library on Easels.
  viewEasels(win) {
    if (!this.enabled) {
      return false;
    }
    const ZenLibrary = win.customElements.get("zen-library");
    const lib = win.document.querySelector("zen-library");
    if (!ZenLibrary?.toggle || (lib?.zenLibrarySections && !("whimsy-easels" in lib.zenLibrarySections))) {
      return false;
    }
    if (lib?.activeTab != "whimsy-easels" || !ZenLibrary.isLibraryOpen) {
      ZenLibrary.toggle("whimsy-easels");
    }
    return true;
  },

  canCapture(browser) {
    const uri = browser?.currentURI;
    return !!uri && (uri.schemeIs("https") || uri.schemeIs("http")) && !lazy.PrivateBrowsingUtils.isBrowserPrivate(browser);
  },

  // The whole page as one capture (Arc's Capture Full Page, into an easel):
  // up to FULL_PAGE_MAX_HEIGHT tall, cropped live to the same area.
  async capturePage(browser) {
    if (!this.canCapture(browser)) {
      return { error: lazy.PrivateBrowsingUtils.isBrowserPrivate(browser) ? "whimsy-easel-capture-private" : "whimsy-capture-failed-toast" };
    }
    let bounds = null;
    try {
      bounds = await browser.browsingContext.currentWindowGlobal.getActor("WhimsyEasel").sendQuery("WhimsyEasel:PageBounds");
    } catch {}
    const nums = ["width", "height", "viewportWidth", "viewportHeight", "devicePixelRatio"].map(k => bounds?.[k]);
    if (!nums.every(Number.isFinite)) {
      return { error: "whimsy-capture-failed-toast" };
    }
    const [width, height, viewportWidth, , dpr] = nums;
    const capped = Math.min(height, FULL_PAGE_MAX_HEIGHT);
    return this.captureRegion(browser, {
      region: { left: 0, top: 0, right: Math.min(width, MAX_REGION), bottom: capped },
      devicePixelRatio: Math.min(2, dpr),
      // The live view lays the page out at its own width and full height.
      viewportWidth,
      viewportHeight: capped,
    });
  },

  // "Add Page to Easel": the picker, then the chosen easel.
  async addPageToEasel(browser) {
    const win = browser?.documentGlobal;
    if (!win?.gBrowser || !this.enabled) {
      return null;
    }
    const capture = await this.capturePage(browser);
    if (capture.error) {
      win.gZenUIManager?.showToast?.(capture.error);
      return null;
    }
    // From the command: over the page, where the command bar sits.
    return this.showPicker(win, browser, null, easelId => this.addCaptureTo(win, easelId, capture),
      capture.item.profileKey, { capture });
  },

  // Validates a capture request from a page (the child is untrusted).
  sanitizeRegion(data) {
    const region = data?.region;
    const nums = ["left", "top", "right", "bottom"].map(k => region?.[k]);
    if (!nums.every(n => Number.isFinite(n))) {
      return null;
    }
    const [left, top, right, bottom] = nums;
    const width = right - left;
    const height = bottom - top;
    if (width < 4 || height < 4 || width > MAX_REGION || height > MAX_REGION || left < -MAX_REGION || top < -MAX_REGION) {
      return null;
    }
    const dpr = Number.isFinite(data.devicePixelRatio) ? Math.min(4, Math.max(0.5, data.devicePixelRatio)) : 1;
    const clamp = (n, fallback) => (Number.isFinite(n) && n > 0 && n < MAX_REGION ? n : fallback);
    return {
      region: { left, top, right, bottom, width, height, devicePixelRatio: dpr },
      viewportWidth: clamp(data.viewportWidth, 1280),
      viewportHeight: clamp(data.viewportHeight, 800),
    };
  },

  // The capture item for a region of `browser`'s page (image saved later,
  // once an easel is chosen). Returns { item, blob } or { error }.
  async captureRegion(browser, data) {
    if (lazy.PrivateBrowsingUtils.isBrowserPrivate(browser)) {
      return { error: "whimsy-easel-capture-private" };
    }
    const clean = this.sanitizeRegion(data);
    if (!clean) {
      return { error: "whimsy-capture-failed-toast" };
    }
    const { region, viewportWidth, viewportHeight } = clean;
    const crop = { x: Math.round(region.left), y: Math.round(region.top), w: Math.round(region.width), h: Math.round(region.height) };
    let blob;
    try {
      const canvas = await lazy.ScreenshotsUtils.createCanvas({ ...region }, browser);
      blob = await canvas.convertToBlob();
    } catch (e) {
      console.error("Whimsy: easel capture", e);
      return { error: "whimsy-capture-failed-toast" };
    }
    const tab = browser.documentGlobal?.gBrowser?.getTabForBrowser(browser);
    const uri = browser.currentURI;
    const web = uri?.schemeIs("https") || uri?.schemeIs("http");
    const w = Math.min(CAPTURE_MAX_WIDTH, crop.w);
    return {
      blob,
      item: {
        type: "capture",
        w,
        h: Math.round((crop.h * w) / crop.w),
        url: web ? uri.spec : null,
        title: tab?.label || browser.contentTitle || uri?.host || "",
        userContextId: tab?.userContextId || 0,
        // wave9: the profile the capture came from; it only goes on that
        // profile's easels.
        profileKey: this.profileKeyForBrowser(browser),
        crop,
        pageWidth: Math.round(viewportWidth),
        pageHeight: Math.round(viewportHeight),
        live: false,
      },
    };
  },

  // Saves a capture into an easel ("new" makes one). Returns the easel id.
  async addCaptureTo(win, easelId, { item, blob }) {
    const { profileKey: captureKey, ...rest } = item;
    const profileKey = captureKey || DEFAULT_PROFILE_KEY;
    if (easelId == "new" && !this.canPersistIn(win)) {
      win?.gZenUIManager?.showToast?.("whimsy-easel-new-private");
      return null;
    }
    let easel = easelId == "new" ? await gWhimsyEaselStore.create({ profileKey }) : await gWhimsyEaselStore.get(easelId);
    // A capture never crosses into another profile's easel.
    if (!easel || profileKeyOf(easel) !== profileKey) {
      return null;
    }
    // Live, it loads in the easel's profile container.
    const userContextId = lazy.WhimsyProfiles.idForKey(profileKey) ?? 0;
    const image = await gWhimsyEaselStore.saveImage(easel.id, new Uint8Array(await blob.arrayBuffer()));
    await gWhimsyEaselStore.addItem(easel.id, { ...rest, userContextId, image });
    if (easelId == "new") {
      this.openEasel(win, easel.id, { pin: true, profileKey });
    } else {
      // W10-24: says where it went, with Open.
      const id = easel.id;
      lazy.WhimsyToast.show(win, {
        l10nId: "whimsy-easel-capture-added",
        l10nArgs: { title: easel.title || (await this.untitled(win)) },
        action: { l10nId: "whimsy-easel-open", onCommand: () => this.openEasel(win, id, { profileKey }) },
      });
    }
    return easel.id;
  },

  async untitled(win) {
    return (await win.document.l10n.formatValue("whimsy-easel-untitled")) || "Untitled Easel";
  },

  // "Add to Easel" was clicked in a page's capture toolbar.
  async onCaptureRequest(browser, data, anchor) {
    const win = browser?.documentGlobal;
    if (!win?.gBrowser || !this.enabled) {
      return;
    }
    const utils = lazy.ScreenshotsUtils;
    utils.closePanel?.(browser);
    const capture = await this.captureRegion(browser, data);
    utils.exit?.(browser);
    if (capture.error) {
      win.gZenUIManager?.showToast?.(capture.error);
      return;
    }
    await this.showPicker(win, browser, anchor, easelId => this.addCaptureTo(win, easelId, capture),
      capture.item.profileKey, { capture });
  },

  // W10-24: "Add to Easel" is a WhimsySurface (it was a native menu): the
  // capture's own thumbnail and size on top, then a 2-column grid of
  // tiles, New Easel first, then the capture's profile's recent easels with
  // their thumbnails, names and when they were edited. Click or Return
  // adds; Esc leaves the capture unsaved. From the capture toolbar it
  // hangs under the Add to Easel button; from the command, over the page.
  async showPicker(win, browser, anchor, onPick, profileKey = DEFAULT_PROFILE_KEY, { capture = null } = {}) {
    const doc = win.document;
    const urls = [];
    const objectURL = blob => {
      const url = win.URL.createObjectURL(blob);
      urls.push(url);
      return url;
    };
    let picked = false;
    const parts = lazy.WhimsySurface.create(win, {
      id: PICKER_ID,
      width: PICKER_WIDTH,
      titleL10nId: "whimsy-easel-picker-heading",
      close: true,
      className: "whimsy-easel-picker",
      initialFocus: () => grid.querySelector(".whimsy-easel-tile[tabindex='0']"),
      onHidden: () => {
        // The thumbnails are blob: URLs made here.
        win.setTimeout(() => urls.forEach(url => win.URL.revokeObjectURL(url)), 0);
      },
    });
    const { panel, view } = parts;

    if (capture) {
      const head = doc.createXULElement("hbox");
      head.className = "whimsy-easel-picker-capture";
      head.setAttribute("align", "center");
      const preview = doc.createElementNS(HTML_NS, "img");
      preview.className = "whimsy-easel-picker-preview";
      preview.alt = "";
      if (capture.blob) {
        preview.src = objectURL(capture.blob);
      }
      const text = doc.createXULElement("vbox");
      text.setAttribute("flex", "1");
      const kind = doc.createElementNS(HTML_NS, "b");
      kind.className = "whimsy-easel-picker-kind";
      doc.l10n.setAttributes(kind, capture.item?.live ? "whimsy-easel-picker-live" : "whimsy-easel-picker-still");
      const size = doc.createElementNS(HTML_NS, "span");
      size.className = "whimsy-easel-picker-size";
      const crop = capture.item?.crop ?? {};
      doc.l10n.setAttributes(size, capture.item?.live ? "whimsy-easel-picker-size-live" : "whimsy-easel-picker-size-still",
        { width: Math.round(crop.w ?? 0), height: Math.round(crop.h ?? 0) });
      text.append(kind, size);
      head.append(preview, text);
      view.append(head);
    }

    const grid = doc.createElementNS(HTML_NS, "div");
    grid.className = "whimsy-easel-grid";
    grid.setAttribute("role", "grid");
    grid.dataset.columns = "2";
    grid.setAttribute("aria-labelledby", `${PICKER_ID}-title`);
    const choose = id => {
      picked = true;
      lazy.WhimsySurface.close(panel);
      onPick(id);
    };
    const tile = (id, className) => {
      const button = doc.createElementNS(HTML_NS, "button");
      button.type = "button";
      button.className = `whimsy-easel-tile ${className}`;
      button.setAttribute("role", "gridcell");
      button.tabIndex = -1;
      button.dataset.easel = id;
      button.addEventListener("click", () => choose(id));
      button.addEventListener("keydown", event => {
        if (event.key == "Enter" || event.key == " ") {
          event.preventDefault();
          choose(id);
        }
      });
      return button;
    };
    const fresh = tile("new", "whimsy-easel-tile-new");
    const plus = doc.createElementNS(HTML_NS, "span");
    plus.className = "whimsy-easel-tile-plus";
    plus.setAttribute("aria-hidden", "true");
    plus.textContent = "+";
    const freshName = doc.createElementNS(HTML_NS, "span");
    freshName.className = "whimsy-easel-tile-name";
    doc.l10n.setAttributes(freshName, "whimsy-easel-picker-new-tile");
    fresh.append(plus, freshName);
    fresh.tabIndex = 0;
    grid.append(fresh);

    const easels = (await gWhimsyEaselStore.list(profileKey)).slice(0, PICKER_EASELS);
    const untitled = await this.untitled(win);
    for (const easel of easels) {
      const button = tile(easel.id, "whimsy-easel-tile-easel");
      const thumb = doc.createElementNS(HTML_NS, "span");
      thumb.className = "whimsy-easel-tile-thumb";
      thumb.setAttribute("loading", "true");
      const name = doc.createElementNS(HTML_NS, "span");
      name.className = "whimsy-easel-tile-name";
      name.textContent = easel.title || untitled;
      button.title = easel.title || untitled;
      const when = doc.createElementNS(HTML_NS, "span");
      when.className = "whimsy-easel-tile-when";
      doc.l10n.setAttributes(when, "whimsy-easel-edited", { when: this.editedWhen(easel.updated) });
      button.append(thumb, name, when);
      grid.append(button);
      gWhimsyEaselStore.thumbnail(easel.id).then(picture => {
        thumb.removeAttribute("loading");
        if (picture && panel.isConnected) {
          const img = doc.createElementNS(HTML_NS, "img");
          img.alt = "";
          img.src = objectURL(new win.Blob([picture.bytes], { type: picture.type }));
          thumb.append(img);
        }
      }, () => thumb.removeAttribute("loading"));
    }
    view.append(grid);
    if (!easels.length) {
      // No easels yet: New Easel as a wide row, and what an easel is.
      grid.setAttribute("first", "true");
      grid.dataset.columns = "1";
      const hint = doc.createElementNS(HTML_NS, "p");
      hint.className = "whimsy-easel-picker-first";
      doc.l10n.setAttributes(hint, "whimsy-easel-picker-first");
      view.append(hint);
    }
    lazy.WhimsySurface.finish(parts);

    if (anchor && browser && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) {
      lazy.WhimsySurface.open(win, panel, { anchor: browser, position: "overlap", x: anchor.x, y: anchor.y + 2 });
    } else {
      lazy.WhimsySurface.open(win, panel, { at: "page-top-center" });
    }
    panel._whimsyPicked = () => picked;
    return panel;
  },

  // "2 hours ago", "yesterday", or "Oct 12" for anything older than a week.
  editedWhen(ms) {
    const locale = Services.locale.appLocaleAsBCP47;
    const diff = (Number(ms) || Date.now()) - Date.now();
    const minutes = Math.round(diff / 60000);
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    if (Math.abs(minutes) < 60) {
      return rtf.format(Math.min(0, minutes), "minute");
    }
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) {
      return rtf.format(hours, "hour");
    }
    const days = Math.round(hours / 24);
    if (Math.abs(days) < 7) {
      return rtf.format(days, "day");
    }
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(Number(ms)));
  },
};
