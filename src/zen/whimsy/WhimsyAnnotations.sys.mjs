/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  JSONFile: "resource://gre/modules/JSONFile.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyMenuPrefs: "resource:///modules/whimsy/WhimsyMenuPrefs.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyNotes: "resource:///modules/whimsy/WhimsyNotesSection.sys.mjs",
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
  WhimsyUndo: "resource:///modules/whimsy/WhimsyUndo.sys.mjs",
  WhimsyVerbs: "resource:///modules/whimsy/WhimsyVerbs.sys.mjs",
  gWhimsyNotesStore: "resource:///modules/whimsy/WhimsyNotesSection.sys.mjs",
});

const PREF_ENABLED = "whimsy.feature.annotations";
const PREF_COLOR = "whimsy.annotations.color";
const PREF_PEN_WIDTH = "whimsy.annotations.pen-width";
const PREF_PEN_HINT_SHOWN = "whimsy.annotations.pen-hint-shown";
const STORE_FILENAME = "whimsy-annotations.json";
const BUTTON_ID = "whimsy-annotations-button";
const POPOVER_ID = "whimsy-annotation-popover";
const PAGE_PANEL_ID = "whimsy-annotations-page-panel";
const PEN_BAR_ID = "whimsy-annotations-pen-bar";
const PEN_HINT_ID = "whimsy-annotations-pen-hint";
const CTX_HIGHLIGHT_ID = "context-whimsy-highlight";
const CTX_ADD_NOTE_ID = "context-whimsy-add-note";
const CTX_DRAW_ID = "context-whimsy-draw";
const CTX_SEP_ID = "context-whimsy-annotations-separator";
const SVG_NS = "http://www.w3.org/2000/svg";

export const ANNOTATION_COLORS = Object.freeze([
  "yellow",
  "green",
  "blue",
  "pink",
]);

export const PEN_WIDTHS = Object.freeze(["thin", "thick"]);

const COLOR_LABELS = Object.freeze({
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  pink: "Pink",
});


export class WhimsyAnnotationsParent extends JSWindowActorParent {
  receiveMessage(message) {
    const browser = this.browsingContext?.top?.embedderElement;
    const win = browser?.documentGlobal;
    if (!browser || !win) {
      return null;
    }
    switch (message.name) {
      case "WhimsyAnnotations:PageReady":
        WhimsyAnnotations.restoreForBrowser(browser, message.data);
        break;
      case "WhimsyAnnotations:ClickHighlight":
        if (message.data?.id) {
          WhimsyAnnotations.openHighlightPopover(win, {
            browser,
            highlightId: message.data.id,
            rect: message.data.rect,
          });
        }
        break;
      case "WhimsyAnnotations:PenStrokeAdded":
        if (message.data?.stroke) {
          WhimsyAnnotations._onActorStrokeAdded(win, browser, message.data);
        }
        break;
      case "WhimsyAnnotations:PenStrokeErased":
        if (message.data?.strokeId) {
          WhimsyAnnotations._onActorStrokeErased(win, browser, message.data);
        }
        break;
    }
    return null;
  }
}

class AnnotationsStore {
  #file = null;
  #loaded = false;
  #loadPromise = null;

  #ensureFile() {
    if (!this.#file) {
      const path = PathUtils.join(PathUtils.profileDir, STORE_FILENAME);
      this.#file = new lazy.JSONFile({
        path,
        dataPostProcessor: data => {
          if (!data || typeof data !== "object") {
            return { version: 1, pages: {} };
          }
          if (!data.pages || typeof data.pages !== "object") {
            data.pages = {};
          }
          data.version = 1;
          return data;
        },
      });
    }
    return this.#file;
  }

  async ensureLoaded() {
    if (this.#loaded) {
      return this.#ensureFile().data;
    }
    if (!this.#loadPromise) {
      this.#loadPromise = (async () => {
        const file = this.#ensureFile();
        try {
          await file.load();
        } catch {
          file.data = { version: 1, pages: {} };
        }
        this.#loaded = true;
        return file.data;
      })();
    }
    return this.#loadPromise;
  }

  get dataSync() {
    const file = this.#ensureFile();
    if (!this.#loaded) {
      try {
        file.ensureDataReady();
      } catch {
        file.data = { version: 1, pages: {} };
      }
      this.#loaded = true;
    }
    if (!file.data || typeof file.data !== "object") {
      file.data = { version: 1, pages: {} };
    }
    if (!file.data.pages || typeof file.data.pages !== "object") {
      file.data.pages = {};
    }
    return file.data;
  }

  saveSoon() {
    try {
      this.#ensureFile().saveSoon();
    } catch {}
  }

  async flush() {
    if (!this.#file) {
      return;
    }
    try {
      await this.#file._save();
    } catch {}
  }
}

const gStore = new AnnotationsStore();

