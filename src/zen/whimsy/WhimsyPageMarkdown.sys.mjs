/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Copy page as Markdown, the content side (loaded by WhimsyPageChild on
// first use). An article goes through Firefox's Reader View extraction
// (Readability via ReaderMode.parseDocument), so the Markdown is the article
// and not the site's navigation, ads and footers. A page Readability can't
// read is walked as it is, skipping what's hidden and the usual chrome
// (nav, aside, forms, ad and share blocks). A selection is converted on its
// own, with no title or source line.
//
// htmlToMarkdown(root, baseURL) is a small DOM-to-Markdown writer
// (CommonMark + GFM tables and strikethrough): headings, paragraphs,
// links, emphasis, inline code, fenced code with its language, nested
// lists, quotes, images, rules and simple tables.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ReaderMode: "moz-src:///toolkit/components/reader/ReaderMode.sys.mjs",
  Readerable: "resource://gre/modules/Readerable.sys.mjs",
});

// Never Markdown, anywhere.
const SKIP_TAGS = new Set([
  "script", "style", "noscript", "template", "iframe", "object", "embed", "form", "button",
  "input", "select", "textarea", "svg", "canvas", "dialog", "video", "audio", "map", "head",
  "link", "meta", "title",
]);
// Page chrome, skipped when walking a page Readability couldn't read.
const CHROME_TAGS = new Set(["nav", "aside", "footer"]);
const CHROME_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search", "dialog", "alert"]);
const CHROME_NAMES =
  /(^|[\s_-])(ads?|adv|advert\w*|sponsor\w*|promo\w*|banner|cookie\w*|consent|newsletter|share|sharing|social|related|recommend\w*|comments?|popup|modal|sidebar|breadcrumbs?|skip-link)($|[\s_-])/i;
const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "main", "header", "figure", "figcaption", "address",
  "details", "summary", "dl", "dt", "dd", "center", "hgroup", "body",
]);
const MAX_TEXT = 2_000_000;

function absolute(url, baseURL) {
  if (!url) {
    return "";
  }
  try {
    return new URL(url, baseURL || undefined).href;
  } catch (e) {
    return "";
  }
}

