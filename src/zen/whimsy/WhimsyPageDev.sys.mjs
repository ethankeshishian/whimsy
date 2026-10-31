/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave9/pagedev: the page developer tools (W9-11, from the Lens browser's
// developer menu).
//
// - Fonts on This Page: every family the page actually renders with
//   (InspectorUtils.getUsedFontFaces in the content actor, not the CSS
//   stacks), its faces, weights and styles, where it comes from (web font
//   URL, local(), system), a sample drawn in the font itself and how much
//   of the text uses it. Highlight on Page outlines that text.
// - Page Colors: the palette from computed styles (text, backgrounds,
//   borders, links, accents), deduplicated and ordered by area, in HEX,
//   RGB or HSL, with WCAG contrast for the text/background pairs and
//   Copy All as CSS Variables.
// - Built With: the page's stack from a small local ruleset
//   (WhimsyTechRules), with the evidence for each.
//
// Where they live: Tools ▸ Browser Tools, the menu Firefox keeps for
// developer tools, as one group with the Font Inspector and Element Info.
// Each is also a command (command bar, a shortcut you can assign in
// Settings ▸ Keyboard Shortcuts; none by default). No other control
// duplicates them. The results open in the same sheet as the inspectors.
//
// Analysis is local: the actor reads the rendered page and the headers
// the tab already has; nothing is sent anywhere and nothing is stored
// (the colour format choice lives only in memory for the session).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyInspector: "resource:///modules/whimsy/WhimsyInspector.sys.mjs",
  WhimsyPanels: "resource:///modules/whimsy/WhimsyPanels.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "ClipboardHelper", () =>
  Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper)
);
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));

const FEATURE_PREF = "whimsy.feature.page-dev";
const ACTOR = "WhimsyPageDev";

// The page's replies are untrusted: a compromised page process could send
// anything. Only a PNG data URL may become a chrome mask image (never a URL
// the chrome would fetch), and only a hex colour a chrome colour.
function safeImage(image) {
  if (typeof image?.url != "string" || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image.url)) {
    return null;
  }
  const size = n => Math.min(2000, Math.max(0, Math.round(Number(n) || 0)));
  return { url: image.url, width: size(image.width), height: size(image.height) };
}

function safeColor(value) {
  return typeof value == "string" && /^#[0-9a-f]{3,8}$/i.test(value) ? value : "transparent";
}
const SHEET = "chrome://browser/content/whimsy/whimsy-pagedev.css";
const HTML_NS = "http://www.w3.org/1999/xhtml";
const ICON = name => `chrome://browser/skin/zen-icons/${name}.svg`;

const MENU_POPUP_ID = "menuWebDeveloperPopup";
const MENU_SEPARATOR_ID = "whimsy-pagedev-separator";
// Page-wide tools first, then the two pickers.
const MENU_ITEMS = [
  { id: "menu_whimsyPageFonts", command: "cmd_whimsyPageFonts", l10nId: "whimsy-pagedev-menu-fonts", pref: FEATURE_PREF },
  { id: "menu_whimsyPageColors", command: "cmd_whimsyPageColors", l10nId: "whimsy-pagedev-menu-colors", pref: FEATURE_PREF },
  { id: "menu_whimsyBuiltWith", command: "cmd_whimsyBuiltWith", l10nId: "whimsy-pagedev-menu-built-with", pref: FEATURE_PREF },
  {
    id: "menu_whimsyFontInspector",
    command: "cmd_whimsyInspectFont",
    l10nId: "whimsy-pagedev-menu-font-inspector",
    pref: "whimsy.feature.font-inspector",
  },
  {
    id: "menu_whimsyElementInfo",
    command: "cmd_whimsyInspectElement",
    l10nId: "whimsy-pagedev-menu-element-info",
    pref: "whimsy.feature.element-inspector",
  },
];

export const FORMATS = ["hex", "rgb", "hsl"];

