/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Markdown/CSV viewer's page (WhimsyDocViewer converts the response
// into it). Pure functions: text in, a static HTML page out, with no
// script. Markdown goes through markdown-it (Firefox ships it in the
// ProseMirror bundle) with raw HTML off, so the file's own markup is shown
// as text; the result is sanitized again (nsIParserUtils) and the page
// carries a strict CSP. CSV/TSV cells are escaped by hand.

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "md", () => {
  const { MarkdownIt } = ChromeUtils.importESModule(
    "chrome://browser/content/multilineeditor/prosemirror.bundle.mjs"
  );
  return new MarkdownIt("default", { html: false, linkify: false, typographer: false });
});
ChromeUtils.defineLazyGetter(lazy, "parserUtils", () =>
  Cc["@mozilla.org/parserutils;1"].getService(Ci.nsIParserUtils)
);

export const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src * data: blob: file:; media-src * file:; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
// A file opened from disk loads nothing from the web: a downloaded README
// can't tell anyone it was opened through a remote image (security L8).
export const LOCAL_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob: file:; media-src file:; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
export const MAX_PREVIEW_CHARS = 5_000_000;
export const MAX_ROWS = 20_000;
export const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkd", "mkdn", "mdwn", "mdtxt"]);
export const CSV_EXTENSIONS = new Set(["csv"]);
export const TSV_EXTENSIONS = new Set(["tsv", "tab"]);

export function escapeHTML(text) {
  return String(text).replace(
    /[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

// "markdown", "csv", "tsv" or null for a URL's file extension.
export function kindForExtension(extension) {
  const ext = (extension ?? "").toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(ext)) {
    return "markdown";
  }
  if (CSV_EXTENSIONS.has(ext)) {
    return "csv";
  }
  if (TSV_EXTENSIONS.has(ext)) {
    return "tsv";
  }
  return null;
}

function slugify(text, used) {
  const base =
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section";
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  return `h-${count ? `${base}-${count}` : base}`;
}

function inlineText(token) {
  if (!token?.children) {
    return token?.content ?? "";
  }
  return token.children
    .filter(t => t.type == "text" || t.type == "code_inline")
    .map(t => t.content)
    .join("");
}

// Markdown to { html (sanitized), toc: [{ level, text, id }], title, words }.
export function renderMarkdown(text) {
  const md = lazy.md;
  const env = {};
  const tokens = md.parse(text, env);
  const toc = [];
  const used = new Map();
  let title = "";
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type != "heading_open") {
      continue;
    }
    const headingText = inlineText(tokens[i + 1]).trim();
    const id = slugify(headingText, used);
    token.attrSet("id", id);
    const level = Number(token.tag.slice(1));
    if (level == 1 && !title) {
      title = headingText;
    }
    toc.push({ level, text: headingText, id });
  }
  const rendered = md.renderer.render(tokens, md.options, env);
  const sanitized = lazy.parserUtils.sanitize(rendered, Ci.nsIParserUtils.SanitizerDropForms);
  const html = sanitized.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "";
  const words = (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
  return { html, toc, title, words };
}

// Picks the separator a CSV file uses (some locales use ";").
export function detectSeparator(text, kind) {
  if (kind == "tsv") {
    return "\t";
  }
  const firstLine = text.slice(0, 4096).split(/\r?\n/, 1)[0].replace(/"[^"]*"/g, "");
  const counts = [",", ";", "\t"].map(sep => [sep, firstLine.split(sep).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] ? counts[0][0] : ",";
}

// RFC 4180 parsing: quoted fields, doubled quotes, newlines inside quotes.
export function parseDelimited(text, separator, maxRows = MAX_ROWS) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let truncated = false;
  const input = text.replace(/^﻿/, "");
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c == '"') {
        if (input[i + 1] == '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c == '"' && field === "") {
      quoted = true;
    } else if (c == separator) {
      row.push(field);
      field = "";
    } else if (c == "\n" || c == "\r") {
      if (c == "\r" && input[i + 1] == "\n") {
        i++;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (rows.length > maxRows) {
        truncated = true;
        break;
      }
    } else {
      field += c;
    }
  }
  if (!truncated && (field !== "" || row.length)) {
    row.push(field);
    rows.push(row);
  }
  return { rows: truncated ? rows.slice(0, maxRows + 1) : rows, truncated };
}

// Sort key for a cell: numbers (1,234.5, -3, 12%) sort as numbers.
export function cellNumber(text) {
  const t = text.trim().replace(/[,\s]/g, "").replace(/%$/, "");
  return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t) ? parseFloat(t) : null;
}

