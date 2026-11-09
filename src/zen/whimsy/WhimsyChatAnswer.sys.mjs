/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 chat-answers: how an answer looks in chat. Thinking streams muted
// and folds to "Thought for N seconds"; text streams with citation pills
// that appear once their sentence lands; a provider that can't stream
// fades its answer in whole. The model line opens a per-chat model and
// Thinking menu. Notes share one line style and errors one block (three
// tones). Provider pass-through: images, code, and research reports.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyAIContext: "resource:///modules/whimsy/WhimsyAIContext.sys.mjs",
  WhimsyAIPage: "resource:///modules/whimsy/WhimsyAIPage.sys.mjs",
  WhimsyAIProviders: "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs",
  WhimsyAIReports: "resource:///modules/whimsy/WhimsyAIReports.sys.mjs",
  WhimsyAIRouter: "resource:///modules/whimsy/WhimsyAIRouter.sys.mjs",
  WhimsyAIStore: "resource:///modules/whimsy/WhimsyAIStore.sys.mjs",
  WhimsyAIUpdates: "resource:///modules/whimsy/WhimsyAIUpdates.sys.mjs",
  WhimsyChat: "resource:///modules/whimsy/WhimsyChat.sys.mjs",
  WhimsyChatContextUI: "resource:///modules/whimsy/WhimsyChatContextUI.sys.mjs",
  WhimsyChatPanel: "resource:///modules/whimsy/WhimsyChatPanel.sys.mjs",
  WhimsyChatThreads: "resource:///modules/whimsy/WhimsyChatThreads.sys.mjs",
});

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SHEET = "chrome://browser/content/whimsy/whimsy-chat-answer.css";
const ICONS = "chrome://browser/content/whimsy/icons/";
const EASE = "cubic-bezier(0.075, 0.82, 0.165, 1)";
const EXPAND = "cubic-bezier(0.34, 1.2, 0.64, 1)";
const FOLD_MS = 300;
const PILL_MS = 150;
const FADE_MS = 240;
const SENTENCE_END = /[.!?。！？](["”’)\]]*)(\s|$)/;
const MARK = /\u0001(\d+)\u0002/g;

export const BRANDS = {
  apple: "chrome://browser/content/whimsy/ai/apple-intelligence.svg",
  claude: `${ICONS}claude.svg`,
  ollama: "chrome://browser/content/whimsy/ai/ollama.svg",
  openai: `${ICONS}openai.svg`,
  gemini: `${ICONS}gemini.svg`,
  test: "chrome://browser/skin/zen-icons/sparkles.svg",
};

// Error codes to the block's tone and its l10n ids.
const RED = new Set(["failed", "network", "unavailable", "timeout", "bad-response", "all-failed", "bad-key", "no-model"]);
const AMBER = new Set(["plan-limit", "rate-limited", "signed-out", "claude-code-signed-out", "offline", "connector-signed-out"]);
const NEEDS = ["images", "video", "research", "imageGen", "code", "chars"];

// Per chat: {provider, model, thinking}. Drafts key by their tab.
const choices = new Map();

function h(doc, tag, attrs = {}, ...children) {
  const el = doc.createElementNS(HTML_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) {
      continue;
    }
    if (k == "l10n") {
      const [id, args] = Array.isArray(v) ? v : [v];
      doc.l10n.setAttributes(el, id, args);
    } else if (k.startsWith("on")) {
      el.addEventListener(k.slice(2), v);
    } else if (v === true) {
      el.setAttribute(k, "");
    } else {
      el.setAttribute(k, v);
    }
  }
  el.append(...children.flat(Infinity).filter(c => c != null && c !== false));
  return el;
}

function icon(doc, url, cls = "") {
  return h(doc, "span", { class: `whimsy-chat-icon ${cls}`.trim(), style: `--whimsy-chat-icon: url("${url}")`, "aria-hidden": "true" });
}

function brand(doc, provider) {
  return h(doc, "img", { class: "whimsy-chat-brand", src: BRANDS[provider] ?? BRANDS.test, alt: "", "aria-hidden": "true" });
}

function reducedMotion(win) {
  return win.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function providerName(id) {
  if (id == "test") {
    return "Test";
  }
  try {
    return lazy.WhimsyAIProviders.providerName(id);
  } catch {
    return id;
  }
}

/** "claude-opus-5-5" -> "Opus 5.5", "gpt-5" -> "GPT-5", "gemini-2.5-pro" -> "2.5 Pro". */
export function modelLabel(provider, model) {
  let name = String(model ?? "").trim();
  if (!name || provider == "apple") {
    return "";
  }
  if (provider == "ollama") {
    return name.replace(/:latest$/, "");
  }
  name = name.replace(/^(claude|gemini|models\/gemini)-/i, "").replace(/-\d{8}$/, "").replace(/-latest$/, "");
  if (/^(gpt|o\d)/i.test(name)) {
    return name.replace(/^gpt/i, "GPT").replace(/-(mini|nano|pro)$/i, (m, s) => ` ${s[0].toUpperCase()}${s.slice(1)}`);
  }
  return name
    .replace(/(\d)-(\d)/g, "$1.$2")
    .split("-")
    .map(w => (/^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

export function whoLabel(provider, model) {
  const label = modelLabel(provider, model ?? lazy.WhimsyAIProviders.modelOf(provider));
  return label ? `${providerName(provider)} · ${label}` : providerName(provider);
}

// ---- Text: a small Markdown subset with citation marks ----

function inline(doc, text, ctx) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\u0001\d+\u0002)/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > at) {
      out.push(text.slice(at, m.index));
    }
    const t = m[0];
    if (t.startsWith("**")) {
      out.push(h(doc, "strong", {}, t.slice(2, -2)));
    } else if (t.startsWith("`")) {
      out.push(h(doc, "code", {}, t.slice(1, -1)));
    } else {
      const n = Number(t.slice(1, -1));
      out.push(ctx.pill(n));
    }
    at = m.index + t.length;
  }
  if (at < text.length) {
    out.push(text.slice(at));
  }
  return out;
}

function codeBlock(doc, { language, code, output, ranBy }) {
  const shown = language ? language.charAt(0).toUpperCase() + language.slice(1) : "";
  const copy = h(doc, "button", {
    class: "whimsy-chat-code-copy",
    l10n: "whimsy-chat-code-copy",
    onclick: e => {
      copyText(code);
      const b = e.currentTarget;
      doc.l10n.setAttributes(b, "whimsy-chat-code-copied");
      b.documentGlobal.setTimeout(() => doc.l10n.setAttributes(b, "whimsy-chat-code-copy"), 1500);
    },
  });
  const head = h(
    doc,
    "div",
    { class: "whimsy-chat-code-head" },
    h(doc, "span", ranBy ? { l10n: ["whimsy-chat-code-ran", { language: shown || "Code", provider: providerName(ranBy) }] } : {}, ranBy ? null : shown),
    copy
  );
  const block = h(doc, "div", { class: "whimsy-chat-code", "data-language": language || "" }, head, h(doc, "pre", {}, h(doc, "code", {}, code)));
  if (output != null) {
    return h(doc, "div", { class: "whimsy-chat-code-group" }, block, h(doc, "div", { class: "whimsy-chat-code whimsy-chat-code-output" }, h(doc, "div", { class: "whimsy-chat-code-head" }, h(doc, "span", { l10n: "whimsy-chat-code-output" })), h(doc, "pre", {}, String(output))));
  }
  return block;
}

/** Renders `text` (with \u0001n\u0002 citation marks) into block elements. */
export function renderMarkdown(doc, text, ctx) {
  const blocks = [];
  const lines = String(text ?? "").split("\n");
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) {
      blocks.push(h(doc, "p", {}, inline(doc, para.join("\n"), ctx)));
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push(list);
      list = null;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^```\s*([\w+#.-]*)\s*$/);
    if (fence) {
      flushPara();
      flushList();
      const code = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i++]);
      }
      blocks.push(codeBlock(doc, { language: fence[1], code: code.join("\n").replace(MARK, "") }));
      continue;
    }
    // A table: a | row, then a |---| rule, then rows.
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      flushPara();
      flushList();
      const cells = row => row.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(cells(lines[i++]));
      }
      i--;
      blocks.push(
        h(
          doc,
          "div",
          { class: "whimsy-chat-table-wrap" },
          h(
            doc,
            "table",
            { class: "whimsy-chat-table" },
            h(doc, "thead", {}, h(doc, "tr", {}, head.map(c => h(doc, "th", {}, inline(doc, c, ctx))))),
            h(doc, "tbody", {}, rows.map(r => h(doc, "tr", {}, head.map((_, j) => h(doc, "td", {}, inline(doc, r[j] ?? "", ctx))))))
          )
        )
      );
      continue;
    }
    // "0:42 What it says" in a list: the time is a pill that plays the video from there.
    const item = line.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/);
    const time = item?.[2].match(/^((?:\d+:)?\d{1,2}:\d{2})\s+(.*)$/);
    if (time) {
      flushPara();
      if (!list || list.localName != "ul" || !list.classList.contains("whimsy-chat-times")) {
        flushList();
        list = h(doc, "ul", { class: "whimsy-chat-times" });
      }
      const seconds = time[1].split(":").reduce((n, part) => n * 60 + Number(part), 0);
      list.append(h(doc, "li", {}, h(doc, "button", { class: "whimsy-chat-time", "data-seconds": String(seconds), onclick: () => ctx?.seek?.(seconds) }, time[1]), " ", inline(doc, time[2], ctx)));
      continue;
    }
    if (item) {
      flushPara();
      const ordered = !!item[1];
      if (!list || (list.localName == "ol") != ordered) {
        flushList();
        list = h(doc, ordered ? "ol" : "ul");
      }
      list.append(h(doc, "li", {}, inline(doc, item[2], ctx)));
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (heading) {
      flushPara();
      flushList();
      blocks.push(h(doc, "h4", {}, inline(doc, heading[1], ctx)));
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}

// Puts each citation's mark into the text where its event arrived. Only
// citations whose sentence is complete (or every one, when `all`).
function marked(text, citations, all) {
  const shown = citations
    .filter(c => all || SENTENCE_END.test(text.slice(c.at)) || c.at >= text.length && all)
    .map(c => {
      const rest = text.slice(c.at);
      const end = rest.match(SENTENCE_END);
      return { ...c, pos: end ? c.at + end.index + 1 + end[1].length : text.length };
    })
    .sort((a, b) => a.pos - b.pos);
  let out = "";
  let at = 0;
  for (const c of shown) {
    out += text.slice(at, c.pos) + `\u0001${c.n}\u0002`;
    at = c.pos;
  }
  return { text: out + text.slice(at), shown: new Set(shown.map(c => c.n)) };
}

function copyText(text) {
  Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(String(text ?? ""));
}

// ---- Citations on the page ----

function tabFor(win, thread, source) {
  const gBrowser = win.gBrowser;
  if (source?.tabKey) {
    const tab = gBrowser.tabs.find(t => lazy.WhimsyAIContext.tabKey(t) == source.tabKey);
    if (tab) {
      return tab;
    }
  }
  const own = thread ? lazy.WhimsyChatThreads.tabOf(thread) : null;
  if (own) {
    return own;
  }
  if (source?.url) {
    return gBrowser.tabs.find(t => t.linkedBrowser.currentURI.spec == source.url) ?? null;
  }
  return null;
}

function quoteOf(source) {
  return String(source?.quote ?? source?.text ?? "").trim().slice(0, 120);
}

// ---- The answer while it streams ----

class Live {
  constructor(panel, thread) {
    this.panel = panel;
    this.win = panel.win;
    this.doc = panel.doc;
    this.thread = thread;
    this.text = "";
    this.thinking = "";
    this.thinkingAt = 0;
    this.thinkingMs = null;
    this.citations = [];
    this.artifacts = [];
    this.pillsShown = new Set();
    this.provider = null;
    this.streams = true;
    const { doc } = this;
    this.status = h(doc, "div", { class: "whimsy-chat-status" }, h(doc, "span", { class: "whimsy-chat-spinner" }), h(doc, "span", { l10n: "whimsy-chat-status-reading" }));
    this.textEl = h(doc, "div", { class: "whimsy-chat-text whimsy-chat-md" });
    this.cards = h(doc, "div", { class: "whimsy-chat-cards" });
    this.node = h(doc, "div", { class: "whimsy-chat-msg", "data-role": "ai", busy: true }, this.status, this.textEl, this.cards);
  }

  setStatus(id) {
    const label = this.status.querySelector("span:last-child");
    if (label) {
      this.doc.l10n.setAttributes(label, id);
    }
  }

  event(event) {
    switch (event.type) {
      case "status":
        if (event.provider) {
          this.provider = event.provider;
          this.streams = lazy.WhimsyAIProviders.capabilities(event.provider).streaming !== false;
        }
        if (["reading", "reading-tabs", "watching", "searching"].includes(event.key)) {
          this.setStatus(`whimsy-chat-status-${event.key}`);
        }
        break;
      case "handoff":
        this.provider = event.to;
        this.streams = lazy.WhimsyAIProviders.capabilities(event.to).streaming !== false;
        break;
      case "thinking":
        this.onThinking(event.text);
        break;
      case "text":
        this.onText(event.delta);
        break;
      case "citation":
        this.citations.push({ n: Number(event.n) || this.citations.length + 1, at: this.text.length, source: event.source ?? null });
        this.renderText();
        break;
      case "artifact":
        this.onArtifact(event.artifact ?? event);
        break;
    }
  }

  onThinking(text) {
    const { doc } = this;
    if (!this.thinkEl) {
      this.thinkingAt = Date.now();
      this.thinkBody = h(doc, "div", { class: "whimsy-chat-thinking-text" });
      this.thinkEl = h(
        doc,
        "div",
        { class: "whimsy-chat-thinking", live: true },
        h(doc, "div", { class: "whimsy-chat-thinking-head" }, h(doc, "span", { class: "whimsy-chat-spinner" }), h(doc, "span", { l10n: "whimsy-chat-thinking" })),
        h(doc, "div", { class: "whimsy-chat-thinking-fold" }, this.thinkBody)
      );
      this.status.replaceWith(this.thinkEl);
    }
    this.thinking += text;
    this.thinkBody.textContent = this.thinking;
    this.thinkBody.scrollTop = this.thinkBody.scrollHeight;
    this.scroll();
  }

  fold() {
    if (!this.thinkEl || this.thinkingMs != null) {
      return;
    }
    this.thinkingMs = Date.now() - this.thinkingAt;
    const folded = thinkingLine(this.doc, { thinking: this.thinking, thinkingMs: this.thinkingMs });
    const old = this.thinkEl;
    if (reducedMotion(this.win)) {
      old.replaceWith(folded);
    } else {
      // The text block closes, then the folded line stands in its place.
      old.removeAttribute("live");
      const fold = old.querySelector(".whimsy-chat-thinking-fold");
      fold.animate({ gridTemplateRows: ["1fr", "0fr"], opacity: [1, 0] }, { duration: FOLD_MS, easing: EASE, fill: "forwards" });
      old.querySelector(".whimsy-chat-thinking-head").replaceWith(folded.querySelector(".whimsy-chat-thinking-head"));
      old.querySelector(".whimsy-chat-thinking-fold > *").replaceWith(folded.querySelector(".whimsy-chat-thinking-text"));
      old.setAttribute("folded", "true");
      this.doc.l10n.translateFragment(old);
    }
    this.thinkEl = folded.isConnected ? folded : old;
  }

  onText(delta) {
    if (!delta) {
      return;
    }
    this.fold();
    this.text += delta;
    // A plan answer arrives whole, so its status row stays until then.
    if (this.streams) {
      this.status.remove();
      this.renderText();
    }
  }

  renderText() {
    if (!this.streams) {
      return;
    }
    const { doc } = this;
    const { text, shown } = marked(this.text, this.citations, false);
    const fresh = [...shown].filter(n => !this.pillsShown.has(n));
    const pill = n => {
      const c = this.citations.find(x => x.n == n);
      const el = citationPill(doc, this.win, this.thread, c);
      if (fresh.includes(n) && !reducedMotion(this.win)) {
        el.animate({ opacity: [0, 1], scale: [0.8, 1] }, { duration: PILL_MS, easing: EASE });
      }
      return el;
    };
    this.textEl.replaceChildren(...renderMarkdown(doc, text, { pill }));
    this.textEl.append(h(doc, "span", { class: "whimsy-chat-caret", "aria-hidden": "true" }));
    for (const n of fresh) {
      this.pillsShown.add(n);
    }
    doc.l10n.translateFragment(this.textEl);
    this.scroll();
  }

  onArtifact(artifact) {
    this.artifacts.push(artifact);
    if (artifact.kind == "progress") {
      this.status.remove();
      const existing = this.cards.querySelector(".whimsy-chat-research[live]");
      this.researchAt ??= Date.now();
      const card = researchProgress(this.doc, artifact, () => this.panel.onSendButton(), { provider: this.provider, startedAt: this.researchAt });
      if (existing) {
        existing.replaceWith(card);
      } else {
        this.cards.append(card);
      }
      this.doc.l10n.translateFragment(card);
    }
    this.scroll();
  }

  scroll() {
    const body = this.panel.body;
    if (body?.contains(this.node)) {
      body.scrollTop = body.scrollHeight;
    }
  }

  /** What the saved message keeps besides text and provider. */
  fields() {
    const out = {};
    if (this.thinking) {
      out.thinking = this.thinking.slice(0, 20000);
      out.thinkingMs = this.thinkingMs ?? Date.now() - this.thinkingAt;
    }
    if (this.citations.length) {
      out.citations = this.citations;
    }
    const artifacts = this.artifacts.filter(a => a.kind != "progress");
    if (artifacts.length) {
      out.artifacts = artifacts;
    }
    return out;
  }

  /** The saved answer took the live one's place. */
  settled(replacement) {
    if (replacement && !this.streams && !reducedMotion(this.win)) {
      replacement.animate({ opacity: [0, 1] }, { duration: FADE_MS, easing: EASE });
    }
  }
}

function citationPill(doc, win, thread, c) {
  const source = c?.source ?? null;
  return h(doc, "button", {
    class: "whimsy-chat-cite",
    "data-n": String(c?.n ?? ""),
    l10n: ["whimsy-chat-cite", { n: c?.n ?? 0, title: source?.title ?? "" }],
    onmouseenter: () => WhimsyChatAnswer.tintCitation(win, thread, source, true),
    onmouseleave: () => WhimsyChatAnswer.tintCitation(win, thread, source, false),
    onclick: e => {
      for (const other of e.currentTarget.closest(".whimsy-chat-body, .whimsy-chat-msg")?.querySelectorAll(".whimsy-chat-cite[active]") ?? []) {
        other.removeAttribute("active");
      }
      e.currentTarget.setAttribute("active", "true");
      WhimsyChatAnswer.showCitation(win, thread, source);
    },
  }, source?.page ? h(doc, "span", { l10n: ["whimsy-summary-cite-page", { page: source.page }] }) : String(c?.n ?? ""));
}

function thinkingLine(doc, msg) {
  const seconds = Math.max(1, Math.round((msg.thinkingMs ?? 0) / 1000));
  const text = h(doc, "div", { class: "whimsy-chat-thinking-text" }, msg.thinking ?? "");
  const fold = h(doc, "div", { class: "whimsy-chat-thinking-fold" }, text);
  const button = h(
    doc,
    "button",
    {
      class: "whimsy-chat-thinking-head",
      "aria-expanded": "false",
      onclick: e => {
        const b = e.currentTarget;
        const open = b.getAttribute("aria-expanded") != "true";
        b.setAttribute("aria-expanded", String(open));
        b.closest(".whimsy-chat-thinking").toggleAttribute("open", open);
      },
    },
    h(doc, "span", { l10n: ["whimsy-chat-thought-for", { seconds }] }),
    icon(doc, "chrome://browser/skin/zen-icons/chevron.svg", "whimsy-chat-thinking-chevron")
  );
  return h(doc, "div", { class: "whimsy-chat-thinking", folded: true }, button, fold);
}

function researchProgress(doc, artifact, stop, { provider = null, startedAt = Date.now() } = {}) {
  const minutes = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
  const progress = Number(artifact.progress);
  const lines = artifact.lines ?? [];
  return h(
    doc,
    "div",
    { class: "whimsy-chat-research", live: true },
    h(doc, "div", { class: "whimsy-chat-research-title" }, artifact.title ?? ""),
    h(
      doc,
      "div",
      { class: "whimsy-chat-research-detail" },
      artifact.detail ?? h(doc, "span", { l10n: ["whimsy-chat-research-meta", { provider: provider ? providerName(provider) : "none", minutes, sources: Number(artifact.sources) || 0 }] })
    ),
    h(
      doc,
      "div",
      { class: "whimsy-chat-research-bar", role: "progressbar", indeterminate: !(progress >= 0 && progress <= 1) || null, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": progress >= 0 && progress <= 1 ? String(Math.round(progress * 100)) : null },
      h(doc, "div", { style: progress >= 0 && progress <= 1 ? `width: ${Math.round(progress * 100)}%` : null })
    ),
    h(
      doc,
      "ul",
      {},
      lines.map((line, i) => {
        const done = i < lines.length - 1;
        return h(doc, "li", { done }, done ? icon(doc, "chrome://browser/skin/zen-icons/check.svg") : h(doc, "span", { class: "whimsy-chat-spinner" }), h(doc, "span", {}, line));
      })
    ),
    h(doc, "button", { class: "whimsy-chat-pill-btn", l10n: "whimsy-chat-research-stop", onclick: stop })
  );
}

// ---- Saved answers ----

function artifactCard(doc, win, msg, artifact) {
  if (artifact.kind == "image") {
    const src = artifact.url ?? (artifact.data ? `data:${artifact.mime ?? "image/png"};base64,${artifact.data}` : "");
    const img = h(doc, "img", { class: "whimsy-chat-image", src, alt: artifact.alt ?? "", draggable: "true" });
    img.addEventListener("dragstart", e => {
      e.dataTransfer.setData("text/uri-list", src);
      e.dataTransfer.setData("application/x-moz-file-promise-url", src);
      e.dataTransfer.setData("application/x-moz-file-promise-dest-filename", artifact.name ?? "image.png");
    });
    return h(
      doc,
      "figure",
      { class: "whimsy-chat-image-card" },
      h(
        doc,
        "div",
        { class: "whimsy-chat-image-wrap" },
        img,
        h(
          doc,
          "div",
          { class: "whimsy-chat-image-actions" },
          h(doc, "button", { class: "whimsy-chat-pill-btn", l10n: "whimsy-chat-image-save", onclick: () => WhimsyChatAnswer.saveImage(win, artifact) }),
          h(doc, "button", { class: "whimsy-chat-pill-btn", l10n: "whimsy-chat-image-copy", onclick: () => WhimsyChatAnswer.copyImage(win, artifact) })
        )
      ),
      h(doc, "figcaption", {
        l10n: ["whimsy-chat-image-caption", { provider: providerName(msg.provider), width: artifact.width ?? 0, height: artifact.height ?? 0, type: (artifact.mime ?? "image/png").split("/")[1].toUpperCase() }],
      })
    );
  }
  if (artifact.kind == "code") {
    return codeBlock(doc, { language: artifact.language, code: artifact.code ?? "", output: artifact.output, ranBy: artifact.output != null ? msg.provider : null });
  }
  if (artifact.kind == "report" || artifact.kind == "doc") {
    return h(
      doc,
      "div",
      { class: "whimsy-chat-report", "data-report": artifact.reportId ?? "" },
      h(
        doc,
        "div",
        { class: "whimsy-chat-report-head" },
        h(doc, "img", { class: "whimsy-chat-report-icon", src: `${ICONS}pdf.svg`, alt: "" }),
        h(
          doc,
          "div",
          { class: "whimsy-chat-report-text" },
          h(doc, "div", { class: "whimsy-chat-report-title" }, artifact.title ?? ""),
          h(doc, "div", {
            class: "whimsy-chat-report-detail",
            l10n: [artifact.kind == "report" ? "whimsy-chat-report-detail" : "whimsy-chat-doc-detail", { sources: artifact.sources ?? 0 }],
          })
        )
      ),
      h(doc, "button", { class: "whimsy-chat-pill-btn primary", l10n: "whimsy-chat-report-open", onclick: () => lazy.WhimsyAIReports.open(win, artifact.reportId) }),
      h(doc, "button", { class: "whimsy-chat-pill-btn", l10n: "whimsy-chat-report-export", onclick: e => WhimsyChatAnswer.exportMenu(win, e.currentTarget, artifact.reportId) })
    );
  }
  return null;
}

function renderSaved(doc, msg, ctx) {
  const { win, thread, panel } = ctx;
  const node = h(doc, "div", { class: "whimsy-chat-msg", "data-role": "ai", "data-msg-id": msg.id });
  if (msg.thinking) {
    node.append(thinkingLine(doc, msg));
  }
  const cites = msg.citations ?? [];
  const { text } = marked(String(msg.text ?? ""), cites, true);
  const pill = n => citationPill(doc, win, thread, cites.find(c => c.n == n) ?? { n });
  const seek = seconds => WhimsyChatAnswer.seekVideo(win, thread, seconds);
  node.append(h(doc, "div", { class: "whimsy-chat-text whimsy-chat-md" }, renderMarkdown(doc, text, { pill, seek })));
  const cards = (msg.artifacts ?? []).map(a => artifactCard(doc, win, msg, a)).filter(Boolean);
  if (cards.length) {
    node.append(h(doc, "div", { class: "whimsy-chat-cards" }, cards));
  }
  if (msg.partial && msg.next && !msg.stoppedHere) {
    node.append(
      errorBlock(doc, {
        tone: "amber",
        l10n: ["whimsy-chat-error-quota-mid", { provider: providerName(msg.provider) }],
        buttons: [
          { l10n: ["whimsy-chat-error-finish-with", { provider: providerName(msg.next) }], primary: true, run: () => panel?.finishWith?.(msg) },
          { l10n: "whimsy-chat-error-stop-here", run: () => panel?.stopHere?.(msg) },
        ],
      })
    );
  }
  const actions = h(doc, "div", { class: "whimsy-chat-actions" });
  for (const action of lazy.WhimsyChat.answerActions(msg)) {
    actions.append(h(doc, "button", { class: "whimsy-chat-btn", l10n: action.l10nId, "data-action": action.id, onclick: () => action.run(win, msg) }, icon(doc, action.icon)));
  }
  node.append(actions);
  return node;
}

// ---- Note line and error block ----

/** One note line: icon, words, and optional link buttons. */
export function noteLine(doc, { kind, iconUrl = "chrome://browser/skin/zen-icons/info.svg", l10n, buttons = [] }) {
  return h(
    doc,
    "div",
    { class: "whimsy-chat-note", "data-kind": kind },
    icon(doc, iconUrl),
    h(
      doc,
      "span",
      { class: "whimsy-chat-note-text" },
      h(doc, "span", { l10n }),
      buttons.map(b => [" ", h(doc, "button", { class: "whimsy-chat-link", l10n: b.l10n, onclick: b.run })])
    )
  );
}

export function errorBlock(doc, { tone, l10n, detail, buttons = [], code }) {
  return h(
    doc,
    "div",
    { class: "whimsy-chat-error", role: "alert", tone, "data-code": code ?? "" },
    icon(doc, tone == "grey" ? "chrome://browser/skin/zen-icons/info.svg" : "chrome://browser/skin/zen-icons/security-warning.svg"),
    h(
      doc,
      "div",
      { class: "whimsy-chat-error-body" },
      h(doc, "div", { class: "whimsy-chat-error-text", l10n }),
      detail ? h(doc, "div", { class: "whimsy-chat-error-detail", l10n: detail }) : null,
      buttons.length
        ? h(doc, "div", { class: "whimsy-chat-error-buttons" }, buttons.map(b => h(doc, "button", { class: `whimsy-chat-pill-btn${b.primary ? " primary" : ""}`, l10n: b.l10n, onclick: b.run })))
        : null
    )
  );
}

function needOf(msg) {
  return NEEDS.find(n => msg.needs?.[n]) ?? null;
}

// Each error code to its block: tone, words, and next steps.
export function errorSpec(msg, { win, panel } = {}) {
  const P = lazy.WhimsyAIProviders;
  const code = msg.code ?? "failed";
  const provider = msg.provider ?? msg.tried?.[0] ?? P.order.find(id => P.isOn(id)) ?? "claude";
  const name = providerName(provider);
  const needs = msg.needs ?? {};
  const others = lazy.WhimsyAIRouter.capable(needs).filter(id => id != provider);
  const retry = opts => () => panel?.retry?.(msg, opts);
  const settings = () => P.openSettings(win, "add-provider");
  if (code == "none-capable") {
    const need = needOf(msg) ?? "images";
    const can = lazy.WhimsyAIRouter._enabled().length ? P.order.filter(id => id != provider && lazy.WhimsyAIRouter._fits(id, needs)) : [];
    return {
      tone: "grey",
      l10n: [`whimsy-chat-error-cannot-${need}`, { who: whoLabel(provider, msg.model) }],
      detail: can.length ? ["whimsy-chat-error-can", { names: new Intl.ListFormat("en", { type: "conjunction" }).format(can.map(providerName)) }] : null,
      buttons: [
        others.length
          ? { l10n: ["whimsy-chat-error-ask", { provider: providerName(others[0]) }], primary: true, run: retry({ provider: others[0] }) }
          : { l10n: "whimsy-chat-error-see-which", primary: true, run: settings },
        { l10n: `whimsy-chat-error-without-${need == "research" ? "research" : "it"}`, run: retry({ textOnly: true }) },
      ],
    };
  }
  if (code == "plan-limit" || code == "rate-limited") {
    const until = msg.until ? new Date(msg.until).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
    return {
      tone: "amber",
      l10n: [until ? "whimsy-chat-error-plan-out-until" : "whimsy-chat-error-plan-out", { provider: name, time: until }],
      buttons: [
        others.length
          ? { l10n: ["whimsy-chat-error-ask", { provider: providerName(others[0]) }], primary: true, run: retry({ provider: others[0] }) }
          : { l10n: "whimsy-chat-error-connect", primary: true, run: settings },
        P.canManageUsage?.(provider) ? { l10n: "whimsy-chat-error-usage", run: () => P.manageUsage(win, provider) } : null,
      ].filter(Boolean),
    };
  }
  if (code == "signed-out" || code == "claude-code-signed-out") {
    return { tone: "amber", l10n: ["whimsy-chat-error-signed-out", { provider: name }], buttons: [{ l10n: "whimsy-chat-error-sign-in", primary: true, run: () => P.openSettings(win) }, { l10n: "whimsy-chat-error-retry", run: retry({}) }] };
  }
  if (code == "offline") {
    const apple = P.isOn("apple") && P.order.includes("apple");
    return {
      tone: "amber",
      l10n: apple ? "whimsy-chat-error-offline-apple" : "whimsy-chat-error-offline",
      buttons: [
        apple ? { l10n: "whimsy-chat-error-ask-apple", primary: true, run: retry({ provider: "apple" }) } : null,
        { l10n: "whimsy-chat-error-when-online", primary: !apple, run: () => panel?.retryWhenOnline?.(msg) },
      ].filter(Boolean),
    };
  }
  if (code == "connector-signed-out") {
    return {
      tone: "amber",
      l10n: ["whimsy-chat-error-connector", { connector: msg.connector ?? "", item: msg.item ?? "" }],
      buttons: [{ l10n: ["whimsy-chat-error-connector-sign-in", { connector: msg.connector ?? "" }], primary: true, run: () => P.openSettings(win) }, { l10n: "whimsy-chat-error-without-it", run: retry({ withoutChip: msg.chipId }) }],
    };
  }
  if (code == "too-long") {
    return {
      tone: "amber",
      l10n: ["whimsy-chat-error-too-long", { who: whoLabel(provider, msg.model) }],
      buttons: [others.length ? { l10n: ["whimsy-chat-error-use", { provider: providerName(others[0]) }], primary: true, run: retry({ provider: others[0] }) } : null].filter(Boolean),
    };
  }
  const tried = (msg.tried ?? []).filter(Boolean);
  return {
    tone: RED.has(code) || !AMBER.has(code) ? "red" : "amber",
    l10n: code == "all-failed" && tried.length > 1
      ? ["whimsy-chat-error-all-failed", { names: new Intl.ListFormat("en", { type: "conjunction" }).format(tried.map(providerName)) }]
      : ["whimsy-chat-error-down", { provider: name }],
    buttons: [
      others.length && code != "all-failed" ? { l10n: ["whimsy-chat-error-ask-instead", { provider: providerName(others[0]) }], primary: true, run: retry({ provider: others[0] }) } : null,
      { l10n: "whimsy-chat-error-retry", primary: !others.length || code == "all-failed", run: retry({}) },
    ].filter(Boolean),
  };
}

function renderError(doc, msg, ctx) {
  if (msg.resolved) {
    return null;
  }
  const spec = errorSpec(msg, ctx);
  const node = errorBlock(doc, { ...spec, code: msg.code });
  node.setAttribute("data-msg-id", msg.id);
  return node;
}

const NEED_WORDS = { images: "images", video: "video", research: "research", imageGen: "image-gen", code: "code", chars: "long" };

function renderHandoff(doc, msg) {
  const to = providerName(msg.to);
  if (msg.reason == "capability") {
    const need = NEED_WORDS[msg.need] ?? "task";
    return noteLine(doc, {
      kind: "handoff",
      iconUrl: `${ICONS}uturn-backward.svg`,
      l10n: [`whimsy-chat-note-fallback-${need}`, { to, from: whoLabel(msg.from, msg.fromModel) }],
    });
  }
  return noteLine(doc, { kind: "handoff", iconUrl: `${ICONS}uturn-backward.svg`, l10n: ["whimsy-chat-note-handoff", { to, from: providerName(msg.from) }] });
}

// ---- Model line and menu ----

function keyOf(thread) {
  return thread?.id ?? (thread?.tabKey ? `draft:${thread.tabKey}` : "draft");
}

export const WhimsyChatAnswer = {
  _inited: false,

  init() {
    if (this._inited) {
      return;
    }
    this._inited = true;
    const C = lazy.WhimsyChat;
    C.registerCard("ai", renderSaved);
    C.registerCard("error", renderError);
    C.registerCard("note:handoff", renderHandoff);
    C.registerCard("note:chip-removed", (doc, msg, ctx) => lazy.WhimsyChatContextUI.renderRemovedNote(doc, msg, ctx));
    C.registerCard("note:left-out", (doc, msg) => lazy.WhimsyChatContextUI.renderLeftOut(doc, msg));
    lazy.WhimsyAIReports.init();
    C.registerCard("note:language", (doc, msg, ctx) =>
      noteLine(doc, {
        kind: "language",
        iconUrl: "chrome://browser/skin/zen-icons/translations.svg",
        l10n: ["whimsy-chat-note-language", { page: msg.pageName ?? msg.page, answer: msg.answerName ?? msg.answer }],
        buttons: msg.done ? [] : [{ l10n: ["whimsy-chat-note-language-switch", { page: msg.pageName ?? msg.page }], run: () => ctx.panel?.answerInLanguage?.(msg) }],
      })
    );
    C.registerAnswerAction({
      id: "copy",
      l10nId: "whimsy-chat-action-copy",
      icon: "chrome://browser/skin/zen-icons/edit-copy.svg",
      isAvailable: msg => msg.role == "ai" && !!msg.text,
      run: (win, msg) => copyText(String(msg.text ?? "")),
    });
    C.registerAnswerAction({
      id: "retry",
      l10nId: "whimsy-chat-action-retry",
      icon: "chrome://browser/skin/zen-icons/reload.svg",
      isAvailable: msg => msg.role == "ai",
      run: (win, msg) => lazy.WhimsyChatPanel.forWindow(win).retry(msg),
    });
  },

  sheetURL: SHEET,
  brands: BRANDS,
  who: whoLabel,

  copyText(text) {
    copyText(text);
  },

  live(panel, thread) {
    return new Live(panel, thread);
  },

  // ---- Per-chat model and thinking ----

  choiceFor(thread) {
    return choices.get(keyOf(thread)) ?? thread?.choice ?? { provider: "auto", model: "", thinking: "normal" };
  },

  async setChoice(thread, patch) {
    const next = { ...this.choiceFor(thread), ...patch };
    choices.set(keyOf(thread), next);
    if (thread?.id && !thread.draft) {
      await lazy.WhimsyAIStore.updateThread(thread.id, { choice: next, updated: thread.updated });
      thread.choice = next;
    }
    return next;
  },

  /** A draft became a stored chat: its choice goes with it. */
  adopt(draft, thread) {
    const choice = choices.get(keyOf(draft));
    if (choice) {
      choices.delete(keyOf(draft));
      this.setChoice(thread, choice);
    }
  },

  /** Who answers next: the chosen provider, or the first that can. */
  resolve(thread, needs = {}) {
    const choice = this.choiceFor(thread);
    if (choice.provider && choice.provider != "auto" && lazy.WhimsyAIRouter._enabled().includes(choice.provider)) {
      return { provider: choice.provider, model: choice.model || lazy.WhimsyAIProviders.modelOf(choice.provider) };
    }
    const id = lazy.WhimsyAIRouter.capable(needs)[0] ?? lazy.WhimsyAIRouter._enabled()[0] ?? null;
    return { provider: id, model: id ? lazy.WhimsyAIProviders.modelOf(id) : "" };
  },

  thinkingLevels(provider, model) {
    if (!provider) {
      return null;
    }
    return lazy.WhimsyAIProviders.capabilities(provider, model || undefined).thinking ?? null;
  },

  /** Fills the model line's start: mark, who, and "Deep thinking" when not Normal. */
  renderModelLine(panel) {
    const { doc } = panel;
    const start = panel.modelRow.querySelector(".whimsy-chat-model-start");
    const { provider, model } = this.resolve(panel.thread, panel.contextNeeds ?? {});
    const choice = this.choiceFor(panel.thread);
    const levels = this.thinkingLevels(provider, model);
    const button = h(
      doc,
      "button",
      {
        class: "whimsy-chat-model-button",
        "aria-haspopup": "listbox",
        "aria-expanded": "false",
        l10n: ["whimsy-chat-model-button", { who: provider ? whoLabel(provider, model) : "" }],
        onclick: e => this.openModelMenu(panel, e.currentTarget),
      },
      provider ? brand(doc, provider) : null,
      h(doc, "span", { class: "whimsy-chat-model-name" }, provider ? whoLabel(provider, model) : ""),
      icon(doc, "chrome://browser/skin/zen-icons/chevron.svg", "whimsy-chat-model-chevron")
    );
    const extra = levels && choice.thinking != "normal" ? h(doc, "span", { class: "whimsy-chat-model-thinking", l10n: `whimsy-chat-model-thinking-${choice.thinking}` }) : null;
    start.replaceChildren(button, extra ?? "");
  },

  openModelMenu(panel, anchor) {
    const { doc, win } = panel;
    panel.el.querySelector(".whimsy-chat-menu")?.remove();
    const P = lazy.WhimsyAIProviders;
    const thread = panel.thread;
    const choice = this.choiceFor(thread);
    const needs = panel.contextNeeds ?? {};
    const enabled = lazy.WhimsyAIRouter._enabled();
    const close = (focus = true) => {
      menu.remove();
      anchor.setAttribute("aria-expanded", "false");
      if (focus) {
        anchor.focus();
      }
    };
    const pick = async provider => {
      await this.setChoice(thread, { provider, model: provider == "auto" ? "" : P.modelOf(provider) });
      close();
      this.renderModelLine(panel);
      doc.l10n.translateFragment(panel.modelRow);
    };
    const row = (id, label, detail, { dim = null, selected = false } = {}) =>
      h(
        doc,
        "div",
        {
          class: "whimsy-chat-option",
          role: "option",
          tabindex: "-1",
          "data-provider": id,
          "aria-selected": String(selected),
          "aria-disabled": dim ? "true" : null,
          onclick: () => !dim && pick(id),
        },
        h(doc, "span", { class: "whimsy-chat-option-check" }),
        id == "auto" ? h(doc, "span", { class: "whimsy-chat-brand" }) : brand(doc, id),
        h(doc, "span", { class: "whimsy-chat-option-label" }, typeof label == "string" ? label : h(doc, "span", { l10n: label })),
        h(doc, "span", { class: "whimsy-chat-option-detail", l10n: dim ?? detail })
      );
    const methodL10n = id => `whimsy-chat-model-method-${lazy.WhimsyAIContext.describeDestination(id).method}`;
    const reason = id => {
      const caps = P.capabilities(id);
      for (const need of ["images", "video", "research"]) {
        if (needs[need] && !caps[need]) {
          return `whimsy-chat-model-cannot-${need}`;
        }
      }
      return needs.chars > caps.maxInputChars ? "whimsy-chat-model-cannot-long" : null;
    };
    const rows = [
      row("auto", ["whimsy-chat-model-auto"], "whimsy-chat-model-auto-detail", { selected: choice.provider == "auto" || !enabled.includes(choice.provider) }),
      h(doc, "hr", { class: "whimsy-chat-menu-rule" }),
      ...enabled.map(id => row(id, whoLabel(id), methodL10n(id), { dim: reason(id), selected: choice.provider == id })),
    ];
    const resolved = this.resolve(thread, needs);
    const levels = this.thinkingLevels(resolved.provider, resolved.model);
    let seg = null;
    if (levels) {
      seg = h(
        doc,
        "div",
        { class: "whimsy-chat-thinking-control" },
        h(doc, "span", { class: "whimsy-chat-thinking-label", id: "whimsy-chat-thinking-label", l10n: "whimsy-chat-model-thinking" }),
        h(
          doc,
          "div",
          { class: "whimsy-chat-seg", role: "radiogroup", "aria-labelledby": "whimsy-chat-thinking-label" },
          levels.map(level =>
            h(doc, "button", {
              class: "whimsy-chat-segment",
              role: "radio",
              "data-level": level,
              "aria-checked": String((choice.thinking ?? "normal") == level),
              l10n: `whimsy-chat-thinking-${level}`,
              onclick: async () => {
                await this.setChoice(thread, { thinking: level });
                for (const b of menu.querySelectorAll(".whimsy-chat-segment")) {
                  b.setAttribute("aria-checked", String(b.dataset.level == level));
                }
                this.renderModelLine(panel);
                doc.l10n.translateFragment(panel.modelRow);
              },
            })
          )
        )
      );
    }
    const menu = h(
      doc,
      "div",
      {
        class: "whimsy-chat-menu whimsy-chat-model-menu",
        onkeydown: e => {
          const opts = [...menu.querySelectorAll(".whimsy-chat-option:not([aria-disabled])")];
          const at = opts.indexOf(doc.activeElement);
          if (e.key == "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
            panel.composer.focus();
          } else if (e.key == "ArrowDown" || e.key == "ArrowUp") {
            e.preventDefault();
            opts[(at + (e.key == "ArrowDown" ? 1 : opts.length - 1)) % opts.length]?.focus();
          } else if (e.key == "Enter" && at >= 0) {
            e.preventDefault();
            pick(opts[at].dataset.provider);
          }
        },
      },
      h(doc, "div", { class: "whimsy-chat-menu-title", l10n: "whimsy-chat-model-title" }),
      h(doc, "div", { role: "listbox", "aria-labelledby": "", class: "whimsy-chat-menu-list" }, rows),
      seg ? h(doc, "hr", { class: "whimsy-chat-menu-rule" }) : null,
      seg,
      h(doc, "hr", { class: "whimsy-chat-menu-rule" }),
      h(doc, "button", { class: "whimsy-chat-menu-link", l10n: "whimsy-chat-model-settings", onclick: () => (close(false), P.openSettings(win)) })
    );
    panel.panel.append(menu);
    anchor.setAttribute("aria-expanded", "true");
    const dismiss = e => {
      if (!menu.isConnected) {
        win.removeEventListener("mousedown", dismiss, true);
      } else if (!menu.contains(e.target) && !anchor.contains(e.target)) {
        close(false);
        win.removeEventListener("mousedown", dismiss, true);
      }
    };
    win.addEventListener("mousedown", dismiss, true);
    doc.l10n.translateFragment(menu).then(() => {
      if (!reducedMotion(win)) {
        menu.animate({ opacity: [0, 1], scale: [0.98, 1], translate: ["0 4px", "0 0"] }, { duration: 180, easing: EASE });
      }
      (menu.querySelector(".whimsy-chat-option[aria-selected='true']") ?? menu.querySelector(".whimsy-chat-option"))?.focus();
    });
    return menu;
  },

  // ---- Citations on the page ----

  tintCitation(win, thread, source, on) {
    const quote = quoteOf(source);
    const tab = tabFor(win, thread, source);
    if (!quote || !tab) {
      return;
    }
    try {
      tab.linkedBrowser.finder.highlight(on, quote, false, true);
    } catch (e) {
      console.error("Whimsy chat: citation tint", e);
    }
  },

  async showCitation(win, thread, source) {
    const quote = quoteOf(source);
    let tab = tabFor(win, thread, source);
    if (!tab && source?.url) {
      tab = win.gBrowser.addTrustedTab(source.url);
    }
    if (!tab || !quote) {
      return false;
    }
    if (win.gBrowser.selectedTab != tab && !tab.splitView) {
      win.gBrowser.selectedTab = tab;
    }
    // A summary's passage that has left the page: the thread says so.
    if (source?.summary && !(await lazy.WhimsyAIPage.quoteOnPage(tab, quote))) {
      await lazy.WhimsyAIPage.passageGone(win, thread);
      return false;
    }
    // Scrolled a third of the way down and tinted until the next scroll (page-1.3).
    if (await lazy.WhimsyAIPage.showPassage(win, tab, quote, source)) {
      return true;
    }
    // The tab may have closed while the page looked for the passage.
    if (!tab.linkedBrowser) {
      return false;
    }
    const finder = tab.linkedBrowser.finder;
    finder.fastFind(quote, false, false);
    finder.highlight(true, quote, false, true);
    return true;
  },

  /** A time in a video summary plays the chat's video from there. */
  async seekVideo(win, thread, seconds) {
    const tab = (thread ? lazy.WhimsyChatThreads.tabOf(thread) : null) ?? win.gBrowser.selectedTab;
    if (win.gBrowser.selectedTab != tab && !tab.splitView) {
      win.gBrowser.selectedTab = tab;
    }
    const actor = tab.linkedBrowser.browsingContext?.currentWindowGlobal?.getActor("WhimsyPage");
    return actor ? actor.sendQuery("Whimsy:CastControl", { action: "seek", time: seconds }).catch(() => false) : false;
  },

  // ---- Pass-through ----

  async saveImage(win, artifact) {
    const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    fp.init(win.browsingContext, "", Ci.nsIFilePicker.modeSave);
    fp.defaultString = artifact.name ?? "image.png";
    const result = await new Promise(resolve => fp.open(resolve));
    if (result == Ci.nsIFilePicker.returnCancel || !fp.file) {
      return null;
    }
    await IOUtils.write(fp.file.path, imageBytes(artifact));
    return fp.file.path;
  },

  copyImage(win, artifact) {
    const bytes = imageBytes(artifact);
    const imgTools = Cc["@mozilla.org/image/tools;1"].getService(Ci.imgITools);
    const container = imgTools.decodeImageFromArrayBuffer(bytes.buffer, artifact.mime ?? "image/png");
    const transferable = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
    transferable.init(null);
    transferable.addDataFlavor("image/png");
    transferable.setTransferData("image/png", container);
    Services.clipboard.setData(transferable, null, Ci.nsIClipboard.kGlobalClipboard);
    return true;
  },

  exportMenu(win, anchor, reportId) {
    const { doc } = anchor.ownerDocument ? { doc: anchor.ownerDocument } : win;
    anchor.parentElement.querySelector(".whimsy-chat-export")?.remove();
    const choose = async format => {
      menu.remove();
      await lazy.WhimsyAIReports.export(win, reportId, format);
    };
    const menu = h(
      doc,
      "div",
      { class: "whimsy-chat-menu whimsy-chat-export", role: "menu" },
      ["pdf", "markdown"].map(f => h(doc, "button", { class: "whimsy-chat-option", role: "menuitem", l10n: `whimsy-chat-report-export-${f}`, onclick: () => choose(f) }))
    );
    anchor.after(menu);
    doc.l10n.translateFragment(menu);
    menu.querySelector("button")?.focus();
    return menu;
  },

  /** Research and generated docs become local report files. */
  async saveArtifacts(win, thread, artifacts) {
    for (const a of artifacts ?? []) {
      if ((a.kind == "report" || a.kind == "doc") && !a.reportId && a.markdown) {
        const saved = await lazy.WhimsyAIReports.save(thread.id, { title: a.title ?? "", markdown: a.markdown, kind: a.kind });
        a.reportId = saved.id;
        delete a.markdown;
        // Opens beside the chat's tab without taking you away from the answer.
        await lazy.WhimsyAIReports.open(win, saved.id, { select: false });
        if (a.kind == "report") {
          await lazy.WhimsyAIUpdates.post({
            id: `research:${saved.id}`,
            source: "research",
            title: a.title || "Research report",
            threadId: thread.id,
            reportId: saved.id,
          });
        }
      }
    }
    return artifacts;
  },
};

function imageBytes(artifact) {
  if (artifact.data) {
    return Uint8Array.from(atob(artifact.data), c => c.charCodeAt(0));
  }
  const m = String(artifact.url ?? "").match(/^data:[^;]+;base64,(.*)$/);
  return m ? Uint8Array.from(atob(m[1]), c => c.charCodeAt(0)) : new Uint8Array();
}
