/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Upload from the clipboard: the parent half. Shows a small popup anchored
// near the click with the clipboard image (if there is one), the five
// newest downloads, and "Choose file...". Loved for screenshots: capture
// one (Cmd+Ctrl+Shift+4 on macOS), click any upload button, click the
// thumbnail.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
  WhimsyUploadBadges: "resource:///modules/whimsy/WhimsyUploadBadges.sys.mjs",
  WhimsyImageMetadata: "resource:///modules/whimsy/WhimsyImageMetadata.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
  WhimsyFireButton: "resource:///modules/whimsy/WhimsyFireButton.sys.mjs",
});

// The two clipboard flavors paste to upload reads. W13-R2: the badges check
// these same flavors (clipboardKind), types only, so a badge never shows for
// something the paste can't read.
export const FILE_FLAVOR = "application/x-moz-file";
export const IMAGE_FLAVOR = "image/png";

const hasFlavor = flavor => Services.clipboard.hasDataMatchingFlavors([flavor], Ci.nsIClipboard.kGlobalClipboard);

// "file", "image" or null: what Cmd+V would upload, by the clipboard's type
// alone (no contents are read, so macOS doesn't ask).
export function clipboardKind() {
  try {
    if (hasFlavor(FILE_FLAVOR)) {
      return "file";
    }
    return hasFlavor(IMAGE_FLAVOR) ? "image" : null;
  } catch (e) {
    return null;
  }
}

async function clipboardImagePath() {
  if (!hasFlavor(IMAGE_FLAVOR)) {
    return null;
  }
  try {
    const transferable = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
    transferable.init(null);
    transferable.addDataFlavor(IMAGE_FLAVOR);
    Services.clipboard.getData(transferable, Ci.nsIClipboard.kGlobalClipboard);
    const data = {};
    transferable.getTransferData(IMAGE_FLAVOR, data);
    // An image another app put there (a ⌘⌃⇧4 screenshot, Preview's Copy)
    // arrives as PNG bytes; one Firefox put there (Copy Image) as a decoded
    // image, encoded to PNG here.
    let stream;
    if (data.value instanceof Ci.nsIInputStream) {
      stream = data.value;
    } else {
      const container = data.value.QueryInterface(Ci.imgIContainer);
      const imgTools = Cc["@mozilla.org/image/tools;1"].getService(Ci.imgITools);
      stream = imgTools.encodeImage(container, IMAGE_FLAVOR);
    }
    const available = stream.available();
    const binary = lazy.NetUtil.readInputStreamToString(stream, available);
    const bytes = new Uint8Array(available);
    for (let i = 0; i < available; i++) {
      bytes[i] = binary.charCodeAt(i) & 0xff;
    }
    // FileUtils.getFile is gone from Firefox; PathUtils gives the temp dir.
    const path = PathUtils.join(PathUtils.tempDir, "whimsy-clipboard-upload.png");
    await IOUtils.write(path, bytes);
    return path;
  } catch (e) {
    console.error("Whimsy: reading the clipboard image failed", e);
    return null;
  }
}

// A file copied in Finder (Cmd+C): the clipboard holds its path. Finder also
// puts the file's icon there as an image, so a copied file wins over
// clipboardImagePath (otherwise pasting a copied PDF uploads its icon).
function clipboardFilePath() {
  const flavor = FILE_FLAVOR;
  if (!hasFlavor(flavor)) {
    return null;
  }
  try {
    const transferable = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
    transferable.init(null);
    transferable.addDataFlavor(flavor);
    Services.clipboard.getData(transferable, Ci.nsIClipboard.kGlobalClipboard);
    const data = {};
    transferable.getTransferData(flavor, data);
    const file = data.value?.QueryInterface(Ci.nsIFile);
    return file?.exists() && file.isFile() ? file.path : null;
  } catch (e) {
    console.error("Whimsy: reading the clipboard file failed", e);
    return null;
  }
}

