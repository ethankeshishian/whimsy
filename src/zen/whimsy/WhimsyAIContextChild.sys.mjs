/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23: what a frame gives an AI surface, already redacted, and the masks
// drawn over its secret fields before any snapshot. One actor per frame
// (allFrames): a cross-origin payment frame answers for itself, and masks
// itself whole. The masks are anonymous content (as Redact's boxes are), so
// the page's DOM is never touched and drawSnapshot paints them.

import {
  MASK_COLOR,
  fieldValue,
  isSensitiveFrame,
  redactText,
  sensitiveFields,
  withoutValues,
} from "resource:///modules/whimsy/WhimsyAISensitive.sys.mjs";

const MAX_TEXT = 400_000;
const MAX_IMAGES = 60;
const MAX_HEADINGS = 60;
const MIN_IMAGE_PX = 48;
const PAD = 2;
const MIN_MIRROR = 3;
const MAX_MIRROR_NODES = 20_000;

export class WhimsyAIContextChild extends JSWindowActorChild {
  #mask = null;
  #layer = null;

  didDestroy() {
    this.#unmask();
  }

  handleEvent(event) {
    if (event.type == "scroll" || event.type == "resize") {
      this.#drawMask();
    }
  }

  receiveMessage(message) {
    switch (message.name) {
      case "WhimsyAIContext:Extract":
        return this.extract(message.data ?? {});
      case "WhimsyAIContext:Mask":
        if (message.data?.on) {
          return this.#maskOn();
        }
        this.#unmask();
        return [];
    }
    return null;
  }

