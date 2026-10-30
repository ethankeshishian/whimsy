/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Three small download conveniences (Arc/Chrome/Safari parity), each with
// its own whimsy.feature.* switch:
//
// - Dock badge + bounce (whimsy.downloads.dock-badge, macOS only): Zen's Dock
//   progress bar already works (DownloadsTaskbar, nsMacDockSupport); this
//   adds the missing count badge and one Dock bounce when a download
//   finishes while Whimsy is in the background. People leave the window and
//   glance at the Dock, like Chrome and Safari.
// - Quick Look (Space on a finished download; "Quick Look" in its context
//   menu): Arc's downloads popover opens the native macOS preview panel so
//   you can check a PDF or image without leaving the browser. Gecko has no
//   Quick Look API, so this shells out to /usr/bin/qlmanage (a non-native
//   window, but no engine patch).
// - Keep the panel open while dragging a download onto a site (Arc, Safari):
//   downloads already drag out as application/x-moz-file; what's missing is
//   that any open popup/panel auto-hides the moment the drag starts. This
//   suspends auto-hide on the panel that owns the drag, for the drag's
//   duration, so dropping into Gmail/Slack/Drive doesn't need two trips.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
});

const QUICKLOOK_PREF = "whimsy.feature.quick-look";
const DOCK_BADGE_PREF = "whimsy.downloads.dock-badge";
const DOCK_FEATURE_PREF = "whimsy.feature.dock-badge";
const DRAG_FEATURE_PREF = "whimsy.feature.drag-downloads";

function dockSupport() {
  if (AppConstants.platform != "macosx") {
    return null;
  }
  try {
    return Cc["@mozilla.org/widget/macdocksupport;1"].getService(Ci.nsIMacDockSupport);
  } catch (e) {
    return null;
  }
}