// What Cmd+V uploads: a copied file, else the clipboard image.
// { path, isFile } or null. Overridable for tests.
export async function clipboardUpload() {
  const file = clipboardFilePath();
  if (file) {
    return { path: file, isFile: true };
  }
  const image = await clipboardImagePath();
  return image ? { path: image, isFile: false } : null;
}

const isPasteKey = e =>
  e.key?.toLowerCase() == "v" &&
  (AppConstants.platform == "macosx" ? e.metaKey : e.ctrlKey) &&
  !e.altKey &&
  !e.shiftKey;

// wave8/isolation: only the asking page's own side and profile. A private
// tab sees private downloads (as a private window's panel does), a normal
// tab none of them; a tab sees only downloads made in its own container
// (profile), so one profile's files are never offered to another's pages.
export async function recentDownloads({ isPrivate = false, userContextId = 0 } = {}) {
  try {
    const list = await lazy.Downloads.getList(isPrivate ? lazy.Downloads.PRIVATE : lazy.Downloads.PUBLIC);
    const all = await list.getAll();
    return all
      .filter(d => d.succeeded && d.target?.path && !!d.source?.isPrivate == isPrivate &&
        (d.source?.userContextId || 0) == (userContextId || 0))
      .sort((a, b) => (b.startTime || 0) - (a.startTime || 0))
      .slice(0, 5)
      .map(d => ({ path: d.target.path, name: PathUtils.filename(d.target.path) }));
  } catch (e) {
    return [];
  }
}

// The File itself is made here and sent with the answer: a web content
// process may not create a File from a path (dom.file.createInChild is off
// outside tests; BackgroundParentImpl refuses with InvalidStateError), so
// pasting an image into an upload button failed there.
//
// W27/W29: the photo loses the details Settings removes (the download on
// disk stays as it is). With `ask` (the sheet), the person picks them; a
// cancelled sheet gives { cancelled: true }.
async function withFile(result, ask = null) {
  if (!result?.path) {
    return result;
  }
  let file;
  try {
    file = await File.createFromFileName(result.path);
  } catch (e) {
    console.error("Whimsy: reading the file to upload failed", e);
    return null;
  }
  const files = await lazy.WhimsyImageMetadata.filesToUpload([file], null, ask);
  return files ? { ...result, file: files[0] } : { cancelled: true };
}

// W29: a Cmd+V whose photo has details to ask about. The parent reads the
// clipboard at the key press, but the sheet waits until the page has had
// its paste; the child then asks for it by this token. One at a time.
const pastes = new Map();
// Each window's open sheet: cancels it.
const sheets = new WeakMap();
let nextPasteToken = 1;

// W29: a screen rect in device pixels (from the page) in `win`'s CSS pixels.
function chromeRect(win, rect) {
  if (!rect || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) {
    return null;
  }
  const scale = win.devicePixelRatio || 1;
  return { left: rect.left / scale, top: rect.top / scale, width: rect.width / scale, height: rect.height / scale };
}

// Security L1: when the person last pressed Cmd+V (Ctrl+V elsewhere) in
// each window, as the parent saw it. The child's paste request is honoured
// only right after one, so a page (or a compromised content process) can't
// pull the clipboard's file whenever it likes.
const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const pasteKeys = new WeakMap();
const PASTE_GESTURE_MS = 2000;

export class WhimsyUploadParent extends JSWindowActorParent {
  // Overridable for tests.
  static clipboardUpload = clipboardUpload;
  static recentDownloads = recentDownloads;

