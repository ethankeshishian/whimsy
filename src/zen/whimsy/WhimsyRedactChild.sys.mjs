/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave5: Redact in the screenshot interface. While Screenshots is open and
// Redact is on, emails, phone numbers, key/token-looking strings and card
// numbers (Luhn-valid) get a blurred box drawn over them, and clicking any
// text blurs or unblurs it. The boxes are anonymous content (like the
// Screenshots overlay itself), so the page's DOM is never touched, and
// drawSnapshot paints them into the capture. The parent turns this off
// once the image is made, so the page goes back to normal.
//
// wave7: every frame has its own actor (allFrames), so text inside
// iframes, same-origin or not, is found and blurred in that frame's own
// document; a click over a frame is handed to the frame's actor, in that
// frame's coordinates (directly in this process, or through the parent
// for an out-of-process frame).
//
// Pointer events come from the actor's own capturing listeners (declared
// with the actor, so they sit on the window root before Screenshots adds
// its listeners there; Screenshots stops immediate propagation of every
// pointer event it handles, so a listener added after it never runs).
//
// Text inside position: fixed elements gets its boxes in a fixed layer, in
// viewport coordinates, so they stay on the text while the page scrolls;
// everything else is in page coordinates. Neither layer has a size of its
// own: an absolutely positioned layer as big as the window (scrollbar
// included) made the page overflow, which brought in scrollbars and moved
// fixed elements after their boxes were measured.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// "(555) 123-4567", "+1 415 555 0132", "+44 20 7946 0958", "555.123.4567".
// Not part of a longer run of digit groups (a card number that fails Luhn).
const PHONE = /(?<![\w+.-]|\d[ .])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?|\d{2,4}[ .-])\d{3,4}[ .-]?\d{3,4}(?![\w-]|[ .]\d)/g;
const CARD = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;
const TOKENS = [
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g, // Stripe
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS
  /\bAIza[0-9A-Za-z_-]{35}/g, // Google
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, // Anthropic, OpenAI
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
];
// Anything else long and random-looking: 32+ characters mixing letters and
// digits, either hex or mixed case (slugs and words don't qualify).
const LONG = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{32,}(?![A-Za-z0-9+/_=-])/g;

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "TEMPLATE", "OPTION"]);
const CLICK_SLOP = 4;
const PAD = 2;

export function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2) {
      d *= 2;
      if (d > 9) {
        d -= 9;
      }
    }
    sum += d;
  }
  return sum % 10 == 0;
}

function looksLikeToken(s) {
  if (!/\d/.test(s) || !/[A-Za-z]/.test(s)) {
    return false;
  }
  return /^[0-9a-f]+$/i.test(s) || (/[a-z]/.test(s) && /[A-Z]/.test(s));
}

/**
 * The sensitive spans in a string, as [start, end] pairs.
 *
 * @param {string} text
 * @returns {Array<[number, number]>}
 */
export function findSensitive(text) {
  const spans = [];
  const add = (re, ok = () => true) => {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (ok(m[0])) {
        spans.push([m.index, m.index + m[0].length]);
      }
    }
  };
  add(EMAIL);
  add(CARD, s => {
    const digits = s.replace(/\D/g, "");
    return digits.length >= 13 && digits.length <= 19 && luhn(digits);
  });
  add(PHONE, s => {
    const n = s.replace(/\D/g, "").length;
    return n >= 7 && n <= 15;
  });
  for (const re of TOKENS) {
    add(re);
  }
  add(LONG, looksLikeToken);
  spans.sort((a, b) => a[0] - b[0]);
  // Merge overlaps (a token that is also "long", a card that looks like a phone).
  const merged = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) {
      last[1] = Math.max(last[1], span[1]);
    } else {
      merged.push(span);
    }
  }
  return merged;
}

export class WhimsyRedactChild extends JSWindowActorChild {
  #active = false;
  #content = null;
  #layer = null;
  #fixedLayer = null;
  // Text node -> spans the detectors found in it.
  #auto = new Map();
  // Text nodes the user clicked: blurred whole, or unblurred.
  #added = new Set();
  #removed = new Set();
  #frame = 0;
  #redetect = 0;
  #observer = null;
  #down = null;

