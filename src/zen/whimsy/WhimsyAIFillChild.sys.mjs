/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 page-act: the page side of Draft reply and Form fill. Messages only;
// it never presses a button, never submits a form, and never touches a
// password, card, or one-time-code field (WhimsyAISensitive). Words the
// parent formats (tags) live in a closed shadow root the page can't read.

import { classifyField, isSensitiveFrame } from "resource:///modules/whimsy/WhimsyAISensitive.sys.mjs";
import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const FIELD_SELECTOR = "input, textarea, select, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']";
const TEXT_TYPES = new Set(["", "text", "email", "tel", "url", "search", "number", "date", "month"]);
const REPLY_WORDS = /\b(comment|reply|respond|response|message|answer|write|compose|post|add a)\b/i;
const MAX_FIELDS = 80;
const STAGGER_MS = 80;

const LOOK_CSS = `
[whimsy-ai-fill="filled"] { background-color: color-mix(in srgb, #0a84ff 12%, Field) !important; transition: background-color 240ms cubic-bezier(.2,.8,.2,1) !important; }
[whimsy-ai-fill="unsure"] { border-color: rgb(217, 138, 0) !important; box-shadow: 0 0 0 3px rgba(217, 138, 0, .22) !important; outline: none !important; }
[whimsy-ai-fill="left"] { border-style: dashed !important; }
@media (prefers-reduced-motion: reduce) { [whimsy-ai-fill] { transition: none !important; } }
`;

const TAG_CSS = `
:host { all: initial; position: absolute; z-index: 2147483646; pointer-events: none; }
.tag { display: inline-flex; align-items: center; gap: 4px; font: 500 11px/1.3 -apple-system, system-ui, sans-serif; white-space: nowrap; }
.tag::before { content: ""; width: 11px; height: 11px; background: currentColor; mask: var(--icon) center / contain no-repeat; }
.tag[data-look="filled"] { color: light-dark(#0062cc, #4da3ff); --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6z'/%3E%3C/svg%3E"); }
.tag[data-look="unsure"] { color: light-dark(#8a5a00, rgb(240, 177, 60)); --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M8 1l7 13H1zM7.25 6v4h1.5V6zm0 5v1.5h1.5V11z'/%3E%3C/svg%3E"); }
.tag[data-look="left"] { color: light-dark(#6e6e73, #98989d); --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 7V5a4 4 0 018 0v2h1v8H3V7zm2 0h4V5a2 2 0 00-4 0z'/%3E%3C/svg%3E"); }
`;

function visible(el) {
  const win = el.ownerDocument?.defaultView;
  if (!win || el.disabled || el.readOnly || el.type == "hidden") {
    return false;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) {
    return false;
  }
  // Pushed off the page (left: -9999px) counts as hidden.
  if (rect.right + win.scrollX <= 0 || rect.bottom + win.scrollY <= 0) {
    return false;
  }
  const style = win.getComputedStyle(el);
  return style.visibility != "hidden" && style.display != "none" && Number(style.opacity) > 0.05;
}

function isEditable(el) {
  if (el.localName == "textarea") {
    return true;
  }
  if (el.localName == "input") {
    return TEXT_TYPES.has((el.getAttribute("type") ?? "").toLowerCase()) || el.type == "password";
  }
  if (el.localName == "select") {
    return true;
  }
  return el.isContentEditable;
}

function labelOf(el) {
  const doc = el.ownerDocument;
  const parts = [];
  for (const label of el.labels ?? []) {
    parts.push(label.textContent);
  }
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    for (const id of by.split(/\s+/)) {
      parts.push(doc.getElementById(id)?.textContent ?? "");
    }
  }
  parts.push(el.getAttribute("aria-label") ?? "", el.getAttribute("placeholder") ?? "");
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  return text.slice(0, 120) || (el.getAttribute("name") ?? el.id ?? "").slice(0, 60);
}

function valueOf(el) {
  return el.isContentEditable && el.localName != "input" && el.localName != "textarea" ? el.textContent : el.value ?? "";
}

export class WhimsyAIFillChild extends JSWindowActorChild {
  constructor() {
    super();
    this.touched = new WeakSet();
    this.fields = [];
    this.tags = [];
    this.sheet = false;
    this.listening = false;
  }

  receiveMessage(message) {
    switch (message.name) {
      case "WhimsyAIFill:FindReply":
        return this.findReply();
      case "WhimsyAIFill:WriteReply":
        return this.writeReply(message.data);
      case "WhimsyAIFill:Fields":
        return this.collect();
      case "WhimsyAIFill:Fill":
        return this.fill(message.data);
      case "WhimsyAIFill:Clear":
        return this.clear();
    }
    return null;
  }

