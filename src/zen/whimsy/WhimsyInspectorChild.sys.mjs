/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave9: Inspector (Font Inspector & Element Inspector Lite) content side.
// Works via a JSWindowActor. Anonymous content ensures the page's DOM is untouched.
// In private browsing tabs, state is transient in-memory and never written to storage.

const OVERLAY_STYLESHEET = "chrome://browser/content/whimsy/whimsy-inspector.css";

function colorToHex(colorStr, win = null) {
  if (!colorStr) {
    return "#000000";
  }
  try {
    const inspectorUtils = win?.InspectorUtils || (typeof InspectorUtils !== "undefined" ? InspectorUtils : null);
    if (inspectorUtils?.colorToRGBA) {
      const rgba = inspectorUtils.colorToRGBA(colorStr, win?.document);
      if (rgba) {
        const r = Math.max(0, Math.min(255, Math.round(rgba.r))).toString(16).padStart(2, "0");
        const g = Math.max(0, Math.min(255, Math.round(rgba.g))).toString(16).padStart(2, "0");
        const b = Math.max(0, Math.min(255, Math.round(rgba.b))).toString(16).padStart(2, "0");
        if (rgba.a !== undefined && rgba.a < 1) {
          const a = Math.max(0, Math.min(255, Math.round(rgba.a * 255))).toString(16).padStart(2, "0");
          return `#${r}${g}${b}${a}`.toUpperCase();
        }
        return `#${r}${g}${b}`.toUpperCase();
      }
    }
  } catch (e) {}

  const m = colorStr.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/i);
  if (m) {
    const r = Math.max(0, Math.min(255, Math.round(parseFloat(m[1])))).toString(16).padStart(2, "0");
    const g = Math.max(0, Math.min(255, Math.round(parseFloat(m[2])))).toString(16).padStart(2, "0");
    const b = Math.max(0, Math.min(255, Math.round(parseFloat(m[3])))).toString(16).padStart(2, "0");
    if (m[4] !== undefined && parseFloat(m[4]) < 1) {
      const a = Math.max(0, Math.min(255, Math.round(parseFloat(m[4]) * 255))).toString(16).padStart(2, "0");
      return `#${r}${g}${b}${a}`.toUpperCase();
    }
    return `#${r}${g}${b}`.toUpperCase();
  }
  return colorStr.toUpperCase();
}

