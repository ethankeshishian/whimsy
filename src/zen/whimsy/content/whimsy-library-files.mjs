/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, repeat } from "chrome://global/content/vendor/lit.all.mjs";
import { ZenLibrarySearchSection } from "moz-src:///zen/library/sections/ZenLibrarySearchSection.mjs";
const { listCaptures, deleteCapture, copyCapture } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyFilesSection.sys.mjs"
);
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  ShortcutUtils: "resource://gre/modules/ShortcutUtils.sys.mjs",
  WhimsyCaptureCard: "resource:///modules/whimsy/WhimsyCaptureCard.sys.mjs",
  WhimsyUndo: "resource:///modules/whimsy/WhimsyUndo.sys.mjs",
});
const SAVED_TOPIC = "whimsy-capture-saved";
// W10-24: thumbnails in a grid with Finder's icon-size slider.
const SIZE_PREF = "whimsy.library.screenshot-size";
// F11 (W13): the slider's stops are thumbnails per row (small, medium,
// large). They were minimum widths (96, 150, 240px), but a Library section
// is at most 308px wide (Zen's .zen-library-section), so 150 and 240 both
// came out as one full-width column: the middle and right stops looked the
// same. Columns differ at any width.
const COLUMNS = [3, 2, 1];

export class WhimsyFilesSection extends ZenLibrarySearchSection {
  static id = "whimsy-files";
  static label = "whimsy-library-files-title";

  static render(library) {
    return html`
      <whimsy-library-files-section
        class="zen-library-section"
        data-section="whimsy-files"
        .library=${library}
      ></whimsy-library-files-section>
    `;
  }

  static properties = { files: { state: true }, size: { state: true } };