function tableHTML(rows, strings) {
  if (!rows.length) {
    return `<p class="empty">${escapeHTML(strings.empty)}</p>`;
  }
  const width = Math.max(...rows.map(r => r.length));
  const [header, ...body] = rows;
  const th = [];
  for (let i = 0; i < width; i++) {
    th.push(
      `<th scope="col" data-col="${i}" tabindex="0" aria-sort="none"><span>${escapeHTML(header[i] ?? "")}</span></th>`
    );
  }
  const numeric = [];
  for (let i = 0; i < width; i++) {
    const values = body.slice(0, 200).map(r => r[i] ?? "").filter(v => v.trim());
    numeric[i] = values.length > 0 && values.every(v => cellNumber(v) !== null);
  }
  const tr = body.map(
    r =>
      `<tr>${Array.from({ length: width }, (_, i) => `<td${numeric[i] ? ' class="num"' : ""}>${escapeHTML(r[i] ?? "")}</td>`).join("")}</tr>`
  );
  return `<div class="table-wrap"><table><thead><tr>${th.join("")}</tr></thead><tbody>${tr.join("")}</tbody></table></div>`;
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #15141a; --muted: #5b5b66; --line: rgba(21, 20, 26, 0.12);
  --accent: #0061e0; --code-bg: rgba(21, 20, 26, 0.05); --bar-bg: rgba(255, 255, 255, 0.82);
  --row-alt: rgba(21, 20, 26, 0.03); --radius: 8px;
  --reader-font: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1c1b22; --fg: #fbfbfe; --muted: #bfbfc9; --line: rgba(251, 251, 254, 0.14);
    --accent: #45a1ff; --code-bg: rgba(251, 251, 254, 0.07); --bar-bg: rgba(28, 27, 34, 0.82);
    --row-alt: rgba(251, 251, 254, 0.03);
  }
}
* { box-sizing: border-box; }
html { scroll-padding-top: 64px; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 18px/1.6 var(--reader-font); -moz-osx-font-smoothing: grayscale; }
.raw-toggle { position: absolute; opacity: 0; pointer-events: none; }
.bar {
  position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 12px;
  padding: 10px 20px; background: var(--bar-bg); backdrop-filter: blur(16px);
  border-bottom: 1px solid var(--line); font-size: 13px;
}
.bar .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar .meta { color: var(--muted); white-space: nowrap; }
.bar .live { color: var(--muted); }
.bar .switch {
  margin-inline-start: auto; cursor: default; user-select: none; padding: 4px 10px; border-radius: var(--radius);
  border: 1px solid var(--line); background: var(--code-bg); font-weight: 500;
}
.bar .switch:hover { background: color-mix(in srgb, var(--code-bg), var(--fg) 6%); }
.raw-toggle:focus-visible ~ .bar .switch { outline: 2px solid var(--accent); outline-offset: 2px; }
.raw-toggle:checked ~ .bar .to-raw, .raw-toggle:not(:checked) ~ .bar .to-preview { display: none; }
.raw-toggle:checked ~ .layout { display: none; }
.raw-toggle:not(:checked) ~ .raw { display: none; }
.layout { display: grid; grid-template-columns: minmax(0, 40em); justify-content: center; gap: 48px; padding: 32px 20px 96px; }
.layout.has-toc { grid-template-columns: 220px minmax(0, 40em); }
.toc { font-size: 14px; line-height: 1.4; }
.toc summary { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 8px; cursor: default; }
.toc ol { list-style: none; margin: 0; padding: 0; }
.toc li { margin: 0; }
.toc a { display: block; padding: 3px 8px; border-radius: 6px; color: var(--muted); text-decoration: none; }
.toc a:hover { color: var(--fg); background: var(--code-bg); }
.toc .l2 a { padding-inline-start: 18px; } .toc .l3 a { padding-inline-start: 28px; }
.toc .l4 a, .toc .l5 a, .toc .l6 a { padding-inline-start: 38px; font-size: 13px; }
@media (min-width: 1000px) { .toc { position: sticky; top: 72px; align-self: start; max-height: calc(100vh - 96px); overflow: auto; } }
@media (max-width: 999px) { .layout.has-toc { grid-template-columns: minmax(0, 40em); gap: 16px; } .toc { border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 12px; } }
article { min-width: 0; overflow-wrap: break-word; }
article h1, article h2, article h3, article h4 { line-height: 1.25; margin: 1.6em 0 0.5em; }
article h1 { font-size: 2em; margin-top: 0; } article h2 { font-size: 1.5em; padding-bottom: 0.2em; border-bottom: 1px solid var(--line); }
article h3 { font-size: 1.25em; }
article a { color: var(--accent); }
article img { max-width: 100%; height: auto; }
article code { font: 0.88em/1.4 var(--mono); background: var(--code-bg); padding: 0.15em 0.35em; border-radius: 4px; }
article pre, .raw { font: 14px/1.5 var(--mono); background: var(--code-bg); padding: 14px 16px; border-radius: var(--radius); overflow: auto; tab-size: 4; }
article pre code { background: none; padding: 0; font-size: inherit; }
article blockquote { margin: 1em 0; padding: 0 1em; color: var(--muted); border-inline-start: 3px solid var(--line); }
article hr { border: none; border-top: 1px solid var(--line); margin: 2em 0; }
article table { border-collapse: collapse; display: block; overflow: auto; font-size: 0.9em; }
article th, article td { border: 1px solid var(--line); padding: 6px 12px; }
.raw { margin: 24px auto 96px; max-width: min(100% - 40px, 60em); white-space: pre-wrap; overflow-wrap: anywhere; background: none; }
.sheet .layout { grid-template-columns: minmax(0, max-content); padding-inline: 20px; }
.table-wrap { overflow: auto; border: 1px solid var(--line); border-radius: var(--radius); max-width: calc(100vw - 40px); }
.sheet table { border-collapse: separate; border-spacing: 0; font: 14px/1.4 var(--reader-font); font-variant-numeric: tabular-nums; }
.sheet th, .sheet td { padding: 6px 12px; border-bottom: 1px solid var(--line); text-align: start; white-space: pre-wrap; max-width: 40ch; vertical-align: top; }
.sheet td.num { text-align: end; }
.sheet tbody tr:nth-child(even) { background: var(--row-alt); }
.sheet th { position: sticky; top: 0; background: var(--bg); font-weight: 600; cursor: default; user-select: none; }
.sheet th:hover { background: color-mix(in srgb, var(--bg), var(--fg) 5%); }
.sheet th:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.sheet th::after { content: ""; display: inline-block; width: 1em; margin-inline-start: 4px; color: var(--muted); }
.sheet th[aria-sort="ascending"]::after { content: "\\2191"; }
.sheet th[aria-sort="descending"]::after { content: "\\2193"; }
.note, .empty { color: var(--muted); font-size: 14px; }
@media (prefers-reduced-motion: no-preference) { html { scroll-behavior: smooth; } }
`;

// The page's <body> contents. strings: { source, preview, table, contents,
// empty, truncated, tooLarge, meta } (already localized).
export function renderBody({ text, kind, name, strings }) {
  const tooLarge = text.length > MAX_PREVIEW_CHARS;
  let main = "";
  let toc = "";
  let title = name;
  let meta = strings.meta ?? "";
  if (tooLarge) {
    main = `<p class="note">${escapeHTML(strings.tooLarge)}</p>`;
  } else if (kind == "markdown") {
    const rendered = renderMarkdown(text);
    title = rendered.title || name;
    main = `<article>${rendered.html}</article>`;
    if (rendered.toc.length >= 2) {
      const minLevel = Math.min(...rendered.toc.map(h => h.level));
      const items = rendered.toc
        .map(h => `<li class="l${h.level - minLevel + 1}"><a href="#${escapeHTML(h.id)}">${escapeHTML(h.text)}</a></li>`)
        .join("");
      toc = `<details class="toc" open=""><summary>${escapeHTML(strings.contents)}</summary><nav><ol>${items}</ol></nav></details>`;
    }
  } else {
    const { rows, truncated } = parseDelimited(text, detectSeparator(text, kind));
    main = tableHTML(rows, strings);
    if (truncated) {
      main += `<p class="note">${escapeHTML(strings.truncated)}</p>`;
    }
  }
  const body =
    `<input type="checkbox" id="whimsy-doc-raw" class="raw-toggle"${tooLarge ? ' checked=""' : ""} aria-label="${escapeHTML(strings.source)}">` +
    `<header class="bar"><span class="name">${escapeHTML(name)}</span><span class="meta">${escapeHTML(meta)}</span><span class="live"></span>` +
    `<label for="whimsy-doc-raw" class="switch"><span class="to-raw">${escapeHTML(strings.source)}</span>` +
    `<span class="to-preview">${escapeHTML(kind == "markdown" ? strings.preview : strings.table)}</span></label></header>` +
    `<div class="layout${toc ? " has-toc" : ""}">${toc}<main>${main}</main></div>` +
    `<pre class="raw">${escapeHTML(text)}</pre>`;
  return { body, title };
}

// The whole page.
export function renderPage({ text, kind, name, strings, local = false }) {
  const { body, title } = renderBody({ text, kind, name, strings });
  return (
    `<!DOCTYPE html><html dir="auto"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${escapeHTML(local ? LOCAL_CSP : CSP)}">` +
    `<meta name="color-scheme" content="light dark"><meta name="viewport" content="width=device-width">` +
    `<title>${escapeHTML(title)}</title><style>${STYLE}</style></head>` +
    `<body class="whimsy-doc ${kind == "markdown" ? "prose" : "sheet"}">${body}</body></html>`
  );
}