// Escapes what would otherwise turn plain text into Markdown syntax.
function escapeText(text) {
  return text
    .replace(/([\\`*[\]])/g, "\\$1")
    .replace(/(^|[^\p{L}\p{N}])_|_(?=[^\p{L}\p{N}]|$)/gu, (m, before) => (before !== undefined ? `${before}\\_` : "\\_"))
    // Only where it could start an HTML tag.
    .replace(/<(?=[A-Za-z/!?])/g, "&lt;");
}

function codeSpan(text) {
  const runs = text.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(0, ...runs.map(r => r.length)) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function codeLanguage(el) {
  for (const node of [el, el.querySelector?.("code")]) {
    const match = node?.className?.match?.(/(?:^|\s)(?:language|lang|highlight-source)-([\w+#.-]+)/);
    if (match) {
      return match[1];
    }
  }
  return el.getAttribute?.("data-lang") ?? "";
}

class Writer {
  constructor({ baseURL = "", pageChrome = false, codeLanguages = null } = {}) {
    this.baseURL = baseURL;
    this.codeLanguages = codeLanguages;
    this.pageChrome = pageChrome;
    this.length = 0;
  }

  skip(el) {
    const tag = el.localName;
    if (SKIP_TAGS.has(tag) || el.hidden || el.getAttribute("aria-hidden") == "true") {
      return true;
    }
    if (!this.pageChrome) {
      return false;
    }
    if (CHROME_TAGS.has(tag) || CHROME_ROLES.has(el.getAttribute("role"))) {
      return true;
    }
    if (tag == "header" && !el.closest("article, main, [role=main]")) {
      return true;
    }
    const names = `${typeof el.className == "string" ? el.className : ""} ${el.id}`;
    if (CHROME_NAMES.test(names) && !el.closest("article, main, [role=main]")?.isSameNode?.(el)) {
      return true;
    }
    // Live pages only: what isn't rendered isn't copied.
    try {
      if (el.isConnected && el.ownerDocument.defaultView && !el.checkVisibility({ visibilityProperty: true })) {
        return true;
      }
    } catch (e) {}
    return false;
  }

  children(node, ctx) {
    let out = "";
    for (const child of node.childNodes) {
      out += this.node(child, ctx);
      if (this.length > MAX_TEXT) {
        break;
      }
    }
    return out;
  }

  // Inline content on one line (headings, links, table cells).
  inline(node, ctx) {
    return this.children(node, { ...ctx, inline: true })
      .replace(/\s*\n+\s*/g, " ")
      .replace(/ {2,}/g, " ")
      .trim();
  }

  block(text) {
    const trimmed = text.replace(/^\s+|\s+$/g, "");
    return trimmed ? `\n\n${trimmed}\n\n` : "";
  }

  node(node, ctx = {}) {
    if (node.nodeType == node.TEXT_NODE) {
      const text = node.data;
      this.length += text.length;
      if (ctx.pre) {
        return text;
      }
      return escapeText(text.replace(/\s+/g, " "));
    }
    if (node.nodeType != node.ELEMENT_NODE && node.nodeType != node.DOCUMENT_FRAGMENT_NODE) {
      return "";
    }
    if (node.nodeType == node.DOCUMENT_FRAGMENT_NODE) {
      return this.children(node, ctx);
    }
    const el = node;
    if (this.skip(el)) {
      return "";
    }
    const tag = el.localName;
    switch (tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const text = this.inline(el, ctx);
        return text ? (ctx.inline ? ` ${text} ` : `\n\n${"#".repeat(+tag[1])} ${text}\n\n`) : "";
      }
      case "br":
        return ctx.inline ? " " : "  \n";
      case "hr":
        return ctx.inline ? " " : "\n\n---\n\n";
      case "a": {
        const text = this.inline(el, ctx);
        const raw = el.getAttribute("href");
        const href = absolute(raw, this.baseURL);
        if (!text) {
          return "";
        }
        if (!href || raw.startsWith("#") || !/^(https?|mailto|ftp|file):/i.test(href)) {
          return text;
        }
        return `[${text}](${href.replace(/[()\s]/g, c => encodeURIComponent(c))})`;
      }
      case "strong":
      case "b": {
        const text = this.children(el, ctx);
        return text.trim() ? `**${text.trim()}**` : text;
      }
      case "em":
      case "i":
      case "cite": {
        const text = this.children(el, ctx);
        return text.trim() ? `_${text.trim()}_` : text;
      }
      case "del":
      case "s":
      case "strike": {
        const text = this.children(el, ctx);
        return text.trim() ? `~~${text.trim()}~~` : text;
      }
      case "code":
      case "kbd":
      case "samp":
      case "tt": {
        if (ctx.pre) {
          return el.textContent;
        }
        const text = el.textContent.replace(/\s+/g, " ");
        this.length += text.length;
        return text.trim() ? codeSpan(text) : "";
      }
      case "pre": {
        const text = el.textContent.replace(/\n$/, "");
        this.length += text.length;
        if (ctx.inline) {
          return codeSpan(text.replace(/\s+/g, " "));
        }
        const runs = text.match(/^`{3,}/gm) ?? [];
        const fence = "`".repeat(Math.max(2, ...runs.map(r => r.length)) + 1);
        const language = codeLanguage(el) || this.codeLanguages?.get(el.textContent.trim()) || "";
        return `\n\n${fence}${language}\n${text}\n${fence}\n\n`;
      }
      case "blockquote": {
        if (ctx.inline) {
          return this.children(el, ctx);
        }
        const inner = this.children(el, ctx).trim().replace(/\n{3,}/g, "\n\n");
        return inner ? this.block(inner.split("\n").map(line => (line ? `> ${line}` : ">")).join("\n")) : "";
      }
      case "ul":
      case "ol":
        return ctx.inline ? this.children(el, ctx) : this.list(el, ctx);
      case "li":
        // A list item outside a list.
        return ctx.inline ? this.children(el, ctx) : this.block(`- ${this.children(el, ctx).trim()}`);
      case "img": {
        const src = absolute(el.getAttribute("src") || el.getAttribute("data-src"), this.baseURL);
        const width = +el.getAttribute("width");
        const height = +el.getAttribute("height");
        if (!src || !/^https?:/i.test(src) || (width && width <= 2) || (height && height <= 2)) {
          return "";
        }
        const alt = (el.getAttribute("alt") ?? "").replace(/[[\]\n]/g, " ").trim();
        return `![${alt}](${src.replace(/[()\s]/g, c => encodeURIComponent(c))})`;
      }
      case "table":
        return ctx.inline ? this.inline(el, ctx) : this.table(el, ctx);
    }
    const inner = this.children(el, ctx);
    if (!ctx.inline && BLOCK_TAGS.has(tag)) {
      return this.block(inner);
    }
    return inner;
  }

  list(el, ctx) {
    const ordered = el.localName == "ol";
    let number = ordered ? parseInt(el.getAttribute("start") ?? "1", 10) || 1 : 0;
    const items = [];
    for (const child of el.children) {
      if (child.localName != "li" || this.skip(child)) {
        if (child.localName == "ul" || child.localName == "ol") {
          // A list directly inside a list: belongs to the previous item.
          const nested = this.list(child, ctx).trim();
          if (nested && items.length) {
            items[items.length - 1] += `\n${nested.replace(/^/gm, "   ")}`;
          }
        }
        continue;
      }
      const marker = ordered ? `${number++}. ` : "- ";
      const body = this.children(child, ctx)
        .replace(/^\s+|\s+$/g, "")
        .replace(/\n{3,}/g, "\n\n")
        // Tight lists: paragraphs inside an item don't need blank lines
        // unless the item really has several paragraphs.
        .replace(/\n\n(?=(?:\s*(?:[-*+]|\d+\.)\s))/g, "\n");
      const indent = " ".repeat(marker.length);
      items.push(marker + body.split("\n").map((line, i) => (i && line ? indent + line : line)).join("\n"));
    }
    return items.length ? `\n\n${items.join("\n")}\n\n` : "";
  }

  table(el, ctx) {
    const rows = [...el.querySelectorAll(":scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr")];
    // Layout tables (nested tables, a single column) are read as blocks.
    if (!rows.length || el.querySelector("table") || rows.every(r => r.cells.length < 2)) {
      return this.block(this.children(el, ctx));
    }
    const cell = c => this.inline(c, ctx).replace(/\|/g, "\\|") || " ";
    const width = Math.max(...rows.map(r => r.cells.length));
    const lines = rows.map(r => {
      const cells = [...r.cells].map(cell);
      while (cells.length < width) {
        cells.push(" ");
      }
      return `| ${cells.join(" | ")} |`;
    });
    lines.splice(1, 0, `| ${Array(width).fill("---").join(" | ")} |`);
    return `\n\n${lines.join("\n")}\n\n`;
  }
}

