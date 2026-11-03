/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave9: Inspector (Font Inspector & Element Inspector Lite).
//
// W9-01: Font Inspector ("What Font Is This?"):
// On highlighted text (right-click item registered with Menus settings,
// command bar action, assignable shortcut), shows a clean popover with
// font family (the face actually rendered, not just the CSS stack), size,
// weight, line height, letter spacing, and colour (hex, copyable, with swatch).
// Each value copies on click. Works in content via a JSWindowActor; never
// writes private pages' data to storage.
//
// W9-02: Element Inspector lite:
// Pick an element to inspect its box model (margin, border, padding, content),
// colours, and text-contrast ratio (WCAG pass/fail). Hold Option or select two
// elements to measure the distance/gap between them. Shares the element picker
// with Zap and W9-01. Includes "Open in DevTools" link.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyPanels: "resource:///modules/whimsy/WhimsyPanels.sys.mjs",
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  DevToolsShim: "chrome://devtools-startup/content/DevToolsShim.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "ClipboardHelper", () =>
  Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper)
);
ChromeUtils.defineLazyGetter(lazy, "l10n", () =>
  new Localization(["browser/whimsy.ftl"], true)
);

const FONT_FEATURE_PREF = "whimsy.feature.font-inspector";
const ELEMENT_FEATURE_PREF = "whimsy.feature.element-inspector";
const HTML_NS = "http://www.w3.org/1999/xhtml";

const PANEL_SHEET = "chrome://browser/content/whimsy/whimsy-inspector.css";
const FONT_PANEL_ID = "whimsy-font-inspector-panel";
const FONT_PANEL_WIDTH = 320;
// W13 F10: Element Info is a fixed 360px wide (it never jumps sideways
// between elements); its height follows its content.
const ELEMENT_PANEL_ID = "whimsy-element-inspector-panel";
const ELEMENT_PANEL_WIDTH = 360;
// The card shows a skeleton only when the page takes this long to answer.
const READING_DELAY_MS = 150;
const SOURCES = new Set(["web", "local", "system", "fallback"]);
const SIZE_RX = /^-?\d+(\.\d+)?px$|^normal$/;
const HEX_RX = /^#[0-9A-F]{6}([0-9A-F]{2})?$/i;
const WEIGHT_NAMES = new Set([100, 200, 300, 400, 500, 600, 700, 800, 900]);

// Strings from the page are untrusted: one line, no control characters,
// a sane length.
function cleanText(value, max = 200) {
  return typeof value == "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, max) : "";
}

/**
 * W10-17: the font card's data, checked in the parent. Everything that
 * came from the page is validated; anything odd falls back to nothing.
 */
export function validateFontData(data) {
  if (!data || typeof data != "object") {
    return null;
  }
  const size = v => (typeof v == "string" && SIZE_RX.test(v.trim()) ? v.trim() : null);
  const family = cleanText(data.family);
  const system = !!data.system || family.startsWith(".");
  const weight = Math.round(Number(data.weight));
  const finite = v => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    family: system ? null : family || null,
    system,
    source: system ? "system" : (SOURCES.has(data.source) ? data.source : "fallback"),
    sourceHost: cleanText(data.sourceHost, 253),
    sourceURL: /^https?:\/\//.test(data.sourceURL ?? "") ? cleanText(data.sourceURL, 500) : "",
    others: (Array.isArray(data.others) ? data.others : []).slice(0, 2).map(o => {
      // A hidden face (".SFNS…") is the system font, never shown by name.
      const otherSystem = !!o?.system || cleanText(o?.family).startsWith(".");
      return {
        family: otherSystem ? null : cleanText(o?.family) || null,
        system: otherSystem,
        count: Math.max(0, Math.round(Number(o?.count) || 0)),
      };
    }).filter(o => o.count > 0 && (o.family || o.system)),
    cssStack: cleanText(data.cssStack, 400).replace(/[;{}<>]/g, "") || "sans-serif",
    size: size(data.size) ?? "normal",
    weight: WEIGHT_NAMES.has(weight) ? weight : (Number.isFinite(weight) && weight > 0 && weight <= 1000 ? weight : 400),
    style: /^(italic|oblique)/.test(data.style ?? "") ? "italic" : "normal",
    lineHeight: size(data.lineHeight) ?? "normal",
    letterSpacing: size(data.letterSpacing) ?? "normal",
    colorHex: HEX_RX.test(data.colorHex ?? "") ? data.colorHex.toUpperCase() : null,
    previewText: cleanText(data.previewText, 60),
    selector: cleanText(data.selector, 500),
    x: finite(data.x),
    y: finite(data.y),
    width: finite(data.width),
    height: finite(data.height),
  };
}