  get #sensitiveFrame() {
    try {
      return isSensitiveFrame(this.manager);
    } catch {
      return false;
    }
  }

  #rects() {
    const win = this.contentWindow;
    if (!win) {
      return [];
    }
    if (this.#sensitiveFrame) {
      return [{ x: 0, y: 0, width: win.innerWidth, height: win.innerHeight, kind: "frame" }];
    }
    const rects = [];
    const fields = sensitiveFields(this.document);
    for (const { el, kind } of fields) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) {
        continue;
      }
      rects.push({ x: r.left - PAD, y: r.top - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2, kind });
    }
    rects.push(...this.#mirrorRects(fields));
    return rects;
  }

  // A secret a page shows again in its own text ("Your code is 482913").
  #mirrorRects(fields) {
    const values = [...new Set(fields.map(f => fieldValue(f.el).trim()).filter(v => v.length >= MIN_MIRROR))];
    const body = this.document.body;
    if (!values.length || !body) {
      return [];
    }
    const out = [];
    const walker = this.document.createTreeWalker(body, this.contentWindow.NodeFilter.SHOW_TEXT);
    const range = this.document.createRange();
    for (let node = walker.nextNode(), n = 0; node && n < MAX_MIRROR_NODES; node = walker.nextNode(), n++) {
      const text = node.data;
      if (text.length < MIN_MIRROR || fields.some(f => f.el.contains(node))) {
        continue;
      }
      for (const value of values) {
        for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + value.length)) {
          range.setStart(node, at);
          range.setEnd(node, at + value.length);
          for (const r of range.getClientRects()) {
            if (r.width > 0 && r.height > 0) {
              out.push({ x: r.left - PAD, y: r.top - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2, kind: "mirror" });
            }
          }
        }
      }
    }
    return out;
  }

  extract({ redact = true } = {}) {
    const doc = this.document;
    const win = this.contentWindow;
    const empty = { text: "", images: [], videos: [], title: "", lang: "", headings: [], sensitiveRects: [] };
    if (!doc?.documentElement || !win) {
      return empty;
    }
    const sensitiveRects = this.#rects();
    if (this.#sensitiveFrame) {
      return { ...empty, sensitiveFrame: true, sensitiveRects };
    }
    const secrets = sensitiveFields(doc);
    const secretEls = new Set(secrets.map(s => s.el));
    let text = doc.body?.innerText ?? doc.documentElement.textContent ?? "";
    // Field values innerText leaves out (a draft in a textarea), labelled.
    const fields = [];
    for (const el of doc.querySelectorAll("input, textarea")) {
      if (secretEls.has(el) || el.type == "hidden" || el.type == "file" || el.type == "checkbox" || el.type == "radio") {
        continue;
      }
      const value = (el.value ?? "").trim();
      if (!value || /^(submit|button|reset|image)$/.test(el.type)) {
        continue;
      }
      const label = (el.labels?.[0]?.textContent ?? el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? el.name ?? "").trim();
      fields.push(label ? `${label}: ${value}` : value);
    }
    if (fields.length) {
      text += "\n\n" + fields.join("\n");
    }
    text = withoutValues(text, secrets.map(s => fieldValue(s.el)));
    if (redact) {
      text = redactText(text).text;
    }
    const images = [];
    for (const img of doc.images) {
      if (images.length >= MAX_IMAGES) {
        break;
      }
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (w < MIN_IMAGE_PX || h < MIN_IMAGE_PX || !img.currentSrc) {
        continue;
      }
      images.push({ src: img.currentSrc, w, h, alt: img.alt ?? "" });
    }
    const videos = [...doc.querySelectorAll("video")].map(v => ({
      src: v.currentSrc ?? "",
      w: v.videoWidth,
      h: v.videoHeight,
      duration: Number.isFinite(v.duration) ? v.duration : null,
      title: v.getAttribute("title") ?? v.getAttribute("aria-label") ?? "",
    }));
    const headings = [...doc.querySelectorAll("h1, h2, h3")]
      .slice(0, MAX_HEADINGS)
      .map(h => ({ level: Number(h.localName[1]), text: (h.innerText ?? "").trim() }))
      .filter(h => h.text);
    return {
      text: text.slice(0, MAX_TEXT),
      truncated: text.length > MAX_TEXT,
      images,
      videos,
      title: doc.title ?? "",
      lang: doc.documentElement.lang ?? "",
      headings,
      sensitiveRects,
    };
  }

  #maskOn() {
    const doc = this.document;
    const win = this.contentWindow;
    if (!doc?.documentElement || !win) {
      return [];
    }
    if (!this.#mask) {
      this.#mask = doc.insertAnonymousContent();
      // CSSOM properties, not a style sheet: a page's CSP can't block them.
      const layer = doc.createElement("div");
      for (const [k, v] of [["position", "fixed"], ["left", "0"], ["top", "0"], ["width", "0"], ["height", "0"], ["overflow", "visible"], ["pointer-events", "none"]]) {
        layer.style.setProperty(k, v);
      }
      this.#mask.root.appendChild(layer);
      this.#layer = layer;
      win.addEventListener("scroll", this, { capture: true, passive: true });
      win.addEventListener("resize", this);
    }
    return this.#drawMask();
  }

  #drawMask() {
    if (!this.#layer) {
      return [];
    }
    const doc = this.document;
    const rects = this.#rects();
    this.#layer.replaceChildren();
    for (const r of rects) {
      const box = doc.createElement("div");
      box.className = "whimsy-ai-mask";
      for (const [k, v] of [
        ["position", "absolute"],
        ["left", `${r.x}px`],
        ["top", `${r.y}px`],
        ["width", `${r.width}px`],
        ["height", `${r.height}px`],
        ["background-color", MASK_COLOR],
        ["border-radius", r.kind == "frame" ? "0" : "4px"],
      ]) {
        box.style.setProperty(k, v, "important");
      }
      this.#layer.appendChild(box);
    }
    return rects;
  }

  #unmask() {
    if (!this.#mask) {
      return;
    }
    try {
      this.contentWindow?.removeEventListener("scroll", this, { capture: true });
      this.contentWindow?.removeEventListener("resize", this);
      this.document?.removeAnonymousContent(this.#mask);
    } catch {}
    this.#mask = null;
    this.#layer = null;
  }
}
