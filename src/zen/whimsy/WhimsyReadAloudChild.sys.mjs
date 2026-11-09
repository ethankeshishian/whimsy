/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 voice-image: read aloud, in the page. Finds what to read (the
// selection, else the article Reader View's parser finds, matched back to
// the page's own paragraphs), splits it into sentences, tints the one being
// read (a CSS highlight, so the page's DOM is never touched), and reports a
// click on a sentence so reading jumps there. Messages only.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ReaderMode: "moz-src:///toolkit/components/reader/ReaderMode.sys.mjs",
});

const BLOCKS = "h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, dd, dt, figcaption, td";
const SKIP = "script, style, noscript, template, svg, math, button, select, textarea";
const HIGHLIGHT = "whimsy-read-aloud";
const PAUSED = "whimsy-read-aloud-paused";

const normalize = text => String(text ?? "").replace(/\s+/g, " ").trim();

export class WhimsyReadAloudChild extends JSWindowActorChild {
  sentences = [];
  sheet = null;

  receiveMessage(message) {
    switch (message.name) {
      case "WhimsyReadAloud:Prepare":
        return this.prepare(message.data ?? {});
      case "WhimsyReadAloud:Mark":
        return this.mark(message.data ?? {});
      case "WhimsyReadAloud:Clear":
        return this.clear();
    }
    return null;
  }

  didDestroy() {
    this.clear();
  }

  hasSelection() {
    const selection = this.contentWindow?.getSelection();
    return !!selection && !selection.isCollapsed && !!normalize(selection.toString());
  }

  async prepare({ mode = "page", tint = "" }) {
    this.clear();
    const doc = this.document;
    let ranges = [];
    let kind = "page";
    if (mode != "here" && this.hasSelection()) {
      kind = "selection";
      const selection = this.contentWindow.getSelection();
      for (let i = 0; i < selection.rangeCount; i++) {
        ranges.push(selection.getRangeAt(i).cloneRange());
      }
    } else {
      ranges = (await this.articleBlocks(doc)).map(el => {
        const range = doc.createRange();
        range.selectNodeContents(el);
        return range;
      });
    }
    this.sentences = ranges.flatMap(range => this.split(range));
    if (!this.sentences.length) {
      return { kind, sentences: [] };
    }
    let start = 0;
    if (mode == "here") {
      const index = this.sentences.findIndex(s => s.range.getBoundingClientRect().bottom > 1);
      start = Math.max(0, index);
    }
    this.useTint(tint);
    this.contentWindow.addEventListener("click", this, true);
    return {
      kind,
      start,
      title: normalize(doc.title),
      sentences: this.sentences.map(s => s.text),
    };
  }

  // The page's own paragraphs whose text is in the article Readability finds.
  async articleBlocks(doc) {
    let article = null;
    try {
      article = await lazy.ReaderMode.parseDocument(doc);
    } catch (e) {
      article = null;
    }
    const text = normalize(article?.textContent);
    if (!text) {
      return [];
    }
    const win = this.contentWindow;
    const picked = [];
    const seen = new Set();
    const inPicked = el => {
      for (let node = el.parentElement; node; node = node.parentElement) {
        if (seen.has(node)) {
          return true;
        }
      }
      return false;
    };
    for (const el of doc.body?.querySelectorAll(BLOCKS) ?? []) {
      const own = normalize(el.textContent);
      const heading = /^h\d$/.test(el.localName);
      if (own.length < (heading ? 3 : 20) || !text.includes(own) || el.closest(SKIP) || inPicked(el)) {
        continue;
      }
      const style = win.getComputedStyle(el);
      if (style.display == "none" || style.visibility == "hidden") {
        continue;
      }
      seen.add(el);
      picked.push(el);
    }
    return picked;
  }