  #observer = { observe: () => this.#refresh() };
  #sizeObserver = () => {
    this.size = this.#readSize();
  };

  constructor() {
    super();
    this.files = [];
    this.size = this.#readSize();
  }

  #readSize() {
    const value = Services.prefs.getIntPref(SIZE_PREF, 1);
    return Math.min(COLUMNS.length - 1, Math.max(0, value));
  }

  connectedCallback() {
    super.connectedCallback();
    Services.obs.addObserver(this.#observer, SAVED_TOPIC);
    Services.prefs.addObserver(SIZE_PREF, this.#sizeObserver);
    this.#refresh();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    Services.obs.removeObserver(this.#observer, SAVED_TOPIC);
    Services.prefs.removeObserver(SIZE_PREF, this.#sizeObserver);
    this.#menu?.hidePopup();
    this.#menu?.remove();
    this.#menu = null;
  }

  #refresh() {
    this.files = listCaptures();
  }

  get searchPlaceholderL10nId() {
    return "whimsy-library-files-search-placeholder";
  }

  onSearchChanged() {
    this.requestUpdate();
  }

  #open(file) {
    try {
      new lazy.FileUtils.File(file.path).launch();
    } catch (e) {
      console.error("Whimsy: open capture", e);
    }
  }

  #reveal(file) {
    try {
      new lazy.FileUtils.File(file.path).reveal();
    } catch (e) {
      console.error("Whimsy: reveal capture", e);
    }
  }

  // wave9/designfix (M9): Delete can be undone, from the toast or with
  // Cmd+Z, like Arc's "Deleted · Undo"; it was one click to lose the file.
  async #remove(file) {
    const deleted = await deleteCapture(file.path);
    this.#refresh();
    if (!deleted) {
      return;
    }
    const win = this.documentGlobal;
    lazy.WhimsyUndo.showToast(
      win,
      "whimsy-library-files-deleted-toast",
      { type: "library-delete", undo: () => deleted.restore() },
      undefined,
      { detail: file.leafName }
    );
  }

  async #copy(file) {
    try {
      await copyCapture(file.path);
      this.documentGlobal.gZenUIManager?.showToast("whimsy-library-files-copied-toast");
    } catch (e) {
      console.error("Whimsy: copy capture", e);
    }
  }

  // W15: the screenshot editor on this file (Save replaces it, Save Copy
  // adds one).
  #edit(file) {
    lazy.WhimsyCaptureCard.openLibraryEditor(this.documentGlobal, file.path)
      .catch(e => console.error("Whimsy: edit capture", e));
  }

  // wave9/designfix (M9): right-click opens a menu (Open, Edit, Show in
  // Finder, Copy, Delete), as Finder and Arc's Library do; it used to
  // reveal the file at once.
  #menu = null;
  #menuFile = null;

  #buildMenu() {
    const doc = this.ownerDocument;
    const menu = this.documentGlobal.MozXULElement.parseXULToFragment(`
      <menupopup class="whimsy-library-files-menu">
        <menuitem data-action="open" data-l10n-id="whimsy-library-files-menu-open"/>
        <menuitem data-action="edit" data-l10n-id="whimsy-library-files-menu-edit"/>
        <menuitem data-action="reveal" data-l10n-id="whimsy-library-files-menu-reveal"/>
        <menuitem data-action="copy" data-l10n-id="whimsy-library-files-menu-copy"/>
        <menuseparator/>
        <menuitem data-action="delete" data-l10n-id="whimsy-library-files-menu-delete"/>
      </menupopup>
    `).firstElementChild;
    menu.addEventListener("command", event => {
      const file = this.#menuFile;
      if (!file) {
        return;
      }
      switch (event.target.dataset.action) {
        case "open":
          this.#open(file);
          break;
        case "edit":
          this.#edit(file);
          break;
        case "reveal":
          this.#reveal(file);
          break;
        case "copy":
          this.#copy(file);
          break;
        case "delete":
          this.#remove(file);
          break;
      }
    });
    menu.addEventListener("popuphidden", event => {
      if (event.target == menu) {
        this.querySelector(".whimsy-library-shot[menu-open]")?.removeAttribute("menu-open");
        this.#menuFile = null;
      }
    });
    doc.getElementById("mainPopupSet").appendChild(menu);
    return menu;
  }

  #openMenu(file, row, event) {
    this.#menu ??= this.#buildMenu();
    this.querySelector(".whimsy-library-shot[menu-open]")?.removeAttribute("menu-open");
    this.#menuFile = file;
    row.setAttribute("menu-open", "true");
    this.#menu.openPopupAtScreen(event.screenX, event.screenY, true, event);
  }

  #renderFile(file) {
    const query = this.searchQuery.toLowerCase();
    if (query && !file.leafName.toLowerCase().includes(query)) {
      return "";
    }
    const url = Services.io.newFileURI(file).spec;
    // The editor's Save replaces the file: a new address shows the new image.
    const src = `${url}?v=${file.lastModifiedTime}`;
    return html`
      <div class="whimsy-library-shot-cell">
        <button
          class="whimsy-library-shot"
          draggable="true"
          title=${file.leafName}
          @click=${() => this.#open(file)}
          @dragstart=${event => {
            event.dataTransfer.setData("text/uri-list", url);
            event.dataTransfer.setData("text/plain", file.path);
            event.dataTransfer.effectAllowed = "copyLink";
          }}
          @contextmenu=${event => {
            event.preventDefault();
            this.#openMenu(file, event.currentTarget, event);
          }}
        >
          <img class="whimsy-library-shot-image" src=${src} alt="" loading="lazy" />
          <span class="whimsy-library-shot-name">${file.leafName}</span>
        </button>
        <div class="whimsy-library-shot-tools">
          <toolbarbutton
            class="toolbarbutton-1 whimsy-library-shot-edit"
            data-l10n-id="whimsy-library-files-edit"
            @click=${event => {
              event.stopPropagation();
              this.#edit(file);
            }}
          >
            <img class="toolbarbutton-icon" src="chrome://browser/skin/zen-icons/sliders.svg" alt="" />
          </toolbarbutton>
          <toolbarbutton
            class="toolbarbutton-1 whimsy-library-shot-delete"
            data-l10n-id="whimsy-library-files-delete"
            @click=${event => {
              event.stopPropagation();
              this.#remove(file);
            }}
          >
            <img class="toolbarbutton-icon" src="chrome://browser/skin/zen-icons/trash.svg" alt="" />
          </toolbarbutton>
        </div>
      </div>
    `;
  }

  // Capture's shortcut as it's bound now (⇧⌘2 by default).
  #captureKey() {
    const keyEl = this.ownerDocument.getElementById("key_whimsyScreenshotArc");
    try {
      if (keyEl && !keyEl.hasAttribute("disabled")) {
        return lazy.ShortcutUtils.prettifyShortcut(keyEl);
      }
    } catch (e) {}
    return Services.appinfo.OS == "Darwin" ? "⇧⌘2" : "Ctrl+Shift+2";
  }

  #setSize(value) {
    const size = Math.min(COLUMNS.length - 1, Math.max(0, Number(value) || 0));
    this.size = size;
    Services.prefs.setIntPref(SIZE_PREF, size);
  }

  renderItems() {
    if (!this.files.length) {
      const key = this.#captureKey();
      return html`<div class="zen-library-empty whimsy-library-shots-empty">
        <span data-l10n-id="whimsy-library-files-empty"></span>
        <span class="whimsy-library-shots-hint" data-l10n-id="whimsy-library-files-empty-hint"
          data-l10n-args=${JSON.stringify({ key })}></span>
      </div>`;
    }
    return html`
      <div class="whimsy-library-shots-bar">
        <img class="whimsy-library-shots-glyph" src="chrome://browser/skin/zen-icons/selectable/image.svg" alt="" />
        <input
          type="range"
          class="whimsy-library-shot-size"
          min="0"
          max="2"
          step="1"
          .value=${String(this.size)}
          data-l10n-id="whimsy-library-shot-size"
          @input=${event => this.#setSize(event.target.value)}
        />
        <img class="whimsy-library-shots-glyph whimsy-library-shots-glyph-large"
          src="chrome://browser/skin/zen-icons/selectable/image.svg" alt="" />
      </div>
      <div class="whimsy-library-shots" style=${`--whimsy-shot-columns: ${COLUMNS[this.size]}`}>
        ${repeat(this.files, f => f.path, f => this.#renderFile(f))}
      </div>
    `;
  }
}

customElements.define("whimsy-library-files-section", WhimsyFilesSection);
