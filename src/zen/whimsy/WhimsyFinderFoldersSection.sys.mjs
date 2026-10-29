/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// batch10: Finder folders in the sidebar (Arc parity). Arc lets you pin a
// Finder folder into the sidebar and browse it without leaving the browser -
// handy for a folder of reference files or project assets dragged into web
// forms constantly. "Add folder" picks a folder with the native picker;
// listing is a plain, non-recursive nsIFile.directoryEntries walk (Zen's
// nsIZenLibraryFiles.scanMedia is built for the media grid's extension
// filter, which would match nothing with an empty list, so this uses
// nsIFile directly for the flat "every file" case and only reaches for
// nsIZenLibraryFiles.isCloudPlaceholder, the one piece that needs it).
// There's no folder-change-notification API anywhere in the engine, so an
// open section polls on an interval instead of trying to watch the folder.

import { html, repeat } from "chrome://global/content/vendor/lit.all.mjs";
import { ZenLibrarySearchSection } from "moz-src:///zen/library/sections/ZenLibrarySearchSection.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(
  lazy,
  {
    FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
    JSONFile: "resource://gre/modules/JSONFile.sys.mjs",
  },
  { global: "current" }
);

const STORE_FILENAME = "whimsy-finder-folders.json";
const POLL_MS = 15000;

class FinderFoldersStore {
  #file = null;
  #loading = null;

  async #ensureLoaded() {
    if (this.#file) {
      return this.#file;
    }
    this.#loading ??= (async () => {
      const file = new lazy.JSONFile({
        path: PathUtils.join(PathUtils.profileDir, STORE_FILENAME),
        dataPostProcessor(data) {
          if (!data || typeof data != "object" || !Array.isArray(data.folders)) {
            return { folders: [] };
          }
          return data;
        },
      });
      await file.load();
      this.#file = file;
    })();
    await this.#loading;
    return this.#file;
  }

  async list() {
    const file = await this.#ensureLoaded();
    return file.data.folders;
  }

  async add(path) {
    const file = await this.#ensureLoaded();
    if (!file.data.folders.includes(path)) {
      file.data.folders.push(path);
      file.saveSoon();
    }
  }

  async remove(path) {
    const file = await this.#ensureLoaded();
    file.data.folders = file.data.folders.filter(p => p != path);
    file.saveSoon();
  }
}

export const gWhimsyFinderFoldersStore = new FinderFoldersStore();

function cloudService() {
  try {
    return Cc["@mozilla.org/zen/library-files;1"].getService(Ci.nsIZenLibraryFiles);
  } catch {
    return null;
  }
}

/** @returns {nsIFile[]} The folder's direct children, folders first, by name */
export function listFolderEntries(path) {
  try {
    const dir = new lazy.FileUtils.File(path);
    if (!dir.exists() || !dir.isDirectory()) {
      return [];
    }
    const entries = [];
    const iter = dir.directoryEntries;
    while (iter.hasMoreElements()) {
      entries.push(iter.nextFile);
    }
    entries.sort((a, b) => {
      if (a.isDirectory() != b.isDirectory()) {
        return a.isDirectory() ? -1 : 1;
      }
      return a.leafName.localeCompare(b.leafName);
    });
    return entries;
  } catch {
    return [];
  }
}

export class WhimsyFinderFoldersSection extends ZenLibrarySearchSection {
  static id = "whimsy-finder-folders";
  static label = "whimsy-library-finder-folders-title";

  static render(library) {
    return html`
      <whimsy-library-finder-folders-section
        class="zen-library-section"
        data-section="whimsy-finder-folders"
        .library=${library}
      ></whimsy-library-finder-folders-section>
    `;
  }

  static properties = {
    folders: { state: true },
    expanded: { state: true },
  };

  #pollTimer = null;

  constructor() {
    super();
    this.folders = [];
    this.expanded = new Map();
  }

  connectedCallback() {
    super.connectedCallback();
    this.#refresh();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#stopPolling();
  }

  async onShown() {
    await super.onShown?.();
    this.#startPolling();
  }

  onHidden() {
    this.#stopPolling();
  }