function parseRgb(colorStr) {
  if (!colorStr) {
    return { r: 0, g: 0, b: 0, a: 1 };
  }
  const m = colorStr.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/i);
  if (m) {
    return {
      r: parseFloat(m[1]),
      g: parseFloat(m[2]),
      b: parseFloat(m[3]),
      a: m[4] !== undefined ? parseFloat(m[4]) : 1,
    };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

function srgbToLin(v) {
  v = v / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relLuminance(r, g, b) {
  return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
}

function contrastRatio(rgb1, rgb2) {
  const l1 = relLuminance(rgb1.r, rgb1.g, rgb1.b);
  const l2 = relLuminance(rgb2.r, rgb2.g, rgb2.b);
  const max = Math.max(l1, l2);
  const min = Math.min(l1, l2);
  return (max + 0.05) / (min + 0.05);
}

function getEffectiveBg(element, win) {
  let curr = element;
  let bg = { r: 255, g: 255, b: 255, a: 1 };
  while (curr && curr.nodeType === 1) {
    const style = win.getComputedStyle(curr);
    const parsed = parseRgb(style.backgroundColor);
    if (parsed.a > 0.05) {
      bg = parsed;
      break;
    }
    curr = curr.parentElement;
  }
  return bg;
}

function generateSelector(el) {
  if (!el || el.nodeType !== 1) {
    return "";
  }
  if (el.id) {
    return `#${CSS.escape(el.id)}`;
  }
  const path = [];
  let curr = el;
  while (curr && curr.nodeType === 1 && curr.tagName.toLowerCase() !== "body" && curr.tagName.toLowerCase() !== "html") {
    const tag = curr.tagName.toLowerCase();
    if (curr.id) {
      path.unshift(`#${CSS.escape(curr.id)}`);
      break;
    }
    let selector = tag;
    if (curr.className && typeof curr.className === "string") {
      const classes = curr.className.trim().split(/\s+/).filter(c => c && !c.startsWith("whimsy-")).slice(0, 2);
      if (classes.length) {
        selector += "." + classes.map(c => CSS.escape(c)).join(".");
      }
    }
    const siblings = Array.from(curr.parentNode?.children || []).filter(s => s.tagName === curr.tagName);
    if (siblings.length > 1) {
      const index = siblings.indexOf(curr) + 1;
      selector += `:nth-of-type(${index})`;
    }
    path.unshift(selector);
    curr = curr.parentElement;
  }
  return path.join(" > ") || el.tagName.toLowerCase();
}

export class WhimsyInspectorChild extends JSWindowActorChild {
  _pickerActive = false;
  _pickerMode = "element"; // "element" | "font" | "zap" | "measure"
  _anon = null;
  _overlay = null;
  _hoverOutline = null;
  _hoverChip = null;
  _selectedOutline = null;
  _selectedChip = null;
  _gapGuides = [];
  _selectedElement = null;
  _selectedRect = null;
  _hoveredElement = null;

  receiveMessage(message) {
    switch (message.name) {
      case "Whimsy:InspectFontSelection":
        return this.inspectFontSelection();
      case "Whimsy:StartPicker":
        return this.startPicker(message.data?.mode || "element");
      case "Whimsy:StopPicker":
        return this.stopPicker();
      case "Whimsy:InspectElementBySelector":
        return this.inspectBySelector(message.data?.selector);
    }
    return null;
  }

  inspectFontSelection() {
    const win = this.contentWindow;
    if (!win) {
      return null;
    }
    const sel = win.getSelection();
    if (sel && sel.rangeCount > 0 && sel.toString().trim()) {
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
      return this._extractFontInfo(node, range, {
        x: win.mozInnerScreenX + rect.left,
        y: win.mozInnerScreenY + rect.bottom,
        text: sel.toString().trim(),
      });
    }
    return null;
  }

  _extractFontInfo(element, range = null, point = null) {
    const win = this.contentWindow;
    const doc = this.document;
    if (!win || !element) {
      return null;
    }
    const style = win.getComputedStyle(element);

    let renderedFont = null;
    try {
      const rng = range || doc.createRange();
      if (!range) {
        rng.selectNodeContents(element);
      }
      const inspectorUtils = win.InspectorUtils || (typeof InspectorUtils !== "undefined" ? InspectorUtils : null);
      if (inspectorUtils?.getUsedFontFaces) {
        const fonts = inspectorUtils.getUsedFontFaces(rng);
        if (fonts?.length && fonts[0].name) {
          renderedFont = fonts[0].name;
        }
      }
    } catch (e) {}

    const cssStack = style.fontFamily || "sans-serif";
    if (!renderedFont) {
      renderedFont = cssStack.split(",")[0].replace(/['"]/g, "").trim();
    }

    const rect = element.getBoundingClientRect();
    const x = point?.x ?? Math.round(win.mozInnerScreenX + rect.left);
    const y = point?.y ?? Math.round(win.mozInnerScreenY + rect.bottom);
    const colorHex = colorToHex(style.color, win);

    return {
      renderedFont,
      cssStack,
      size: style.fontSize,
      weight: style.fontWeight,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      colorHex,
      colorRgb: style.color,
      previewText: point?.text || element.textContent?.trim().slice(0, 60) || "The quick brown fox jumps over the lazy dog",
      tagName: element.tagName.toLowerCase(),
      selector: generateSelector(element),
      x,
      y,
    };
  }

  _extractElementInfo(element) {
    const win = this.contentWindow;
    if (!win || !element) {
      return null;
    }
    const style = win.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    const boxModel = {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      margin: {
        top: Math.round(parseFloat(style.marginTop) || 0),
        right: Math.round(parseFloat(style.marginRight) || 0),
        bottom: Math.round(parseFloat(style.marginBottom) || 0),
        left: Math.round(parseFloat(style.marginLeft) || 0),
      },
      border: {
        top: Math.round(parseFloat(style.borderTopWidth) || 0),
        right: Math.round(parseFloat(style.borderRightWidth) || 0),
        bottom: Math.round(parseFloat(style.borderBottomWidth) || 0),
        left: Math.round(parseFloat(style.borderLeftWidth) || 0),
      },
      padding: {
        top: Math.round(parseFloat(style.paddingTop) || 0),
        right: Math.round(parseFloat(style.paddingRight) || 0),
        bottom: Math.round(parseFloat(style.paddingBottom) || 0),
        left: Math.round(parseFloat(style.paddingLeft) || 0),
      },
    };

    const textColorHex = colorToHex(style.color, win);
    const textRgb = parseRgb(style.color);
    const bgRgb = getEffectiveBg(element, win);
    const bgColorHex = colorToHex(`rgb(${bgRgb.r}, ${bgRgb.g}, ${bgRgb.b})`, win);

    const ratio = contrastRatio(textRgb, bgRgb);
    const fontSize = parseFloat(style.fontSize) || 16;
    const isBold = parseInt(style.fontWeight, 10) >= 600 || style.fontWeight === "bold";
    const isLarge = fontSize >= 24 || (fontSize >= 18.66 && isBold);
    const passAA = ratio >= (isLarge ? 3.0 : 4.5);
    const passAAA = ratio >= (isLarge ? 4.5 : 7.0);

    const fontInfo = this._extractFontInfo(element);

    return {
      tagName: element.tagName.toLowerCase(),
      selector: generateSelector(element),
      rect: {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      boxModel,
      colors: {
        textColorHex,
        bgColorHex,
        contrastRatio: (Math.round(ratio * 10) / 10).toFixed(1) + ":1",
        passAA,
        passAAA,
        rating: passAAA ? "AAA" : (passAA ? "AA" : "Fail"),
      },
      font: fontInfo,
      x: Math.round(win.mozInnerScreenX + rect.left),
      y: Math.round(win.mozInnerScreenY + rect.bottom),
    };
  }

  inspectBySelector(selector) {
    if (!selector) {
      return null;
    }
    const el = this.document?.querySelector(selector);
    return el ? this._extractElementInfo(el) : null;
  }

  startPicker(mode = "element") {
    if (this._pickerActive) {
      this._pickerMode = mode;
      return true;
    }
    const doc = this.document;
    if (!doc) {
      return false;
    }
    this._pickerActive = true;
    this._pickerMode = mode;
    this._selectedElement = null;
    this._selectedRect = null;
    this._hoveredElement = null;

    try {
      this._anon = doc.insertAnonymousContent();
      const root = this._anon.root;

      const link = doc.createElement("link");
      link.rel = "stylesheet";
      link.href = OVERLAY_STYLESHEET;

      const overlay = doc.createElement("div");
      overlay.id = "whimsy-inspector-overlay";

      const hoverOutline = doc.createElement("div");
      hoverOutline.className = "whimsy-hover-outline";
      hoverOutline.style.display = "none";
      const hoverChip = doc.createElement("span");
      hoverChip.className = "whimsy-picker-chip";
      hoverOutline.append(hoverChip);

      const selectedOutline = doc.createElement("div");
      selectedOutline.className = "whimsy-selected-outline";
      selectedOutline.style.display = "none";
      const selectedChip = doc.createElement("span");
      selectedChip.className = "whimsy-picker-chip";
      selectedOutline.append(selectedChip);

      overlay.append(hoverOutline, selectedOutline);
      root.append(link, overlay);

      this._overlay = overlay;
      this._hoverOutline = hoverOutline;
      this._hoverChip = hoverChip;
      this._selectedOutline = selectedOutline;
      this._selectedChip = selectedChip;
    } catch (e) {
      this._pickerActive = false;
      return false;
    }

    const handler = this.docShell?.chromeEventHandler || this.contentWindow;
    if (handler) {
      handler.addEventListener("pointermove", this, true);
      handler.addEventListener("click", this, true);
      handler.addEventListener("keydown", this, true);
    }
    return true;
  }

  stopPicker() {
    if (!this._pickerActive) {
      return;
    }
    this._pickerActive = false;
    this._selectedElement = null;
    this._selectedRect = null;
    this._hoveredElement = null;

    const handler = this.docShell?.chromeEventHandler || this.contentWindow;
    if (handler) {
      handler.removeEventListener("pointermove", this, true);
      handler.removeEventListener("click", this, true);
      handler.removeEventListener("keydown", this, true);
    }

    if (this._anon && this.document?.documentElement) {
      try {
        this.document.removeAnonymousContent(this._anon);
      } catch (e) {}
    }
    this._anon = null;
    this._overlay = null;
    this._hoverOutline = null;
    this._hoverChip = null;
    this._selectedOutline = null;
    this._selectedChip = null;
    this._clearGapGuides();
  }

  _clearGapGuides() {
    for (const guide of this._gapGuides) {
      guide.remove();
    }
    this._gapGuides = [];
  }

  handleEvent(event) {
    if (!this._pickerActive) {
      return;
    }
    switch (event.type) {
      case "pointermove":
        this._onPointerMove(event);
        break;
      case "click":
        this._onClick(event);
        break;
      case "keydown":
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          this.stopPicker();
          this.sendAsyncMessage("Whimsy:PickerClosed");
        }
        break;
    }
  }

  _onPointerMove(event) {
    const doc = this.document;
    if (!doc || !this._hoverOutline) {
      return;
    }
    const target = event.composedTarget || event.target || doc.elementFromPoint(event.clientX, event.clientY);
    if (!target || target.nodeType !== 1 || target === doc.documentElement || target === doc.body) {
      this._hoverOutline.style.display = "none";
      this._clearGapGuides();
      return;
    }

    this._hoveredElement = target;
    const r = target.getBoundingClientRect();
    this._hoverOutline.style.display = "block";
    this._hoverOutline.style.top = `${r.top}px`;
    this._hoverOutline.style.left = `${r.left}px`;
    this._hoverOutline.style.width = `${r.width}px`;
    this._hoverOutline.style.height = `${r.height}px`;

    const tag = target.tagName.toLowerCase();
    const id = target.id ? `#${target.id}` : "";
    const cls = target.className && typeof target.className === "string"
      ? `.${target.className.trim().split(/\s+/)[0]}`
      : "";
    this._hoverChip.textContent = `${tag}${id}${cls} · ${Math.round(r.width)} × ${Math.round(r.height)}`;

    // If an element is already selected, measure gaps!
    if (this._selectedRect && (this._pickerMode === "element" || this._pickerMode === "measure" || event.altKey)) {
      this._renderGaps(this._selectedRect, r);
    } else {
      this._clearGapGuides();
    }
  }

  _renderGaps(r1, r2) {
    this._clearGapGuides();
    if (!this._overlay) {
      return;
    }
    const doc = this.document;

    // Horizontal gap:
    if (r2.left >= r1.right) {
      const gapX = Math.round(r2.left - r1.right);
      const midY = Math.round((Math.max(r1.top, r2.top) + Math.min(r1.bottom, r2.bottom)) / 2) || Math.round(r1.top + r1.height / 2);
      this._createGapGuide(r1.right, midY, gapX, 0, `${gapX}px`);
    } else if (r1.left >= r2.right) {
      const gapX = Math.round(r1.left - r2.right);
      const midY = Math.round((Math.max(r1.top, r2.top) + Math.min(r1.bottom, r2.bottom)) / 2) || Math.round(r1.top + r1.height / 2);
      this._createGapGuide(r2.right, midY, gapX, 0, `${gapX}px`);
    }

    // Vertical gap:
    if (r2.top >= r1.bottom) {
      const gapY = Math.round(r2.top - r1.bottom);
      const midX = Math.round((Math.max(r1.left, r2.left) + Math.min(r1.right, r2.right)) / 2) || Math.round(r1.left + r1.width / 2);
      this._createGapGuide(midX, r1.bottom, 0, gapY, `${gapY}px`);
    } else if (r1.top >= r2.bottom) {
      const gapY = Math.round(r1.top - r2.bottom);
      const midX = Math.round((Math.max(r1.left, r2.left) + Math.min(r1.right, r2.right)) / 2) || Math.round(r1.left + r1.width / 2);
      this._createGapGuide(midX, r2.bottom, 0, gapY, `${gapY}px`);
    }
  }

  _createGapGuide(x, y, w, h, label) {
    const doc = this.document;
    if (!doc || !this._overlay) {
      return;
    }
    const guide = doc.createElement("div");
    guide.className = `whimsy-gap-guide ${w > 0 ? "horizontal" : "vertical"}`;
    guide.style.left = `${x}px`;
    guide.style.top = `${y}px`;
    guide.style.width = `${Math.max(w, 1)}px`;
    guide.style.height = `${Math.max(h, 1)}px`;

    const badge = doc.createElement("span");
    badge.className = "whimsy-gap-chip";
    badge.textContent = label;
    badge.style.left = `${w / 2}px`;
    badge.style.top = `${h / 2}px`;

    guide.append(badge);
    this._overlay.append(guide);
    this._gapGuides.push(guide);
  }

  _onClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const target = this._hoveredElement || event.composedTarget || event.target;
    if (!target || target.nodeType !== 1) {
      return;
    }

    if (this._pickerMode === "font") {
      const fontData = this._extractFontInfo(target);
      this.stopPicker();
      this.sendAsyncMessage("Whimsy:FontInspected", fontData);
      return;
    }

    if (this._pickerMode === "zap") {
      const selector = generateSelector(target);
      this.stopPicker();
      this.sendAsyncMessage("Whimsy:ZapElement", { selector });
      return;
    }

    // Element inspector mode:
    if (!this._selectedElement) {
      // First selection:
      this._selectedElement = target;
      const r = target.getBoundingClientRect();
      this._selectedRect = r;
      if (this._selectedOutline) {
        this._selectedOutline.style.display = "block";
        this._selectedOutline.style.top = `${r.top}px`;
        this._selectedOutline.style.left = `${r.left}px`;
        this._selectedOutline.style.width = `${r.width}px`;
        this._selectedOutline.style.height = `${r.height}px`;
        this._selectedChip.textContent = `Selected: ${target.tagName.toLowerCase()}`;
      }
      const data = this._extractElementInfo(target);
      this.sendAsyncMessage("Whimsy:ElementInspected", data);
    } else {
      // Second element clicked: compute final gap!
      const r1 = this._selectedRect;
      const r2 = target.getBoundingClientRect();
      const gapX = Math.round(r2.left >= r1.right ? r2.left - r1.right : (r1.left >= r2.right ? r1.left - r2.right : 0));
      const gapY = Math.round(r2.top >= r1.bottom ? r2.top - r1.bottom : (r1.top >= r2.bottom ? r1.top - r2.bottom : 0));

      this.sendAsyncMessage("Whimsy:GapMeasured", {
        firstSelector: generateSelector(this._selectedElement),
        secondSelector: generateSelector(target),
        gapX,
        gapY,
      });

      // Reset selection to second element
      this._selectedElement = target;
      this._selectedRect = r2;
      if (this._selectedOutline) {
        this._selectedOutline.style.top = `${r2.top}px`;
        this._selectedOutline.style.left = `${r2.left}px`;
        this._selectedOutline.style.width = `${r2.width}px`;
        this._selectedOutline.style.height = `${r2.height}px`;
      }
      const data = this._extractElementInfo(target);
      this.sendAsyncMessage("Whimsy:ElementInspected", data);
    }
  }

  didDestroy() {
    this.stopPicker();
  }
}