/**
 * W13 F10: Element Info's data, checked in the parent like the font card's:
 * numbers stay numbers, colours are hex, names are one clean line.
 */
export function validateElementData(data) {
  if (!data || typeof data != "object" || !data.boxModel || !data.colors) {
    return null;
  }
  const int = v => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
  const sides = o => ({ top: int(o?.top), right: int(o?.right), bottom: int(o?.bottom), left: int(o?.left) });
  const hex = v => (HEX_RX.test(v ?? "") ? v.toUpperCase() : "#000000");
  const tag = cleanText(data.tagName, 40).replace(/[^a-z0-9-]/gi, "") || "element";
  const rating = ["AAA", "AA", "Fail"].includes(data.colors.rating) ? data.colors.rating : "Fail";
  return {
    tagName: tag,
    name: cleanText(data.name, 80) || tag,
    selector: cleanText(data.selector, 500),
    boxModel: {
      width: int(data.boxModel.width),
      height: int(data.boxModel.height),
      margin: sides(data.boxModel.margin),
      border: sides(data.boxModel.border),
      padding: sides(data.boxModel.padding),
    },
    colors: {
      textColorHex: hex(data.colors.textColorHex),
      bgColorHex: hex(data.colors.bgColorHex),
      contrastRatio: /^\d{1,2}\.\d{2}:1$/.test(data.colors.contrastRatio ?? "") ? data.colors.contrastRatio : "",
      passAA: !!data.colors.passAA,
      rating,
    },
    font: data.font ? validateFontData(data.font) : null,
  };
}