// Formats a string without Fluent's bidi isolation marks: these strings
// are also what gets copied, and U+2068/U+2069 don't belong in a
// clipboard (Whimsy ships en-US only).
function fmt(id, args) {
  return (lazy.l10n.formatValueSync(id, args) ?? "").replace(/[\u2068\u2069]/g, "");
}

function shorten(text, max = 48) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function round(n, digits = 0) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function hexOf({ r, g, b, a = 1 }) {
  const byte = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}${a < 1 ? byte(a * 255) : ""}`.toUpperCase();
}

export function hslOf({ r, g, b }) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max != min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max == r) {
      h = (g - b) / d + (g < b ? 6 : 0);
    } else if (max == g) {
      h = (b - r) / d + 2;
    } else {
      h = (r - g) / d + 4;
    }
    h *= 60;
  }
  return { h: round(h) % 360, s: round(s * 100), l: round(l * 100) };
}

/** A colour as text in one of FORMATS. */
export function formatColor(rgba, format = "hex") {
  const a = rgba.a ?? 1;
  const alpha = a < 1 ? round(a, 2) : null;
  if (format == "rgb") {
    const [r, g, b] = [rgba.r, rgba.g, rgba.b].map(v => Math.round(v));
    return alpha == null ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  if (format == "hsl") {
    const { h, s, l } = hslOf(rgba);
    return alpha == null ? `hsl(${h}, ${s}%, ${l}%)` : `hsla(${h}, ${s}%, ${l}%, ${alpha})`;
  }
  return hexOf(rgba);
}

/** The palette as a :root block of custom properties, named by role. */
export function cssVariables(palette, format = "hex") {
  const counts = {};
  const lines = palette.map(color => {
    const role = color.roles?.[0] ?? "color";
    counts[role] = (counts[role] ?? 0) + 1;
    const share = `${round(color.share * 100, 1)}%`;
    return `  --page-${role}-${counts[role]}: ${formatColor(color.rgba, format)}; /* ${share} */`;
  });
  return `:root {\n${lines.join("\n")}\n}\n`;
}

export const WhimsyPageDev = {
  _sessionInitialized: false,
  _sheetLoaded: new WeakSet(),
  // Session only (never a pref): the colour format last picked.
  _format: "hex",

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  initSession() {
    if (this._sessionInitialized) {
      return;
    }
    this._sessionInitialized = true;
    try {
      ChromeUtils.registerWindowActor(ACTOR, {
        parent: { esModuleURI: "resource:///modules/whimsy/WhimsyPageDevParent.sys.mjs" },
        child: { esModuleURI: "resource:///modules/whimsy/WhimsyPageDevChild.sys.mjs" },
        matches: ["https://*/*", "http://*/*", "file:///*"],
        // Web pages run in (untrusted) site-isolated processes; the parent
        // only asks, and treats every reply as page data (safeImage,
        // safeColor) before it reaches the chrome.
        safeForUntrustedWebProcess: true,
      });
    } catch (e) {
      // Already registered in this session.
    }
  },

  initWindow(win) {
    this.initSession();
    const available = () => this.enabled;
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyPageFonts",
      l10nId: "whimsy-action-page-fonts",
      run: w => this.showFonts(w),
      icon: ICON("text-size"),
      isAvailable: available,
    });
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyPageColors",
      l10nId: "whimsy-action-page-colors",
      run: w => this.showColors(w),
      icon: ICON("palette"),
      isAvailable: available,
    });
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyBuiltWith",
      l10nId: "whimsy-action-built-with",
      run: w => this.showBuiltWith(w),
      icon: ICON("layers"),
      isAvailable: available,
    });
    this.installMenu(win);
  },

  // ---- Tools ▸ Browser Tools ----

  installMenu(win) {
    const doc = win.document;
    const popup = doc.getElementById(MENU_POPUP_ID);
    if (!popup || doc.getElementById(MENU_SEPARATOR_ID)) {
      return;
    }
    const separator = doc.createXULElement("menuseparator");
    separator.id = MENU_SEPARATOR_ID;
    const items = MENU_ITEMS.map(spec => {
      const item = doc.createXULElement("menuitem");
      item.id = spec.id;
      item.setAttribute("command", spec.command);
      doc.l10n.setAttributes(item, spec.l10nId);
      return item;
    });
    popup.append(separator, ...items);
    popup.addEventListener("popupshowing", event => {
      if (event.target == popup) {
        this.updateMenu(win);
      }
    });
  },

  /** Shows the rows whose feature is on; greys them out where the page can't be read. */
  updateMenu(win) {
    const doc = win.document;
    const popup = doc.getElementById(MENU_POPUP_ID);
    const separator = doc.getElementById(MENU_SEPARATOR_ID);
    if (!popup || !separator) {
      return;
    }
    const items = MENU_ITEMS.map(spec => doc.getElementById(spec.id));
    // DevTools adds its rows to this menu lazily: keep the group last.
    if (popup.lastElementChild != items.at(-1)) {
      popup.append(separator, ...items.filter(Boolean));
    }
    const readable = !!this.actorFor(win.gBrowser?.selectedBrowser);
    let any = false;
    MENU_ITEMS.forEach((spec, i) => {
      const item = items[i];
      if (!item) {
        return;
      }
      item.hidden = !Services.prefs.getBoolPref(spec.pref, true);
      item.disabled = !readable;
      const keyId = lazy.WhimsyCommands.get(spec.command)?.keyId;
      if (keyId && doc.getElementById(keyId)) {
        item.setAttribute("key", keyId);
      }
      any ||= !item.hidden;
    });
    separator.hidden = !any;
  },

  // ---- Plumbing ----

  actorFor(browser) {
    try {
      return browser?.browsingContext?.currentWindowGlobal?.getActor(ACTOR) ?? null;
    } catch (e) {
      // Not a web page (about:, view-source:, a PDF viewer…).
      return null;
    }
  },

  async query(browser, name, data) {
    const actor = this.actorFor(browser);
    if (!actor) {
      return null;
    }
    try {
      return await actor.sendQuery(name, data);
    } catch (e) {
      console.error(`Whimsy: ${name}`, e);
      return null;
    }
  },

  _loadSheet(win) {
    if (this._sheetLoaded.has(win)) {
      return;
    }
    this._sheetLoaded.add(win);
    try {
      win.windowUtils.loadSheetUsingURIString(SHEET, win.windowUtils.AUTHOR_SHEET);
    } catch (e) {
      console.error("Whimsy: page developer sheet", e);
    }
  },

  /**
   * A sheet that hands focus back to where it was when it closes (unless
   * the person has since moved it), and runs `cleanup` once hidden.
   */
  _sheet(win, { id, titleL10nId, size = "large", footer = false }) {
    this._loadSheet(win);
    const doc = win.document;
    const browser = win.gBrowser?.selectedBrowser;
    const previous = doc.commandDispatcher?.focusedElement ?? doc.activeElement;
    const cleanups = [];
    let host = "";
    try {
      host = browser?.currentURI?.displayHost || "";
    } catch (e) {}
    const parts = lazy.WhimsyPanels.create(win, {
      id,
      titleL10nId,
      size,
      footer,
      subtitle: host || undefined,
      onHidden: () => {
        for (const fn of cleanups) {
          try {
            fn();
          } catch (e) {}
        }
        this._returnFocus(win, parts.panel, previous, browser);
      },
    });
    parts.panel.classList.add("whimsy-pagedev-panel");
    parts.onCleanup = fn => cleanups.push(fn);
    parts.browser = browser;
    return parts;
  },

  _returnFocus(win, panel, previous, browser) {
    const focused = win.document.commandDispatcher?.focusedElement ?? null;
    if (focused && !panel.contains(focused)) {
      return;
    }
    try {
      if (previous?.isConnected && previous != win.document.documentElement && previous.focus) {
        previous.focus();
      } else {
        (browser?.isConnected ? browser : win.gBrowser?.selectedBrowser)?.focus();
      }
    } catch (e) {}
  },

  toast(win, messageId, l10nArgs = {}) {
    const ui = win.gZenUIManager;
    if (!ui?.showToast) {
      return;
    }
    ui.showToast(messageId, { l10nArgs });
    // Zen reuses a toast that is still showing with the same id and keeps
    // its old text: refresh it (as WhimsyCopy does).
    const toast = [...(win.document.getElementById("zen-toast-container")?.children ?? [])].find(
      t => t._messageId == messageId
    );
    const label = toast?.firstElementChild?.querySelector("label:not(.whimsy-copy-url)");
    if (label) {
      win.document.l10n.setAttributes(label, messageId, l10nArgs);
    }
  },

  /** Copies `value`; the toast names `label` and shows only after the copy worked. */
  copy(win, value, label = value) {
    if (!value) {
      return false;
    }
    try {
      const context = win.gBrowser?.selectedBrowser?.browsingContext?.currentWindowGlobal ?? null;
      lazy.ClipboardHelper.copyString(value, context);
    } catch (e) {
      console.error("Whimsy: copy", e);
      return false;
    }
    this.toast(win, "whimsy-pagedev-copied-toast", { value: shorten(label) });
    return true;
  },

  percent(share) {
    if (share > 0 && share < 0.01) {
      return fmt("whimsy-pagedev-share-tiny");
    }
    return new Intl.NumberFormat(Services.locale.appLocaleAsBCP47, {
      style: "percent",
      maximumFractionDigits: share < 0.1 ? 1 : 0,
    }).format(share);
  },

  /** A copyable property row: label on the left, value on the right. */
  _prop(win, { l10nId, value, copy = value, crop = "end" }) {
    const row = lazy.WhimsyPanels.item(win.document, { l10nId, detail: value });
    row.classList.add("whimsy-pagedev-prop");
    row.querySelector(".whimsy-sheet-item-detail")?.setAttribute("crop", crop);
    row.setAttribute("tooltiptext", value);
    row.addEventListener("command", () => this.copy(win, copy));
    return row;
  },

  _button(doc, { l10nId, args, onClick, pressed = null }) {
    const button = doc.createElementNS(HTML_NS, "button");
    button.type = "button";
    button.className = "whimsy-pagedev-button whimsy-sheet-item";
    button.textContent = fmt(l10nId, args);
    if (pressed != null) {
      button.setAttribute("aria-pressed", String(pressed));
    }
    button.addEventListener("click", onClick);
    return button;
  },

  _unavailable(doc, body) {
    body.append(
      lazy.WhimsyPanels.empty(doc, { l10nId: "whimsy-pagedev-unavailable", icon: ICON("info") })
    );
  },

  // ---- Fonts on This Page ----

  async showFonts(win) {
    if (!this.enabled) {
      return null;
    }
    const browser = win.gBrowser?.selectedBrowser;
    const result = await this.query(browser, "WhimsyPageDev:Fonts");
    const doc = win.document;
    const sheet = this._sheet(win, { titleL10nId: "whimsy-pagedev-fonts-title", id: "whimsy-pagedev-fonts-panel" });
    const { panel, body } = sheet;

    if (!result) {
      this._unavailable(doc, body);
    } else if (!result.families?.length) {
      body.append(lazy.WhimsyPanels.empty(doc, { l10nId: "whimsy-pagedev-fonts-empty", icon: ICON("text-size") }));
    } else {
      body.append(
        lazy.WhimsyPanels.caption(doc, {
          l10nId: "whimsy-pagedev-fonts-summary",
          l10nArgs: { count: result.families.length },
        })
      );
      const highlightButtons = [];
      for (const family of result.families) {
        body.append(this._fontGroup(win, sheet, family, highlightButtons));
      }
      sheet.onCleanup(() => {
        if (browser?.isConnected) {
          this.query(browser, "WhimsyPageDev:ClearHighlight");
        }
      });
    }
    lazy.WhimsyPanels.open(win, panel);
    return panel;
  },

  _fontSource(source) {
    switch (source.kind) {
      case "web":
        return { value: fmt("whimsy-pagedev-font-source-web", { url: source.detail }), copy: source.detail, crop: "center" };
      case "embedded":
        return { value: fmt("whimsy-pagedev-font-source-embedded"), copy: fmt("whimsy-pagedev-font-source-embedded") };
      case "local":
        return { value: fmt("whimsy-pagedev-font-source-local", { name: source.detail }), copy: source.detail };
      case "fallback":
        return { value: fmt("whimsy-pagedev-font-source-fallback"), copy: fmt("whimsy-pagedev-font-source-fallback") };
      default:
        return { value: fmt("whimsy-pagedev-font-source-system"), copy: fmt("whimsy-pagedev-font-source-system") };
    }
  },

  _fontGroup(win, sheet, family, highlightButtons) {
    const doc = win.document;
    const group = doc.createXULElement("vbox");
    group.className = "whimsy-pagedev-font";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", family.family);

    const head = doc.createXULElement("hbox");
    head.className = "whimsy-pagedev-font-head";
    head.setAttribute("align", "baseline");
    const name = doc.createXULElement("label");
    name.className = "whimsy-pagedev-font-name";
    name.setAttribute("crop", "end");
    name.setAttribute("flex", "1");
    name.setAttribute("value", family.family);
    const share = doc.createXULElement("label");
    share.className = "whimsy-pagedev-font-share";
    share.setAttribute("value", this.percent(family.share));
    head.append(name, share);
    group.append(head);

    // The sample, drawn by the page in the font itself (see the child).
    const sample = doc.createElementNS(HTML_NS, "div");
    sample.className = "whimsy-pagedev-sample";
    sample.setAttribute("role", "img");
    sample.setAttribute("aria-label", family.sample || family.family);
    const image = safeImage(family.image);
    if (image) {
      sample.style.maskImage = `url("${image.url}")`;
      sample.style.width = `${image.width}px`;
      sample.style.height = `${image.height}px`;
    } else {
      sample.classList.add("whimsy-pagedev-sample-text");
      sample.textContent = family.sample || family.family;
    }
    group.append(sample);

    const usage = fmt(family.capped ? "whimsy-pagedev-font-usage-capped" : "whimsy-pagedev-font-usage-value", {
      percent: this.percent(family.share),
      chars: family.chars,
    });
    const rows = [
      this._prop(win, { l10nId: "whimsy-pagedev-font-family", value: family.family }),
      family.faces.length && this._prop(win, { l10nId: "whimsy-pagedev-font-faces", value: family.faces.join(", ") }),
      family.weights.length && this._prop(win, { l10nId: "whimsy-pagedev-font-weights", value: family.weights.join(", ") }),
      family.styles.length && this._prop(win, { l10nId: "whimsy-pagedev-font-styles", value: family.styles.join(", ") }),
      ...family.sources.map(source =>
        this._prop(win, { l10nId: "whimsy-pagedev-font-source", ...this._fontSource(source) })
      ),
      this._prop(win, { l10nId: "whimsy-pagedev-font-usage", value: usage }),
    ].filter(Boolean);
    group.append(...rows);

    const actions = doc.createXULElement("hbox");
    actions.className = "whimsy-pagedev-actions";
    const highlight = this._button(doc, {
      l10nId: "whimsy-pagedev-font-highlight",
      pressed: false,
      onClick: () => this._toggleHighlight(win, sheet, family.family, highlight, highlightButtons),
    });
    highlight.classList.add("whimsy-pagedev-highlight-button");
    highlightButtons.push(highlight);
    const search = this._button(doc, {
      l10nId: "whimsy-font-search-button",
      onClick: () => {
        lazy.WhimsyPanels.close(sheet.panel);
        lazy.WhimsyInspector.performFontSearch(win, family.family);
      },
    });
    actions.append(highlight, search);
    group.append(actions);
    return group;
  },

  async _toggleHighlight(win, sheet, family, button, buttons) {
    const wasOn = button.getAttribute("aria-pressed") == "true";
    for (const b of buttons) {
      b.setAttribute("aria-pressed", "false");
    }
    if (wasOn) {
      await this.query(sheet.browser, "WhimsyPageDev:ClearHighlight");
      return 0;
    }
    const result = await this.query(sheet.browser, "WhimsyPageDev:Highlight", { family });
    if (!result?.count) {
      this.toast(win, "whimsy-pagedev-font-highlight-none");
      return 0;
    }
    button.setAttribute("aria-pressed", "true");
    return result.count;
  },

  // ---- Page Colors ----

  async showColors(win) {
    if (!this.enabled) {
      return null;
    }
    const browser = win.gBrowser?.selectedBrowser;
    const result = await this.query(browser, "WhimsyPageDev:Colors");
    const doc = win.document;
    const sheet = this._sheet(win, {
      id: "whimsy-pagedev-colors-panel",
      titleL10nId: "whimsy-pagedev-colors-title",
      footer: !!result?.palette?.length,
    });
    const { panel, body, footer } = sheet;

    if (!result) {
      this._unavailable(doc, body);
    } else if (!result.palette?.length) {
      body.append(lazy.WhimsyPanels.empty(doc, { l10nId: "whimsy-pagedev-colors-empty", icon: ICON("palette") }));
    } else {
      const refreshers = [];
      const refresh = () => refreshers.forEach(fn => fn(this._format));
      body.append(this._formatSwitch(doc, refresh));

      body.append(
        lazy.WhimsyPanels.caption(doc, {
          l10nId: "whimsy-pagedev-palette-heading",
          l10nArgs: { count: result.palette.length },
        })
      );
      for (const color of result.palette) {
        body.append(this._colorRow(win, color, refreshers));
      }
      if (result.more) {
        const more = doc.createXULElement("description");
        more.className = "whimsy-pagedev-note";
        doc.l10n.setAttributes(more, "whimsy-pagedev-colors-more", { count: result.more });
        body.append(more);
      }

      if (result.pairs?.length) {
        const failing = result.pairs.filter(p => !p.aa).length;
        body.append(
          lazy.WhimsyPanels.caption(doc, {
            l10nId: "whimsy-pagedev-contrast-heading",
            l10nArgs: { failing },
          })
        );
        for (const pair of result.pairs) {
          body.append(this._pairRow(win, pair, refreshers));
        }
      }

      footer.append(
        lazy.WhimsyPanels.footerButton(doc, {
          l10nId: "whimsy-pagedev-copy-css-vars",
          primary: true,
          onCommand: () =>
            this.copy(win, cssVariables(result.palette, this._format), fmt("whimsy-pagedev-css-vars-label")),
        })
      );
      refresh();
    }
    lazy.WhimsyPanels.open(win, panel);
    return panel;
  },

  _formatSwitch(doc, refresh) {
    const box = doc.createXULElement("hbox");
    box.className = "whimsy-pagedev-formats";
    box.setAttribute("role", "radiogroup");
    box.setAttribute("aria-label", fmt("whimsy-pagedev-format-label"));
    const buttons = FORMATS.map(format => {
      const button = doc.createElementNS(HTML_NS, "button");
      button.type = "button";
      button.className = "whimsy-pagedev-format";
      button.dataset.format = format;
      button.setAttribute("role", "radio");
      button.textContent = fmt(`whimsy-pagedev-format-${format}`);
      return button;
    });
    const select = (format, focus = false) => {
      this._format = format;
      for (const b of buttons) {
        const on = b.dataset.format == format;
        b.setAttribute("aria-checked", String(on));
        // One tab stop for the group; arrows move within it.
        b.tabIndex = on ? 0 : -1;
        if (on && focus) {
          b.focus();
        }
      }
      refresh();
    };
    for (const button of buttons) {
      button.addEventListener("click", () => select(button.dataset.format));
      button.addEventListener("keydown", event => {
        const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
        if (!step) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const i = FORMATS.indexOf(this._format);
        select(FORMATS[(i + step + FORMATS.length) % FORMATS.length], true);
      });
    }
    box.append(...buttons);
    select(FORMATS.includes(this._format) ? this._format : "hex");
    return box;
  },

  _roleNames(roles) {
    return roles.map(role => fmt(`whimsy-pagedev-role-${role}`)).join(" · ");
  },

  _colorRow(win, color, refreshers) {
    const doc = win.document;
    const row = lazy.WhimsyPanels.item(doc, {
      label: color.hex,
      subtitle: this._roleNames(color.roles),
      detail: this.percent(color.share),
    });
    row.classList.add("whimsy-pagedev-color");
    const swatch = doc.createElementNS(HTML_NS, "span");
    swatch.className = "whimsy-pagedev-swatch";
    swatch.style.backgroundColor = formatColor(color.rgba, "rgb");
    row.querySelector(".whimsy-sheet-item-icon")?.replaceWith(swatch);
    const title = row.querySelector(".whimsy-sheet-item-title");
    let value = color.hex;
    refreshers.push(format => {
      value = formatColor(color.rgba, format);
      title.setAttribute("value", value);
      row.setAttribute("aria-label", `${value}, ${this._roleNames(color.roles)}, ${this.percent(color.share)}`);
      row.setAttribute("tooltiptext", fmt("whimsy-pagedev-copy-value", { value }));
    });
    row.addEventListener("command", () => this.copy(win, value));
    return row;
  },

  _pairRow(win, pair, refreshers) {
    const doc = win.document;
    const ratio = `${pair.ratio.toFixed(2)}:1`;
    const row = lazy.WhimsyPanels.item(doc, { label: "", detail: ratio });
    row.classList.add("whimsy-pagedev-pair");
    const sample = doc.createElementNS(HTML_NS, "span");
    sample.className = "whimsy-pagedev-pair-sample";
    sample.setAttribute("aria-hidden", "true");
    sample.style.color = safeColor(pair.fg);
    sample.style.backgroundColor = safeColor(pair.bg);
    sample.textContent = "Aa";
    row.querySelector(".whimsy-sheet-item-icon")?.replaceWith(sample);

    const badges = doc.createXULElement("hbox");
    badges.className = "whimsy-pagedev-badges";
    badges.setAttribute("align", "center");
    const badge = (level, pass) => {
      const b = doc.createElementNS(HTML_NS, "span");
      b.className = `whimsy-pagedev-badge ${pass ? "pass" : "fail"}`;
      b.textContent = fmt(pass ? "whimsy-pagedev-wcag-pass" : "whimsy-pagedev-wcag-fail", { level });
      return b;
    };
    badges.append(badge("AA", pair.aa), badge("AAA", pair.aaa));
    const notes = [];
    if (pair.large) {
      notes.push(fmt("whimsy-pagedev-contrast-large"));
    }
    if (pair.image) {
      notes.push(fmt("whimsy-pagedev-contrast-image"));
    }
    if (notes.length) {
      const note = doc.createElementNS(HTML_NS, "span");
      note.className = "whimsy-pagedev-badge-note";
      note.textContent = notes.join(" · ");
      badges.append(note);
    }
    row.querySelector(".whimsy-sheet-item-text")?.append(badges);

    const title = row.querySelector(".whimsy-sheet-item-title");
    const rgb = hex => {
      const n = parseInt(hex.slice(1, 7), 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
    };
    let text = "";
    refreshers.push(format => {
      const fg = formatColor(rgb(pair.fg), format);
      const bg = formatColor(rgb(pair.bg), format);
      title.setAttribute("value", fmt("whimsy-pagedev-contrast-pair", { fg, bg }));
      const result = level => fmt(level ? "whimsy-pagedev-result-pass" : "whimsy-pagedev-result-fail");
      text = fmt("whimsy-pagedev-contrast-copy", { fg, bg, ratio, aa: result(pair.aa), aaa: result(pair.aaa) });
      row.setAttribute("aria-label", text);
      row.setAttribute("tooltiptext", fmt("whimsy-pagedev-copy-value", { value: text }));
    });
    row.addEventListener("command", () => this.copy(win, text, ratio));
    return row;
  },

  // ---- Built With ----

  evidenceText(evidence) {
    return fmt("whimsy-pagedev-evidence", {
      kind: evidence.kind,
      detail: evidence.detail ?? "",
      count: evidence.count ?? 0,
    });
  },

  techLine(tech) {
    const name = tech.version ? `${tech.name} ${tech.version}` : tech.name;
    const category = fmt(`whimsy-pagedev-category-${tech.category}`);
    const evidence = tech.evidence.map(e => this.evidenceText(e)).join("; ");
    return `${name} (${category}): ${evidence}`;
  },

  async showBuiltWith(win) {
    if (!this.enabled) {
      return null;
    }
    const browser = win.gBrowser?.selectedBrowser;
    const result = await this.query(browser, "WhimsyPageDev:BuiltWith");
    const doc = win.document;
    const technologies = result?.technologies ?? [];
    const sheet = this._sheet(win, {
      id: "whimsy-pagedev-built-with-panel",
      titleL10nId: "whimsy-pagedev-built-with-title",
      footer: technologies.length > 0,
    });
    const { panel, body, footer } = sheet;

    if (!result) {
      this._unavailable(doc, body);
    } else if (!technologies.length) {
      body.append(lazy.WhimsyPanels.empty(doc, { l10nId: "whimsy-pagedev-built-with-empty", icon: ICON("layers") }));
    } else {
      let category = null;
      for (const tech of technologies) {
        if (tech.category != category) {
          category = tech.category;
          body.append(lazy.WhimsyPanels.caption(doc, { l10nId: `whimsy-pagedev-category-${category}` }));
        }
        const evidence = tech.evidence.map(e => this.evidenceText(e));
        const row = lazy.WhimsyPanels.item(doc, {
          label: tech.version ? `${tech.name} ${tech.version}` : tech.name,
          subtitle: evidence.join(" · "),
        });
        row.classList.add("whimsy-pagedev-tech");
        row.setAttribute("data-key", tech.key);
        row.setAttribute("tooltiptext", evidence.join("\n"));
        row.setAttribute("aria-label", `${row.getAttribute("aria-label")}, ${evidence.join(", ")}`);
        row.addEventListener("command", () => this.copy(win, this.techLine(tech), tech.name));
        body.append(row);
      }
      footer.append(
        lazy.WhimsyPanels.footerButton(doc, {
          l10nId: "whimsy-pagedev-copy-all",
          primary: true,
          onCommand: () =>
            this.copy(
              win,
              technologies.map(t => this.techLine(t)).join("\n"),
              fmt("whimsy-pagedev-built-with-label")
            ),
        })
      );
    }
    if (result) {
      const note = doc.createXULElement("description");
      note.className = "whimsy-pagedev-note";
      doc.l10n.setAttributes(note, "whimsy-pagedev-built-with-local");
      body.append(note);
    }
    lazy.WhimsyPanels.open(win, panel);
    return panel;
  },
};
