/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave9/pagedev: the content side of Fonts on This Page, Page Colors and
// Built With (W9-11). Everything here reads the page as it is rendered
// and answers the parent; it never changes the page's DOM (the usage
// highlight is anonymous content, like the inspector's picker), never
// runs a page getter, and keeps nothing once the tab navigates.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyTechRules: "resource:///modules/whimsy/WhimsyTechRules.sys.mjs",
});

// The usage highlight (anonymous content over the page).
const LAYER_STYLE = {
  position: "fixed",
  inset: "0",
  pointerEvents: "none",
  zIndex: "2147483647",
};
const BOX_STYLE = {
  position: "fixed",
  pointerEvents: "none",
  boxSizing: "border-box",
  borderRadius: "2px",
  backgroundColor: "rgba(168, 85, 247, 0.22)",
  boxShadow: "0 0 0 1px rgba(168, 85, 247, 0.7)",
};
const MAX_ELEMENTS = 8000;
// Fragments of text recorded per face (InspectorUtils' maxRanges): enough
// to measure and highlight usage on long pages.
const MAX_RANGES = 4000;
const MAX_STYLE_SAMPLES = 400;
const MAX_HIGHLIGHT_RECTS = 600;
const MAX_PALETTE = 40;
const MAX_PAIRS = 12;
const SAMPLE_PX = 26;

function nonSpaceLength(text) {
  return (text || "").replace(/\s+/g, "").length;
}

function quoteFamily(name) {
  return `"${String(name).replace(/["\\]/g, "\\$&")}"`;
}

