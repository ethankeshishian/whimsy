/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W15 screenshots: one viewer, one save. Firefox Screenshots keeps its
// name, its capture step and its preview dialog; what changes is the rest:
//
//   After a drag, the page's toolbar is one Capture button
//   (WhimsyCaptureChild; Enter captures, Esc closes Screenshots, Cmd+C
//   and Cmd+S stay quick copy and download). Capture, Visible, Full Page and Portrait all open
//   Firefox's preview, the viewer, with
//     Retry · Add to Easel · Copy · Download · Edit · Save and Close · ✕
//   Copy and Download keep it open; only Save and Close (which writes the
//   one Library file and shows the Library's Screenshots) and ✕ close it.
//
//   Edit opens the editor on the viewer's image (W13 F04, Yab's Edit):
//   Backdrop, Shape (Auto, 16:9, 1:1, 4:5), "Hide private details" and
//   "Redact by hand" (drag boxes; a click on a box takes it away). Copy and
//   Download keep it open, ✕ leaves without the edits, Done goes back to
//   the viewer with them, Save and Close saves once and closes both. A
//   Library screenshot's Edit opens it with Save (that file) and Save Copy.
//
// "Hide private details" is the existing redact machinery (WhimsyRedact),
// on by default (whimsy.capture.redact): it hides them on the page while
// you frame the shot, so the image already has them hidden. Turning it
// off or on in the editor captures the same region again.
//
// Screenshots' files stay untouched: ScreenshotsUtils.createCanvas (every
// capture draws there), showPanelAndOverlay and openPreviewDialog are
// wrapped, each calling through, and the dialog is decorated once it's
// ready. Nothing is sent anywhere; a private page's viewer has no Save.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  saveCapture: "resource:///modules/whimsy/WhimsyFilesSection.sys.mjs",
  writeCapture: "resource:///modules/whimsy/WhimsyFilesSection.sys.mjs",
  overwriteCapture: "resource:///modules/whimsy/WhimsyFilesSection.sys.mjs",
  listCaptures: "resource:///modules/whimsy/WhimsyFilesSection.sys.mjs",
  isPrivateCapture: "resource:///modules/whimsy/WhimsyFilesSection.sys.mjs",
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  ScreenshotsUtils: "moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs",
  WhimsyArcMenus: "resource:///modules/whimsy/WhimsyArcMenus.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyEasel: "resource:///modules/whimsy/WhimsyEasel.sys.mjs",
  WhimsyRedact: "resource:///modules/whimsy/WhimsyRedactParent.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "getFilename", () =>
  ChromeUtils.importESModule("chrome://browser/content/screenshots/fileHelpers.mjs").getFilename);

const FEATURE_PREF = "whimsy.feature.capture-card";
const REDACT_PREF = "whimsy.capture.redact";
const STYLE_PREF = "whimsy.capture.redact-style";
const BACKDROP_PREF = "whimsy.capture.backdrop";
const SHAPE_PREF = "whimsy.capture.shape";
const LAST_METHOD_PREF = "screenshots.browser.component.last-saved-method";
const HTML_NS = "http://www.w3.org/1999/xhtml";
const VIEWER_SHEET = "chrome://browser/content/whimsy/whimsy-capture-viewer.css";
const FLASH_MS = 1500;

const EDITOR_ID = "whimsy-capture-editor";

export const BACKDROPS = ["gradient", "white", "dark", "none"];
export const SHAPES = { auto: null, "16:9": 16 / 9, "1:1": 1, "4:5": 4 / 5 };
const ICON = name => `chrome://browser/skin/zen-icons/${name}.svg`;

/**
 * Where the image goes on its backdrop: the canvas size and the image's
 * place, for a shape and a backdrop. Pure, for tests.
 *
 * @returns {{width: number, height: number, x: number, y: number, radius: number}}
 */
export function layoutFor(w, h, { backdrop = "none", shape = "auto" } = {}) {
  const pad = backdrop == "none" ? 0 : Math.round(Math.max(w, h) * 0.06);
  let width = w + 2 * pad;
  let height = h + 2 * pad;
  const ratio = SHAPES[shape] ?? null;
  if (ratio) {
    if (width / height < ratio) {
      width = Math.round(height * ratio);
    } else {
      height = Math.round(width / ratio);
    }
  }
  return {
    width,
    height,
    x: Math.round((width - w) / 2),
    y: Math.round((height - h) / 2),
    radius: backdrop == "none" ? 0 : Math.round(Math.min(w, h) * 0.02) + 6,
  };
}

let actorRegistered = false;

