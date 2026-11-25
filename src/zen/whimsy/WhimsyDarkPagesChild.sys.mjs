/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Native themes first; Zen Boosts' existing per-color paint path second.
// No document-sized filters, CSSOM rewriting, or per-element mutation work.
import {
  DARK_PAGES_KEY, beginDarkPage, setAdaptiveDarkPage, endDarkPage,
} from "resource:///modules/whimsy/WhimsyDarkPagesConfig.sys.mjs";

const GATE = "@media screen { html { background: #1c1b22 !important; } body { opacity: 0 !important; } }";
// Canvases follow the same inversion in the engine: a 2D canvas recolours
// its colours as it draws (emoji glyphs and images keep theirs), and WebGL
// and other canvases keep a display-time lightness flip
// (src/zen/whimsy/emoji/WhimsyDarkCanvas.h).
const FADE = "::view-transition-old(root), ::view-transition-new(root) { animation-duration: 240ms !important; }";

function luminance(value) {
  const color = InspectorUtils.colorToRGBA(value);
  return color?.a > 0.9 ? (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255 : null;
}

export class WhimsyDarkPagesChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type == "DOMDocElementInserted") {
      this.start();
    } else if (!this._record && event.type == "pageshow" && event.persisted) {
      // Back from the cache, from before the actor was registered.
      this._ready = true;
      this.settle();
      this.start();
    } else if (this._record && (event.type == "DOMContentLoaded" || event.type == "pageshow")) {
      this._ready = true;
      this.settle();
      if (event.type == "pageshow" && event.persisted) {
        this._record = beginDarkPage(this.browsingContext);
        this._originalScheme = this._record.originalScheme;
        this.configure();
      } else {
        this.refresh();
      }
    } else if (this._record && this._ready) {
      if (event.type == "beforeprint") {
        this._printing = true;
        this._observer?.disconnect();
        setAdaptiveDarkPage(this._record, false);
        this.sheet("dim", null);
      } else if (event.type == "afterprint") {
        this._printing = false;
        this.configure();
      } else if (event.type == "pagehide") {
        this._transition?.skipTransition();
      } else if (event.type == "load" && event.target == this.document) {
        // A slow page's own load restarts the settling time.
        this.settle();
        this.schedule();
      } else if (!event.type.startsWith("Style") || event.stylesheet?.ownerNode || event.rule?.parentStyleSheet?.ownerNode) {
        this.schedule();
      }
    }
  }

  // A page open before the actor was registered (Whimsy's startup hook
  // runs after session restore) missed DOMDocElementInserted; the parent
  // starts it with this message, so settings apply to it live.
  receiveMessage({ name }) {
    if (name == "Whimsy:DarkPagesStart" && !this._record) {
      this._ready = this.document.readyState != "loading";
      this.settle();
      this.start();
    }
  }

  start() {
    if (this._record || this.document.contentType != "text/html") {
      return;
    }
    this._record = beginDarkPage(this.browsingContext);
    this._originalScheme = this._record.originalScheme;
    this._sharedChange = e => {
      if (e.changedKeys.includes(DARK_PAGES_KEY)) {
        this.configure();
      }
    };
    Services.cpmm.sharedData.addEventListener("change", this._sharedChange);
    this.document.styleSheetChangeEventsEnabled = true;
    this.configure();
  }

  sheet(name, css) {
    const utils = this.contentWindow.windowUtils;
    this._sheets ??= new Map();
    const previous = this._sheets.get(name);
    const next = css ? `data:text/css,${encodeURIComponent(css)}` : null;
    if (previous == next) {
      return;
    }
    if (next) {
      utils.loadSheetUsingURIString(next, utils.USER_SHEET);
      this._sheets.set(name, next);
    } else {
      this._sheets.delete(name);
    }
    if (previous) {
      utils.removeSheetUsingURIString(previous, utils.USER_SHEET);
    }
  }

  configure() {
    const config = Services.cpmm.sharedData.get(DARK_PAGES_KEY);
    // The parent's key (WhimsyDarkPages.siteKey): the page's address, not
    // its principal, which is opaque for a CSP-sandboxed page.
    const oa = this.browsingContext.originAttributes;
    const key = `${oa.userContextId || 0}|${this.document.documentURIObject.prePath}`;
    const isPrivate = !!oa.privateBrowsingId;
    const sites = profileSites(config, isPrivate, key);
    const choice = sites?.[key] || "automatic";
    const active = !!config?.enabled && choice != "off" && (choice == "on" || config.active);
    const manual = config?.manual;
    const animate = this._ready && manual?.serial != this._manual && manual?.key == key && manual?.isPrivate == isPrivate;
    this._manual = manual?.serial;
    const revision = (this._configuration || 0) + 1;
    this._configuration = revision;
    const apply = () => {
      if (this._configuration != revision || !this._record) {
        return;
      }
      this._active = active;
      this._dim = !!config?.dim;
      const scheme = active ? "dark" : this._originalScheme;
      if (this.browsingContext.prefersColorSchemeOverride != scheme) {
        this.browsingContext.prefersColorSchemeOverride = scheme;
      }
      if (this._ready) {
        this.refresh();
      } else {
        this.sheet("gate", active ? GATE : null);
      }
    };
    const win = this.contentWindow;
    this._transition?.skipTransition();
    if (animate && this.document.startViewTransition && !win.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.sheet("fade", FADE);
      // View transitions suppress rendering (including rAF) until this
      // callback settles. Waiting for a frame here deadlocks until Gecko's
      // 10s transition timeout. The Boost setter requests a restyle; Gecko
      // flushes layout before capturing the new state, so keep this synchronous.
      this._transition = this.document.startViewTransition(apply);
      this._transition.ready.catch(() => {});
      this._transition.updateCallbackDone.catch(() => {});
      this._transition.finished.catch(() => {});
    } else {
      apply();
    }
  }

  isDark() {
    const win = this.contentWindow;
    const doc = this.document;
    const root = doc.documentElement;
    // What shows through where nothing paints a background: the canvas,
    // which is dark when the page opts into dark with color-scheme (we've
    // asked it for dark). Pages dark only this way read as light before.
    const canvas = () => {
      const scheme = `${win.getComputedStyle(root).colorScheme} ${
        doc.querySelector("meta[name='color-scheme' i]")?.content || ""}`;
      return /\bdark\b/.test(scheme) && !/\bonly\s+light\b/.test(scheme) ? 0 : 1;
    };
    // Read authored computed colors: the paint-time boost deliberately
    // doesn't change them, so native-theme detection cannot double-darken.
    const background = el => {
      for (let node = el; node; node = node.parentElement) {
        const light = luminance(win.getComputedStyle(node).backgroundColor);
        if (light != null) {
          return light;
        }
      }
      return canvas();
    };
    // A popup, menu or sticky bar floats over the page; it isn't the page.
    // A light sign-in bubble over a dark page used to outvote the page and
    // invert it to grey. A fixed layer that fills the viewport is the page.
    const area = win.innerWidth * win.innerHeight;
    const floating = el => {
      for (let node = el; node && node != root; node = node.parentElement) {
        const position = win.getComputedStyle(node).position;
        if (position == "fixed" || position == "sticky") {
          const rect = node.getBoundingClientRect();
          return rect.width * rect.height < area * 0.9;
        }
      }
      return false;
    };
    let dark = 0;
    let count = 0;
    for (const x of [0.2, 0.5, 0.8]) {
      for (const y of [0.15, 0.45, 0.75]) {
        const el = doc.elementsFromPoint(win.innerWidth * x, win.innerHeight * y).find(e => !floating(e));
        if (el) {
          dark += background(el) < 0.4 ? 1 : 0;
          count++;
        }
      }
    }
    return count ? dark / count >= 0.6 : background(doc.body || root) < 0.4;
  }

  refresh() {
    if (this._printing) {
      return;
    }
    this._observer?.disconnect();
    this.sheet("gate", null);
    const forced = this.contentWindow.matchMedia("(forced-colors: active)").matches;
    const state = !this._active || forced ? "original" : this.isDark() ? "native" : "generated";
    setAdaptiveDarkPage(this._record, state == "generated");
    this.sheet("dim", this._dim && state != "original" ? "@media screen { img, video { filter: brightness(.8) !important; } }" : null);
    this.document.documentElement.setAttribute("data-whimsy-dark-page", state);
    this._theme = this.theme();
    this.sendAsyncMessage("Whimsy:DarkPagesState", state);
    if (this._active) {
      this.watch();
    }
  }

  // W29 (owner: "clicking on the color of the popup in figjam, and ...
  // expanding the results in google, changes"). The page is judged while
  // it loads and hydrates, and again when it moves to a new page or
  // changes its own theme. After that, content opening over the page (a
  // colour picker, expanded results) never flips it between dark and light.
  // W30 (owner: "the figma bug ... is still there"): FigJam rewrites its
  // query (?node-id=) on every click, and apps toggle classes on <body> as
  // popups open, so neither counts by itself. A new page is a new path; a
  // theme change is a change in the colours <html> and <body> compute.
  get settling() {
    return Date.now() < (this._settleUntil || 0);
  }

  settle() {
    this._settleUntil = Date.now() + 3000;
    this._page = this.pageIdentity();
  }

  pageIdentity() {
    const location = this.document.location;
    return location ? location.origin + location.pathname : null;
  }

  // The colours a theme switch changes: the paint-time boost leaves
  // computed colours alone, so Whimsy's own darkening never shows here.
  theme() {
    const win = this.contentWindow;
    const doc = this.document;
    return [doc.documentElement, doc.body].map(el => {
      const style = el && win.getComputedStyle(el);
      return style ? `${style.backgroundColor} ${style.color} ${style.colorScheme}` : "";
    }).join("|") + `|${doc.querySelector("meta[name='color-scheme' i]")?.content || ""}`;
  }

  // Whether a change after settling is the page's own: a new page, or new
  // theme colours.
  changed() {
    if (this.pageIdentity() != this._page) {
      this.settle();
      return true;
    }
    return this.theme() != this._theme;
  }

  watch() {
    this._observer ??= new this.contentWindow.MutationObserver(() => this.schedule());
    // Color changes and SPA hydration are detected with nine paint samples,
    // once per refresh tick. No traversal of long pages or color rewriting.
    this._observer.observe(this.document.documentElement, { subtree: true, childList: true,
      attributes: true, attributeFilter: ["style", "class", "media", "href", "bgcolor", "color"] });
  }

  schedule() {
    if (this._scheduled) {
      return;
    }
    this._scheduled = true;
    this.contentWindow.requestAnimationFrame(() => {
      this._scheduled = false;
      if (this._record && (this.settling || this.changed())) {
        this.refresh();
      }
    });
  }

  didDestroy() {
    this._configuration = (this._configuration || 0) + 1;
    this._observer?.disconnect();
    if (this._sharedChange) {
      Services.cpmm.sharedData.removeEventListener("change", this._sharedChange);
    }
    if (this._record) {
      // A newer document may already own the same browsing context.
      endDarkPage(this._record);
      this._record = null;
    }
  }
}

// W26 site panel: a site with no choice of its own takes its profile's
// Automatic Dark Mode where that differs from the global setting
// (WhimsyDarkPages.publishProfiles).
function profileSites(config, isPrivate, key) {
  const sites = isPrivate ? config?.privateSites : config?.sites;
  if (sites?.[key]) {
    return sites;
  }
  const profiles = Services.cpmm.sharedData.get("Whimsy:DarkPagesProfiles");
  const own = profiles?.[key.slice(0, key.indexOf("|"))];
  if (typeof own != "boolean") {
    return sites;
  }
  return { ...sites, [key]: own ? "on" : "off" };
}
