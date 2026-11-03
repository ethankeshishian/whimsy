/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W13 F04 (wave12 F04, option A; wave13 research yab.md §2.5): Redact
// after the capture. Firefox Screenshots keeps its name and its capture
// step; what changes is what comes after a copy:
//
//   a result card at the page's bottom end: the image, then
//     Copied · Save · Redact · Edit
//   and a line saying what was hidden ("2 emails hidden · drag out to make
//   a file"). Copied copies again; Save saves it as a file (Firefox's own
//   download, with its name and folder); the image drags out as a file.
//
//   Redact and Edit open one editor on the image (Yab's Edit): Backdrop,
//   Shape (Auto, 16:9, 1:1, 4:5), "Hide private details" and "Redact by
//   hand" (drag boxes over the image; a click on a box takes it away),
//   then Done, which copies the result. Redact opens it with the hand
//   picked, Edit with nothing picked. The look (backdrop, shape) is
//   remembered for the next capture's editor.
//
// "Hide private details" is the existing redact machinery (WhimsyRedact:
// emails, phone numbers, keys and card numbers, found in the page's text
// in every frame), on by default (whimsy.capture.redact): it hides them
// on the page while you frame the shot, so the copy already has them
// hidden and the card says what it hid. Turning it off or on in the
// editor captures the same region of the page again, without or with it.
// With the card, the Redact toggle leaves the Screenshots bar (Redact is
// after the capture now, not a mode before it).
//
// Screenshots' files stay untouched: ScreenshotsUtils.createCanvas (every
// capture draws there) and copyScreenshot (every Screenshots copy) are
// wrapped the way WhimsyRedact and WhimsyFilesSection wrap them, each
// calling through, so the wrappers compose in any order.
//
// Nothing is sent anywhere. A private page's capture stays in memory (the
// Library never gets it, as before) and doesn't drag out as a file.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  saveCapture: "resource:///modules/whimsy/WhimsyFilesSection.sys.mjs",
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  ScreenshotsUtils: "moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyRedact: "resource:///modules/whimsy/WhimsyRedactParent.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.capture-card";
const REDACT_PREF = "whimsy.capture.redact";
const STYLE_PREF = "whimsy.capture.redact-style";
const BACKDROP_PREF = "whimsy.capture.backdrop";
const SHAPE_PREF = "whimsy.capture.shape";
const SAVED_TOPIC = "whimsy-capture-saved";
const HTML_NS = "http://www.w3.org/1999/xhtml";

const CARD_ID = "whimsy-capture-card";
const CARD_WIDTH = 236;
// The card goes by itself after this long, unless the pointer or the
// keyboard is in it, or its editor is open.
const CARD_MS = 8000;
const EDITOR_ID = "whimsy-capture-editor";
const EDITOR_WIDTH = 720;
const PREVIEW_HEIGHT = 360;

export const BACKDROPS = ["gradient", "white", "dark", "none"];
export const SHAPES = { auto: null, "16:9": 16 / 9, "1:1": 1, "4:5": 4 / 5 };
const KINDS = ["email", "phone", "card", "key", "text"];
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

function totalHidden(kinds) {
  return KINDS.reduce((n, kind) => n + (kinds?.[kind] ?? 0), 0);
}

