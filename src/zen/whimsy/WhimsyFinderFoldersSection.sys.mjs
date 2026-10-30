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