  get sensitiveFrame() {
    try {
      return isSensitiveFrame(this.manager);
    } catch {
      return false;
    }
  }

  // --- Draft reply ---

  replyBox() {
    const doc = this.document;
    const usable = el => isEditable(el) && el.localName != "select" && el.localName != "input" && visible(el) && !classifyField(el);
    const active = doc.activeElement;
    if (active && active != doc.body && usable(active)) {
      return active;
    }
    const candidates = [...doc.querySelectorAll("textarea, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']")].filter(usable);
    if (!candidates.length) {
      return null;
    }
    const named = candidates.find(el => REPLY_WORDS.test(`${labelOf(el)} ${el.getAttribute("name") ?? ""} ${el.id}`));
    if (named) {
      return named;
    }
    const area = el => {
      const r = el.getBoundingClientRect();
      return r.width * r.height;
    };
    return candidates.sort((a, b) => area(b) - area(a))[0];
  }

  findReply() {
    if (this.sensitiveFrame) {
      return { found: false };
    }
    const box = this.replyBox();
    if (!box) {
      return { found: false };
    }
    const existing = valueOf(box).trim();
    return { found: true, hasText: !!existing, existing: existing.slice(0, 80), label: labelOf(box) };
  }

  writeReply({ text, mode = "replace" }) {
    const box = this.replyBox();
    if (!box || this.sensitiveFrame) {
      return { ok: false };
    }
    const draft = String(text ?? "");
    const before = valueOf(box);
    const joined = mode == "insert-after" && before.trim() ? `${before.replace(/\s+$/, "")}\n\n` : "";
    const full = joined + draft;
    if (box.localName == "textarea") {
      box.focus();
      box.setUserInput(full);
      box.setSelectionRange(joined.length, full.length);
    } else {
      box.focus();
      const sel = this.contentWindow.getSelection();
      const range = this.document.createRange();
      range.selectNodeContents(box);
      if (joined) {
        range.collapse(false);
      }
      sel.removeAllRanges();
      sel.addRange(range);
      this.document.execCommand("insertText", false, joined ? `\n\n${draft}` : draft);
      // Select what was written.
      const after = this.document.createRange();
      const walker = this.document.createTreeWalker(box, this.contentWindow.NodeFilter.SHOW_TEXT);
      let node;
      let start = null;
      let end = null;
      while ((node = walker.nextNode())) {
        const at = node.data.indexOf(draft.slice(0, 20));
        if (start == null && at >= 0) {
          start = { node, at };
        }
        end = node;
      }
      if (start && end) {
        after.setStart(start.node, start.at);
        after.setEnd(end, end.data.length);
        sel.removeAllRanges();
        sel.addRange(after);
      }
    }
    const reduce = this.contentWindow.matchMedia("(prefers-reduced-motion: reduce)").matches;
    box.scrollIntoView({ block: "nearest", behavior: reduce ? "instant" : "smooth" });
    return { ok: true };
  }

  // --- Form fill ---

  collect() {
    const doc = this.document;
    const secretFrame = this.sensitiveFrame;
    this.fields = [...doc.querySelectorAll(FIELD_SELECTOR)].filter(el => isEditable(el) && visible(el)).slice(0, MAX_FIELDS);
    // From here on, a field the person types in is theirs.
    this.listen();
    this.snapshot = new Map(this.fields.map(el => [el, valueOf(el)]));
    return {
      secretFrame,
      fields: this.fields.map((el, index) => {
        const sensitive = secretFrame ? "card" : classifyField(el);
        return {
          index,
          label: labelOf(el),
          tag: el.localName,
          type: (el.getAttribute("type") ?? "").toLowerCase(),
          autocomplete: (el.getAttribute("autocomplete") ?? "").toLowerCase(),
          name: (el.getAttribute("name") ?? el.id ?? "").slice(0, 60),
          options: el.localName == "select" ? [...el.options].slice(0, 60).map(o => o.textContent.trim()) : undefined,
          // Values of secret fields never leave the page.
          filled: sensitive ? false : !!valueOf(el).trim(),
          sensitive: sensitive || null,
          focused: doc.activeElement == el,
          extensionMenu: this.extensionMenuNear(el),
        };
      }),
    };
  }

  // An extension's own menu (1Password, Bitwarden…) is a moz-extension
  // frame laid over the page near the field. While one is open, skip it.
  extensionMenuNear(el) {
    const r = el.getBoundingClientRect();
    for (const frame of this.document.querySelectorAll("iframe")) {
      if (!String(frame.src).startsWith("moz-extension:") || !visible(frame)) {
        continue;
      }
      const f = frame.getBoundingClientRect();
      const near = f.top < r.bottom + 400 && f.bottom > r.top - 40 && f.left < r.right + 40 && f.right > r.left - 40;
      if (near) {
        return true;
      }
    }
    return false;
  }

