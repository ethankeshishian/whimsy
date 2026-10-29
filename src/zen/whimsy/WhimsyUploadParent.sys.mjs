/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Upload from the clipboard: the parent half. Shows a small popup anchored
// near the click with the clipboard image (if there is one), the five
// newest downloads, and "Choose file...". Loved for screenshots: capture
// one (Cmd+Ctrl+Shift+4 on macOS), click any upload button, click the
// thumbnail.

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
  async receiveMessage(message) {
    if (message.name != "WhimsyUpload:Pick") {
      return null;
    }
    const win = this.browsingContext.topChromeWindow;
    const [clipboardPath, downloads] = await Promise.all([clipboardImagePath(), recentDownloads()]);
    return this.showPopup(win, message.data, { clipboardPath, downloads });
  }

  showPopup(win, { screenX, screenY }, { clipboardPath, downloads }) {
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

      const addRow = (l10nId, onPick) => {
        const row = document.createXULElement("toolbarbutton");
        row.className = "subviewbutton";
        document.l10n.setAttributes(row, l10nId);
        row.addEventListener("command", () => finish(onPick()));
        panel.appendChild(row);
      };
      if (clipboardPath) {
        addRow("whimsy-upload-clipboard", () => ({ path: clipboardPath }));
      }
      for (const download of downloads) {
        const row = document.createXULElement("toolbarbutton");
        row.className = "subviewbutton";
        row.setAttribute("label", download.name);
        row.addEventListener("command", () => finish({ path: download.path }));
        panel.appendChild(row);
      }
      addRow("whimsy-upload-choose-file", () => ({ useNativePicker: true }));

      panel.addEventListener("keydown", e => e.key == "Escape" && finish(null));
      panel.addEventListener("popuphidden", () => {
        finish(null);
        panel.remove();
      });
      document.documentElement.appendChild(panel);
      panel.openPopupAtScreen(screenX, screenY, false);
    });
  }
}
