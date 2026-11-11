/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  JSONFile: "resource://gre/modules/JSONFile.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyMenuPrefs: "resource:///modules/whimsy/WhimsyMenuPrefs.sys.mjs",
  WhimsyNotesSection: "resource:///modules/whimsy/WhimsyNotesSection.sys.mjs",
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
  WhimsyUndo: "resource:///modules/whimsy/WhimsyUndo.sys.mjs",
  WhimsyVerbs: "resource:///modules/whimsy/WhimsyVerbs.sys.mjs",
  gWhimsyNotesStore: "resource:///modules/whimsy/WhimsyNotesSection.sys.mjs",
});

const PREF_ENABLED = "whimsy.feature.annotations";
const PREF_COLOR = "whimsy.annotations.color";
const STORE_FILENAME = "whimsy-annotations.json";
const STYLE_ID = "whimsy-annotations-chrome-style";
const BUTTON_ID = "whimsy-annotations-button";
const POPOVER_ID = "whimsy-annotation-popover";
const PAGE_PANEL_ID = "whimsy-annotations-page-panel";
const CTX_HIGHLIGHT_ID = "context-whimsy-highlight";
const CTX_ADD_NOTE_ID = "context-whimsy-add-note";
const CTX_SEP_ID = "context-whimsy-annotations-separator";

export const ANNOTATION_COLORS = Object.freeze([
  "yellow",
  "green",
  "blue",
  "pink",
]);

const COLOR_LABELS = Object.freeze({
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  pink: "Pink",
});

