/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 voice-image: text inside images (media-3.x). Images that stay in view
// are recognized on this Mac (Firefox's TextRecognition), once each. Over
// every recognized line sits an invisible line of real text, in a closed
// shadow root above the page: the pointer becomes an I-beam there, drag,
// double- and triple-click select like text, ⌘C copies, and ⌘F finds it.
// Nothing is drawn on the image until a translation covers its lines.

const FEATURE_PREF = "whimsy.feature.image-text";
const DWELL_MS = 300;
const MIN_WIDTH = 48;
const MIN_HEIGHT = 24;
const MAX_LINES = 200;
const MAX_TEXT = 500;
const SVG_NS = "http://www.w3.org/2000/svg";

const STYLE = `
.box { position: absolute; left: 0; top: 0; pointer-events: none; }
.line {
  position: absolute; left: 0; top: 0; margin: 0; padding: 0;
  transform-origin: 0 0; white-space: pre; color: transparent;
  font-family: system-ui, -apple-system, sans-serif; font-weight: 500;
  cursor: text; user-select: text; pointer-events: auto;
  transition: background-color 150ms, color 150ms;
}
.line.blocked { pointer-events: none; }
.line::selection { color: transparent; background-color: Highlight; }
.line.translated {
  color: var(--ink); background-color: var(--plate);
  border-radius: 2px; padding: 0 2px; margin-left: -2px;
  box-shadow: 0 0 0 2px var(--plate);
}
.line.translated::selection { color: HighlightText; }
.line.arrive { animation: arrive 150ms both; }
@keyframes arrive { from { opacity: 0; } }
.pill {
  position: absolute; right: 10px; top: 10px; display: flex; align-items: center; gap: 8px;
  padding: 4px 4px 4px 10px; border-radius: 8px; pointer-events: auto; cursor: default;
  background: rgba(24, 24, 27, 0.86); color: #fff; user-select: none;
  font: 500 12px/16px system-ui, -apple-system, sans-serif;
  box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.14), 0 4px 12px rgba(0, 0, 0, 0.25);
  animation: arrive 150ms both;
}
.pill svg { width: 12px; height: 12px; flex: none; }
.pill button {
  all: unset; padding: 3px 8px; border-radius: 5px; cursor: pointer;
  background: rgba(255, 255, 255, 0.14); font: 600 12px/16px system-ui, -apple-system, sans-serif;
}
.pill button:hover { background: rgba(255, 255, 255, 0.22); }
.pill button:focus-visible { outline: 2px solid #4c9aff; outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) { .line.arrive { animation-delay: 0s !important; } }
`;

