/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Markdown and CSV viewer. Opening a README or a notes file shows a wall of
// asterisks (or a download), and a CSV a download prompt; Typora, Marked
// and GitHub's file view are loved because the file just reads, with a
// table of contents, and a CSV is a table you can sort. This works the way
// Firefox's JSON viewer does: a content sniffer (net-content-sniffers)
// claims top-level document loads of
// - local .md/.markdown, .csv and .tsv files (file://), and
// - web .md/.csv/.tsv files served as text/plain (raw GitHub files and the
//   like) or anything served as text/markdown,
// and a stream converter turns them into a static page: Markdown with
// reader typography and a contents list, CSV/TSV as a table whose columns
// sort when you click their header. "Source" shows the file as it is. A
// local file re-renders when it's saved (checked once a second while the
// tab is visible).
//
// Safe by construction: the page has no script at all (sorting, the
// reload and nothing else run here, in Whimsy's privileged code, on the
// page's DOM); markdown-it renders with raw HTML off and blocks
// javascript:/data: links, the result is sanitized again, and the page
// carries a CSP with default-src 'none'. Downloads (Content-Disposition:
// attachment), frames and view-source are left alone, and
// whimsy.feature.doc-viewer switches it all off.

import {
  CSP,
  cellNumber,
  kindForExtension,
  renderBody,
  renderPage,
} from "resource:///modules/whimsy/WhimsyDocRender.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"]));