export const WhimsyAnnotations = {
  _initialized: false,
  _windows: new WeakSet(),
  _anchoredByBrowser: new WeakMap(),
  _penSessions: new WeakMap(),

  COLORS: ANNOTATION_COLORS,
  PEN_WIDTHS,

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    XPCOMUtils.defineLazyPreferenceGetter(
      this,
      "_enabledPref",
      PREF_ENABLED,
      true,
      () => this._onEnabledChanged()
    );

    gStore.ensureLoaded().catch(() => {});
    this._registerVerbs();
  },

  uninit() {
    this._initialized = false;
  },

  get enabled() {
    try {
      return Services.prefs.getBoolPref(PREF_ENABLED, true);
    } catch {
      return true;
    }
  },

  get lastColor() {
    try {
      const c = Services.prefs.getStringPref(PREF_COLOR, "yellow");
      return ANNOTATION_COLORS.includes(c) ? c : "yellow";
    } catch {
      return "yellow";
    }
  },

  set lastColor(color) {
    if (ANNOTATION_COLORS.includes(color)) {
      try {
        Services.prefs.setStringPref(PREF_COLOR, color);
      } catch {}
    }
  },

  normalizeColor(color) {
    return ANNOTATION_COLORS.includes(color) ? color : this.lastColor;
  },

  get lastPenWidth() {
    try {
      const w = Services.prefs.getStringPref(PREF_PEN_WIDTH, "thin");
      return PEN_WIDTHS.includes(w) ? w : "thin";
    } catch {
      return "thin";
    }
  },

  set lastPenWidth(width) {
    if (PEN_WIDTHS.includes(width)) {
      try {
        Services.prefs.setStringPref(PREF_PEN_WIDTH, width);
      } catch {}
    }
  },

  normalizePenWidth(width) {
    return PEN_WIDTHS.includes(width) ? width : this.lastPenWidth;
  },

  normalizeURL(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") {
      return null;
    }
    const trimmed = rawUrl.trim();
    if (
      !trimmed ||
      trimmed.startsWith("about:") ||
      trimmed.startsWith("chrome:") ||
      trimmed.startsWith("moz-extension:") ||
      trimmed.startsWith("javascript:") ||
      trimmed.startsWith("view-source:") ||
      trimmed.startsWith("blob:")
    ) {
      return null;
    }
    try {
      const u = new URL(trimmed);
      if (!["http:", "https:", "file:", "data:"].includes(u.protocol)) {
        return null;
      }
      if (u.protocol === "data:") {
        return trimmed;
      }
      u.hash = "";
      return u.href;
    } catch {
      return null;
    }
  },

  isPrivate(win, browser = win?.gBrowser?.selectedBrowser) {
    if (!win) {
      return true;
    }
    try {
      if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
        return true;
      }
    } catch {}
    try {
      if (browser && lazy.PrivateBrowsingUtils.isBrowserPrivate(browser)) {
        return true;
      }
    } catch {}
    try {
      const tab = browser
        ? win.gBrowser?.getTabForBrowser?.(browser)
        : win.gBrowser?.selectedTab;
      if (tab && lazy.WhimsyPrivate.isPrivateTab(tab)) {
        return true;
      }
    } catch {}
    return false;
  },

  canAnnotate(win, browser = win?.gBrowser?.selectedBrowser) {
    if (!this.enabled || !win || !browser) {
      return false;
    }
    if (this.isPrivate(win, browser)) {
      return false;
    }
    const spec = browser.currentURI?.spec || "";
    return Boolean(this.normalizeURL(spec));
  },

  _profileKeyForWindow(win) {
    try {
      return (
        win?.gZenWorkspaces?.activeWorkspace ||
        Services.prefs.getStringPref("whimsy.profile.current", "default") ||
        "default"
      );
    } catch {
      return "default";
    }
  },

  _onEnabledChanged() {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (!win.closed) {
        if (!this.enabled && this.isPenActive(win)) {
          this.stopPen(win, { immediate: true });
        }
        this.updateUrlbarButton(win);
        if (win.gBrowser?.selectedBrowser) {
          this.restoreForBrowser(win.gBrowser.selectedBrowser);
        }
      }
    }
  },

  _registerVerbs() {
    try {
      lazy.WhimsyVerbs.registerVerb({
        id: "highlight",
        l10nId: "whimsy-verb-highlight",
        scope: "selection",
        when: win => this.canAnnotate(win),
        run: (win, subject) => {
          const color = this.normalizeColor(subject?.color || this.lastColor);
          return this.highlightSelection(win, { color, subject });
        },
      });

      for (const color of ANNOTATION_COLORS) {
        lazy.WhimsyVerbs.registerVerb({
          id: `highlight-${color}`,
          l10nId: `whimsy-verb-highlight-${color}`,
          scope: "selection",
          when: win => {
            if (!this.canAnnotate(win)) {
              return false;
            }
            // Show color-specific verbs when the user filters in ⌘K or invokes runVerb directly.
            const urlbar = win?.gURLBar;
            if (urlbar?.view?.isOpen) {
              const q = String(urlbar.value || "").trim().toLowerCase();
              if (!q) {
                return false;
              }
            }
            return true;
          },
          run: (win, subject) => {
            return this.highlightSelection(win, { color, subject });
          },
        });
      }

      lazy.WhimsyVerbs.registerVerb({
        id: "annotate",
        l10nId: "whimsy-verb-annotate",
        scope: "selection",
        when: win => {
          if (!this.canAnnotate(win)) {
            return false;
          }
          const urlbar = win?.gURLBar;
          if (urlbar?.view?.isOpen) {
            const q = String(urlbar.value || "").trim().toLowerCase();
            if (!q) {
              return false;
            }
          }
          return true;
        },
        run: (win, subject) => {
          return this.openAddNoteForSelection(win, { subject });
        },
      });

      lazy.WhimsyVerbs.registerVerb({
        id: "draw",
        l10nId: "whimsy-verb-draw",
        icon: "chrome://browser/content/whimsy/icons/pencil.svg",
        scope: "both",
        group: "page",
        when: win => this.canAnnotate(win),
        isAvailable: (win, subject, view) => {
          if (!this.canAnnotate(win)) {
            return false;
          }
          const session = lazy.WhimsyVerbs.sessions?.get?.(win);
          if (session && !session.groups && !view) {
            const q = String(win?.gURLBar?.value || "").trim();
            if (!q) {
              return false;
            }
          }
          return true;
        },
        run: win => {
          return this.startPen(win);
        },
      });
    } catch {}
  },

  initWindow(win) {
    if (!win?.document || this._windows.has(win)) {
      return;
    }
    this._windows.add(win);

    this._ensureContextMenu(win);
    this._ensureUrlbarButton(win);
    // The way to the Notes and highlights panel: the approved address-bar
    // cue opens the page's note in Notes (gen-w24.py 2.4, 2.6), so the panel
    // that edits this page's note and highlights is a command-bar action,
    // offered while the page has any.
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyAnnotationsPanel",
      l10nId: "whimsy-annotations-cmd-panel",
      icon: "chrome://browser/content/whimsy/icons/highlighter.svg",
      key: null,
      isAvailable: w => !w.document.getElementById(BUTTON_ID)?.hidden,
      run: w => this.openPagePanel(w),
    });

    const onTabSelect = () => {
      if (this.isPenActive(win)) {
        this.stopPen(win, { immediate: true });
      }
      this.updateUrlbarButton(win);
      const browser = win.gBrowser?.selectedBrowser;
      if (browser) {
        this.restoreForBrowser(browser);
      }
    };
    const progressListener = {
      QueryInterface: ChromeUtils.generateQI([
        "nsIWebProgressListener",
        "nsISupportsWeakReference",
      ]),
      onLocationChange: (aWebProgress, _aRequest, _aLocation, aFlags) => {
        if (!aWebProgress?.isTopLevel) {
          return;
        }
        const sameDoc = Boolean(
          aFlags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT
        );
        if (!sameDoc && this.isPenActive(win)) {
          this.stopPen(win, { immediate: true });
        }
        this.updateUrlbarButton(win);
        const browser = win.gBrowser?.selectedBrowser;
        if (browser) {
          this.restoreForBrowser(browser);
        }
      },
    };

    win.gBrowser?.tabContainer?.addEventListener("TabSelect", onTabSelect);
    try {
      win.gBrowser?.addProgressListener(progressListener);
    } catch {}

    win.addEventListener(
      "unload",
      () => {
        win.gBrowser?.tabContainer?.removeEventListener("TabSelect", onTabSelect);
        try {
          win.gBrowser?.removeProgressListener(progressListener);
        } catch {}
      },
      { once: true }
    );

    this.updateUrlbarButton(win);
    if (win.gBrowser?.selectedBrowser) {
      this.restoreForBrowser(win.gBrowser.selectedBrowser);
    }
  },

  _ensureContextMenu(win) {
    const doc = win.document;
    const menu = doc.getElementById("contentAreaContextMenu");
    if (!menu || doc.getElementById(CTX_HIGHLIGHT_ID)) {
      return;
    }

    const hlItem = doc.createXULElement("menuitem");
    hlItem.id = CTX_HIGHLIGHT_ID;
    hlItem.className = "menuitem-iconic";
    hlItem.setAttribute("data-l10n-id", "whimsy-annotations-context-highlight");
    hlItem.setAttribute("label", "Highlight");
    hlItem.hidden = true;
    hlItem.addEventListener("command", () => {
      this.highlightSelection(win, { color: this.lastColor });
    });

    const noteItem = doc.createXULElement("menuitem");
    noteItem.id = CTX_ADD_NOTE_ID;
    noteItem.className = "menuitem-iconic";
    noteItem.setAttribute("data-l10n-id", "whimsy-annotations-context-add-note");
    noteItem.setAttribute("label", "Add Note…");
    noteItem.hidden = true;
    noteItem.addEventListener("command", () => {
      this.openAddNoteForSelection(win);
    });

    const drawItem = doc.createXULElement("menuitem");
    drawItem.id = CTX_DRAW_ID;
    drawItem.className = "menuitem-iconic";
    drawItem.setAttribute("data-l10n-id", "whimsy-annotations-context-draw");
    drawItem.setAttribute("label", "Draw on Page");
    drawItem.hidden = true;
    drawItem.addEventListener("command", () => {
      this.startPen(win);
    });

    const sep = doc.createXULElement("menuseparator");
    sep.id = CTX_SEP_ID;
    sep.hidden = true;

    const anchor =
      doc.getElementById("context-whimsy-verb-note") ||
      doc.getElementById("context-copy") ||
      menu.firstElementChild;
    if (anchor) {
      menu.insertBefore(hlItem, anchor);
      menu.insertBefore(noteItem, anchor);
      menu.insertBefore(drawItem, anchor);
      menu.insertBefore(sep, anchor);
    } else {
      menu.append(hlItem, noteItem, drawItem, sep);
    }

    menu.addEventListener("popupshowing", event => {
      if (event.target !== menu) {
        return;
      }
      const show = this._shouldShowContextItems(win);
      const showDraw = this._shouldShowDrawContextItem(win);
      hlItem.hidden = !show;
      noteItem.hidden = !show;
      drawItem.hidden = !showDraw;
      sep.hidden = true;
    });
  },

  _shouldShowDrawContextItem(win) {
    if (!this.canAnnotate(win)) {
      return false;
    }
    const cm = win.gContextMenu;
    if (cm) {
      if (
        cm.onTextInput ||
        cm.onEditable ||
        cm.onPassword ||
        cm.onImage ||
        cm.onCanvas ||
        cm.onVideo ||
        cm.onAudio ||
        cm.onLink
      ) {
        return false;
      }
    }
    return true;
  },

  _shouldShowContextItems(win) {
    if (!this.canAnnotate(win)) {
      return false;
    }
    const cm = win.gContextMenu;
    if (cm) {
      if (
        cm.onTextInput ||
        cm.onEditable ||
        cm.onPassword ||
        cm.inFrame && false
      ) {
        return false;
      }
      if (cm.isTextSelected) {
        return Boolean(String(cm.selectionInfo?.fullText || cm.selectionInfo?.text || "x").trim());
      }
    }
    return false;
  },

  _ensureUrlbarButton(win) {
    const doc = win.document;
    if (doc.getElementById(BUTTON_ID)) {
      return;
    }
    const container =
      doc.getElementById("page-action-buttons") ||
      doc.querySelector(".urlbar-input-box")?.parentElement;
    if (!container) {
      return;
    }

    // A page-action sibling (Reader, Translate): an .urlbar-icon image
    // from an icon file, plus the count, on the approved yellow pill
    // (whimsy-browser.css). It's a state cue, so it shows whenever the page
    // has annotations; clicking it opens the page's note in Notes.
    const btn = doc.createXULElement("hbox");
    btn.id = BUTTON_ID;
    btn.className = "urlbar-page-action whimsy-smart-button";
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    btn.setAttribute("align", "center");
    doc.l10n.setAttributes(btn, "whimsy-annotations-urlbar-button", { count: 0 });
    btn.hidden = true;

    const icon = doc.createXULElement("image");
    icon.className = "urlbar-icon";
    const countEl = doc.createXULElement("label");
    countEl.className = "whimsy-annotations-button-count";
    countEl.setAttribute("value", "0");
    btn.append(icon, countEl);

    const activate = event => {
      if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") {
        return;
      }
      if (event.type === "click" && event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.openInNotes(win);
    };
    btn.addEventListener("click", activate);
    btn.addEventListener("keydown", activate);

    const starBox = doc.getElementById("star-button-box");
    if (starBox && starBox.parentNode === container) {
      container.insertBefore(btn, starBox);
    } else {
      container.appendChild(btn);
    }
  },

  getPageRecord(rawUrl, { win = null, browser = null } = {}) {
    if (win && this.isPrivate(win, browser)) {
      return null;
    }
    const normUrl = this.normalizeURL(rawUrl);
    if (!normUrl) {
      return null;
    }
    const data = gStore.dataSync;
    // Async restore/panel entry points refresh this cached record from Notes.
    const rec = data.pages[normUrl] || null;
    if (rec && !Array.isArray(rec.drawings)) {
      rec.drawings = [];
    }
    return rec;
  },

  getHighlights(rawUrl, opts = {}) {
    const rec = this.getPageRecord(rawUrl, opts);
    if (!rec || !Array.isArray(rec.highlights)) {
      return [];
    }
    return rec.highlights.map(h => ({ ...h }));
  },

  getDrawings(rawUrl, opts = {}) {
    const rec = this.getPageRecord(rawUrl, opts);
    if (!rec || !Array.isArray(rec.drawings)) {
      return [];
    }
    return rec.drawings.map(d => ({
      ...d,
      points: Array.isArray(d.points) ? d.points.map(pt => [pt[0], pt[1]]) : [],
    }));
  },

  getPageNote(rawUrl, opts = {}) {
    const rec = this.getPageRecord(rawUrl, opts);
    return String(rec?.note || "");
  },

  _ensurePageRecord(normUrl, { title = "", profileKey = "default" } = {}) {
    const data = gStore.dataSync;
    let rec = data.pages[normUrl];
    const now = Date.now();
    if (!rec) {
      rec = {
        url: normUrl,
        title: title || normUrl,
        note: "",
        noteId: null,
        noteUpdatedAt: 0,
        createdAt: now,
        updatedAt: now,
        profileKey: profileKey || "default",
        highlights: [],
        drawings: [],
      };
      data.pages[normUrl] = rec;
    } else {
      if (title && (!rec.title || rec.title === normUrl)) {
        rec.title = title;
      }
      if (profileKey) {
        rec.profileKey = profileKey;
      }
      if (!Array.isArray(rec.highlights)) {
        rec.highlights = [];
      }
      if (!Array.isArray(rec.drawings)) {
        rec.drawings = [];
      }
    }
    return rec;
  },

  _pruneIfEmpty(normUrl) {
    const data = gStore.dataSync;
    const rec = data.pages[normUrl];
    if (!rec) {
      return;
    }
    const hasHighlights = Array.isArray(rec.highlights) && rec.highlights.length > 0;
    const hasNote = Boolean(rec.note && String(rec.note).trim());
    const hasDrawings = Array.isArray(rec.drawings) && rec.drawings.length > 0;
    if (!hasHighlights && !hasNote && !hasDrawings) {
      delete data.pages[normUrl];
    }
  },

  _sanitizeDrawingStroke(stroke, fallbackGroupId = "") {
    if (!stroke || !Array.isArray(stroke.points)) {
      return null;
    }
    const roundHalf = v => Math.round((Number(v) || 0) * 2) / 2;
    const points = [];
    for (const pt of stroke.points) {
      if (!Array.isArray(pt) || pt.length < 2) {
        continue;
      }
      const x = roundHalf(pt[0]);
      const y = roundHalf(pt[1]);
      if (points.length) {
        const [px, py] = points[points.length - 1];
        if (Math.hypot(x - px, y - py) < 1) {
          continue;
        }
      }
      points.push([x, y]);
    }
    if (points.length < 2) {
      return null;
    }
    const now = Date.now();
    const id =
      String(stroke.id || "") ||
      globalThis.crypto?.randomUUID?.() ||
      `drw-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const groupId = String(stroke.groupId || fallbackGroupId || id);
    const color = ANNOTATION_COLORS.includes(stroke.color)
      ? stroke.color
      : this.lastColor;
    const width = stroke.width === "thick" ? "thick" : "thin";
    const layoutWidth = Math.max(0, Math.round(Number(stroke.layoutWidth) || 0));
    const createdAt = Number(stroke.createdAt) || now;
    return {
      id,
      groupId,
      color,
      width,
      layoutWidth,
      points,
      createdAt,
    };
  },

  _drawingGroupsForRecord(rec) {
    const drawings = Array.isArray(rec?.drawings) ? rec.drawings : [];
    if (!drawings.length) {
      return [];
    }
    const byGroup = new Map();
    for (const d of drawings) {
      if (!d || !Array.isArray(d.points) || d.points.length < 2) {
        continue;
      }
      const gid = String(d.groupId || d.id || "");
      let group = byGroup.get(gid);
      if (!group) {
        group = { groupId: gid, strokes: [] };
        byGroup.set(gid, group);
      }
      group.strokes.push(d);
    }
    return [...byGroup.values()];
  },

  _drawingCountForRecord(rec) {
    return this._drawingGroupsForRecord(rec).length;
  },

  async addDrawingStroke(
    rawUrl,
    stroke,
    { win = null, browser = null, title = "", groupId = "", renderContent = false } = {}
  ) {
    if (win && this.isPrivate(win, browser)) {
      return null;
    }
    const normUrl = this.normalizeURL(rawUrl);
    if (!normUrl) {
      return null;
    }
    const clean = this._sanitizeDrawingStroke(stroke, groupId);
    if (!clean) {
      return null;
    }
    await gStore.ensureLoaded();
    const profileKey = this._profileKeyForWindow(win);
    const pageTitle =
      title ||
      browser?.contentTitle ||
      win?.gBrowser?.selectedBrowser?.contentTitle ||
      normUrl;
    const rec = this._ensurePageRecord(normUrl, {
      title: pageTitle,
      profileKey,
    });
    const existingIdx = rec.drawings.findIndex(d => d.id === clean.id);
    if (existingIdx !== -1) {
      rec.drawings[existingIdx] = clean;
    } else {
      rec.drawings.push(clean);
    }
    rec.updatedAt = Date.now();
    gStore.saveSoon();

    await this._refreshWindowsForUrl(normUrl, { renderContent });
    return { ...clean, points: clean.points.map(p => [p[0], p[1]]) };
  },

  async removeDrawingStroke(
    rawUrl,
    strokeId,
    { win = null, browser = null, renderContent = false } = {}
  ) {
    if (win && this.isPrivate(win, browser)) {
      return null;
    }
    const normUrl = this.normalizeURL(rawUrl);
    if (!normUrl || !strokeId) {
      return null;
    }
    await gStore.ensureLoaded();
    const rec = gStore.dataSync.pages[normUrl];
    if (!rec || !Array.isArray(rec.drawings)) {
      return null;
    }
    const idx = rec.drawings.findIndex(d => d.id === strokeId);
    if (idx === -1) {
      return null;
    }
    const [removed] = rec.drawings.splice(idx, 1);
    rec.updatedAt = Date.now();
    this._pruneIfEmpty(normUrl);
    gStore.saveSoon();

    await this._refreshWindowsForUrl(normUrl, { renderContent });
    return { stroke: removed, index: idx };
  },

  async setDrawings(
    rawUrl,
    drawings = [],
    { win = null, browser = null, title = "", renderContent = true } = {}
  ) {
    if (win && this.isPrivate(win, browser)) {
      return [];
    }
    const normUrl = this.normalizeURL(rawUrl);
    if (!normUrl) {
      return [];
    }
    await gStore.ensureLoaded();
    const cleanList = Array.isArray(drawings)
      ? drawings.map(d => this._sanitizeDrawingStroke(d)).filter(Boolean)
      : [];
    if (cleanList.length) {
      const profileKey = this._profileKeyForWindow(win);
      const pageTitle =
        title ||
        browser?.contentTitle ||
        win?.gBrowser?.selectedBrowser?.contentTitle ||
        normUrl;
      const rec = this._ensurePageRecord(normUrl, {
        title: pageTitle,
        profileKey,
      });
      rec.drawings = cleanList;
      rec.updatedAt = Date.now();
    } else if (gStore.dataSync.pages[normUrl]) {
      gStore.dataSync.pages[normUrl].drawings = [];
      gStore.dataSync.pages[normUrl].updatedAt = Date.now();
      this._pruneIfEmpty(normUrl);
    }
    gStore.saveSoon();
    await this._refreshWindowsForUrl(normUrl, { renderContent });
    return cleanList;
  },

  async clearDrawings(rawUrl, { win = null, browser = null } = {}) {
    return this.setDrawings(rawUrl, [], { win, browser, renderContent: true });
  },

  async _syncRecordFromNotesStore(rec) {
    if (!rec?.noteId) {
      return;
    }
    try {
      const noteId = rec.noteId;
      const noteText = rec.note;
      const notes = await lazy.gWhimsyNotesStore.list(rec.profileKey || "default");
      // Do not replace a page edit made while the Notes store was loading.
      if (rec.noteId !== noteId || rec.note !== noteText) {
        return;
      }
      const existing = notes.find(note => note.id === noteId);
      if (existing && typeof existing.text === "string" && existing.text !== rec.note) {
        rec.note = existing.text;
        gStore.saveSoon();
      }
    } catch {}
  },

  async _syncPageNoteToNotesStore(rec) {
    if (!rec) {
      return;
    }
    try {
      const store = lazy.gWhimsyNotesStore;
      const noteText = String(rec.note || "").trim();
      const notes = await store.list(rec.profileKey || "default");
      const existing = notes.find(n => n.id === rec.noteId) || notes.find(
        n => n.pageAttached && this.normalizeURL(n.url) === rec.url
      );

      if (!noteText) {
        if (existing) {
          await store.remove(existing.id);
        }
        rec.noteId = null;
        return;
      }

      if (existing) {
        await store.update(existing.id, {
          title: rec.title || existing.title || rec.url,
          text: rec.note,
          url: rec.url,
          pageAttached: true,
        });
        rec.noteId = existing.id;
      } else {
        const created = await store.create({
          title: rec.title || rec.url,
          text: rec.note,
          url: rec.url,
          pageAttached: true,
          profileKey: rec.profileKey || "default",
        });
        rec.noteId = created.id;
      }
    } catch {}
  },

  async setPageNote(rawUrl, noteText, { win = null, browser = null, title = "" } = {}) {
    if (win && this.isPrivate(win, browser)) {
      return null;
    }
    const normUrl = this.normalizeURL(rawUrl);
    if (!normUrl) {
      return null;
    }
    await gStore.ensureLoaded();
    const profileKey = this._profileKeyForWindow(win);
    const pageTitle =
      title ||
      browser?.contentTitle ||
      win?.gBrowser?.selectedBrowser?.contentTitle ||
      normUrl;
    const rec = this._ensurePageRecord(normUrl, {
      title: pageTitle,
      profileKey,
    });
    const clean = String(noteText || "");
    rec.note = clean;
    rec.noteUpdatedAt = Date.now();
    rec.updatedAt = rec.noteUpdatedAt;
    if (pageTitle) {
      rec.title = pageTitle;
    }

    await this._syncPageNoteToNotesStore(rec);
    this._pruneIfEmpty(normUrl);
    gStore.saveSoon();

    this._refreshWindowsForUrl(normUrl, { renderContent: false });
    return rec;
  },

  async addHighlight(
    rawUrl,
    anchor,
    { color = this.lastColor, note = "", title = "", win = null, browser = null } = {}
  ) {
    if (win && this.isPrivate(win, browser)) {
      return null;
    }
    const normUrl = this.normalizeURL(rawUrl);
    if (!normUrl || !anchor?.text || !String(anchor.text).trim()) {
      return null;
    }
    await gStore.ensureLoaded();
    const validColor = this.normalizeColor(color);
    this.lastColor = validColor;

    const profileKey = this._profileKeyForWindow(win);
    const pageTitle =
      title ||
      anchor.title ||
      browser?.contentTitle ||
      win?.gBrowser?.selectedBrowser?.contentTitle ||
      normUrl;
    const rec = this._ensurePageRecord(normUrl, {
      title: pageTitle,
      profileKey,
    });

    const now = Date.now();
    const hl = {
      id:
        globalThis.crypto?.randomUUID?.() ||
        `hl-${now}-${Math.random().toString(36).slice(2, 8)}`,
      text: String(anchor.text),
      prefix: String(anchor.prefix || "").slice(-32),
      suffix: String(anchor.suffix || "").slice(0, 32),
      startOffset: Number.isFinite(anchor.startOffset) ? anchor.startOffset : 0,
      color: validColor,
      note: String(note || ""),
      createdAt: now,
      updatedAt: now,
    };

    rec.highlights.push(hl);
    rec.highlights.sort((a, b) => (a.startOffset || 0) - (b.startOffset || 0));
    rec.updatedAt = now;
    gStore.saveSoon();

    await this._refreshWindowsForUrl(normUrl, { renderContent: true });
    return { ...hl };
  },

  async updateHighlight(rawUrl, highlightId, patch = {}, { win = null, browser = null } = {}) {
    if (win && this.isPrivate(win, browser)) {
      return null;
    }
    const normUrl = this.normalizeURL(rawUrl);
    if (!normUrl || !highlightId) {
      return null;
    }
    await gStore.ensureLoaded();
    const rec = gStore.dataSync.pages[normUrl];
    if (!rec || !Array.isArray(rec.highlights)) {
      return null;
    }
    const hl = rec.highlights.find(h => h.id === highlightId);
    if (!hl) {
      return null;
    }
    if (patch.color !== undefined && ANNOTATION_COLORS.includes(patch.color)) {
      hl.color = patch.color;
      this.lastColor = patch.color;
    }
    if (patch.note !== undefined) {
      hl.note = String(patch.note || "");
    }
    hl.updatedAt = Date.now();
    rec.updatedAt = hl.updatedAt;
    gStore.saveSoon();

    await this._refreshWindowsForUrl(normUrl, { renderContent: true });
    return { ...hl };
  },

  async removeHighlight(rawUrl, highlightId, { win = null, browser = null } = {}) {
    if (win && this.isPrivate(win, browser)) {
      return null;
    }
    const normUrl = this.normalizeURL(rawUrl);
    if (!normUrl || !highlightId) {
      return null;
    }
    await gStore.ensureLoaded();
    const rec = gStore.dataSync.pages[normUrl];
    if (!rec || !Array.isArray(rec.highlights)) {
      return null;
    }
    const idx = rec.highlights.findIndex(h => h.id === highlightId);
    if (idx === -1) {
      return null;
    }
    const [removed] = rec.highlights.splice(idx, 1);
    rec.updatedAt = Date.now();
    this._pruneIfEmpty(normUrl);
    gStore.saveSoon();

    await this._refreshWindowsForUrl(normUrl, { renderContent: true });
    return removed;
  },

  async _captureSelectionFromBrowser(browser, fallbackSubject = null) {
    if (!browser) {
      return null;
    }
    try {
      const actor = browser.browsingContext?.currentWindowGlobal?.getActor(
        "WhimsyAnnotations"
      );
      if (actor) {
        const captured = await actor.sendQuery("WhimsyAnnotations:CaptureSelection");
        if (captured?.text && String(captured.text).trim()) {
          return captured;
        }
      }
    } catch {}

    const fallbackText = String(fallbackSubject?.text || "").trim();
    if (fallbackText) {
      return {
        text: fallbackText,
        prefix: "",
        suffix: "",
        startOffset: 0,
        rect: null,
        url: browser.currentURI?.spec || "",
        title: browser.contentTitle || "",
      };
    }
    return null;
  },

  async highlightSelection(
    win,
    { color = this.lastColor, note = "", subject = null, showToast = true } = {}
  ) {
    const browser = win?.gBrowser?.selectedBrowser;
    if (!this.canAnnotate(win, browser)) {
      return null;
    }
    const captured = await this._captureSelectionFromBrowser(browser, subject);
    if (!captured) {
      return null;
    }
    const url = captured.url || browser.currentURI?.spec || "";
    const hl = await this.addHighlight(url, captured, {
      color,
      note,
      title: captured.title || browser.contentTitle || "",
      win,
      browser,
    });
    if (hl && showToast) {
      try {
        lazy.WhimsyUndo.showToast(
          win,
          "whimsy-annotations-toast-highlighted",
          {
            type: "annotation",
            undo: () => this.removeHighlight(url, hl.id, { win, browser }),
            redo: () =>
              this.addHighlight(url, captured, {
                color: hl.color,
                note: hl.note,
                win,
                browser,
              }),
          },
          { color: COLOR_LABELS[hl.color] || "Yellow" }
        );
      } catch {}
    }
    return hl;
  },

  async openAddNoteForSelection(win, { subject = null } = {}) {
    const browser = win?.gBrowser?.selectedBrowser;
    if (!this.canAnnotate(win, browser)) {
      return null;
    }
    const captured = await this._captureSelectionFromBrowser(browser, subject);
    if (!captured) {
      return null;
    }
    const url = captured.url || browser.currentURI?.spec || "";
    return this.openHighlightPopover(win, {
      browser,
      url,
      draftAnchor: captured,
      rect: captured.rect,
    });
  },

  async restoreForBrowser(browser, pageData = null) {
    const win = browser?.documentGlobal;
    if (!win || !browser) {
      return { anchoredIds: [], droppedIds: [] };
    }
    if (!this.enabled || this.isPrivate(win, browser)) {
      this._anchoredByBrowser.delete(browser);
      try {
        const actor = browser.browsingContext?.currentWindowGlobal?.getActor(
          "WhimsyAnnotations"
        );
        await actor?.sendQuery("WhimsyAnnotations:Render", {
          highlights: [],
          drawings: [],
        });
      } catch {}
      this.updateUrlbarButton(win);
      return { anchoredIds: [], droppedIds: [] };
    }

    await gStore.ensureLoaded();
    const rawUrl = pageData?.url || browser.currentURI?.spec || "";
    const normUrl = this.normalizeURL(rawUrl);
    if (!normUrl) {
      this._anchoredByBrowser.delete(browser);
      this.updateUrlbarButton(win);
      return { anchoredIds: [], droppedIds: [] };
    }

    const rec = this.getPageRecord(normUrl, { win, browser });
    await this._syncRecordFromNotesStore(rec);
    if (rec && pageData?.title && (!rec.title || rec.title === normUrl)) {
      rec.title = pageData.title;
      gStore.saveSoon();
    }
    const highlights = rec?.highlights || [];
    const drawings = rec?.drawings || [];

    let result = { anchoredIds: [], droppedIds: [] };
    try {
      const actor = browser.browsingContext?.currentWindowGlobal?.getActor(
        "WhimsyAnnotations"
      );
      if (actor) {
        const rendered = await actor.sendQuery("WhimsyAnnotations:Render", {
          highlights,
          drawings,
        });
        if (rendered && Array.isArray(rendered.anchoredIds)) {
          result = rendered;
          this._anchoredByBrowser.set(browser, new Set(rendered.anchoredIds));
        }
      }
    } catch {}

    this.updateUrlbarButton(win);
    return result;
  },

  async _refreshWindowsForUrl(normUrl, { renderContent = true } = {}) {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (win.closed || this.isPrivate(win)) {
        continue;
      }
      for (const tab of win.gBrowser?.tabs || []) {
        const browser = tab.linkedBrowser;
        if (!browser || this.isPrivate(win, browser)) {
          continue;
        }
        const tabUrl = this.normalizeURL(browser.currentURI?.spec || "");
        if (!normUrl || tabUrl === normUrl) {
          if (renderContent) {
            await this.restoreForBrowser(browser);
          } else {
            this.updateUrlbarButton(win);
          }
        }
      }
    }
  },

  _activeHighlightsForBrowser(win, browser = win?.gBrowser?.selectedBrowser) {
    if (!this.canAnnotate(win, browser)) {
      return [];
    }
    const normUrl = this.normalizeURL(browser.currentURI?.spec || "");
    if (!normUrl) {
      return [];
    }
    const rec = this.getPageRecord(normUrl, { win, browser });
    const stored = rec?.highlights || [];
    if (!stored.length) {
      return [];
    }
    const anchoredSet = this._anchoredByBrowser.get(browser);
    if (anchoredSet instanceof Set) {
      return stored.filter(h => anchoredSet.has(h.id));
    }
    return stored;
  },

  updateUrlbarButton(win) {
    const doc = win?.document;
    const btn = doc?.getElementById(BUTTON_ID);
    if (!btn) {
      return;
    }
    const browser = win.gBrowser?.selectedBrowser;
    if (!this.canAnnotate(win, browser)) {
      btn.hidden = true;
      return;
    }
    const normUrl = this.normalizeURL(browser.currentURI?.spec || "");
    if (!normUrl) {
      btn.hidden = true;
      return;
    }
    const rec = this.getPageRecord(normUrl, { win, browser });
    if (!rec) {
      btn.hidden = true;
      return;
    }
    const activeHighlights = this._activeHighlightsForBrowser(win, browser);
    const hasNote = Boolean(rec.note && String(rec.note).trim());
    const drawingCount = this._drawingCountForRecord(rec);
    const count = activeHighlights.length + (hasNote ? 1 : 0) + drawingCount;

    if (count <= 0) {
      btn.hidden = true;
      return;
    }

    btn.querySelector(".whimsy-annotations-button-count")?.setAttribute("value", String(count));
    doc.l10n.setAttributes(btn, "whimsy-annotations-urlbar-button", { count });
    btn.hidden = false;
  },

  isPenActive(win) {
    return Boolean(this._penSessions.get(win)?.active);
  },

  getPenSession(win) {
    return this._penSessions.get(win) || null;
  },

  _createPenSvgIcon(doc, pathSpecs) {
    const svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    for (const spec of pathSpecs) {
      const p = doc.createElementNS(SVG_NS, "path");
      p.setAttribute("d", spec.d);
      if (spec.strokeWidth) {
        p.setAttribute("stroke-width", String(spec.strokeWidth));
      }
      svg.appendChild(p);
    }
    return svg;
  },

  _ensurePenBar(win) {
    const doc = win.document;
    let bar = doc.getElementById(PEN_BAR_ID);
    if (bar) {
      return bar;
    }

    bar = doc.createElement("div");
    bar.id = PEN_BAR_ID;
    bar.className = "whimsy-annotations-pen-bar whimsy-surface-tokens";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("data-l10n-id", "whimsy-annotations-pen-toolbar");
    bar.setAttribute("aria-label", "Draw on page");
    bar.hidden = true;

    const swatchesWrap = doc.createElement("div");
    swatchesWrap.className = "whimsy-annotation-swatches";
    swatchesWrap.setAttribute("role", "radiogroup");
    swatchesWrap.setAttribute("aria-label", "Ink color");

    for (const c of ANNOTATION_COLORS) {
      const swatch = doc.createElement("button");
      swatch.type = "button";
      swatch.className = "whimsy-annotation-swatch whimsy-pen-swatch";
      swatch.setAttribute("role", "radio");
      swatch.setAttribute("data-color", c);
      swatch.setAttribute("data-l10n-id", `whimsy-annotations-pen-color-${c}`);
      swatch.setAttribute("aria-label", COLOR_LABELS[c]);
      swatch.setAttribute("title", COLOR_LABELS[c]);
      swatch.setAttribute("tooltiptext", COLOR_LABELS[c]);
      swatch.setAttribute("aria-checked", "false");
      swatch.addEventListener("click", () => {
        this.setPenColor(win, c);
      });
      swatchesWrap.appendChild(swatch);
    }

    const sep1 = doc.createElement("div");
    sep1.className = "whimsy-pen-sep whimsy-surface-rule";
    sep1.setAttribute("role", "separator");

    const thinBtn = doc.createElement("button");
    thinBtn.type = "button";
    thinBtn.className = "whimsy-pen-tool-btn whimsy-pen-width-btn";
    thinBtn.setAttribute("data-width", "thin");
    thinBtn.setAttribute("data-l10n-id", "whimsy-annotations-pen-thin");
    thinBtn.setAttribute("aria-label", "Thin Line");
    thinBtn.setAttribute("title", "Thin Line");
    thinBtn.setAttribute("tooltiptext", "Thin Line");
    thinBtn.setAttribute("aria-pressed", "true");
    thinBtn.appendChild(
      this._createPenSvgIcon(doc, [{ d: "M3 13L13 3", strokeWidth: 1.5 }])
    );
    thinBtn.addEventListener("click", () => {
      this.setPenWidth(win, "thin");
    });

    const thickBtn = doc.createElement("button");
    thickBtn.type = "button";
    thickBtn.className = "whimsy-pen-tool-btn whimsy-pen-width-btn";
    thickBtn.setAttribute("data-width", "thick");
    thickBtn.setAttribute("data-l10n-id", "whimsy-annotations-pen-thick");
    thickBtn.setAttribute("aria-label", "Thick Line");
    thickBtn.setAttribute("title", "Thick Line");
    thickBtn.setAttribute("tooltiptext", "Thick Line");
    thickBtn.setAttribute("aria-pressed", "false");
    thickBtn.appendChild(
      this._createPenSvgIcon(doc, [{ d: "M3 13L13 3", strokeWidth: 3.2 }])
    );
    thickBtn.addEventListener("click", () => {
      this.setPenWidth(win, "thick");
    });

    const eraserBtn = doc.createElement("button");
    eraserBtn.type = "button";
    eraserBtn.className = "whimsy-pen-tool-btn whimsy-pen-eraser-btn";
    eraserBtn.setAttribute("data-tool", "eraser");
    eraserBtn.setAttribute("data-l10n-id", "whimsy-annotations-pen-eraser");
    eraserBtn.setAttribute("aria-label", "Eraser");
    eraserBtn.setAttribute("title", "Eraser");
    eraserBtn.setAttribute("tooltiptext", "Eraser");
    eraserBtn.setAttribute("aria-pressed", "false");
    eraserBtn.appendChild(
      this._createPenSvgIcon(doc, [
        { d: "M9.5 3.5l3 3-6 6H3.5v-3zM3 12.5h10" },
      ])
    );
    eraserBtn.addEventListener("click", () => {
      const session = this._penSessions.get(win);
      const nextTool = session?.tool === "eraser" ? "pen" : "eraser";
      this.setPenTool(win, nextTool);
    });

    const sep2 = doc.createElement("div");
    sep2.className = "whimsy-pen-sep whimsy-surface-rule";
    sep2.setAttribute("role", "separator");

    const undoBtn = doc.createElement("button");
    undoBtn.type = "button";
    undoBtn.className = "whimsy-pen-tool-btn whimsy-pen-undo-btn";
    undoBtn.setAttribute("data-action", "undo");
    undoBtn.setAttribute("data-l10n-id", "whimsy-annotations-pen-undo");
    undoBtn.setAttribute("aria-label", "Undo (⌘Z)");
    undoBtn.setAttribute("title", "Undo (⌘Z)");
    undoBtn.setAttribute("tooltiptext", "Undo (⌘Z)");
    undoBtn.appendChild(
      this._createPenSvgIcon(doc, [
        { d: "M6 4L2.5 7.5 6 11" },
        { d: "M3 7.5h6.5a3.5 3.5 0 0 1 0 7H8" },
      ])
    );
    undoBtn.addEventListener("click", () => {
      this.undoPen(win);
    });

    const doneBtn = doc.createElement("button");
    doneBtn.type = "button";
    doneBtn.className =
      "whimsy-pen-done footer-button whimsy-surface-button primary";
    doneBtn.setAttribute("data-action", "done");
    doneBtn.setAttribute("data-l10n-id", "whimsy-annotations-pen-done");
    doneBtn.setAttribute("aria-label", "Done (Esc)");
    doneBtn.setAttribute("title", "Done (Esc)");
    doneBtn.setAttribute("tooltiptext", "Done (Esc)");
    doneBtn.textContent = "Done";
    doneBtn.addEventListener("click", () => {
      this.stopPen(win);
    });

    bar.append(
      swatchesWrap,
      sep1,
      thinBtn,
      thickBtn,
      eraserBtn,
      sep2,
      undoBtn,
      doneBtn
    );
    return bar;
  },

  _syncPenBar(win) {
    const doc = win?.document;
    const bar = doc?.getElementById(PEN_BAR_ID);
    const session = this._penSessions.get(win);
    if (!bar || !session) {
      return;
    }
    const isEraser = session.tool === "eraser";
    for (const swatch of bar.querySelectorAll(".whimsy-pen-swatch")) {
      const c = swatch.getAttribute("data-color");
      const active = !isEraser && c === session.color;
      swatch.setAttribute("aria-checked", active ? "true" : "false");
    }
    for (const btn of bar.querySelectorAll(".whimsy-pen-width-btn")) {
      const w = btn.getAttribute("data-width");
      const active = !isEraser && w === session.width;
      btn.setAttribute("aria-pressed", active ? "true" : "false");
      if (active) {
        btn.setAttribute("data-active", "true");
      } else {
        btn.removeAttribute("data-active");
      }
    }
    const eraserBtn = bar.querySelector(".whimsy-pen-eraser-btn");
    if (eraserBtn) {
      eraserBtn.setAttribute("aria-pressed", isEraser ? "true" : "false");
      if (isEraser) {
        eraserBtn.setAttribute("data-active", "true");
      } else {
        eraserBtn.removeAttribute("data-active");
      }
    }
  },

  _showPenHintIfNeeded(win, stack) {
    const doc = win?.document;
    if (!doc || !stack) {
      return;
    }
    let shownCount = 0;
    try {
      shownCount = Services.prefs.getIntPref(PREF_PEN_HINT_SHOWN, 0);
    } catch {}
    if (shownCount >= 2) {
      return;
    }
    try {
      Services.prefs.setIntPref(PREF_PEN_HINT_SHOWN, shownCount + 1);
    } catch {}

    let hint = doc.getElementById(PEN_HINT_ID);
    if (!hint) {
      hint = doc.createElement("div");
      hint.id = PEN_HINT_ID;
      hint.className = "whimsy-annotations-pen-hint whimsy-surface-tokens";
      hint.setAttribute("data-l10n-id", "whimsy-annotations-pen-hint");
      hint.textContent =
        "Drag to draw. Scroll with two fingers. Press Esc when you’re done.";
    }
    if (hint.parentNode !== stack) {
      stack.appendChild(hint);
    }
    hint.hidden = false;

    const session = this._penSessions.get(win);
    if (session?.hintTimer) {
      win.clearTimeout(session.hintTimer);
    }
    const timer = win.setTimeout(() => {
      if (hint) {
        hint.hidden = true;
      }
      if (session && session.hintTimer === timer) {
        session.hintTimer = 0;
      }
    }, 2000);
    if (session) {
      session.hintTimer = timer;
    }
  },

  _hidePenHint(win) {
    const session = this._penSessions.get(win);
    if (session?.hintTimer) {
      win.clearTimeout(session.hintTimer);
      session.hintTimer = 0;
    }
    const hint = win?.document?.getElementById(PEN_HINT_ID);
    if (hint) {
      hint.hidden = true;
    }
  },

  async _syncPenStateToActor(win) {
    const session = this._penSessions.get(win);
    const browser = session?.browser || win?.gBrowser?.selectedBrowser;
    if (!browser) {
      return null;
    }
    const normUrl =
      session?.normUrl || this.normalizeURL(browser.currentURI?.spec || "");
    const drawings = normUrl ? this.getDrawings(normUrl, { win, browser }) : [];
    try {
      const actor = browser.browsingContext?.currentWindowGlobal?.getActor(
        "WhimsyAnnotations"
      );
      return await actor?.sendQuery("WhimsyAnnotations:SetPenState", {
        active: Boolean(session?.active),
        color: session?.color || this.lastColor,
        width: session?.width || this.lastPenWidth,
        tool: session?.tool || "pen",
        groupId: session?.groupId || "",
        drawings,
      });
    } catch {}
    return null;
  },

  async startPen(win, { color = null, width = null, tool = "pen" } = {}) {
    const browser = win?.gBrowser?.selectedBrowser;
    if (!this.canAnnotate(win, browser)) {
      return null;
    }
    const normUrl = this.normalizeURL(browser.currentURI?.spec || "");
    if (!normUrl) {
      return null;
    }
    await gStore.ensureLoaded();

    const initialColor = color ? this.normalizeColor(color) : this.lastColor;
    const initialWidth = width
      ? this.normalizePenWidth(width)
      : this.lastPenWidth;
    this.lastColor = initialColor;
    this.lastPenWidth = initialWidth;

    let session = this._penSessions.get(win);
    const now = Date.now();
    const groupId =
      globalThis.crypto?.randomUUID?.() ||
      `grp-${now}-${Math.random().toString(36).slice(2, 8)}`;

    if (session?.onKeyDown) {
      try {
        win.removeEventListener("keydown", session.onKeyDown, true);
      } catch {}
    }
    if (session?.hintTimer) {
      win.clearTimeout(session.hintTimer);
    }

    const onKeyDown = event => {
      if (!this.isPenActive(win)) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.stopPen(win);
        return;
      }
      const isAccel =
        Services.appinfo.OS === "Darwin" ? event.metaKey : event.ctrlKey;
      if (
        isAccel &&
        !event.shiftKey &&
        !event.altKey &&
        event.key?.toLowerCase() === "z"
      ) {
        event.preventDefault();
        event.stopPropagation();
        this.undoPen(win);
      }
    };

    session = {
      active: true,
      browser,
      normUrl,
      color: initialColor,
      width: initialWidth,
      tool: tool === "eraser" ? "eraser" : "pen",
      groupId,
      undoStack: [],
      onKeyDown,
      hintTimer: 0,
    };
    this._penSessions.set(win, session);
    win.addEventListener("keydown", onKeyDown, true);

    const bar = this._ensurePenBar(win);
    const stack =
      browser.closest(".browserStack") ||
      win.document.getElementById("tabbrowser-tabbox") ||
      browser.parentElement;
    if (stack && bar.parentNode !== stack) {
      stack.appendChild(bar);
    }
    this._syncPenBar(win);

    bar._motion?.cancel();
    bar._motion = null;
    bar.removeAttribute("entering");
    bar.removeAttribute("exiting");
    bar.hidden = false;

    const reduced = win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced) {
      bar.setAttribute("entering", "");
      const frames = [
        { opacity: 0, transform: "translate(-50%, -8px)" },
        { opacity: 1, transform: "translate(-50%, 0)" },
      ];
      const motion = bar.animate(frames, {
        duration: 180,
        easing: "cubic-bezier(0.075, 0.82, 0.165, 1)",
      });
      bar._motion = motion;
      motion.finished
        .then(() => {
          if (bar._motion === motion) {
            bar.removeAttribute("entering");
            bar._motion = null;
          }
        })
        .catch(() => {});
    }

    this._showPenHintIfNeeded(win, stack);
    await this._syncPenStateToActor(win);
    return bar;
  },

  async stopPen(win, { immediate = false } = {}) {
    const session = this._penSessions.get(win);
    if (!session) {
      const existingBar = win?.document?.getElementById(PEN_BAR_ID);
      if (existingBar) {
        existingBar.hidden = true;
      }
      return;
    }

    session.active = false;
    if (session.onKeyDown) {
      try {
        win.removeEventListener("keydown", session.onKeyDown, true);
      } catch {}
      session.onKeyDown = null;
    }
    this._hidePenHint(win);

    await this._syncPenStateToActor(win);
    this._penSessions.delete(win);
    this.updateUrlbarButton(win);

    const bar = win?.document?.getElementById(PEN_BAR_ID);
    if (!bar) {
      return;
    }
    bar._motion?.cancel();
    bar._motion = null;
    bar.removeAttribute("entering");
    bar.removeAttribute("exiting");

    const reduced =
      immediate || win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      bar.hidden = true;
      return;
    }

    bar.setAttribute("exiting", "");
    const frames = [
      { opacity: 1, transform: "translate(-50%, 0)" },
      { opacity: 0, transform: "translate(-50%, -8px)" },
    ];
    const motion = bar.animate(frames, {
      duration: 180,
      easing: "cubic-bezier(0.075, 0.82, 0.165, 1)",
    });
    bar._motion = motion;
    try {
      await motion.finished;
    } catch {}
    if (bar._motion === motion) {
      bar.removeAttribute("exiting");
      bar.hidden = true;
      bar._motion = null;
    }
  },

  async setPenColor(win, color) {
    const valid = this.normalizeColor(color);
    this.lastColor = valid;
    const session = this._penSessions.get(win);
    if (!session || !session.active) {
      return;
    }
    session.color = valid;
    session.tool = "pen";
    this._syncPenBar(win);
    await this._syncPenStateToActor(win);
  },

  async setPenWidth(win, width) {
    const valid = this.normalizePenWidth(width);
    this.lastPenWidth = valid;
    const session = this._penSessions.get(win);
    if (!session || !session.active) {
      return;
    }
    session.width = valid;
    session.tool = "pen";
    this._syncPenBar(win);
    await this._syncPenStateToActor(win);
  },

  async setPenTool(win, tool) {
    const session = this._penSessions.get(win);
    if (!session || !session.active) {
      return;
    }
    session.tool = tool === "eraser" ? "eraser" : "pen";
    this._syncPenBar(win);
    await this._syncPenStateToActor(win);
  },

  async _onActorStrokeAdded(win, browser, { stroke, url } = {}) {
    if (!this.canAnnotate(win, browser) || !stroke) {
      return null;
    }
    const session = this._penSessions.get(win);
    const rawUrl = url || session?.normUrl || browser.currentURI?.spec || "";
    const saved = await this.addDrawingStroke(rawUrl, stroke, {
      win,
      browser,
      groupId: session?.groupId || stroke.groupId || "",
      renderContent: false,
    });
    if (saved && session?.active) {
      session.undoStack.push({ type: "add", stroke: saved });
    }
    this.updateUrlbarButton(win);
    return saved;
  },

  async _onActorStrokeErased(win, browser, { strokeId, url } = {}) {
    if (!this.canAnnotate(win, browser) || !strokeId) {
      return null;
    }
    const session = this._penSessions.get(win);
    const rawUrl = url || session?.normUrl || browser.currentURI?.spec || "";
    const removed = await this.removeDrawingStroke(rawUrl, strokeId, {
      win,
      browser,
      renderContent: false,
    });
    if (removed && session?.active) {
      session.undoStack.push({
        type: "erase",
        stroke: removed.stroke,
        index: removed.index,
      });
    }
    this.updateUrlbarButton(win);
    return removed;
  },

  async undoPen(win) {
    const session = this._penSessions.get(win);
    if (!session || !session.active || !session.undoStack.length) {
      return false;
    }
    const browser = session.browser || win?.gBrowser?.selectedBrowser;
    const normUrl =
      session.normUrl || this.normalizeURL(browser?.currentURI?.spec || "");
    if (!normUrl) {
      return false;
    }
    const action = session.undoStack.pop();
    if (!action) {
      return false;
    }
    await gStore.ensureLoaded();
    if (action.type === "add") {
      await this.removeDrawingStroke(normUrl, action.stroke.id, {
        win,
        browser,
        renderContent: true,
      });
    } else if (action.type === "erase" && action.stroke) {
      const profileKey = this._profileKeyForWindow(win);
      const rec = this._ensurePageRecord(normUrl, {
        title: browser?.contentTitle || normUrl,
        profileKey,
      });
      const idx = Math.max(
        0,
        Math.min(rec.drawings.length, Number(action.index) || 0)
      );
      rec.drawings.splice(idx, 0, action.stroke);
      rec.updatedAt = Date.now();
      gStore.saveSoon();
      await this._refreshWindowsForUrl(normUrl, { renderContent: true });
    }
    return true;
  },

  _buildDrawingThumbSvg(doc, strokes) {
    const svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 38 24");
    svg.setAttribute("aria-hidden", "true");

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of strokes) {
      for (const [x, y] of s.points || []) {
        if (x < minX) {
          minX = x;
        }
        if (y < minY) {
          minY = y;
        }
        if (x > maxX) {
          maxX = x;
        }
        if (y > maxY) {
          maxY = y;
        }
      }
    }
    if (!Number.isFinite(minX)) {
      return svg;
    }

    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const padX = 4;
    const padY = 4;
    const availW = 38 - padX * 2;
    const availH = 24 - padY * 2;
    const scale = Math.min(availW / spanX, availH / spanY);
    const offsetX = padX + (availW - spanX * scale) / 2;
    const offsetY = padY + (availH - spanY * scale) / 2;
    const round1 = v => Math.round(v * 10) / 10;

    for (const s of strokes) {
      const pts = s.points || [];
      if (!pts.length) {
        continue;
      }
      const path = doc.createElementNS(SVG_NS, "path");
      path.setAttribute("data-color", s.color || "yellow");
      path.setAttribute("stroke-width", s.width === "thick" ? "2.4" : "1.8");
      let d = "";
      for (let i = 0; i < pts.length; i++) {
        const tx = round1(offsetX + (pts[i][0] - minX) * scale);
        const ty = round1(offsetY + (pts[i][1] - minY) * scale);
        d += i === 0 ? `M ${tx} ${ty}` : ` L ${tx} ${ty}`;
      }
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return svg;
  },

  async openHighlightPopover(
    win,
    { browser = win?.gBrowser?.selectedBrowser, url = "", highlightId = null, draftAnchor = null, rect = null } = {}
  ) {
    if (!this.canAnnotate(win, browser)) {
      return null;
    }
    const normUrl = this.normalizeURL(url || browser.currentURI?.spec || "");
    if (!normUrl) {
      return null;
    }

    const rec = this.getPageRecord(normUrl, { win, browser });
    const existing = highlightId
      ? rec?.highlights?.find(h => h.id === highlightId) || null
      : null;

    if (!existing && !draftAnchor) {
      return null;
    }

    const doc = win.document;
    const parts = lazy.WhimsySurface.create(win, {
      id: POPOVER_ID,
      width: 300,
      titleL10nId: "whimsy-annotations-popover-title",
      close: true,
      footer: true,
    });
    const { panel, view: body, footer } = parts;

    let currentColor = this.normalizeColor(existing?.color || this.lastColor);
    const quoteText = existing ? existing.text : draftAnchor.text;

    const quoteEl = doc.createElement("div");
    quoteEl.className = "whimsy-annotation-quote";
    quoteEl.setAttribute("data-color", currentColor);
    quoteEl.textContent = quoteText;

    const colorRow = doc.createElement("div");
    colorRow.className = "whimsy-annotation-color-row";
    const colorLabel = doc.createElement("span");
    colorLabel.className = "whimsy-annotation-color-label";
    colorLabel.setAttribute("data-l10n-id", "whimsy-annotations-color-label");
    colorLabel.textContent = "Highlight color";

    const swatchesWrap = doc.createElement("div");
    swatchesWrap.className = "whimsy-annotation-swatches";
    swatchesWrap.setAttribute("role", "radiogroup");
    swatchesWrap.setAttribute("aria-label", "Highlight color");

    const swatchButtons = new Map();
    const syncSwatches = newColor => {
      currentColor = newColor;
      quoteEl.setAttribute("data-color", currentColor);
      for (const [c, btn] of swatchButtons.entries()) {
        btn.setAttribute("aria-checked", c === currentColor ? "true" : "false");
      }
    };

    for (const c of ANNOTATION_COLORS) {
      const swatch = doc.createElement("button");
      swatch.type = "button";
      swatch.className = "whimsy-annotation-swatch";
      swatch.setAttribute("role", "radio");
      swatch.setAttribute("data-color", c);
      swatch.setAttribute("aria-label", COLOR_LABELS[c]);
      swatch.setAttribute("title", COLOR_LABELS[c]);
      swatch.setAttribute("aria-checked", c === currentColor ? "true" : "false");
      swatch.addEventListener("click", async () => {
        syncSwatches(c);
        this.lastColor = c;
        if (existing) {
          await this.updateHighlight(
            normUrl,
            existing.id,
            { color: c },
            { win, browser }
          );
        }
      });
      swatchButtons.set(c, swatch);
      swatchesWrap.appendChild(swatch);
    }

    colorRow.append(colorLabel, swatchesWrap);

    const textarea = doc.createElement("textarea");
    textarea.className = "whimsy-annotation-note-input";
    textarea.rows = 3;
    textarea.setAttribute("data-l10n-id", "whimsy-annotations-note-placeholder");
    textarea.placeholder = "Write a note about this passage…";
    textarea.value = existing?.note || "";

    if (existing) {
      const delBtn = lazy.WhimsySurface.footerButton(doc, {
        l10nId: "whimsy-annotations-remove-highlight",
        destructive: true,
      });
      delBtn.classList.add("whimsy-annotation-delete");
      delBtn.addEventListener("command", async () => {
        const snapshot = { ...existing };
        lazy.WhimsySurface.close(panel);
        await this.removeHighlight(normUrl, existing.id, { win, browser });
        try {
          lazy.WhimsyUndo.showToast(
            win,
            snapshot.note
              ? "whimsy-annotations-toast-note-deleted"
              : "whimsy-annotations-toast-removed",
            {
              type: "annotation",
              undo: () =>
                this.addHighlight(normUrl, snapshot, {
                  color: snapshot.color,
                  note: snapshot.note,
                  win,
                  browser,
                }),
              redo: () =>
                this.removeHighlight(normUrl, snapshot.id, { win, browser }),
            }
          );
        } catch {}
      });
      footer.append(delBtn);
    } else {
      const hint = doc.createElement("span");
      hint.className = "whimsy-annotation-hint";
      hint.setAttribute("data-l10n-id", "whimsy-annotations-return-hint");
      footer.append(hint);
    }

    const cancelBtn = lazy.WhimsySurface.footerButton(doc, {
      l10nId: "whimsy-annotations-cancel",
      onCommand: () => lazy.WhimsySurface.close(panel),
    });
    cancelBtn.classList.add("whimsy-annotation-cancel");
    const saveBtn = lazy.WhimsySurface.footerButton(doc, { l10nId: "whimsy-annotations-save", primary: true });
    saveBtn.classList.add("whimsy-annotation-save");

    const commitSave = async () => {
      const noteValue = textarea.value.trim();
      lazy.WhimsySurface.close(panel);
      if (existing) {
        await this.updateHighlight(
          normUrl,
          existing.id,
          { color: currentColor, note: noteValue },
          { win, browser }
        );
      } else if (draftAnchor) {
        const created = await this.addHighlight(normUrl, draftAnchor, {
          color: currentColor,
          note: noteValue,
          title: draftAnchor.title || browser.contentTitle || "",
          win,
          browser,
        });
        if (created) {
          try {
            lazy.WhimsyUndo.showToast(
              win,
              noteValue
                ? "whimsy-annotations-toast-note-saved"
                : "whimsy-annotations-toast-highlighted",
              {
                type: "annotation",
                undo: () =>
                  this.removeHighlight(normUrl, created.id, { win, browser }),
                redo: () =>
                  this.addHighlight(normUrl, draftAnchor, {
                    color: currentColor,
                    note: noteValue,
                    win,
                    browser,
                  }),
              },
              { color: COLOR_LABELS[currentColor] || "Yellow" }
            );
          } catch {}
        }
      }
    };

    saveBtn.addEventListener("command", commitSave);
    textarea.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        commitSave();
      } else if (event.key === "Escape") {
        event.preventDefault();
        lazy.WhimsySurface.close(panel);
      }
    });

    footer.append(cancelBtn, saveBtn);
    body.append(quoteEl, colorRow, textarea);
    lazy.WhimsySurface.finish(parts);

    panel.addEventListener(
      "popupshown",
      () => {
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      },
      { once: true }
    );

    if (rect && Number.isFinite(rect.screenX) && Number.isFinite(rect.screenY)) {
      lazy.WhimsySurface.open(win, panel, {
        position: "bottomcenter topleft",
        screenRect: {
          left: Math.round(rect.screenX),
          top: Math.round(rect.screenY),
          width: Math.max(8, Math.round(rect.width || 24)),
          height: Math.max(8, Math.round(rect.height || 18)),
        },
        gap: 6,
      });
    } else {
      const anchorEl =
        doc.getElementById(BUTTON_ID) && !doc.getElementById(BUTTON_ID).hidden
          ? doc.getElementById(BUTTON_ID)
          : win.gURLBar?.inputField || browser;
      lazy.WhimsySurface.open(win, panel, {
        anchor: anchorEl,
        position: "after_end",
        y: 6,
      });
    }
    return panel;
  },

  /** Opens this page's note in Notes (the cue's and the panel's target). */
  async openInNotes(win) {
    const browser = win?.gBrowser?.selectedBrowser;
    const normUrl = this.normalizeURL(browser?.currentURI?.spec || "");
    const rec = normUrl ? this.getPageRecord(normUrl, { win, browser }) : null;
    return lazy.WhimsyNotes.openInLibrary(win, rec?.noteId ?? null);
  },

  async openPagePanel(win, anchorEl = null) {
    const browser = win?.gBrowser?.selectedBrowser;
    if (!this.canAnnotate(win, browser)) {
      return null;
    }
    const normUrl = this.normalizeURL(browser.currentURI?.spec || "");
    if (!normUrl) {
      return null;
    }
    await gStore.ensureLoaded();
    await this._syncRecordFromNotesStore(this.getPageRecord(normUrl, { win, browser }));

    const doc = win.document;
    const btn = anchorEl || doc.getElementById(BUTTON_ID) || win.gURLBar;
    const parts = lazy.WhimsySurface.create(win, {
      id: PAGE_PANEL_ID,
      width: 320,
      titleL10nId: "whimsy-annotations-panel-title",
      close: true,
      footer: true,
    });
    const { panel, view, footer } = parts;
    // The surface's header holds the title; the body re-renders below it.
    const body = doc.createXULElement("vbox");
    body.className = "whimsy-annotations-panel-body";
    view.append(body);
    let saveNoteNow = async () => {};

    const renderPanelBody = () => {
      body.replaceChildren();

      const rec = this.getPageRecord(normUrl, { win, browser });
      const activeHighlights = this._activeHighlightsForBrowser(win, browser);
      const pageNote = String(rec?.note || "");

      // Editable page note section (one note per page)
      const noteSection = doc.createElement("div");
      noteSection.className = "whimsy-annotations-page-note-section";

      const noteLabel = doc.createElement("div");
      noteLabel.className = "whimsy-annotations-section-label";
      noteLabel.textContent =
        rec?.title || browser.contentTitle || "Page note";

      const noteArea = doc.createElement("textarea");
      noteArea.className = "whimsy-annotations-page-note";
      noteArea.rows = 3;
      noteArea.setAttribute(
        "data-l10n-id",
        "whimsy-annotations-page-note-placeholder"
      );
      noteArea.placeholder = "Write a note for this page…";
      noteArea.value = pageNote;

      saveNoteNow = async () => {
        await this.setPageNote(normUrl, noteArea.value, {
          win,
          browser,
          title: browser.contentTitle || rec?.title || normUrl,
        });
      };

      noteArea.addEventListener("change", saveNoteNow);
      noteArea.addEventListener("input", () => {
        saveNoteNow();
      });
      noteArea.addEventListener("keydown", event => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          saveNoteNow();
          lazy.WhimsySurface.close(panel);
        }
      });

      noteSection.append(noteLabel, noteArea);

      // Highlights section
      const hlSection = doc.createElement("div");
      hlSection.className = "whimsy-annotations-highlights-section";

      const hlLabel = doc.createElement("div");
      hlLabel.className = "whimsy-annotations-section-label";
      hlLabel.setAttribute("data-l10n-id", "whimsy-annotations-highlights-label");
      hlLabel.textContent = `Highlights (${activeHighlights.length})`;
      hlSection.appendChild(hlLabel);

      const listEl = doc.createElement("div");
      listEl.className = "whimsy-annotations-highlights-list";

      if (!activeHighlights.length) {
        const emptyEl = doc.createElement("div");
        emptyEl.className = "whimsy-annotations-empty-highlights";
        emptyEl.setAttribute(
          "data-l10n-id",
          "whimsy-annotations-no-highlights"
        );
        emptyEl.textContent = "No highlights on this page yet.";
        listEl.appendChild(emptyEl);
      } else {
        for (const hl of activeHighlights) {
          const item = doc.createElement("div");
          item.className = "whimsy-annotations-item";
          item.setAttribute("data-highlight-id", hl.id);
          item.setAttribute("data-color", hl.color || "yellow");

          const quote = doc.createElement("div");
          quote.className = "whimsy-annotations-item-quote";
          quote.textContent = hl.text;
          item.appendChild(quote);

          if (hl.note && String(hl.note).trim()) {
            const noteTextEl = doc.createElement("div");
            noteTextEl.className = "whimsy-annotations-item-note";
            noteTextEl.textContent = hl.note;
            item.appendChild(noteTextEl);
          }

          const actions = doc.createElement("div");
          actions.className = "whimsy-annotations-item-actions";

          const itemSwatches = doc.createElement("div");
          itemSwatches.className = "whimsy-annotations-item-swatches";
          for (const c of ANNOTATION_COLORS) {
            const dot = doc.createElement("button");
            dot.type = "button";
            dot.className = "whimsy-annotations-item-swatch";
            dot.setAttribute("data-color", c);
            dot.setAttribute("title", COLOR_LABELS[c]);
            dot.setAttribute("aria-label", COLOR_LABELS[c]);
            dot.setAttribute(
              "aria-checked",
              c === (hl.color || "yellow") ? "true" : "false"
            );
            dot.addEventListener("click", async event => {
              event.stopPropagation();
              await this.updateHighlight(
                normUrl,
                hl.id,
                { color: c },
                { win, browser }
              );
              renderPanelBody();
            });
            itemSwatches.appendChild(dot);
          }

          const btns = doc.createElement("div");
          btns.className = "whimsy-annotations-item-buttons";

          const editBtn = doc.createElement("button");
          editBtn.type = "button";
          editBtn.className = "whimsy-surface-text-button whimsy-surface-ghost whimsy-annotations-item-btn whimsy-annotations-item-edit";
          editBtn.setAttribute("data-l10n-id", "whimsy-annotations-edit-item");
          editBtn.textContent = hl.note ? "Edit note" : "Add note";
          editBtn.addEventListener("click", async event => {
            event.stopPropagation();
            lazy.WhimsySurface.close(panel);
            let rect = null;
            try {
              const actor =
                browser.browsingContext?.currentWindowGlobal?.getActor(
                  "WhimsyAnnotations"
                );
              rect = await actor?.sendQuery(
                "WhimsyAnnotations:ScrollToHighlight",
                { id: hl.id }
              );
            } catch {}
            await this.openHighlightPopover(win, {
              browser,
              url: normUrl,
              highlightId: hl.id,
              rect,
            });
          });

          const delBtn = doc.createElement("button");
          delBtn.type = "button";
          delBtn.className =
            "whimsy-surface-text-button whimsy-surface-ghost whimsy-annotations-item-btn whimsy-annotations-item-delete danger";
          delBtn.setAttribute("data-l10n-id", "whimsy-annotations-delete-item");
          delBtn.textContent = "Remove";
          delBtn.addEventListener("click", async event => {
            event.stopPropagation();
            await this.removeHighlight(normUrl, hl.id, { win, browser });
            const remaining = this._activeHighlightsForBrowser(win, browser);
            const currNote = this.getPageNote(normUrl, { win, browser });
            const currDrawings = this.getDrawings(normUrl, { win, browser });
            if (!remaining.length && !currNote.trim() && !currDrawings.length) {
              lazy.WhimsySurface.close(panel);
            } else {
              renderPanelBody();
            }
          });

          btns.append(editBtn, delBtn);
          actions.append(itemSwatches, btns);
          item.appendChild(actions);

          item.addEventListener("click", async () => {
            try {
              const actor =
                browser.browsingContext?.currentWindowGlobal?.getActor(
                  "WhimsyAnnotations"
                );
              await actor?.sendQuery("WhimsyAnnotations:ScrollToHighlight", {
                id: hl.id,
              });
            } catch {}
          });

          listEl.appendChild(item);
        }
      }

      hlSection.appendChild(listEl);

      body.append(noteSection, hlSection);

      const drawingGroups = this._drawingGroupsForRecord(rec);
      if (drawingGroups.length > 0) {
        const drwSection = doc.createElement("div");
        drwSection.className = "whimsy-annotations-drawings-section";

        const drwLabel = doc.createElement("div");
        drwLabel.className =
          "whimsy-annotations-section-label whimsy-annotations-drawings-label";
        doc.l10n.setAttributes(
          drwLabel,
          "whimsy-annotations-drawings-label",
          { count: drawingGroups.length }
        );
        drwLabel.textContent = `Drawings · ${drawingGroups.length}`;
        drwSection.appendChild(drwLabel);

        const drwRow = doc.createElement("div");
        drwRow.className =
          "whimsy-annotations-item whimsy-annotations-drawings-row";

        const drwActions = doc.createElement("div");
        drwActions.className = "whimsy-annotations-item-actions";

        const thumbsWrap = doc.createElement("div");
        thumbsWrap.className = "whimsy-annotations-drawings-thumbs";

        drawingGroups.forEach((grp, idx) => {
          const thumbBtn = doc.createElement("button");
          thumbBtn.type = "button";
          thumbBtn.className = "whimsy-annotations-drawing-thumb";
          thumbBtn.setAttribute("data-group-id", grp.groupId);
          doc.l10n.setAttributes(
            thumbBtn,
            "whimsy-annotations-drawings-preview",
            { index: idx + 1 }
          );
          thumbBtn.setAttribute("aria-label", `Drawing ${idx + 1}`);
          thumbBtn.setAttribute("title", `Drawing ${idx + 1}`);
          thumbBtn.appendChild(this._buildDrawingThumbSvg(doc, grp.strokes));
          thumbBtn.addEventListener("click", async event => {
            event.stopPropagation();
            try {
              const actor =
                browser.browsingContext?.currentWindowGlobal?.getActor(
                  "WhimsyAnnotations"
                );
              await actor?.sendQuery("WhimsyAnnotations:ScrollToDrawing", {
                groupId: grp.groupId,
                strokeIds: grp.strokes.map(s => s.id),
              });
            } catch {}
          });
          thumbsWrap.appendChild(thumbBtn);
        });

        const drwBtns = doc.createElement("div");
        drwBtns.className = "whimsy-annotations-item-buttons";

        const drwEditBtn = doc.createElement("button");
        drwEditBtn.type = "button";
        drwEditBtn.className =
          "whimsy-surface-text-button whimsy-surface-ghost whimsy-annotations-item-btn whimsy-annotations-drawings-edit";
        drwEditBtn.setAttribute(
          "data-l10n-id",
          "whimsy-annotations-drawings-edit"
        );
        drwEditBtn.textContent = "Edit";
        drwEditBtn.addEventListener("click", async event => {
          event.stopPropagation();
          await saveNoteNow();
          lazy.WhimsySurface.close(panel);
          await this.startPen(win);
        });

        const drwDelBtn = doc.createElement("button");
        drwDelBtn.type = "button";
        drwDelBtn.className =
          "whimsy-surface-text-button whimsy-surface-ghost whimsy-annotations-item-btn whimsy-annotations-drawings-remove danger";
        drwDelBtn.setAttribute(
          "data-l10n-id",
          "whimsy-annotations-drawings-remove"
        );
        drwDelBtn.textContent = "Remove";
        drwDelBtn.addEventListener("click", async event => {
          event.stopPropagation();
          const snapshot = this.getDrawings(normUrl, { win, browser });
          await this.clearDrawings(normUrl, { win, browser });
          try {
            lazy.WhimsyUndo.showToast(
              win,
              "whimsy-annotations-toast-drawings-removed",
              {
                type: "annotation",
                undo: () =>
                  this.setDrawings(normUrl, snapshot, { win, browser }),
                redo: () =>
                  this.clearDrawings(normUrl, { win, browser }),
              }
            );
          } catch {}
          const remaining = this._activeHighlightsForBrowser(win, browser);
          const currNote = this.getPageNote(normUrl, { win, browser });
          if (!remaining.length && !currNote.trim()) {
            lazy.WhimsySurface.close(panel);
          } else {
            renderPanelBody();
          }
        });

        drwBtns.append(drwEditBtn, drwDelBtn);
        drwActions.append(thumbsWrap, drwBtns);
        drwRow.appendChild(drwActions);
        drwSection.appendChild(drwRow);
        body.appendChild(drwSection);
      }
    };
    const clearBtn = lazy.WhimsySurface.footerButton(doc, {
      l10nId: "whimsy-annotations-clear-page",
      destructive: true,
      onCommand: async () => {
        lazy.WhimsySurface.close(panel);
        await this.clearPage(normUrl, { win, browser });
      },
    });
    clearBtn.classList.add("whimsy-annotation-delete", "whimsy-annotations-clear-page");
    const openNotesBtn = lazy.WhimsySurface.footerButton(doc, {
      l10nId: "whimsy-annotations-open-in-notes",
      onCommand: () => {
        lazy.WhimsySurface.close(panel);
        this.openInNotes(win);
      },
    });
    openNotesBtn.classList.add("whimsy-annotations-open-notes");
    const doneBtn = lazy.WhimsySurface.footerButton(doc, {
      l10nId: "whimsy-annotations-done",
      primary: true,
      onCommand: async () => {
        await saveNoteNow();
        lazy.WhimsySurface.close(panel);
      },
    });
    doneBtn.classList.add("whimsy-annotations-done");
    footer.append(clearBtn, openNotesBtn, doneBtn);
    renderPanelBody();
    lazy.WhimsySurface.finish(parts);

    const buttonEl = doc.getElementById(BUTTON_ID);
    if (buttonEl) {
      buttonEl.setAttribute("open", "true");
      panel.addEventListener(
        "popuphidden",
        () => {
          buttonEl.removeAttribute("open");
        },
        { once: true }
      );
    }

    lazy.WhimsySurface.open(win, panel, {
      anchor: btn,
      position: "after_end",
      y: 6,
    });
    return panel;
  },

  async clearPage(rawUrl, { win = null, browser = null } = {}) {
    const normUrl = this.normalizeURL(rawUrl);
    if (!normUrl) {
      return;
    }
    await gStore.ensureLoaded();
    const rec = gStore.dataSync.pages[normUrl];
    if (rec) {
      rec.note = "";
      await this._syncPageNoteToNotesStore(rec);
      delete gStore.dataSync.pages[normUrl];
      gStore.saveSoon();
    }
    await this._refreshWindowsForUrl(normUrl, { renderContent: true });
  },

  async clearForFire({
    since = 0,
    allSpaces = true,
    profileIds = null,
    baseDomain = null,
  } = {}) {
    await gStore.ensureLoaded();
    const data = gStore.dataSync;
    const allowedProfiles =
      !allSpaces && Array.isArray(profileIds) && profileIds.length
        ? new Set(profileIds)
        : null;

    const affectedUrls = [];
    for (const [normUrl, rec] of Object.entries(data.pages)) {
      if (allowedProfiles && !allowedProfiles.has(rec.profileKey || "default")) {
        continue;
      }
      if (baseDomain) {
        try {
          const u = new URL(normUrl);
          const host = u.hostname.toLowerCase();
          const target = baseDomain.toLowerCase();
          if (host !== target && !host.endsWith(`.${target}`)) {
            continue;
          }
        } catch {
          continue;
        }
      }

      if (since > 0) {
        if (Array.isArray(rec.highlights)) {
          rec.highlights = rec.highlights.filter(
            h => (h.updatedAt || h.createdAt || 0) < since
          );
        }
        if (Array.isArray(rec.drawings)) {
          rec.drawings = rec.drawings.filter(
            d => (d.createdAt || 0) < since
          );
        }
        if ((rec.noteUpdatedAt || rec.updatedAt || 0) >= since) {
          rec.note = "";
          await this._syncPageNoteToNotesStore(rec);
        }
        this._pruneIfEmpty(normUrl);
      } else {
        rec.note = "";
        await this._syncPageNoteToNotesStore(rec);
        delete data.pages[normUrl];
      }
      affectedUrls.push(normUrl);
    }

    // Also clear matching standalone/page notes in gWhimsyNotesStore.
    try {
      const notesStore = lazy.gWhimsyNotesStore;
      const notes = await notesStore.list();
      for (const n of notes) {
        if (allowedProfiles && !allowedProfiles.has(n.profileKey || "default")) {
          continue;
        }
        if (baseDomain) {
          if (!n.url) {
            continue;
          }
          try {
            const host = new URL(n.url).hostname.toLowerCase();
            const target = baseDomain.toLowerCase();
            if (host !== target && !host.endsWith(`.${target}`)) {
              continue;
            }
          } catch {
            continue;
          }
        }
        if (since > 0 && (n.updated || n.created || 0) < since) {
          continue;
        }
        await notesStore.remove(n.id);
      }
    } catch {}

    gStore.saveSoon();
    await gStore.flush();

    for (const url of affectedUrls) {
      await this._refreshWindowsForUrl(url, { renderContent: true });
    }
    if (!affectedUrls.length) {
      await this._refreshWindowsForUrl(null, { renderContent: true });
    }
  },

  async clearAll() {
    await this.clearForFire({ since: 0, allSpaces: true });
  },

  async resetForTests() {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (!win.closed && this.isPenActive(win)) {
        await this.stopPen(win, { immediate: true });
      }
    }
    await this.clearAll();
    this.lastColor = "yellow";
    for (const pref of [PREF_COLOR, PREF_PEN_WIDTH, PREF_PEN_HINT_SHOWN]) {
      try {
        if (Services.prefs.prefHasUserValue(pref)) {
          Services.prefs.clearUserPref(pref);
        }
      } catch {}
    }
  },
};