export const WhimsyCaptureCard = {
  _installed: false,
  // Set while the editor captures the page again, so that capture isn't
  // taken for a new one.
  _recapturing: false,
  // browser -> what the next copy came from (region, what was hidden).
  _pending: new WeakMap(),
  // window -> its last capture.
  _last: new WeakMap(),

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  initWindow(win) {
    this.install();
    const available = w => this.enabled && !!this._last.get(w);
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyCaptureEdit",
      l10nId: "whimsy-action-capture-edit",
      run: w => available(w) && this.openEditor(w, { tool: null }),
      icon: ICON("sliders"),
      isAvailable: available,
    });
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyCaptureRedactLast",
      l10nId: "whimsy-action-capture-redact-last",
      run: w => available(w) && this.openEditor(w, { tool: "hand" }),
      icon: "chrome://browser/content/whimsy/icons/redact.svg",
      isAvailable: available,
    });
  },

  install() {
    if (this._installed) {
      return;
    }
    this._installed = true;
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
          console.error("Whimsy: capture card", e);
        }
      }
      return createCanvas.call(this, region, browser, ...rest);
    };
    // Every Screenshots copy: then the card.
    const copyScreenshot = utils.copyScreenshot;
    utils.copyScreenshot = async function (blob, browser, eventName, ...rest) {
      await copyScreenshot.call(this, blob, browser, eventName, ...rest);
      try {
        if (self.enabled && blob && browser?.isConnected) {
          self.showCard(browser, blob);
        }
      } catch (e) {
        console.error("Whimsy: capture card", e);
      }
    };
  },

  isPrivate(browser) {
    try {
      return lazy.PrivateBrowsingUtils.isBrowserPrivate(browser);
    } catch {
      return true;
    }
  },

  // ---- The card ---------------------------------------------------------

  showCard(browser, blob) {
    // Not browser.ownerGlobal: Screenshots' own copyScreenshot() can run
    // this continuation after an xray-wrapped browser's ownerGlobal has
    // gone stale (seen with a directly-called copyScreenshotFromRegion, as
    // in the test), while ownerDocument.defaultView still resolves.
    const win = browser.ownerDocument?.defaultView;
    if (!win?.gBrowser) {
      return null;
    }
    const doc = win.document;
    const from = this._pending.get(browser) ?? null;
    this._pending.delete(browser);
    const old = this._last.get(win);
    if (old && old != this._editing) {
      this.release(win, old);
    }
    const capture = {
      browser,
      blob,
      url: win.URL.createObjectURL(blob),
      region: from?.region ?? null,
      spec: from?.spec ?? "",
      redacted: !!from?.redacted,
      // Whether the copied image itself has the page's details hidden
      // (it never changes; `redacted` follows the edits).
      originalHidden: !!from?.redacted,
      // What the page hid (autoKinds) and what the card says was hidden
      // (kinds: that, plus boxes drawn by hand).
      autoKinds: from?.kinds ?? null,
      kinds: from?.kinds ?? null,
      private: this.isPrivate(browser),
      path: null,
      // The images the editor has made, by "hidden" (true/false).
      images: new Map(),
    };
    this._last.set(win, capture);
    this.watchSaved(win, capture);

    const S = lazy.WhimsySurface;
    const parts = S.create(win, {
      id: CARD_ID,
      width: CARD_WIDTH,
      className: "whimsy-capture-card",
      initialFocus: false,
      onHidden: () => {
        win.clearTimeout(timer);
        win.gBrowser.tabContainer.removeEventListener("TabSelect", onTabSelect);
      },
    });
    const { panel, view } = parts;
    doc.l10n.setAttributes(panel, "whimsy-capture-card");

    const thumb = doc.createElementNS(HTML_NS, "img");
    thumb.className = "whimsy-capture-thumb";
    thumb.src = capture.url;
    doc.l10n.setAttributes(thumb, "whimsy-capture-thumb");
    thumb.addEventListener("dragstart", event => this.onDragStart(event, capture));

    const actions = doc.createElementNS(HTML_NS, "div");
    actions.className = "whimsy-capture-actions";
    actions.setAttribute("role", "group");
    const action = (name, icon, l10nId, onClick) => {
      const button = doc.createElementNS(HTML_NS, "button");
      button.type = "button";
      button.className = "whimsy-capture-action";
      button.dataset.action = name;
      const image = doc.createXULElement("image");
      image.setAttribute("src", icon);
      const label = doc.createElementNS(HTML_NS, "span");
      doc.l10n.setAttributes(label, l10nId);
      button.append(image, label);
      button.addEventListener("click", onClick);
      actions.append(button);
      return button;
    };
    const copied = action("copy", ICON("check"), "whimsy-capture-copied", () => this.copyAgain(win, capture, copied));
    copied.setAttribute("done", "true");
    const save = action("save", ICON("save"), "whimsy-capture-save", () => this.save(win, capture, save));
    action("redact", "chrome://browser/content/whimsy/icons/redact.svg", "whimsy-capture-redact",
      () => this.openEditor(win, { tool: "hand" }));
    action("edit", ICON("sliders"), "whimsy-capture-edit", () => this.openEditor(win, { tool: null }));

    const detail = doc.createElementNS(HTML_NS, "p");
    detail.className = "whimsy-capture-detail";
    view.append(thumb, actions, detail);
    capture.card = { panel, thumb, detail, copied, save };
    this.updateCard(win, capture);

    // It goes by itself, unless you're using it.
    let timer = 0;
    const arm = () => {
      win.clearTimeout(timer);
      timer = win.setTimeout(() => {
        if (!panel.matches(":hover") && !panel.contains(doc.activeElement) && this._editing != capture) {
          S.close(panel);
        } else {
          arm();
        }
      }, CARD_MS);
    };
    panel.addEventListener("mouseleave", arm);
    panel.addEventListener("focusout", arm);
    const onTabSelect = () => S.close(panel);
    win.gBrowser.tabContainer.addEventListener("TabSelect", onTabSelect);
    arm();

    // The page's bottom end corner, 12px in.
    const area = S.pageArea(win);
    const rect = area.getBoundingClientRect();
    // The same side as Page tools' "page-top-end" (away from a sidebar on
    // the right).
    const startSide = S.sidebarOnRight(win) != (doc.dir == "rtl");
    const x = startSide ? 12 : Math.max(0, Math.round(rect.width - CARD_WIDTH - 12));
    panel.addEventListener("popupshown", () => {
      // Exactly 12px above the bottom, now that its height is known.
      const box = panel.getOuterScreenRect();
      const bottom = win.mozInnerScreenY + rect.bottom - 12;
      if (Math.abs(box.top + box.height - bottom) > 1) {
        panel.moveTo(Math.round(box.left), Math.round(bottom - box.height));
      }
    }, { once: true });
    S.openOver(panel, area, { x, y: Math.max(0, Math.round(rect.height - 200)) });
    return panel;
  },

  // What the card says under the buttons.
  updateCard(win, capture) {
    const card = capture.card;
    if (!card?.panel.isConnected) {
      return;
    }
    const doc = win.document;
    card.thumb.src = capture.url;
    const kinds = capture.redacted ? capture.kinds ?? {} : {};
    const total = totalHidden(kinds);
    const only = KINDS.find(kind => kinds[kind] == total) ?? "mixed";
    const drag = !capture.private;
    card.thumb.draggable = drag;
    doc.l10n.setAttributes(card.detail, "whimsy-capture-detail", {
      count: total,
      kind: total ? only : "none",
      drag: drag ? "yes" : "no",
    });
  },

  // Releases a capture's object URLs.
  release(win, capture) {
    try {
      win.URL.revokeObjectURL(capture.url);
    } catch {}
  },

  // The Library's copy of the capture (WhimsyFilesSection saves every
  // Screenshots copy), so the image drags out as that file.
  watchSaved(win, capture) {
    if (capture.private) {
      return;
    }
    const observer = (subject, topic, data) => {
      capture.path ??= data;
      Services.obs.removeObserver(observer, SAVED_TOPIC);
    };
    Services.obs.addObserver(observer, SAVED_TOPIC);
    // Only this capture's: stop listening soon after.
    win.setTimeout(() => {
      try {
        Services.obs.removeObserver(observer, SAVED_TOPIC);
      } catch {}
    }, 3000);
  },

  onDragStart(event, capture) {
    const dt = event.dataTransfer;
    if (capture.private || !dt) {
      event.preventDefault();
      return;
    }
    // The Library's file of what was copied (the edit's own, after Done).
    if (capture.path) {
      try {
        dt.mozSetDataAt("application/x-moz-file", new lazy.FileUtils.File(capture.path), 0);
        dt.effectAllowed = "copy";
        return;
      } catch (e) {
        console.error("Whimsy: capture drag", e);
      }
    }
    dt.setData("text/uri-list", capture.url);
    dt.effectAllowed = "copy";
  },

  async copyAgain(win, capture, button) {
    const buffer = await (capture.edited ?? capture.blob).arrayBuffer();
    lazy.BrowserUtils.copyImageToClipboard(buffer);
    this.flash(win, button, "whimsy-capture-copied");
  },

  // The button says it worked, briefly.
  flash(win, button, l10nId) {
    if (!button?.isConnected) {
      return;
    }
    button.setAttribute("done", "true");
    button.classList.add("whimsy-capture-flash");
    win.setTimeout(() => button.classList.remove("whimsy-capture-flash"), 600);
    win.document.l10n.setAttributes(button.querySelector("span"), l10nId);
  },

  async save(win, capture, button) {
    const blob = capture.edited ?? capture.blob;
    const url = win.URL.createObjectURL(blob);
    let saved = false;
    try {
      saved = await lazy.ScreenshotsUtils.downloadScreenshot(null, url, capture.browser, "Download");
    } catch (e) {
      // Screenshots' telemetry wants its own session, which is over by
      // now; the file is saved before that.
      saved = true;
      console.warn("Whimsy: capture card save", e);
    } finally {
      win.setTimeout(() => win.URL.revokeObjectURL(url), 60000);
    }
    if (saved) {
      this.flash(win, button, "whimsy-capture-saved");
    }
    return saved;
  },

  // ---- The editor -------------------------------------------------------

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
   * Opens the editor on the window's last capture. tool: "hand" (Redact)
   * or null (Edit).
   */
  async openEditor(win, { tool = null } = {}) {
    const capture = this._last.get(win);
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
    const look = this.look;
    const state = {
      // The capture as copied (with the page's private details hidden or
      // not), or as the last Done left it.
      hidden: capture.editorHidden ?? capture.originalHidden,
      boxes: [],
      tool,
      handStyle: lazy.WhimsyRedact.style,
      backdrop: look.backdrop,
      shape: look.shape,
      image: null,
      layout: null,
      drawing: null,
    };
    const area = S.pageArea(win).getBoundingClientRect();
    const width = Math.max(320, Math.min(EDITOR_WIDTH, Math.round(area.width - 40)));
    const parts = S.create(win, {
      id: EDITOR_ID,
      width,
      titleL10nId: "whimsy-capture-editor-title",
      close: true,
      closeOnOutsideClick: false,
      className: "whimsy-capture-editor",
      initialFocus: () => done,
      onHidden: () => {
        if (this._editing == capture) {
          this._editing = null;
        }
      },
    });
    const { panel, view, header } = parts;
    panel._capture = capture;
    this._editing = capture;
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

    // The toolbar: Backdrop · Shape · Hide private details · Redact by hand · Done.
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
    const done = S.footerButton(doc, {
      l10nId: "whimsy-capture-done",
      primary: true,
      onCommand: () => this.finish(win, capture, state, panel),
    });
    bar.append(
      groupOf("whimsy-capture-backdrop-label", backdrops), rule(),
      groupOf("whimsy-capture-shape-label", shapes.group), rule(),
      groupOf(null, hide, hideLabel), rule(),
      groupOf(null, hand, styles.group),
      done
    );
    const hint = doc.createElementNS(HTML_NS, "p");
    hint.className = "whimsy-capture-hint";
    view.append(stage, bar, hint);

    const setTool = next => {
      state.tool = next;
      sync();
    };
    panel._setTool = setTool;

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
      const scale = Math.min(1, maxW / canvas.width, PREVIEW_HEIGHT / canvas.height);
      state.scale = scale;
      preview.width = Math.max(1, Math.round(canvas.width * scale));
      preview.height = Math.max(1, Math.round(canvas.height * scale));
      const p = preview.getContext("2d");
      p.clearRect(0, 0, preview.width, preview.height);
      p.drawImage(canvas, 0, 0, preview.width, preview.height);
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
    S.open(win, panel, { at: "page-top-center" });
    state.image = await this.imageFor(win, capture, state.hidden);
    if (!state.image) {
      state.image = await win.createImageBitmap(capture.blob);
    }
    if (panel.isConnected) {
      sync();
    }
    return panel;
  },

  // Done: the finished image goes to the clipboard and onto the card.
  async finish(win, capture, state, panel) {
    if (!state.image) {
      return null;
    }
    const doc = win.document;
    const { canvas } = this.compose(doc, state.image, state);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    if (!blob) {
      return null;
    }
    lazy.BrowserUtils.copyImageToClipboard(await blob.arrayBuffer());
    capture.edited = blob;
    this.release(win, capture);
    capture.url = win.URL.createObjectURL(blob);
    // What the card says now: what the page hid (if that's on), plus the
    // boxes drawn by hand.
    capture.editorHidden = state.hidden;
    const auto = state.hidden ? capture.autoKinds ?? {} : {};
    capture.kinds = { ...auto, text: (auto.text ?? 0) + state.boxes.length };
    capture.redacted = state.hidden || state.boxes.length > 0;
    // The Library keeps what was copied (as it keeps every capture), and
    // that file is what the card's image drags out as.
    if (!capture.private) {
      capture.path = (await lazy.saveCapture(blob, capture.browser)) ?? null;
    }
    lazy.WhimsySurface.close(panel);
    this.updateCard(win, capture);
    this.flash(win, capture.card?.copied, "whimsy-capture-copied");
    return blob;
  },

  lastCapture(win) {
    return this._last.get(win) ?? null;
  },
};
