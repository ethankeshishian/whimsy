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
// W10-57: Redact has two looks, Black Out (the default) and Blur, picked
// in a row that opens under the bar while Redact is on, with a hint that a
// click on text hides or shows it (whimsy.capture.redact-style). The
// capture guard (see WhimsyRedactChild) keeps every click away from the
// page, in every frame, for as long as Screenshots is open on the tab.
//
// W10-59: a Portrait tile beside Visible and Full Page (Arc's Capture in
// Portrait Mode, also the cmd_whimsyCapturePortrait command): the page
// laid out at a phone's width, in the same preview as the other two.
//
// Screenshots' own files stay untouched: the button is added to the
// <screenshots-buttons> shadow root after it renders, and the session is
// followed by wrapping ScreenshotsUtils.openPanel/createCanvas/exit, the
// way WhimsyFilesSection wraps copyScreenshot.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ScreenshotsUtils: "moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyPage: "resource:///modules/whimsy/WhimsyPage.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.redact";
const REDACT_PREF = "whimsy.capture.redact";
const STYLE_PREF = "whimsy.capture.redact-style";
const STYLES = ["black", "blur"];
const ACTOR = "WhimsyRedact";
const SHEET = "chrome://browser/content/whimsy/whimsy-redact.css";
const HTML_NS = "http://www.w3.org/1999/xhtml";

export class WhimsyRedactParent extends JSWindowActorParent {
  receiveMessage(message) {
    const browser = this.browsingContext.top.embedderElement;
    switch (message.name) {
      case "Redact:FramesChanged":
        // A frame loaded while guarding or redacting: start both in every
        // frame again (frames already on ignore it).
        if (browser && WhimsyRedact._guarded.has(browser)) {
          WhimsyRedact.guard(browser, true);
        }
        if (browser && WhimsyRedact._active.has(browser)) {
          WhimsyRedact.set(browser, true);
        }
        break;
      case "Redact:ToggleInFrame": {
        // A click over an out-of-process frame. Only a direct child frame
        // of the sender, and only with numbers for the point.
        const { browsingContextId, x, y } = message.data ?? {};
        const target = BrowsingContext.get(browsingContextId);
        if (!target || target.parent != this.browsingContext || !Number.isFinite(x) || !Number.isFinite(y)) {
          return null;
        }
        return WhimsyRedact.queryFrame(target, "Redact:ToggleAt", { x, y });
      }
    }
    return null;
  }
}