  receiveMessage(message) {
    switch (message.name) {
      case "Redact:Set":
        if (message.data.on) {
          this.activate();
        } else {
          this.deactivate();
        }
        return this.#state();
      case "Redact:State":
        return this.#state();
      case "Redact:ToggleAt":
        // Tests (and anything else) can click without the overlay; also a
        // click over this frame, forwarded from its parent frame.
        return this.toggleAt(message.data.x, message.data.y);
    }
    return null;
  }

  didDestroy() {
    this.deactivate();
  }

  // Box rects in page coordinates (fixed boxes at the current scroll).
  #state() {
    const win = this.contentWindow;
    const read = (layer, dx, dy) =>
      [...(layer?.children ?? [])].map(box => ({
        left: parseFloat(box.style.left) + dx,
        top: parseFloat(box.style.top) + dy,
        width: parseFloat(box.style.width),
        height: parseFloat(box.style.height),
      }));
    const rects = [...read(this.#layer, 0, 0), ...read(this.#fixedLayer, win?.scrollX ?? 0, win?.scrollY ?? 0)];
    return { active: this.#active, rects, added: this.#added.size, removed: this.#removed.size };
  }

  get #overlay() {
    try {
      // Only an actor Screenshots already started; never create one.
      const overlay = this.manager.getExistingActor("ScreenshotsComponent")?.overlay;
      return overlay?.initialized ? overlay : null;
    } catch {
      return null;
    }
  }

  activate() {
    if (this.#active || !this.document?.body) {
      return;
    }
    this.#active = true;
    const doc = this.document;
    this.#content = doc.insertAnonymousContent();
    // CSSOM style properties, not a style sheet or attribute: a page's CSP
    // can block those, and the anonymous content inherits the page's.
    // Zero-size layers: boxes overflow them visibly, but the layers never
    // make the page itself bigger.
    const makeLayer = (id, position) => {
      const layer = doc.createElement("div");
      layer.id = id;
      for (const [k, v] of [["position", position], ["left", "0"], ["top", "0"], ["width", "0"], ["height", "0"], ["overflow", "visible"], ["pointer-events", "none"]]) {
        layer.style.setProperty(k, v);
      }
      this.#content.root.appendChild(layer);
      return layer;
    };
    this.#layer = makeLayer("whimsy-redact-layer", "absolute");
    this.#fixedLayer = makeLayer("whimsy-redact-fixed-layer", "fixed");

    const win = this.contentWindow;
    win.addEventListener("scroll", this, { capture: true, passive: true });
    win.addEventListener("resize", this);
    // A frame added or navigated while redacting: ask the parent to start
    // redaction in it too.
    win.addEventListener("load", this, { capture: true });
    this.#observer = new win.MutationObserver(() => this.#scheduleDetect());
    this.#observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
    this.#detect();
    this.#draw();
  }

  deactivate() {
    if (!this.#active) {
      return;
    }
    this.#active = false;
    const win = this.contentWindow;
    try {
      win?.removeEventListener("scroll", this, { capture: true });
      win?.removeEventListener("resize", this);
      win?.removeEventListener("load", this, { capture: true });
      if (this.#frame) {
        win?.cancelAnimationFrame(this.#frame);
      }
      if (this.#redetect) {
        win?.clearTimeout(this.#redetect);
      }
    } catch {}
    this.#observer?.disconnect();
    this.#observer = null;
    try {
      if (this.#content) {
        this.document.removeAnonymousContent(this.#content);
      }
    } catch {}
    this.#content = this.#layer = this.#fixedLayer = null;
    this.#frame = this.#redetect = 0;
    this.#auto.clear();
    this.#added.clear();
    this.#removed.clear();
    this.#down = null;
  }

  handleEvent(event) {
    if (!this.#active) {
      return;
    }
    switch (event.type) {
      case "scroll":
        // Sticky elements move with the scroll: redraw right away, and again
        // after layout settles.
        this.#draw();
        this.#scheduleDraw();
        break;
      case "resize":
        this.#scheduleDraw();
        break;
      case "load":
        if (event.target?.localName == "iframe" || event.target?.localName == "frame") {
          this.sendAsyncMessage("Redact:FramesChanged");
        }
        break;
      case "pointerdown":
        this.#onPointerDown(event);
        break;
      case "pointerup":
        this.#onPointerUp(event);
        break;
    }
  }

  // Clicks reach the page through the Screenshots overlay, which would
  // select the element under the pointer. With Redact on, a click blurs
  // text instead; dragging still selects a region.
  #onPointerDown(event) {
    this.#down = null;
    const overlay = this.#overlay;
    if (!event.isTrusted || event.button != 0 || !overlay || !["crosshairs", "draggingReady"].includes(overlay.state)) {
      return;
    }
    if (!event.originalTarget?.closest?.("#screenshots-component") || event.originalTarget.closest("#buttons-container")) {
      return;
    }
    this.#down = { x: event.clientX, y: event.clientY };
    // Without a hovered element, a click ends back in crosshairs instead
    // of selecting that element.
    overlay.hoverElementRegion?.resetDimensions();
    overlay.hideHoverElementContainer?.();
  }

  #onPointerUp(event) {
    const down = this.#down;
    this.#down = null;
    if (!down || event.button != 0) {
      return;
    }
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > CLICK_SLOP) {
      return;
    }
    this.toggleAt(event.clientX, event.clientY);
  }

  /**
   * Blur or unblur the text node at a viewport point.
   *
   * @returns {boolean|null} true if it's now blurred, false if not, null if no text there
   */
  toggleAt(x, y) {
    if (!this.#active) {
      return null;
    }
    const overlay = this.#overlay;
    overlay?.setPointerEventsNone();
    let node = null;
    let frame = null;
    try {
      const hit = this.document.elementFromPoint(x, y);
      if (hit && (hit.localName == "iframe" || hit.localName == "frame")) {
        frame = hit;
      } else {
        const pos = this.document.caretPositionFromPoint(x, y);
        node = pos?.offsetNode;
      }
    } finally {
      overlay?.resetPointerEvents();
    }
    if (frame) {
      return this.#toggleInFrame(frame, x, y);
    }
    if (!node || node.nodeType != node.TEXT_NODE || !node.data.trim()) {
      return null;
    }
    // caretPositionFromPoint snaps to the nearest text; only count a hit.
    const range = this.document.createRange();
    range.selectNodeContents(node);
    const hit = [...range.getClientRects()].some(r => x >= r.left - PAD && x <= r.right + PAD && y >= r.top - PAD && y <= r.bottom + PAD);
    if (!hit) {
      return null;
    }
    const blurred = this.#added.has(node) || (this.#auto.has(node) && !this.#removed.has(node));
    if (blurred) {
      this.#added.delete(node);
      if (this.#auto.has(node)) {
        this.#removed.add(node);
      }
    } else {
      this.#removed.delete(node);
      this.#added.add(node);
    }
    this.#draw();
    return !blurred;
  }

  // A click over an iframe: the point in the frame's own viewport (inside
  // its border and padding), then that frame's actor.
  #toggleInFrame(frame, x, y) {
    const win = this.contentWindow;
    const rect = frame.getBoundingClientRect();
    const style = win.getComputedStyle(frame);
    const localX = x - rect.left - frame.clientLeft - parseFloat(style.paddingLeft || 0);
    const localY = y - rect.top - frame.clientTop - parseFloat(style.paddingTop || 0);
    if (localX < 0 || localY < 0 || localX > frame.clientWidth || localY > frame.clientHeight) {
      return null;
    }
    const bc = frame.browsingContext;
    if (!bc) {
      return null;
    }
    // Same process: straight to its actor.
    let inner = null;
    try {
      inner = bc.docShell ? bc.window?.windowGlobalChild : null;
    } catch {}
    if (inner) {
      try {
        return inner.getActor("WhimsyRedact").toggleAt(localX, localY);
      } catch {
        return null;
      }
    }
    // Another process: the parent checks the frame is ours and passes it on.
    this.sendAsyncMessage("Redact:ToggleInFrame", { browsingContextId: bc.id, x: localX, y: localY });
    return null;
  }

