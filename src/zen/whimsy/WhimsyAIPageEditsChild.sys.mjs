/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 page-act: the page side of page edits by description and AI page
// translation. Top frame only, messages only. It never runs code a model
// wrote and never presses anything: a change is a sheet (hide rules, and
// CSS the parent generated from allowlisted rules). Translation swaps the
// text of blocks and keeps the originals for Show original.

const BLOCKS = "p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, dt, dd, td, th, summary, caption";
const SECTION_CHARS = 1500;
const MAX_OUTLINE = 160;

function visible(el) {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) {
    return false;
  }
  const style = el.ownerDocument.defaultView.getComputedStyle(el);
  return style.visibility != "hidden" && style.display != "none";
}

// A selector that finds this element again: its id when it has a sane one,
// else a path of tag:nth-of-type steps from the nearest id or the body.
function selectorFor(el) {
  const doc = el.ownerDocument;
  const sane = id => /^[A-Za-z][\w-]{0,60}$/.test(id) && doc.querySelectorAll(`#${id}`).length == 1;
  const steps = [];
  let node = el;
  while (node && node.nodeType == 1 && node != doc.documentElement) {
    if (node.id && sane(node.id)) {
      steps.unshift(`#${node.id}`);
      return steps.join(" > ");
    }
    if (node == doc.body) {
      steps.unshift("body");
      return steps.join(" > ");
    }
    const same = [...(node.parentElement?.children ?? [])].filter(c => c.localName == node.localName);
    steps.unshift(same.length > 1 ? `${node.localName}:nth-of-type(${same.indexOf(node) + 1})` : node.localName);
    node = node.parentElement;
  }
  return steps.join(" > ");
}

export class WhimsyAIPageEditsChild extends JSWindowActorChild {
  constructor() {
    super();
    this.sheets = [];
    this.blocks = null;
  }

  receiveMessage(message) {
    switch (message.name) {
      case "WhimsyAIPageEdits:Outline":
        return this.outline();
      case "WhimsyAIPageEdits:Apply":
        return this.apply(message.data);
      case "WhimsyAIPageEdits:Revert":
        return this.revert();
      case "WhimsyAIPageEdits:Sections":
        return this.sections();
      case "WhimsyAIPageEdits:Translate":
        return this.translate(message.data);
      case "WhimsyAIPageEdits:Original":
        return this.original();
    }
    return null;
  }

  get utils() {
    return this.contentWindow.windowUtils;
  }

  // The page's parts a sentence can name: landmarks, things with ids and
  // classes, with a few words of their text. Page words are data.
  outline() {
    const doc = this.document;
    const out = [];
    const seen = new Set();
    const candidates = doc.body?.querySelectorAll("header, nav, aside, footer, main, article, section, form, dialog, iframe, details, summary, button, [role], [id], [class]") ?? [];
    for (const el of candidates) {
      if (out.length >= MAX_OUTLINE) {
        break;
      }
      if (!visible(el) || el.closest("[whimsy-ai-fill]")) {
        continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width * r.height < 400 && !el.matches("button, summary, [aria-expanded]")) {
        continue;
      }
      const selector = selectorFor(el);
      if (seen.has(selector)) {
        continue;
      }
      seen.add(selector);
      out.push({
        selector,
        tag: el.localName,
        role: el.getAttribute("role") ?? "",
        id: el.id.slice(0, 40),
        classes: [...el.classList].slice(0, 4).join(" ").slice(0, 80),
        label: (el.getAttribute("aria-label") ?? "").slice(0, 60),
        text: el.textContent.replace(/\s+/g, " ").trim().slice(0, 60),
        size: `${Math.round(r.width)}x${Math.round(r.height)}`,
        count: el.matches("button, summary, [aria-expanded=false]") ? 1 : undefined,
      });
    }
    return { title: doc.title, outline: out };
  }

  /**
   * hide: selectors to hide; css: CSS the parent generated. Returns which
   * hide selectors matched here (only those are ever kept).
   */
  async apply({ hide = [], css = "" }) {
    const doc = this.document;
    const valid = s => {
      try {
        return doc.querySelectorAll(s).length;
      } catch {
        return 0;
      }
    };
    const hidden = hide.filter(s => typeof s == "string" && valid(s) > 0);
    const rules = [hidden.length ? `${hidden.join(",\n")} { display: none !important; }` : "", css].filter(Boolean).join("\n");
    if (rules) {
      const uri = `data:text/css,${encodeURIComponent(rules)}`;
      const load = () => {
        if (!this.sheets.includes(uri)) {
          this.utils.loadSheetUsingURIString(uri, this.utils.AUTHOR_SHEET);
          this.sheets.push(uri);
        }
      };
      // The new look swaps in with a crossfade of the page (a view
      // transition's default fade); reduced motion and background tabs
      // swap instantly.
      const reduce = this.contentWindow.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!reduce && doc.visibilityState == "visible" && typeof doc.startViewTransition == "function") {
        try {
          await doc.startViewTransition(load).updateCallbackDone;
        } catch {}
      }
      load();
    }
    return { hidden: hidden.length, matched: hidden, missing: hide.length - hidden.length, styled: !!css };
  }

  revert() {
    for (const uri of this.sheets.splice(0)) {
      try {
        this.utils.removeSheetUsingURIString(uri, this.utils.AUTHOR_SHEET);
      } catch {}
    }
    return true;
  }

  // --- Translation ---

  sections() {
    const doc = this.document;
    const blocks = [...(doc.body?.querySelectorAll(BLOCKS) ?? [])].filter(
      el => !el.querySelector(BLOCKS) && el.textContent.trim().length > 1 && !el.closest("script, style, noscript, [contenteditable], textarea, pre, code")
    );
    this.blocks = blocks.map(el => ({ el, original: [...el.childNodes].map(n => n.cloneNode(true)) }));
    const sections = [];
    let current = [];
    let size = 0;
    for (const [i, b] of this.blocks.entries()) {
      const text = b.el.textContent.replace(/\s+/g, " ").trim();
      if (size + text.length > SECTION_CHARS && current.length) {
        sections.push(current);
        current = [];
        size = 0;
      }
      current.push({ i, text });
      size += text.length;
    }
    if (current.length) {
      sections.push(current);
    }
    return { lang: doc.documentElement.lang || "", sections };
  }

  translate({ items = [] }) {
    const reduce = this.contentWindow.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const { i, text } of items) {
      const block = this.blocks?.[i];
      if (!block?.el.isConnected || typeof text != "string") {
        continue;
      }
      block.el.textContent = text;
      if (!reduce) {
        block.el.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)" });
      }
    }
    return true;
  }

  original() {
    for (const block of this.blocks ?? []) {
      if (block.el.isConnected) {
        block.el.replaceChildren(...block.original.map(n => n.cloneNode(true)));
      }
    }
    return true;
  }
}