const CHROME_CSS = `
#${BUTTON_ID} {
  -moz-context-properties: fill, fill-opacity;
  fill: currentColor;
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding-inline: 5px;
  border-radius: 6px;
  cursor: pointer;
}
#${BUTTON_ID}[hidden] {
  display: none !important;
}
#${BUTTON_ID}:hover {
  background-color: var(--urlbar-box-hover-bgcolor, rgba(128, 128, 142, 0.14));
}
#${BUTTON_ID}[open="true"] {
  background-color: light-dark(rgba(79, 70, 229, 0.12), rgba(129, 140, 248, 0.18));
  color: light-dark(#4f46e5, #818cf8);
}
#${BUTTON_ID} .whimsy-annotations-button-icon {
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
#${BUTTON_ID} .whimsy-annotations-button-icon svg {
  width: 14px;
  height: 14px;
  stroke: currentColor;
  fill: none;
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
}
#${BUTTON_ID} .whimsy-annotations-button-count {
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  padding: 1px 4px;
  border-radius: 999px;
  background-color: light-dark(rgba(234, 179, 8, 0.22), rgba(250, 204, 21, 0.22));
  color: light-dark(#854d0e, #fde047);
}

#${POPOVER_ID} .whimsy-surface-view,
#${PAGE_PANEL_ID} .whimsy-surface-view {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.whimsy-annotation-quote {
  font-size: 12px;
  line-height: 1.45;
  color: var(--whimsy-surface-muted, light-dark(#52525b, #a1a1aa));
  padding: 6px 10px;
  border-radius: 6px;
  background: light-dark(rgba(0, 0, 0, 0.03), rgba(255, 255, 255, 0.04));
  border-left: 3px solid #eab308;
  max-height: 60px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}
.whimsy-annotation-quote[data-color="yellow"] {
  border-left-color: light-dark(#eab308, #facc15);
}
.whimsy-annotation-quote[data-color="green"] {
  border-left-color: light-dark(#22c55e, #4ade80);
}
.whimsy-annotation-quote[data-color="blue"] {
  border-left-color: light-dark(#3b82f6, #60a5fa);
}
.whimsy-annotation-quote[data-color="pink"] {
  border-left-color: light-dark(#ec4899, #f472b6);
}

.whimsy-annotation-color-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.whimsy-annotation-color-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--whimsy-surface-muted, light-dark(#71717a, #a1a1aa));
}
.whimsy-annotation-swatches {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.whimsy-annotation-swatch {
  appearance: none;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  border: 2px solid transparent;
  padding: 0;
  margin: 0;
  cursor: pointer;
  transition: transform 100ms ease, box-shadow 100ms ease, border-color 100ms ease;
}
.whimsy-annotation-swatch:hover {
  transform: scale(1.08);
}
.whimsy-annotation-swatch[data-color="yellow"] {
  background-color: light-dark(#fde047, #facc15);
  border-color: light-dark(#eab308, #ca8a04);
}
.whimsy-annotation-swatch[data-color="green"] {
  background-color: light-dark(#86efac, #4ade80);
  border-color: light-dark(#22c55e, #16a34a);
}
.whimsy-annotation-swatch[data-color="blue"] {
  background-color: light-dark(#93c5fd, #60a5fa);
  border-color: light-dark(#3b82f6, #2563eb);
}
.whimsy-annotation-swatch[data-color="pink"] {
  background-color: light-dark(#f9a8d4, #f472b6);
  border-color: light-dark(#ec4899, #db2777);
}
.whimsy-annotation-swatch[aria-checked="true"] {
  box-shadow: 0 0 0 2px var(--whimsy-surface-bg, light-dark(#fff, #1e1e22)),
    0 0 0 4px light-dark(#4f46e5, #818cf8);
}

.whimsy-annotation-note-input,
.whimsy-annotations-page-note {
  width: 100%;
  box-sizing: border-box;
  min-height: 68px;
  resize: vertical;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--whimsy-surface-border, light-dark(rgba(24, 24, 27, 0.14), rgba(255, 255, 255, 0.14)));
  background: light-dark(#ffffff, rgba(255, 255, 255, 0.05));
  color: inherit;
  font: inherit;
  font-size: 12.5px;
  line-height: 1.45;
}
.whimsy-annotation-note-input:focus-visible,
.whimsy-annotations-page-note:focus-visible {
  outline: 2px solid light-dark(#4f46e5, #818cf8);
  outline-offset: 0;
}

.whimsy-annotation-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 2px;
}
.whimsy-annotation-footer-left {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.whimsy-annotation-footer-right {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.whimsy-annotation-hint {
  font-size: 11px;
  color: var(--whimsy-surface-muted, light-dark(#71717a, #a1a1aa));
}
.whimsy-annotation-delete {
  appearance: none;
  border: 1px solid transparent;
  background: transparent;
  color: var(--whimsy-surface-muted, light-dark(#71717a, #a1a1aa));
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 11.5px;
  cursor: pointer;
}
.whimsy-annotation-delete:hover {
  color: light-dark(#dc2626, #f87171);
  background: light-dark(rgba(220, 38, 38, 0.08), rgba(248, 113, 113, 0.12));
}

.whimsy-annotations-panel-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.whimsy-annotations-panel-title-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.whimsy-annotations-panel-heading {
  font-size: 13px;
  font-weight: 600;
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.whimsy-annotations-panel-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
  background: light-dark(rgba(24, 24, 27, 0.07), rgba(255, 255, 255, 0.1));
  color: var(--whimsy-surface-muted, light-dark(#52525b, #a1a1aa));
}
.whimsy-annotations-open-notes {
  appearance: none;
  border: 0;
  background: transparent;
  color: light-dark(#4f46e5, #818cf8);
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
}
.whimsy-annotations-open-notes:hover {
  text-decoration: underline;
}

.whimsy-annotations-section-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--whimsy-surface-muted, light-dark(#71717a, #a1a1aa));
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.whimsy-annotations-highlights-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 240px;
  overflow-y: auto;
}
.whimsy-annotations-empty-highlights {
  font-size: 12px;
  color: var(--whimsy-surface-muted, light-dark(#71717a, #a1a1aa));
  padding: 6px 2px;
}
.whimsy-annotations-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border-radius: 8px;
  background: light-dark(rgba(24, 24, 27, 0.03), rgba(255, 255, 255, 0.04));
  border: 1px solid var(--whimsy-surface-border, light-dark(rgba(24, 24, 27, 0.08), rgba(255, 255, 255, 0.08)));
  border-left-width: 3px;
  cursor: pointer;
}
.whimsy-annotations-item[data-color="yellow"] {
  border-left-color: light-dark(#eab308, #facc15);
}
.whimsy-annotations-item[data-color="green"] {
  border-left-color: light-dark(#22c55e, #4ade80);
}
.whimsy-annotations-item[data-color="blue"] {
  border-left-color: light-dark(#3b82f6, #60a5fa);
}
.whimsy-annotations-item[data-color="pink"] {
  border-left-color: light-dark(#ec4899, #f472b6);
}
.whimsy-annotations-item:hover {
  background: light-dark(rgba(24, 24, 27, 0.055), rgba(255, 255, 255, 0.07));
}
.whimsy-annotations-item-quote {
  font-size: 12px;
  line-height: 1.4;
  color: inherit;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.whimsy-annotations-item-note {
  font-size: 11.5px;
  line-height: 1.35;
  color: var(--whimsy-surface-muted, light-dark(#52525b, #a1a1aa));
}
.whimsy-annotations-item-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-top: 2px;
}
.whimsy-annotations-item-swatches {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.whimsy-annotations-item-swatch {
  appearance: none;
  width: 13px;
  height: 13px;
  border-radius: 999px;
  border: 1.5px solid transparent;
  padding: 0;
  cursor: pointer;
}
.whimsy-annotations-item-swatch[data-color="yellow"] {
  background-color: light-dark(#fde047, #facc15);
  border-color: light-dark(#eab308, #ca8a04);
}
.whimsy-annotations-item-swatch[data-color="green"] {
  background-color: light-dark(#86efac, #4ade80);
  border-color: light-dark(#22c55e, #16a34a);
}
.whimsy-annotations-item-swatch[data-color="blue"] {
  background-color: light-dark(#93c5fd, #60a5fa);
  border-color: light-dark(#3b82f6, #2563eb);
}
.whimsy-annotations-item-swatch[data-color="pink"] {
  background-color: light-dark(#f9a8d4, #f472b6);
  border-color: light-dark(#ec4899, #db2777);
}
.whimsy-annotations-item-swatch[aria-checked="true"] {
  box-shadow: 0 0 0 1.5px light-dark(#4f46e5, #818cf8);
}
.whimsy-annotations-item-buttons {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.whimsy-annotations-item-btn {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--whimsy-surface-muted, light-dark(#71717a, #a1a1aa));
  font-size: 11px;
  padding: 2px 5px;
  border-radius: 4px;
  cursor: pointer;
}
.whimsy-annotations-item-btn:hover {
  color: inherit;
  background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.08));
}
.whimsy-annotations-item-btn.danger:hover {
  color: light-dark(#dc2626, #f87171);
}
`;

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

  COLORS: ANNOTATION_COLORS,

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
    } catch {}
  },

  initWindow(win) {
    if (!win?.document || this._windows.has(win)) {
      return;
    }
    this._windows.add(win);

    const doc = win.document;
    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CHROME_CSS;
      (doc.head || doc.documentElement).appendChild(style);
    }

    this._ensureContextMenu(win);
    this._ensureUrlbarButton(win);

    const onTabSelect = () => {
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
      onLocationChange: aWebProgress => {
        if (!aWebProgress?.isTopLevel) {
          return;
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
      menu.insertBefore(sep, anchor);
    } else {
      menu.append(hlItem, noteItem, sep);
    }

    menu.addEventListener("popupshowing", event => {
      if (event.target !== menu) {
        return;
      }
      const show = this._shouldShowContextItems(win);
      hlItem.hidden = !show;
      noteItem.hidden = !show;
      sep.hidden = true;
    });
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

    const btn = doc.createXULElement("hbox");
    btn.id = BUTTON_ID;
    btn.className = "urlbar-page-action whimsy-smart-button";
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    btn.setAttribute("data-l10n-id", "whimsy-annotations-urlbar-button");
    btn.setAttribute("tooltiptext", "Notes and highlights on this page");
    btn.hidden = true;

    const iconWrap = doc.createElement("span");
    iconWrap.className = "whimsy-annotations-button-icon";
    iconWrap.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5l4 4L6 14H2v-4L9.5 2.5z"/><path d="M7.5 4.5l4 4"/></svg>`;

    const countEl = doc.createElement("span");
    countEl.className = "whimsy-annotations-button-count";
    countEl.textContent = "0";

    btn.append(iconWrap, countEl);

    const activate = event => {
      if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.openPagePanel(win, btn);
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
    const record = data.pages[normUrl] || null;
    if (record) {
      this._syncRecordFromNotesStore(record);
    }
    return record;
  },

  getHighlights(rawUrl, opts = {}) {
    const rec = this.getPageRecord(rawUrl, opts);
    if (!rec || !Array.isArray(rec.highlights)) {
      return [];
    }
    return rec.highlights.map(h => ({ ...h }));
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
      };
      data.pages[normUrl] = rec;
    } else {
      if (title && (!rec.title || rec.title === normUrl)) {
        rec.title = title;
      }
      if (profileKey) {
        rec.profileKey = profileKey;
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
    if (!hasHighlights && !hasNote) {
      delete data.pages[normUrl];
    }
  },

  _syncRecordFromNotesStore(rec) {
    if (!rec?.noteId) {
      return;
    }
    try {
      const store = lazy.gWhimsyNotesStore;
      if (!store?._loaded) {
        return;
      }
      const existing = store.get(rec.noteId);
      if (existing && typeof existing.text === "string" && existing.text !== rec.note) {
        rec.note = existing.text;
      }
    } catch {}
  },

  async _syncPageNoteToNotesStore(rec) {
    if (!rec) {
      return;
    }
    try {
      const store = lazy.gWhimsyNotesStore;
      await store.ensureLoaded();
      const noteText = String(rec.note || "").trim();
      const pageNotes = store
        .list({ profileKey: rec.profileKey })
        .filter(
          n =>
            n.id === rec.noteId ||
            (n.pageAttached && this.normalizeURL(n.url) === rec.url)
        );
      const existing = pageNotes[0] || (rec.noteId ? store.get(rec.noteId) : null);

      if (!noteText) {
        if (existing) {
          await store.delete(existing.id);
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
        await actor?.sendQuery("WhimsyAnnotations:Render", { highlights: [] });
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
    if (rec && pageData?.title && (!rec.title || rec.title === normUrl)) {
      rec.title = pageData.title;
      gStore.saveSoon();
    }
    const highlights = rec?.highlights || [];

    let result = { anchoredIds: [], droppedIds: [] };
    try {
      const actor = browser.browsingContext?.currentWindowGlobal?.getActor(
        "WhimsyAnnotations"
      );
      if (actor) {
        const rendered = await actor.sendQuery("WhimsyAnnotations:Render", {
          highlights,
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
    const count = activeHighlights.length + (hasNote ? 1 : 0);

    if (count <= 0) {
      btn.hidden = true;
      return;
    }

    const countEl = btn.querySelector(".whimsy-annotations-button-count");
    if (countEl) {
      countEl.textContent = String(count);
    }
    btn.hidden = false;
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
    });
    const { panel, view: body } = parts;

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

    const footer = doc.createElement("div");
    footer.className = "whimsy-annotation-footer";

    const footerLeft = doc.createElement("div");
    footerLeft.className = "whimsy-annotation-footer-left";

    if (existing) {
      const delBtn = doc.createElement("button");
      delBtn.type = "button";
      delBtn.className = "whimsy-annotation-delete";
      delBtn.setAttribute("data-l10n-id", "whimsy-annotations-remove-highlight");
      delBtn.textContent = "Remove";
      delBtn.addEventListener("click", async () => {
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
      footerLeft.appendChild(delBtn);
    } else {
      const hint = doc.createElement("span");
      hint.className = "whimsy-annotation-hint";
      hint.setAttribute("data-l10n-id", "whimsy-annotations-return-hint");
      hint.textContent = "Return to save";
      footerLeft.appendChild(hint);
    }

    const footerRight = doc.createElement("div");
    footerRight.className = "whimsy-annotation-footer-right";

    const cancelBtn = doc.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "whimsy-annotation-cancel";
    cancelBtn.setAttribute("data-l10n-id", "whimsy-annotations-cancel");
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => {
      lazy.WhimsySurface.close(panel);
    });

    const saveBtn = doc.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "whimsy-annotation-save primary";
    saveBtn.setAttribute("data-l10n-id", "whimsy-annotations-save");
    saveBtn.textContent = "Save";

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

    saveBtn.addEventListener("click", commitSave);
    textarea.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        commitSave();
      } else if (event.key === "Escape") {
        event.preventDefault();
        lazy.WhimsySurface.close(panel);
      }
    });

    footerRight.append(cancelBtn, saveBtn);
    footer.append(footerLeft, footerRight);
    body.append(quoteEl, colorRow, textarea, footer);
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

    const doc = win.document;
    const btn = anchorEl || doc.getElementById(BUTTON_ID) || win.gURLBar;
    const parts = lazy.WhimsySurface.create(win, {
      id: PAGE_PANEL_ID,
      width: 320,
      titleL10nId: "whimsy-annotations-panel-title",
      close: true,
    });
    const { panel, view: body } = parts;

    const renderPanelBody = () => {
      body.replaceChildren();

      const rec = this.getPageRecord(normUrl, { win, browser });
      const activeHighlights = this._activeHighlightsForBrowser(win, browser);
      const pageNote = String(rec?.note || "");
      const totalCount = activeHighlights.length + (pageNote.trim() ? 1 : 0);

      // Header row
      const topRow = doc.createElement("div");
      topRow.className = "whimsy-annotations-panel-top";

      const titleWrap = doc.createElement("div");
      titleWrap.className = "whimsy-annotations-panel-title-wrap";

      const heading = doc.createElement("h2");
      heading.className = "whimsy-annotations-panel-heading";
      heading.setAttribute("data-l10n-id", "whimsy-annotations-panel-heading");
      heading.textContent = "Notes & highlights";

      const badge = doc.createElement("span");
      badge.className = "whimsy-annotations-panel-badge";
      badge.textContent = String(totalCount);

      titleWrap.append(heading, badge);

      const openNotesBtn = doc.createElement("button");
      openNotesBtn.type = "button";
      openNotesBtn.className = "whimsy-annotations-open-notes";
      openNotesBtn.setAttribute(
        "data-l10n-id",
        "whimsy-annotations-open-in-notes"
      );
      openNotesBtn.textContent = "Open in Notes";
      openNotesBtn.addEventListener("click", () => {
        lazy.WhimsySurface.close(panel);
        lazy.WhimsyNotesSection.openInLibrary(win);
      });

      topRow.append(titleWrap, openNotesBtn);

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

      const saveNoteNow = async () => {
        await this.setPageNote(normUrl, noteArea.value, {
          win,
          browser,
          title: browser.contentTitle || rec?.title || normUrl,
        });
        const updatedRec = this.getPageRecord(normUrl, { win, browser });
        const updatedHl = this._activeHighlightsForBrowser(win, browser);
        const newCount =
          updatedHl.length +
          (updatedRec?.note && String(updatedRec.note).trim() ? 1 : 0);
        badge.textContent = String(newCount);
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
          editBtn.className = "whimsy-annotations-item-btn whimsy-annotations-item-edit";
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
            "whimsy-annotations-item-btn whimsy-annotations-item-delete danger";
          delBtn.setAttribute("data-l10n-id", "whimsy-annotations-delete-item");
          delBtn.textContent = "Remove";
          delBtn.addEventListener("click", async event => {
            event.stopPropagation();
            await this.removeHighlight(normUrl, hl.id, { win, browser });
            const remaining = this._activeHighlightsForBrowser(win, browser);
            const currNote = this.getPageNote(normUrl, { win, browser });
            if (!remaining.length && !currNote.trim()) {
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

      // Footer
      const footer = doc.createElement("div");
      footer.className = "whimsy-annotation-footer";

      const clearBtn = doc.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "whimsy-annotation-delete whimsy-annotations-clear-page";
      clearBtn.setAttribute("data-l10n-id", "whimsy-annotations-clear-page");
      clearBtn.textContent = "Clear page";
      clearBtn.addEventListener("click", async () => {
        lazy.WhimsySurface.close(panel);
        await this.clearPage(normUrl, { win, browser });
      });

      const doneBtn = doc.createElement("button");
      doneBtn.type = "button";
      doneBtn.className = "whimsy-annotations-done primary";
      doneBtn.setAttribute("data-l10n-id", "whimsy-annotations-done");
      doneBtn.textContent = "Done";
      doneBtn.addEventListener("click", async () => {
        await saveNoteNow();
        lazy.WhimsySurface.close(panel);
      });

      footer.append(clearBtn, doneBtn);
      body.append(topRow, noteSection, hlSection, footer);
    };

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
      await notesStore.ensureLoaded();
      const notes = notesStore.list();
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
        if (since > 0 && (n.updatedAt || n.createdAt || 0) < since) {
          continue;
        }
        await notesStore.delete(n.id);
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
    await this.clearAll();
    this.lastColor = "yellow";
  },
};