  #scheduleDraw() {
    if (!this.#frame) {
      this.#frame = this.contentWindow.requestAnimationFrame(() => {
        this.#frame = 0;
        this.#draw();
      });
    }
  }

  #scheduleDetect() {
    if (this.#redetect) {
      return;
    }
    this.#redetect = this.contentWindow.setTimeout(() => {
      this.#redetect = 0;
      if (this.#active) {
        this.#detect();
        this.#draw();
      }
    }, 250);
  }

  #detect() {
    this.#auto.clear();
    const doc = this.document;
    const walker = doc.createTreeWalker(doc.body, this.contentWindow.NodeFilter.SHOW_TEXT, {
      acceptNode: node => {
        if (node.data.length < 6) {
          return this.contentWindow.NodeFilter.FILTER_REJECT;
        }
        for (let el = node.parentElement; el; el = el.parentElement) {
          if (SKIP.has(el.localName.toUpperCase())) {
            return this.contentWindow.NodeFilter.FILTER_REJECT;
          }
        }
        return this.contentWindow.NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const spans = findSensitive(node.data);
      if (spans.length) {
        this.#auto.set(node, spans);
      }
    }
    for (const set of [this.#added, this.#removed]) {
      for (const node of set) {
        if (!node.isConnected) {
          set.delete(node);
        }
      }
    }
  }

  // Page coordinates, so the boxes scroll with the page and cover parts
  // outside the viewport for full-page captures.
  #draw() {
    if (!this.#layer) {
      return;
    }
    const doc = this.document;
    const win = this.contentWindow;
    const { scrollX, scrollY } = win;
    const rects = [];
    const fixedRects = [];
    const range = doc.createRange();
    // Whether a node is inside a position: fixed element (cached per draw).
    const fixedCache = new Map();
    const isFixed = el => {
      if (!el || el == doc.documentElement) {
        return false;
      }
      if (fixedCache.has(el)) {
        return fixedCache.get(el);
      }
      const fixed = win.getComputedStyle(el).position == "fixed" || isFixed(el.parentElement);
      fixedCache.set(el, fixed);
      return fixed;
    };
    const collect = node => {
      const fixed = isFixed(node.parentElement);
      for (const r of range.getClientRects()) {
        if (r.width > 0 && r.height > 0) {
          if (fixed) {
            fixedRects.push([r.left - PAD, r.top - PAD, r.width + PAD * 2, r.height + PAD * 2]);
          } else {
            rects.push([r.left + scrollX - PAD, r.top + scrollY - PAD, r.width + PAD * 2, r.height + PAD * 2]);
          }
        }
      }
    };
    for (const [node, spans] of this.#auto) {
      if (!node.isConnected || this.#removed.has(node) || this.#added.has(node)) {
        continue;
      }
      for (const [start, end] of spans) {
        if (end > node.length) {
          continue;
        }
        range.setStart(node, start);
        range.setEnd(node, end);
        collect(node);
      }
    }
    for (const node of this.#added) {
      if (node.isConnected) {
        range.selectNodeContents(node);
        collect(node);
      }
    }
    this.#fill(this.#layer, rects);
    this.#fill(this.#fixedLayer, fixedRects);
  }

  #fill(layer, rects) {
    if (!layer) {
      return;
    }
    const doc = this.document;
    while (layer.children.length > rects.length) {
      layer.lastElementChild.remove();
    }
    while (layer.children.length < rects.length) {
      const box = doc.createElement("div");
      box.className = "whimsy-redact-box";
      const s = box.style;
      s.setProperty("position", "absolute");
      s.setProperty("border-radius", "4px");
      s.setProperty("backdrop-filter", "blur(7px)");
      // Also a tint, so a redaction never reads as untouched text.
      s.setProperty("background-color", "rgb(128 128 128 / 0.35)");
      s.setProperty("pointer-events", "none");
      layer.appendChild(box);
    }
    rects.forEach(([left, top, width, height], i) => {
      const s = layer.children[i].style;
      s.setProperty("left", `${left}px`);
      s.setProperty("top", `${top}px`);
      s.setProperty("width", `${width}px`);
      s.setProperty("height", `${height}px`);
    });
  }
}