export const WhimsyInspector = {
  _sessionInitialized: false,
  _sheetLoaded: new WeakSet(),
  _activePickers: new WeakMap(),
  _lastInspectedFont: null,

  get fontInspectorEnabled() {
    return Services.prefs.getBoolPref(FONT_FEATURE_PREF, true);
  },

  get elementInspectorEnabled() {
    return Services.prefs.getBoolPref(ELEMENT_FEATURE_PREF, true);
  },

  get enabled() {
    return this.fontInspectorEnabled || this.elementInspectorEnabled;
  },

  initSession() {
    if (this._sessionInitialized) {
      return;
    }
    this._sessionInitialized = true;
    try {
      ChromeUtils.registerWindowActor("WhimsyInspector", {
        parent: { esModuleURI: "resource:///modules/whimsy/WhimsyInspectorParent.sys.mjs" },
        child: { esModuleURI: "resource:///modules/whimsy/WhimsyInspectorChild.sys.mjs" },
        matches: ["https://*/*", "http://*/*", "file:///*"],
        allFrames: true,
        safeForUntrustedWebProcess: true,
      });
    } catch (e) {
      // Actor might already be registered in this session.
    }
  },

  // The page's inspector actor, or null where it can't run (about: pages,
  // which the actor's matches leave out).
  actorFor(browser) {
    try {
      return browser?.browsingContext?.currentWindowGlobal?.getActor("WhimsyInspector") ?? null;
    } catch (e) {
      return null;
    }
  },

  initWindow(win) {
    this.initSession();
    const { document } = win;

    // Register commands in WhimsyCommands
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyInspectFont",
      l10nId: "whimsy-action-inspect-font",
      run: w => this.inspectFont(w),
      icon: "chrome://browser/skin/zen-icons/signature.svg",
      isAvailable: w => this.fontInspectorEnabled,
    });

    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsySearchFont",
      l10nId: "whimsy-action-search-font",
      run: w => this.searchFont(w),
      icon: "chrome://browser/skin/zen-icons/search-glass.svg",
      isAvailable: w => this.fontInspectorEnabled,
    });

    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyInspectElement",
      l10nId: "whimsy-action-inspect-element",
      whimsyKeywords: lazy.WhimsyCommands.keywords("whimsy-keywords-inspect-element"),
      run: w => this.togglePicker(w, "element"),
      icon: "chrome://browser/skin/zen-icons/developer.svg",
      isAvailable: w => this.elementInspectorEnabled,
    });

    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyMeasureGap",
      l10nId: "whimsy-action-measure-gap",
      run: w => this.togglePicker(w, "measure"),
      icon: "chrome://browser/skin/zen-icons/developer.svg",
      isAvailable: w => this.elementInspectorEnabled,
    });

    // Content area context menu item for highlighted text
    const menu = document.getElementById("contentAreaContextMenu");
    if (menu) {
      const item = document.createXULElement("menuitem");
      item.id = "context-whimsy-inspect-font";
      item.hidden = true;
      document.l10n.setAttributes(item, "whimsy-context-inspect-font");
      item.setAttribute("command", "cmd_whimsyInspectFont");
      item.addEventListener("command", () => {
        this.inspectFont(win);
      });

      menu.addEventListener("popupshowing", event => {
        if (event.target != menu) {
          return;
        }
        const context = win.gContextMenu;
        const selection = !!context?.isContentSelected && !context.onTextInput;
        item.hidden = !this.fontInspectorEnabled || !context || !selection;
        if (item.hidden) {
          return;
        }
        const anchor = document.getElementById("context-inspect") || document.getElementById("context-copy");
        if (anchor && anchor.nextElementSibling != item) {
          anchor.after(item);
        }
      });
      menu.append(item);

      // W10-45: the user couldn't find Element Info (only in Tools ▸ Browser
      // Tools and the command bar). Right-click any element → Element Info,
      // beside Firefox's Inspect, opens it on that element. Settings → Menus
      // can turn it off.
      const info = document.createXULElement("menuitem");
      info.id = "context-whimsy-element-info";
      info.hidden = true;
      document.l10n.setAttributes(info, "whimsy-context-element-info");
      info.addEventListener("command", () => this.inspectContextElement(win));
      menu.addEventListener("popupshowing", event => {
        if (event.target != menu) {
          return;
        }
        const context = win.gContextMenu;
        info.hidden =
          !this.elementInspectorEnabled ||
          !context ||
          !!context.onTextInput ||
          !this.actorFor(context.browser);
        if (info.hidden) {
          return;
        }
        // Firefox lists Inspect Accessibility Properties, then Inspect;
        // Element Info goes right after Inspect.
        const anchor =
          document.getElementById("context-inspect") ||
          document.getElementById("context-inspect-a11y") ||
          document.getElementById("context-whimsy-inspect-font");
        if (anchor && anchor.nextElementSibling != info) {
          anchor.after(info);
        }
      });
      menu.append(info);
    }
  },

  // W10-45: Element Info on the element that was right-clicked (in its own
  // frame); the picker when it can't be found.
  async inspectContextElement(win) {
    if (!this.elementInspectorEnabled) {
      return;
    }
    const context = win.gContextMenu;
    const frame = context?.frameBrowsingContext ?? context?.browser?.browsingContext;
    let data = null;
    try {
      const actor = frame?.currentWindowGlobal?.getActor("WhimsyInspector");
      data = await actor?.sendQuery("Whimsy:InspectContextTarget", { target: context.targetIdentifier });
    } catch (e) {
      // A page the inspector can't run in, or one going away.
    }
    if (data) {
      this.showElementPopover(win, data);
    } else {
      this.startPicker(win, "element");
    }
  },

  // Inspect font: inspects selected text immediately, or starts element
  // picker if no selection. W10-17: a page that takes a moment shows the
  // card reading; a page Whimsy can't read says so.
  async inspectFont(win) {
    if (!this.fontInspectorEnabled) {
      return;
    }
    const browser = win.gBrowser?.selectedBrowser;
    const actor = this.actorFor(browser);
    if (!actor) {
      this.showFontPopover(win, null, { state: "unavailable" });
      return;
    }

    let answered = false;
    let reading = null;
    const timer = win.setTimeout(() => {
      if (!answered) {
        reading = this.showFontPopover(win, null, { state: "reading" });
      }
    }, READING_DELAY_MS);
    let result = null;
    let failed = false;
    try {
      result = await actor.sendQuery("Whimsy:InspectFontSelection");
    } catch (e) {
      failed = true;
    }
    answered = true;
    win.clearTimeout(timer);
    if (failed) {
      this.showFontPopover(win, null, { state: "unavailable", reuse: reading });
      return;
    }
    if (result) {
      this.showFontPopover(win, result, { reuse: reading });
      return;
    }
    if (reading) {
      lazy.WhimsySurface.close(reading);
    }
    // No text highlighted: start picker in font inspection mode
    this.startPicker(win, "font");
  },

  // Search for the rendered font name in a new tab next to current one
  async searchFont(win, fontName = null) {
    if (!this.fontInspectorEnabled) {
      return;
    }
    const openPanel = win.document?.getElementById(FONT_PANEL_ID);
    if (openPanel) {
      lazy.WhimsySurface.close(openPanel);
    }

    let font = fontName || this._lastInspectedFont?.renderedFont;
    if (!font) {
      const browser = win.gBrowser?.selectedBrowser;
      const actor = this.actorFor(browser);
      if (actor) {
        try {
          const result = await actor.sendQuery("Whimsy:InspectFontSelection");
          if (result?.renderedFont) {
            font = result.renderedFont;
          }
        } catch (e) {}
      }
    }
    if (!font) {
      return;
    }
    await this.performFontSearch(win, font);
  },

  async performFontSearch(win, fontName) {
    if (!fontName) {
      return;
    }
    const isPrivate =
      lazy.PrivateBrowsingUtils.isWindowPrivate(win) ||
      lazy.WhimsyPrivate.isPrivateTab?.(win.gBrowser?.selectedTab);

    let url = null;
    try {
      await lazy.SearchService.init();
      const engine = isPrivate
        ? (await lazy.SearchService.getDefaultPrivate()) || (await lazy.SearchService.getDefault())
        : await lazy.SearchService.getDefault();
      const submission = engine?.getSubmission(fontName);
      if (submission?.uri?.spec) {
        url = submission.uri.spec;
      }
    } catch (e) {}

    if (!url) {
      url = `https://www.google.com/search?q=${encodeURIComponent(fontName)}`;
    }

    lazy.WhimsyPrivate.openTabFor(win, url, { relatedToCurrent: true });
  },

  // The popovers' styles live in whimsy-inspector.css, which nothing else
  // loads into the browser window: load it once per window, on first use.
  _loadSheet(win) {
    if (this._sheetLoaded.has(win)) {
      return;
    }
    this._sheetLoaded.add(win);
    try {
      win.windowUtils.loadSheetUsingURIString(PANEL_SHEET, win.windowUtils.AUTHOR_SHEET);
    } catch (e) {
      console.error("Whimsy: inspector sheet", e);
    }
  },

  /**
   * W10-17: "What Font Is This?" as a WhimsySurface card (the user: the
   * name showed as "." and the UI was horrible). The pad shows the text in
   * its own font; then the name (system fonts named plainly: "San
   * Francisco"), where it comes from, six facts that copy in place, what
   * else drew part of the text, and Search for This Font / Copy CSS. It
   * hangs 8px under the selection (above it when there's no room).
   *
   * @param {Window} win
   * @param {object|null} raw - the child's data (validated here)
   * @param {object} [o]
   * @param {"reading"|"unavailable"} [o.state]
   * @param {Element} [o.reuse] - a reading card to fill in place
   * @returns {Element|null} the panel
   */
  showFontPopover(win, raw, { state = null, reuse = null } = {}) {
    const data = state ? null : validateFontData(raw);
    if (!data && !state) {
      return null;
    }
    const doc = win.document;
    if (data) {
      this._lastInspectedFont = { ...data, renderedFont: data.family ?? lazy.l10n.formatValueSync("whimsy-font-system-name") };
    }
    const keep = reuse?.isConnected && (reuse.state == "open" || reuse.state == "showing") ? reuse : null;
    let parts;
    if (keep) {
      parts = keep._whimsyParts;
      parts.view.replaceChildren(parts.header);
      parts.footer.replaceChildren();
    } else {
      // W13 F07: a header to drag it by (grip, "Font Inspector", close). It
      // opens at the text it describes, so a drag lasts for this card only.
      parts = lazy.WhimsySurface.create(win, {
        id: FONT_PANEL_ID,
        width: FONT_PANEL_WIDTH,
        titleL10nId: "whimsy-font-inspector-title",
        close: true,
        footer: true,
        className: "whimsy-font-card",
        initialFocus: () => parts.panel.querySelector(".whimsy-font-copy-css") ?? parts.footer.querySelector("button"),
      });
      parts.panel._whimsyParts = parts;
      lazy.WhimsySurface.makeDraggable(parts.panel, parts.header, { remember: false });
    }
    const { panel, view, footer } = parts;
    panel.setAttribute("aria-labelledby", "whimsy-font-name");
    panel.toggleAttribute("reading", state == "reading");

    const pad = doc.createXULElement("vbox");
    pad.className = "whimsy-surface-pad whimsy-font-pad";
    view.append(pad);

    if (state == "reading") {
      pad.append(lazy.WhimsySurface.skeleton(doc, { width: "80%", height: 22 }),
        lazy.WhimsySurface.skeleton(doc, { width: "45%", height: 10 }));
      pad.setAttribute("aria-busy", "true");
    } else if (state == "unavailable") {
      const text = doc.createElementNS(HTML_NS, "p");
      text.className = "whimsy-font-unavailable";
      doc.l10n.setAttributes(text, "whimsy-pagedev-unavailable");
      pad.append(text);
      // The header's ✕ closes it (W13 F07: no second Close in the footer).
    } else {
      this._fillFontCard(win, parts, pad, data);
    }
    footer.hidden = !footer.children.length;
    lazy.WhimsySurface.finish(parts);

    if (keep) {
      if (data) {
        footer.querySelector(".whimsy-font-copy-css")?.focus();
      }
      return panel;
    }
    const rect = data && [data.x, data.y, data.width, data.height].every(Number.isFinite) ?
      { left: data.x, top: data.y, width: Math.max(1, data.width), height: Math.max(1, data.height) } : null;
    if (rect) {
      lazy.WhimsySurface.open(win, panel, { screenRect: rect, position: "after_start", gap: 8 });
    } else {
      lazy.WhimsySurface.open(win, panel, { at: "page-top-center" });
    }
    return panel;
  },

  _fillFontCard(win, parts, pad, data) {
    const doc = win.document;
    const { panel, view, footer } = parts;
    const systemName = lazy.l10n.formatValueSync("whimsy-font-system-name");
    const familyName = data.family ?? systemName;

    // The text in its own font.
    const specimen = doc.createElementNS(HTML_NS, "div");
    specimen.className = "whimsy-font-specimen";
    specimen.textContent = data.previewText || lazy.l10n.formatValueSync("whimsy-font-sample-text");
    const family = data.system ? "-apple-system, system-ui" :
      `"${familyName.replace(/["\\]/g, "")}", ${data.cssStack}`;
    specimen.style.fontFamily = family;
    specimen.style.fontWeight = String(data.weight);
    specimen.style.fontStyle = data.style;
    pad.append(specimen);

    // The name, and where it comes from.
    const nameRow = doc.createElementNS(HTML_NS, "div");
    nameRow.className = "whimsy-font-name-row";
    const name = doc.createElementNS(HTML_NS, "span");
    name.id = "whimsy-font-name";
    name.className = "whimsy-font-name";
    name.textContent = familyName;
    name.title = familyName;
    const pill = lazy.WhimsySurface.pill(doc, { l10nId: `whimsy-font-source-${data.source}` });
    pill.classList.add("whimsy-font-source");
    if (data.sourceURL || data.sourceHost) {
      pill.title = data.sourceURL || data.sourceHost;
    }
    nameRow.append(name, pill);
    view.append(nameRow);

    // Six facts; each copies its value in place.
    const facts = doc.createElementNS(HTML_NS, "div");
    facts.className = "whimsy-font-facts";
    const fact = (key, l10nId, value, copy = value, swatch = null) => {
      const k = doc.createElementNS(HTML_NS, "span");
      k.className = "k";
      doc.l10n.setAttributes(k, l10nId);
      const v = doc.createElementNS(HTML_NS, "span");
      v.className = "v whimsy-surface-copy-value";
      if (swatch) {
        const chip = doc.createElementNS(HTML_NS, "span");
        chip.className = "whimsy-font-swatch";
        chip.style.backgroundColor = swatch;
        v.append(chip);
      }
      const text = doc.createElementNS(HTML_NS, "span");
      if (typeof value == "string") {
        text.textContent = value;
      } else {
        doc.l10n.setAttributes(text, value.l10nId, value.args);
      }
      v.append(text);
      const button = lazy.WhimsySurface.copyButton(doc, {
        value: copy,
        content: [k, v],
        className: "whimsy-font-fact",
      });
      button.dataset.fact = key;
      facts.append(button);
    };
    fact("size", "whimsy-font-size-label", data.size);
    fact("weight", "whimsy-font-weight-label",
      { l10nId: "whimsy-font-weight-value", args: { weight: data.weight } }, String(data.weight));
    fact("line-height", "whimsy-font-line-height-label", data.lineHeight);
    fact("letter-spacing", "whimsy-font-letter-spacing-label", data.letterSpacing);
    if (data.colorHex) {
      fact("color", "whimsy-font-color-label", data.colorHex, data.colorHex, data.colorHex);
    }
    fact("style", "whimsy-font-style-label", { l10nId: `whimsy-font-style-${data.style}` }, data.style);
    view.append(facts);

    if (data.others.length) {
      const other = data.others[0];
      const also = doc.createElementNS(HTML_NS, "p");
      also.className = "whimsy-font-also";
      doc.l10n.setAttributes(also, "whimsy-font-also", { font: other.family ?? systemName, count: other.count });
      view.append(also);
    }

    // Search (not for the system font) and Copy CSS, the default.
    if (!data.system) {
      footer.append(lazy.WhimsySurface.footerButton(doc, {
        l10nId: "whimsy-font-search-button-label",
        onCommand: () => this.searchFont(win, familyName),
      }));
    }
    const copyCss = lazy.WhimsySurface.footerButton(doc, {
      l10nId: "whimsy-font-copy-css-button",
      primary: true,
      onCommand: () => {
        lazy.WhimsySurface.copyText(this.fontCss(data));
        doc.l10n.setAttributes(copyCss, "whimsy-font-copied-css-button");
        win.setTimeout(() => copyCss.isConnected && doc.l10n.setAttributes(copyCss, "whimsy-font-copy-css-button"),
          lazy.WhimsySurface.COPIED_MS);
      },
    });
    copyCss.classList.add("whimsy-font-copy-css");
    footer.append(copyCss);
    return panel;
  },

  // The CSS Copy CSS copies (its shape is unchanged from wave 9).
  fontCss(data) {
    const family = data.system ? "-apple-system, system-ui" : `"${data.family}", ${data.cssStack}`;
    return [
      `font-family: ${family};`,
      `font-size: ${data.size};`,
      `font-weight: ${data.weight};`,
      `line-height: ${data.lineHeight || "normal"};`,
      `letter-spacing: ${data.letterSpacing || "normal"};`,
      ...(data.colorHex ? [`color: ${data.colorHex};`] : []),
    ].join("\n");
  },

  // Display the Element Inspector popover matching Whimsy's panel styling.
  /**
   * W13 F10 (wave12 F10, option A): Element Info, a WhimsySurface 360px
   * wide whose height hugs its content (no scrollbar unless the window is
   * shorter than it; then only the body scrolls and the header stays).
   * Header: the drag grip, the element's short name ("div.card", in the
   * space colour, mono) with its full selector as the tooltip, its size,
   * and close. Then the box model, the element's colours as rows (each
   * copies its value), and a group with its font and contrast. It floats
   * over the page and stays while you use it (F07: the header drags it);
   * Pick Another keeps it open, and the next element replaces its content
   * in place, the height easing to the new content over 160ms.
   */
  showElementPopover(win, raw) {
    const data = validateElementData(raw);
    if (!data) {
      return null;
    }
    this._loadSheet(win);
    const doc = win.document;
    const existing = doc.getElementById(ELEMENT_PANEL_ID);
    const keep = existing?._whimsyParts && (existing.state == "open" || existing.state == "showing") ? existing : null;
    let parts;
    let before = 0;
    if (keep) {
      parts = keep._whimsyParts;
      before = parts.view.getBoundingClientRect().height;
      parts.body.replaceChildren();
      parts.footer.replaceChildren();
    } else {
      parts = lazy.WhimsySurface.create(win, {
        id: ELEMENT_PANEL_ID,
        width: ELEMENT_PANEL_WIDTH,
        title: data.name,
        close: true,
        footer: true,
        closeOnOutsideClick: false,
        className: "whimsy-element-inspector-panel",
        onHidden: () => {
          win.gBrowser.tabContainer.removeEventListener("TabSelect", onTabSelect);
        },
      });
      const onTabSelect = () => lazy.WhimsySurface.close(parts.panel);
      win.gBrowser.tabContainer.addEventListener("TabSelect", onTabSelect);
      parts.title.classList.add("whimsy-element-tag");
      const dims = doc.createElementNS(HTML_NS, "span");
      dims.className = "whimsy-element-dims";
      parts.close.before(dims);
      // Only the body scrolls, under a header that stays.
      parts.body = doc.createXULElement("vbox");
      parts.body.className = "whimsy-element-body";
      parts.view.append(parts.body);
      parts.panel._whimsyParts = parts;
      lazy.WhimsySurface.makeDraggable(parts.panel, parts.header);
    }
    const { panel, view, body, footer, title } = parts;
    title.textContent = data.name;
    title.title = data.selector;
    const dims = parts.header.querySelector(".whimsy-element-dims");
    dims.textContent = `${data.boxModel.width} × ${data.boxModel.height}`;
    panel.dataset.selector = data.selector;

    body.append(this._boxModel(doc, data.boxModel));

    // Colours: a row each; a click copies the value.
    const colors = lazy.WhimsySurface.group(doc);
    colors.classList.add("whimsy-element-colors");
    for (const [hex, l10nId, key] of [
      [data.colors.textColorHex, "whimsy-element-text-color", "text"],
      [data.colors.bgColorHex, "whimsy-element-bg-color", "background"],
    ]) {
      const swatch = doc.createElementNS(HTML_NS, "span");
      swatch.className = "whimsy-color-swatch";
      swatch.style.backgroundColor = hex;
      const value = doc.createElementNS(HTML_NS, "span");
      value.className = "whimsy-element-color-value whimsy-surface-copy-value";
      value.textContent = hex;
      const role = doc.createElementNS(HTML_NS, "span");
      role.className = "whimsy-color-chip-label";
      doc.l10n.setAttributes(role, l10nId);
      const row = lazy.WhimsySurface.copyButton(doc, {
        value: hex,
        content: [swatch, value, role],
        className: "whimsy-element-color whimsy-surface-row",
        liveBefore: role,
      });
      row.dataset.color = key;
      colors.append(row);
    }
    body.append(colors);

    // Font and contrast.
    const facts = lazy.WhimsySurface.group(doc);
    facts.classList.add("whimsy-element-facts");
    const fact = (key, l10nId, ...content) => {
      const row = doc.createElementNS(HTML_NS, "div");
      row.className = "whimsy-element-fact";
      row.dataset.fact = key;
      const k = doc.createElementNS(HTML_NS, "span");
      k.className = "k";
      doc.l10n.setAttributes(k, l10nId);
      const v = doc.createElementNS(HTML_NS, "span");
      v.className = "v";
      v.append(...content);
      row.append(k, v);
      facts.append(row);
    };
    if (data.font) {
      const f = data.font;
      const family = f.family ?? lazy.l10n.formatValueSync("whimsy-font-system-name");
      const px = v => (v == "normal" ? v : String(Math.round(parseFloat(v) * 10) / 10));
      fact("font", "whimsy-element-font-label", `${family} ${px(f.size)}/${px(f.lineHeight)} · ${f.weight}`);
    }
    const ratio = doc.createElementNS(HTML_NS, "span");
    ratio.className = "whimsy-contrast-ratio";
    ratio.textContent = data.colors.contrastRatio;
    const badge = lazy.WhimsySurface.pill(doc, {
      l10nId: "whimsy-element-wcag-badge",
      l10nArgs: { rating: data.colors.rating },
      tone: data.colors.passAA ? "pass" : "fail",
    });
    badge.classList.add("whimsy-wcag-badge", data.colors.passAA ? "pass" : "fail");
    fact("contrast", "whimsy-element-contrast-ratio", ratio, badge);
    body.append(facts);

    // Actions: Pick Another, What Font (when there's text), Open in DevTools.
    footer.append(lazy.WhimsySurface.footerButton(doc, {
      l10nId: "whimsy-element-pick-another-button",
      onCommand: () => this.startPicker(win, "element"),
    }));
    if (data.font) {
      footer.append(lazy.WhimsySurface.footerButton(doc, {
        l10nId: "whimsy-element-inspect-font-button",
        onCommand: () => {
          lazy.WhimsySurface.close(panel);
          this.showFontPopover(win, raw.font);
        },
      }));
    }
    footer.append(lazy.WhimsySurface.footerButton(doc, {
      l10nId: "whimsy-element-open-devtools-button",
      primary: true,
      onCommand: () => {
        lazy.WhimsySurface.close(panel);
        try {
          lazy.DevToolsShim?.showToolboxForTab?.(win.gBrowser.selectedTab, { toolId: "inspector" });
        } catch (e) {
          console.error("Whimsy: failed to open DevTools", e);
        }
      },
    }));
    lazy.WhimsySurface.finish(parts);

    if (keep) {
      // The height eases from the last element's to this one's.
      const after = view.getBoundingClientRect().height;
      if (Math.abs(after - before) > 0.5 && !win.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        view.animate([{ height: `${before}px`, overflow: "clip" }, { height: `${after}px`, overflow: "clip" }], {
          duration: 160,
          easing: "cubic-bezier(0.2, 0, 0, 1)",
          id: "whimsy-element-info-height",
        });
      }
      return panel;
    }
    lazy.WhimsySurface.open(win, panel, { at: "page-top-center" });
    return panel;
  },

  // The box model, margin to content, each side's value in place.
  _boxModel(doc, bm) {
    const box = (cls, labelL10nId, sides, inner) => {
      const el = doc.createElementNS(HTML_NS, "div");
      el.className = cls;
      if (labelL10nId) {
        const label = doc.createElementNS(HTML_NS, "span");
        label.className = "whimsy-box-label";
        doc.l10n.setAttributes(label, labelL10nId);
        el.append(label);
      }
      for (const side of ["top", "bottom", "left", "right"]) {
        const v = doc.createElementNS(HTML_NS, "span");
        v.className = `whimsy-box-val-${side}`;
        v.textContent = String(sides[side]);
        el.append(v);
      }
      el.append(inner);
      return el;
    };
    const content = doc.createElementNS(HTML_NS, "div");
    content.className = "whimsy-box-content";
    content.textContent = `${bm.width} × ${bm.height}`;
    const wrap = doc.createElementNS(HTML_NS, "div");
    wrap.className = "whimsy-box-model-container";
    doc.l10n.setAttributes(wrap, "whimsy-element-box-model-label");
    wrap.setAttribute("role", "img");
    wrap.append(
      box("whimsy-box-margin", "whimsy-element-margin-box", bm.margin,
        box("whimsy-box-border", "whimsy-element-border-box", bm.border,
          box("whimsy-box-padding", "whimsy-element-padding-box", bm.padding, content)))
    );
    return wrap;
  },

  async inspectElementBySelector(win, selector) {
    const browser = win.gBrowser.selectedBrowser;
    const actor = this.actorFor(browser);
    if (!actor) {
      return;
    }
    try {
      const data = await actor.sendQuery("Whimsy:InspectElementBySelector", { selector });
      if (data) {
        this.showElementPopover(win, data);
      }
    } catch (e) {}
  },

  // Shared element picker controls (shares picker between Zap, Font Inspector, Element Inspector)
  startPicker(win, mode = "element") {
    // Each picker honours its own switch.
    if (mode == "font" ? !this.fontInspectorEnabled : !this.elementInspectorEnabled) {
      return false;
    }
    const browser = win.gBrowser.selectedBrowser;
    const actor = this.actorFor(browser);
    if (!actor) {
      return false;
    }
    this._activePickers.set(win, mode);
    actor.sendAsyncMessage("Whimsy:StartPicker", { mode });
    return true;
  },

  stopPicker(win) {
    const browser = win.gBrowser.selectedBrowser;
    const actor = this.actorFor(browser);
    this._activePickers.delete(win);
    actor?.sendAsyncMessage("Whimsy:StopPicker");
  },

  togglePicker(win, mode = "element") {
    if (this._activePickers.has(win)) {
      this.stopPicker(win);
      return false;
    }
    return this.startPicker(win, mode);
  },

  onPickerClosed(win) {
    this._activePickers.delete(win);
  },

  showToast(win, messageId, l10nArgs = {}) {
    if (!win.gZenUIManager?.showToast) {
      return;
    }
    win.gZenUIManager.showToast(messageId, { l10nArgs });
    // Zen reuses a toast that is still showing if messageId matches,
    // keeping its old text. Refresh the label like WhimsyCopy does.
    const container = win.document?.getElementById("zen-toast-container");
    if (!container) {
      return;
    }
    const toast = [...container.children].find(t => t._messageId == messageId);
    if (!toast) {
      return;
    }
    const label = toast.firstElementChild?.querySelector("label:not(.whimsy-copy-url)");
    if (label) {
      win.document.l10n.setAttributes(label, messageId, l10nArgs);
    }
  },

  onGapMeasured(win, data) {
    if (!data) {
      return;
    }
    try {
      this.showToast(win, "whimsy-element-gap-toast", {
        gapX: data.gapX,
        gapY: data.gapY,
      });
    } catch (e) {}
  },
};
