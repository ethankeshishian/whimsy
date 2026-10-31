/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave5: Easel, the page (about:whimsy?easel&id=<id>). One canvas: items
// are absolutely positioned in a "world" that pans and zooms; selection,
// handles and guides draw in screen space above it so they stay crisp at
// any zoom. Every change is one undo step and is saved to the profile.
// See WhimsyEasel.sys.mjs and docs/whimsy/easel.md.

import * as M from "chrome://browser/content/whimsy/whimsy-easel-model.mjs";
import { BLOCK_SANDBOX_FLAGS, createLiveBrowser } from "chrome://browser/content/whimsy/whimsy-note-blocks.mjs";

const { gWhimsyEaselStore, gWhimsyEaselClipboard, CHANGED_TOPIC, FEATURE_PREF, easelIdFromURL, easelURL } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyEasel.sys.mjs"
);
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

const PREF_COLOR = "whimsy.easel.color";
const PREF_FONT = "whimsy.easel.font";
const PREF_SIZE = "whimsy.easel.size";
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const DRAG_THRESHOLD = 3;
const SNAP_PX = 6;
const VIEW_MARGIN = 96;
const SHAPE_TOOLS = new Set(["rect", "ellipse", "line", "arrow"]);
const TOOL_KEYS = { v: "select", t: "text", p: "pen", h: "highlighter", r: "rect", o: "ellipse", l: "line", a: "arrow", i: "image" };
const TAB_DROP_TYPE = "application/x-moz-tabbrowser-tab";
const CLIP_TYPE = "application/x-whimsy-easel";
const SVG_NS = "http://www.w3.org/2000/svg";

const $ = id => document.getElementById(id);

// Loads a live capture's page into its <browser> again (see startLive).
function reloadLiveBrowser(browser, url, userContextId) {
  try {
    if (browser.browsingContext) {
      browser.browsingContext.sandboxFlags |= BLOCK_SANDBOX_FLAGS;
    }
    browser.loadURI(Services.io.newURI(url), {
      triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({ userContextId }),
      loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_HISTORY,
    });
  } catch (e) {
    console.error("Whimsy: easel live capture", e);
  }
}
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
const isMac = Services.appinfo.OS == "Darwin";

function svgEl(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url ?? "";
  }
}

function isWebURL(text) {
  try {
    const url = new URL(text.trim());
    return (url.protocol == "https:" || url.protocol == "http:") && !/\s/.test(text.trim());
  } catch {
    return false;
  }
}

class EaselApp {
  id = null;
  title = "";
  items = [];
  selection = new Set();
  tool = "select";
  view = { x: VIEW_MARGIN, y: VIEW_MARGIN, zoom: 1 };
  history = new M.History();
  editingId = null;
  activeId = null;
  els = new Map();
  imageURLs = new Map();
  source = M.newItemId();
  #drag = null;
  #saveTimer = null;
  #viewTimer = null;
  #nudge = null;
  #space = false;
  #pointer = null;
  #suppressMouseDown = false;
  #started = false;
  #liveObserver = null;
  #untitled = "Untitled Easel";
  #textPlaceholder = "";
  #viewAnimation = 0;

  color = Services.prefs.getStringPref(PREF_COLOR, "ink");
  font = Services.prefs.getStringPref(PREF_FONT, "sans");
  size = Math.min(2, Math.max(0, Services.prefs.getIntPref(PREF_SIZE, 1)));

  get item() {
    return this.selection.size == 1 ? this.find([...this.selection][0]) : null;
  }

  get selectedItems() {
    return this.items.filter(i => this.selection.has(i.id));
  }

  find(id) {
    return this.items.find(i => i.id == id) ?? null;
  }

  get isPrivate() {
    return lazy.PrivateBrowsingUtils.isContentWindowPrivate(window);
  }

  // ---------- Startup ----------

