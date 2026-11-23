/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W30 svg-save: save an SVG as SVG, PNG or JPG (owner-approved mockup
// intake-w30/designs/svg-save-mockup.html).
// - On an <img> showing an SVG, Firefox's own "Save Image As…" opens the
//   dialog instead of saving; every other image keeps Firefox's behaviour.
// - An inline <svg>, or one shown by <object> or <embed>, gets a "Save
//   Image As…" row in the page menu, right below "Save Page As…".
// The dialog (a WhimsySurface over the page, laid out like the Focus
// session sheet): Format (SVG, PNG, JPG; always opens on SVG, which saves
// the original file), Background (Clear, White, Page; remembered), and
// Size (the drawn size, proportions locked, clamped to Firefox's largest
// canvas). Drawing happens in the page's process (WhimsySvgSaveChild); the
// file goes through Firefox's download setting, like the screenshot save.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  DownloadPaths: "resource://gre/modules/DownloadPaths.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyCaptureCard: "resource:///modules/whimsy/WhimsyCaptureCard.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.svg-save";
const BACKGROUND_PREF = "whimsy.svg-save.background";
const MENU_ID = "context-whimsy-save-svg";
const PANEL_ID = "whimsy-svg-save";
const ACTOR = "WhimsySvgSave";
const XHTML = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_TYPE = "image/svg+xml";
const FORMATS = {
  png: { type: "image/png", ext: "png" },
  jpg: { type: "image/jpeg", ext: "jpg" },
};
const BACKGROUNDS = ["clear", "white", "page"];

// Firefox's largest canvas, the limits Screenshots uses
// (ScreenshotsUtils' MAX_CAPTURE_DIMENSION and MAX_CAPTURE_AREA).
export const MAX_SIDE = 32766;
export const MAX_AREA = 472907776;

/**
 * The largest size inside Firefox's limits with the same proportions, or
 * null when width × height already fits.
 */
export function clampSize(width, height, ratioWidth = width, ratioHeight = height) {
  if (!(width >= 1 && height >= 1)) {
    return null;
  }
  const s = Math.min(1, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_AREA / (width * height)));
  if (s >= 1) {
    return null;
  }
  const follow = w => Math.max(1, Math.round((w * ratioHeight) / ratioWidth));
  let w = Math.max(1, Math.floor(width * s));
  let h = follow(w);
  while (w > 1 && (h > MAX_SIDE || w > MAX_SIDE || w * h > MAX_AREA)) {
    w--;
    h = follow(w);
  }
  return { width: w, height: h };
}

/** The file name for a save: the SVG's own name, else its <title>, else "image". */
export function fileNameFor(info, ext) {
  const clean = text => {
    let name = "";
    try {
      name = lazy.DownloadPaths.sanitize(text ?? "", { compressWhitespaces: true });
    } catch (e) {}
    return name.replace(/\.+$/, "").trim().slice(0, 120);
  };
  const base = clean(info?.baseName) || clean(info?.title) || "image";
  return `${base}.${ext}`;
}

export class WhimsySvgSaveParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name == "WhimsySvgSave:Target") {
      const browser = this.browsingContext.top.embedderElement;
      if (browser) {
        browser._whimsySvgTarget = message.data?.kind ?? null;
      }
    }
    return null;
  }
}