const FEATURE_PREF = "whimsy.feature.doc-viewer";
export const VIEW_TYPE = "application/vnd.whimsy.doc.view";
const MARKDOWN_TYPES = new Set(["text/markdown", "text/x-markdown"]);
const RELOAD_INTERVAL_MS = 1000;
// A local file that had to be reloaded keeps its Source toggle (by URL).
const keptState = new Map();
const ORIGINAL_TYPES = { markdown: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values" };

const BinaryInput = Components.Constructor("@mozilla.org/binaryinputstream;1", "nsIBinaryInputStream", "setInputStream");
const BufferStream = Components.Constructor("@mozilla.org/io/arraybuffer-input-stream;1", "nsIArrayBufferInputStream", "setData");

function extensionOf(uri) {
  try {
    return uri.QueryInterface(Ci.nsIURL).fileExtension.toLowerCase();
  } catch (e) {
    return "";
  }
}

// What the viewer would show for a channel: "markdown", "csv", "tsv" or null.
export function viewKind(uri, contentType) {
  if (!uri || !["file", "http", "https"].includes(uri.scheme)) {
    return null;
  }
  const byExtension = kindForExtension(extensionOf(uri));
  if (uri.scheme == "file") {
    return byExtension;
  }
  const type = (contentType ?? "").toLowerCase();
  if (MARKDOWN_TYPES.has(type)) {
    return "markdown";
  }
  return type == "text/plain" ? byExtension : null;
}

function isAttachment(channel) {
  try {
    return channel.contentDisposition == Ci.nsIChannel.DISPOSITION_ATTACHMENT;
  } catch (e) {
    return false;
  }
}

export class WhimsyDocSniffer {
  QueryInterface = ChromeUtils.generateQI(["nsIContentSniffer"]);

  getMIMETypeFromContent(request) {
    if (!(request instanceof Ci.nsIChannel)) {
      return "";
    }
    const claimable =
      Services.prefs.getBoolPref(FEATURE_PREF, true) &&
      request.loadInfo?.isTopLevelLoad &&
      request.loadFlags & Ci.nsIChannel.LOAD_DOCUMENT_URI &&
      !isAttachment(request);
    // Re-sniffing a claimed load keeps it; anywhere else it's plain text
    // again (as the JSON viewer does).
    if (request.contentType == VIEW_TYPE) {
      return claimable ? "" : "text/plain";
    }
    return claimable && viewKind(request.URI, request.contentType) ? VIEW_TYPE : "";
  }
}

function windowForRequest(request) {
  try {
    return request.notificationCallbacks.getInterface(Ci.nsILoadContext).associatedWindow;
  } catch (e) {}
  try {
    return request.loadGroup.notificationCallbacks.getInterface(Ci.nsILoadContext).associatedWindow;
  } catch (e) {}
  return null;
}

function fileName(uri) {
  try {
    return decodeURIComponent(uri.QueryInterface(Ci.nsIURL).fileName) || uri.spec;
  } catch (e) {
    return uri.spec;
  }
}

async function pageStrings(kind, text) {
  const words = (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
  const rows = kind == "markdown" ? 0 : text.split(/\r\n|\r|\n/).filter(Boolean).length - 1;
  let values = [];
  try {
    values = await lazy.l10n.formatValues([
    { id: "whimsy-doc-viewer-source" },
    { id: "whimsy-doc-viewer-preview" },
    { id: "whimsy-doc-viewer-table" },
    { id: "whimsy-doc-viewer-contents" },
    { id: "whimsy-doc-viewer-empty" },
    { id: "whimsy-doc-viewer-truncated" },
    { id: "whimsy-doc-viewer-too-large" },
    kind == "markdown"
      ? { id: "whimsy-doc-viewer-meta-markdown", args: { words } }
      : { id: "whimsy-doc-viewer-meta-table", args: { kind: kind.toUpperCase(), rows: Math.max(0, rows) } },
    ]);
  } catch (e) {
    console.error("Whimsy: Markdown/CSV viewer strings", e);
  }
  // English if the strings can't load, so the page still renders.
  const [
    source = "Source",
    preview = "Preview",
    table = "Table",
    contents = "Contents",
    empty = "This file is empty.",
    truncated = "Showing the first rows only.",
    tooLarge = "This file is too large to preview.",
    meta = "",
  ] = values.map(v => v ?? undefined);
  return { source, preview, table, contents, empty, truncated, tooLarge, meta };
}

export class WhimsyDocConverter {
  QueryInterface = ChromeUtils.generateQI(["nsIStreamConverter", "nsIStreamListener", "nsIRequestObserver"]);

  convert() {
    throw Components.Exception("", Cr.NS_ERROR_NOT_IMPLEMENTED);
  }

  asyncConvertData(fromType, toType, listener) {
    this.listener = listener;
  }

  getConvertedType(fromType, channel) {
    if (channel instanceof Ci.nsIMultiPartChannel) {
      throw Components.Exception("", Cr.NS_ERROR_FAILURE);
    }
    return "text/html";
  }

  onStartRequest(request) {
    request.QueryInterface(Ci.nsIChannel);
    this.uri = request.URI;
    let originalType = "";
    if (request instanceof Ci.nsIHttpChannel) {
      try {
        originalType = request.getResponseHeader("Content-Type").split(";")[0].trim().toLowerCase();
        request.setResponseHeader("Content-Security-Policy", CSP, false);
        request.setResponseHeader("Content-Security-Policy-Report-Only", "", false);
      } catch (e) {}
    }
    this.kind = viewKind(this.uri, originalType || "text/plain") ?? "markdown";
    request.contentType = "text/html";
    request.contentCharset = "UTF-8";
    // Save Page As saves the file, not the rendered page.
    try {
      request.QueryInterface(Ci.nsIWritablePropertyBag).setProperty("contentType", originalType || ORIGINAL_TYPES[this.kind]);
    } catch (e) {}
    this.decoder = new TextDecoder("utf-8");
    this.text = "";
    this.listener.onStartRequest(request);
    const win = windowForRequest(request);
    this.doc = win?.document?.documentURI == this.uri.spec ? win.document : null;
  }

  onDataAvailable(request, stream, offset, count) {
    const buffer = new ArrayBuffer(count);
    new BinaryInput(stream).readArrayBuffer(count, buffer);
    this.text += this.decoder.decode(buffer, { stream: true });
  }

  onStopRequest(request, status) {
    if (!Components.isSuccessCode(status)) {
      this.listener.onStopRequest(request, status);
      return;
    }
    this.text += this.decoder.decode();
    this.finish(request, status);
  }

  async finish(request, status) {
    const { listener, kind, text, uri, doc } = this;
    this.listener = null;
    this.text = "";
    try {
      const strings = await pageStrings(kind, text);
      const html = renderPage({ text, kind, name: fileName(uri), strings });
      const buffer = new TextEncoder().encode(html).buffer;
      const stream = new BufferStream(buffer, 0, buffer.byteLength);
      listener.onDataAvailable(request, stream, 0, buffer.byteLength);
    } catch (e) {
      console.error("Whimsy: Markdown/CSV viewer", e);
    }
    listener.onStopRequest(request, status);
    if (doc) {
      WhimsyDocViewer.attach(doc, { kind, uri });
    }
  }
}

export const WhimsyDocViewer = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  // Sorting and live reload, run from here on the page (it has no script).
  attach(doc, { kind, uri }) {
    if (kind != "markdown") {
      const onSort = event => {
        if (event.type == "keydown" && event.key != "Enter" && event.key != " ") {
          return;
        }
        const th = event.target?.closest?.("th[data-col]");
        if (!th) {
          return;
        }
        event.preventDefault();
        this.sortBy(th);
      };
      doc.addEventListener("click", onSort);
      doc.addEventListener("keydown", onSort);
    }
    if (uri.scheme != "file") {
      return;
    }
    const ready = () => {
      const kept = keptState.get(uri.spec);
      keptState.delete(uri.spec);
      const toggle = doc.getElementById("whimsy-doc-raw");
      if (kept?.raw && toggle) {
        toggle.checked = true;
      }
      this.watch(doc, { kind, uri });
    };
    if (doc.readyState == "loading") {
      doc.addEventListener("DOMContentLoaded", ready, { once: true });
    } else {
      ready();
    }
  },

  // Sorts the table by a column: ascending, then descending, then the
  // file's own order. Numbers sort as numbers; empty cells go last.
  sortBy(th) {
    const table = th.closest("table");
    const tbody = table?.tBodies[0];
    if (!tbody) {
      return;
    }
    const col = Number(th.dataset.col);
    const next = { none: "ascending", ascending: "descending", descending: "none" }[th.getAttribute("aria-sort")] ?? "ascending";
    for (const other of table.querySelectorAll("th[data-col]")) {
      other.setAttribute("aria-sort", "none");
    }
    th.setAttribute("aria-sort", next);
    const rows = [...tbody.rows];
    rows.forEach((row, i) => {
      if (!row.dataset.order) {
        row.dataset.order = String(i);
      }
    });
    if (next == "none") {
      rows.sort((a, b) => a.dataset.order - b.dataset.order);
    } else {
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
      const dir = next == "ascending" ? 1 : -1;
      const key = row => row.cells[col]?.textContent ?? "";
      rows.sort((a, b) => {
        const x = key(a);
        const y = key(b);
        if (!x.trim() || !y.trim()) {
          return !x.trim() - !y.trim();
        }
        const nx = cellNumber(x);
        const ny = cellNumber(y);
        const cmp = nx !== null && ny !== null ? nx - ny : collator.compare(x, y);
        return cmp * dir || a.dataset.order - b.dataset.order;
      });
    }
    tbody.append(...rows);
  },

  // Re-renders a local file when it changes on disk.
  watch(doc, { kind, uri }) {
    let file;
    try {
      file = uri.QueryInterface(Ci.nsIFileURL).file;
    } catch (e) {
      return;
    }
    const win = doc.defaultView;
    if (!win) {
      return;
    }
    let last = null;
    let busy = false;
    let timer = null;
    const modified = () => {
      try {
        const f = file.clone();
        return f.exists() ? f.lastModifiedTime : null;
      } catch (e) {
        return null;
      }
    };
    const check = async () => {
      if (!doc.defaultView || busy || doc.hidden) {
        return;
      }
      const now = modified();
      if (now === null || now === last) {
        return;
      }
      if (last === null) {
        last = now;
        return;
      }
      last = now;
      busy = true;
      try {
        // The file content process may read local files (IOUtils is
        // parent-only).
        const text = this.readFile(file);
        await this.rerender(doc, { kind, uri, text });
      } catch (e) {
        // Couldn't read it here: reload the page, keeping the toggle.
        keptState.set(uri.spec, { raw: !!doc.getElementById("whimsy-doc-raw")?.checked });
        doc.defaultView?.location.reload();
      } finally {
        busy = false;
      }
    };
    const start = () => {
      if (!timer && this.enabled) {
        last = modified();
        timer = lazy.setInterval(check, RELOAD_INTERVAL_MS);
      }
    };
    const stop = () => {
      if (timer) {
        lazy.clearInterval(timer);
        timer = null;
      }
    };
    win.addEventListener("pagehide", stop);
    win.addEventListener("pageshow", start);
    start();
  },

  readFile(file) {
    const stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
    stream.init(file, -1, 0, 0);
    try {
      return new TextDecoder("utf-8").decode(lazy.NetUtil.readInputStream(stream, stream.available()));
    } finally {
      stream.close();
    }
  },

  async rerender(doc, { kind, uri, text }) {
    if (!doc.defaultView) {
      return;
    }
    const strings = await pageStrings(kind, text);
    const { body, title } = renderBody({ text, kind, name: fileName(uri), strings });
    const raw = doc.getElementById("whimsy-doc-raw")?.checked;
    const scroll = doc.defaultView.scrollY;
    doc.body.innerHTML = body;
    doc.title = title;
    const toggle = doc.getElementById("whimsy-doc-raw");
    if (toggle && raw !== undefined) {
      toggle.checked = raw;
    }
    doc.defaultView.scrollTo(0, scroll);
    const event = new doc.defaultView.Event("WhimsyDocReloaded");
    doc.dispatchEvent(event);
  },
};
