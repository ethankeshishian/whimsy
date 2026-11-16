/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W28 (W27 design x-navigation-search-page-minimap): Page Minimap. A narrow
// live picture of a long page floats at its right edge with the visible part
// outlined; a click centres that spot, dragging the outline scrolls. It shows
// only on pages more than two screens long, fades two seconds after
// scrolling stops (unless the pointer is on it), and comes back on scroll or
// when the pointer nears the right edge. Off by default; Show Page Minimap
// (command bar) turns it on in every window (whimsy.minimap.enabled).
//
// The page side (WhimsyMinimapChild) only measures and scrolls its own
// page. The picture comes from the window's compositor (drawSnapshot, as the
// command bar and Claude use it), drawn into a <canvas> in the browser
// stack: never while the tab is in the background, the minimap is faded, or
// the outline is being dragged; at most once every two seconds while the
// page changes, and when scrolling stops. Scrolling itself only moves the
// outline (and the picture, on a page taller than the minimap) with a
// transform. Pages over 30 screens get a 30-screen band of the page around
// the view, moved when scrolling stops.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.page-minimap";
const PREF = "whimsy.minimap.enabled";
// How long after scrolling stops it fades; tests shorten it.
const IDLE_PREF = "whimsy.minimap.idle-ms";
const IDLE_MS = 2000;
const SHEET = "chrome://browser/content/whimsy/whimsy-minimap.css";
const ICON = "chrome://browser/skin/zen-icons/search-page.svg";
const ACTOR = "WhimsyMinimap";
const COMMAND = "cmd_whimsyPageMinimap";
const TOAST_KEY = "whimsy-page-minimap";
const HTML = "http://www.w3.org/1999/xhtml";
// The picture's width inside the 104px minimap (9px each side).
const PICTURE_WIDTH = 86;
// The outline is never shorter than this, so it can always be grabbed.
const MIN_OUTLINE = 12;
// Pages longer than this many screens are pictured as a band around the view.
const MAX_SCREENS = 30;
const REFRESH_MS = 2000;
const SCROLL_STOP_MS = 150;

const windows = new WeakSet();
// browser -> MapView
let views = new WeakMap();
let actorRegistered = false;

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

// What the page said, checked: it comes from a web process.
function readState(data) {
  const y = Number(data?.y);
  const height = Number(data?.height);
  const view = Number(data?.view);
  const width = Number(data?.width);
  if (![y, height, view, width].every(Number.isFinite) || view <= 0 || width <= 0 || height <= 0) {
    return null;
  }
  return { y: Math.max(0, y), height, view, width };
}

class MapView {
  constructor(browser) {
    this.browser = browser;
    this.win = browser.ownerDocument.documentGlobal;
    this.state = null;
    this.el = null;
    this.band = null;
    this.drag = null;
    this.dirty = true;
    this.lastShot = 0;
    this.shooting = false;
    this.idleTimer = 0;
    this.stopTimer = 0;
    this.refreshTimer = 0;
    this.dragFrame = 0;
    this.trackHeight = 0;
  }

  get long() {
    const state = this.state;
    return !!state && state.height > 2 * state.view;
  }

  // Shown, awake, and its tab on screen: the only time a picture is taken.
  get awake() {
    return !!this.el?.isConnected && !this.el.hidden && !this.el.classList.contains("is-idle") && this.browser.docShellIsActive;
  }