  async init() {
    await document.l10n.ready;
    [this.#untitled, this.#textPlaceholder] = await document.l10n.formatValues([
      "whimsy-easel-untitled",
      "whimsy-easel-text-placeholder",
    ]);
    if (!Services.prefs.getBoolPref(FEATURE_PREF, true)) {
      this.showOff("whimsy-easel-off-title", "whimsy-easel-off-body");
      return;
    }
    this.id = easelIdFromURL(document.documentURI);
    if (!this.id) {
      // whimsy://easel: a new easel, then its own address.
      const easel = await gWhimsyEaselStore.create();
      location.replace(easelURL(easel.id));
      return;
    }
    const easel = await gWhimsyEaselStore.get(this.id);
    if (!easel) {
      this.showOff("whimsy-easel-missing-title", "whimsy-easel-missing-body");
      return;
    }
    this.title = easel.title ?? "";
    this.items = M.clone(easel.items ?? []);
    $("easel").hidden = false;
    this.updateTitle();
    this.buildToolbar();
    this.bindEvents();
    await this.loadImages(this.items);
    gWhimsyEaselStore.prune(this.id, this.imageNames(this.items));
    this.#liveObserver = new IntersectionObserver(entries => this.onLiveVisible(entries), { root: $("viewport") });
    this.renderAll();
    if (easel.view && Number.isFinite(easel.view.zoom)) {
      this.view = { ...easel.view };
      this.applyView();
    } else if (this.items.length) {
      this.fit({ animate: false });
    } else {
      this.applyView();
    }
    Services.obs.addObserver(this, CHANGED_TOPIC);
    window.addEventListener("unload", () => this.destroy(), { once: true });
    this.setTool("select");
    this.updateChrome();
    $("viewport").focus({ preventScroll: true });
    // wave7: the easel takes its space's colour, like Arc's easels.
    this.applySpaceColor();
    document.addEventListener("visibilitychange", () => this.applySpaceColor());
    window.addEventListener("focus", () => this.applySpaceColor());
    this.#started = true;
    document.documentElement.setAttribute("ready", "true");
  }

  showOff(titleId, bodyId) {
    const off = $("off");
    document.l10n.setAttributes(off.querySelector("h1"), titleId);
    document.l10n.setAttributes(off.querySelector("p"), bodyId);
    off.hidden = false;
    document.title = this.#untitled;
    document.documentElement.setAttribute("ready", "true");
  }

  destroy() {
    try {
      Services.obs.removeObserver(this, CHANGED_TOPIC);
    } catch {}
    this.flush();
    this.#liveObserver?.disconnect();
    for (const url of this.imageURLs.values()) {
      URL.revokeObjectURL(url);
    }
  }

  // Another page or the capture tool changed this easel.
  async observe(subject, topic, data) {
    let info;
    try {
      info = JSON.parse(data);
    } catch {
      return;
    }
    if (info.id != this.id || info.source == this.source) {
      return;
    }
    const easel = await gWhimsyEaselStore.get(this.id);
    if (!easel) {
      return;
    }
    if (easel.title != this.title && document.activeElement != $("easel-title")) {
      this.title = easel.title;
      this.updateTitle();
    }
    if (JSON.stringify(easel.items) == JSON.stringify(this.items)) {
      return;
    }
    const known = new Set(this.items.map(i => i.id));
    const added = easel.items.filter(i => !known.has(i.id));
    this.history.push(this.items);
    this.items = M.clone(easel.items);
    await this.loadImages(added);
    this.renderAll();
    if (added.length) {
      this.select(added.map(i => i.id));
      this.reveal(M.boundsOf(added));
      this.announce("whimsy-easel-status-added", { count: added.length });
    }
    this.updateChrome();
  }

  // ---------- Images ----------

  imageNames(items) {
    const names = new Set();
    for (const item of items) {
      if (item.type == "image" && item.src) names.add(item.src);
      if (item.type == "capture" && item.image) names.add(item.image);
    }
    return names;
  }

  async loadImages(items) {
    for (const name of this.imageNames(items)) {
      if (this.imageURLs.has(name)) {
        continue;
      }
      const bytes = await gWhimsyEaselStore.readImage(this.id, name);
      if (bytes) {
        const type = name.endsWith(".svg") ? "image/svg+xml" : name.endsWith(".jpg") ? "image/jpeg" : `image/${name.split(".").pop()}`;
        this.imageURLs.set(name, URL.createObjectURL(new Blob([bytes], { type })));
      }
    }
  }

  // ---------- View ----------

  applyView() {
    const { x, y, zoom } = this.view;
    $("world").style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    const viewport = $("viewport");
    const dot = 24 * zoom;
    viewport.style.setProperty("--dot-size", `${dot}px`);
    viewport.style.setProperty("--dot-x", `${x % dot}px`);
    viewport.style.setProperty("--dot-y", `${y % dot}px`);
    const reset = $("zoom-reset");
    const percent = Math.round(zoom * 100);
    reset.textContent = `${percent}%`;
    document.l10n.setAttributes(reset, "whimsy-easel-zoom-reset", { percent });
    this.updateOverlay();
    clearTimeout(this.#viewTimer);
    this.#viewTimer = setTimeout(() => this.saveView(), 600);
  }

  saveView() {
    if (this.id) {
      gWhimsyEaselStore.update(this.id, { view: { ...this.view } }, this.source);
    }
  }

  toWorld(clientX, clientY) {
    const rect = $("viewport").getBoundingClientRect();
    return { x: (clientX - rect.left - this.view.x) / this.view.zoom, y: (clientY - rect.top - this.view.y) / this.view.zoom };
  }

  toScreen(box) {
    const { x, y, zoom } = this.view;
    return { x: box.x * zoom + x, y: box.y * zoom + y, w: box.w * zoom, h: box.h * zoom };
  }

  get viewCenter() {
    const rect = $("viewport").getBoundingClientRect();
    return this.toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  zoomAt(zoom, clientX, clientY, { animate = false } = {}) {
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    const rect = $("viewport").getBoundingClientRect();
    const cx = clientX ?? rect.left + rect.width / 2;
    const cy = clientY ?? rect.top + rect.height / 2;
    const world = this.toWorld(cx, cy);
    const target = { zoom, x: cx - rect.left - world.x * zoom, y: cy - rect.top - world.y * zoom };
    this.setView(target, { animate });
  }

  zoomStep(direction) {
    const steps = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
    const z = this.view.zoom;
    const next = direction > 0 ? steps.find(s => s > z + 0.001) ?? MAX_ZOOM : [...steps].reverse().find(s => s < z - 0.001) ?? MIN_ZOOM;
    this.zoomAt(next, null, null, { animate: true });
  }

  fit({ animate = true } = {}) {
    const bounds = M.boundsOf(this.items);
    const rect = $("viewport").getBoundingClientRect();
    if (!bounds) {
      this.setView({ x: VIEW_MARGIN, y: VIEW_MARGIN, zoom: 1 }, { animate });
      return;
    }
    const zoom = Math.min(1, Math.max(MIN_ZOOM, Math.min((rect.width - 2 * VIEW_MARGIN) / bounds.w, (rect.height - 2 * VIEW_MARGIN - 40) / bounds.h)));
    this.setView(
      { zoom, x: rect.width / 2 - (bounds.x + bounds.w / 2) * zoom, y: rect.height / 2 - (bounds.y + bounds.h / 2) * zoom },
      { animate }
    );
  }

  // Pans just enough to show a box (new captures, keyboard selection).
  reveal(box) {
    if (!box) {
      return;
    }
    const rect = $("viewport").getBoundingClientRect();
    const s = this.toScreen(box);
    const margin = 80;
    let { x, y } = this.view;
    if (s.x < margin) x += margin - s.x;
    else if (s.x + s.w > rect.width - margin) x -= Math.min(s.x - margin, s.x + s.w - (rect.width - margin));
    if (s.y < margin) y += margin - s.y;
    else if (s.y + s.h > rect.height - margin) y -= Math.min(s.y - margin, s.y + s.h - (rect.height - margin));
    if (x != this.view.x || y != this.view.y) {
      this.setView({ ...this.view, x, y }, { animate: true });
    }
  }

  // Animates on the frame clock so the selection overlay tracks every frame
  // and a new gesture can interrupt it from wherever it is.
  setView(target, { animate = false } = {}) {
    cancelAnimationFrame(this.#viewAnimation);
    if (!animate || reducedMotion()) {
      this.view = target;
      this.applyView();
      return;
    }
    const from = { ...this.view };
    const start = performance.now();
    const duration = 320;
    const ease = t => 1 - Math.pow(1 - t, 4);
    const step = now => {
      const t = Math.min(1, (now - start) / duration);
      const k = ease(t);
      this.view = {
        x: from.x + (target.x - from.x) * k,
        y: from.y + (target.y - from.y) * k,
        zoom: from.zoom + (target.zoom - from.zoom) * k,
      };
      this.applyView();
      if (t < 1) {
        this.#viewAnimation = requestAnimationFrame(step);
      }
    };
    this.#viewAnimation = requestAnimationFrame(step);
  }

  // ---------- Rendering ----------

  renderAll() {
    const ids = new Set(this.items.map(i => i.id));
    for (const [id, el] of this.els) {
      if (!ids.has(id)) {
        this.#liveObserver?.unobserve(el);
        el.remove();
        this.els.delete(id);
      }
    }
    this.items.forEach((item, index) => this.renderItem(item, index));
    for (const id of [...this.selection]) {
      if (!ids.has(id)) this.selection.delete(id);
    }
    $("empty").hidden = this.items.length > 0;
    this.updateOverlay();
  }

  renderItem(item, index = this.items.indexOf(item)) {
    let el = this.els.get(item.id);
    if (!el || el.dataset.type != item.type) {
      el?.remove();
      el = document.createElement("div");
      el.className = "item";
      el.dataset.id = item.id;
      el.dataset.type = item.type;
      $("world").append(el);
      this.els.set(item.id, el);
    }
    // Stacking order is z-index, never DOM order: moving a live capture's
    // <browser> in the DOM would reload its page.
    el.style.zIndex = String(index + 1);
    this.position(item, el);
    el.classList.toggle("selected", this.selection.has(item.id));
    switch (item.type) {
      case "text":
        this.renderText(item, el);
        break;
      case "pen":
        this.renderPen(item, el);
        break;
      case "shape":
        this.renderShape(item, el);
        break;
      case "image":
        this.renderImage(item, el);
        break;
      case "capture":
        this.renderCapture(item, el);
        break;
      case "link":
        this.renderLink(item, el);
        break;
    }
    return el;
  }

  position(item, el = this.els.get(item.id)) {
    if (!el) return;
    el.style.transform = `translate(${item.x}px, ${item.y}px)`;
    if (item.type == "text" && item.auto) {
      el.style.width = el.style.height = "";
    } else if (item.type == "text") {
      el.style.width = `${item.w}px`;
      el.style.height = "";
    } else {
      el.style.width = `${item.w}px`;
      el.style.height = `${item.h}px`;
    }
  }

  renderText(item, el) {
    let text = el.querySelector(".text");
    if (!text) {
      text = document.createElement("div");
      text.className = "text";
      text.dataset.placeholder = this.#textPlaceholder;
      text.addEventListener("input", () => this.onTextInput(item.id));
      text.addEventListener("blur", () => {
        // The window losing focus blurs the text too, but it stays the
        // document's focused element: keep editing then.
        if (document.activeElement == text) return;
        this.stopEditing();
      });
      el.append(text);
    }
    el.classList.toggle("auto", !!item.auto);
    el.classList.toggle("editing", this.editingId == item.id);
    text.style.font = M.textFont(item);
    text.style.lineHeight = String(M.TEXT_LINE_HEIGHT);
    text.style.color = M.colorValue(item.color, isDark());
    text.style.setProperty("--ink", item.color);
    if (this.editingId != item.id && text.textContent != item.text) {
      text.textContent = item.text;
    }
  }

  // Text keeps its own box: measure it after layout.
  measureText(item) {
    const el = this.els.get(item.id);
    if (!el) return;
    const text = el.querySelector(".text");
    if (item.auto) {
      item.w = Math.max(8, Math.ceil(text.offsetWidth));
    }
    item.h = Math.max(item.size * M.TEXT_LINE_HEIGHT, Math.ceil(text.offsetHeight));
  }

  renderPen(item, el) {
    let svg = el.querySelector("svg");
    if (!svg) {
      svg = svgEl("svg", { preserveAspectRatio: "none" });
      svg.append(svgEl("path", { class: "hit" }), svgEl("path", { class: "ink" }));
      el.append(svg);
    }
    el.classList.toggle("highlighter", !!item.highlighter);
    svg.setAttribute("viewBox", `0 0 ${item.vw} ${item.vh}`);
    const [hit, ink] = svg.children;
    for (const path of [hit, ink]) {
      path.setAttribute("d", item.d);
      path.setAttribute("vector-effect", "non-scaling-stroke");
    }
    hit.setAttribute("stroke-width", String(Math.max(14, item.width + 10)));
    ink.setAttribute("stroke", M.colorValue(item.color, isDark()));
    ink.setAttribute("stroke-width", String(item.width));
  }

  renderShape(item, el) {
    let svg = el.querySelector("svg");
    if (!svg) {
      svg = svgEl("svg");
      el.append(svg);
    }
    svg.replaceChildren();
    const color = M.colorValue(item.color, isDark());
    const line = item.shape == "line" || item.shape == "arrow";
    el.classList.toggle("shape-line", line);
    el.classList.toggle("shape-hollow", !line && !item.fill);
    el.classList.toggle("shape-filled", !line && !!item.fill);
    svg.setAttribute("viewBox", `0 0 ${item.w} ${item.h}`);
    const stroke = { stroke: color, "stroke-width": item.width, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" };
    const hitWidth = Math.max(14, item.width + 10);
    if (line) {
      const [x1, y1, x2, y2] = M.lineEnds(item);
      let d = `M${x1} ${y1}L${x2} ${y2}`;
      if (item.shape == "arrow") {
        const [a, b] = M.arrowHead(x1, y1, x2, y2, item.width);
        d += `M${a[0]} ${a[1]}L${x2} ${y2}L${b[0]} ${b[1]}`;
      }
      svg.append(svgEl("path", { d, class: "hit", "stroke-width": hitWidth }), svgEl("path", { d, ...stroke }));
      return;
    }
    const inset = item.width / 2;
    const geometry =
      item.shape == "ellipse"
        ? ["ellipse", { cx: item.w / 2, cy: item.h / 2, rx: Math.max(0, item.w / 2 - inset), ry: Math.max(0, item.h / 2 - inset) }]
        : ["rect", { x: inset, y: inset, width: Math.max(0, item.w - item.width), height: Math.max(0, item.h - item.width), rx: 8 }];
    if (!item.fill) {
      svg.append(svgEl(geometry[0], { ...geometry[1], class: "hit", "stroke-width": hitWidth }));
    }
    const shape = svgEl(geometry[0], { ...geometry[1], ...stroke });
    if (item.fill) {
      shape.setAttribute("fill", color);
      shape.setAttribute("fill-opacity", item.fill == "tint" ? "0.18" : "1");
    }
    svg.append(shape);
  }

  renderImage(item, el) {
    let img = el.querySelector("img");
    if (!img) {
      img = document.createElement("img");
      img.alt = "";
      img.draggable = false;
      el.append(img);
    }
    const url = this.imageURLs.get(item.src);
    if (url && img.getAttribute("src") != url) img.src = url;
  }

  renderCapture(item, el) {
    if (!el.firstChild) {
      const img = document.createElement("img");
      img.alt = "";
      img.draggable = false;
      const shield = document.createElement("div");
      shield.className = "capture-shield";
      const badge = document.createElement("div");
      badge.className = "capture-badge";
      const dot = document.createElement("span");
      dot.className = "live-dot";
      const label = document.createElement("span");
      badge.append(dot, label);
      el.append(img, shield, badge);
    }
    const [img, , badge] = [el.querySelector("img"), null, el.querySelector(".capture-badge")];
    const url = this.imageURLs.get(item.image);
    if (url && img.getAttribute("src") != url) img.src = url;
    badge.lastChild.textContent = hostOf(item.url) || item.title || "";
    el.title = item.title || "";
    el.classList.toggle("live", !!item.live);
    el.classList.toggle("active", this.activeId == item.id);
    this.updateLive(item, el);
  }

  renderLink(item, el) {
    if (!el.firstChild) {
      const icon = document.createElement("img");
      icon.alt = "";
      icon.draggable = false;
      const text = document.createElement("div");
      text.className = "link-text";
      const title = document.createElement("span");
      title.className = "link-title";
      const host = document.createElement("span");
      host.className = "link-host";
      text.append(title, host);
      el.append(icon, text);
    }
    const icon = el.querySelector("img");
    const src = `page-icon:${item.url}`;
    if (icon.getAttribute("src") != src) {
      icon.src = src;
      icon.onerror = () => (icon.src = "chrome://global/skin/icons/defaultFavicon.svg");
    }
    el.querySelector(".link-title").textContent = item.title || hostOf(item.url);
    el.querySelector(".link-host").textContent = hostOf(item.url);
    el.title = item.url;
  }

  // ---------- Live captures ----------

  updateLive(item, el) {
    const wantLive = item.live && item.url && !this.isPrivate;
    const stage = el.querySelector(".capture-stage");
    let note = el.querySelector(".capture-note");
    if (item.live && this.isPrivate) {
      if (!note) {
        note = document.createElement("div");
        note.className = "capture-note";
        document.l10n.setAttributes(note, "whimsy-easel-live-private");
        el.append(note);
      }
    } else {
      note?.remove();
    }
    if (!wantLive) {
      if (stage) {
        stage.remove();
      }
      this.#liveObserver?.unobserve(el);
      if (this.activeId == item.id) {
        this.activeId = null;
      }
      return;
    }
    if (stage) {
      this.layoutStage(item, stage);
      return;
    }
    // Load only once it's on screen (and again every time the easel opens).
    // On screen already (Play, a capture in view): load now rather than
    // wait for the observer's first callback.
    if (this.#started && this.isOnScreen(el)) {
      this.#liveObserver?.unobserve(el);
      this.startLive(item, el);
      return;
    }
    this.#liveObserver?.observe(el);
  }

  isOnScreen(el) {
    const view = $("viewport").getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.right > view.left && box.left < view.right && box.bottom > view.top && box.top < view.bottom;
  }

  onLiveVisible(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      this.#liveObserver.unobserve(el);
      const item = this.find(el.dataset.id);
      if (item?.live && !el.querySelector(".capture-stage")) {
        this.startLive(item, el);
      }
    }
  }

  startLive(item, el) {
    const stage = document.createElement("div");
    stage.className = "capture-stage";
    el.querySelector(".capture-shield").before(stage);
    this.layoutStage(item, stage);
    const url = item.url;
    const userContextId = item.userContextId || 0;
    const browser = createLiveBrowser(stage, {
      url,
      userContextId,
      className: "capture-browser",
      group: "whimsy-easel",
    });
    // The static capture stays underneath until the page has drawn.
    const ready = () => stage.classList.add("ready");
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
      onStateChange(webProgress, request, flags) {
        if (flags & Ci.nsIWebProgressListener.STATE_STOP && flags & Ci.nsIWebProgressListener.STATE_IS_WINDOW) {
          setTimeout(ready, 150);
        }
      },
    };
    stage._listener = listener;
    const listen = () => {
      try {
        browser.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_STATE_WINDOW);
      } catch {}
    };
    listen();
    // Loading the page usually moves it to its site's process, which gives
    // the <browser> a new browsing context and web progress: listen again
    // there, or the stage never hears that the page drew.
    browser.addEventListener("DidChangeBrowserRemoteness", listen);
    // A frame loader made again (the element re-bound) starts on
    // about:blank and forgets the page; load the capture's page again.
    browser.addEventListener("XULFrameLoaderCreated", () => {
      Promise.resolve().then(() => {
        if (browser.isConnected && (browser.currentURI?.spec ?? "about:blank") == "about:blank") {
          reloadLiveBrowser(browser, url, userContextId);
          listen();
        }
      });
    });
    setTimeout(ready, 3000);
    return browser;
  }

  layoutStage(item, stage) {
    const crop = item.crop ?? { x: 0, y: 0, w: item.pageWidth || 1280, h: item.pageHeight || 800 };
    const pageWidth = item.pageWidth || 1280;
    const pageHeight = Math.max(item.pageHeight || 800, crop.y + crop.h);
    const scale = item.w / crop.w;
    stage.style.width = `${pageWidth}px`;
    stage.style.height = `${pageHeight}px`;
    stage.style.transform = `scale(${scale}) translate(${-crop.x}px, ${-crop.y}px)`;
  }

  refreshLive() {
    let count = 0;
    for (const el of this.els.values()) {
      const browser = el.querySelector(".capture-browser");
      if (browser) {
        browser.reload();
        count++;
      }
    }
    this.announce("whimsy-easel-status-refreshed", { count });
  }

  setLive(item, live) {
    if (!item?.url || item.type != "capture") return;
    this.change(() => {
      item.live = live;
    });
    if (live) {
      this.activate(item.id);
    }
    this.announce(live ? "whimsy-easel-status-live-on" : "whimsy-easel-status-live-off");
  }

  // A live capture takes the pointer once entered (double-click or Play).
  activate(id) {
    if (this.activeId == id) return;
    const previous = this.activeId;
    this.activeId = id;
    for (const otherId of [previous, id]) {
      const el = otherId && this.els.get(otherId);
      el?.classList.toggle("active", this.activeId == otherId);
    }
  }

  // ---------- Selection ----------

  select(ids, { add = false } = {}) {
    if (!add) this.selection.clear();
    for (const id of ids) this.selection.add(id);
    if (this.activeId && !this.selection.has(this.activeId)) this.activate(null);
    for (const [id, el] of this.els) {
      el.classList.toggle("selected", this.selection.has(id));
    }
    this.updateChrome();
  }

  clearSelection() {
    if (this.editingId) this.stopEditing();
    this.select([]);
  }

  updateOverlay() {
    const box = $("selection");
    const items = this.selectedItems;
    $("guides").replaceChildren();
    if (!items.length) {
      box.hidden = true;
      this.updateContextBar();
      return;
    }
    const bounds = M.boundsOf(items);
    const s = this.toScreen(bounds);
    box.hidden = false;
    Object.assign(box.style, { transform: `translate(${s.x}px, ${s.y}px)`, width: `${s.w}px`, height: `${s.h}px` });
    const single = items.length == 1 ? items[0] : null;
    const line = single?.type == "shape" && (single.shape == "line" || single.shape == "arrow");
    box.classList.toggle("line", line);
    box.classList.toggle("text-only", single?.type == "text");
    box.classList.toggle("no-resize", !!this.editingId);
    for (const handle of box.querySelectorAll(".handle")) {
      handle.style.left = handle.style.top = "";
    }
    if (line) {
      const [x1, y1, x2, y2] = M.lineEnds(single);
      const nw = box.querySelector('[data-handle="nw"]');
      const se = box.querySelector('[data-handle="se"]');
      Object.assign(nw.style, { left: `${x1 * this.view.zoom}px`, top: `${y1 * this.view.zoom}px` });
      Object.assign(se.style, { left: `${x2 * this.view.zoom}px`, top: `${y2 * this.view.zoom}px` });
      box.style.borderColor = "transparent";
    } else {
      box.style.borderColor = "";
    }
    this.updateContextBar();
  }

  showGuides(guides) {
    const layer = $("guides");
    layer.replaceChildren();
    for (const g of guides) {
      const el = document.createElement("div");
      el.className = `guide ${g.axis}`;
      if (g.axis == "x") {
        const top = this.toScreen({ x: g.at, y: g.from, w: 0, h: g.to - g.from });
        Object.assign(el.style, { left: `${top.x}px`, top: `${top.y}px`, height: `${top.h}px` });
      } else {
        const left = this.toScreen({ x: g.from, y: g.at, w: g.to - g.from, h: 0 });
        Object.assign(el.style, { left: `${left.x}px`, top: `${left.y}px`, width: `${left.w}px` });
      }
      layer.append(el);
    }
  }

  // ---------- Changes, undo, saving ----------

  // Runs a mutation as one undo step, then re-renders and saves.
  change(mutate, { render = true } = {}) {
    const before = M.clone(this.items);
    mutate();
    if (JSON.stringify(before) == JSON.stringify(this.items)) {
      return false;
    }
    this.history.push(before);
    if (render) this.renderAll();
    this.saveSoon();
    this.updateChrome();
    return true;
  }

  // Records an undo step for a change already applied (drags).
  commit(before) {
    if (JSON.stringify(before) == JSON.stringify(this.items)) {
      return false;
    }
    this.history.push(before);
    this.saveSoon();
    this.updateChrome();
    return true;
  }

  undo() {
    this.stopEditing();
    const items = this.history.undo(this.items);
    if (!items) return;
    this.restore(items);
    this.announce("whimsy-easel-status-undo");
  }

  redo() {
    this.stopEditing();
    const items = this.history.redo(this.items);
    if (!items) return;
    this.restore(items);
    this.announce("whimsy-easel-status-redo");
  }

  async restore(items) {
    this.items = items;
    await this.loadImages(items);
    this.renderAll();
    this.saveSoon();
    this.updateChrome();
  }

  saveSoon() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    if (!this.id) return null;
    return gWhimsyEaselStore.update(this.id, { items: M.clone(this.items), title: this.title }, this.source);
  }

  updateTitle() {
    const input = $("easel-title");
    if (input.value != this.title) input.value = this.title;
    document.title = this.title || this.#untitled;
  }

  // ---------- Item factories ----------

  addItems(items, { select = true } = {}) {
    this.change(() => {
      this.items.push(...items);
    });
    if (select) {
      this.select(items.map(i => i.id));
      this.reveal(M.boundsOf(items));
    }
    this.announce("whimsy-easel-status-added", { count: items.length });
  }

  textItem(x, y, text = "") {
    const size = M.TEXT_SIZES[this.size];
    return { id: M.newItemId(), type: "text", x, y, w: 8, h: size * M.TEXT_LINE_HEIGHT, text, font: this.font, size, color: this.color, auto: true };
  }

  linkItem(url, title, at) {
    return { id: M.newItemId(), type: "link", x: at.x, y: at.y, ...M.LINK_SIZE, url, title: title || "" };
  }

  async imageItem(bytes, type, at) {
    const name = await gWhimsyEaselStore.saveImage(this.id, bytes, type);
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    this.imageURLs.set(name, url);
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      return null;
    }
    const natural = { w: img.naturalWidth || 320, h: img.naturalHeight || 240 };
    const w = Math.min(480, natural.w);
    const h = (natural.h * w) / natural.w;
    return { id: M.newItemId(), type: "image", x: at.x - w / 2, y: at.y - h / 2, w, h, src: name };
  }

  // ---------- Text editing ----------

  startEditing(id, { caretAtEnd = true } = {}) {
    const item = this.find(id);
    const el = this.els.get(id);
    if (!item || item.type != "text" || !el) return;
    this.editingId = id;
    this.#drag = { kind: "text-session", before: this.#drag?.before ?? M.clone(this.items) };
    this.select([id]);
    el.classList.add("editing");
    const text = el.querySelector(".text");
    text.contentEditable = "plaintext-only";
    text.focus();
    if (caretAtEnd) {
      const range = document.createRange();
      range.selectNodeContents(text);
      range.collapse(false);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    this.updateOverlay();
  }

  onTextInput(id) {
    const item = this.find(id);
    const el = this.els.get(id);
    if (!item || !el) return;
    item.text = el.querySelector(".text").textContent;
    this.measureText(item);
    this.updateOverlay();
  }

  stopEditing() {
    const id = this.editingId;
    if (!id) return;
    this.editingId = null;
    const before = this.#drag?.kind == "text-session" ? this.#drag.before : null;
    this.#drag = null;
    const el = this.els.get(id);
    const text = el?.querySelector(".text");
    if (text) {
      text.contentEditable = "false";
      el.classList.remove("editing");
    }
    const item = this.find(id);
    if (item && !item.text.trim()) {
      // An empty text box disappears, with no undo step of its own.
      this.items = this.items.filter(i => i.id != id);
      this.selection.delete(id);
      this.renderAll();
    } else if (item) {
      this.measureText(item);
    }
    if (before) this.commit(before);
    this.renderAll();
    this.updateChrome();
    if (document.activeElement == text || document.activeElement == document.body) {
      $("viewport").focus({ preventScroll: true });
    }
  }

  // ---------- Pointer input ----------

  onPointerDown(event) {
    const viewport = $("viewport");
    this.#suppressMouseDown = false;
    if (event.target.closest("#toolbar, #contextbar, #topbar, #share-menu")) return;
    this.#pointer = { x: event.clientX, y: event.clientY };
    if (this.editingId && event.target.closest(".item")?.dataset.id == this.editingId) {
      return; // caret placement inside the text being edited
    }
    if (this.editingId) this.stopEditing();
    // Every press the canvas handles itself: no compat mousedown default
    // (it would move focus and start a text selection; see the text tool).
    this.#suppressMouseDown = event.button == 0 || event.button == 1;
    if (event.button == 1 || (event.button == 0 && this.#space)) {
      this.startPan(event);
      return;
    }
    if (event.button != 0) return;
    viewport.focus({ preventScroll: true });
    const handle = event.target.closest(".handle");
    if (handle) {
      this.startResize(event, handle.dataset.handle);
      return;
    }
    const itemEl = event.target.closest(".item");
    const world = this.toWorld(event.clientX, event.clientY);
    if (this.activeId && itemEl?.dataset.id != this.activeId) this.activate(null);
    switch (this.tool) {
      case "text": {
        // Typing starts on release. This page is privileged, and Gecko only
        // lets a *content* preventDefault() on pointerdown suppress the
        // mousedown that follows; so that mousedown still runs its default
        // action, focuses the viewport and blurs a text box focused here,
        // which then disappears because it's empty. So: no mousedown default
        // for this press, and the caret goes in once the press is over.
        event.preventDefault();
        if (itemEl?.dataset.type == "text") {
          this.#drag = { kind: "text-pending", id: itemEl.dataset.id, before: null };
          return;
        }
        const size = M.TEXT_SIZES[this.size];
        const item = this.textItem(world.x, world.y - (size * M.TEXT_LINE_HEIGHT) / 2);
        const before = M.clone(this.items);
        this.items.push(item);
        this.renderAll();
        this.select([item.id]);
        this.#drag = { kind: "text-pending", id: item.id, before };
        return;
      }
      case "pen":
      case "highlighter":
        this.startStroke(event, world);
        return;
      default:
        if (SHAPE_TOOLS.has(this.tool)) {
          this.startShape(event, world);
          return;
        }
    }
    if (itemEl) {
      const id = itemEl.dataset.id;
      if (event.shiftKey) {
        const ids = new Set(this.selection);
        ids.has(id) ? ids.delete(id) : ids.add(id);
        this.select([...ids]);
        if (!ids.has(id)) return;
      } else if (!this.selection.has(id)) {
        this.select([id]);
      }
      this.startMove(event);
      return;
    }
    this.startMarquee(event, world);
  }

  capture(event, drag) {
    this.#drag = drag;
    try {
      $("viewport").setPointerCapture(event.pointerId);
    } catch {}
  }

  startPan(event) {
    event.preventDefault();
    $("viewport").dataset.panning = "active";
    this.capture(event, { kind: "pan", sx: event.clientX, sy: event.clientY, view: { ...this.view } });
  }

  startMove(event) {
    const items = this.selectedItems;
    this.capture(event, {
      kind: "move",
      sx: event.clientX,
      sy: event.clientY,
      moved: false,
      before: M.clone(this.items),
      start: new Map(items.map(i => [i.id, { x: i.x, y: i.y }])),
      bounds: M.boundsOf(items),
      others: this.items.filter(i => !this.selection.has(i.id)),
    });
  }

  startResize(event, handle) {
    event.preventDefault();
    event.stopPropagation();
    const items = this.selectedItems;
    this.capture(event, {
      kind: "resize",
      handle,
      sx: event.clientX,
      sy: event.clientY,
      before: M.clone(this.items),
      start: new Map(items.map(i => [i.id, M.clone(i)])),
      bounds: M.boundsOf(items),
      others: this.items.filter(i => !this.selection.has(i.id)),
    });
  }

  startMarquee(event, world) {
    this.capture(event, { kind: "marquee", origin: world, add: event.shiftKey, base: new Set(event.shiftKey ? this.selection : []) });
    if (!event.shiftKey) this.select([]);
  }

  startStroke(event, world) {
    event.preventDefault();
    const highlighter = this.tool == "highlighter";
    const width = M.STROKE_WIDTHS[this.size] * (highlighter ? M.HIGHLIGHTER_SCALE : 1);
    const color = highlighter && this.color == "ink" ? "yellow" : this.color;
    const preview = svgEl("svg", { class: "preview" });
    Object.assign(preview.style, { position: "absolute", left: 0, top: 0, overflow: "visible", width: "1px", height: "1px", zIndex: String(this.items.length + 2) });
    const path = svgEl("path", { stroke: M.colorValue(color, isDark()), "stroke-width": width, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" });
    if (highlighter) {
      path.style.opacity = "0.4";
      path.style.mixBlendMode = isDark() ? "screen" : "multiply";
    }
    preview.append(path);
    $("world").append(preview);
    this.capture(event, { kind: "stroke", points: [[world.x, world.y]], preview, path, width, color, highlighter });
  }

  startShape(event, world) {
    event.preventDefault();
    const item = {
      id: M.newItemId(),
      type: "shape",
      shape: this.tool,
      x: world.x,
      y: world.y,
      w: 1,
      h: 1,
      color: this.color,
      width: M.STROKE_WIDTHS[this.size],
      fill: null,
    };
    const before = M.clone(this.items);
    this.items.push(item);
    this.renderAll();
    this.capture(event, { kind: "shape", item, origin: world, before });
  }

  onPointerMove(event) {
    const drag = this.#drag;
    if (!drag || drag.kind == "text-session" || drag.kind == "text-pending") return;
    switch (drag.kind) {
      case "pan":
        this.view = { ...drag.view, x: drag.view.x + event.clientX - drag.sx, y: drag.view.y + event.clientY - drag.sy };
        this.applyView();
        break;
      case "move": {
        const dxs = event.clientX - drag.sx;
        const dys = event.clientY - drag.sy;
        if (!drag.moved && Math.hypot(dxs, dys) < DRAG_THRESHOLD) return;
        drag.moved = true;
        let dx = dxs / this.view.zoom;
        let dy = dys / this.view.zoom;
        let guides = [];
        if (!event.altKey && drag.others.length) {
          const snapped = M.snapMove({ ...drag.bounds, x: drag.bounds.x + dx, y: drag.bounds.y + dy }, drag.others, SNAP_PX / this.view.zoom);
          dx += snapped.dx;
          dy += snapped.dy;
          guides = snapped.guides;
        }
        for (const item of this.selectedItems) {
          const start = drag.start.get(item.id);
          item.x = start.x + dx;
          item.y = start.y + dy;
          this.position(item);
        }
        this.updateOverlay();
        this.showGuides(guides);
        break;
      }
      case "resize":
        this.resizeTo(drag, event);
        break;
      case "marquee": {
        const world = this.toWorld(event.clientX, event.clientY);
        const rect = M.rectFromPoints(drag.origin, world);
        const s = this.toScreen(rect);
        const marquee = $("marquee");
        marquee.hidden = false;
        Object.assign(marquee.style, { transform: `translate(${s.x}px, ${s.y}px)`, width: `${s.w}px`, height: `${s.h}px` });
        const ids = new Set(drag.base);
        for (const item of this.items) {
          if (M.intersects(rect, item)) ids.add(item.id);
        }
        this.select([...ids]);
        break;
      }
      case "stroke": {
        const events = event.getCoalescedEvents?.() ?? [event];
        for (const e of events) {
          const p = this.toWorld(e.clientX, e.clientY);
          const last = drag.points.at(-1);
          if (Math.hypot(p.x - last[0], p.y - last[1]) * this.view.zoom >= 1.5) {
            drag.points.push([p.x, p.y]);
          }
        }
        drag.path.setAttribute("d", M.smoothPath(drag.points));
        break;
      }
      case "shape": {
        const world = this.toWorld(event.clientX, event.clientY);
        this.shapeTo(drag, world, event.shiftKey);
        break;
      }
    }
  }

  shapeTo(drag, world, constrain) {
    const { item, origin } = drag;
    let dx = world.x - origin.x;
    let dy = world.y - origin.y;
    if (constrain) {
      if (item.shape == "line" || item.shape == "arrow") {
        // Snap to 45° steps.
        const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const length = Math.hypot(dx, dy);
        dx = Math.cos(angle) * length;
        dy = Math.sin(angle) * length;
      } else {
        const side = Math.max(Math.abs(dx), Math.abs(dy));
        dx = Math.sign(dx || 1) * side;
        dy = Math.sign(dy || 1) * side;
      }
    }
    Object.assign(item, {
      x: Math.min(origin.x, origin.x + dx),
      y: Math.min(origin.y, origin.y + dy),
      w: Math.max(1, Math.abs(dx)),
      h: Math.max(1, Math.abs(dy)),
      flipX: dx < 0,
      flipY: dy < 0,
    });
    this.renderItem(item);
  }

  resizeTo(drag, event) {
    let dx = (event.clientX - drag.sx) / this.view.zoom;
    let dy = (event.clientY - drag.sy) / this.view.zoom;
    const items = this.selectedItems;
    // wave7: the moving edges snap to other items' edges and centres, like
    // moving does (Option turns it off). Line ends don't snap.
    let guides = [];
    const single = items.length == 1 ? items[0] : null;
    const line = single?.type == "shape" && (single.shape == "line" || single.shape == "arrow");
    if (!event.altKey && !line && drag.others?.length) {
      const base = single ? drag.start.get(single.id) : drag.bounds;
      const rect = M.resizeRect(base, drag.handle, dx, single?.type == "text" ? 0 : dy);
      const snapped = M.snapResize(rect, drag.handle, drag.others, SNAP_PX / this.view.zoom);
      dx += snapped.dx;
      dy += single?.type == "text" ? 0 : snapped.dy;
      guides = snapped.guides.filter(g => single?.type != "text" || g.axis == "x");
    }
    if (items.length == 1) {
      const item = items[0];
      const start = drag.start.get(item.id);
      if (item.type == "shape" && (item.shape == "line" || item.shape == "arrow")) {
        // The two handles are the line's ends.
        const [x1, y1, x2, y2] = M.lineEnds(start);
        let a = { x: start.x + x1, y: start.y + y1 };
        let b = { x: start.x + x2, y: start.y + y2 };
        if (drag.handle == "nw") a = { x: a.x + dx, y: a.y + dy };
        else b = { x: b.x + dx, y: b.y + dy };
        Object.assign(item, {
          x: Math.min(a.x, b.x),
          y: Math.min(a.y, b.y),
          w: Math.max(1, Math.abs(b.x - a.x)),
          h: Math.max(1, Math.abs(b.y - a.y)),
          flipX: b.x < a.x,
          flipY: b.y < a.y,
        });
      } else if (item.type == "text") {
        const r = M.resizeRect(start, drag.handle, dx, 0, { min: 24 });
        Object.assign(item, { x: r.x, w: r.w, auto: false });
        this.renderItem(item);
        this.measureText(item);
      } else {
        const keepAspect = item.type == "image" || item.type == "capture" || item.type == "link" ? !event.shiftKey : event.shiftKey;
        const r = M.resizeRect(start, drag.handle, dx, dy, { keepAspect: keepAspect && item.type != "link" });
        Object.assign(item, { x: r.x, y: r.y, w: r.w, h: r.h });
        if (item.type == "link") item.h = Math.max(56, Math.min(item.h, 120));
      }
      this.renderItem(item);
    } else {
      const r = M.resizeRect(drag.bounds, drag.handle, dx, dy, { keepAspect: !event.shiftKey });
      for (const item of items) {
        const start = drag.start.get(item.id);
        const mapped = M.mapRect(start, drag.bounds, r);
        Object.assign(item, mapped);
        if (item.type == "text") {
          item.size = Math.max(6, start.size * (r.w / drag.bounds.w));
          if (!start.auto) item.w = mapped.w;
        }
        this.renderItem(item);
        if (item.type == "text") this.measureText(item);
      }
    }
    this.updateOverlay();
    this.showGuides(guides);
  }

  onPointerUp(event) {
    const drag = this.#drag;
    if (drag?.kind == "text-pending") {
      this.#drag = drag.before ? { kind: "text-session", before: drag.before } : null;
      this.startEditing(drag.id);
      return;
    }
    if (!drag || drag.kind == "text-session") return;
    this.#drag = null;
    try {
      $("viewport").releasePointerCapture(event.pointerId);
    } catch {}
    $("guides").replaceChildren();
    switch (drag.kind) {
      case "pan":
        $("viewport").dataset.panning = this.#space ? "ready" : "";
        if (!this.#space) delete $("viewport").dataset.panning;
        break;
      case "move":
      case "resize":
        if (drag.kind == "move" && !drag.moved) break;
        this.commit(drag.before);
        this.renderAll();
        break;
      case "marquee":
        $("marquee").hidden = true;
        this.updateChrome();
        break;
      case "stroke": {
        drag.preview.remove();
        const geometry = M.strokeGeometry(drag.points, drag.width);
        const item = { id: M.newItemId(), type: "pen", ...geometry, color: drag.color, width: drag.width, highlighter: drag.highlighter };
        this.change(() => this.items.push(item));
        break;
      }
      case "shape": {
        const { item } = drag;
        if (item.w < 4 && item.h < 4) {
          // A click makes a default-sized shape.
          const line = item.shape == "line" || item.shape == "arrow";
          Object.assign(item, { w: line ? 160 : 140, h: line ? 1 : 96, flipX: false, flipY: false });
        }
        this.renderAll();
        this.commit(drag.before);
        this.select([item.id]);
        // Shapes are one-shot, like Arc: back to the pointer to adjust.
        this.setTool("select");
        break;
      }
    }
  }

  onDoubleClick(event) {
    const itemEl = event.target.closest(".item");
    if (!itemEl) {
      if (this.tool == "select" && !event.target.closest("#toolbar, #contextbar, #topbar")) {
        // Double-click the canvas to write there.
        const world = this.toWorld(event.clientX, event.clientY);
        const size = M.TEXT_SIZES[this.size];
        const item = this.textItem(world.x, world.y - (size * M.TEXT_LINE_HEIGHT) / 2);
        this.#drag = { kind: "text-session", before: M.clone(this.items) };
        this.items.push(item);
        this.renderAll();
        this.startEditing(item.id);
      }
      return;
    }
    const item = this.find(itemEl.dataset.id);
    this.openItem(item);
  }

  // Enter / double-click: edit text, enter a live capture, open a link.
  openItem(item) {
    if (!item) return;
    switch (item.type) {
      case "text":
        this.startEditing(item.id);
        break;
      case "capture":
        if (!item.url) break;
        if (!item.live) this.setLive(item, true);
        else this.activate(item.id);
        break;
      case "link":
        this.openURL(item.url);
        break;
    }
  }

  openURL(url, userContextId = 0) {
    window.browsingContext.topChromeWindow?.openTrustedLinkIn(url, "tab", { userContextId });
  }

  onWheel(event) {
    if (event.target.closest("#toolbar, #contextbar, #topbar, #share-menu")) return;
    event.preventDefault();
    const unit = event.deltaMode == 1 ? 16 : event.deltaMode == 2 ? 400 : 1;
    if (event.ctrlKey || event.metaKey) {
      // Pinch (trackpads send Ctrl+wheel) and Cmd+scroll zoom at the pointer.
      this.zoomAt(this.view.zoom * Math.exp(-event.deltaY * unit * 0.01), event.clientX, event.clientY);
      return;
    }
    cancelAnimationFrame(this.#viewAnimation);
    let { deltaX, deltaY } = event;
    if (event.shiftKey && !deltaX) [deltaX, deltaY] = [deltaY, 0];
    this.view = { ...this.view, x: this.view.x - deltaX * unit, y: this.view.y - deltaY * unit };
    this.applyView();
  }

  // ---------- Keyboard ----------

  onKeyDown(event) {
    const accel = isMac ? event.metaKey : event.ctrlKey;
    const target = event.target;
    const inField = target.closest?.("input, textarea, [contenteditable='plaintext-only'], [contenteditable='true']");
    if (this.editingId) {
      if (event.key == "Escape" || (accel && event.key == "Enter")) {
        event.preventDefault();
        const id = this.editingId;
        this.stopEditing();
        if (this.find(id)) this.select([id]);
      }
      return;
    }
    if (target.closest?.("#share-menu")) return;
    if (inField) {
      if (target.id == "easel-title" && (event.key == "Enter" || event.key == "Escape")) {
        event.preventDefault();
        $("viewport").focus();
      }
      return;
    }
    const key = event.key.toLowerCase();
    // Shortcuts that work anywhere on the page.
    if (accel && !event.altKey) {
      if (key == "z") {
        event.preventDefault();
        event.shiftKey ? this.redo() : this.undo();
        return;
      }
      if (key == "y" && !isMac) {
        event.preventDefault();
        this.redo();
        return;
      }
      if (key == "r" && !event.shiftKey) {
        // Arc: Cmd+R refreshes every live capture.
        event.preventDefault();
        this.refreshLive();
        return;
      }
      if (key == "s" && event.shiftKey) {
        // Arc: Save As exports the easel.
        event.preventDefault();
        this.exportAs(isDark() ? "png-dark" : "png-light");
        return;
      }
      if (key == "=" || key == "+") {
        event.preventDefault();
        this.zoomStep(1);
        return;
      }
      if (key == "-") {
        event.preventDefault();
        this.zoomStep(-1);
        return;
      }
      if (key == "0") {
        event.preventDefault();
        this.zoomAt(1, null, null, { animate: true });
        return;
      }
    }
    if (target.closest?.("#toolbar, #contextbar, #topbar")) {
      this.onBarKey(event);
      return;
    }
    if (accel && !event.altKey) {
      switch (key) {
        // Clipboard commands are off in privileged pages when nothing is
        // editable, so the page handles Cmd+C/X/V itself.
        case "c":
        case "x":
          if (!this.selection.size) return;
          event.preventDefault();
          this.copySelection();
          if (key == "x") this.deleteSelection();
          return;
        case "v":
          event.preventDefault();
          this.pasteFromClipboard();
          return;
        case "a":
          event.preventDefault();
          this.select(this.items.map(i => i.id));
          this.announceSelection();
          return;
        case "d":
          event.preventDefault();
          this.duplicate();
          return;
        case "]":
          event.preventDefault();
          this.reorder(event.shiftKey ? "front" : "forward");
          return;
        case "[":
          event.preventDefault();
          this.reorder(event.shiftKey ? "back" : "backward");
          return;
      }
      return;
    }
    if (event.key == " " && !event.repeat) {
      this.#space = true;
      $("viewport").dataset.panning = "ready";
      event.preventDefault();
      return;
    }
    if (event.key == "!" || (event.shiftKey && event.code == "Digit1")) {
      event.preventDefault();
      this.fit();
      return;
    }
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        if (this.activeId) this.activate(null);
        else if (this.selection.size) this.select([]);
        else this.setTool("select");
        return;
      case "Delete":
      case "Backspace":
        if (this.selection.size) {
          event.preventDefault();
          this.deleteSelection();
        }
        return;
      case "Enter":
        event.preventDefault();
        if (this.item) {
          this.openItem(this.item);
        } else if (this.tool == "text" || SHAPE_TOOLS.has(this.tool)) {
          this.createAtCenter();
        }
        return;
      case "Tab":
        if (this.cycleSelection(event.shiftKey ? -1 : 1)) event.preventDefault();
        return;
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown":
        if (!this.selection.size) return;
        event.preventDefault();
        // Option+arrows resize, so sizing never needs a pointer.
        this.nudge(event.key, event.shiftKey ? 10 : 1, { resize: event.altKey });
        return;
    }
    if (!event.altKey && !event.shiftKey && TOOL_KEYS[key]) {
      event.preventDefault();
      this.setTool(TOOL_KEYS[key]);
    }
  }

  onKeyUp(event) {
    if (event.key == " ") {
      this.#space = false;
      if ($("viewport").dataset.panning != "active") delete $("viewport").dataset.panning;
    }
    if (event.key.startsWith("Arrow") && this.#nudge) {
      this.commit(this.#nudge);
      this.#nudge = null;
    }
  }

  // Arrow keys move the selection (Shift: 10px); a run of presses is one undo step.
  nudge(key, step, { resize = false } = {}) {
    this.#nudge ??= M.clone(this.items);
    const dx = key == "ArrowLeft" ? -step : key == "ArrowRight" ? step : 0;
    const dy = key == "ArrowUp" ? -step : key == "ArrowDown" ? step : 0;
    for (const item of this.selectedItems) {
      if (resize) {
        const keepAspect = item.type == "image" || item.type == "capture";
        const w = Math.max(M.MIN_SIZE, item.w + (dx || (keepAspect ? (dy * item.w) / item.h : 0)));
        const h = item.type == "text" ? item.h : Math.max(M.MIN_SIZE, keepAspect ? (w * item.h) / item.w : item.h + dy);
        Object.assign(item, { w, h }, item.type == "text" ? { auto: false } : {});
        this.renderItem(item);
        if (item.type == "text") this.measureText(item);
        continue;
      }
      item.x += dx;
      item.y += dy;
      this.position(item);
    }
    this.updateOverlay();
    this.saveSoon();
  }

  // Tab walks through items; past the last one, focus moves on.
  cycleSelection(direction) {
    if (!this.items.length) return false;
    const current = this.item ? this.items.indexOf(this.item) : direction > 0 ? -1 : this.items.length;
    const next = current + direction;
    if (next < 0 || next >= this.items.length) {
      this.select([]);
      return false;
    }
    const item = this.items[next];
    this.select([item.id]);
    this.reveal(item);
    this.announceSelection();
    return true;
  }

  createAtCenter() {
    const c = this.viewCenter;
    if (this.tool == "text") {
      const item = this.textItem(c.x - 40, c.y - 20);
      this.#drag = { kind: "text-session", before: M.clone(this.items) };
      this.items.push(item);
      this.renderAll();
      this.startEditing(item.id);
      return;
    }
    const line = this.tool == "line" || this.tool == "arrow";
    const item = {
      id: M.newItemId(),
      type: "shape",
      shape: this.tool,
      x: c.x - 70,
      y: c.y - (line ? 0 : 48),
      w: line ? 160 : 140,
      h: line ? 1 : 96,
      color: this.color,
      width: M.STROKE_WIDTHS[this.size],
      fill: null,
    };
    this.addItems([item]);
    this.setTool("select");
  }

  // Toolbars are single tab stops; arrow keys move inside them.
  onBarKey(event) {
    const bar = event.target.closest("#toolbar, #contextbar");
    if (!bar || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = [...bar.querySelectorAll("button")].filter(b => !b.closest("[hidden]") && !b.disabled);
    const index = buttons.indexOf(event.target.closest("button"));
    if (index < 0) return;
    event.preventDefault();
    const next =
      event.key == "Home" ? 0 : event.key == "End" ? buttons.length - 1 : (index + (event.key == "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    for (const b of buttons) b.tabIndex = -1;
    buttons[next].tabIndex = 0;
    buttons[next].focus();
  }

  // ---------- Commands ----------

  setTool(tool) {
    if (tool == "image") {
      $("file-input").click();
      return;
    }
    this.tool = tool;
    $("viewport").dataset.tool = tool;
    for (const button of document.querySelectorAll(".tool")) {
      button.setAttribute("aria-pressed", String(button.dataset.tool == tool));
    }
    if (tool != "select" && this.activeId) this.activate(null);
    this.updateToolbarState();
  }

  deleteSelection() {
    const count = this.selection.size;
    this.change(() => {
      this.items = this.items.filter(i => !this.selection.has(i.id));
    });
    this.selection.clear();
    this.updateChrome();
    this.announce("whimsy-easel-status-deleted", { count });
  }

  duplicate() {
    const copies = this.selectedItems.map(i => ({ ...M.clone(i), id: M.newItemId(), x: i.x + 24, y: i.y + 24 }));
    if (copies.length) this.addItems(copies);
  }

  reorder(where) {
    const selected = this.selectedItems;
    if (!selected.length) return;
    this.change(() => {
      const rest = this.items.filter(i => !this.selection.has(i.id));
      if (where == "front") {
        this.items = [...rest, ...selected];
      } else if (where == "back") {
        this.items = [...selected, ...rest];
      } else {
        const items = [...this.items];
        const order = where == "forward" ? [...items.keys()].reverse() : [...items.keys()];
        for (const i of order) {
          const j = where == "forward" ? i + 1 : i - 1;
          if (j < 0 || j >= items.length) continue;
          if (this.selection.has(items[i].id) && !this.selection.has(items[j].id)) {
            [items[i], items[j]] = [items[j], items[i]];
          }
        }
        this.items = items;
      }
    });
  }

  // Colour and size apply to the selection when there is one (Arc), and
  // become the remembered choice for what you draw next.
  setColor(color) {
    this.color = color;
    Services.prefs.setStringPref(PREF_COLOR, color);
    const items = this.selectedItems.filter(i => ["text", "pen", "shape"].includes(i.type));
    if (items.length) this.change(() => items.forEach(i => (i.color = color)));
    this.updateToolbarState();
  }

  setSize(size) {
    this.size = size;
    Services.prefs.setIntPref(PREF_SIZE, size);
    const items = this.selectedItems.filter(i => ["text", "pen", "shape"].includes(i.type));
    if (items.length) {
      this.change(() => {
        for (const item of items) {
          if (item.type == "text") item.size = M.TEXT_SIZES[size];
          else item.width = M.STROKE_WIDTHS[size] * (item.highlighter ? M.HIGHLIGHTER_SCALE : 1);
        }
      });
      for (const item of items.filter(i => i.type == "text")) this.measureText(item);
      this.updateOverlay();
    }
    this.updateToolbarState();
  }

  setFont(font) {
    this.font = font;
    Services.prefs.setStringPref(PREF_FONT, font);
    const items = this.selectedItems.filter(i => i.type == "text");
    if (items.length) {
      this.change(() => items.forEach(i => (i.font = font)));
      items.forEach(i => this.measureText(i));
      this.updateOverlay();
    }
    this.updateContextBar();
  }

  onContextAction(action) {
    const item = this.item;
    switch (action) {
      case "fill": {
        const shapes = this.selectedItems.filter(i => i.type == "shape" && i.shape != "line" && i.shape != "arrow");
        const next = shapes[0]?.fill ? null : "tint";
        this.change(() => shapes.forEach(s => (s.fill = next)));
        break;
      }
      case "live":
        this.setLive(item, !item?.live);
        break;
      case "open":
        if (item?.url) this.openURL(item.url, item.userContextId);
        break;
      case "front":
      case "back":
        this.reorder(action);
        break;
      case "duplicate":
        this.duplicate();
        break;
      case "delete":
        this.deleteSelection();
        $("viewport").focus();
        break;
    }
    this.updateContextBar();
  }

  // ---------- Clipboard and drops ----------

  get insertPoint() {
    if (this.#pointer) {
      const rect = $("viewport").getBoundingClientRect();
      const { x, y } = this.#pointer;
      if (x > rect.left && x < rect.right && y > rect.top && y < rect.bottom) return this.toWorld(x, y);
    }
    return this.viewCenter;
  }

  onCopy(event, cut = false) {
    if (this.editingId || event.target.closest?.("input") || !this.selection.size) return;
    event.preventDefault();
    const items = M.clone(this.selectedItems);
    event.clipboardData.setData(CLIP_TYPE, JSON.stringify({ easel: this.id, items }));
    const text = items.map(i => i.text ?? i.url ?? "").filter(Boolean).join("\n");
    event.clipboardData.setData("text/plain", text);
    if (cut) this.deleteSelection();
  }

  async onPaste(event) {
    if (this.editingId || event.target.closest?.("input")) return;
    event.preventDefault();
    const data = event.clipboardData;
    const at = this.insertPoint;
    const raw = data.getData(CLIP_TYPE);
    if (raw) {
      await this.pasteItems(raw, at);
      return;
    }
    const files = [...data.files].filter(f => f.type.startsWith("image/"));
    if (files.length) {
      await this.importFiles(files, at);
      return;
    }
    const text = data.getData("text/plain");
    if (text) this.addText(text, at);
  }

  copySelection() {
    const items = M.clone(this.selectedItems);
    const text = items.map(i => i.text ?? i.url ?? "").filter(Boolean).join("\n") || "\u200b";
    gWhimsyEaselClipboard.payload = JSON.stringify({ easel: this.id, items });
    gWhimsyEaselClipboard.text = text;
    Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(text);
    this.announce("whimsy-easel-status-copied", { count: items.length });
  }

  async pasteFromClipboard() {
    const at = this.insertPoint;
    let text = "";
    try {
      for (const entry of await navigator.clipboard.read()) {
        const imageType = entry.types.find(t => t.startsWith("image/"));
        if (imageType) {
          const blob = await entry.getType(imageType);
          await this.importFiles([new File([blob], "pasted", { type: imageType })], at);
          return;
        }
        if (entry.types.includes("text/plain")) {
          text = await (await entry.getType("text/plain")).text();
        }
      }
    } catch {
      try {
        text = await navigator.clipboard.readText();
      } catch {}
    }
    if (gWhimsyEaselClipboard.payload && text == gWhimsyEaselClipboard.text) {
      await this.pasteItems(gWhimsyEaselClipboard.payload, at);
    } else if (text) {
      this.addText(text, at);
    }
  }

  async pasteItems(raw, at) {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    const items = (payload.items ?? []).filter(i => i && typeof i.type == "string" && Number.isFinite(i.x));
    if (!items.length) return;
    const bounds = M.boundsOf(items);
    const copies = [];
    for (const item of items) {
      const copy = { ...item, id: M.newItemId(), x: item.x - bounds.x + at.x - bounds.w / 2, y: item.y - bounds.y + at.y - bounds.h / 2 };
      // Images from another easel are copied into this one's folder.
      for (const key of ["src", "image"]) {
        if (copy[key] && payload.easel != this.id) {
          const bytes = await gWhimsyEaselStore.readImage(payload.easel, copy[key]);
          if (!bytes) continue;
          copy[key] = await gWhimsyEaselStore.saveImage(this.id, bytes, copy[key].endsWith(".jpg") ? "image/jpeg" : "image/png");
        }
      }
      copies.push(copy);
    }
    await this.loadImages(copies);
    this.addItems(copies);
  }

  addText(text, at) {
    const trimmed = text.trim();
    if (isWebURL(trimmed)) {
      this.addItems([this.linkItem(trimmed, "", { x: at.x - M.LINK_SIZE.w / 2, y: at.y - M.LINK_SIZE.h / 2 })]);
      return;
    }
    const item = this.textItem(at.x, at.y, text.slice(0, 20000));
    this.items.push(item);
    this.renderItem(item);
    this.measureText(item);
    this.items.pop();
    this.addItems([item]);
  }

  async importFiles(files, at) {
    const items = [];
    for (const file of files.slice(0, 20)) {
      if (!file.type.startsWith("image/") || file.size > 50 * 1024 * 1024) continue;
      const item = await this.imageItem(new Uint8Array(await file.arrayBuffer()), file.type, { x: at.x + items.length * 24, y: at.y + items.length * 24 });
      if (item) items.push(item);
    }
    if (items.length) this.addItems(items);
    else this.announce("whimsy-easel-status-image-failed");
  }

  onDragOver(event) {
    const types = event.dataTransfer.types;
    if (["Files", "text/uri-list", "text/x-moz-url", "text/plain", TAB_DROP_TYPE].some(t => types.includes(t))) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }

  async onDrop(event) {
    event.preventDefault();
    const dt = event.dataTransfer;
    const at = this.toWorld(event.clientX, event.clientY);
    const tab = dt.mozGetDataAt?.(TAB_DROP_TYPE, 0);
    if (tab?.linkedBrowser) {
      const url = tab.linkedBrowser.currentURI?.spec;
      if (url && isWebURL(url)) {
        this.addItems([this.linkItem(url, tab.label, { x: at.x - M.LINK_SIZE.w / 2, y: at.y - M.LINK_SIZE.h / 2 })]);
      }
      return;
    }
    const files = [...dt.files].filter(f => f.type.startsWith("image/"));
    if (files.length) {
      await this.importFiles(files, at);
      return;
    }
    const uri = dt.getData("text/uri-list").split("\n").find(l => l && !l.startsWith("#"))?.trim();
    // Captures dragged from the Library are local image files.
    if (uri?.startsWith("file:") && /\.(png|jpe?g|gif|webp)$/i.test(uri)) {
      try {
        const path = Services.io.newURI(uri).QueryInterface(Ci.nsIFileURL).file.path;
        const bytes = await IOUtils.read(path);
        const type = /\.jpe?g$/i.test(uri) ? "image/jpeg" : `image/${uri.split(".").pop().toLowerCase()}`;
        const item = await this.imageItem(bytes, type, at);
        if (item) this.addItems([item]);
      } catch (e) {
        console.error("Whimsy: easel drop", e);
        this.announce("whimsy-easel-status-image-failed");
      }
      return;
    }
    const mozUrl = dt.getData("text/x-moz-url");
    if (mozUrl) {
      const [url, title] = mozUrl.split("\n");
      if (isWebURL(url)) {
        this.addItems([this.linkItem(url.trim(), title, { x: at.x - M.LINK_SIZE.w / 2, y: at.y - M.LINK_SIZE.h / 2 })]);
        return;
      }
    }
    const text = uri || dt.getData("text/plain");
    if (text) this.addText(text, at);
  }

  // ---------- Export (Arc shared to arc.net; Whimsy has no server) ----------

  async renderCanvas({ dark = isDark(), scale = 2 } = {}) {
    const geometry = M.exportGeometry(this.items, scale);
    const canvas = document.createElement("canvas");
    canvas.width = geometry.width;
    canvas.height = geometry.height;
    const ctx = canvas.getContext("2d");
    ctx.scale(geometry.scale, geometry.scale);
    ctx.translate(-geometry.box.x, -geometry.box.y);
    ctx.fillStyle = M.BACKGROUND[dark ? 1 : 0];
    ctx.fillRect(geometry.box.x, geometry.box.y, geometry.box.w, geometry.box.h);
    const images = new Map();
    for (const name of this.imageNames(this.items)) {
      const url = this.imageURLs.get(name);
      if (!url) continue;
      const img = new Image();
      img.src = url;
      try {
        await img.decode();
        images.set(name, img);
      } catch {}
    }
    M.drawItems(ctx, this.items, { dark, images });
    return canvas;
  }

  async renderPNG(options) {
    const canvas = await this.renderCanvas(options);
    return new Promise(resolve => canvas.toBlob(resolve, "image/png"));
  }

  async exportAs(kind, { path = null } = {}) {
    $("share-menu").hidePopover?.();
    try {
      if (kind == "link") {
        // wave7: the easel's own address. It opens this easel in Whimsy on
        // any device it syncs to (whimsy.easel.sync); Arc's public links
        // needed Arc's servers, which Whimsy doesn't have.
        Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(easelURL(this.id));
        this.announce("whimsy-easel-status-copied-link");
        return true;
      }
      if (kind == "copy") {
        const blob = await this.renderPNG();
        lazy.BrowserUtils.copyImageToClipboard(await blob.arrayBuffer());
        this.announce("whimsy-easel-status-copied-image");
        return true;
      }
      if (kind == "pdf") {
        const blob = await this.renderPNG({ dark: false });
        const img = $("print-image");
        img.src = URL.createObjectURL(blob);
        await img.decode();
        window.print();
        return true;
      }
      const blob = await this.renderPNG({ dark: kind == "png-dark" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const target = path ?? (await this.pickSavePath(`${(this.title || this.#untitled).replace(/[\\/:*?"<>|]/g, "-")}.png`));
      if (!target) return false;
      await IOUtils.write(target, bytes);
      this.announce("whimsy-easel-status-saved-png");
      return true;
    } catch (e) {
      console.error("Whimsy: easel export", e);
      this.announce("whimsy-easel-status-export-failed");
      return false;
    }
  }

  async pickSavePath(name) {
    const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    const title = await document.l10n.formatValue("whimsy-easel-export-picker-title");
    fp.init(window.browsingContext, title, Ci.nsIFilePicker.modeSave);
    fp.defaultString = name;
    fp.defaultExtension = "png";
    fp.appendFilter("PNG", "*.png");
    const result = await new Promise(resolve => fp.open(resolve));
    return result == Ci.nsIFilePicker.returnCancel ? null : fp.file?.path ?? null;
  }

  // ---------- Space colour ----------

  // The first colour of the space this easel's tab is in, as [r, g, b], or
  // null (Zen's default theme, or no tab yet).
  spaceRGB() {
    try {
      const win = window.browsingContext.topChromeWindow;
      const tab = win?.gBrowser?.getTabForBrowser(window.browsingContext.embedderElement);
      const id = tab?.getAttribute("zen-workspace-id");
      const rgb = id && win.gZenWorkspaces?.getWorkspaceFromId?.(id)?.theme?.gradientColors?.[0]?.c;
      return Array.isArray(rgb) && rgb.length >= 3 && rgb.slice(0, 3).every(Number.isFinite) ? rgb.slice(0, 3) : null;
    } catch {
      return null;
    }
  }

  applySpaceColor() {
    const root = document.documentElement;
    const rgb = this.spaceRGB();
    if (!rgb) {
      root.removeAttribute("space-color");
      for (const name of ["--ez-space", "--ez-space-text", "--ez-space-dark", "--ez-space-text-dark"]) root.style.removeProperty(name);
      return;
    }
    // Ink on the accent: whichever of near-black and white reads better.
    const lin = v => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const luminance = c => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
    const ink = c => ((luminance(c) + 0.05) / 0.05 > 1.05 / (luminance(c) + 0.05) ? "#1a1320" : "#ffffff");
    // Dark mode lifts the accent a third of the way to white.
    const dark = rgb.map(v => Math.round(v + (255 - v) * 0.35));
    root.style.setProperty("--ez-space", `rgb(${rgb.join(" ")})`);
    root.style.setProperty("--ez-space-text", ink(rgb));
    root.style.setProperty("--ez-space-dark", `rgb(${dark.join(" ")})`);
    root.style.setProperty("--ez-space-text-dark", ink(dark));
    root.setAttribute("space-color", "true");
  }

  // ---------- Chrome ----------

  buildToolbar() {
    const swatches = document.querySelector(".swatches");
    for (const name of M.COLOR_NAMES) {
      const button = document.createElement("button");
      button.className = "swatch";
      button.setAttribute("role", "radio");
      button.dataset.color = name;
      button.style.setProperty("--swatch", M.colorValue(name, isDark()));
      document.l10n.setAttributes(button, `whimsy-easel-color-${name}`);
      swatches.append(button);
    }
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      for (const button of swatches.children) {
        button.style.setProperty("--swatch", M.colorValue(button.dataset.color, isDark()));
      }
      this.renderAll();
    });
    // One tab stop per toolbar.
    for (const bar of [$("toolbar"), $("contextbar")]) {
      bar.querySelectorAll("button").forEach((b, i) => (b.tabIndex = i == 0 ? 0 : -1));
    }
  }

  bindEvents() {
    const viewport = $("viewport");
    viewport.addEventListener("pointerdown", e => this.onPointerDown(e));
    // See the text tool in onPointerDown: a privileged page has to cancel
    // the compat mousedown itself to keep its focus where it put it.
    viewport.addEventListener("mousedown", e => {
      if (this.#suppressMouseDown) {
        this.#suppressMouseDown = false;
        e.preventDefault();
      }
    });
    viewport.addEventListener("pointermove", e => this.onPointerMove(e));
    viewport.addEventListener("pointerup", e => this.onPointerUp(e));
    viewport.addEventListener("pointercancel", e => this.onPointerUp(e));
    viewport.addEventListener("dblclick", e => this.onDoubleClick(e));
    viewport.addEventListener("wheel", e => this.onWheel(e), { passive: false });
    viewport.addEventListener("dragover", e => this.onDragOver(e));
    viewport.addEventListener("drop", e => this.onDrop(e));
    document.addEventListener("keydown", e => this.onKeyDown(e));
    document.addEventListener("keyup", e => this.onKeyUp(e));
    document.addEventListener("copy", e => this.onCopy(e));
    document.addEventListener("cut", e => this.onCopy(e, true));
    document.addEventListener("paste", e => this.onPaste(e));
    document.addEventListener("pointermove", e => (this.#pointer = { x: e.clientX, y: e.clientY }), { passive: true });
    window.addEventListener("resize", () => this.updateOverlay());
    window.addEventListener("pagehide", () => this.flush());

    for (const button of document.querySelectorAll(".tool")) {
      button.addEventListener("click", () => this.setTool(button.dataset.tool));
    }
    document.querySelector(".swatches").addEventListener("click", e => {
      const swatch = e.target.closest(".swatch");
      if (swatch) this.setColor(swatch.dataset.color);
    });
    for (const button of document.querySelectorAll(".size")) {
      button.addEventListener("click", () => this.setSize(Number(button.dataset.size)));
    }
    for (const button of document.querySelectorAll(".font-button")) {
      button.addEventListener("click", () => this.setFont(button.dataset.font));
    }
    for (const button of document.querySelectorAll("#contextbar [data-action]")) {
      button.addEventListener("click", () => this.onContextAction(button.dataset.action));
    }
    $("undo").addEventListener("click", () => this.undo());
    $("redo").addEventListener("click", () => this.redo());
    $("zoom-in").addEventListener("click", () => this.zoomStep(1));
    $("zoom-out").addEventListener("click", () => this.zoomStep(-1));
    $("zoom-reset").addEventListener("click", () => this.zoomAt(1, null, null, { animate: true }));
    $("file-input").addEventListener("change", async e => {
      const files = [...e.target.files];
      e.target.value = "";
      if (files.length) await this.importFiles(files, this.viewCenter);
    });

    const title = $("easel-title");
    title.addEventListener("input", () => {
      this.title = title.value;
      document.title = this.title || this.#untitled;
      this.saveSoon();
    });

    const share = $("share");
    const menu = $("share-menu");
    share.addEventListener("click", () => {
      if (menu.matches(":popover-open")) {
        menu.hidePopover();
        return;
      }
      const rect = share.getBoundingClientRect();
      menu.style.top = `${rect.bottom + 8}px`;
      menu.style.right = `${document.documentElement.clientWidth - rect.right}px`;
      menu.showPopover();
      menu.querySelector("button").focus();
    });
    menu.addEventListener("toggle", e => {
      share.setAttribute("aria-expanded", String(e.newState == "open"));
      if (e.newState == "closed" && menu.contains(document.activeElement)) share.focus();
    });
    menu.addEventListener("keydown", e => {
      const items = [...menu.querySelectorAll("button")];
      const i = items.indexOf(document.activeElement);
      if (e.key == "ArrowDown" || e.key == "ArrowUp") {
        e.preventDefault();
        items[(i + (e.key == "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
      } else if (e.key == "Home" || e.key == "End") {
        e.preventDefault();
        items[e.key == "Home" ? 0 : items.length - 1].focus();
      }
    });
    for (const button of menu.querySelectorAll("[data-export]")) {
      button.addEventListener("click", () => this.exportAs(button.dataset.export));
    }
  }

  updateChrome() {
    $("undo").disabled = !this.history.canUndo;
    $("redo").disabled = !this.history.canRedo;
    $("empty").hidden = this.items.length > 0;
    this.updateToolbarState();
    this.updateOverlay();
  }

  // The swatches and sizes show the selection's style, or what's next.
  updateToolbarState() {
    const styled = this.selectedItems.filter(i => ["text", "pen", "shape"].includes(i.type));
    const color = styled.length && styled.every(i => i.color == styled[0].color) ? styled[0].color : styled.length ? null : this.color;
    for (const swatch of document.querySelectorAll(".swatch")) {
      swatch.setAttribute("aria-checked", String(swatch.dataset.color == color));
    }
    let size = this.size;
    if (styled.length) {
      const first = styled[0];
      size = first.type == "text" ? M.TEXT_SIZES.indexOf(first.size) : M.STROKE_WIDTHS.indexOf(first.width / (first.highlighter ? M.HIGHLIGHTER_SCALE : 1));
    }
    for (const button of document.querySelectorAll(".size")) {
      button.setAttribute("aria-checked", String(Number(button.dataset.size) == size));
    }
  }

  updateContextBar() {
    const bar = $("contextbar");
    const items = this.selectedItems;
    if (!items.length || this.#drag?.kind == "move" || this.#drag?.kind == "resize" || this.#drag?.kind == "marquee") {
      bar.hidden = true;
      return;
    }
    const all = type => items.every(i => i.type == type);
    const groups = {
      text: all("text"),
      shape: items.every(i => i.type == "shape" && i.shape != "line" && i.shape != "arrow"),
      capture: items.length == 1 && items[0].type == "capture" && !!items[0].url,
    };
    for (const group of bar.querySelectorAll(".ctx-group[data-for]")) {
      group.hidden = !groups[group.dataset.for];
    }
    // Keep the bar's single tab stop on a button that's showing.
    const visible = [...bar.querySelectorAll("button")].filter(b => !b.closest("[hidden]"));
    if (!visible.some(b => b.tabIndex == 0)) {
      bar.querySelectorAll("button").forEach(b => (b.tabIndex = -1));
      if (visible[0]) visible[0].tabIndex = 0;
    }
    if (groups.text) {
      for (const b of bar.querySelectorAll(".font-button")) {
        b.setAttribute("aria-checked", String(b.dataset.font == items[0].font));
      }
    }
    if (groups.shape) {
      bar.querySelector('[data-action="fill"]').setAttribute("aria-pressed", String(!!items[0].fill));
    }
    if (groups.capture) {
      const live = bar.querySelector('[data-action="live"]');
      live.setAttribute("aria-pressed", String(!!items[0].live));
      document.l10n.setAttributes(live, items[0].live ? "whimsy-easel-live-pause" : "whimsy-easel-live-play");
    }
    const wasHidden = bar.hidden;
    bar.hidden = false;
    const s = this.toScreen(M.boundsOf(items));
    const width = bar.offsetWidth;
    const height = bar.offsetHeight;
    const vw = document.documentElement.clientWidth;
    let left = s.x + s.w / 2 - width / 2;
    let top = s.y - height - 12;
    if (top < 60) top = s.y + s.h + 12;
    left = Math.max(12, Math.min(vw - width - 12, left));
    top = Math.max(60, Math.min(document.documentElement.clientHeight - height - 76, top));
    bar.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    if (wasHidden) {
      // Restart the pop-in from where the bar now is.
      bar.style.animation = "none";
      bar.offsetWidth;
      bar.style.animation = "";
    }
  }

  announce(id, args) {
    document.l10n.setAttributes($("status"), id, args);
  }

  announceSelection() {
    this.announce("whimsy-easel-status-selected", { count: this.selection.size });
  }
}

const app = new EaselApp();
window.gWhimsyEasel = app;
app.init().catch(e => {
  console.error("Whimsy: easel", e);
  document.documentElement.setAttribute("ready", "true");
});
