/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W30 svg-save: the page side of "Save Image As…" for SVGs (WhimsySvgSave
// is the parent). Three kinds count:
//   "img":    an <img> showing an SVG (Firefox's own Image menu row);
//   "inline": an <svg> drawn in an HTML page;
//   "doc":    an SVG document, as <object> or <embed> show one (the
//             right-click lands inside it), or an .svg opened in a tab.
// Before Firefox's menu opens, the right-click's kind goes to the parent,
// so its popupshowing can decide the rows without waiting. On use, the
// parent asks for the details (drawn size, viewBox, the colour behind,
// names) and then for the drawing itself, rendered here, in the page's own
// process: no page script runs (Xrays, and an SVG drawn as an image never
// runs script or loads anything), and nothing leaves the device.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ContentDOMReference: "resource://gre/modules/ContentDOMReference.sys.mjs",
});

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_TYPE = "image/svg+xml";
const SVG_PATH = /\.svgz?$/i;
const FEATURE_PREF = "whimsy.feature.svg-save";

function isSvgUrl(spec) {
  try {
    const url = new URL(spec);
    if (url.protocol == "data:") {
      return /^data:image\/svg\+xml[;,]/i.test(spec);
    }
    return SVG_PATH.test(url.pathname);
  } catch (e) {
    return false;
  }
}

/**
 * What kind of SVG `node` is part of, if any: { kind, element }. The
 * element is the <img>, the outermost <svg>, or the SVG document's root.
 */
export function findSvg(node) {
  if (!node) {
    return null;
  }
  if (node.nodeType != 1) {
    node = node.parentElement;
  }
  if (!node) {
    return null;
  }
  const win = node.ownerDocument?.defaultView;
  if (!win) {
    return null;
  }
  // An image element: only <img>, and only an SVG one. Any other image
  // (an SVG <image> with a PNG in it, too) keeps Firefox's menu.
  if (node instanceof Ci.nsIImageLoadingContent && node.currentURI) {
    if (!win.HTMLImageElement.isInstance(node)) {
      return null;
    }
    let type = null;
    try {
      type = node.getRequest(Ci.nsIImageLoadingContent.CURRENT_REQUEST)?.mimeType ?? null;
    } catch (e) {}
    return type == SVG_TYPE || (!type && isSvgUrl(node.currentURI.spec)) ? { kind: "img", element: node } : null;
  }
  // <object> or <embed> itself (its SVG not drawn as a document yet).
  if (win.HTMLObjectElement.isInstance(node) || win.HTMLEmbedElement.isInstance(node)) {
    const root = node.getSVGDocument?.()?.documentElement ?? null;
    return root && root.namespaceURI == SVG_NS ? { kind: "doc", element: root } : null;
  }
  let svg = node.namespaceURI == SVG_NS ? (node.localName == "svg" ? node : node.ownerSVGElement) : null;
  if (!svg) {
    return null;
  }
  // The outermost <svg>; one inside another's <foreignObject> counts as
  // the outer one.
  for (let outer = svg; outer; outer = outer.parentElement?.closest("svg")) {
    svg = outer;
    while (svg.ownerSVGElement) {
      svg = svg.ownerSVGElement;
    }
    outer = svg;
  }
  if (svg == svg.ownerDocument.documentElement) {
    return { kind: "doc", element: svg };
  }
  return { kind: "inline", element: svg };
}