  get reducedMotion() {
    return this.win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  build() {
    if (this.el) {
      return;
    }
    const doc = this.win.document;
    const container = this.win.gBrowser.getBrowserContainer?.(this.browser) ?? this.browser.closest(".browserContainer");
    if (!container) {
      return;
    }
    const el = doc.createElementNS(HTML, "div");
    el.className = "whimsy-minimap whimsy-surface-tokens is-idle";
    el.hidden = true;
    el.setAttribute("role", "scrollbar");
    el.setAttribute("aria-orientation", "vertical");
    el.setAttribute("aria-valuemin", "0");
    el.setAttribute("aria-valuemax", "100");
    el.setAttribute("aria-valuenow", "0");
    doc.l10n.setAttributes(el, "whimsy-minimap");
    const track = doc.createElementNS(HTML, "div");
    track.className = "whimsy-minimap-track";
    const canvas = doc.createElementNS(HTML, "canvas");
    canvas.className = "whimsy-minimap-picture";
    canvas.width = 0;
    canvas.height = 0;
    const outline = doc.createElementNS(HTML, "div");
    outline.className = "whimsy-minimap-view";
    track.append(canvas, outline);
    el.append(track);
    container.append(el);
    this.el = el;
    this.track = track;
    this.canvas = canvas;
    this.outline = outline;
    el.addEventListener("pointerdown", e => this.onPointerDown(e));
    el.addEventListener("pointermove", e => this.onPointerMove(e));
    el.addEventListener("pointerup", e => this.endDrag(e));
    el.addEventListener("lostpointercapture", e => this.endDrag(e));
    el.addEventListener("mouseenter", () => this.wake());
    el.addEventListener("mouseleave", () => this.armIdle());
    // The minimap's height follows the window and the find card; read it
    // only when it changes, never while scrolling.
    this.resizer = new this.win.ResizeObserver(() => {
      this.trackHeight = this.track.clientHeight;
      this.layout();
    });
    this.resizer.observe(track);
  }

  remove() {
    this.clearTimers();
    this.resizer?.disconnect();
    this.el?.remove();
    this.el = null;
  }

  clearTimers() {
    for (const name of ["idleTimer", "stopTimer", "refreshTimer"]) {
      this.win.clearTimeout(this[name]);
      this[name] = 0;
    }
    if (this.dragFrame) {
      this.win.cancelAnimationFrame(this.dragFrame);
      this.dragFrame = 0;
    }
  }

  // A new page: nothing shows until it reports in.
  reset() {
    this.state = null;
    this.band = null;
    this.dirty = true;
    this.drag = null;
    this.clearTimers();
    if (this.el) {
      this.el.hidden = true;
      this.el.classList.add("is-idle");
      this.el.classList.remove("is-dragging");
      this.canvas.width = this.canvas.height = 0;
    }
  }

  onState(state, { wake = false } = {}) {
    const height = this.state?.height;
    const width = this.state?.width;
    this.state = state;
    if (!this.long) {
      if (this.el) {
        this.el.hidden = true;
        this.el.classList.add("is-idle");
      }
      return;
    }
    this.build();
    if (!this.el) {
      return;
    }
    this.el.hidden = false;
    if (height != state.height || width != state.width) {
      this.requestShot();
    }
    this.layout();
    if (wake) {
      this.wake();
    }
  }

  onScroll(y) {
    if (!this.state) {
      return;
    }
    this.state.y = Math.max(0, y);
    if (!this.long || !this.el) {
      return;
    }
    // While dragging, the outline follows the pointer, not the page.
    if (!this.drag) {
      this.layout();
    }
    this.wake();
    this.win.clearTimeout(this.stopTimer);
    this.stopTimer = this.win.setTimeout(() => {
      this.stopTimer = 0;
      this.requestShot();
    }, SCROLL_STOP_MS);
  }

  // Shows it (a scroll, the pointer at the edge) and starts the fade timer.
  wake() {
    if (!this.el || this.el.hidden) {
      return;
    }
    if (this.el.classList.contains("is-idle")) {
      this.el.classList.remove("is-idle");
      this.trackHeight = this.track.clientHeight;
      this.layout();
      if (this.dirty) {
        this.requestShot();
      }
    }
    this.armIdle();
  }

  armIdle() {
    if (!this.el) {
      return;
    }
    this.win.clearTimeout(this.idleTimer);
    const ms = Services.prefs.getIntPref(IDLE_PREF, IDLE_MS);
    this.idleTimer = this.win.setTimeout(() => {
      this.idleTimer = 0;
      if (!this.el) {
        return;
      }
      if (this.drag || this.el.matches(":hover")) {
        this.armIdle();
        return;
      }
      this.el.classList.add("is-idle");
    }, ms);
  }

  // Where things sit, in CSS pixels of the track. On a page taller than the
  // track the picture scrolls with the view, like a code editor's minimap,
  // so the outline moves like a scrollbar's thumb.
  geometry(y = this.state.y) {
    const { height, view, width } = this.state;
    const scale = PICTURE_WIDTH / width;
    const track = this.trackHeight || this.track?.clientHeight || 0;
    const max = Math.max(1, height - view);
    const outline = Math.max(view * scale, MIN_OUTLINE);
    const windowed = height * scale > track;
    const ratio = windowed ? Math.max(0, track - outline) / max : scale;
    const top = clamp(y, 0, max) * ratio;
    return { scale, max, outline, ratio, top, mapTop: clamp(y, 0, max) * scale - top };
  }

  layout(y = this.state?.y) {
    if (!this.el || !this.state || !this.long) {
      return;
    }
    const geo = this.geometry(y);
    this.outline.style.height = `${geo.outline}px`;
    this.outline.style.transform = `translateY(${geo.top}px)`;
    const bandTop = this.band ? this.band.top * geo.scale : 0;
    this.canvas.style.transform = `translateY(${bandTop - geo.mapTop}px)`;
    this.el.setAttribute("aria-valuenow", String(Math.round((clamp(y, 0, geo.max) / geo.max) * 100)));
  }

  // At most once every two seconds; a faded or background minimap waits
  // until it shows again.
  requestShot() {
    this.dirty = true;
    if (!this.awake || this.refreshTimer) {
      return;
    }
    const wait = Math.max(0, this.lastShot + REFRESH_MS - Date.now());
    this.refreshTimer = this.win.setTimeout(() => {
      this.refreshTimer = 0;
      this.shoot();
    }, wait);
  }

  async shoot() {
    if (!this.awake || this.drag || this.shooting || !this.long) {
      return;
    }
    const global = this.browser.browsingContext?.currentWindowGlobal;
    if (!global) {
      return;
    }
    const { height, view, width, y } = this.state;
    const scale = PICTURE_WIDTH / width;
    let top = 0;
    let span = height;
    if (height > MAX_SCREENS * view) {
      span = MAX_SCREENS * view;
      top = clamp(y + view / 2 - span / 2, 0, height - span);
    }
    this.shooting = true;
    this.lastShot = Date.now();
    this.dirty = false;
    let bitmap = null;
    try {
      bitmap = await global.drawSnapshot(new this.win.DOMRect(0, top, width, span), scale * this.win.devicePixelRatio, "white");
    } catch (e) {
      // The page went away or changed process mid-paint; the next change
      // or scroll stop paints again.
      this.dirty = true;
    } finally {
      this.shooting = false;
    }
    if (!bitmap) {
      return;
    }
    if (!this.el || this.browser.browsingContext?.currentWindowGlobal != global) {
      bitmap.close();
      return;
    }
    this.canvas.width = bitmap.width;
    this.canvas.height = bitmap.height;
    this.canvas.style.height = `${span * scale}px`;
    this.canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
    this.band = { top, span };
    this.layout();
  }

  trackY(event) {
    return event.clientY - this.track.getBoundingClientRect().top;
  }

  onPointerDown(event) {
    if (event.button != 0 || !this.long) {
      return;
    }
    event.preventDefault();
    const at = this.trackY(event);
    const geo = this.geometry();
    let offset = at - geo.top;
    if (offset < 0 || offset > geo.outline) {
      // A click outside the outline centres that spot.
      const pageY = (at + geo.mapTop) / geo.scale;
      const target = clamp(pageY - this.state.view / 2, 0, geo.max);
      this.scrollTo(target, !this.reducedMotion);
      offset = geo.outline / 2;
    }
    this.drag = { offset, pointerId: event.pointerId, moved: false };
    this.el.setPointerCapture(event.pointerId);
    this.el.classList.add("is-dragging");
    this.wake();
  }

  onPointerMove(event) {
    if (!this.drag || event.pointerId != this.drag.pointerId) {
      return;
    }
    const geo = this.geometry();
    const top = this.trackY(event) - this.drag.offset;
    this.drag.y = geo.ratio > 0 ? clamp(top / geo.ratio, 0, geo.max) : 0;
    this.drag.moved = true;
    this.layout(this.drag.y);
    if (!this.dragFrame) {
      this.dragFrame = this.win.requestAnimationFrame(() => {
        this.dragFrame = 0;
        if (this.drag?.moved) {
          this.scrollTo(this.drag.y, false);
        }
      });
    }
  }

  endDrag(event) {
    if (!this.drag || event.pointerId != this.drag.pointerId) {
      return;
    }
    if (this.drag.moved) {
      this.scrollTo(this.drag.y, false);
      this.state.y = this.drag.y;
    }
    this.drag = null;
    this.el.classList.remove("is-dragging");
    if (this.el.hasPointerCapture(event.pointerId)) {
      this.el.releasePointerCapture(event.pointerId);
    }
    this.layout();
    this.armIdle();
    if (this.dirty) {
      this.requestShot();
    }
  }

  scrollTo(y, smooth) {
    try {
      this.browser.browsingContext?.currentWindowGlobal?.getActor(ACTOR).sendAsyncMessage("WhimsyMinimap:ScrollTo", { y, smooth });
    } catch (e) {
      // No page to scroll.
    }
  }
}

export class WhimsyMinimapParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (!WhimsyMinimap.on) {
      return;
    }
    const browser = this.browsingContext.top?.embedderElement;
    if (!browser || browser.browsingContext?.currentWindowGlobal != this.manager) {
      return;
    }
    switch (message.name) {
      case "WhimsyMinimap:State": {
        const state = readState(message.data);
        if (state) {
          WhimsyMinimap.view(browser)?.onState(state);
        }
        break;
      }
      case "WhimsyMinimap:Scroll": {
        const y = Number(message.data?.y);
        if (Number.isFinite(y)) {
          views.get(browser)?.onScroll(y);
        }
        break;
      }
      case "WhimsyMinimap:Edge":
        if (message.data?.near === true) {
          views.get(browser)?.wake();
        }
        break;
    }
  }
}

