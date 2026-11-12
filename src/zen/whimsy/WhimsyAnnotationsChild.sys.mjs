/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const CONTEXT_CHARS = 32;
const STYLE_ID = "whimsy-annotations-content-style";
const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEXTAREA",
  "INPUT",
  "SELECT",
  "OPTION",
  "HEAD",
  "SVG",
  "MATH",
]);

const CONTENT_CSS = `
mark.whimsy-annotation-mark {
  all: unset;
  display: inline;
  font: inherit;
  color: inherit;
  line-height: inherit;
  letter-spacing: inherit;
  word-spacing: inherit;
  padding: 1px 0;
  margin: 0;
  border: 0;
  border-radius: 2px;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  cursor: pointer;
  transition: background-color 120ms ease, box-shadow 120ms ease;
}
mark.whimsy-annotation-mark[data-color="yellow"] {
  background-color: light-dark(rgba(253, 224, 71, 0.45), rgba(250, 204, 21, 0.28));
}
mark.whimsy-annotation-mark[data-color="green"] {
  background-color: light-dark(rgba(134, 239, 172, 0.45), rgba(74, 222, 128, 0.25));
}
mark.whimsy-annotation-mark[data-color="blue"] {
  background-color: light-dark(rgba(147, 197, 253, 0.45), rgba(96, 165, 250, 0.28));
}
mark.whimsy-annotation-mark[data-color="pink"] {
  background-color: light-dark(rgba(249, 168, 212, 0.45), rgba(244, 114, 182, 0.28));
}
mark.whimsy-annotation-mark[data-has-note="true"][data-color="yellow"] {
  box-shadow: inset 0 -1.5px 0 light-dark(rgba(202, 138, 4, 0.55), rgba(250, 204, 21, 0.55));
}
mark.whimsy-annotation-mark[data-has-note="true"][data-color="green"] {
  box-shadow: inset 0 -1.5px 0 light-dark(rgba(22, 163, 74, 0.55), rgba(74, 222, 128, 0.55));
}
mark.whimsy-annotation-mark[data-has-note="true"][data-color="blue"] {
  box-shadow: inset 0 -1.5px 0 light-dark(rgba(37, 99, 235, 0.55), rgba(96, 165, 250, 0.55));
}
mark.whimsy-annotation-mark[data-has-note="true"][data-color="pink"] {
  box-shadow: inset 0 -1.5px 0 light-dark(rgba(219, 39, 119, 0.55), rgba(244, 114, 182, 0.55));
}
/* W25 designfix: the pulse and the note pin wear their highlight's own
   colour (one of the four approved ones), as the mockup's pins do, never
   an off-system accent. Page content can't read chrome tokens. */
:is(mark.whimsy-annotation-mark, span.whimsy-annotation-pin)[data-color="yellow"] {
  --whimsy-hl-edge: light-dark(#eab308, #facc15);
}
:is(mark.whimsy-annotation-mark, span.whimsy-annotation-pin)[data-color="green"] {
  --whimsy-hl-edge: light-dark(#22c55e, #4ade80);
}
:is(mark.whimsy-annotation-mark, span.whimsy-annotation-pin)[data-color="blue"] {
  --whimsy-hl-edge: light-dark(#3b82f6, #60a5fa);
}
:is(mark.whimsy-annotation-mark, span.whimsy-annotation-pin)[data-color="pink"] {
  --whimsy-hl-edge: light-dark(#ec4899, #f472b6);
}
mark.whimsy-annotation-mark[data-pulse="true"] {
  outline: 2px solid var(--whimsy-hl-edge, light-dark(#eab308, #facc15));
  outline-offset: 1px;
}
span.whimsy-annotation-pin {
  all: unset;
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-left: 2px;
  vertical-align: super;
  border-radius: 999px;
  background-color: var(--whimsy-hl-edge, light-dark(#eab308, #facc15));
  cursor: pointer;
  user-select: none;
}
::highlight(whimsy-hl-yellow) {
  background-color: light-dark(rgba(253, 224, 71, 0.45), rgba(250, 204, 21, 0.28));
}
::highlight(whimsy-hl-green) {
  background-color: light-dark(rgba(134, 239, 172, 0.45), rgba(74, 222, 128, 0.25));
}
::highlight(whimsy-hl-blue) {
  background-color: light-dark(rgba(147, 197, 253, 0.45), rgba(96, 165, 250, 0.28));
}
::highlight(whimsy-hl-pink) {
  background-color: light-dark(rgba(249, 168, 212, 0.45), rgba(244, 114, 182, 0.28));
}
`;