function luminance([r, g, b]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// A recognized line's quad from Vision (normalized, origin bottom left:
// p1 bottom left, p2 top left, p3 top right, p4 bottom right) as top left,
// top right, bottom right, bottom left with the origin top left.
function fromQuad(result) {
  const q = result.quad;
  const flip = p => [Number(p.x) || 0, 1 - (Number(p.y) || 0)];
  return { text: String(result.string ?? ""), quad: [flip(q.p2), flip(q.p3), flip(q.p4), flip(q.p1)] };
}

function validLine(line) {
  return (
    line &&
    typeof line.text == "string" &&
    line.text.trim() &&
    Array.isArray(line.quad) &&
    line.quad.length == 4 &&
    line.quad.every(p => Array.isArray(p) && p.length == 2 && p.every(Number.isFinite))
  );
}

export class WhimsyImageTextChild extends JSWindowActorChild {
  // img -> {id, src, lines, box, els, translated, pill}
  images = new Map();
  pending = new Map();
  seen = new WeakSet();
  timers = new Map();
  nextId = 1;
  host = null;
  root = null;
  observer = null;
  mutations = null;
  scheduled = false;
  usedOnce = false;

  handleEvent(event) {
    if (event.type == "DOMContentLoaded" || event.type == "pageshow") {
      try {
        this.start();
      } catch (e) {
        console.error("Whimsy: image text", e);
      }
    } else if (event.type == "pagehide") {
      this.stop();
    }
  }

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  }

  start() {
    const doc = this.document;
    if (this.observer || !this.enabled || !doc?.documentElement || doc.contentType?.startsWith("image/")) {
      return;
    }
    const win = this.contentWindow;
    this.observer = new win.IntersectionObserver(entries => this.onIntersect(entries), { threshold: 0.25 });
    this.mutations = new win.MutationObserver(() => this.rescanSoon());
    this.mutations.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srcset"] });
    this.onScroll = () => this.layoutSoon();
    this.onCopyEvent = event => this.onCopy(event);
    win.addEventListener("copy", this.onCopyEvent, { capture: true });
    win.addEventListener("scroll", this.onScroll, { capture: true, passive: true, mozSystemGroup: true });
    win.addEventListener("resize", this.onScroll, { passive: true, mozSystemGroup: true });
    this.resizes = new win.ResizeObserver(() => this.layoutSoon());
    this.rescan();
  }

  stop() {
    this.observer?.disconnect();
    this.mutations?.disconnect();
    this.resizes?.disconnect();
    const win = this.contentWindow;
    if (win && this.onScroll) {
      win.removeEventListener("scroll", this.onScroll, { capture: true, mozSystemGroup: true });
      win.removeEventListener("resize", this.onScroll, { mozSystemGroup: true });
      win.removeEventListener("copy", this.onCopyEvent, { capture: true });
    }
    for (const timer of this.timers.values()) {
      win?.clearTimeout(timer);
    }
    this.observer = this.mutations = this.resizes = null;
    this.timers.clear();
    this.pending.clear();
    this.images.clear();
    this.host?.remove();
    this.host = this.root = null;
    this.sendAsyncMessage("Whimsy:ImageText:Reset");
  }

  didDestroy() {
    this.observer?.disconnect();
    this.mutations?.disconnect();
    this.resizes?.disconnect();
  }

  rescanSoon() {
    if (this.rescanTimer || !this.contentWindow) {
      return;
    }
    this.rescanTimer = this.contentWindow.setTimeout(() => {
      this.rescanTimer = null;
      this.rescan();
    }, 250);
  }

  rescan() {
    if (!this.observer) {
      return;
    }
    for (const img of this.document.images) {
      if (!this.seen.has(img)) {
        this.seen.add(img);
        this.observer.observe(img);
      }
    }
    for (const [img, info] of this.images) {
      if (!img.isConnected) {
        info.box.remove();
        this.images.delete(img);
      } else if ((img.currentSrc || img.src) != info.src) {
        info.box.remove();
        this.images.delete(img);
        this.observer.unobserve(img);
        this.observer.observe(img);
      }
    }
    this.layoutSoon();
  }

  onIntersect(entries) {
    const win = this.contentWindow;
    for (const entry of entries) {
      const img = entry.target;
      if (!entry.isIntersecting) {
        win.clearTimeout(this.timers.get(img));
        this.timers.delete(img);
        continue;
      }
      if (this.images.has(img) || this.pending.has(img) || this.timers.has(img)) {
        continue;
      }
      // Only images that stay in view: a fast scroll recognizes nothing.
      this.timers.set(
        img,
        win.setTimeout(() => {
          this.timers.delete(img);
          this.recognize(img);
        }, DWELL_MS)
      );
    }
  }

  inView(img) {
    const rect = img.getBoundingClientRect();
    const win = this.contentWindow;
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < win.innerHeight && rect.left < win.innerWidth;
  }

  recognize(img) {
    if (this.images.has(img)) {
      return Promise.resolve(this.images.get(img));
    }
    if (this.pending.has(img)) {
      return this.pending.get(img);
    }
    const promise = this.#recognize(img).finally(() => this.pending.delete(img));
    this.pending.set(img, promise);
    return promise;
  }

  async #recognize(img) {
    const rect = img.getBoundingClientRect();
    if (!img.isConnected || rect.width < MIN_WIDTH || rect.height < MIN_HEIGHT) {
      return null;
    }
    if (!img.complete || !img.naturalWidth) {
      try {
        await img.decode();
      } catch {
        return null;
      }
    }
    const src = img.currentSrc || img.src;
    if (!src) {
      return null;
    }
    let lines = null;
    try {
      const begin = await this.sendQuery("Whimsy:ImageText:Begin", { src });
      if (!begin?.enabled) {
        return null;
      }
      lines = begin.lines ?? [...(await img.recognizeCurrentImageText())].map(fromQuad);
    } catch (e) {
      console.error("Whimsy: image text recognition", e);
      return null;
    }
    if (!this.observer || !img.isConnected || (img.currentSrc || img.src) != src) {
      return null;
    }
    lines = (lines ?? [])
      .filter(validLine)
      .slice(0, MAX_LINES)
      .map(l => ({ text: l.text.trim().slice(0, MAX_TEXT), quad: l.quad }));
    const info = { id: this.nextId++, src, lines, els: [], translated: false, pill: null, box: null };
    if (lines.length) {
      this.build(img, info);
    }
    this.images.set(img, info);
    this.sendAsyncMessage("Whimsy:ImageText:Found", { src, imageId: info.id, lines: lines.map(l => l.text), inView: this.inView(img) });
    return info;
  }

  ensureHost() {
    if (this.host?.isConnected) {
      return;
    }
    const doc = this.document;
    this.host = doc.createElement("div");
    this.host.setAttribute(
      "style",
      "all: initial !important; position: absolute !important; left: 0 !important; top: 0 !important; width: 0 !important; height: 0 !important; overflow: visible !important; z-index: 2147483647 !important; pointer-events: none !important; display: block !important;"
    );
    this.root = this.host.attachShadow({ mode: "closed" });
    const style = doc.createElement("style");
    style.textContent = STYLE;
    this.root.append(style);
    this.root.addEventListener("selectstart", () => this.onUsed());
    this.root.addEventListener("click", event => this.onClick(event));
    // In the body: find (⌘F and its count) searches only the body.
    (doc.body ?? doc.documentElement).append(this.host);
  }

  build(img, info) {
    this.ensureHost();
    const doc = this.document;
    info.box = doc.createElement("div");
    info.box.className = "box";
    for (const line of info.lines) {
      const el = doc.createElement("div");
      el.className = "line";
      el.textContent = line.text;
      info.box.append(el);
      info.els.push(el);
    }
    this.root.append(info.box);
    this.resizes?.observe(img);
    this.layout(img, info);
  }

  layoutSoon() {
    if (this.scheduled || !this.contentWindow) {
      return;
    }
    this.scheduled = true;
    this.contentWindow.requestAnimationFrame(() => {
      this.scheduled = false;
      for (const [img, info] of this.images) {
        if (info.box) {
          this.layout(img, info);
        }
      }
    });
  }

  // The image's content box, relative to the layer's origin.
  contentBox(img) {
    const rect = img.getBoundingClientRect();
    const style = this.contentWindow.getComputedStyle(img);
    const px = name => parseFloat(style[name]) || 0;
    const origin = this.host.getBoundingClientRect();
    const left = rect.left + px("borderLeftWidth") + px("paddingLeft");
    const top = rect.top + px("borderTopWidth") + px("paddingTop");
    return {
      left: left - origin.left,
      top: top - origin.top,
      viewLeft: left,
      viewTop: top,
      width: rect.width - px("borderLeftWidth") - px("borderRightWidth") - px("paddingLeft") - px("paddingRight"),
      height: rect.height - px("borderTopWidth") - px("borderBottomWidth") - px("paddingTop") - px("paddingBottom"),
    };
  }

  layout(img, info) {
    const box = this.contentBox(img);
    const hidden = this.contentWindow.getComputedStyle(img).visibility != "visible" || !box.width;
    info.box.style.display = hidden ? "none" : "";
    info.box.style.transform = `translate(${box.left}px, ${box.top}px)`;
    info.box.style.width = `${box.width}px`;
    info.box.style.height = `${box.height}px`;
    if (hidden) {
      return;
    }
    const doc = this.document;
    const win = this.contentWindow;
    info.lines.forEach((line, i) => {
      const el = info.els[i];
      const [tl, tr, br, bl] = line.quad.map(([x, y]) => [x * box.width, y * box.height]);
      const width = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
      const height = Math.max(4, Math.hypot(bl[0] - tl[0], bl[1] - tl[1]));
      const angle = Math.atan2(tr[1] - tl[1], tr[0] - tl[0]);
      // Measure a line's own width only when its text or size changed.
      const key = `${el.textContent}|${Math.round(height * 10)}`;
      if (el._whimsyKey != key) {
        el.style.fontSize = `${height * 0.82}px`;
        el.style.lineHeight = `${height}px`;
        el.style.height = `${height}px`;
        el.style.transform = "none";
        el.style.minWidth = "";
        el._whimsyKey = key;
        el._whimsyNatural = el.scrollWidth || 1;
      }
      const natural = el._whimsyNatural;
      // A translation keeps its own length, up to a third wider than the line.
      const scale = info.translated && !el._whimsyOriginal ? Math.min(1, (width * 1.33) / natural) : width / natural;
      el.style.transform = `translate(${tl[0]}px, ${tl[1]}px) rotate(${angle}rad) scaleX(${scale})`;
      // A shorter translation's plate still covers the whole line.
      el.style.minWidth = info.translated && !el._whimsyOriginal ? `${width / scale}px` : "";
      // Lines under something the page put over the image take no pointer.
      const cx = box.viewLeft + (tl[0] + tr[0] + br[0] + bl[0]) / 4;
      const cy = box.viewTop + (tl[1] + tr[1] + br[1] + bl[1]) / 4;
      if (cx >= 0 && cy >= 0 && cx < win.innerWidth && cy < win.innerHeight) {
        const hit = doc.elementsFromPoint(cx, cy).find(e => e != this.host);
        el.classList.toggle("blocked", !!hit && hit != img);
      }
    });
    info.pill?.style.setProperty("display", "");
  }

  // ⌘C: the selected part of each line, one line per row, when the whole
  // selection is in images (page text copies as the page's text).
  selectedLines() {
    const sel = this.contentWindow.getSelection();
    const out = [];
    const inLayer = node => !!this.root && node?.getRootNode() == this.root;
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i);
      if (!inLayer(range.startContainer) || !inLayer(range.endContainer)) {
        return out;
      }
    }
    for (const info of this.images.values()) {
      info.els.forEach(el => {
        const node = el.firstChild;
        if (!node || !sel.containsNode(node, true)) {
          return;
        }
        let start = node.length;
        let end = 0;
        for (let i = 0; i < sel.rangeCount; i++) {
          const range = sel.getRangeAt(i);
          if (!range.intersectsNode(node)) {
            continue;
          }
          start = Math.min(start, range.startContainer == node ? range.startOffset : 0);
          end = Math.max(end, range.endContainer == node ? range.endOffset : node.length);
        }
        const text = node.data.slice(start, end).trim();
        if (text) {
          out.push(text);
        }
      });
    }
    return out;
  }

  onCopy(event) {
    const lines = this.selectedLines();
    if (!lines.length) {
      return;
    }
    event.clipboardData.setData("text/plain", lines.join("\n"));
    event.preventDefault();
    this.sendAsyncMessage("Whimsy:ImageText:Copied", { lines: lines.length });
    this.onUsed();
  }

  onUsed() {
    if (!this.usedOnce) {
      this.usedOnce = true;
      this.sendAsyncMessage("Whimsy:ImageText:Used");
    }
  }

  // A plain click on a line is a click on the image (its link, its lightbox).
  onClick(event) {
    const win = this.contentWindow;
    win.clearTimeout(this.clickTimer);
    const line = event.originalTarget?.closest?.(".line");
    if (!line || event.detail != 1 || event.button != 0) {
      return;
    }
    this.clickTimer = win.setTimeout(() => {
      if (!win.getSelection().isCollapsed) {
        return;
      }
      for (const [img, info] of this.images) {
        if (info.els.includes(line)) {
          img.click();
        }
      }
    }, 320);
  }

  // The images in view with text, biggest first.
  async textInView() {
    const visible = [...this.document.images].filter(img => this.inView(img));
    const infos = await Promise.all(visible.map(img => this.recognize(img)));
    return visible
      .map((img, i) => ({ img, info: infos[i] }))
      .filter(({ info }) => info?.lines.length)
      .sort((a, b) => {
        const area = ({ img }) => {
          const r = img.getBoundingClientRect();
          return r.width * r.height;
        };
        return area(b) - area(a);
      });
  }

  async target(src) {
    const found = await this.textInView();
    return (src && found.find(f => f.info.src == src)) || found[0] || null;
  }

  colours(img, info) {
    // The plate takes the image's colours under each line (media-3.6).
    const out = [];
    try {
      const doc = this.document;
      const canvas = doc.createElement("canvas");
      const w = (canvas.width = Math.min(img.naturalWidth, 800));
      const h = (canvas.height = Math.round((img.naturalHeight * w) / img.naturalWidth));
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, w, h);
      for (const line of info.lines) {
        const xs = line.quad.map(p => p[0] * w);
        const ys = line.quad.map(p => p[1] * h);
        // The box a little grown: its rim is the background around the
        // words (the plate), its inside holds the words (the ink).
        const x = Math.max(0, Math.floor(Math.min(...xs)) - 2);
        const y = Math.max(0, Math.floor(Math.min(...ys)) - 2);
        const bw = Math.max(1, Math.min(w, Math.ceil(Math.max(...xs)) + 2) - x);
        const bh = Math.max(1, Math.min(h, Math.ceil(Math.max(...ys)) + 2) - y);
        const data = ctx.getImageData(x, y, bw, bh).data;
        const buckets = new Map();
        const pixels = [];
        for (let row = 0; row < bh; row++) {
          for (let col = 0; col < bw; col++) {
            const i = (row * bw + col) * 4;
            const px = [data[i], data[i + 1], data[i + 2]];
            pixels.push(px);
            if (row < 2 || row >= bh - 2 || col < 2 || col >= bw - 2) {
              const key = px.map(v => v >> 4).join(",");
              const entry = buckets.get(key) ?? { n: 0, px };
              entry.n++;
              buckets.set(key, entry);
            }
          }
        }
        const plate = [...buckets.values()].sort((a, b) => b.n - a.n)[0]?.px ?? [255, 255, 255];
        let ink = luminance(plate) > 128 ? [29, 29, 31] : [250, 250, 250];
        let far = 0;
        for (const px of pixels) {
          const d = distance(px, plate);
          if (d > far) {
            far = d;
            ink = px;
          }
        }
        if (far < 90) {
          ink = luminance(plate) > 128 ? [29, 29, 31] : [250, 250, 250];
        }
        out.push({ plate: `rgb(${plate.join(",")})`, ink: `rgb(${ink.join(",")})` });
      }
    } catch {
      // A cross-origin image can't be read: a light plate with dark text.
    }
    return info.lines.map((_, i) => out[i] ?? { plate: "rgb(246, 244, 238)", ink: "rgb(29, 29, 31)" });
  }

  showTranslation(img, info, { lines, label, showOriginal, showTranslation }) {
    const doc = this.document;
    const colours = this.colours(img, info);
    const reduced = this.contentWindow.matchMedia("(prefers-reduced-motion: reduce)").matches;
    info.translated = true;
    info.translations = lines;
    info.els.forEach((el, i) => {
      el._whimsyOriginal = null;
      el.textContent = lines[i] ?? info.lines[i].text;
      el.style.setProperty("--plate", colours[i].plate);
      el.style.setProperty("--ink", colours[i].ink);
      el.style.animationDelay = reduced ? "0s" : `${i * 30}ms`;
      el.classList.remove("arrive");
      el.classList.add("translated", "arrive");
    });
    info.pill?.remove();
    const pill = doc.createElement("div");
    pill.className = "pill";
    const svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    for (const d of ["M2 3.5h6M5 2v1.5m-2 0c.4 2.2 1.8 4 4 5M7 3.5C6.6 5.7 5 7.7 2.5 8.6", "m8.5 14 3-7 3 7m-5.2-2h4.4"]) {
      const path = doc.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "1.3");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      svg.append(path);
    }
    const text = doc.createElement("span");
    text.textContent = label;
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = showOriginal;
    button.addEventListener("click", event => {
      event.stopPropagation();
      this.swap(info, !info.translated);
      button.textContent = info.translated ? showOriginal : showTranslation;
    });
    pill.append(svg, text, button);
    info.box.append(pill);
    info.pill = pill;
    this.layout(img, info);
  }

  // Show original crossfades back to the image's own text, and back again.
  swap(info, translated) {
    info.translated = translated;
    info.els.forEach((el, i) => {
      el.classList.remove("arrive");
      if (translated) {
        el.textContent = info.translations[i] ?? info.lines[i].text;
        el._whimsyOriginal = null;
        el.classList.add("translated");
      } else {
        el.classList.remove("translated");
        el._whimsyOriginal = true;
        el.textContent = info.lines[i].text;
      }
    });
    for (const [img, entry] of this.images) {
      if (entry == info) {
        this.layout(img, info);
      }
    }
  }

  async receiveMessage(message) {
    const data = message.data ?? {};
    switch (message.name) {
      case "Whimsy:ImageText:InView": {
        const found = await this.textInView();
        return found.map(({ img, info }) => {
          const box = this.contentBox(img);
          return {
            imageId: info.id,
            src: info.src,
            lines: info.lines.map(line => {
              const xs = line.quad.map(p => box.viewLeft + p[0] * box.width);
              const ys = line.quad.map(p => box.viewTop + p[1] * box.height);
              const x = Math.min(...xs);
              const y = Math.min(...ys);
              return { text: line.text, rect: { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y } };
            }),
          };
        });
      }
      case "Whimsy:ImageText:Count": {
        const needle = String(data.text ?? "").toLowerCase();
        if (!needle) {
          return 0;
        }
        let count = 0;
        for (const { info } of await this.textInView()) {
          for (const line of info.lines) {
            const hay = line.text.toLowerCase();
            for (let at = hay.indexOf(needle); at != -1; at = hay.indexOf(needle, at + needle.length)) {
              count++;
            }
          }
        }
        return count;
      }
      case "Whimsy:ImageText:Text": {
        const found = await this.target(data.src);
        return found ? { src: found.info.src, imageId: found.info.id, lines: found.info.lines.map(l => l.text) } : null;
      }
      case "Whimsy:ImageText:Translate": {
        for (const [img, info] of this.images) {
          if (info.id == data.imageId && info.box) {
            this.showTranslation(img, info, data);
            return true;
          }
        }
        return false;
      }
    }
    return null;
  }
}