export const WhimsyMinimap = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  // Show Page Minimap is on (and the feature is).
  get on() {
    return this.enabled && Services.prefs.getBoolPref(PREF, false);
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    this.sync = this.sync.bind(this);
    Services.prefs.addObserver(PREF, this.sync);
    Services.prefs.addObserver(FEATURE_PREF, this.sync);
    this.syncActor();
  },

  // The page side exists only while the minimap is on.
  syncActor() {
    const on = this.on;
    if (on && !actorRegistered) {
      ChromeUtils.registerWindowActor(ACTOR, {
        parent: { esModuleURI: "resource:///modules/whimsy/WhimsyMinimap.sys.mjs" },
        child: {
          esModuleURI: "resource:///modules/whimsy/WhimsyMinimapChild.sys.mjs",
          events: { pageshow: { mozSystemGroup: true }, pagehide: { mozSystemGroup: true } },
        },
        matches: ["https://*/*", "http://*/*", "file:///*"],
        messageManagerGroups: ["browsers"],
        allFrames: false,
        // The child only measures and scrolls its own page; the parent checks
        // every number it sends (readState) and never runs anything from it.
        safeForUntrustedWebProcess: true,
      });
      actorRegistered = true;
    } else if (!on && actorRegistered) {
      ChromeUtils.unregisterWindowActor(ACTOR);
      actorRegistered = false;
    }
  },

  sync() {
    this.syncActor();
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (!windows.has(win)) {
        continue;
      }
      if (this.on) {
        this.startVisible(win);
      } else {
        for (const el of win.document.querySelectorAll(".whimsy-minimap")) {
          el.remove();
        }
      }
    }
    if (!this.on) {
      views = new WeakMap();
    }
  },

  initWindow(win) {
    if (windows.has(win) || !win.gBrowser) {
      return;
    }
    windows.add(win);
    this.init();
    try {
      win.windowUtils.loadSheetUsingURIString(SHEET, win.windowUtils.AUTHOR_SHEET);
    } catch (e) {
      console.error("Whimsy: minimap sheet", e);
    }
    lazy.WhimsyCommands.register(win, {
      id: COMMAND,
      l10nId: "whimsy-action-page-minimap-toggle",
      icon: ICON,
      run: w => this.enabled && this.toggle(w),
      isAvailable: () => this.enabled,
      whimsyKeywords: () => lazy.WhimsyCommands.keywords("whimsy-keywords-page-minimap"),
      variants: [
        { l10nId: "whimsy-action-page-minimap-show", isAvailable: () => this.enabled && !this.on },
        { l10nId: "whimsy-action-page-minimap-hide", isAvailable: () => this.on },
      ],
    });
    win.gBrowser.addTabsProgressListener({
      onLocationChange: (browser, webProgress, request, location, flags) => {
        if (webProgress?.isTopLevel && !(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT)) {
          views.get(browser)?.reset();
        }
      },
    });
    win.gBrowser.tabContainer.addEventListener("TabSelect", () => {
      if (this.on) {
        this.startVisible(win);
      }
    });
    if (this.on) {
      this.startVisible(win);
    }
  },

  view(browser) {
    let view = views.get(browser);
    if (!view) {
      view = new MapView(browser);
      views.set(browser, view);
    }
    return view;
  },

  // The browsers on screen (two or more in a split view).
  visibleBrowsers(win) {
    const browsers = new Set([win.gBrowser.selectedBrowser]);
    for (const tab of win.gBrowser.visibleTabs ?? []) {
      if (tab.linkedBrowser?.docShellIsActive) {
        browsers.add(tab.linkedBrowser);
      }
    }
    return [...browsers];
  },

  // Asks each page on screen how long it is (and starts its page side, for
  // a page that loaded before the minimap was turned on).
  startVisible(win, { wake = false } = {}) {
    return Promise.all(this.visibleBrowsers(win).map(browser => this.start(browser, { wake })));
  },

  async start(browser, { wake = false } = {}) {
    const global = browser?.browsingContext?.currentWindowGlobal;
    if (!this.on || !global) {
      return null;
    }
    let state = null;
    try {
      state = readState(await global.getActor(ACTOR).sendQuery("WhimsyMinimap:Start"));
    } catch (e) {
      // Not a web page (about:, a PDF, the new tab page).
      return null;
    }
    if (!state || !this.on || browser.browsingContext?.currentWindowGlobal != global) {
      return null;
    }
    this.view(browser).onState(state, { wake });
    return state;
  },

  async toggle(win) {
    const on = !this.on;
    Services.prefs.setBoolPref(PREF, on);
    if (!on) {
      return false;
    }
    // Shown at once on a long page; a short one says why nothing appeared.
    const state = await this.start(win.gBrowser.selectedBrowser, { wake: true });
    if (state && state.height <= 2 * state.view) {
      try {
        win.gZenUIManager?.toasts?.open("whimsy-minimap-short-toast", { key: TOAST_KEY, timeout: 4000 });
      } catch (e) {
        console.error("Whimsy: minimap toast", e);
      }
    }
    return true;
  },
};