export class WhimsyAnnotationsChild extends JSWindowActorChild {
  #clickAdded = false;

  handleEvent(event) {
    if (event.type === "DOMContentLoaded" || event.type === "pageshow") {
      const doc = this.document;
      if (!doc || !doc.body || this.browsingContext !== this.browsingContext?.top) {
        return;
      }
      const href = doc.location?.href || "";
      if (
        !href ||
        href.startsWith("about:") ||
        href.startsWith("chrome:") ||
        href.startsWith("moz-extension:")
      ) {
        return;
      }
      try {
        this.sendAsyncMessage("WhimsyAnnotations:PageReady", {
          url: href,
          title: doc.title || "",
        });
      } catch {}
      return;
    }

    if (event.type === "click") {
      if (event.button !== 0 || event.defaultPrevented) {
        return;
      }
      const target =
        event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
      if (!target?.closest) {
        return;
      }
      const mark = target.closest(
        "mark.whimsy-annotation-mark, span.whimsy-annotation-pin"
      );
      if (!mark) {
        return;
      }
      const id = mark.getAttribute("data-whimsy-highlight-id");
      if (!id) {
        return;
      }
      const sel = this.contentWindow?.getSelection?.();
      if (sel && !sel.isCollapsed && String(sel).trim().length > 0) {
        return;
      }
      event.stopPropagation();
      const rect = this.#rectForHighlight(id) || this.#clientRectToScreen(mark.getBoundingClientRect());
      try {
        this.sendAsyncMessage("WhimsyAnnotations:ClickHighlight", {
          id,
          rect,
        });
      } catch {}
    }
  }

  async receiveMessage(message) {
    switch (message.name) {
      case "WhimsyAnnotations:CaptureSelection":
        return this.#captureSelection();
      case "WhimsyAnnotations:Render":
        return this.#renderHighlights(message.data?.highlights || []);
      case "WhimsyAnnotations:ScrollToHighlight":
        return this.#scrollToHighlight(message.data?.id);
      case "WhimsyAnnotations:GetHighlightRect":
        return this.#rectForHighlight(message.data?.id);
    }
    return null;
  }

