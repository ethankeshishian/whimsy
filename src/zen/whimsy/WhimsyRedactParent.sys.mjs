/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave5: Redact, a toggle in Firefox Screenshots' panel (beside Visible and
// Full Page). Like CleanShot's and Arc's blur tools, but automatic: with it
// on, emails, phone numbers, API keys/tokens and card numbers are blurred
// on the page while you frame the shot, a click on any text blurs or
// unblurs it, and the copy or download (region, visible or full page)
// carries the blur. The page goes back to normal once the image is made.
// The toggle remembers its state (whimsy.capture.redact).
//
// Screenshots' own files stay untouched: the button is added to the
// <screenshots-buttons> shadow root after it renders, and the session is
// followed by wrapping ScreenshotsUtils.openPanel/createCanvas/exit, the
// way WhimsyFilesSection wraps copyScreenshot.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ScreenshotsUtils: "moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.redact";
const REDACT_PREF = "whimsy.capture.redact";
const ACTOR = "WhimsyRedact";
const SHEET = "chrome://browser/content/whimsy/whimsy-redact.css";
const HTML_NS = "http://www.w3.org/1999/xhtml";

export class WhimsyRedactParent extends JSWindowActorParent {}

export const WhimsyRedact = {
  // Browsers with redaction showing.
  _active: new WeakSet(),

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  get on() {
    return Services.prefs.getBoolPref(REDACT_PREF, false);
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    ChromeUtils.registerWindowActor(ACTOR, {
      parent: { esModuleURI: "resource:///modules/whimsy/WhimsyRedactParent.sys.mjs" },
      // Started by the parent's messages only, in the top page.
      child: { esModuleURI: "resource:///modules/whimsy/WhimsyRedactChild.sys.mjs" },
      safeForUntrustedWebProcess: true,
    });
    this.wrapScreenshots();
  },

  wrapScreenshots() {
    const utils = lazy.ScreenshotsUtils;
    if (utils._whimsyRedactWrapped) {
      return;
    }
    utils._whimsyRedactWrapped = true;
    const self = this;
    // Every time the buttons show (start, back to crosshairs, Retry).
    const openPanel = utils.openPanel;
    utils.openPanel = function (browser, ...rest) {
      const result = openPanel.call(this, browser, ...rest);
      try {
        self.syncPanel(browser);
        if (self.isScreenshotsMode(browser) && self.enabled && self.on) {
          self.set(browser, true);
        }
      } catch (e) {
        console.error("Whimsy: redact", e);
      }
      return result;
    };
    // Every capture (region copy/download, Visible, Full Page) draws here;
    // the blur is in the page by then, so it ends up in the image.
    const createCanvas = utils.createCanvas;
    utils.createCanvas = async function (region, browser, ...rest) {
      try {
        return await createCanvas.call(this, region, browser, ...rest);
      } finally {
        self.set(browser, false);
      }
    };
    const exit = utils.exit;
    utils.exit = function (browser, ...rest) {
      self.set(browser, false);
      return exit.call(this, browser, ...rest);
    };
  },

  isScreenshotsMode(browser) {
    const mode = lazy.ScreenshotsUtils.browserToScreenshotsState?.get(browser)?.mode;
    return !mode || mode == "screenshots";
  },

  actorFor(browser) {
    try {
      return browser?.browsingContext?.currentWindowGlobal?.getActor(ACTOR) ?? null;
    } catch {
      // Pages Whimsy can't run in (about: pages in the parent and the like).
      return null;
    }
  },

  /**
   * Show or clear redaction on a browser's page.
   *
   * @returns {Promise<object|null>} The child's state, for tests
   */
  async set(browser, on) {
    if (!browser || (!on && !this._active.has(browser))) {
      return null;
    }
    const actor = this.actorFor(browser);
    if (on) {
      this._active.add(browser);
    } else {
      this._active.delete(browser);
    }
    try {
      return (await actor?.sendQuery("Redact:Set", { on })) ?? null;
    } catch {
      return null;
    }
  },

  async state(browser) {
    try {
      return (await this.actorFor(browser)?.sendQuery("Redact:State")) ?? null;
    } catch {
      return null;
    }
  },

  // --- The toggle in the Screenshots panel ---

  initWindow(win) {
    this.init();
    win.customElements.whenDefined("screenshots-buttons").then(cls => {
      if (cls.prototype._whimsyRedactPatched) {
        return;
      }
      cls.prototype._whimsyRedactPatched = true;
      for (const name of ["connectedCallback", "attributeChangedCallback"]) {
        const original = cls.prototype[name];
        cls.prototype[name] = function (...args) {
          const result = original?.apply(this, args);
          try {
            WhimsyRedact.decorate(this);
          } catch (e) {
            console.error("Whimsy: redact button", e);
          }
          return result;
        };
      }
      // Panels made before the definition was patched.
      for (const el of win.document.querySelectorAll("screenshots-buttons")) {
        this.decorate(el);
      }
    });
  },

  syncPanel(browser) {
    const panel = lazy.ScreenshotsUtils.panelForBrowser?.(browser);
    const el = panel?.querySelector("screenshots-buttons");
    if (el) {
      this.decorate(el);
    }
  },

  /** Add (or update) the Redact toggle in a <screenshots-buttons>. */
  decorate(el) {
    const root = el.shadowRoot;
    if (!root) {
      return;
    }
    let button = root.getElementById("whimsy-redact");
    const show = this.enabled && !el.isMiniWindow && root.querySelector("moz-button-group");
    if (!show) {
      root.getElementById("whimsy-redact-wrap")?.remove();
      return;
    }
    if (!button) {
      const doc = el.ownerDocument;
      const link = doc.createElementNS(HTML_NS, "link");
      link.rel = "stylesheet";
      link.href = SHEET;
      const wrap = doc.createElementNS(HTML_NS, "div");
      wrap.id = "whimsy-redact-wrap";
      button = doc.createElementNS(HTML_NS, "button");
      button.id = "whimsy-redact";
      button.className = "screenshot-button footer-button";
      doc.l10n.setAttributes(button, "whimsy-redact-button");
      button.addEventListener("click", () => this.toggle(el.documentGlobal));
      wrap.append(button);
      // First, so Visible and Full Page keep their places.
      root.querySelector("moz-button-group").before(link, wrap);
    }
    button.setAttribute("aria-pressed", String(this.on));
  },

  /** The toggle: flip and remember, then apply to the current page. */
  async toggle(win) {
    const on = !this.on;
    Services.prefs.setBoolPref(REDACT_PREF, on);
    const browser = win.gBrowser.selectedBrowser;
    this.syncPanel(browser);
    return this.set(browser, on);
  },
};