function tidy(markdown) {
  return markdown
    .split("\n")
    .map(line => (/\S {2}$/.test(line) ? line.replace(/\s+$/, "  ") : line.replace(/\s+$/, "")))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s*\n/, "")
    .trim();
}

// Converts a DOM subtree (element, fragment or document body) to Markdown.
export function htmlToMarkdown(root, { baseURL = "", pageChrome = false, codeLanguages = null } = {}) {
  if (!root) {
    return "";
  }
  const writer = new Writer({ baseURL, pageChrome, codeLanguages });
  return tidy(writer.node(root, {}));
}

// The selection in a window as Markdown, or "" when nothing is selected.
export function selectionToMarkdown(win) {
  const selection = win.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) {
    return "";
  }
  const doc = win.document;
  const parts = [];
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    const fragment = range.cloneContents();
    let start = range.commonAncestorContainer;
    if (start.nodeType != start.ELEMENT_NODE) {
      start = start.parentElement;
    }
    // Part of a code block keeps its fence; several list items keep their list.
    let wrapper = null;
    const pre = start?.closest("pre");
    if (pre) {
      wrapper = doc.createElement("pre");
      wrapper.className = pre.className;
    } else if (start?.localName == "ul" || start?.localName == "ol") {
      wrapper = doc.createElement(start.localName);
    }
    if (wrapper) {
      wrapper.append(fragment);
    }
    const markdown = htmlToMarkdown(wrapper ?? fragment, { baseURL: doc.baseURI });
    if (markdown) {
      parts.push(markdown);
    }
  }
  return parts.join("\n\n");
}

