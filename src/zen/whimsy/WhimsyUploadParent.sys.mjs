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
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
});

async function clipboardImagePath() {
  if (!Services.clipboard.hasDataMatchingFlavors(["image/png"], Ci.nsIClipboard.kGlobalClipboard)) {
    return null;
  }
  try {
    const transferable = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
    transferable.init(null);
    transferable.addDataFlavor("image/png");
    Services.clipboard.getData(transferable, Ci.nsIClipboard.kGlobalClipboard);
    const data = {};
    transferable.getTransferData("image/png", data);
    const container = data.value.QueryInterface(Ci.imgIContainer);
    const imgTools = Cc["@mozilla.org/image/tools;1"].getService(Ci.imgITools);
    const stream = imgTools.encodeImage(container, "image/png");
    const available = stream.available();
    const binary = NetUtil.readInputStreamToString(stream, available);
    const bytes = new Uint8Array(available);
    for (let i = 0; i < available; i++) {
      bytes[i] = binary.charCodeAt(i) & 0xff;
    }
    const file = lazy.FileUtils.getFile("TmpD", ["whimsy-clipboard-upload.png"]);
    await IOUtils.write(file.path, bytes);
    return file.path;
  } catch (e) {
    console.error("Whimsy: reading the clipboard image failed", e);
    return null;
  }
}

// A file copied in Finder (Cmd+C): the clipboard holds its path. Finder also
// puts the file's icon there as an image, so a copied file wins over
// clipboardImagePath (otherwise pasting a copied PDF uploads its icon).
function clipboardFilePath() {
  const flavor = "application/x-moz-file";
  if (!Services.clipboard.hasDataMatchingFlavors([flavor], Ci.nsIClipboard.kGlobalClipboard)) {
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

async function recentDownloads() {
  try {
    const list = await lazy.Downloads.getList(lazy.Downloads.PUBLIC);
    const all = await list.getAll();
    return all
      .filter(d => d.succeeded && d.target?.path)
      .sort((a, b) => (b.startTime || 0) - (a.startTime || 0))
      .slice(0, 5)
      .map(d => ({ path: d.target.path, name: PathUtils.filename(d.target.path) }));
  } catch (e) {
    return [];
  }
}

export class WhimsyUploadParent extends JSWindowActorParent {
  // Overridable for tests.
  static clipboardUpload = clipboardUpload;

  async receiveMessage(message) {
    // Cmd+V on a focused upload button: the clipboard's file or image, no popup.
    if (message.name == "WhimsyUpload:Paste") {
      const clip = await WhimsyUploadParent.clipboardUpload();
      return clip ? { path: clip.path } : null;
    }
    if (message.name != "WhimsyUpload:Pick") {
      return null;
    }
    const win = this.browsingContext.topChromeWindow;
    const [clip, downloads] = await Promise.all([WhimsyUploadParent.clipboardUpload(), recentDownloads()]);
    return this.showPopup(win, message.data, { clip, downloads });
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