/** "#RRGGBB" for a CSS colour, alpha laid over white; null if transparent. */
function solidHex(doc, value) {
  if (!value || value == "transparent") {
    return null;
  }
  const canvas = doc.createElementNS(XHTML_NS, "canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "rgba(0, 0, 0, 0)";
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  if (!a) {
    return null;
  }
  const over = c => Math.round((c * a + 255 * (255 - a)) / 255);
  return "#" + [over(r), over(g), over(b)].map(c => c.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/**
 * The solid colour behind `element`: its own background or its nearest
 * ancestor's (out of shadow roots and same-process frames), which ends
 * at body and html; else white. Gradients and images aren't copied.
 */
export function backgroundBehind(element) {
  let el = element;
  while (el) {
    const doc = el.ownerDocument;
    const win = doc.defaultView;
    let hex = null;
    try {
      hex = solidHex(doc, win.getComputedStyle(el).backgroundColor);
    } catch (e) {}
    if (hex) {
      return hex;
    }
    if (el.parentElement) {
      el = el.parentElement;
    } else if (el.parentNode?.host) {
      el = el.parentNode.host;
    } else {
      let frame = null;
      try {
        frame = win.frameElement;
      } catch (e) {}
      el = frame;
    }
  }
  return "#FFFFFF";
}

function svgTitle(svg) {
  for (const child of svg.children) {
    if (child.localName == "title" && child.namespaceURI == SVG_NS) {
      return child.textContent.replace(/\s+/g, " ").trim();
    }
  }
  return "";
}

/** The URL's file name without its extension ("" for none). */
export function urlBaseName(spec) {
  try {
    const url = new URL(spec);
    if (!["http:", "https:", "file:", "ftp:"].includes(url.protocol)) {
      return "";
    }
    let leaf = url.pathname.split("/").pop() ?? "";
    try {
      leaf = decodeURIComponent(leaf);
    } catch (e) {}
    return leaf.replace(/\.[^.]*$/, "").trim();
  } catch (e) {
    return "";
  }
}

function drawnSize(element) {
  const rect = element.getBoundingClientRect();
  let { width, height } = rect;
  if (!(width > 0 && height > 0) && element == element.ownerDocument.documentElement) {
    width = element.ownerDocument.defaultView.innerWidth;
    height = element.ownerDocument.defaultView.innerHeight;
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

// A standalone copy of an inline <svg>: its namespace, the size it's
// drawn at when it has none, and the colours it inherits from the page
// (so currentColor and inherited fills stay as shown). Scripts and event
// handlers are left out, so the file never runs the page's code.
export function serializeSvg(svg, size) {
  const win = svg.ownerDocument.defaultView;
  const clone = svg.cloneNode(true);
  for (const script of clone.querySelectorAll("script")) {
    script.remove();
  }
  for (const el of [clone, ...clone.querySelectorAll("*")]) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) {
        el.removeAttributeNode(attr);
      }
    }
  }
  if (!clone.hasAttribute("width")) {
    clone.setAttribute("width", String(size.width));
  }
  if (!clone.hasAttribute("height")) {
    clone.setAttribute("height", String(size.height));
  }
  try {
    const cs = win.getComputedStyle(svg);
    const inherited = `color: ${cs.color}; fill: ${cs.fill}; stroke: ${cs.stroke};`;
    const own = clone.getAttribute("style");
    clone.setAttribute("style", own ? `${inherited} ${own}` : inherited);
  } catch (e) {}
  return new win.XMLSerializer().serializeToString(clone);
}

export class WhimsySvgSaveChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type != "contextmenu" || !Services.prefs.getBoolPref(FEATURE_PREF, true)) {
      return;
    }
    let kind = null;
    try {
      kind = findSvg(event.composedTarget ?? event.target)?.kind ?? null;
    } catch (e) {
      // A page torn down mid-event.
    }
    this.sendAsyncMessage("WhimsySvgSave:Target", { kind });
  }

  resolve(identifier) {
    let node = null;
    try {
      node = identifier ? lazy.ContentDOMReference.resolve(identifier) : null;
    } catch (e) {
      return null;
    }
    // Only this frame's own page.
    if (!node || (node.ownerDocument ?? node) != this.document) {
      return null;
    }
    return findSvg(node);
  }

  async receiveMessage(message) {
    switch (message.name) {
      case "WhimsySvgSave:Gather":
        return this.gather(this.resolve(message.data?.target));
      case "WhimsySvgSave:Render":
        return this.render(this.resolve(message.data?.target), message.data);
    }
    return null;
  }

  gather(found) {
    if (!found) {
      return null;
    }
    const { kind, element } = found;
    const doc = element.ownerDocument;
    const size = drawnSize(element);
    // The ratio: the SVG's viewBox, else the size it's drawn at. An <img>
    // only has the intrinsic size Firefox worked out from its SVG.
    let ratio = { width: size.width, height: size.height };
    if (kind == "img") {
      if (element.naturalWidth > 0 && element.naturalHeight > 0) {
        ratio = { width: element.naturalWidth, height: element.naturalHeight };
      }
    } else {
      const box = element.viewBox?.baseVal;
      if (box && box.width > 0 && box.height > 0) {
        ratio = { width: box.width, height: box.height };
      }
    }
    const url = kind == "img" ? element.currentURI.spec : kind == "doc" ? doc.documentURI : "";
    return {
      kind,
      width: size.width,
      height: size.height,
      ratioWidth: ratio.width,
      ratioHeight: ratio.height,
      background: backgroundBehind(element),
      title: kind == "img" ? "" : svgTitle(element),
      baseName: url ? urlBaseName(url) : "",
      url,
      contentType: kind == "img" ? SVG_TYPE : kind == "doc" ? doc.contentType : SVG_TYPE,
      // The inline SVG as a file of its own (the SVG option saves this).
      markup: kind == "inline" ? serializeSvg(element, size) : null,
    };
  }

  // Draws the SVG at width × height CSS px into a canvas, over the
  // background (a "#RRGGBB", or none for clear), and returns the PNG or
  // JPEG bytes. The SVG is drawn as an image, so it stays sharp at any
  // size: the page's own <img> as it is; an inline one from its markup;
  // an SVG document from its address, loaded as the page loads images.
  async render(found, { width, height, background, type }) {
    if (!found || !(width >= 1 && height >= 1) || !["image/png", "image/jpeg"].includes(type)) {
      throw new Error("Nothing to draw");
    }
    const { kind, element } = found;
    const doc = element.ownerDocument;
    let image = element;
    if (kind != "img") {
      image = doc.createElementNS(XHTML_NS, "img");
      image.src = kind == "inline"
        ? `data:${SVG_TYPE};charset=utf-8,${encodeURIComponent(serializeSvg(element, drawnSize(element)))}`
        : doc.documentURI;
    }
    await image.decode();
    const canvas = doc.createElementNS(XHTML_NS, "canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("No canvas");
    }
    if (background || type == "image/jpeg") {
      ctx.fillStyle = background || "#FFFFFF";
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(image, 0, 0, width, height);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error("Couldn't encode"))), type, type == "image/jpeg" ? 0.92 : undefined);
    });
    return blob.arrayBuffer();
  }
}
