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
    }
    return null;
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