export const WhimsyDownloads = {
  // ---- Dock badge + bounce (once per session) ----

  async init() {
    if (this._inited || AppConstants.platform != "macosx") {
      return;
    }
    this._inited = true;
    const dock = dockSupport();
    if (!dock) {
      return;
    }
    this._inProgress = new Set();
    const list = await lazy.Downloads.getList(lazy.Downloads.ALL);
    const anyWindowFocused = () =>
      [...Services.wm.getEnumerator("navigator:browser")].some(w => w.document.hasFocus());
    const refreshBadge = () => {
      if (!Services.prefs.getBoolPref(DOCK_FEATURE_PREF, true) || !Services.prefs.getBoolPref(DOCK_BADGE_PREF, true)) {
        dock.badgeText = "";
        return;
      }
      dock.badgeText = this._inProgress.size ? String(this._inProgress.size) : "";
    };
    list.addView({
      onDownloadAdded: download => {
        if (!download.stopped) {
          this._inProgress.add(download);
        }
        refreshBadge();
      },
      onDownloadChanged: download => {
        if (download.stopped) {
          const wasInProgress = this._inProgress.delete(download);
          if (wasInProgress && download.succeeded && !anyWindowFocused()) {
            this.bounce();
          }
        } else {
          this._inProgress.add(download);
        }
        refreshBadge();
      },
      onDownloadRemoved: download => {
        this._inProgress.delete(download);
        refreshBadge();
      },
    });
    Services.prefs.addObserver(DOCK_BADGE_PREF, refreshBadge);
    Services.prefs.addObserver(DOCK_FEATURE_PREF, refreshBadge);
  },

  bounce() {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    // getAttention bounces the Dock icon once without stealing focus
    // (activateApplication would).
    win?.getAttention();
  },

  // ---- Quick Look (Firefox's downloads panel) ----

  get quickLookEnabled() {
    return Services.prefs.getBoolPref(QUICKLOOK_PREF, true);
  },

  // Space again closes the preview, as in Finder and Arc: a second call
  // for the same file only closes the one that's open.
  async showQuickLook(path) {
    const open = this._quickLook;
    if (open) {
      this._quickLook = null;
      open.process.kill();
      if (open.path == path) {
        return;
      }
    }
    try {
      const process = await lazy.Subprocess.call({ command: "/usr/bin/qlmanage", arguments: ["-p", path] });
      process.stdin.close();
      const entry = { path, process };
      this._quickLook = entry;
      process.wait().then(() => {
        if (this._quickLook == entry) {
          this._quickLook = null;
        }
      });
    } catch (e) {
      console.error("Whimsy: Quick Look failed", e);
    }
  },

  initWindow(win) {
    this.initQuickLook(win);
    this.initLibraryQuickLook(win);
    this.initDragKeepOpen(win);
  },

  initQuickLook(win) {
    if (AppConstants.platform != "macosx") {
      return;
    }
    const richListBox = win.document.getElementById("downloadsListBox");
    const menu = win.document.getElementById("downloadsContextMenu");
    if (!richListBox) {
      return;
    }
    const pathFor = item => item && win.DownloadsView?.itemForElement(item)?.download?.target?.path;
    const openQuickLook = path => {
      IOUtils.exists(path).then(exists => {
        if (exists) {
          this.showQuickLook(path);
        } else {
          win.gZenUIManager?.showToast?.("whimsy-quicklook-missing-toast", {});
        }
      });
    };
    richListBox.addEventListener(
      "keypress",
      event => {
        if (event.key != " " || !this.quickLookEnabled) {
          return;
        }
        const path = pathFor(richListBox.selectedItem);
        if (path) {
          event.preventDefault();
          openQuickLook(path);
        }
      },
      false
    );
    menu?.addEventListener("popupshowing", () => {
      if (!this.quickLookEnabled) {
        menu.querySelector("#whimsyQuickLookMenuItem")?.remove();
        return;
      }
      if (menu.querySelector("#whimsyQuickLookMenuItem")) {
        return;
      }
      const item = win.document.createXULElement("menuitem");
      item.id = "whimsyQuickLookMenuItem";
      win.document.l10n.setAttributes(item, "whimsy-quicklook-menuitem");
      item.addEventListener("command", () => {
        const path = pathFor(menu.triggerNode?.closest("richlistitem"));
        if (path) {
          openQuickLook(path);
        }
      });
      menu.appendChild(item);
    });
  },

  // ---- Quick Look in Zen's Library (Downloads section) ----
  // Zen's Library draws its own rows (Lit), not Firefox's DownloadsView.
  // A one-line overlay.py hook gives each row its Download as
  // `whimsyDownload`, so a filtered list or two files with the same name
  // never preview the wrong one. Space previews the focused row, or else
  // the row under the pointer (the Library has no row selection); the row
  // menu gets "Quick Look" too, as in Arc's Library.

  initLibraryQuickLook(win) {
    if (AppConstants.platform != "macosx" || win._whimsyLibraryQuickLook) {
      return;
    }
    win._whimsyLibraryQuickLook = true;
    const doc = win.document;
    const ROW = "[data-section='downloads'] .zen-library-row";
    doc.addEventListener(
      "keydown",
      event => {
        if (
          event.key != " " ||
          event.repeat ||
          event.altKey ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          !this.quickLookEnabled ||
          event.target.closest?.("input, textarea, select, [contenteditable]") ||
          event.target.localName == "browser"
        ) {
          return;
        }
        const row = event.target.closest?.(ROW) ?? doc.querySelector(`${ROW}:hover`);
        if (!this.canQuickLook(row?.whimsyDownload)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.previewLibraryDownload(win, row.whimsyDownload);
      },
      true
    );
    doc.addEventListener("popupshowing", event => {
      const menu = event.target;
      if (!menu.classList?.contains("zen-library-downloads-menu")) {
        return;
      }
      let item = menu.querySelector(".whimsy-library-quicklook");
      const download = doc.querySelector(`${ROW}[menu-open]`)?.whimsyDownload;
      if (!this.quickLookEnabled) {
        item?.remove();
        menu.querySelector(".whimsy-library-quicklook-separator")?.remove();
        return;
      }
      if (!item) {
        const separator = doc.createXULElement("menuseparator");
        separator.className = "whimsy-library-quicklook-separator";
        item = doc.createXULElement("menuitem");
        item.className = "whimsy-library-quicklook";
        doc.l10n.setAttributes(item, "whimsy-quicklook-menuitem");
        item.addEventListener("command", () => this.previewLibraryDownload(win, item._whimsyDownload));
        menu.prepend(item, separator);
      }
      item._whimsyDownload = download;
      item.disabled = !this.canQuickLook(download);
    });
  },

  canQuickLook(download) {
    return !!(download?.succeeded && !download.deleted && download.target?.path);
  },

  // Returns true when the preview opened (or closed, on a second Space).
  async previewLibraryDownload(win, download) {
    if (!this.quickLookEnabled || !this.canQuickLook(download)) {
      return false;
    }
    const { path } = download.target;
    if (!(await IOUtils.exists(path))) {
      win.gZenUIManager?.showToast?.("whimsy-quicklook-missing-toast", {});
      return false;
    }
    await this.showQuickLook(path);
    return true;
  },

  // ---- Keep a panel open across a download drag ----

  get dragKeepOpenEnabled() {
    return Services.prefs.getBoolPref(DRAG_FEATURE_PREF, true);
  },

  initDragKeepOpen(win) {
    const { document } = win;
    document.addEventListener(
      "dragstart",
      event => {
        if (!this.dragKeepOpenEnabled || !event.target.closest?.("[draggable='true']")) {
          return;
        }
        const panel = event.target.closest("panel, menupopup");
        if (panel && !panel.hasAttribute("noautohide")) {
          panel.setAttribute("whimsy-drag-noautohide", "");
          panel.setAttribute("noautohide", "true");
        }
      },
      true
    );
    const release = () => {
      for (const panel of document.querySelectorAll("[whimsy-drag-noautohide]")) {
        panel.removeAttribute("noautohide");
        panel.removeAttribute("whimsy-drag-noautohide");
      }
    };
    document.addEventListener("dragend", release, true);
    document.addEventListener("drop", release, true);
  },
};