export const WhimsySvgSave = {
  MENU_ID,
  PANEL_ID,

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  initWindow(win) {
    const doc = win.document;
    const menu = doc.getElementById("contentAreaContextMenu");
    if (!menu) {
      return;
    }
    const item = doc.createXULElement("menuitem");
    item.id = MENU_ID;
    item.hidden = true;
    doc.l10n.setAttributes(item, "whimsy-context-save-svg");
    // gContextMenu is read when the item is used, never kept.
    item.addEventListener("command", () => this.fromMenu(win));
    const anchor = doc.getElementById("context-savepage");
    anchor ? anchor.after(item) : menu.append(item);

    let shownKind = null;
    menu.addEventListener("popupshowing", event => {
      if (event.target != menu) {
        return;
      }
      // What the child said about this right-click (sent before Firefox's
      // own menu message); used once, so a page the actor doesn't run in
      // never shows an earlier answer.
      const browser = win.gContextMenu?.browser;
      shownKind = browser?._whimsySvgTarget ?? null;
      if (browser) {
        browser._whimsySvgTarget = null;
      }
      // Firefox has already decided whether page items show (Save Page As
      // is hidden on links, images, selections and fields).
      const pageItems = !doc.getElementById("context-savepage")?.hidden;
      item.hidden = !this.enabled || !pageItems || !(shownKind == "inline" || shownKind == "doc");
    });

    // An SVG <img>: Firefox's own Save Image As opens the dialog. Capture,
    // so Firefox's handler (on the popup, bubbling) never sees it.
    menu.addEventListener("command", event => {
      if (event.target?.id != "context-saveimage" || !this.enabled) {
        return;
      }
      const context = win.gContextMenu;
      if (!context?.onImage || context.onCanvas) {
        return;
      }
      if (shownKind != "img" && context.contentData?.contentType != SVG_TYPE) {
        return;
      }
      event.stopPropagation();
      this.fromMenu(win);
    }, true);
  },

  // Everything the save needs from the menu, read now: gContextMenu is
  // gone once the menu closes.
  contextFor(win) {
    const context = win.gContextMenu;
    if (!context?.browser) {
      return null;
    }
    return {
      browser: context.browser,
      frame: context.frameBrowsingContext ?? context.browser.browsingContext,
      target: context.targetIdentifier,
      principal: context.principal,
      referrerInfo: context.contentData?.referrerInfo ?? null,
      cookieJarSettings: context.contentData?.cookieJarSettings ?? null,
      contentDisposition: context.onImage ? context.contentData?.contentDisposition ?? null : null,
      isPrivate: lazy.PrivateBrowsingUtils.isBrowserPrivate(context.browser),
    };
  },

  async fromMenu(win) {
    const ctx = this.contextFor(win);
    if (!ctx) {
      return null;
    }
    let info = null;
    try {
      info = await ctx.frame.currentWindowGlobal?.getActor(ACTOR).sendQuery("WhimsySvgSave:Gather", { target: ctx.target });
    } catch (e) {
      console.error("Whimsy: svg-save gather", e);
    }
    info = this.checked(info);
    if (!info) {
      this.failed(win);
      return null;
    }
    return this.open(win, info, ctx);
  },

  // The child's answer, kept to what it may be: a web process could send
  // anything. (The address is checked against the page's principal again
  // when it is saved.)
  checked(info) {
    if (!info || !["img", "inline", "doc"].includes(info.kind)) {
      return null;
    }
    const side = n => (Number.isFinite(n) && n >= 1 ? Math.min(Math.round(n), MAX_SIDE) : 1);
    const ratio = n => (Number.isFinite(n) && n > 0 ? n : 0);
    const text = (value, max) => (typeof value == "string" ? value.slice(0, max) : "");
    const clean = {
      kind: info.kind,
      width: side(info.width),
      height: side(info.height),
      ratioWidth: ratio(info.ratioWidth),
      ratioHeight: ratio(info.ratioHeight),
      background: /^#[0-9A-F]{6}$/i.test(info.background) ? info.background.toUpperCase() : "#FFFFFF",
      title: text(info.title, 200),
      baseName: text(info.baseName, 200),
      url: text(info.url, 1 << 20),
      contentType: SVG_TYPE,
      markup: info.kind == "inline" ? text(info.markup, 64 << 20) : null,
    };
    if (info.kind == "inline" ? !clean.markup : !clean.url) {
      return null;
    }
    return clean;
  },

  failed(win) {
    win.gZenUIManager?.showToast?.("whimsy-svg-save-failed-toast");
  },

  storedBackground() {
    const value = Services.prefs.getStringPref(BACKGROUND_PREF, "clear");
    return BACKGROUNDS.includes(value) ? value : "clear";
  },

  /** The dialog. Returns its parts (tests drive it). */
  open(win, info, ctx) {
    const S = lazy.WhimsySurface;
    const doc = win.document;
    const el = (tag, className) => {
      const node = doc.createElementNS(XHTML, tag);
      if (className) {
        node.className = className;
      }
      return node;
    };
    const ratio = {
      width: info.ratioWidth > 0 ? info.ratioWidth : info.width,
      height: info.ratioHeight > 0 ? info.ratioHeight : info.height,
    };
    const state = { format: "svg", background: this.storedBackground() };
    let formatSeg = null;
    const parts = S.create(win, {
      id: PANEL_ID,
      width: 320,
      titleL10nId: "whimsy-svg-save-title",
      footer: true,
      className: "whimsy-svg-save",
      // The checked Format segment (SVG: the dialog always opens on it).
      initialFocus: () => formatSeg.buttons.find(b => b.getAttribute("aria-checked") == "true"),
    });
    const { panel } = parts;

    // Format.
    const formatSection = el("div", "whimsy-svg-save-section");
    const formatCaption = S.caption(doc, { l10nId: "whimsy-svg-save-format", id: `${PANEL_ID}-format` });
    formatSeg = S.seg(doc, {
      name: "format",
      options: [
        { value: "svg", l10nId: "whimsy-svg-save-format-svg", id: `${PANEL_ID}-format-svg` },
        { value: "png", l10nId: "whimsy-svg-save-format-png", id: `${PANEL_ID}-format-png` },
        { value: "jpg", l10nId: "whimsy-svg-save-format-jpg", id: `${PANEL_ID}-format-jpg` },
      ],
      onPick: value => {
        state.format = value;
        render();
      },
    });
    formatSeg.group.setAttribute("aria-labelledby", formatCaption.label.id);
    formatSection.append(formatCaption.caption, formatSeg.group);

    // Background, with the page colour beside its caption when picked.
    const backgroundSection = el("div", "whimsy-svg-save-section");
    const backgroundCaption = S.caption(doc, { l10nId: "whimsy-svg-save-background", id: `${PANEL_ID}-background`, detail: "" });
    const pageDetail = backgroundCaption.detail;
    pageDetail.id = `${PANEL_ID}-page-color`;
    const backgroundSeg = S.seg(doc, {
      name: "background",
      options: [
        { value: "clear", l10nId: "whimsy-svg-save-background-clear", id: `${PANEL_ID}-background-clear` },
        { value: "white", l10nId: "whimsy-svg-save-background-white", id: `${PANEL_ID}-background-white` },
        { value: "page", l10nId: "whimsy-svg-save-background-page", id: `${PANEL_ID}-background-page` },
      ],
      onPick: value => {
        state.background = value;
        Services.prefs.setStringPref(BACKGROUND_PREF, value);
        render();
      },
    });
    backgroundSeg.group.setAttribute("aria-labelledby", backgroundCaption.label.id);
    backgroundSection.append(backgroundCaption.caption, backgroundSeg.group);
    const clearButton = backgroundSeg.buttons[0];

    // Size: Width, the locked-proportions mark, Height; the note below.
    const sizeSection = el("div", "whimsy-svg-save-section");
    const sizeCaption = S.caption(doc, { l10nId: "whimsy-svg-save-size", id: `${PANEL_ID}-size` });
    const fields = el("div", "whimsy-svg-save-fields");
    fields.setAttribute("role", "group");
    fields.setAttribute("aria-labelledby", sizeCaption.label.id);
    const note = el("div", "whimsy-svg-save-note");
    note.id = `${PANEL_ID}-note`;
    note.setAttribute("aria-live", "polite");
    const field = (side, l10nId, value) => {
      const label = el("label", "whimsy-surface-search whimsy-svg-save-field");
      const name = el("span", "whimsy-svg-save-field-label");
      doc.l10n.setAttributes(name, l10nId);
      const input = el("input");
      input.id = `${PANEL_ID}-${side}`;
      input.type = "text";
      input.setAttribute("inputmode", "numeric");
      input.setAttribute("autocomplete", "off");
      input.setAttribute("spellcheck", "false");
      input.setAttribute("aria-describedby", note.id);
      input.value = String(value);
      const unit = el("span", "whimsy-svg-save-field-unit");
      doc.l10n.setAttributes(unit, "whimsy-svg-save-px");
      label.append(name, input, unit);
      return { label, input };
    };
    const widthField = field("width", "whimsy-svg-save-width", info.width);
    const heightField = field("height", "whimsy-svg-save-height", info.height);
    const link = el("span", "whimsy-svg-save-link");
    link.setAttribute("role", "img");
    doc.l10n.setAttributes(link, "whimsy-svg-save-locked");
    const icon = doc.createElementNS(SVG_NS, "svg");
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.5");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.setAttribute("aria-hidden", "true");
    for (const d of ["M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2.4-2.4a2.6 2.6 0 0 0-3.7-3.7l-.8.8", "M9.4 6.6a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.8-.8"]) {
      const path = doc.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      icon.append(path);
    }
    link.append(icon);
    fields.append(widthField.label, link, heightField.label);
    sizeSection.append(sizeCaption.caption, fields, note);

    const W = widthField.input;
    const H = heightField.input;
    const num = input => {
      const n = parseInt(input.value.replace(/[^\d]/g, ""), 10);
      return Number.isFinite(n) ? n : 0;
    };
    const sizeOk = () => num(W) >= 1 && num(H) >= 1;
    let saveButton = null;
    const updateSave = () => {
      saveButton.disabled = state.format != "svg" && !sizeOk();
    };
    const clearNote = () => {
      note.classList.remove("whimsy-svg-save-warn");
      note.removeAttribute("data-l10n-id");
      note.removeAttribute("data-l10n-args");
      note.textContent = "";
    };
    // Typing one side sets the other, rounded, at least 1.
    const sync = source => {
      const digits = source.value.replace(/[^\d]/g, "");
      if (digits != source.value) {
        source.value = digits;
      }
      const value = num(source);
      const other = source == W ? H : W;
      if (value > 0) {
        const follows = source == W ? (value * ratio.height) / ratio.width : (value * ratio.width) / ratio.height;
        other.value = String(Math.max(1, Math.round(follows)));
      } else {
        other.value = "";
      }
      clearNote();
      updateSave();
    };
    // Too large: shrinks, proportions kept, and says so in amber.
    const enforce = () => {
      const clamped = clampSize(num(W), num(H), ratio.width, ratio.height);
      if (clamped) {
        W.value = String(clamped.width);
        H.value = String(clamped.height);
        note.classList.add("whimsy-svg-save-warn");
        doc.l10n.setAttributes(note, "whimsy-svg-save-reduced", { width: clamped.width, height: clamped.height });
      }
      return clamped;
    };
    for (const input of [W, H]) {
      input.addEventListener("input", () => sync(input));
      input.addEventListener("blur", enforce);
      input.addEventListener("focus", () => input.select());
    }

    const render = () => {
      // SVG saves the original file: Background and Size step aside,
      // dimmed and disabled but in place, so nothing moves.
      const vector = state.format == "svg";
      // JPG can't be clear: Clear turns off, and a clear choice becomes White.
      if (state.format == "jpg" && state.background == "clear") {
        state.background = "white";
      }
      backgroundSection.classList.toggle("whimsy-svg-save-off", vector);
      sizeSection.classList.toggle("whimsy-svg-save-off", vector);
      backgroundSeg.setDisabled(vector);
      clearButton.disabled = vector || state.format == "jpg";
      if (state.format == "jpg") {
        doc.l10n.setAttributes(clearButton, "whimsy-svg-save-clear-jpg");
      } else {
        clearButton.removeAttribute("data-l10n-id");
        clearButton.removeAttribute("title");
      }
      W.disabled = H.disabled = vector;
      formatSeg.select(state.format);
      backgroundSeg.select(state.background);
      pageDetail.replaceChildren();
      if (state.background == "page") {
        const dot = el("span", "whimsy-svg-save-dot");
        dot.style.backgroundColor = info.background;
        const text = el("span");
        doc.l10n.setAttributes(text, "whimsy-svg-save-page-color", { color: info.background });
        pageDetail.append(dot, text);
      }
      updateSave();
    };

    const save = async () => {
      if (state.format != "svg") {
        enforce();
        updateSave();
        if (saveButton.disabled) {
          return;
        }
      }
      const choice = {
        format: state.format,
        background: state.background,
        width: num(W),
        height: num(H),
      };
      S.close(panel);
      await this.save(win, info, ctx, choice);
    };

    parts.view.append(formatSection, backgroundSection, sizeSection);
    saveButton = S.footerButton(doc, { l10nId: "whimsy-svg-save-save", primary: true, id: `${PANEL_ID}-save`, onCommand: save });
    parts.footer.append(
      S.footerButton(doc, { l10nId: "whimsy-svg-save-cancel", id: `${PANEL_ID}-cancel`, onCommand: () => S.close(panel) }),
      saveButton
    );
    // Enter saves from anywhere but the footer's buttons (they run their
    // own command); Esc cancels (WhimsySurface).
    panel.addEventListener("keydown", event => {
      if (
        event.key != "Enter" || event.defaultPrevented ||
        event.shiftKey || event.ctrlKey || event.altKey || event.metaKey ||
        event.target.closest?.(".whimsy-surface-footer")
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      save();
    });
    render();
    S.finish(parts);
    S.open(win, panel, { at: "page-top-center" });
    this._dialog = { ...parts, state, info, ctx, formatSeg, backgroundSeg, width: W, height: H, note, saveButton, pageDetail, save, render };
    return this._dialog;
  },

  async save(win, info, ctx, choice) {
    try {
      if (choice.format == "svg") {
        await this.saveOriginal(win, info, ctx);
        return true;
      }
      const format = FORMATS[choice.format];
      const background = choice.format == "png" && choice.background == "clear" ? null :
        choice.background == "page" ? info.background : "#FFFFFF";
      const bytes = await ctx.frame.currentWindowGlobal.getActor(ACTOR).sendQuery("WhimsySvgSave:Render", {
        target: ctx.target,
        width: choice.width,
        height: choice.height,
        background,
        type: format.type,
      });
      if (!bytes?.byteLength) {
        throw new Error("Nothing drawn");
      }
      const blob = new Blob([bytes], { type: format.type });
      return await lazy.WhimsyCaptureCard.download(win, blob, { browser: ctx.browser, private: ctx.isPrivate }, {
        filename: fileNameFor(info, format.ext),
        contentType: format.type,
      });
    } catch (e) {
      console.error("Whimsy: svg-save", e);
      this.failed(win);
      return false;
    }
  },

  // SVG: the original file. An <img>'s or an SVG document's is saved from
  // its address as Firefox's Save Image As does (same principal, referrer
  // and cookies), except that it follows the download setting; an inline
  // one is written from its markup.
  async saveOriginal(win, info, ctx) {
    const filename = fileNameFor(info, "svg");
    if (info.kind == "inline") {
      const blob = new Blob([info.markup], { type: SVG_TYPE });
      const ok = await lazy.WhimsyCaptureCard.download(win, blob, { browser: ctx.browser, private: ctx.isPrivate }, {
        filename,
        contentType: SVG_TYPE,
      });
      return ok;
    }
    win.urlSecurityCheck(info.url, ctx.principal);
    win.internalSave(
      info.url,
      null, // originalURL
      null, // document
      filename, // used when the address has no file name
      ctx.contentDisposition,
      info.contentType || SVG_TYPE,
      false, // do not bypass the cache
      "SaveImageTitle",
      null, // chosen data
      ctx.referrerInfo,
      ctx.cookieJarSettings,
      null, // initiating doc
      true, // follow the download setting (ask, or the Downloads folder)
      null, // cache key
      ctx.isPrivate,
      ctx.principal
    );
    return true;
  },
};
