/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave5/verbs: the page's selection as Markdown, for the "Copy as Markdown"
// selection verb (WhimsyVerbs.sys.mjs). Runs in the content process, called
// by WhimsyPageChild. Covers what people actually select: paragraphs,
// headings, emphasis, links (absolute), inline code, code blocks, lists,
// quotes and images. Anything else falls through to its text.

const BLOCKS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "DD",
  "DIV",
  "DL",
  "DT",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "HEADER",
  "MAIN",
  "NAV",
  "P",
  "SECTION",
  "TABLE",
  "TR",
]);
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "svg"]);

function inline(text) {
  return text.replace(/\s+/g, " ");
}

function wrap(mark, inner) {
  const trimmed = inner.trim();
  if (!trimmed) {
    return inner;
  }
  const lead = inner.match(/^\s*/)[0];
  const tail = inner.match(/\s*$/)[0];
  return `${lead}${mark}${trimmed}${mark}${tail}`;
}

function children(node, ctx) {
  let out = "";
  for (const child of node.childNodes) {
    out += convert(child, ctx);
  }
  return out;
}

function convert(node, ctx) {
  if (node.nodeType == 3) {
    return ctx.pre ? node.data : inline(node.data);
  }
  if (node.nodeType != 1 && node.nodeType != 11) {
    return "";
  }
  if (node.nodeType == 11) {
    return children(node, ctx);
  }
  const tag = node.localName.toUpperCase();
  if (SKIP.has(node.localName) || SKIP.has(tag) || node.hidden) {
    return "";
  }
  switch (tag) {
    case "BR":
      return "  \n";
    case "HR":
      return "\n\n---\n\n";
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      return `\n\n${"#".repeat(+tag[1])} ${children(node, ctx).trim()}\n\n`;
    case "STRONG":
    case "B":
      return wrap("**", children(node, ctx));
    case "EM":
    case "I":
      return wrap("_", children(node, ctx));
    case "S":
    case "DEL":
      return wrap("~~", children(node, ctx));
    case "CODE":
      if (ctx.pre) {
        return node.textContent;
      }
      return wrap("`", node.textContent.replace(/`/g, "\\`"));
    case "PRE": {
      const code = node.textContent.replace(/\n$/, "");
      const lang = (node.querySelector?.("code")?.className.match(/language-([\w+-]+)/) ?? [])[1] ?? "";
      return `\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
    }
    case "A": {
      const text = children(node, ctx).trim();
      const href = node.href;
      if (!href || href.startsWith("javascript:")) {
        return text;
      }
      return `[${text || href}](${href})`;
    }
    case "IMG": {
      const src = node.src;
      return src ? `![${node.alt || ""}](${src})` : "";
    }
    case "UL":
    case "OL": {
      const depth = ctx.depth ?? 0;
      let index = Number(node.getAttribute("start")) || 1;
      let out = "";
      for (const item of node.children) {
        if (item.localName != "li") {
          continue;
        }
        const marker = tag == "OL" ? `${index++}.` : "-";
        const body = children(item, { ...ctx, depth: depth + 1 })
          .trim()
          .replace(/\n{2,}/g, "\n")
          .replace(/\n/g, `\n${"  ".repeat(depth + 1)}`);
        out += `${"  ".repeat(depth)}${marker} ${body}\n`;
      }
      return depth ? `\n${out}` : `\n\n${out}\n`;
    }
    case "LI":
      // A list item selected without its list.
      return `- ${children(node, ctx).trim()}\n`;
    case "BLOCKQUOTE": {
      const body = children(node, ctx).trim().replace(/\n{3,}/g, "\n\n");
      return `\n\n${body.replace(/^/gm, "> ")}\n\n`;
    }
    case "TD":
    case "TH":
      return `${children(node, ctx).trim()} `;
  }
  const out = children(node, ctx);
  return BLOCKS.has(tag) ? `\n\n${out}\n\n` : out;
}

/** Markdown for a node or fragment (whitespace tidied). */
export function toMarkdown(node) {
  return convert(node, { pre: false, depth: 0 })
    .replace(/[ \t]+\n/g, m => (m.endsWith("  \n") ? "  \n" : "\n"))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The window's selection as Markdown, or "" when nothing is selected. */
export function selectionToMarkdown(win) {
  const selection = win.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    return "";
  }
  const holder = win.document.createElement("div");
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    // Keep the list/heading/code a partial selection sits in, so a few
    // selected list items still come out as a list.
    const container = range.commonAncestorContainer;
    const fragment = range.cloneContents();
    const parent = container.nodeType == 1 ? container : container.parentElement;
    if (parent && /^(ul|ol|pre|h[1-6]|blockquote)$/.test(parent.localName) && fragment.firstChild) {
      const shell = parent.cloneNode(false);
      shell.append(fragment);
      holder.append(shell);
    } else {
      holder.append(fragment);
    }
  }
  return toMarkdown(holder);
}