  #startPolling() {
    this.#stopPolling();
    this.#pollTimer = this.ownerGlobal.setInterval(() => this.#refreshExpanded(), POLL_MS);
  }

  #stopPolling() {
    if (this.#pollTimer) {
      this.ownerGlobal.clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
  }

  async #refresh() {
    this.folders = await gWhimsyFinderFoldersStore.list();
    this.#refreshExpanded();
  }

  #refreshExpanded() {
    for (const path of this.expanded.keys()) {
      this.expanded.set(path, listFolderEntries(path));
    }
    this.requestUpdate();
  }

  get searchPlaceholderL10nId() {
    return "whimsy-library-finder-folders-search-placeholder";
  }

  onSearchChanged() {
    this.requestUpdate();
  }

  async #addFolder() {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    const [title] = await this.ownerDocument.l10n.formatValues([
      "whimsy-library-finder-folders-picker-title",
    ]);
    picker.init(this.ownerGlobal.browsingContext, title ?? "", picker.modeGetFolder);
    const result = await new Promise(resolve => picker.open(resolve));
    if ((result != picker.returnOK && result != picker.returnReplace) || !picker.file) {
      return;
    }
    await gWhimsyFinderFoldersStore.add(picker.file.path);
    await this.#refresh();
  }

  async #removeFolder(path) {
    await gWhimsyFinderFoldersStore.remove(path);
    this.expanded.delete(path);
    await this.#refresh();
  }

  #toggle(path) {
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
    } else {
      this.expanded.set(path, listFolderEntries(path));
    }
    this.requestUpdate();
  }

  #open(entry) {
    try {
      new lazy.FileUtils.File(entry.path).launch();
    } catch (e) {
      console.error("Whimsy: open finder-folder entry", e);
    }
  }

  #reveal(path) {
    try {
      new lazy.FileUtils.File(path).reveal();
    } catch (e) {
      console.error("Whimsy: reveal finder-folder entry", e);
    }
  }

  #isCloud(path) {
    try {
      return !!cloudService()?.isCloudPlaceholder(path);
    } catch {
      return false;
    }
  }

  #matches(name) {
    const query = this.searchQuery.toLowerCase();
    return !query || name.toLowerCase().includes(query);
  }

  #renderEntry(entry) {
    if (!this.#matches(entry.leafName)) {
      return "";
    }
    const isDir = entry.isDirectory();
    return html`
      <div
        class="zen-library-row"
        style="padding-inline-start: 32px"
        ?cloud-placeholder=${!isDir && this.#isCloud(entry.path)}
        draggable="true"
        @click=${() => (isDir ? this.#toggle(entry.path) : this.#open(entry))}
        @dragstart=${event => {
          event.dataTransfer.setData("text/uri-list", Services.io.newFileURI(entry).spec);
          event.dataTransfer.setData("text/plain", entry.path);
          event.dataTransfer.effectAllowed = "copyLink";
        }}
        @contextmenu=${event => {
          event.preventDefault();
          this.#reveal(entry.path);
        }}
      >
        <img class="zen-library-row-icon" src=${`moz-icon://${entry.path}?size=16`} alt="" />
        <div class="zen-library-row-text">
          <span class="zen-library-row-title">${entry.leafName}</span>
        </div>
      </div>
      ${
        isDir && this.expanded.has(entry.path)
          ? repeat(this.expanded.get(entry.path) ?? [], e => e.path, e => this.#renderEntry(e))
          : ""
      }
    `;
  }

  #renderFolder(path) {
    const name = path.split(/[\\/]/).pop() || path;
    return html`
      <div class="zen-library-group">
        <div
          class="zen-library-row"
          @click=${() => this.#toggle(path)}
          @contextmenu=${event => {
            event.preventDefault();
            this.#reveal(path);
          }}
        >
          <img class="zen-library-row-icon" src="chrome://browser/skin/zen-icons/folder.svg" alt="" />
          <div class="zen-library-row-text">
            <span class="zen-library-row-title">${name}</span>
            <span class="zen-library-row-subtitle">${path}</span>
          </div>
          <div class="zen-library-row-actions">
            <toolbarbutton
              class="toolbarbutton-1"
              data-l10n-id="whimsy-library-finder-folders-remove"
              @click=${event => {
                event.stopPropagation();
                this.#removeFolder(path);
              }}
            >
              <img class="toolbarbutton-icon" src="chrome://browser/skin/zen-icons/close.svg" alt="" />
            </toolbarbutton>
          </div>
        </div>
        ${
          this.expanded.has(path)
            ? repeat(this.expanded.get(path) ?? [], e => e.path, e => this.#renderEntry(e))
            : ""
        }
      </div>
    `;
  }

  renderItems() {
    if (!this.folders.length) {
      return html`<div
        class="zen-library-empty"
        data-l10n-id="whimsy-library-finder-folders-empty"
      ></div>`;
    }
    return repeat(this.folders, p => p, p => this.#renderFolder(p));
  }

  renderFooter() {
    return html`
      <button class="zen-library-filter-button" @click=${() => this.#addFolder()}>
        <img src="chrome://browser/skin/zen-icons/plus.svg" alt="" />
        <span data-l10n-id="whimsy-library-finder-folders-add"></span>
      </button>
    `;
  }
}

customElements.define("whimsy-library-finder-folders-section", WhimsyFinderFoldersSection);