  // A range's text split into sentences (Intl.Segmenter), each with its own range.
  split(range) {
    const doc = this.document;
    const root = range.commonAncestorContainer;
    const nodes = [];
    const walker = doc.createTreeWalker(root.nodeType == root.TEXT_NODE ? root.parentNode : root, this.contentWindow.NodeFilter.SHOW_TEXT);
    let text = "";
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!range.intersectsNode(node) || node.parentElement?.closest(SKIP)) {
        continue;
      }
      const start = node == range.startContainer ? range.startOffset : 0;
      const end = node == range.endContainer ? range.endOffset : node.data.length;
      if (end <= start) {
        continue;
      }
      nodes.push({ node, start, at: text.length, length: end - start });
      text += node.data.slice(start, end);
    }
    if (!nodes.length) {
      return [];
    }
    const point = (index, isEnd) => {
      const hit =
        nodes.find(n => (isEnd ? index > n.at && index <= n.at + n.length : index >= n.at && index < n.at + n.length)) ??
        nodes[nodes.length - 1];
      return [hit.node, hit.start + Math.max(0, Math.min(hit.length, index - hit.at))];
    };
    const segmenter = new Intl.Segmenter(doc.documentElement.lang || undefined, { granularity: "sentence" });
    const out = [];
    for (const { segment, index } of segmenter.segment(text)) {
      const lead = segment.length - segment.trimStart().length;
      const body = segment.trim();
      if (!body || !/[\p{L}\p{N}]/u.test(body)) {
        continue;
      }
      const sentence = doc.createRange();
      sentence.setStart(...point(index + lead, false));
      sentence.setEnd(...point(index + lead + body.length, true));
      out.push({ range: sentence, text: normalize(body) });
    }
    return out;
  }

  useTint(tint) {
    const safe = /^[#a-z0-9(),.%\s-]+$/i.test(tint) ? tint : "rgb(10, 132, 255)";
    const css =
      `::highlight(${HIGHLIGHT}) { background-color: color-mix(in srgb, ${safe} 22%, transparent); }` +
      `::highlight(${PAUSED}) { background-color: color-mix(in srgb, ${safe} 11%, transparent); }` +
      // Dark pages need more of the colour to show it at all.
      `@media (prefers-color-scheme: dark) {` +
      `::highlight(${HIGHLIGHT}) { background-color: color-mix(in srgb, ${safe} 40%, transparent); }` +
      `::highlight(${PAUSED}) { background-color: color-mix(in srgb, ${safe} 20%, transparent); } }`;
    this.sheet = `data:text/css;charset=utf-8,${encodeURIComponent(css)}`;
    const utils = this.contentWindow.windowUtils;
    utils.loadSheetUsingURIString(this.sheet, utils.AUTHOR_SHEET);
  }

  mark({ index = -1, paused = false, scroll = true }) {
    const win = this.contentWindow;
    if (!win) {
      return false;
    }
    const highlights = win.CSS.highlights;
    highlights.delete(HIGHLIGHT);
    highlights.delete(PAUSED);
    const sentence = this.sentences[index];
    if (!sentence) {
      return false;
    }
    highlights.set(paused ? PAUSED : HIGHLIGHT, new win.Highlight(sentence.range));
    if (scroll) {
      const rect = sentence.range.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > win.innerHeight) {
        const reduce = win.matchMedia("(prefers-reduced-motion: reduce)").matches;
        win.scrollBy({ top: rect.top - win.innerHeight / 3, behavior: reduce ? "instant" : "smooth" });
      }
    }
    return true;
  }

  clear() {
    const win = this.contentWindow;
    if (win) {
      try {
        win.CSS.highlights.delete(HIGHLIGHT);
        win.CSS.highlights.delete(PAUSED);
        win.removeEventListener("click", this, true);
        if (this.sheet) {
          win.windowUtils.removeSheetUsingURIString(this.sheet, win.windowUtils.AUTHOR_SHEET);
        }
      } catch (e) {
        // The page is going away.
      }
    }
    this.sheet = null;
    this.sentences = [];
    return true;
  }

  // A plain click on a sentence (not a link or a control) jumps there.
  handleEvent(event) {
    if (event.type != "click" || event.button != 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    if (event.target?.closest?.("a[href], button, input, textarea, select, label, summary, [contenteditable]") || this.hasSelection()) {
      return;
    }
    const caret = this.document.caretPositionFromPoint(event.clientX, event.clientY);
    if (!caret?.offsetNode) {
      return;
    }
    const index = this.sentences.findIndex(s => {
      try {
        return s.range.comparePoint(caret.offsetNode, caret.offset) == 0;
      } catch (e) {
        return false;
      }
    });
    if (index >= 0) {
      this.sendAsyncMessage("WhimsyReadAloud:Jump", { index });
    }
  }
}