  static initWindow(win) {
    win.addEventListener("keydown", event => {
      if (
        event.isTrusted &&
        event.key?.toLowerCase() == "v" &&
        (AppConstants.platform == "macosx" ? event.metaKey : event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey
      ) {
        // wave9/secfix (security-full-1 L7): and in which page: only a
        // Cmd+V into a tab's page counts, for that tab alone (not the
        // address bar, nor another tab or pane).
        // The page the key went to, by its top browsing context's id: a
        // remote page's keys arrive at its <browser>; an in-process page's
        // at an element of its own document. None for the address bar or
        // other chrome.
        const target = event.composedTarget ?? event.target;
        let top = null;
        if (target?.localName == "browser" && target.namespaceURI == XUL_NS) {
          top = target.browsingContext?.top ?? null;
        } else {
          const bc = target?.ownerDocument?.defaultView?.browsingContext;
          top = bc?.isContent ? bc.top : null;
        }
        pasteKeys.set(win, { time: Date.now(), topId: top?.id ?? null });
      }
    }, { capture: true, mozSystemGroup: true });
  }

  static pastedJustNow(win, top) {
    const last = win ? pasteKeys.get(win) : null;
    return last?.topId != null && last.topId == top?.id && Date.now() - last.time < PASTE_GESTURE_MS;
  }

  // W13-R2: the clipboard's file or image as a File, for a click on a
  // paste badge or the Paste Image to Upload command (gestures in the
  // parent itself), or null.
  // W29: with `win`, the photo-details sheet may ask first (at `rect`, a
  // screen rect in device pixels); false when it was cancelled.
  static async readClipboardFile({ win = null, rect = null } = {}) {
    const clip = await WhimsyUploadParent.clipboardUpload();
    if (!clip) {
      return null;
    }
    const ask = win ? data => WhimsyUploadParent.askDetails(win, { ...data, rect }) : null;
    const result = await withFile({ path: clip.path }, ask);
    return result?.cancelled ? false : (result?.file ?? null);
  }

  /**
   * W29: "Remove photo details?", the sheet that asks before an upload.
   * `kinds` counts the photos carrying each kind of detail; `rect` is where
   * it opens (a screen rect in device pixels, or null). Resolves to the
   * kinds to remove ({ location, camera, date, other }) for this upload
   * only, or null when it's cancelled (Cancel, Esc, or a click outside).
   */
  static askDetails(win, { count, kinds, rect = null }) {
    const { WhimsySurface, WhimsyFireButton, WhimsyImageMetadata } = lazy;
    const doc = win.document;
    const settings = WhimsyImageMetadata.categories;
    // A newer sheet replaces one still open (create() removes it, with no
    // popuphidden): that upload is cancelled.
    sheets.get(win)?.();
    return new Promise(resolve => {
      let settled = false;
      const settle = value => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
        if (sheets.get(win) == cancel) {
          sheets.delete(win);
        }
      };
      const cancel = () => settle(null);
      sheets.set(win, cancel);
      const rows = [];
      const choice = () => Object.fromEntries(rows.map(r => [r.cat, r.input.checked && !r.input.disabled]));
      const upload = () => {
        settle(choice());
        WhimsySurface.close(parts.panel);
      };
      const parts = WhimsySurface.create(win, {
        id: "whimsy-photo-details",
        className: "whimsy-photo-details",
        width: 300,
        titleL10nId: "whimsy-photo-details-title",
        footer: true,
        initialFocus: () => rows.find(r => !r.input.disabled)?.input ?? null,
        onHidden: () => settle(null),
      });
      const summary = doc.createElementNS("http://www.w3.org/1999/xhtml", "p");
      summary.className = "whimsy-photo-details-text";
      doc.l10n.setAttributes(summary, "whimsy-photo-details-summary", { count });
      parts.view.append(summary);

      const group = WhimsySurface.group(doc);
      group.classList.add("whimsy-photo-details-rows");
      const button = WhimsySurface.footerButton(doc, {
        l10nId: "whimsy-photo-details-upload",
        primary: true,
        id: "whimsy-photo-details-upload",
        onCommand: upload,
      });
      const relabel = () => {
        const any = rows.some(r => r.input.checked && !r.input.disabled);
        doc.l10n.setAttributes(button, any ? "whimsy-photo-details-upload" : "whimsy-photo-details-upload-as-is");
      };
      for (const cat of WhimsyImageMetadata.CATEGORIES) {
        const n = kinds?.[cat] ?? 0;
        const { row, input } = WhimsyFireButton.checkRow(doc, `whimsy-photo-details-row-${cat}`, n > 0 && !!settings[cat], relabel);
        row.classList.add("whimsy-photo-details-row");
        row.dataset.kind = cat;
        input.id = `whimsy-photo-details-${cat}`;
        const note = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
        note.className = "whimsy-photo-details-count";
        note.id = `whimsy-photo-details-${cat}-count`;
        if (n > 0) {
          doc.l10n.setAttributes(note, "whimsy-photo-details-count", { count: n });
        } else {
          // A kind no chosen photo has keeps its place, greyed out.
          doc.l10n.setAttributes(note, "whimsy-photo-details-none");
          input.disabled = true;
          row.setAttribute("disabled", "true");
        }
        input.setAttribute("aria-describedby", note.id);
        row.append(note);
        group.append(row);
        rows.push({ cat, input });
      }
      // Up and Down move between the rows that can change; Return uploads.
      group.addEventListener("keydown", event => {
        const target = event.target;
        if (target?.localName != "input" || event.ctrlKey || event.altKey || event.metaKey) {
          return;
        }
        if (event.key == "Enter") {
          event.preventDefault();
          event.stopPropagation();
          upload();
          return;
        }
        if (event.key != "ArrowDown" && event.key != "ArrowUp") {
          return;
        }
        const enabled = rows.map(r => r.input).filter(i => !i.disabled);
        const at = enabled.indexOf(target);
        const next = enabled[Math.max(0, Math.min(enabled.length - 1, at + (event.key == "ArrowDown" ? 1 : -1)))];
        event.preventDefault();
        next?.focus();
      });
      parts.view.append(group);
      parts.footer.append(
        WhimsySurface.footerButton(doc, {
          l10nId: "whimsy-photo-details-cancel",
          id: "whimsy-photo-details-cancel",
          onCommand: () => WhimsySurface.close(parts.panel),
        }),
        button
      );
      relabel();
      WhimsySurface.finish(parts);
      const screenRect = chromeRect(win, rect);
      WhimsySurface.open(win, parts.panel, screenRect ? { screenRect, gap: 4 } : {});
    });
  }

