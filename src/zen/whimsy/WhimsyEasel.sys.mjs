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
// and whimsy-easels/<easel id>/ (image files). No sync and no public links
// (Arc shared to arc.net; Whimsy has no server): the page exports PNG/PDF
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
});

export const FEATURE_PREF = "whimsy.feature.easel";
export const CHANGED_TOPIC = "whimsy-easels-changed";
const STORE_FILENAME = "whimsy-easels.json";
const IMAGES_DIR = "whimsy-easels";
const PAGE_URL = "about:whimsy?easel";
const MENU_ID = "whimsy-easel-capture-menu";
// Captures land on the canvas at most this wide (canvas px).
const CAPTURE_MAX_WIDTH = 520;
// Anything bigger is not a real selection.
const MAX_REGION = 30000;
// A deleted easel's images stay this long, for Undo.
const TRASH_MS = 30000;

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
      this.#file = file;
    })();
    await this.#loading;
    return this.#file;
  }

  #notify(id, source = "") {
    Services.obs.notifyObservers(null, CHANGED_TOPIC, JSON.stringify({ id, source }));
  }

  // Newest first.
  async list() {
    const file = await this.#ensureLoaded();
    return [...file.data.easels].sort((a, b) => b.updated - a.updated);
  }

  async get(id) {
    const file = await this.#ensureLoaded();
    return file.data.easels.find(e => e.id == id) ?? null;
  }

  async create({ title = "" } = {}) {
    const file = await this.#ensureLoaded();
    const now = Date.now();
    const easel = { id: newId(), title, items: [], view: null, created: now, updated: now };
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

  async restore(id) {
    const entry = this.#trash.get(id);
    if (!entry) {
      return null;
    }
    lazy.clearTimeout(entry.timer);
    this.#trash.delete(id);
    const file = await this.#ensureLoaded();
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

  // Opens the easel (selecting its tab if one is open). New easels open
  // pinned, like Arc.
  openEasel(win, id, { pin = false } = {}) {
    const url = easelURL(id);
    const existing = win.gBrowser.tabs.find(tab => easelIdFromURL(tab.linkedBrowser?.currentURI?.spec) == id);
    if (existing) {
      win.gBrowser.selectedTab = existing;
      return existing;
    }
    const tab = win.gBrowser.addTrustedTab(url, { inBackground: false });
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
    const easel = await gWhimsyEaselStore.create({ title });
    if (items.length) {
      await gWhimsyEaselStore.update(easel.id, { items });
    }
    this.openEasel(win, easel.id, { pin: true });
    return easel;
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
        crop,
        pageWidth: Math.round(viewportWidth),
        pageHeight: Math.round(viewportHeight),
        live: false,
      },
    };
  },

  // Saves a capture into an easel ("new" makes one). Returns the easel id.
  async addCaptureTo(win, easelId, { item, blob }) {
    let easel = easelId == "new" ? await gWhimsyEaselStore.create() : await gWhimsyEaselStore.get(easelId);
    if (!easel) {
      return null;
    }
    const image = await gWhimsyEaselStore.saveImage(easel.id, new Uint8Array(await blob.arrayBuffer()));
    await gWhimsyEaselStore.addItem(easel.id, { ...item, image });
    if (easelId == "new") {
      this.openEasel(win, easel.id, { pin: true });
    } else {
      win.gZenUIManager?.showToast?.("whimsy-easel-capture-added", {
        l10nArgs: { title: easel.title || (await this.untitled(win)) },
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
    await this.showPicker(win, browser, anchor, easelId => this.addCaptureTo(win, easelId, capture));
  },

  // The "Add to Easel" menu: New Easel, then recent easels.
  async showPicker(win, browser, anchor, onPick) {
    const doc = win.document;
    let menu = doc.getElementById(MENU_ID);
    if (!menu) {
      menu = doc.createXULElement("menupopup");
      menu.id = MENU_ID;
      (doc.getElementById("mainPopupSet") ?? doc.documentElement).append(menu);
    }
    menu.replaceChildren();
    const add = (id, attrs) => {
      const item = doc.createXULElement("menuitem");
      for (const [k, v] of Object.entries(attrs)) {
        item.setAttribute(k, v);
      }
      item.addEventListener("command", () => onPick(id));
      menu.append(item);
      return item;
    };
    const header = doc.createXULElement("menucaption");
    doc.l10n.setAttributes(header, "whimsy-easel-picker-title");
    menu.append(header);
    const fresh = add("new", { class: "menuitem-iconic" });
    doc.l10n.setAttributes(fresh, "whimsy-easel-picker-new");
    fresh.setAttribute("image", "chrome://browser/skin/zen-icons/plus.svg");
    const easels = (await gWhimsyEaselStore.list()).slice(0, 8);
    if (easels.length) {
      menu.append(doc.createXULElement("menuseparator"));
    }
    const untitled = await this.untitled(win);
    for (const easel of easels) {
      add(easel.id, { label: easel.title || untitled, class: "menuitem-iconic", image: "chrome://browser/skin/zen-icons/paintbrush.svg" });
    }
    const x = Number.isFinite(anchor?.x) ? anchor.x : 0;
    const y = Number.isFinite(anchor?.y) ? anchor.y : 0;
    menu.openPopup(browser, { position: "overlap", x, y });
    return menu;
  },
};
