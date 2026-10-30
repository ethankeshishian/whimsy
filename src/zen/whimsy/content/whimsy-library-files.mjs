/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, repeat } from "chrome://global/content/vendor/lit.all.mjs";
import { ZenLibrarySearchSection } from "moz-src:///zen/library/sections/ZenLibrarySearchSection.mjs";
const { listCaptures } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFilesSection.sys.mjs");
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {"FileUtils": "resource://gre/modules/FileUtils.sys.mjs"});
const SAVED_TOPIC = "whimsy-capture-saved";

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

  static properties = { files: { state: true } };

  #observer = { observe: () => this.#refresh() };

  constructor() {
    super();
    this.files = [];
  }

  connectedCallback() {
    super.connectedCallback();
    Services.obs.addObserver(this.#observer, SAVED_TOPIC);
    this.#refresh();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    Services.obs.removeObserver(this.#observer, SAVED_TOPIC);
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

  #remove(file) {
    try {
      new lazy.FileUtils.File(file.path).remove(false);
    } catch (e) {
      console.error("Whimsy: delete capture", e);
    }
    this.#refresh();
  }

  #renderFile(file) {
    const query = this.searchQuery.toLowerCase();
    if (query && !file.leafName.toLowerCase().includes(query)) {
      return "";
    }
    const url = Services.io.newFileURI(file).spec;
    return html`
      <div
        class="zen-library-row"
        draggable="true"
        @click=${() => this.#open(file)}
        @dragstart=${event => {
          event.dataTransfer.setData("text/uri-list", url);
          event.dataTransfer.setData("text/plain", file.path);
          event.dataTransfer.effectAllowed = "copyLink";
        }}
        @contextmenu=${event => {
          event.preventDefault();
          this.#reveal(file);
        }}
      >
        <img class="zen-library-row-icon" src=${url} alt="" />
        <div class="zen-library-row-text">
          <span class="zen-library-row-title">${file.leafName}</span>
        </div>
        <div class="zen-library-row-actions">
          <toolbarbutton
            class="toolbarbutton-1"
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

  renderItems() {
    if (!this.files.length) {
      return html`<div class="zen-library-empty" data-l10n-id="whimsy-library-files-empty"></div>`;
    }
    return repeat(this.files, f => f.path, f => this.#renderFile(f));
  }
}

customElements.define("whimsy-library-files-section", WhimsyFilesSection);