  // The tab's <browser>, for messages about the indicator: only from the
  // top-level page now showing in it.
  get indicatorBrowser() {
    const bc = this.browsingContext;
    if (!bc || bc != bc.top || !this.manager?.isCurrentGlobal) {
      return null;
    }
    return bc.embedderElement ?? null;
  }

  async receiveMessage(message) {
    // W13-R2: the paste badges (WhimsyUploadBadges draws them).
    switch (message.name) {
      case "WhimsyUpload:Hello":
        return lazy.WhimsyUploadBadges.stateFor(this.indicatorBrowser);
      case "WhimsyUpload:Targets":
      case "WhimsyUpload:Hot":
      case "WhimsyUpload:Status":
      case "WhimsyUpload:FocusBadge":
      case "WhimsyUpload:Near": {
        const browser = this.indicatorBrowser;
        if (browser) {
          lazy.WhimsyUploadBadges.fromChild(browser, message.name, message.data ?? {});
        }
        return null;
      }
    }
    // Cmd+V on a focused upload button: the clipboard's file or image, no popup.
    if (message.name == "WhimsyUpload:Paste") {
      if (!WhimsyUploadParent.pastedJustNow(this.browsingContext.topChromeWindow, this.browsingContext.top)) {
        return null;
      }
      const clip = await WhimsyUploadParent.clipboardUpload();
      if (!clip) {
        return null;
      }
      // W29: a photo with details to ask about waits for the sheet, which
      // the child asks for once the page has had its paste.
      const metadata = lazy.WhimsyImageMetadata;
      if (metadata.enabled && metadata.ask) {
        let file = null;
        try {
          file = await File.createFromFileName(clip.path);
        } catch (e) {
          console.error("Whimsy: reading the file to upload failed", e);
          return null;
        }
        if (metadata.candidate(file)) {
          const scan = await metadata.inspectFiles([file]);
          if (scan.count) {
            const token = String(nextPasteToken++);
            pastes.clear();
            pastes.set(token, { scan, top: this.browsingContext.top?.id });
            return { token };
          }
        }
        return { path: clip.path, file };
      }
      return withFile({ path: clip.path });
    }
    if (message.name == "WhimsyUpload:AskPaste") {
      const entry = pastes.get(message.data?.token);
      pastes.delete(message.data?.token);
      if (!entry || entry.top != this.browsingContext.top?.id) {
        return null;
      }
      const win = this.browsingContext.topChromeWindow;
      const { scan } = entry;
      const cats = await WhimsyUploadParent.askDetails(win, { count: scan.count, kinds: scan.kinds, rect: message.data.rect });
      if (!cats) {
        return null;
      }
      return { file: lazy.WhimsyImageMetadata.CATEGORIES.some(c => cats[c]) ? lazy.WhimsyImageMetadata.stripEntries(scan.entries, cats)[0] : scan.entries[0].file };
    }
    if (message.name == "WhimsyUpload:AskDetails") {
      const win = this.browsingContext.topChromeWindow;
      if (!win) {
        return null;
      }
      return WhimsyUploadParent.askDetails(win, message.data ?? {});
    }
    if (message.name != "WhimsyUpload:Pick") {
      return null;
    }
    const win = this.browsingContext.topChromeWindow;
    const attrs = this.browsingContext.top?.originAttributes ?? {};
    const [clip, downloads] = await Promise.all([
      WhimsyUploadParent.clipboardUpload(),
      WhimsyUploadParent.recentDownloads({
        isPrivate: (attrs.privateBrowsingId || 0) > 0,
        userContextId: attrs.userContextId || 0,
      }),
    ]);
    const picked = await this.showPopup(win, message.data, { clip, downloads });
    // W29: the sheet asks where the popup was.
    const scale = win.devicePixelRatio || 1;
    const rect = { left: message.data.screenX * scale, top: message.data.screenY * scale, width: 0, height: 0 };
    const result = await withFile(picked, data => WhimsyUploadParent.askDetails(win, { ...data, rect }));
    return result?.cancelled ? null : result;
  }