  ensureSheet() {
    if (this.sheet) {
      return;
    }
    const utils = this.contentWindow.windowUtils;
    utils.loadSheetUsingURIString(`data:text/css,${encodeURIComponent(LOOK_CSS)}`, utils.AGENT_SHEET);
    this.sheet = true;
  }

  listen() {
    if (this.listening) {
      return;
    }
    this.listening = true;
    const mark = event => {
      if (!event.isTrusted) {
        return;
      }
      const target = event.composedTarget ?? event.target;
      if (target?.nodeType == 1) {
        this.touched.add(target);
        // Fixing a field by hand clears its look; nothing refills it.
        if (target.hasAttribute?.("whimsy-ai-fill") && event.type == "input") {
          target.removeAttribute("whimsy-ai-fill");
          this.tags.find(t => t.field == target)?.host.remove();
        }
      }
    };
    this.contentWindow.addEventListener("keydown", mark, { capture: true, mozSystemGroup: true });
    this.contentWindow.addEventListener("input", mark, { capture: true, mozSystemGroup: true });
  }

  tag(el, look, text) {
    if (!text) {
      return;
    }
    const doc = this.document;
    const host = doc.createElement("div");
    const root = host.attachShadow({ mode: "closed" });
    const style = doc.createElement("style");
    style.textContent = TAG_CSS;
    const span = doc.createElement("span");
    span.className = "tag";
    span.dataset.look = look;
    span.textContent = text;
    root.append(style, span);
    const r = el.getBoundingClientRect();
    const win = this.contentWindow;
    host.style.setProperty("position", "absolute", "important");
    host.style.setProperty("left", `${r.left + win.scrollX}px`, "important");
    host.style.setProperty("top", `${r.bottom + win.scrollY + 3}px`, "important");
    host.setAttribute("aria-hidden", "true");
    doc.documentElement.append(host);
    this.tags.push({ field: el, host });
  }

  write(el, value) {
    if (el.localName == "select") {
      const want = String(value).toLowerCase();
      const option = [...el.options].find(o => o.value.toLowerCase() == want || o.textContent.trim().toLowerCase() == want);
      if (!option) {
        return false;
      }
      el.value = option.value;
      el.dispatchEvent(new this.contentWindow.Event("change", { bubbles: true }));
      return true;
    }
    if (el.localName == "input" || el.localName == "textarea") {
      el.setUserInput(String(value));
      return true;
    }
    return false;
  }

  /**
   * items: [{index, value, look: "filled"|"unsure", tag}], left: [{index,
   * tag}]. Fills top to bottom, 80ms apart (no stagger with reduced
   * motion). A field the person typed in, focused with a menu open, or
   * that turned secret, is skipped. Never submits.
   */
  async fill({ items = [], left = [], skip = [] }) {
    this.ensureSheet();
    this.listen();
    const reduce = this.contentWindow.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const snapshot = this.snapshot ?? new Map();
    const filled = [];
    const skipped = [];
    for (const { index, tag } of left) {
      const el = this.fields[index];
      if (el?.isConnected) {
        el.setAttribute("whimsy-ai-fill", "left");
        this.tag(el, "left", tag);
      }
    }
    for (const item of items) {
      const el = this.fields[item.index];
      if (!el?.isConnected) {
        continue;
      }
      // Typing in a field skips it, and so does an open menu on it.
      const typed = this.touched.has(el) || (snapshot.has(el) && valueOf(el) != snapshot.get(el));
      if (typed || skip.includes(item.index) || this.extensionMenuNear(el) || classifyField(el) || this.sensitiveFrame) {
        skipped.push(item.index);
        continue;
      }
      if (!this.write(el, item.value)) {
        skipped.push(item.index);
        continue;
      }
      el.setAttribute("whimsy-ai-fill", item.look == "unsure" ? "unsure" : "filled");
      this.tag(el, item.look == "unsure" ? "unsure" : "filled", item.tag);
      filled.push(item.index);
      if (!reduce) {
        await new Promise(r => setTimeout(r, STAGGER_MS));
      }
    }
    return { filled, skipped };
  }

  clear() {
    for (const el of this.document.querySelectorAll("[whimsy-ai-fill]")) {
      el.removeAttribute("whimsy-ai-fill");
    }
    for (const { host } of this.tags) {
      host.remove();
    }
    this.tags = [];
    return true;
  }
}
