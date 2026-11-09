/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 ⌘K: how much of the view each kind of content takes (text, video,
// images), the images in view, whether it's a product page, and what the
// selection sits in. Measured once each time ⌘K opens. Messages only.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  classifyField: "resource:///modules/whimsy/WhimsyAISensitive.sys.mjs",
});

const TEXT_BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, dd, figcaption";
const VIDEO_FRAMES = /youtube(-nocookie)?\.com\/embed|player\.vimeo\.com|player\.twitch\.tv|\/embed\/video/i;
const MAX_IMAGES = 10;

function visibleArea(r, vw, vh) {
  const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
  const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
  return w * h;
}

function shown(el, win) {
  const style = win.getComputedStyle(el);
  return style.visibility != "hidden" && style.display != "none" && Number(style.opacity) > 0.05;
}

function isProduct(doc) {
  if (/product/i.test(doc.querySelector("meta[property='og:type']")?.content ?? "")) {
    return true;
  }
  if (doc.querySelector("[itemtype*='schema.org/Product']")) {
    return true;
  }
  const types = node => {
    if (!node || typeof node != "object") {
      return false;
    }
    if (Array.isArray(node)) {
      return node.some(types);
    }
    const t = node["@type"];
    return t == "Product" || (Array.isArray(t) && t.includes("Product")) || types(node["@graph"]);
  };
  for (const script of doc.querySelectorAll("script[type='application/ld+json']")) {
    try {
      if (types(JSON.parse(script.textContent))) {
        return true;
      }
    } catch {}
  }
  return false;
}

export class WhimsyAIViewShareChild extends JSWindowActorChild {
  receiveMessage(message) {
    switch (message.name) {
      case "Whimsy:ViewShare":
        return this.measure();
      case "Whimsy:SelectionInfo":
        return this.selectionInfo();
      // ⌘K's writing commands replace the selection in place, on the
      // field's own undo stack.
      case "Whimsy:ReplaceSelection":
        return this.document.execCommand("insertText", false, String(message.data?.text ?? ""));
      case "Whimsy:UndoReplace":
        return this.document.execCommand("undo");
      // The right-click result card (WhimsyAISelectionCard).
      case "Whimsy:CardMark":
        return this.mark();
      case "Whimsy:CardReplace":
        return this.cardReplace(String(message.data?.text ?? ""));
      case "Whimsy:CardInsertAfter":
        return this.cardInsertAfter(String(message.data?.text ?? ""));
      case "Whimsy:CardUndo":
        return this.cardUndo();
    }
    return null;
  }

  // Right-click: whether the menu's target holds a secret, sent before the
  // menu's own message so the AI rows know (no rows on password, card, or
  // one-time-code fields).
  handleEvent(event) {
    if (event.type != "contextmenu") {
      return;
    }
    const target = event.composedTarget ?? event.target;
    const el = target?.nodeType == 1 ? target : target?.parentElement;
    const host = el?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
    const editingHost = host?.isContentEditable ? host.closest("[contenteditable]:not([contenteditable='false'])") : host;
    this.sendAsyncMessage("Whimsy:ContextTarget", { sensitive: editingHost ? lazy.classifyField(editingHost) : null });
  }

