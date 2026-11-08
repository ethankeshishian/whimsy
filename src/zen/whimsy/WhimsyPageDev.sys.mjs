/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave9/pagedev: the page developer tools (W9-11, from the Lens browser's
// developer menu).
//
// - Page Fonts (W13 F07; was Fonts on This Page): every family the page actually renders with
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
// duplicates them.
//
// W10-18 (the user: "UI horrible"): the three results are one WhimsySurface
// docked at the top end of the page, with a segmented Fonts | Colors |
// Built With switch; each command opens it on its own tab (or switches
// tab). It stays while you use the page (no autohide), reads the page
// again when the tab navigates, and closes when you switch tabs.
//
// Analysis is local: the actor reads the rendered page and the headers
// the tab already has; nothing is sent anywhere and nothing is stored
// (the colour format choice lives only in memory for the session).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyInspector: "resource:///modules/whimsy/WhimsyInspector.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
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
const PANEL_ID = "whimsy-pagedev";
const PANEL_WIDTH = 380;
const TABS = ["fonts", "colors", "built-with"];
const QUERIES = { fonts: "WhimsyPageDev:Fonts", colors: "WhimsyPageDev:Colors", "built-with": "WhimsyPageDev:BuiltWith" };
const MAX_SWATCHES = 16;
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
      run: w => this.open(w, "fonts"),
      icon: ICON("text-size"),
      isAvailable: available,
    });
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyPageColors",
      l10nId: "whimsy-action-page-colors",
      run: w => this.open(w, "colors"),
      icon: ICON("palette"),
      isAvailable: available,
    });
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyBuiltWith",
      l10nId: "whimsy-action-built-with",
      run: w => this.open(w, "built-with"),
      icon: "chrome://browser/skin/zen-icons/selectable/layers.svg",
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

  /** Copies `value` (no toast: the control says Copied in place). */
  copy(win, value) {
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

  // ---- The surface ----

  /** The open page tools surface in `win`, if any. */
  panelOf(win) {
    const panel = win.document.getElementById(PANEL_ID);
    return panel && (panel.state == "open" || panel.state == "showing") ? panel : null;
  },

  // Kept for callers and tests: each opens the surface on its tab.
  showFonts(win) {
    return this.open(win, "fonts");
  },
  showColors(win) {
    return this.open(win, "colors");
  },

  /**
   * Opens the page tools on `tab` ("fonts", "colors", "built-with"), or
   * switches the open one to it. Resolves the panel once that tab has
   * its results (or says it can't read the page).
   */
  async open(win, tab = "fonts") {
    if (!this.enabled) {
      return null;
    }
    tab = TABS.includes(tab) ? tab : "fonts";
    const existing = this.panelOf(win);
    if (existing?._pagedev) {
      await existing._pagedev.select(tab, { focus: true });
      return existing;
    }
    this._loadSheet(win);
    const doc = win.document;
    const browser = win.gBrowser?.selectedBrowser;
    const previous = doc.commandDispatcher?.focusedElement ?? doc.activeElement;
    const cleanups = [];
    const parts = lazy.WhimsySurface.create(win, {
      id: PANEL_ID,
      width: PANEL_WIDTH,
      title: this.hostOf(browser),
      close: true,
      footer: true,
      closeOnOutsideClick: false,
      className: "whimsy-pagedev-panel",
      initialFocus: () => seg.group.querySelector("[aria-selected='true']"),
      onHidden: () => {
        for (const fn of cleanups) {
          try {
            fn();
          } catch (e) {}
        }
        this._returnFocus(win, parts.panel, previous, browser);
      },
    });
    const { panel, view, footer, title, header } = parts;
    // W13 F07: it floats over the page; the header drags it.
    lazy.WhimsySurface.makeDraggable(panel, header);
    const state = { tab, results: {}, browser, highlight: null };

    const seg = lazy.WhimsySurface.seg(doc, {
      name: "pagedev",
      tabs: true,
      label: fmt("whimsy-pagedev-tabs-label"),
      options: TABS.map(t => ({
        value: t,
        id: `whimsy-pagedev-tab-${t}`,
        controls: "whimsy-pagedev-body",
        l10nId: `whimsy-pagedev-tab-${t}`,
      })),
      onPick: t => select(t),
    });
    const body = doc.createXULElement("vbox");
    body.id = "whimsy-pagedev-body";
    body.className = "whimsy-pagedev-body";
    body.setAttribute("role", "tabpanel");
    body.setAttribute("tabindex", "-1");
    view.append(seg.group, body);
    lazy.WhimsySurface.finish(parts);

    const render = () => {
      body.replaceChildren();
      footer.replaceChildren();
      body.setAttribute("aria-labelledby", `whimsy-pagedev-tab-${state.tab}`);
      panel.dataset.tab = state.tab;
      const result = state.results[state.tab];
      footer.hidden = true;
      if (result === undefined) {
        this._reading(doc, body);
        return;
      }
      if (result === null) {
        this._unavailableState(doc, body);
        seg.setDisabled(true);
        return;
      }
      seg.setDisabled(false);
      if (state.tab == "fonts") {
        this._renderFonts(win, state, body);
      } else if (state.tab == "colors") {
        this._renderColors(win, state, body, footer);
      } else {
        this._renderBuiltWith(win, state, body, footer);
      }
      footer.hidden = !footer.children.length;
    };
    const load = async t => {
      if (t in state.results) {
        return;
      }
      const result = await this.query(state.browser, QUERIES[t]);
      if (!panel.isConnected) {
        return;
      }
      state.results[t] = result ?? null;
      if (state.tab == t) {
        render();
      }
    };
    const select = async (t, { focus = false } = {}) => {
      state.tab = t;
      seg.select(t);
      render();
      if (focus) {
        seg.group.querySelector("[aria-selected='true']")?.focus();
      }
      await load(t);
    };
    // Re-read the page when the tab navigates.
    const listener = {
      onLocationChange: (b, progress, request, location, flags) => {
        if (b != state.browser || !progress?.isTopLevel ||
          flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT) {
          return;
        }
        state.highlight = null;
        title.textContent = this.hostOf(b);
      },
      onStateChange: (b, progress, request, flags) => {
        const done = Ci.nsIWebProgressListener.STATE_STOP | Ci.nsIWebProgressListener.STATE_IS_WINDOW;
        if (b == state.browser && progress?.isTopLevel && (flags & done) == done) {
          state.results = {};
          render();
          load(state.tab);
        }
      },
    };
    win.gBrowser.addTabsProgressListener(listener);
    const onTabSelect = () => lazy.WhimsySurface.close(panel);
    win.gBrowser.tabContainer.addEventListener("TabSelect", onTabSelect);
    cleanups.push(() => {
      win.gBrowser.removeTabsProgressListener(listener);
      win.gBrowser.tabContainer.removeEventListener("TabSelect", onTabSelect);
      if (state.browser?.isConnected && state.highlight) {
        this.query(state.browser, "WhimsyPageDev:ClearHighlight");
      }
    });
    // Ctrl+Tab / Ctrl+Shift+Tab switch the surface's tabs while focus is in it.
    panel.addEventListener("keydown", event => {
      if (event.key == "Tab" && event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        const i = TABS.indexOf(state.tab);
        select(TABS[(i + (event.shiftKey ? -1 : 1) + TABS.length) % TABS.length], { focus: true });
      }
    }, true);

    panel._pagedev = { select, state };
    seg.select(tab);
    render();
    // The view never runs past the page.
    const area = lazy.WhimsySurface.pageArea(win).getBoundingClientRect();
    view.style.maxHeight = `${Math.max(240, Math.round(area.height - 20))}px`;
    lazy.WhimsySurface.open(win, panel, { at: "page-top-end" });
    await load(tab);
    return panel;
  },

  hostOf(browser) {
    try {
      return browser?.currentURI?.displayHost || browser?.currentURI?.displaySpec || "";
    } catch (e) {
      return "";
    }
  },

  _reading(doc, body) {
    const { caption, detail } = lazy.WhimsySurface.caption(doc, { l10nId: "whimsy-pagedev-reading" });
    caption.classList.add("whimsy-pagedev-reading");
    caption.prepend(lazy.WhimsySurface.spinner(doc));
    detail?.remove();
    const group = lazy.WhimsySurface.group(doc);
    group.setAttribute("aria-busy", "true");
    for (let i = 0; i < 3; i++) {
      const row = doc.createXULElement("hbox");
      row.className = "whimsy-pagedev-skeleton-row";
      row.setAttribute("align", "center");
      row.append(lazy.WhimsySurface.skeleton(doc, { width: 28, height: 28 }),
        lazy.WhimsySurface.skeleton(doc, { width: `${60 - i * 12}%`, height: 10 }));
      group.append(row);
    }
    body.append(caption, group);
  },

  _unavailableState(doc, body) {
    body.append(lazy.WhimsySurface.empty(doc, { l10nId: "whimsy-pagedev-unavailable" }));
  },

  _empty(doc, body, l10nId) {
    body.append(lazy.WhimsySurface.empty(doc, { l10nId }));
  },

  // A row that opens to show more (a font's source, a technology's
  // evidence): Return, Space or a click toggle it.
  _disclosure(doc, { head, more, label }) {
    const row = doc.createElementNS(HTML_NS, "div");
    row.className = "whimsy-pagedev-row";
    const button = doc.createElementNS(HTML_NS, "div");
    button.className = "whimsy-pagedev-row-head whimsy-surface-row";
    button.setAttribute("role", "button");
    button.setAttribute("aria-expanded", "false");
    button.tabIndex = 0;
    if (label) {
      button.setAttribute("aria-label", label);
    }
    button.append(...head);
    more.className = `${more.className} whimsy-pagedev-row-more`.trim();
    more.hidden = true;
    const toggle = () => {
      const open = button.getAttribute("aria-expanded") != "true";
      button.setAttribute("aria-expanded", String(open));
      row.toggleAttribute("expanded", open);
      more.hidden = !open;
    };
    button.addEventListener("click", toggle);
    button.addEventListener("keydown", event => {
      if (event.key == "Enter" || event.key == " ") {
        event.preventDefault();
        toggle();
      }
    });
    row.append(button, more);
    return row;
  },

  // ---- Fonts ----

  _sourceText(source) {
    switch (source.kind) {
      case "web":
        return source.detail;
      case "embedded":
        return fmt("whimsy-pagedev-font-source-embedded");
      case "local":
        return source.detail;
      default:
        return "";
    }
  },

  _sourceKind(family) {
    if (family.system) {
      return "system";
    }
    const kinds = family.sources.map(s => s.kind);
    if (kinds.includes("web") || kinds.includes("embedded")) {
      return "web";
    }
    if (kinds.includes("local")) {
      return "local";
    }
    return kinds.includes("fallback") && kinds.every(k => k == "fallback") ? "fallback" : "local";
  },

  _renderFonts(win, state, body) {
    const doc = win.document;
    const result = state.results.fonts;
    if (!result.families?.length) {
      this._empty(doc, body, "whimsy-pagedev-fonts-empty");
      return;
    }
    const { caption } = lazy.WhimsySurface.caption(doc, {
      l10nId: "whimsy-pagedev-fonts-summary",
      l10nArgs: { count: result.families.length },
      detailL10nId: "whimsy-pagedev-by-share",
    });
    const group = lazy.WhimsySurface.group(doc);
    group.classList.add("whimsy-pagedev-fonts");
    const highlights = [];
    for (const family of result.families) {
      group.append(this._fontRow(win, state, family, highlights));
    }
    body.append(caption, group);
  },

  _fontRow(win, state, family, highlights) {
    const doc = win.document;
    const name = family.system ? fmt("whimsy-font-system-name") : String(family.family ?? "").slice(0, 200);
    const kind = this._sourceKind(family);

    // "Aa" in the font, drawn by the page (chrome can't use its web fonts).
    const specimen = doc.createElementNS(HTML_NS, "span");
    specimen.className = "whimsy-pagedev-specimen";
    specimen.setAttribute("aria-hidden", "true");
    const image = safeImage(family.specimen);
    if (image) {
      specimen.classList.add("whimsy-pagedev-specimen-image");
      specimen.style.maskImage = `url("${image.url}")`;
      specimen.style.setProperty("--whimsy-specimen-ratio", String(image.width / Math.max(1, image.height)));
    } else {
      specimen.textContent = "Aa";
    }
    const text = doc.createElementNS(HTML_NS, "span");
    text.className = "whimsy-pagedev-row-text";
    const title = doc.createElementNS(HTML_NS, "span");
    title.className = "whimsy-pagedev-row-title";
    title.textContent = name;
    title.title = name;
    const line = doc.createElementNS(HTML_NS, "span");
    line.className = "whimsy-pagedev-row-line";
    line.textContent = fmt("whimsy-pagedev-font-line", {
      percent: this.percent(family.share),
      source: fmt(`whimsy-font-source-${kind}`),
    });
    text.append(title, line);
    const weights = doc.createElementNS(HTML_NS, "span");
    weights.className = "whimsy-pagedev-row-trailing";
    weights.textContent = family.weights.join(" · ");

    const more = doc.createXULElement("vbox");
    more.className = "whimsy-pagedev-font-more";
    for (const source of family.sources) {
      const value = this._sourceText(source);
      if (!value) {
        continue;
      }
      const span = doc.createElementNS(HTML_NS, "span");
      span.className = "whimsy-surface-copy-value";
      span.textContent = value;
      more.append(lazy.WhimsySurface.copyButton(doc, {
        value: source.kind == "web" ? source.detail : value,
        content: [span],
        className: "whimsy-pagedev-source",
        label: fmt("whimsy-pagedev-copy-value", { value }),
      }));
    }
    const actions = doc.createXULElement("hbox");
    actions.className = "whimsy-pagedev-actions";
    const highlight = lazy.WhimsySurface.textButton(doc, {
      l10nId: "whimsy-pagedev-font-highlight",
      onCommand: () => this._toggleHighlight(win, state, family.family, highlight, highlights),
    });
    highlight.classList.add("whimsy-pagedev-highlight-button");
    highlight.setAttribute("aria-pressed", "false");
    highlights.push(highlight);
    const copyName = lazy.WhimsySurface.textButton(doc, {
      l10nId: "whimsy-pagedev-copy-name",
      ghost: true,
      onCommand: () => {
        this.copy(win, family.system ? "-apple-system, system-ui" : family.family);
        doc.l10n.setAttributes(copyName, "whimsy-surface-copied");
        win.setTimeout(() => copyName.isConnected && doc.l10n.setAttributes(copyName, "whimsy-pagedev-copy-name"),
          lazy.WhimsySurface.COPIED_MS);
      },
    });
    copyName.classList.add("whimsy-pagedev-copy-name");
    actions.append(highlight, copyName);
    more.append(actions);

    const row = this._disclosure(doc, { head: [specimen, text, weights], more, label: name });
    row.classList.add("whimsy-pagedev-font");
    row.dataset.family = family.family;
    return row;
  },

  async _toggleHighlight(win, state, family, button, buttons) {
    const wasOn = button.getAttribute("aria-pressed") == "true";
    for (const b of buttons) {
      b.setAttribute("aria-pressed", "false");
    }
    state.highlight = null;
    if (wasOn) {
      await this.query(state.browser, "WhimsyPageDev:ClearHighlight");
      return 0;
    }
    const result = await this.query(state.browser, "WhimsyPageDev:Highlight", { family });
    if (!result?.count) {
      this.toast(win, "whimsy-pagedev-font-highlight-none");
      return 0;
    }
    state.highlight = family;
    button.setAttribute("aria-pressed", "true");
    return result.count;
  },

  // ---- Colors ----

  // W13 F07 (wave12 F07, option C): four swatches a row, nothing written
  // on them; the picked one's value in a detail bar under the grid (its
  // swatch, the value whole in one line, HEX / RGB / HSL, Copy). A click
  // (or the arrow keys: a radiogroup in rows of four) picks a swatch; Copy
  // or Return on the bar copies. The format applies to the contrast rows
  // and Copy All as CSS Variables too.
  _renderColors(win, state, body, footer) {
    const doc = win.document;
    const result = state.results.colors;
    if (!result.palette?.length) {
      this._empty(doc, body, "whimsy-pagedev-colors-empty");
      return;
    }
    const refreshers = [];
    const refresh = () => refreshers.forEach(fn => fn(this._format));

    const { caption } = lazy.WhimsySurface.caption(doc, {
      l10nId: "whimsy-pagedev-palette-heading",
      l10nArgs: { count: result.palette.length + (result.more ?? 0) },
      detailL10nId: "whimsy-pagedev-by-area",
    });

    const colors = result.palette.slice(0, MAX_SWATCHES);
    const grid = doc.createElementNS(HTML_NS, "div");
    grid.className = "whimsy-pagedev-swatches";
    grid.setAttribute("role", "radiogroup");
    grid.dataset.columns = "4";
    doc.l10n.setAttributes(grid, "whimsy-pagedev-swatches-label");

    // The detail bar.
    const bar = doc.createXULElement("hbox");
    bar.className = "whimsy-pagedev-detail";
    bar.setAttribute("align", "center");
    const chip = doc.createElementNS(HTML_NS, "span");
    chip.className = "whimsy-pagedev-detail-swatch";
    chip.setAttribute("aria-hidden", "true");
    const value = doc.createElementNS(HTML_NS, "span");
    value.className = "whimsy-pagedev-detail-value";
    value.id = "whimsy-pagedev-detail-value";
    value.setAttribute("aria-live", "polite");
    const formats = lazy.WhimsySurface.seg(doc, {
      name: "format",
      small: true,
      label: fmt("whimsy-pagedev-format-label"),
      options: FORMATS.map(f => ({ value: f, l10nId: `whimsy-pagedev-format-${f}` })),
      onPick: f => {
        this._format = f;
        formats.select(f);
        refresh();
      },
    });
    formats.group.classList.add("whimsy-pagedev-formats");
    formats.select(FORMATS.includes(this._format) ? this._format : "hex");
    const copy = doc.createXULElement("toolbarbutton");
    copy.className = "whimsy-sheet-icon-button whimsy-pagedev-detail-copy";
    copy.setAttribute("image", ICON("edit-copy"));
    copy.setAttribute("tabindex", "0");
    copy.setAttribute("aria-describedby", value.id);
    doc.l10n.setAttributes(copy, "whimsy-pagedev-detail-copy");
    bar.append(chip, value, formats.group, copy);

    let picked = colors[0];
    const show = () => {
      const text = formatColor(picked.rgba, this._format);
      chip.style.backgroundColor = formatColor(picked.rgba, "rgb");
      value.textContent = text;
      value.title = `${text} · ${this._roleNames(picked.roles)} · ${this.percent(picked.share)}`;
    };
    const pick = (color, swatch) => {
      picked = color;
      for (const el of grid.children) {
        const on = el == swatch;
        el.setAttribute("aria-checked", String(on));
        el.tabIndex = on ? 0 : -1;
      }
      show();
    };
    colors.forEach((color, i) => grid.append(this._swatch(win, color, refreshers, i == 0, pick)));
    refreshers.push(show);
    copy.addEventListener("command", () => {
      const text = formatColor(picked.rgba, this._format);
      this.copy(win, text);
      copy.setAttribute("copied", "true");
      doc.l10n.setAttributes(copy, "whimsy-pagedev-detail-copied");
      win.setTimeout(() => {
        if (copy.isConnected) {
          copy.removeAttribute("copied");
          doc.l10n.setAttributes(copy, "whimsy-pagedev-detail-copy");
        }
      }, lazy.WhimsySurface.COPIED_MS);
    });
    // Return on a swatch copies it, as a click on the old swatch did.
    grid.addEventListener("keydown", event => {
      if (event.key == "Enter" && event.target.closest(".whimsy-pagedev-color")) {
        event.preventDefault();
        copy.doCommand();
      }
    });
    body.append(caption, grid, bar);
    const more = (result.more ?? 0) + Math.max(0, result.palette.length - MAX_SWATCHES);
    if (more) {
      const note = doc.createElementNS(HTML_NS, "p");
      note.className = "whimsy-pagedev-note";
      doc.l10n.setAttributes(note, "whimsy-pagedev-colors-more", { count: more });
      body.append(note);
    }

    if (result.pairs?.length) {
      const failing = result.pairs.filter(p => !p.aa).length;
      const { caption: contrast } = lazy.WhimsySurface.caption(doc, {
        l10nId: "whimsy-pagedev-contrast-heading",
        l10nArgs: { failing },
      });
      const group = lazy.WhimsySurface.group(doc);
      group.classList.add("whimsy-pagedev-pairs");
      for (const pair of result.pairs) {
        group.append(this._pairRow(win, pair, refreshers));
      }
      body.append(contrast, group);
    }

    const copyVars = lazy.WhimsySurface.footerButton(doc, {
      l10nId: "whimsy-pagedev-copy-css-vars",
      primary: true,
      onCommand: () => {
        this.copy(win, cssVariables(result.palette, this._format));
        this._copiedLabel(win, copyVars, "whimsy-pagedev-copy-css-vars");
      },
    });
    copyVars.classList.add("whimsy-pagedev-copy-css-vars");
    footer.append(copyVars);
    refresh();
  },

  _copiedLabel(win, button, l10nId) {
    win.document.l10n.setAttributes(button, "whimsy-pagedev-copied-button");
    win.setTimeout(() => button.isConnected && win.document.l10n.setAttributes(button, l10nId),
      lazy.WhimsySurface.COPIED_MS);
  },

  _roleNames(roles) {
    return roles.map(role => fmt(`whimsy-pagedev-role-${role}`)).join(" · ");
  },

  // A swatch of the grid: a radio, its colour only; its value, roles and
  // share are its name (and tooltip).
  _swatch(win, color, refreshers, checked, onPick) {
    const doc = win.document;
    const button = doc.createElementNS(HTML_NS, "button");
    button.type = "button";
    button.className = "whimsy-pagedev-color";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(checked));
    button.tabIndex = checked ? 0 : -1;
    button.style.backgroundColor = formatColor(color.rgba, "rgb");
    button.dataset.hex = color.hex;
    button.addEventListener("click", () => onPick(color, button));
    refreshers.push(format => {
      const text = formatColor(color.rgba, format);
      button.title = `${text} · ${this.percent(color.share)}`;
      button.setAttribute("aria-label", `${text}, ${this._roleNames(color.roles)}, ${this.percent(color.share)}`);
    });
    return button;
  },

  _pairRow(win, pair, refreshers) {
    const doc = win.document;
    const ratio = `${pair.ratio.toFixed(2)}:1`;
    const chip = doc.createElementNS(HTML_NS, "span");
    chip.className = "whimsy-pagedev-pair-sample";
    chip.setAttribute("aria-hidden", "true");
    chip.style.color = safeColor(pair.fg);
    chip.style.backgroundColor = safeColor(pair.bg);
    chip.textContent = "Aa";
    const text = doc.createElementNS(HTML_NS, "span");
    text.className = "whimsy-pagedev-row-text";
    const colors = doc.createElementNS(HTML_NS, "span");
    colors.className = "whimsy-pagedev-pair-colors whimsy-surface-copy-value";
    text.append(colors);
    const notes = [];
    if (pair.large) {
      notes.push(fmt("whimsy-pagedev-contrast-large"));
    }
    if (pair.image) {
      notes.push(fmt("whimsy-pagedev-contrast-image"));
    }
    if (notes.length) {
      const note = doc.createElementNS(HTML_NS, "span");
      note.className = "whimsy-pagedev-row-line";
      note.textContent = notes.join(" · ");
      text.append(note);
    }
    const number = doc.createElementNS(HTML_NS, "span");
    number.className = "whimsy-pagedev-ratio";
    number.textContent = pair.ratio.toFixed(1);
    const level = pair.aaa ? "aaa" : pair.aa ? "aa" : "fail";
    const pill = lazy.WhimsySurface.pill(doc, {
      l10nId: `whimsy-pagedev-pill-${level}`,
      tone: level == "fail" ? "fail" : "pass",
    });
    pill.classList.add("whimsy-pagedev-pill");
    pill.dataset.level = level;
    const rgb = hex => {
      const n = parseInt(hex.slice(1, 7), 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
    };
    let copyText = "";
    const row = lazy.WhimsySurface.copyButton(doc, {
      value: () => copyText,
      content: [chip, text, number, pill],
      className: "whimsy-pagedev-pair whimsy-surface-row",
      liveIn: text,
      liveBefore: colors.nextSibling,
    });
    refreshers.push(format => {
      const fg = formatColor(rgb(pair.fg), format);
      const bg = formatColor(rgb(pair.bg), format);
      colors.textContent = fmt("whimsy-pagedev-contrast-pair", { fg, bg });
      const result = ok => fmt(ok ? "whimsy-pagedev-result-pass" : "whimsy-pagedev-result-fail");
      copyText = fmt("whimsy-pagedev-contrast-copy", { fg, bg, ratio, aa: result(pair.aa), aaa: result(pair.aaa) });
      row.setAttribute("aria-label", copyText);
      row.title = fmt("whimsy-pagedev-copy-value", { value: copyText });
    });
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

  showBuiltWith(win) {
    return this.open(win, "built-with");
  },

  _renderBuiltWith(win, state, body, footer) {
    const doc = win.document;
    const technologies = state.results["built-with"]?.technologies ?? [];
    if (!technologies.length) {
      this._empty(doc, body, "whimsy-pagedev-built-with-empty");
    } else {
      let category = null;
      let group = null;
      for (const tech of technologies) {
        if (tech.category != category) {
          category = tech.category;
          const { caption } = lazy.WhimsySurface.caption(doc, { l10nId: `whimsy-pagedev-category-${category}` });
          group = lazy.WhimsySurface.group(doc);
          body.append(caption, group);
        }
        group.append(this._techRow(win, tech));
      }
      const copyAll = lazy.WhimsySurface.footerButton(doc, {
        l10nId: "whimsy-pagedev-copy-all",
        primary: true,
        onCommand: () => {
          this.copy(win, technologies.map(t => this.techLine(t)).join("\n"));
          this._copiedLabel(win, copyAll, "whimsy-pagedev-copy-all");
        },
      });
      copyAll.classList.add("whimsy-pagedev-copy-all");
      footer.append(copyAll);
    }
    const note = doc.createElementNS(HTML_NS, "p");
    note.className = "whimsy-pagedev-note";
    doc.l10n.setAttributes(note, "whimsy-pagedev-built-with-local");
    body.append(note);
  },

  _techRow(win, tech) {
    const doc = win.document;
    const name = String(tech.name ?? "");
    const tile = lazy.WhimsySurface.tile(doc, { text: name.slice(0, 1).toUpperCase() });
    tile.classList.add("whimsy-pagedev-monogram");
    const text = doc.createElementNS(HTML_NS, "span");
    text.className = "whimsy-pagedev-row-text whimsy-pagedev-tech-name";
    const title = doc.createElementNS(HTML_NS, "span");
    title.className = "whimsy-pagedev-row-title";
    title.textContent = name;
    text.append(title);
    if (tech.version) {
      const version = doc.createElementNS(HTML_NS, "span");
      version.className = "whimsy-pagedev-version";
      version.textContent = tech.version;
      text.append(" ", version);
    }
    const chevron = doc.createXULElement("image");
    chevron.className = "whimsy-pagedev-chevron";
    chevron.setAttribute("src", "chrome://global/skin/icons/arrow-right.svg");
    const more = doc.createXULElement("vbox");
    more.className = "whimsy-pagedev-evidence";
    for (const evidence of tech.evidence) {
      const line = doc.createElementNS(HTML_NS, "span");
      line.textContent = this.evidenceText(evidence);
      more.append(line);
    }
    const row = this._disclosure(doc, {
      head: [tile, text, chevron],
      more,
      label: tech.version ? `${name} ${tech.version}` : name,
    });
    row.classList.add("whimsy-pagedev-tech");
    row.setAttribute("data-key", tech.key);
    return row;
  },
};