  showPopup(win, { screenX, screenY }, { clip, downloads }) {
    return new Promise(resolve => {
      const { document } = win;
      document.getElementById("whimsy-upload-panel")?.remove();
      const panel = document.createXULElement("panel");
      panel.id = "whimsy-upload-panel";
      panel.className = "whimsy-upload-panel";
      panel.setAttribute("noautohide", "false");
      panel.setAttribute("type", "arrow");

      let settled = false;
      const finish = value => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
        panel.hidePopup();
      };

      const addRow = (l10nId, onPick, args) => {
        const row = document.createXULElement("toolbarbutton");
        row.className = "subviewbutton";
        document.l10n.setAttributes(row, l10nId, args);
        row.addEventListener("command", () => finish(onPick()));
        panel.appendChild(row);
        return row;
      };
      if (clip) {
        const row = clip.isFile
          ? addRow("whimsy-upload-clipboard-file", () => ({ path: clip.path }), { name: PathUtils.filename(clip.path) })
          : addRow("whimsy-upload-clipboard", () => ({ path: clip.path }));
        row.classList.add("whimsy-upload-clipboard-row");
      }
      for (const download of downloads) {
        const row = document.createXULElement("toolbarbutton");
        row.className = "subviewbutton";
        row.setAttribute("label", download.name);
        row.addEventListener("command", () => finish({ path: download.path }));
        panel.appendChild(row);
      }
      addRow("whimsy-upload-choose-file", () => ({ useNativePicker: true }));

      panel.addEventListener("keydown", e => {
        if (e.key == "Escape") {
          finish(null);
        } else if (isPasteKey(e) && clip) {
          // Cmd+V in the popup takes the clipboard row.
          e.preventDefault();
          finish({ path: clip.path });
        }
      });
      panel.addEventListener("popuphidden", () => {
        finish(null);
        panel.remove();
      });
      document.documentElement.appendChild(panel);
      panel.openPopupAtScreen(screenX, screenY, false);
    });
  }
}
