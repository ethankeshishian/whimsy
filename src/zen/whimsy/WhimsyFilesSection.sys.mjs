/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// batch10: Screenshot to sidebar (Arc's Easel, minus the canvas). Firefox
// Screenshots (browser/components/screenshots/ScreenshotsUtils.sys.mjs) only
// ever puts a capture on the clipboard, where the next copy overwrites it.
// This wraps ScreenshotsUtils.copyScreenshot - the one method every capture
// path (region, element, full page; the overlay's own Copy button and
// batch5's full-page-copy command alike) already funnels through before
// setting the clipboard - so every capture also lands as a PNG file the
// user can drag into a doc, Slack or a folder later. The capture folder
// itself is the only store; nothing is indexed separately.

import { html, repeat } from "chrome://global/content/vendor/lit.all.mjs";
import { ZenLibrarySearchSection } from "moz-src:///zen/library/sections/ZenLibrarySearchSection.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(
  lazy,
  {
    FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
    ScreenshotsUtils: "moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs",
  },
  { global: "current" }
);

const FOLDER_PREF = "whimsy.captures.folder";
const DEFAULT_SUBDIR = "whimsy-captures";
const SAVED_TOPIC = "whimsy-capture-saved";

function capturesDir() {
  const sub = Services.prefs.getStringPref(FOLDER_PREF, "") || DEFAULT_SUBDIR;
  return PathUtils.join(PathUtils.profileDir, sub);
}

function filenameFor(date) {
  return `whimsy-capture-${date.toISOString().replace(/[:.]/g, "-")}.png`;
}

let installed = false;
function installCaptureHook() {
  if (installed) {
    return;
  }
  installed = true;
  const original = lazy.ScreenshotsUtils.copyScreenshot;
  lazy.ScreenshotsUtils.copyScreenshot = async function (blob, browser, eventName) {
    await original.call(this, blob, browser, eventName);
    try {
      const dir = capturesDir();
      await IOUtils.makeDirectory(dir, { ignoreExisting: true });
      const path = PathUtils.join(dir, filenameFor(new Date()));
      await IOUtils.write(path, new Uint8Array(await blob.arrayBuffer()));
      Services.obs.notifyObservers(null, SAVED_TOPIC, path);
    } catch (e) {
      console.error("Whimsy: save capture to sidebar", e);
    }
  };
}

/** @returns {nsIFile[]} Saved captures, newest first */
export function listCaptures() {
  try {
    const dir = new lazy.FileUtils.File(capturesDir());
    if (!dir.exists()) {
      return [];
    }
    const files = [];
    const iter = dir.directoryEntries;
    while (iter.hasMoreElements()) {
      const entry = iter.nextFile;
      if (!entry.isDirectory() && /\.png$/i.test(entry.leafName)) {
        files.push(entry);
      }
    }
    files.sort((a, b) => b.lastModifiedTime - a.lastModifiedTime);
    return files;
  } catch {
    return [];
  }
}

installCaptureHook();

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