export const WhimsyRedact = {
  // Browsers with redaction showing.
  _active: new WeakSet(),
  // Browsers with Screenshots open, whose pages get no clicks.
  _guarded: new WeakSet(),

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  get on() {
    return Services.prefs.getBoolPref(REDACT_PREF, false);
  },

  get style() {
    const style = Services.prefs.getStringPref(STYLE_PREF, "black");
    return STYLES.includes(style) ? style : "black";
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    ChromeUtils.registerWindowActor(ACTOR, {
      parent: { esModuleURI: "resource:///modules/whimsy/WhimsyRedactParent.sys.mjs" },
      // Started by the parent's messages only, in the page and each of its
      // frames. The pointer listeners are the actor's own (on the window
      // root from the start, so they run before Screenshots' listeners,
      // which stop the event, and before any of the page's), and only
      // reach an actor that exists. The mouse and click ones are the
      // capture guard's.
      child: {
        esModuleURI: "resource:///modules/whimsy/WhimsyRedactChild.sys.mjs",
        events: {
          pointerdown: { capture: true, createActor: false },
          pointerup: { capture: true, createActor: false },
          mousedown: { capture: true, createActor: false },
          mouseup: { capture: true, createActor: false },
          click: { capture: true, createActor: false },
          auxclick: { capture: true, createActor: false },
          dblclick: { capture: true, createActor: false },
        },
      },
      allFrames: true,
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
        // W10-57: from the first moment the bar shows, the page gets no clicks.
        self.guard(browser, true);
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
      self.guard(browser, false);
      return exit.call(this, browser, ...rest);
    };
  },

  isScreenshotsMode(browser) {
    const mode = lazy.ScreenshotsUtils.browserToScreenshotsState?.get(browser)?.mode;
    return !mode || mode == "screenshots";
  },

  actorFor(browser) {
    return this.actorForContext(browser?.browsingContext);
  },

  actorForContext(bc) {
    try {
      return bc?.currentWindowGlobal?.getActor(ACTOR) ?? null;
    } catch {
      // Pages Whimsy can't run in (about: pages in the parent and the like).
      return null;
    }
  },

  async queryFrame(bc, name, data) {
    try {
      return (await this.actorForContext(bc)?.sendQuery(name, data)) ?? null;
    } catch {
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
    if (on) {
      this._active.add(browser);
    } else {
      this._active.delete(browser);
    }
    return this.sendToFrames(browser, "Redact:Set", { on, style: this.style });
  },

  // Every frame (same-origin or not) gets the message for its own
  // document; returns the top page's answer.
  async sendToFrames(browser, name, data) {
    const top = browser.browsingContext;
    const frames = top?.getAllBrowsingContextsInSubtree?.() ?? [];
    await Promise.all(frames.filter(bc => bc != top).map(bc => this.queryFrame(bc, name, data)));
    return this.queryFrame(top, name, data);
  },

  /**
   * W10-57: keep clicks from the page (every frame) while Screenshots is
   * open on it.
   *
   * @returns {Promise<boolean|null>} The top page's guard, for tests
   */
  async guard(browser, on) {
    if (!browser || (!on && !this._guarded.has(browser))) {
      return null;
    }
    if (on) {
      this._guarded.add(browser);
    } else {
      this._guarded.delete(browser);
    }
    return this.sendToFrames(browser, "Redact:Guard", { on });
  },

  // Boxes drawn again after the page was laid out anew (Portrait).
  async redraw(browser) {
    if (!this._active.has(browser)) {
      return null;
    }
    return this.sendToFrames(browser, "Redact:Redraw", {});
  },

  // The top page's state, or a frame's (pass its BrowsingContext).
  async state(browser, frame = null) {
    return this.queryFrame(frame ?? browser?.browsingContext, "Redact:State");
  },

  // --- Whimsy's parts of the Screenshots bar ---

  initWindow(win) {
    this.init();
    // W10-57: Redact as a command too (command bar, a shortcut of your
    // own): opens Capture with Redact on, or flips Redact while it's open.
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyCaptureRedact",
      l10nId: "whimsy-action-capture-redact",
      run: w => this.captureRedacted(w),
      icon: "chrome://browser/skin/zen-icons/screenshot.svg",
      isAvailable: w => this.enabled && lazy.WhimsyPage.captureEnabled && lazy.WhimsyPage.isWebPage(w),
    });
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

  /**
   * Add (or update) Whimsy's parts of a <screenshots-buttons>: the Redact
   * toggle and its options row, and the Portrait tile.
   */
  decorate(el) {
    const root = el.shadowRoot;
    const group = root?.querySelector("moz-button-group");
    if (!root) {
      return;
    }
    const doc = el.ownerDocument;
    const make = (tag, id, attrs = {}) => {
      const node = doc.createElementNS(HTML_NS, tag);
      if (id) {
        node.id = id;
      }
      for (const [k, v] of Object.entries(attrs)) {
        node.setAttribute(k, v);
      }
      return node;
    };
    const screenshotsMode = !!group && !el.isMiniWindow;
    if (screenshotsMode && (this.enabled || lazy.WhimsyPage.captureEnabled) && !root.getElementById("whimsy-capture-sheet")) {
      // After Firefox's own sheets, before the buttons.
      group.before(make("link", "whimsy-capture-sheet", { rel: "stylesheet", href: SHEET }));
    }

    // The Portrait tile, between Visible and Full Page.
    let portrait = root.getElementById("whimsy-portrait");
    if (!screenshotsMode || !lazy.WhimsyPage.captureEnabled) {
      portrait?.remove();
    } else if (!portrait) {
      portrait = make("button", "whimsy-portrait", { class: "screenshot-button footer-button" });
      doc.l10n.setAttributes(portrait, "whimsy-portrait-button");
      portrait.addEventListener("click", () => {
        lazy.WhimsyPage.takePortraitScreenshot(el.documentGlobal.gBrowser.selectedBrowser).catch(console.error);
      });
      const fullPage = root.getElementById("full-page");
      if (fullPage?.parentNode == group) {
        fullPage.before(portrait);
      } else {
        group.append(portrait);
      }
    }

    // Redact, first, so Visible and Full Page keep their places; its
    // options open under the whole bar. W13 F04: with the capture card,
    // Redact comes after the capture (the card, and its editor's "Hide
    // private details" and Black Out / Blur), so the bar has no toggle;
    // hiding still applies while you frame the shot when that's on.
    if (!screenshotsMode || !this.enabled || Services.prefs.getBoolPref("whimsy.feature.capture-card", true)) {
      root.getElementById("whimsy-redact-wrap")?.remove();
      root.getElementById("whimsy-redact-options")?.remove();
      return;
    }
    let button = root.getElementById("whimsy-redact");
    if (!button) {
      const wrap = make("div", "whimsy-redact-wrap");
      button = make("button", "whimsy-redact", { class: "screenshot-button footer-button" });
      doc.l10n.setAttributes(button, "whimsy-redact-button");
      button.addEventListener("click", () => this.toggle(el.documentGlobal));
      wrap.append(button);
      group.before(wrap);
    }
    let options = root.getElementById("whimsy-redact-options");
    if (!options) {
      options = make("div", "whimsy-redact-options");
      const hint = make("span", "whimsy-redact-hint");
      doc.l10n.setAttributes(hint, "whimsy-redact-hint");
      const styles = make("div", "whimsy-redact-style", { role: "group" });
      doc.l10n.setAttributes(styles, "whimsy-redact-style");
      for (const style of STYLES) {
        const choice = make("button", `whimsy-redact-style-${style}`, { "data-style": style });
        doc.l10n.setAttributes(choice, `whimsy-redact-style-${style}`);
        choice.addEventListener("click", () => this.setStyle(el.documentGlobal, style));
        styles.append(choice);
      }
      options.append(hint, styles);
      root.append(options);
    }
    button.setAttribute("aria-pressed", String(this.on));
    options.hidden = !this.on;
    for (const choice of options.querySelectorAll("[data-style]")) {
      choice.setAttribute("aria-pressed", String(choice.dataset.style == this.style));
    }
  },

  /** The toggle: flip and remember, then apply to the current page. */
  async toggle(win) {
    const on = !this.on;
    Services.prefs.setBoolPref(REDACT_PREF, on);
    const browser = win.gBrowser.selectedBrowser;
    this.syncPanel(browser);
    return this.set(browser, on);
  },

  /** Black Out or Blur: remember, and repaint the boxes on the page. */
  async setStyle(win, style) {
    if (!STYLES.includes(style)) {
      return null;
    }
    Services.prefs.setStringPref(STYLE_PREF, style);
    const browser = win.gBrowser.selectedBrowser;
    this.syncPanel(browser);
    return this._active.has(browser) ? this.set(browser, true) : null;
  },

  isOpen(browser) {
    const panel = lazy.ScreenshotsUtils.panelForBrowser?.(browser);
    return !!panel && !panel.hidden && this.isScreenshotsMode(browser);
  },

  /** cmd_whimsyCaptureRedact. */
  async captureRedacted(win) {
    const browser = win.gBrowser.selectedBrowser;
    if (this.isOpen(browser)) {
      return this.toggle(win);
    }
    Services.prefs.setBoolPref(REDACT_PREF, true);
    // Firefox's own Capture command, so the session starts the usual way.
    win.document.getElementById("Browser:Screenshot")?.doCommand();
    return null;
  },
};