function sourceLine(url) {
  return /^(https?|file):/i.test(url) ? `Source: <${url.replace(/>/g, "%3E")}>` : "";
}

// The page as Markdown: { markdown, kind: "page" | "selection" }, or null
// when there's nothing to copy. `selection`: true (selection only), false
// (whole page) or "auto" (the selection when there is one).
export async function pageToMarkdown(doc, { selection = "auto" } = {}) {
  const win = doc?.defaultView;
  if (!win) {
    return null;
  }
  if (selection !== false) {
    const markdown = selectionToMarkdown(win);
    if (markdown) {
      return { markdown, kind: "selection" };
    }
    if (selection === true) {
      return null;
    }
  }
  const url = doc.documentURI.startsWith("about:reader?")
    ? (lazy.ReaderMode.getOriginalUrl(doc.documentURI) ?? doc.documentURI)
    : doc.documentURI;
  let title = (doc.title || "").trim();
  let body = "";
  let readerable = false;
  try {
    readerable = lazy.Readerable.isProbablyReaderable(doc);
  } catch (e) {}
  if (readerable) {
    try {
      const article = await lazy.ReaderMode.parseDocument(doc);
      if (article?.content) {
        title = (article.title || title).trim();
        const parsed = new DOMParser().parseFromString(article.content, "text/html");
        // Readability often repeats the title as the article's first heading.
        const first = parsed.body.querySelector("h1, h2");
        if (first && first.textContent.trim() == title && !first.previousElementSibling?.textContent.trim()) {
          first.remove();
        }
        // Reader View drops class names, and with them code languages:
        // take them from the page's own code blocks.
        const codeLanguages = new Map();
        for (const pre of doc.querySelectorAll("pre")) {
          const language = codeLanguage(pre);
          if (language) {
            codeLanguages.set(pre.textContent.trim(), language);
          }
        }
        body = htmlToMarkdown(parsed.body, { baseURL: url, codeLanguages });
        if (article.byline) {
          body = `_${escapeText(article.byline.trim())}_\n\n${body}`;
        }
      }
    } catch (e) {
      console.error("Whimsy: Reader View extraction failed, copying the page as is", e);
    }
  }
  if (!body) {
    const root = doc.querySelector("main, [role=main]") ?? doc.body;
    body = htmlToMarkdown(root, { baseURL: doc.baseURI, pageChrome: true });
    // The page's own first heading is usually the title.
    const heading = body.match(/^# (.+)\n/);
    if (heading && heading[1].trim() == escapeText(title)) {
      body = body.slice(heading[0].length).trim();
    }
  }
  if (!body.trim()) {
    return null;
  }
  const header = [title ? `# ${escapeText(title).replace(/\s+/g, " ")}` : "", sourceLine(url)].filter(Boolean).join("\n\n");
  return { markdown: tidy(`${header}\n\n${body}`), kind: "page" };
}