function clampByte(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

export function hexOf({ r, g, b, a = 1 }) {
  const hex = [r, g, b].map(v => clampByte(v).toString(16).padStart(2, "0")).join("");
  const alpha = a < 1 ? clampByte(a * 255).toString(16).padStart(2, "0") : "";
  return `#${hex}${alpha}`.toUpperCase();
}

// Source-over: `top` (may be translucent) on an opaque `bottom`.
function over(top, bottom) {
  const a = top.a ?? 1;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

function channel(v) {
  v /= 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function luminance(c) {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

export function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export class WhimsyPageDevChild extends JSWindowActorChild {
  _highlight = null; // { anon, family, rects, onScroll }
  _fontRanges = new Map(); // family → Range[] (in memory, this page only)

  receiveMessage(message) {
    try {
      switch (message.name) {
        case "WhimsyPageDev:Fonts":
          return this.fonts();
        case "WhimsyPageDev:Colors":
          return this.colors();
        case "WhimsyPageDev:BuiltWith":
          return this.builtWith();
        case "WhimsyPageDev:Highlight":
          return this.highlight(message.data?.family);
        case "WhimsyPageDev:ClearHighlight":
          this.clearHighlight();
          return { count: 0 };
        case "WhimsyPageDev:HighlightState":
          return { family: this._highlight?.family ?? null, count: this._highlight?.rects ?? 0 };
      }
    } catch (e) {
      console.error("Whimsy: page developer", message.name, e);
    }
    return null;
  }

  didDestroy() {
    this.clearHighlight();
    this._fontRanges.clear();
  }

  // ---- Colors helpers ----

  _rgba(value) {
    if (!value) {
      return null;
    }
    this._colorCache ??= new Map();
    if (this._colorCache.has(value)) {
      return this._colorCache.get(value);
    }
    let rgba = null;
    try {
      rgba = InspectorUtils.colorToRGBA(value);
    } catch (e) {}
    if (!rgba) {
      const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/i.exec(value);
      if (m) {
        const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
        rgba = { r: +m[1], g: +m[2], b: +m[3], a: alpha };
      }
    }
    const result = rgba ? { r: rgba.r, g: rgba.g, b: rgba.b, a: rgba.a ?? 1 } : null;
    this._colorCache.set(value, result);
    return result;
  }

  _canvasColor() {
    return this._rgba("Canvas") ?? { r: 255, g: 255, b: 255, a: 1 };
  }

  // The colour text sits on: background layers composited from the first
  // opaque ancestor up (background images can't be measured; flagged).
  _backdrop(element, win) {
    const layers = [];
    let image = false;
    for (let el = element; el && el.nodeType == 1; el = el.parentElement) {
      const style = win.getComputedStyle(el);
      if (style.backgroundImage && style.backgroundImage != "none") {
        image = true;
      }
      const bg = this._rgba(style.backgroundColor);
      if (bg && bg.a > 0) {
        layers.push(bg);
        if (bg.a >= 1) {
          break;
        }
      }
    }
    let color = layers.at(-1)?.a >= 1 ? layers.pop() : this._canvasColor();
    while (layers.length) {
      color = over(layers.pop(), color);
    }
    return { color, image };
  }

  // ---- Fonts on This Page ----

  fonts() {
    const doc = this.document;
    const win = this.contentWindow;
    if (!doc?.body || !win) {
      return { families: [], totalChars: 0 };
    }
    const range = doc.createRange();
    range.selectNodeContents(doc.body);
    const faces = InspectorUtils.getUsedFontFaces(range, MAX_RANGES, true);

    const byFamily = new Map();
    for (const face of faces) {
      const family = face.CSSFamilyName || face.name;
      if (!family) {
        continue;
      }
      let entry = byFamily.get(family);
      if (!entry) {
        entry = {
          family,
          faces: new Set(),
          sources: new Map(),
          ranges: [],
          chars: 0,
          capped: false,
          generic: face.CSSGeneric || "",
        };
        byFamily.set(family, entry);
      }
      if (face.name) {
        entry.faces.add(face.name);
      }
      let source;
      if (face.URI) {
        source = face.URI.startsWith("data:")
          ? { kind: "embedded", detail: face.URI.slice(0, face.URI.indexOf(",") > 0 ? face.URI.indexOf(",") : 40) }
          : { kind: "web", detail: face.URI };
      } else if (face.localName) {
        source = { kind: "local", detail: face.localName };
      } else if (face.fromSystemFallback && !face.fromFontGroup) {
        source = { kind: "fallback", detail: "" };
      } else {
        source = { kind: "system", detail: "" };
      }
      entry.sources.set(`${source.kind}|${source.detail}`, source);
      const ranges = face.ranges ?? [];
      if (ranges.length >= MAX_RANGES) {
        entry.capped = true;
      }
      for (const r of ranges) {
        entry.chars += nonSpaceLength(r.toString());
        entry.ranges.push(r);
      }
    }

    const totalChars = [...byFamily.values()].reduce((sum, e) => sum + e.chars, 0);
    this._fontRanges.clear();
    const families = [];
    for (const entry of byFamily.values()) {
      if (!entry.chars) {
        continue;
      }
      this._fontRanges.set(entry.family, entry.ranges);
      const weights = new Map();
      const styles = new Map();
      let sample = "";
      for (const r of entry.ranges.slice(0, MAX_STYLE_SAMPLES)) {
        const node = r.startContainer;
        const el = node.nodeType == 1 ? node : node.parentElement;
        if (!el) {
          continue;
        }
        const cs = win.getComputedStyle(el);
        const n = nonSpaceLength(r.toString());
        weights.set(cs.fontWeight, (weights.get(cs.fontWeight) ?? 0) + n);
        styles.set(cs.fontStyle, (styles.get(cs.fontStyle) ?? 0) + n);
        if (sample.length < 12) {
          const text = r.toString().replace(/\s+/g, " ").trim();
          if (text.length > sample.length) {
            sample = text;
          }
        }
      }
      const sortKeys = map => [...map.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
      const weightList = sortKeys(weights);
      const styleList = sortKeys(styles);
      families.push({
        family: entry.family,
        faces: [...entry.faces].sort(),
        weights: [...weightList].sort((a, b) => parseFloat(a) - parseFloat(b)),
        styles: styleList,
        sources: [...entry.sources.values()],
        generic: entry.generic,
        chars: entry.chars,
        capped: entry.capped,
        share: totalChars ? entry.chars / totalChars : 0,
        sample: sample.slice(0, 48),
        image: this._sampleImage(entry.family, weightList[0] ?? "400", styleList[0] ?? "normal", sample.slice(0, 48)),
      });
    }
    families.sort((a, b) => b.chars - a.chars);
    return { families, totalChars };
  }

  // A picture of the family's own text in the family itself, drawn by the
  // page's document (which has the web fonts loaded), so the parent can
  // show it without fetching anything. Black on transparent: the panel
  // uses it as a mask and fills it with its own text colour.
  _sampleImage(family, weight, style, text) {
    try {
      const doc = this.document;
      const canvas = doc.createElement("canvas");
      const ctx = canvas.getContext("2d");
      const scale = 2;
      const px = SAMPLE_PX * scale;
      const font = `${style == "normal" ? "" : style} ${weight} ${px}px ${quoteFamily(family)}`.trim();
      const label = text || "Aa Bb Cc 123";
      ctx.font = font;
      const width = Math.min(Math.ceil(ctx.measureText(label).width) + 8, 1200 * scale);
      canvas.width = Math.max(width, 1);
      canvas.height = Math.ceil(px * 1.5);
      ctx.font = font;
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#000";
      ctx.fillText(label, 4, canvas.height / 2);
      return { url: canvas.toDataURL("image/png"), width: canvas.width / scale, height: canvas.height / scale };
    } catch (e) {
      return null;
    }
  }

  highlight(family) {
    this.clearHighlight();
    const ranges = this._fontRanges.get(family);
    const doc = this.document;
    const win = this.contentWindow;
    if (!ranges?.length || !doc || !win) {
      return { count: 0 };
    }
    let anon;
    try {
      anon = doc.insertAnonymousContent();
    } catch (e) {
      return { count: 0 };
    }
    // Styled through the CSSOM: a page can't load chrome:// sheets, and a
    // page's CSP doesn't apply to CSSOM writes.
    const layer = doc.createElement("div");
    Object.assign(layer.style, LAYER_STYLE);
    anon.root.append(layer);

    const draw = () => {
      layer.replaceChildren();
      let drawn = 0;
      for (const r of ranges) {
        for (const rect of r.getClientRects()) {
          if (drawn >= MAX_HIGHLIGHT_RECTS) {
            break;
          }
          if (rect.width < 1 || rect.height < 1 || rect.bottom < 0 || rect.top > win.innerHeight) {
            continue;
          }
          const box = doc.createElement("div");
          Object.assign(box.style, BOX_STYLE);
          box.style.left = `${rect.left}px`;
          box.style.top = `${rect.top}px`;
          box.style.width = `${rect.width}px`;
          box.style.height = `${rect.height}px`;
          layer.append(box);
          drawn++;
        }
      }
      return drawn;
    };

    let total = 0;
    for (const r of ranges) {
      total += [...r.getClientRects()].filter(rect => rect.width >= 1 && rect.height >= 1).length;
    }
    if (!total) {
      doc.removeAnonymousContent(anon);
      return { count: 0 };
    }
    let visible = draw();
    if (!visible) {
      // Nothing on screen: bring the first use into view (instant when
      // the person prefers reduced motion).
      const first = ranges.find(r => [...r.getClientRects()].some(rect => rect.width >= 1));
      const el = first?.startContainer.nodeType == 1 ? first.startContainer : first?.startContainer.parentElement;
      const reduce = win.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el?.scrollIntoView({ block: "center", behavior: reduce ? "instant" : "smooth" });
      visible = draw();
    }

    let queued = false;
    const onScroll = () => {
      if (queued) {
        return;
      }
      queued = true;
      win.requestAnimationFrame(() => {
        queued = false;
        if (this._highlight?.anon == anon) {
          draw();
        }
      });
    };
    win.addEventListener("scroll", onScroll, { passive: true, capture: true });
    win.addEventListener("resize", onScroll, { passive: true });
    this._highlight = { anon, family, rects: total, onScroll };
    return { count: total };
  }

  clearHighlight() {
    const h = this._highlight;
    this._highlight = null;
    if (!h) {
      return;
    }
    const win = this.contentWindow;
    try {
      win?.removeEventListener("scroll", h.onScroll, { capture: true });
      win?.removeEventListener("resize", h.onScroll);
    } catch (e) {}
    try {
      this.document?.removeAnonymousContent(h.anon);
    } catch (e) {}
  }

  // ---- Page Colors ----

  colors() {
    const doc = this.document;
    const win = this.contentWindow;
    if (!doc?.documentElement || !win) {
      return { palette: [], pairs: [] };
    }
    this._colorCache = new Map();
    const palette = new Map(); // hex → { rgba, score, roles: { role: score } }
    const add = (rgba, role, score) => {
      if (!rgba || rgba.a <= 0 || !(score > 0)) {
        return;
      }
      const hex = hexOf(rgba);
      let entry = palette.get(hex);
      if (!entry) {
        entry = { hex, rgba: { r: clampByte(rgba.r), g: clampByte(rgba.g), b: clampByte(rgba.b), a: rgba.a }, score: 0, roles: {} };
        palette.set(hex, entry);
      }
      entry.score += score;
      entry.roles[role] = (entry.roles[role] ?? 0) + score;
    };
    const pairs = new Map();

    const root = doc.documentElement;
    const pageArea = Math.max(root.scrollWidth * root.scrollHeight, win.innerWidth * win.innerHeight);
    // The page's own background: the root's, else the body's (CSS
    // propagates it to the canvas), else the canvas colour.
    const rootBg = this._rgba(win.getComputedStyle(root).backgroundColor);
    const bodyBg = doc.body ? this._rgba(win.getComputedStyle(doc.body).backgroundColor) : null;
    const pageBg = rootBg?.a > 0 ? rootBg : bodyBg?.a > 0 ? bodyBg : this._canvasColor();
    add(pageBg, "background", pageArea);
    const skipBg = new Set([root, doc.body]);

    const elements = doc.body ? doc.body.querySelectorAll("*") : [];
    const count = Math.min(elements.length, MAX_ELEMENTS);
    for (let i = 0; i < count; i++) {
      const el = elements[i];
      if (!el.checkVisibility?.({ visibilityProperty: true, opacityProperty: true })) {
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 && rect.height < 1) {
        continue;
      }
      const cs = win.getComputedStyle(el);
      const area = rect.width * rect.height;

      if (!skipBg.has(el)) {
        add(this._rgba(cs.backgroundColor), "background", area);
      }

      // Borders: each visible side, by its area.
      for (const side of ["Top", "Right", "Bottom", "Left"]) {
        const width = parseFloat(cs[`border${side}Width`]) || 0;
        const style = cs[`border${side}Style`];
        if (width > 0 && style != "none" && style != "hidden") {
          const length = side == "Top" || side == "Bottom" ? rect.width : rect.height;
          add(this._rgba(cs[`border${side}Color`]), "border", length * width);
        }
      }
      const outline = parseFloat(cs.outlineWidth) || 0;
      if (outline > 0 && cs.outlineStyle != "none") {
        add(this._rgba(cs.outlineColor), "accent", 2 * (rect.width + rect.height) * outline);
      }
      if (cs.accentColor && cs.accentColor != "auto") {
        add(this._rgba(cs.accentColor), "accent", 100);
      }
      if (el.namespaceURI == "http://www.w3.org/2000/svg") {
        if (cs.fill && cs.fill != "none" && !cs.fill.startsWith("url(")) {
          add(this._rgba(cs.fill), "accent", area * (parseFloat(cs.fillOpacity) || 1));
        }
        if (cs.stroke && cs.stroke != "none" && !cs.stroke.startsWith("url(")) {
          add(this._rgba(cs.stroke), "accent", 2 * (rect.width + rect.height) * (parseFloat(cs.strokeWidth) || 1));
        }
      }

      // Text this element draws itself (its own text nodes).
      let chars = 0;
      for (const child of el.childNodes) {
        if (child.nodeType == 3) {
          chars += nonSpaceLength(child.data);
        }
      }
      if (!chars) {
        continue;
      }
      const size = parseFloat(cs.fontSize) || 16;
      const link = !!el.closest("a[href]");
      const fg = this._rgba(cs.color);
      if (!fg || fg.a <= 0) {
        continue;
      }
      add(fg, link ? "link" : "text", chars * size * size * 0.5);
      if (cs.textDecorationLine && cs.textDecorationLine != "none") {
        const deco = this._rgba(cs.textDecorationColor);
        if (deco && hexOf(deco) != hexOf(fg)) {
          add(deco, "accent", chars * size);
        }
      }

      const { color: bg, image } = this._backdrop(el, win);
      const shown = fg.a < 1 ? over(fg, bg) : fg;
      const weight = parseInt(cs.fontWeight, 10) || 400;
      // WCAG "large": 18pt (24px), or 14pt (18.66px) bold.
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const key = `${hexOf(shown)}|${hexOf(bg)}`;
      let pair = pairs.get(key);
      if (!pair) {
        pair = { fg: hexOf(shown), bg: hexOf(bg), fgRgb: shown, bgRgb: bg, chars: 0, large: true, image: false };
        pairs.set(key, pair);
      }
      pair.chars += chars;
      // Any normal-size use holds the pair to the normal-text bar.
      pair.large &&= large;
      pair.image ||= image;
    }

    const all = [...palette.values()].sort((a, b) => b.score - a.score);
    const total = all.reduce((sum, e) => sum + e.score, 0) || 1;
    const top = all.slice(0, MAX_PALETTE).map(e => {
      const roles = Object.entries(e.roles)
        .sort((a, b) => b[1] - a[1])
        .map(([role]) => role);
      return { hex: e.hex, rgba: e.rgba, roles, share: e.score / total };
    });

    const pairList = [...pairs.values()]
      .sort((a, b) => b.chars - a.chars)
      .slice(0, MAX_PAIRS)
      .map(p => {
        const raw = contrast(p.fgRgb, p.bgRgb);
        // Truncated to 2 decimals (as DevTools does); pass/fail is judged
        // on the same number that is shown, so they never disagree.
        const ratio = Math.floor(raw * 100) / 100;
        return {
          fg: p.fg,
          bg: p.bg,
          ratio,
          large: p.large,
          image: p.image,
          chars: p.chars,
          aa: ratio >= (p.large ? 3 : 4.5),
          aaa: ratio >= (p.large ? 4.5 : 7),
        };
      });
    this._colorCache = null;
    return {
      palette: top,
      more: Math.max(0, all.length - top.length),
      pairs: pairList,
      capped: elements.length > MAX_ELEMENTS,
    };
  }

  // ---- Built With ----

  _ownValue(win, path) {
    // Follows own data properties only: a page getter never runs.
    let obj = win.wrappedJSObject;
    const parts = path.split(".");
    for (let i = 0; i < parts.length; i++) {
      if (obj === null || (typeof obj != "object" && typeof obj != "function")) {
        return undefined;
      }
      let desc;
      try {
        desc = Object.getOwnPropertyDescriptor(obj, parts[i]);
      } catch (e) {
        return undefined;
      }
      if (!desc) {
        return undefined;
      }
      if (!("value" in desc)) {
        // An accessor: present, but not read.
        return i == parts.length - 1 ? true : undefined;
      }
      obj = desc.value;
    }
    if (obj === undefined) {
      return undefined;
    }
    return typeof obj == "string" ? obj.slice(0, 64) : true;
  }

  builtWith() {
    const doc = this.document;
    const win = this.contentWindow;
    if (!doc?.documentElement || !win) {
      return { technologies: [] };
    }
    const need = lazy.WhimsyTechRules.requirements();
    const signals = {
      generators: [],
      globals: {},
      globalNames: [],
      selectors: {},
      expandos: [],
      urls: [],
      headers: {},
      cssVars: {},
      classes: [],
    };

    for (const meta of doc.querySelectorAll('meta[name="generator" i]')) {
      if (meta.content) {
        signals.generators.push(meta.content.slice(0, 120));
      }
    }

    for (const path of need.globals) {
      const value = this._ownValue(win, path);
      if (value !== undefined) {
        signals.globals[path] = value;
      }
    }
    if (need.prefixes.length) {
      try {
        signals.globalNames = Object.getOwnPropertyNames(win.wrappedJSObject).filter(name =>
          need.prefixes.some(p => name.startsWith(p))
        );
      } catch (e) {}
    }

    for (const selector of need.selectors) {
      try {
        const el = doc.querySelector(selector);
        if (el) {
          const attrs = {};
          for (const attr of el.attributes) {
            attrs[attr.name] = attr.value.slice(0, 64);
          }
          signals.selectors[selector] = attrs;
        }
      } catch (e) {}
    }

    if (need.expando || need.classes) {
      const sample = doc.body ? doc.body.querySelectorAll("*") : [];
      const expandos = new Set();
      const classes = new Set();
      const candidates = [doc.documentElement, doc.body, ...[...sample].slice(0, 3000)].filter(Boolean);
      candidates.forEach((el, i) => {
        if (need.expando && i < 300) {
          try {
            for (const name of Object.keys(el.wrappedJSObject)) {
              expandos.add(name);
            }
          } catch (e) {}
        }
        if (need.classes && classes.size < 6000) {
          for (const c of el.classList) {
            classes.add(c);
          }
        }
      });
      signals.expandos = [...expandos];
      signals.classes = [...classes];
    }

    const urls = new Set();
    const addUrl = u => {
      if (u && urls.size < 800 && /^https?:/i.test(u)) {
        urls.add(u);
      }
    };
    for (const s of doc.scripts) {
      addUrl(s.src);
    }
    for (const l of doc.querySelectorAll("link[href]")) {
      addUrl(l.href);
    }
    try {
      for (const entry of win.performance.getEntriesByType("resource")) {
        addUrl(entry.name);
      }
    } catch (e) {}
    signals.urls = [...urls];

    for (const name of need.cssVars) {
      const value =
        win.getComputedStyle(doc.documentElement).getPropertyValue(name) ||
        (doc.body ? win.getComputedStyle(doc.body).getPropertyValue(name) : "");
      if (value) {
        signals.cssVars[name] = value.trim() || " ";
      }
    }

    signals.headers = this._responseHeaders();

    return { technologies: lazy.WhimsyTechRules.detect(signals) };
  }

  // The document's own response headers, which this tab already received.
  // Cookies are never read.
  _responseHeaders() {
    const headers = {};
    try {
      const channel = this.docShell?.currentDocumentChannel;
      if (channel instanceof Ci.nsIHttpChannel) {
        channel.visitResponseHeaders({
          visitHeader(name, value) {
            const key = name.toLowerCase();
            if (key == "set-cookie" || key == "cookie") {
              return;
            }
            headers[key] = String(value).slice(0, 200);
          },
        });
      }
    } catch (e) {}
    return headers;
  }
}