  #isEditableNode(node) {
    let el = node?.nodeType === 1 ? node : node?.parentElement;
    while (el) {
      const tag = el.tagName?.toUpperCase?.() || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return true;
      }
      if (el.isContentEditable) {
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  #collectTextMap(root) {
    const doc = root?.ownerDocument || this.document;
    const nodes = [];
    let fullText = "";
    if (!root || !doc) {
      return { nodes, fullText };
    }
    const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) {
          return 2; /* FILTER_REJECT */
        }
        if (parent.classList?.contains("whimsy-annotation-pin")) {
          return 2;
        }
        let cur = parent;
        while (cur && cur !== root) {
          if (SKIP_TAGS.has(cur.tagName?.toUpperCase?.())) {
            return 2;
          }
          cur = cur.parentElement;
        }
        return 1; /* FILTER_ACCEPT */
      },
    });
    let current;
    while ((current = walker.nextNode())) {
      const value = current.nodeValue || "";
      if (!value.length) {
        continue;
      }
      const start = fullText.length;
      fullText += value;
      nodes.push({
        node: current,
        start,
        end: fullText.length,
      });
    }
    return { nodes, fullText };
  }

  #offsetInTextMap(nodes, container, offsetInContainer) {
    const doc = this.document;
    if (!doc?.body || !container) {
      return -1;
    }
    if (container.nodeType === 3 /* TEXT_NODE */) {
      for (const entry of nodes) {
        if (entry.node === container) {
          return entry.start + Math.min(offsetInContainer, entry.end - entry.start);
        }
      }
    }
    try {
      const prefixRange = doc.createRange();
      prefixRange.selectNodeContents(doc.body);
      prefixRange.setEnd(container, offsetInContainer);
      return prefixRange.toString().length;
    } catch {
      return -1;
    }
  }

  #captureSelection() {
    const win = this.contentWindow;
    const doc = this.document;
    if (!win || !doc?.body) {
      return null;
    }
    const sel = win.getSelection?.();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      return null;
    }
    const range = sel.getRangeAt(0);
    if (
      this.#isEditableNode(range.startContainer) ||
      this.#isEditableNode(range.endContainer)
    ) {
      return null;
    }
    const rawText = range.toString();
    if (!rawText || !rawText.trim()) {
      return null;
    }

    const { nodes, fullText } = this.#collectTextMap(doc.body);
    let startOffset = this.#offsetInTextMap(
      nodes,
      range.startContainer,
      range.startOffset
    );
    if (
      startOffset < 0 ||
      fullText.slice(startOffset, startOffset + rawText.length) !== rawText
    ) {
      const idx = fullText.indexOf(rawText);
      startOffset = idx >= 0 ? idx : 0;
    }
    const endOffset = startOffset + rawText.length;
    const prefix = fullText.slice(Math.max(0, startOffset - CONTEXT_CHARS), startOffset);
    const suffix = fullText.slice(endOffset, endOffset + CONTEXT_CHARS);
    const clientRect = range.getBoundingClientRect();
    const rect = this.#clientRectToScreen(clientRect);

    return {
      text: rawText,
      prefix,
      suffix,
      startOffset,
      rect,
      url: doc.location?.href || "",
      title: doc.title || "",
    };
  }

  #clientRectToScreen(rect) {
    const win = this.contentWindow;
    const left = Number(rect?.left || 0);
    const top = Number(rect?.top || 0);
    const width = Math.max(1, Number(rect?.width || 0));
    const height = Math.max(1, Number(rect?.height || 0));
    const screenX = (win?.mozInnerScreenX || 0) + left;
    const screenY = (win?.mozInnerScreenY || 0) + top;
    return {
      left,
      top,
      width,
      height,
      screenX,
      screenY,
    };
  }

  #ensureStylesheet() {
    const doc = this.document;
    if (!doc) {
      return;
    }
    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CONTENT_CSS;
      (doc.head || doc.documentElement).appendChild(style);
    }
    if (!this.#clickAdded) {
      this.#clickAdded = true;
      doc.addEventListener("click", this, true);
    }
  }

  #clearRenderedHighlights() {
    const doc = this.document;
    if (!doc?.body) {
      return;
    }
    for (const pin of doc.querySelectorAll("span.whimsy-annotation-pin")) {
      pin.remove();
    }
    const parentsToNormalize = new Set();
    for (const mark of doc.querySelectorAll("mark.whimsy-annotation-mark")) {
      const parent = mark.parentNode;
      if (!parent) {
        continue;
      }
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark);
      }
      parent.removeChild(mark);
      parentsToNormalize.add(parent);
    }
    for (const parent of parentsToNormalize) {
      try {
        parent.normalize();
      } catch {}
    }
    try {
      const reg = this.contentWindow?.CSS?.highlights;
      if (reg) {
        reg.delete("whimsy-hl-yellow");
        reg.delete("whimsy-hl-green");
        reg.delete("whimsy-hl-blue");
        reg.delete("whimsy-hl-pink");
      }
    } catch {}
  }

  #scoreCandidate(fullText, idx, len, anchor) {
    let score = 0;
    const prefix = String(anchor.prefix || "");
    const suffix = String(anchor.suffix || "");
    if (prefix) {
      const actualPrefix = fullText.slice(Math.max(0, idx - prefix.length), idx);
      // Suffix of prefix (closest to quote start)
      let matched = 0;
      for (let i = 1; i <= Math.min(prefix.length, actualPrefix.length); i++) {
        if (prefix[prefix.length - i] === actualPrefix[actualPrefix.length - i]) {
          matched++;
        } else {
          break;
        }
      }
      score += matched * 3;
      if (actualPrefix === prefix) {
        score += 25;
      }
    }
    if (suffix) {
      const actualSuffix = fullText.slice(idx + len, idx + len + suffix.length);
      let matched = 0;
      for (let i = 0; i < Math.min(suffix.length, actualSuffix.length); i++) {
        if (suffix[i] === actualSuffix[i]) {
          matched++;
        } else {
          break;
        }
      }
      score += matched * 3;
      if (actualSuffix === suffix) {
        score += 25;
      }
    }
    if (Number.isFinite(anchor.startOffset) && anchor.startOffset >= 0) {
      const dist = Math.abs(idx - anchor.startOffset);
      score += Math.max(0, 20 - Math.floor(dist / 64));
    }
    return score;
  }

  #findSpanInText(fullText, anchor) {
    const quote = String(anchor?.text || "");
    if (!quote || !fullText) {
      return null;
    }

    // 1. Exact check at stored startOffset first.
    if (
      Number.isFinite(anchor.startOffset) &&
      anchor.startOffset >= 0 &&
      fullText.slice(anchor.startOffset, anchor.startOffset + quote.length) === quote
    ) {
      const prefix = String(anchor.prefix || "");
      const suffix = String(anchor.suffix || "");
      const actualPre = fullText.slice(
        Math.max(0, anchor.startOffset - prefix.length),
        anchor.startOffset
      );
      const actualSuf = fullText.slice(
        anchor.startOffset + quote.length,
        anchor.startOffset + quote.length + suffix.length
      );
      if (actualPre === prefix && actualSuf === suffix) {
        return { start: anchor.startOffset, end: anchor.startOffset + quote.length };
      }
    }

    // 2. Search all exact occurrences of quote and score by prefix/suffix context + offset.
    const candidates = [];
    let searchFrom = 0;
    while (searchFrom <= fullText.length - quote.length) {
      const idx = fullText.indexOf(quote, searchFrom);
      if (idx === -1) {
        break;
      }
      candidates.push({
        start: idx,
        end: idx + quote.length,
        score: this.#scoreCandidate(fullText, idx, quote.length, anchor),
      });
      searchFrom = idx + 1;
    }

    if (candidates.length === 1) {
      return { start: candidates[0].start, end: candidates[0].end };
    }
    if (candidates.length > 1) {
      candidates.sort((a, b) => b.score - a.score);
      return { start: candidates[0].start, end: candidates[0].end };
    }

    // 3. Whitespace-tolerant match (e.g., reflowed newlines/spaces inside quote).
    const trimmed = quote.trim();
    if (!trimmed) {
      return null;
    }
    const escaped = trimmed
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\s+/g, "\\s+");
    try {
      const re = new RegExp(escaped, "g");
      let match;
      while ((match = re.exec(fullText)) !== null) {
        const idx = match.index;
        const len = match[0].length;
        candidates.push({
          start: idx,
          end: idx + len,
          score: this.#scoreCandidate(fullText, idx, len, anchor),
        });
      }
      if (candidates.length) {
        candidates.sort((a, b) => b.score - a.score);
        return { start: candidates[0].start, end: candidates[0].end };
      }
    } catch {}

    return null;
  }

  #wrapSpan(nodes, start, end, highlight) {
    const doc = this.document;
    if (!doc || end <= start) {
      return [];
    }
    const overlapping = [];
    for (const entry of nodes) {
      if (entry.end <= start) {
        continue;
      }
      if (entry.start >= end) {
        break;
      }
      overlapping.push({
        node: entry.node,
        localStart: Math.max(0, start - entry.start),
        localEnd: Math.min(entry.end - entry.start, end - entry.start),
      });
    }

    const createdMarks = [];
    const color = ["yellow", "green", "blue", "pink"].includes(highlight.color)
      ? highlight.color
      : "yellow";
    const hasNote = Boolean(highlight.note && String(highlight.note).trim());

    // Wrap from last segment to first so splitting text nodes doesn't invalidate earlier entries.
    for (let i = overlapping.length - 1; i >= 0; i--) {
      const seg = overlapping[i];
      let targetNode = seg.node;
      if (!targetNode?.parentNode || seg.localEnd <= seg.localStart) {
        continue;
      }
      try {
        if (seg.localEnd < targetNode.nodeValue.length) {
          targetNode.splitText(seg.localEnd);
        }
        if (seg.localStart > 0) {
          targetNode = targetNode.splitText(seg.localStart);
        }
        const mark = doc.createElement("mark");
        mark.className = "whimsy-annotation-mark";
        mark.setAttribute("data-whimsy-highlight-id", highlight.id);
        mark.setAttribute("data-color", color);
        mark.setAttribute("data-has-note", hasNote ? "true" : "false");
        if (hasNote) {
          mark.setAttribute("title", String(highlight.note).trim());
        }
        targetNode.parentNode.insertBefore(mark, targetNode);
        mark.appendChild(targetNode);
        createdMarks.unshift(mark);
      } catch {}
    }

    if (hasNote && createdMarks.length) {
      const lastMark = createdMarks[createdMarks.length - 1];
      const pin = doc.createElement("span");
      pin.className = "whimsy-annotation-pin";
      pin.setAttribute("data-color", color);
      pin.setAttribute("data-whimsy-highlight-id", highlight.id);
      pin.setAttribute("title", String(highlight.note).trim());
      lastMark.after(pin);
    }

    return createdMarks;
  }

  #renderHighlights(highlights) {
    const doc = this.document;
    if (!doc?.body) {
      return { anchoredIds: [], droppedIds: [] };
    }
    this.#clearRenderedHighlights();
    if (!Array.isArray(highlights) || !highlights.length) {
      doc.documentElement?.removeAttribute("data-whimsy-annotations-count");
      return { anchoredIds: [], droppedIds: [] };
    }

    this.#ensureStylesheet();
    const anchoredIds = [];
    const droppedIds = [];
    const byColorRanges = {
      yellow: [],
      green: [],
      blue: [],
      pink: [],
    };

    for (const hl of highlights) {
      if (!hl?.id || !hl?.text) {
        continue;
      }
      const { nodes, fullText } = this.#collectTextMap(doc.body);
      const span = this.#findSpanInText(fullText, hl);
      if (!span) {
        droppedIds.push(hl.id);
        continue;
      }
      const marks = this.#wrapSpan(nodes, span.start, span.end, hl);
      if (marks.length) {
        anchoredIds.push(hl.id);
        const color = ["yellow", "green", "blue", "pink"].includes(hl.color)
          ? hl.color
          : "yellow";
        for (const mark of marks) {
          try {
            const r = doc.createRange();
            r.selectNodeContents(mark);
            byColorRanges[color].push(r);
          } catch {}
        }
      } else {
        droppedIds.push(hl.id);
      }
    }

    try {
      const win = this.contentWindow;
      if (win?.CSS?.highlights && typeof win.Highlight === "function") {
        for (const [color, ranges] of Object.entries(byColorRanges)) {
          const key = `whimsy-hl-${color}`;
          if (ranges.length) {
            win.CSS.highlights.set(key, new win.Highlight(...ranges));
          } else {
            win.CSS.highlights.delete(key);
          }
        }
      }
    } catch {}

    if (anchoredIds.length) {
      doc.documentElement?.setAttribute(
        "data-whimsy-annotations-count",
        String(anchoredIds.length)
      );
    } else {
      doc.documentElement?.removeAttribute("data-whimsy-annotations-count");
    }

    return { anchoredIds, droppedIds };
  }

  #marksForId(id) {
    const doc = this.document;
    if (!doc || !id) {
      return [];
    }
    const safeId = String(id).replace(/["\\]/g, "\\$&");
    return Array.from(
      doc.querySelectorAll(
        `mark.whimsy-annotation-mark[data-whimsy-highlight-id="${safeId}"]`
      )
    );
  }

  #rectForHighlight(id) {
    const marks = this.#marksForId(id);
    if (!marks.length) {
      return null;
    }
    const firstRect = marks[0].getBoundingClientRect();
    return this.#clientRectToScreen(firstRect);
  }

  #scrollToHighlight(id) {
    const marks = this.#marksForId(id);
    if (!marks.length) {
      return null;
    }
    const first = marks[0];
    try {
      first.scrollIntoView({ block: "center", behavior: "instant" });
    } catch {}
    for (const m of marks) {
      m.setAttribute("data-pulse", "true");
    }
    this.contentWindow?.setTimeout?.(() => {
      for (const m of marks) {
        m.removeAttribute("data-pulse");
      }
    }, 1200);
    return this.#rectForHighlight(id);
  }
}