export const WhimsyCaptureCard = {
  _installed: false,
  // Set while the editor captures the page again, so that capture isn't
  // taken for a new one.
  _recapturing: false,
  // browser -> what its next viewer shows came from (region, what was hidden).
  _pending: new WeakMap(),
  // browser -> its open viewer's capture.
  _viewers: new WeakMap(),
  // The capture the editor is open on.
  _editing: null,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  initWindow(win) {
    this.install();
    const { WhimsyCommands } = lazy;
    const editable = w => this.enabled && (!!this.viewerOf(w) || lazy.listCaptures().length > 0);
    WhimsyCommands.register(win, {
      id: "cmd_whimsyCaptureEdit",
      l10nId: "whimsy-action-capture-edit",
      run: w => editable(w) && this.editLatest(w, { tool: null }),
      icon: ICON("sliders"),
      isAvailable: editable,
    });
    WhimsyCommands.register(win, {
      id: "cmd_whimsyCaptureRedactLast",
      l10nId: "whimsy-action-capture-redact-last",
      run: w => editable(w) && this.editLatest(w, { tool: "hand" }),
      icon: "chrome://browser/content/whimsy/icons/redact.svg",
      isAvailable: editable,
    });
    // W16-15: the user removed Capture Selected Area, Save Screenshot and
    // Close and Add Screenshot to Easel as commands. With a box drawn,
    // Enter captures and Esc closes (WhimsyCaptureChild); the viewer keeps
    // its Save and Close and Add to Easel buttons.
  },

  install() {
    if (this._installed) {
      return;
    }
    this._installed = true;
    this.registerActor();
    const utils = lazy.ScreenshotsUtils;
    const self = this;
    // Every capture draws here: note its region and what was hidden in
    // the page right then (redaction is still on; WhimsyRedact turns it
    // off once the canvas is made).
    const createCanvas = utils.createCanvas;
    utils.createCanvas = async function (region, browser, ...rest) {
      if (!self._recapturing && browser && self.enabled) {
        try {
          const redact = lazy.WhimsyRedact;
          const state = redact._active.has(browser) ? await redact.state(browser) : null;
          self._pending.set(browser, {
            region: { ...region },
            spec: browser.currentURI?.spec ?? "",
            redacted: !!state?.active,
            kinds: state?.active ? state.kinds ?? null : null,
          });
        } catch (e) {
          console.error("Whimsy: capture", e);
        }
      }
      return createCanvas.call(this, region, browser, ...rest);
    };
    // Every time the overlay opens (start, Retry): the one Capture button.
    const showPanelAndOverlay = utils.showPanelAndOverlay;
    utils.showPanelAndOverlay = function (browser, ...rest) {
      const result = showPanelAndOverlay.call(this, browser, ...rest);
      try {
        self.offerConfirm(browser);
      } catch (e) {
        console.error("Whimsy: capture button", e);
      }
      return result;
    };
    // Every viewer (Visible, Full Page, Portrait, Capture).
    const openPreviewDialog = utils.openPreviewDialog;
    utils.openPreviewDialog = async function (browser, ...rest) {
      const dialog = await openPreviewDialog.call(this, browser, ...rest);
      try {
        if (self.enabled && dialog) {
          self.attachViewer(browser, dialog);
        }
      } catch (e) {
        console.error("Whimsy: screenshot viewer", e);
      }
      return dialog;
    };
  },

  registerActor() {
    if (actorRegistered) {
      return;
    }
    actorRegistered = true;
    ChromeUtils.registerWindowActor("WhimsyCapture", {
      parent: { esModuleURI: "resource:///modules/whimsy/WhimsyCaptureParent.sys.mjs" },
      child: { esModuleURI: "resource:///modules/whimsy/WhimsyCaptureChild.sys.mjs" },
      // The child only acts on the parent's messages, while Screenshots'
      // overlay is open in that page; the parent checks what it sends.
      safeForUntrustedWebProcess: true,
    });
  },

  isScreenshotsMode(browser) {
    const state = lazy.ScreenshotsUtils.browserToScreenshotsState?.get(browser);
    return !!state && (!state.mode || state.mode == "screenshots");
  },

  actorFor(browser) {
    try {
      return browser?.browsingContext?.currentWindowGlobal?.getActor("WhimsyCapture") ?? null;
    } catch {
      return null;
    }
  },

  // ---- Step 1: select ----------------------------------------------------

  offerConfirm(browser) {
    if (!this.enabled || !this.isScreenshotsMode(browser)) {
      return;
    }
    this.actorFor(browser)?.sendAsyncMessage("WhimsyCapture:Decorate");
  },

  // From the page (untrusted): only numbers, only a real region.
  cleanRegion(data) {
    const nums = ["left", "top", "right", "bottom"].map(k => data?.[k]);
    if (!nums.every(Number.isFinite)) {
      return null;
    }
    const [left, top, right, bottom] = nums;
    if (right - left < 1 || bottom - top < 1) {
      return null;
    }
    const ratio = Number.isFinite(data.devicePixelRatio) ? Math.min(4, Math.max(0.5, data.devicePixelRatio)) : 1;
    return { left, top, right, bottom, width: right - left, height: bottom - top, devicePixelRatio: ratio };
  },

  /** Capture was pressed: draw the region, then the viewer. */
  async confirmRegion(browser, data) {
    const utils = lazy.ScreenshotsUtils;
    if (!this.enabled || !this.isScreenshotsMode(browser)) {
      return null;
    }
    const region = this.cleanRegion(data);
    if (!region) {
      utils.exit(browser);
      return null;
    }
    utils.closePanel(browser);
    Services.focus.setFocus(browser, 0);
    let blob;
    try {
      const canvas = await utils.createCanvas(region, browser);
      blob = await canvas.convertToBlob();
    } catch (e) {
      console.error("Whimsy: capture", e);
      browser.documentGlobal?.gZenUIManager?.showToast?.("whimsy-capture-failed-toast");
      utils.exit(browser);
      return null;
    }
    return this.openViewer(browser, blob);
  },

  // ---- Step 2: the viewer -------------------------------------------------

  /**
   * Opens Firefox's preview on `blob`, as its Visible and Full Page do.
   * `retake`: false when the image can't be drawn again from the page as
   * it is (Portrait lays the page out at a phone's width).
   */
  async openViewer(browser, blob, { retake = true } = {}) {
    const utils = lazy.ScreenshotsUtils;
    const dialog = await utils.openPreviewDialog(browser);
    const capture = this._viewers.get(browser);
    if (capture?.dialog == dialog) {
      capture.blob = blob;
      if (!retake) {
        capture.region = null;
      }
    }
    await dialog._dialogReady;
    const preview = dialog._frame.contentDocument.querySelector("screenshots-preview");
    const url = URL.createObjectURL(blob);
    utils.setBlobURL(browser, url);
    preview.previewImg.src = url;
    preview.focusButton(Services.prefs.getStringPref(LAST_METHOD_PREF, "download"));
    if (Cu.isInAutomation) {
      Services.obs.notifyObservers(null, "screenshots-preview-ready");
    }
    return dialog;
  },

  viewerOf(win) {
    const capture = this._viewers.get(win?.gBrowser?.selectedBrowser);
    return capture?.dialog ? capture : null;
  },

  attachViewer(browser, dialog) {
    const old = this._viewers.get(browser);
    if (old?.dialog == dialog) {
      return old;
    }
    // W16-19: centred in the page both ways (whimsy-browser.css), set
    // before the dialog first shows.
    dialog._overlay?.setAttribute("whimsy-capture-viewer", "");
    const from = this._pending.get(browser) ?? null;
    this._pending.delete(browser);
    const capture = {
      from: "viewer",
      win: browser.ownerDocument?.defaultView,
      browser,
      dialog,
      preview: null,
      buttons: null,
      // The image as captured, and as the editor's last Done left it.
      blob: null,
      edited: null,
      editedURL: null,
      editState: null,
      region: from?.region ?? null,
      spec: from?.spec ?? "",
      // Whether the captured image has the page's details hidden.
      originalHidden: !!from?.redacted,
      autoKinds: from?.kinds ?? null,
      private: lazy.isPrivateCapture(browser),
      // The images the editor has drawn, by "hidden" (true/false).
      images: new Map(),
    };
    this._viewers.set(browser, capture);
    const closed = lazy.ScreenshotsUtils.browserToScreenshotsState?.get(browser)?.closedPromise;
    closed?.then(() => this.onViewerClosed(capture));
    dialog._dialogReady
      .then(() => this.decorateViewer(capture))
      .catch(e => console.error("Whimsy: screenshot viewer", e));
    return capture;
  },

  onViewerClosed(capture) {
    capture.dialog = null;
    if (this._viewers.get(capture.browser) == capture) {
      this._viewers.delete(capture.browser);
    }
    // Closing the viewer leaves its editor's edits too.
    this.closeEditorOf(capture);
    if (capture.editedURL) {
      URL.revokeObjectURL(capture.editedURL);
      capture.editedURL = null;
    }
  },

  canEasel(capture) {
    return !!capture?.browser && lazy.WhimsyEasel.enabled && lazy.WhimsyEasel.canCapture(capture.browser);
  },

  async decorateViewer(capture) {
    const doc = capture.dialog?._frame?.contentDocument;
    const preview = doc?.querySelector("screenshots-preview");
    if (!preview) {
      return;
    }
    await preview.updateComplete;
    if (!capture.dialog) {
      return;
    }
    capture.preview = preview;
    doc.l10n.addResourceIds(["browser/whimsy.ftl"]);
    const root = preview.renderRoot ?? preview.shadowRoot;
    const sheet = doc.createElement("link");
    sheet.rel = "stylesheet";
    sheet.href = VIEWER_SHEET;
    root.append(sheet);
    const row = root.querySelector(".preview-buttons");
    const get = id => root.getElementById?.(id) ?? root.querySelector(`#${id}`);
    const [copy, download, cancel] = ["copy", "download", "cancel"].map(get);
    const make = (id, l10nId, icon, onClick, { primary = false } = {}) => {
      const button = doc.createElement("moz-button");
      button.id = id;
      button.setAttribute("iconsrc", icon);
      if (primary) {
        button.setAttribute("type", "primary");
      }
      doc.l10n.setAttributes(button, l10nId);
      button.addEventListener("click", onClick);
      return button;
    };
    const easel = make("whimsy-capture-easel", "whimsy-easel-capture-button", ICON("paintbrush"),
      () => this.addToEasel(capture));
    easel.hidden = !this.canEasel(capture);
    const edit = make("whimsy-capture-edit", "whimsy-capture-edit", ICON("sliders"),
      () => this.openEditor(capture.win, { capture }));
    const save = make("whimsy-capture-save-close", "whimsy-capture-viewer-save-close", ICON("save"),
      () => this.saveAndClose(capture), { primary: true });
    // A private page's capture never reaches the disk.
    save.hidden = capture.private;
    if (!capture.private) {
      download.setAttribute("type", "default");
    }
    copy.before(easel);
    download.after(edit, save);
    row.append(cancel);
    capture.buttons = { copy, download, easel, edit, save, cancel };
    // Copy and Download keep the viewer open (Firefox's close it).
    preview.saveToClipboard = () => this.viewerCopy(capture);
    preview.saveToFile = () => this.viewerDownload(capture);
    if (Cu.isInAutomation) {
      Services.obs.notifyObservers(null, "whimsy-capture-viewer-ready");
    }
  },

  /** What the viewer shows: the edited image, else the capture. */
  async currentBlob(capture) {
    if (capture.edited) {
      return capture.edited;
    }
    if (!capture.blob && capture.preview) {
      const src = await capture.preview.imageLoadedPromise();
      capture.blob = await (await fetch(src)).blob();
    }
    return capture.blob;
  },

  async viewerCopy(capture) {
    const blob = await this.currentBlob(capture);
    if (!blob) {
      return false;
    }
    try {
      // Firefox's copy: the clipboard, its "Copied" hint, its last method.
      await lazy.ScreenshotsUtils.copyScreenshot(blob, capture.browser, "PreviewCopy");
    } catch (e) {
      // Its telemetry, after the clipboard.
      console.warn("Whimsy: screenshot copy", e);
    }
    this.flash(capture.buttons?.copy, "whimsy-capture-copied");
    return true;
  },

  async viewerDownload(capture) {
    const blob = await this.currentBlob(capture);
    if (!blob) {
      return false;
    }
    const { preview } = capture;
    preview?.disableButtons();
    const url = URL.createObjectURL(blob);
    let saved = false;
    try {
      saved = await lazy.ScreenshotsUtils.downloadScreenshot(null, url, capture.browser, "PreviewDownload");
    } catch (e) {
      console.error("Whimsy: screenshot download", e);
    } finally {
      preview?.enableButtons();
      capture.win?.setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    if (saved) {
      this.flash(capture.buttons?.download, "whimsy-capture-downloaded");
    }
    return saved;
  },

  // The button says it worked, briefly, then goes back to its own label.
  flash(button, l10nId) {
    const doc = button?.ownerDocument;
    if (!button?.isConnected || !doc?.l10n) {
      return;
    }
    button._whimsyLabel ??= doc.l10n.getAttributes(button);
    doc.l10n.setAttributes(button, l10nId);
    button.setAttribute("whimsy-done", "true");
    doc.defaultView.clearTimeout(button._whimsyFlash);
    button._whimsyFlash = doc.defaultView.setTimeout(() => {
      const { id, args } = button._whimsyLabel;
      button._whimsyLabel = null;
      button.removeAttribute("whimsy-done");
      doc.l10n.setAttributes(button, id, args);
    }, FLASH_MS);
  },

  async addToEasel(capture) {
    if (!this.canEasel(capture)) {
      return null;
    }
    const blob = await this.currentBlob(capture);
    return lazy.WhimsyEasel.addImage(capture.browser, blob, {
      region: capture.edited ? null : capture.region,
      anchor: this.anchorOf(capture, capture.buttons?.easel),
    });
  },

  // Under a viewer button, in the page's coordinates (where the easel
  // picker hangs).
  anchorOf(capture, button) {
    const frame = capture.dialog?._frame;
    if (!frame || !button?.isConnected) {
      return null;
    }
    const f = frame.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    const page = capture.browser.getBoundingClientRect();
    return { x: Math.round(f.left + b.left - page.left), y: Math.round(f.top + b.bottom - page.top + 4) };
  },

  /**
   * The one save: the viewer's image (edited, if it was) into the
   * Library's Screenshots, then the viewer closes and the Library shows
   * them. Resolves to the file's path.
   */
  async saveAndClose(capture) {
    if (!capture || capture.private || capture.saving) {
      return null;
    }
    capture.saving = true;
    try {
      const blob = await this.currentBlob(capture);
      const path = blob ? await lazy.saveCapture(blob, capture.browser) : null;
      if (!path) {
        return null;
      }
      this.closeEditorOf(capture);
      capture.dialog?.close();
      lazy.WhimsyArcMenus.openLibrarySection(capture.win, "whimsy-files", { keepOpen: true });
      return path;
    } finally {
      capture.saving = false;
    }
  },

  closeEditorOf(capture) {
    const editor = capture.win?.document.getElementById(EDITOR_ID);
    if (editor?._capture == capture) {
      lazy.WhimsySurface.close(editor);
    }
  },

  // W16-16: one overlay at a time. The viewer (Firefox's tab-modal
  // preview) hides while the editor is open on its capture, and comes back
  // when the editor closes (Done with the edit, ✕ or Esc as it was).
  hideViewer(capture, hide) {
    if (capture?.from != "viewer") {
      return;
    }
    const overlay = capture.dialog?._overlay;
    if (!overlay?.isConnected) {
      return;
    }
    overlay.toggleAttribute("whimsy-capture-editing", hide);
    overlay.inert = hide;
    if (!hide) {
      capture.buttons?.edit?.focus?.();
    }
  },

  // ---- The editor -------------------------------------------------------

  // The Edit commands: the viewer's image, else the newest Library file.
  async editLatest(win, { tool = null } = {}) {
    const viewer = this.viewerOf(win);
    if (viewer) {
      return this.openEditor(win, { capture: viewer, tool });
    }
    const [newest] = lazy.listCaptures();
    return newest ? this.openLibraryEditor(win, newest.path, { tool }) : null;
  },

  /** A Library screenshot in the editor: Save overwrites it, Save Copy adds one. */
  async openLibraryEditor(win, path, { tool = null } = {}) {
    let blob;
    try {
      blob = new win.Blob([await IOUtils.read(path)], { type: "image/png" });
    } catch (e) {
      console.error("Whimsy: edit screenshot", e);
      return null;
    }
    return this.openEditor(win, {
      tool,
      capture: {
        from: "library",
        win,
        path,
        browser: null,
        blob,
        region: null,
        originalHidden: false,
        autoKinds: null,
        private: false,
        images: new Map(),
        editState: null,
      },
    });
  },

  get look() {
    const backdrop = Services.prefs.getStringPref(BACKDROP_PREF, "none");
    const shape = Services.prefs.getStringPref(SHAPE_PREF, "auto");
    return {
      backdrop: BACKDROPS.includes(backdrop) ? backdrop : "none",
      shape: shape in SHAPES ? shape : "auto",
    };
  },

  async imageFor(win, capture, hidden) {
    if (capture.images.has(hidden)) {
      return capture.images.get(hidden);
    }
    let bitmap = null;
    if (hidden == capture.originalHidden) {
      bitmap = await win.createImageBitmap(capture.blob);
    } else {
      bitmap = await this.recapture(win, capture, hidden);
    }
    if (bitmap) {
      capture.images.set(hidden, bitmap);
    }
    return bitmap;
  },

  // The same region of the same page again, with or without hiding.
  async recapture(win, capture, hidden) {
    const { browser } = capture;
    if (!capture.region || !browser?.isConnected || browser.currentURI?.spec != capture.spec) {
      return null;
    }
    const redact = lazy.WhimsyRedact;
    this._recapturing = true;
    try {
      if (hidden) {
        await redact.set(browser, true);
        const state = await redact.state(browser);
        capture.autoKinds = state?.kinds ?? null;
      }
      const canvas = await lazy.ScreenshotsUtils.createCanvas({ ...capture.region }, browser);
      return await win.createImageBitmap(canvas);
    } catch (e) {
      console.error("Whimsy: capture again", e);
      return null;
    } finally {
      // createCanvas's own wrapper (WhimsyRedact) clears it; this is for a
      // failure before that.
      await redact.set(browser, false);
      this._recapturing = false;
    }
  },

  /**
   * The finished image: the capture, the hand-drawn boxes, then the shape
   * and backdrop.
   */
  compose(doc, image, { boxes = [], handStyle = "black", backdrop = "none", shape = "auto" } = {}) {
    const w = image.width;
    const h = image.height;
    const base = doc.createElementNS(HTML_NS, "canvas");
    base.width = w;
    base.height = h;
    const b = base.getContext("2d");
    b.drawImage(image, 0, 0);
    for (const box of boxes) {
      if (handStyle == "blur") {
        b.save();
        b.beginPath();
        b.rect(box.x, box.y, box.width, box.height);
        b.clip();
        b.filter = "blur(8px)";
        b.drawImage(image, 0, 0);
        b.filter = "none";
        b.fillStyle = "rgba(128, 128, 128, 0.35)";
        b.fillRect(box.x, box.y, box.width, box.height);
        b.restore();
      } else {
        b.fillStyle = "rgb(0, 0, 0)";
        b.fillRect(box.x, box.y, box.width, box.height);
      }
    }
    const layout = layoutFor(w, h, { backdrop, shape });
    if (backdrop == "none" && layout.width == w && layout.height == h) {
      return { canvas: base, layout };
    }
    const out = doc.createElementNS(HTML_NS, "canvas");
    out.width = layout.width;
    out.height = layout.height;
    const c = out.getContext("2d");
    if (backdrop == "gradient") {
      const g = c.createLinearGradient(0, 0, layout.width, layout.height);
      g.addColorStop(0, "#f2c27b");
      g.addColorStop(1, "#8b5ad6");
      c.fillStyle = g;
    } else {
      c.fillStyle = { white: "#ffffff", dark: "#1c1b22" }[backdrop] ?? "transparent";
    }
    if (backdrop != "none") {
      c.fillRect(0, 0, layout.width, layout.height);
      c.save();
      c.shadowColor = "rgba(20, 16, 40, 0.28)";
      c.shadowBlur = Math.round(layout.radius * 3);
      c.shadowOffsetY = Math.round(layout.radius / 2);
      c.beginPath();
      c.roundRect(layout.x, layout.y, w, h, layout.radius);
      c.fillStyle = "#fff";
      c.fill();
      c.restore();
      c.save();
      c.beginPath();
      c.roundRect(layout.x, layout.y, w, h, layout.radius);
      c.clip();
    }
    c.drawImage(base, layout.x, layout.y);
    if (backdrop != "none") {
      c.restore();
    }
    return { canvas: out, layout };
  },

  /**
   * Opens the editor on `capture` (the viewer's, or a Library file's; by
   * default the selected tab's viewer). tool: "hand" (Redact) or null
   * (Edit).
   */
  async openEditor(win, { capture = null, tool = null } = {}) {
    capture ??= this.viewerOf(win);
    if (!capture) {
      return null;
    }
    const doc = win.document;
    const S = lazy.WhimsySurface;
    const existing = doc.getElementById(EDITOR_ID);
    if (existing?._capture == capture && (existing.state == "open" || existing.state == "showing")) {
      existing._setTool?.(tool);
      return existing;
    }
    // S.create replaces an open editor without its popuphidden: give the
    // previous capture its viewer back.
    if (existing?._capture && existing._capture != capture) {
      this.hideViewer(existing._capture, false);
    }
    const look = this.look;
    // As captured, or as the last Done left it.
    const kept = capture.editState;
    const state = {
      hidden: kept?.hidden ?? capture.originalHidden,
      boxes: [...(kept?.boxes ?? [])],
      tool,
      handStyle: kept?.handStyle ?? lazy.WhimsyRedact.style,
      backdrop: kept?.backdrop ?? look.backdrop,
      shape: kept?.shape ?? look.shape,
      image: null,
      layout: null,
      drawing: null,
    };
    const fromLibrary = capture.from == "library";
    const area = S.pageArea(win).getBoundingClientRect();
    const width = Math.max(320, Math.round(area.width - 80));
    const parts = S.create(win, {
      id: EDITOR_ID,
      width,
      titleL10nId: "whimsy-capture-editor-title",
      close: true,
      closeOnOutsideClick: false,
      footer: true,
      className: "whimsy-capture-editor",
      initialFocus: () => primary,
      onHidden: () => {
        if (this._editing == capture) {
          this._editing = null;
        }
        this.hideViewer(capture, false);
      },
    });
    const { panel, view, header } = parts;
    panel._capture = capture;
    this._editing = capture;
    this.hideViewer(capture, true);
    S.makeDraggable(panel, header);

    // The image, as it will come out.
    const preview = doc.createElementNS(HTML_NS, "canvas");
    preview.className = "whimsy-capture-preview";
    preview.setAttribute("tabindex", "0");
    preview.setAttribute("role", "img");
    doc.l10n.setAttributes(preview, "whimsy-capture-preview");
    const stage = doc.createXULElement("hbox");
    stage.className = "whimsy-capture-stage";
    stage.setAttribute("pack", "center");
    stage.append(preview);

    // The toolbar: Backdrop · Shape · Hide private details · Redact by hand.
    const bar = doc.createXULElement("hbox");
    bar.className = "whimsy-capture-toolbar";
    bar.setAttribute("align", "center");
    const groupOf = (l10nId, ...content) => {
      const g = doc.createXULElement("hbox");
      g.className = "whimsy-capture-tool-group";
      g.setAttribute("align", "center");
      if (l10nId) {
        const label = doc.createElementNS(HTML_NS, "span");
        label.className = "whimsy-capture-tool-label";
        doc.l10n.setAttributes(label, l10nId);
        g.append(label);
      }
      g.append(...content);
      return g;
    };
    const rule = () => {
      const r = doc.createXULElement("box");
      r.className = "whimsy-capture-tool-rule";
      return r;
    };

    const backdrops = doc.createElementNS(HTML_NS, "div");
    backdrops.className = "whimsy-capture-backdrops";
    backdrops.setAttribute("role", "radiogroup");
    doc.l10n.setAttributes(backdrops, "whimsy-capture-backdrop-group");
    for (const name of BACKDROPS) {
      const b = doc.createElementNS(HTML_NS, "button");
      b.type = "button";
      b.className = "whimsy-capture-backdrop";
      b.dataset.backdrop = name;
      b.setAttribute("role", "radio");
      doc.l10n.setAttributes(b, `whimsy-capture-backdrop-${name}`);
      b.addEventListener("click", () => {
        state.backdrop = name;
        Services.prefs.setStringPref(BACKDROP_PREF, name);
        sync();
      });
      backdrops.append(b);
    }
    const shapes = S.seg(doc, {
      name: "whimsy-capture-shape",
      small: true,
      options: Object.keys(SHAPES).map(value => ({
        value,
        l10nId: value == "auto" ? "whimsy-capture-shape-auto" : null,
        text: value == "auto" ? null : value,
      })),
      onPick: value => {
        state.shape = value;
        Services.prefs.setStringPref(SHAPE_PREF, value);
        sync();
      },
    });
    doc.l10n.setAttributes(shapes.group, "whimsy-capture-shape-group");
    const hideLabel = doc.createElementNS(HTML_NS, "span");
    hideLabel.id = "whimsy-capture-hide-label";
    hideLabel.className = "whimsy-capture-tool-label";
    doc.l10n.setAttributes(hideLabel, "whimsy-capture-hide");
    const hide = S.switch(doc, {
      checked: state.hidden,
      labelledBy: hideLabel.id,
      id: "whimsy-capture-hide",
      onChange: async checked => {
        hide.disabled = true;
        const image = await this.imageFor(win, capture, checked);
        hide.disabled = false;
        if (!image) {
          hide.checked = !checked;
          hide.disabled = true;
          doc.l10n.setAttributes(hide, "whimsy-capture-hide-unavailable");
          return;
        }
        state.hidden = checked;
        Services.prefs.setBoolPref(REDACT_PREF, checked);
        state.image = image;
        sync();
      },
    });
    const hand = doc.createElementNS(HTML_NS, "button");
    hand.type = "button";
    hand.className = "whimsy-capture-hand";
    const handIcon = doc.createXULElement("image");
    handIcon.setAttribute("src", "chrome://browser/content/whimsy/icons/redact.svg");
    const handLabel = doc.createElementNS(HTML_NS, "span");
    doc.l10n.setAttributes(handLabel, "whimsy-capture-hand");
    hand.append(handIcon, handLabel);
    hand.addEventListener("click", () => setTool(state.tool == "hand" ? null : "hand"));
    const styles = S.seg(doc, {
      name: "whimsy-capture-hand-style",
      small: true,
      options: ["black", "blur"].map(value => ({ value, l10nId: `whimsy-redact-style-${value}` })),
      onPick: value => {
        state.handStyle = value;
        Services.prefs.setStringPref(STYLE_PREF, value);
        sync();
      },
    });
    styles.group.classList.add("whimsy-capture-hand-style");
    doc.l10n.setAttributes(styles.group, "whimsy-capture-hand-style-group");
    // A Library file has no page to take again.
    const hideGroup = groupOf(null, hide, hideLabel);
    const hideRule = rule();
    hideGroup.hidden = hideRule.hidden = fromLibrary;
    bar.append(
      groupOf("whimsy-capture-backdrop-label", backdrops), rule(),
      groupOf("whimsy-capture-shape-label", shapes.group), hideRule,
      hideGroup, rule(),
      groupOf(null, hand, styles.group)
    );
    const hint = doc.createElementNS(HTML_NS, "p");
    hint.className = "whimsy-capture-hint";
    view.append(stage, bar, hint);

    // Copy and Download keep it open; ✕ and Esc leave without the edits.
    // From the viewer: Done (back to it, edits kept) and Save and Close.
    // From the Library: Save Copy and Save (that file).
    const { footer } = parts;
    const button = (name, l10nId, onCommand, { isPrimary = false } = {}) => {
      const b = S.footerButton(doc, { l10nId, primary: isPrimary, onCommand });
      b.dataset.action = name;
      return b;
    };
    const copy = button("copy", "whimsy-capture-editor-copy", () => this.editorCopy(win, state, copy));
    const download = button("download", "whimsy-capture-editor-download",
      () => this.editorDownload(win, capture, state, download));
    const spacer = doc.createXULElement("spacer");
    spacer.setAttribute("flex", "1");
    let primary;
    if (fromLibrary) {
      const saveCopy = button("save-copy", "whimsy-capture-editor-save-copy",
        () => this.editorSave(win, capture, state, panel, { copy: true }));
      primary = button("save", "whimsy-capture-editor-save",
        () => this.editorSave(win, capture, state, panel, { copy: false }), { isPrimary: true });
      footer.append(copy, download, spacer, saveCopy, primary);
    } else {
      const done = button("done", "whimsy-capture-done", () => this.editorDone(win, capture, state, panel),
        { isPrimary: capture.private });
      footer.append(copy, download, spacer, done);
      primary = done;
      if (!capture.private) {
        primary = button("save-close", "whimsy-capture-editor-save-close",
          () => this.editorSaveAndClose(win, capture, state), { isPrimary: true });
        footer.append(primary);
      }
    }
    S.finish(parts);

    const setTool = next => {
      state.tool = next;
      sync();
    };
    panel._setTool = setTool;

    let previewHeight = 1;
    // Draws the preview and the controls' state.
    const sync = () => {
      for (const b of backdrops.children) {
        const on = b.dataset.backdrop == state.backdrop;
        b.setAttribute("aria-checked", String(on));
        b.tabIndex = on ? 0 : -1;
      }
      shapes.select(state.shape);
      styles.select(state.handStyle);
      hand.setAttribute("aria-pressed", String(state.tool == "hand"));
      styles.group.hidden = state.tool != "hand";
      preview.toggleAttribute("drawing", state.tool == "hand");
      doc.l10n.setAttributes(hint, state.tool == "hand" ? "whimsy-capture-hint-hand" : "whimsy-capture-hint");
      if (!state.image) {
        return;
      }
      const { canvas, layout } = this.compose(doc, state.image, state);
      state.layout = layout;
      const maxW = width - 20;
      const scale = Math.min(1, maxW / canvas.width, previewHeight / canvas.height);
      state.scale = scale;
      const cssW = Math.max(1, Math.round(canvas.width * scale));
      const cssH = Math.max(1, Math.round(canvas.height * scale));
      // Keep pointer coordinates in CSS pixels; only the backing store
      // follows the screen density, capped at the source resolution.
      const backing = Math.min(win.devicePixelRatio || 1, 1 / scale);
      preview.width = Math.round(cssW * backing);
      preview.height = Math.round(cssH * backing);
      preview.style.width = `${cssW}px`;
      preview.style.height = `${cssH}px`;
      const p = preview.getContext("2d");
      p.setTransform(preview.width / cssW, 0, 0, preview.height / cssH, 0, 0);
      p.clearRect(0, 0, cssW, cssH);
      p.drawImage(canvas, 0, 0, cssW, cssH);
      if (state.drawing) {
        const r = state.drawing;
        p.strokeStyle = "rgba(255, 255, 255, 0.9)";
        p.setLineDash([4, 3]);
        p.strokeRect(
          (layout.x + r.x) * scale + 0.5, (layout.y + r.y) * scale + 0.5,
          r.width * scale, r.height * scale
        );
      }
    };

    // Redact by hand: drag a box over the image; a click on a box takes it away.
    const toImage = event => {
      const r = preview.getBoundingClientRect();
      return {
        x: (event.clientX - r.left) / state.scale - state.layout.x,
        y: (event.clientY - r.top) / state.scale - state.layout.y,
      };
    };
    const clampBox = (a, b) => {
      const w = state.image.width;
      const h = state.image.height;
      const x1 = Math.max(0, Math.min(a.x, b.x));
      const y1 = Math.max(0, Math.min(a.y, b.y));
      const x2 = Math.min(w, Math.max(a.x, b.x));
      const y2 = Math.min(h, Math.max(a.y, b.y));
      return { x: Math.round(x1), y: Math.round(y1), width: Math.round(x2 - x1), height: Math.round(y2 - y1) };
    };
    preview.addEventListener("pointerdown", event => {
      if (state.tool != "hand" || event.button != 0 || !state.image) {
        return;
      }
      event.preventDefault();
      preview.setPointerCapture?.(event.pointerId);
      const start = toImage(event);
      state.drawing = clampBox(start, start);
      const move = e => {
        state.drawing = clampBox(start, toImage(e));
        sync();
      };
      const up = e => {
        preview.removeEventListener("pointermove", move);
        preview.removeEventListener("pointerup", up);
        const box = clampBox(start, toImage(e));
        state.drawing = null;
        if (box.width * state.scale >= 4 && box.height * state.scale >= 4) {
          state.boxes.push(box);
        } else {
          // A click: on a box, it goes.
          const at = state.boxes.findLastIndex(b =>
            start.x >= b.x && start.x <= b.x + b.width && start.y >= b.y && start.y <= b.y + b.height);
          if (at >= 0) {
            state.boxes.splice(at, 1);
          }
        }
        sync();
      };
      preview.addEventListener("pointermove", move);
      preview.addEventListener("pointerup", up);
    });
    // Backspace takes the last box away.
    preview.addEventListener("keydown", event => {
      if ((event.key == "Backspace" || event.key == "Delete") && state.boxes.length) {
        event.preventDefault();
        state.boxes.pop();
        sync();
      }
    });

    sync();
    const shown = new Promise(resolve => panel.addEventListener("popupshown", resolve, { once: true }));
    S.open(win, panel, { at: "page-top-center" });
    // Edit pressed as soon as the viewer shows: its image may not have been
    // read yet (W16-19's check found createImageBitmap(null) there).
    if (!capture.blob && !capture.edited && capture.from == "viewer") {
      await this.currentBlob(capture).catch(e => console.error("Whimsy: screenshot editor", e));
    }
    state.image = await this.imageFor(win, capture, state.hidden);
    if (!state.image) {
      state.image = await win.createImageBitmap(capture.blob);
    }
    if (panel.isConnected) {
      await shown;
      await doc.l10n.translateFragment(panel);
      // Measure the actual header, wrapped toolbar, hint and footer after
      // layout, leaving room around the editor and for the stage padding.
      const nonImageHeight = panel.getBoundingClientRect().height - stage.getBoundingClientRect().height;
      const stageStyle = win.getComputedStyle(stage);
      const stagePadding = parseFloat(stageStyle.paddingTop) + parseFloat(stageStyle.paddingBottom);
      previewHeight = Math.max(1, Math.floor(area.height - 80 - nonImageHeight - stagePadding));
      sync();
    }
    return panel;
  },

  /** The finished image: the capture, the hand-drawn boxes, then the shape and backdrop. */
  async render(win, state) {
    if (!state.image) {
      return null;
    }
    const { canvas } = this.compose(win.document, state.image, state);
    return new Promise(resolve => canvas.toBlob(resolve, "image/png"));
  },

  async editorCopy(win, state, button) {
    const blob = await this.render(win, state);
    if (!blob) {
      return false;
    }
    lazy.BrowserUtils.copyImageToClipboard(await blob.arrayBuffer());
    this.flash(button, "whimsy-capture-editor-copied");
    return true;
  },

  async editorDownload(win, capture, state, button) {
    const blob = await this.render(win, state);
    if (!blob) {
      return false;
    }
    const saved = await this.download(win, blob, capture);
    if (saved) {
      this.flash(button, "whimsy-capture-editor-downloaded");
    }
    return saved;
  },

  // Firefox Screenshots' download (its file name, its folder or "Always
  // ask"), for an image that has no Screenshots session behind it.
  async download(win, blob, capture) {
    const browser = capture.browser ?? win.gBrowser.selectedBrowser;
    const isPrivate = capture.private;
    const title = capture.browser ? capture.browser.contentTitle ?? "" : "";
    const url = URL.createObjectURL(blob);
    try {
      const { filename, accepted } = await lazy.getFilename(title, browser);
      if (!accepted) {
        return false;
      }
      const { Downloads } = lazy;
      const download = await Downloads.createDownload({
        source: { url, isPrivate },
        target: new lazy.FileUtils.File(filename),
      });
      const list = await Downloads.getList(isPrivate ? Downloads.PRIVATE : Downloads.PUBLIC);
      list.add(download);
      await download.start();
      return true;
    } catch (e) {
      console.error("Whimsy: screenshot download", e);
      return false;
    } finally {
      win.setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  },

  // Done: back to the viewer with the edits; nothing is written.
  async editorDone(win, capture, state, panel) {
    const blob = await this.render(win, state);
    if (!blob) {
      return null;
    }
    this.keepEdits(capture, state, blob);
    lazy.WhimsySurface.close(panel);
    return blob;
  },

  keepEdits(capture, state, blob) {
    capture.edited = blob;
    capture.editState = {
      hidden: state.hidden,
      boxes: [...state.boxes],
      handStyle: state.handStyle,
      backdrop: state.backdrop,
      shape: state.shape,
    };
    const img = capture.preview?.previewImg;
    if (img?.isConnected) {
      const old = capture.editedURL;
      capture.editedURL = URL.createObjectURL(blob);
      img.src = capture.editedURL;
      if (old) {
        URL.revokeObjectURL(old);
      }
    }
  },

  async editorSaveAndClose(win, capture, state) {
    const blob = await this.render(win, state);
    if (!blob) {
      return null;
    }
    this.keepEdits(capture, state, blob);
    return this.saveAndClose(capture);
  },

  // From the Library: Save replaces the file, Save Copy adds one.
  async editorSave(win, capture, state, panel, { copy = false } = {}) {
    const blob = await this.render(win, state);
    if (!blob) {
      return null;
    }
    const path = copy ? await lazy.writeCapture(blob) :
      ((await lazy.overwriteCapture(capture.path, blob)) ? capture.path : null);
    if (path) {
      lazy.WhimsySurface.close(panel);
    }
    return path;
  },
};