  #field(el) {
    return el && (el.localName == "textarea" || (el.localName == "input" && /^(text|search|email|url|tel|)$/.test(el.type ?? ""))) ? el : null;
  }

  // Remembers the selection the card acts on: its text, where it is on
  // screen, and whether it can be edited.
  mark() {
    const doc = this.document;
    const win = this.contentWindow;
    const field = this.#field(doc.activeElement);
    let rect = null;
    if (field && field.selectionStart != field.selectionEnd) {
      const { selectionStart: start, selectionEnd: end } = field;
      this._mark = { field, start, end, text: field.value.slice(start, end) };
      rect = field.getBoundingClientRect();
    } else {
      const selection = win.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed) {
        return null;
      }
      const range = selection.getRangeAt(0).cloneRange();
      const node = range.commonAncestorContainer;
      const el = node.nodeType == 1 ? node : node.parentElement;
      const host = el?.isContentEditable ? el.closest("[contenteditable]:not([contenteditable='false'])") ?? el : null;
      this._mark = { range, host, text: selection.toString() };
      rect = range.getBoundingClientRect();
    }
    const m = this._mark;
    const editor = m.field ?? m.host;
    return {
      text: m.text,
      editable: !!editor && !editor.readOnly && !editor.disabled,
      sensitive: editor ? lazy.classifyField(editor) : null,
      rect: { left: win.mozInnerScreenX + rect.left, top: win.mozInnerScreenY + rect.top, width: rect.width, height: rect.height },
    };
  }

  #restore() {
    const m = this._mark;
    if (!m) {
      return false;
    }
    if (m.field) {
      m.field.focus();
      m.field.setSelectionRange(m.start, m.end);
      return true;
    }
    m.host?.focus();
    const selection = this.contentWindow.getSelection();
    selection.removeAllRanges();
    selection.addRange(m.range);
    return true;
  }

  cardReplace(text) {
    const m = this._mark;
    if (!this.#restore() || !(m.field || m.host)) {
      return false;
    }
    const done = this.document.execCommand("insertText", false, text);
    // ⌘Z in the field, or the toast's Undo: the original comes back
    // selected, and the card reopens.
    const target = m.field ?? m.host;
    const onInput = event => {
      if (event.inputType != "historyUndo") {
        return;
      }
      target.removeEventListener("input", onInput);
      if (m.field) {
        m.field.setSelectionRange(m.start, m.start + m.text.length);
      }
      this.sendAsyncMessage("Whimsy:CardUndone");
    };
    target.addEventListener("input", onInput);
    return done;
  }

  // Undo puts the original back and selects it again.
  cardUndo() {
    const m = this._mark;
    if (!m) {
      return false;
    }
    if (m.block) {
      m.block.remove();
      m.block = null;
      return true;
    }
    (m.field ?? m.host)?.focus();
    return this.document.execCommand("undo");
  }

  cardInsertAfter(text) {
    const m = this._mark;
    const doc = this.document;
    if (!m) {
      return false;
    }
    if (m.field || m.host) {
      this.#restore();
      if (m.field) {
        m.field.setSelectionRange(m.end, m.end);
      } else {
        this.contentWindow.getSelection().collapseToEnd();
      }
      return doc.execCommand("insertText", false, `\n\n${text}`);
    }
    // Read-only text: a marked block under its paragraph, gone on reload.
    const node = m.range.endContainer;
    const el = node.nodeType == 1 ? node : node.parentElement;
    const block = el?.closest("p, li, blockquote, pre, h1, h2, h3, h4, h5, h6, td, dd, figcaption") ?? el;
    if (!block) {
      return false;
    }
    const box = doc.createElement("div");
    box.setAttribute("data-whimsy-ai-inserted", "");
    box.style.cssText =
      "margin: 0.6em 0; padding: 0.5em 0.8em; border-inline-start: 3px solid #8b5cf6; border-radius: 4px; " +
      "background: color-mix(in srgb, #8b5cf6 9%, transparent); white-space: pre-wrap; font: inherit; color: inherit;";
    box.textContent = text;
    block.after(box);
    m.block = box;
    return true;
  }

  measure() {
    const win = this.contentWindow;
    const doc = this.document;
    if (!win || !doc?.documentElement) {
      return null;
    }
    const vw = win.innerWidth;
    const vh = win.innerHeight;
    const viewArea = Math.max(1, vw * vh);
    let video = 0;
    for (const el of doc.querySelectorAll("video, iframe")) {
      if (el.localName == "iframe" && !VIDEO_FRAMES.test(el.src)) {
        continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width >= 120 && r.height >= 68 && shown(el, win)) {
        video += visibleArea(r, vw, vh);
      }
    }
    const images = [];
    for (const el of doc.images) {
      const r = el.getBoundingClientRect();
      if (r.width < 64 || r.height < 64 || !shown(el, win)) {
        continue;
      }
      const area = visibleArea(r, vw, vh);
      if (area > 0) {
        images.push({ src: el.currentSrc || el.src, alt: el.alt ?? "", area, el });
      }
    }
    images.sort((a, b) => b.area - a.area);
    let text = 0;
    let chars = 0;
    for (const el of doc.querySelectorAll(TEXT_BLOCKS)) {
      if (el.parentElement?.closest(TEXT_BLOCKS)) {
        continue;
      }
      const words = (el.textContent ?? "").trim().length;
      if (words < 2 || !shown(el, win)) {
        continue;
      }
      const area = visibleArea(el.getBoundingClientRect(), vw, vh);
      if (area > 0) {
        text += area;
        chars += words;
      }
    }
    // The image under the pointer is the one the page shows as hovered.
    const at = images.findIndex(i => i.el.matches(":hover"));
    const underPointer = at >= 0 && at < MAX_IMAGES ? at : null;
    const share = a => Math.min(1, a / viewArea);
    const imageArea = images.reduce((sum, i) => sum + i.area, 0);
    return {
      shares: { article: chars >= 80 ? share(text) : 0, video: share(video), image: share(imageArea) },
      images: images.slice(0, MAX_IMAGES).map(({ src, alt, area }) => ({ src, alt, area })),
      underPointer,
      product: isProduct(doc),
      textChars: (doc.body?.innerText ?? "").trim().length,
      lang: doc.documentElement.lang || "",
    };
  }

  // Whether the selection is in something you can type in, and whether
  // that field holds a secret (no AI there).
  selectionInfo() {
    const doc = this.document;
    const win = this.contentWindow;
    if (!doc || !win) {
      return null;
    }
    const active = doc.activeElement;
    const field = active && (active.localName == "textarea" || (active.localName == "input" && /^(text|search|email|url|tel|password|number|)$/.test(active.type ?? ""))) ? active : null;
    let host = field;
    if (!host) {
      const node = win.getSelection()?.anchorNode;
      const el = node?.nodeType == 1 ? node : node?.parentElement;
      host = el?.isContentEditable ? el.closest("[contenteditable]:not([contenteditable='false'])") ?? el : null;
    }
    return {
      editable: !!host && !host.readOnly && !host.disabled,
      sensitive: host ? lazy.classifyField(host) : null,
    };
  }
}
