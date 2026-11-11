/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Native themes first; Zen Boosts' existing per-color paint path second.
// No document-sized filters, CSSOM rewriting, or per-element mutation work.
import {
  DARK_PAGES_KEY, beginDarkPage, setAdaptiveDarkPage, endDarkPage,
} from "resource:///modules/whimsy/WhimsyDarkPagesConfig.sys.mjs";

const GATE = "@media screen { html { background: #1c1b22 !important; } body { opacity: 0 !important; } }";
const FADE = "::view-transition-old(root), ::view-transition-new(root) { animation-duration: 240ms !important; }";

function luminance(value) {
  const color = InspectorUtils.colorToRGBA(value);
  return color?.a > 0.9 ? (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255 : null;
}

export class WhimsyDarkPagesChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type == "DOMDocElementInserted") {
      if (this.document.contentType != "text/html") {
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
    } else if (this._record && (event.type == "DOMContentLoaded" || event.type == "pageshow")) {
      this._ready = true;
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
      } else if (!event.type.startsWith("Style") || event.stylesheet?.ownerNode || event.rule?.parentStyleSheet?.ownerNode) {
        this.schedule();
      }
    }
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
    const principal = this.document.nodePrincipal;
    const key = `${principal.originAttributes.userContextId || 0}|${principal.originNoSuffix}`;
    const isPrivate = !!principal.originAttributes.privateBrowsingId;
    const sites = isPrivate ? config?.privateSites : config?.sites;
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
      this._transition = this.document.startViewTransition(async () => {
        apply();
        // The existing Boost setter requests a restyle. Capture its paint.
        await new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
      });
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
    // Read authored computed colors: the paint-time boost deliberately
    // doesn't change them, so native-theme detection cannot double-darken.
    const background = el => {
      let depth = 0;
      for (let node = el; node && depth++ < 32; node = node.parentElement) {
        const light = luminance(win.getComputedStyle(node).backgroundColor);
        if (light != null) {
          return light;
        }
      }
      return 1;
    };
    let dark = 0;
    let count = 0;
    for (const x of [0.2, 0.5, 0.8]) {
      for (const y of [0.15, 0.45, 0.75]) {
        const el = doc.elementFromPoint(win.innerWidth * x, win.innerHeight * y);
        if (el) {
          dark += background(el) < 0.4 ? 1 : 0;
          count++;
        }
      }
    }
    return count ? dark / count >= 0.6 : background(doc.body || doc.documentElement) < 0.4;
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
    this.sendAsyncMessage("Whimsy:DarkPagesState", state);
    if (this._active) {
      this.watch();
    }
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
      if (this._record) {
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
