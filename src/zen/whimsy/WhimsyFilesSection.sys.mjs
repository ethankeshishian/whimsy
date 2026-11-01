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


const lazy = {};
ChromeUtils.defineESModuleGetters(
  lazy,
  {
    BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
    FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
    PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
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

export function isPrivateCapture(browser) {
  try {
    return !browser || lazy.PrivateBrowsingUtils.isBrowserPrivate(browser) ||
      lazy.PrivateBrowsingUtils.isWindowPrivate(browser.ownerDocument?.defaultView);
  } catch {
    return true; // Can't tell: keep it off disk.
  }
}

/**
 * Saves a capture into the Library's Screenshots. W10-43: Whimsy's own
 * captures (Cmd+Shift+1 full page, Capture in Portrait Mode) draw with
 * ScreenshotsUtils.createCanvas and copy themselves, so they never went
 * through copyScreenshot below and never reached the Library; they call
 * this too.
 *
 * @param {Blob} blob - the PNG
 * @param {Element} browser - the captured page's <browser>
 * @returns {Promise<string|null>} the saved file's path
 */
export async function saveCapture(blob, browser) {
  // wave9/secfix (security-full-1 M3): a private page's capture stays on
  // the clipboard only, as in Firefox (private windows, private tabs and
  // Scratch).
  if (isPrivateCapture(browser)) {
    return null;
  }
  try {
    const dir = capturesDir();
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    const path = PathUtils.join(dir, filenameFor(new Date()));
    await IOUtils.write(path, new Uint8Array(await blob.arrayBuffer()));
    Services.obs.notifyObservers(null, SAVED_TOPIC, path);
    return path;
  } catch (e) {
    console.error("Whimsy: save capture to sidebar", e);
    return null;
  }
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
    await saveCapture(blob, browser);
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

// wave9/designfix (M9): deleting a screenshot from the Library can be
// undone. The file moves to a hidden folder inside the captures folder
// (listCaptures skips folders) instead of being removed; Undo moves it
// back. Each session holds its own folder, and the next session empties
// the old ones, so a deleted screenshot is really gone after a restart.
const HOLD_PREFIX = ".deleted-";
const HOLD_NAME = `${HOLD_PREFIX}${Date.now()}`;
let purged = false;

async function purgeOldHolds(dir) {
  if (purged) {
    return;
  }
  purged = true;
  try {
    for (const child of await IOUtils.getChildren(dir)) {
      const name = PathUtils.filename(child);
      if (name.startsWith(HOLD_PREFIX) && name != HOLD_NAME) {
        await IOUtils.remove(child, { recursive: true, ignoreAbsent: true });
      }
    }
  } catch (e) {
    console.error("Whimsy: clear deleted captures", e);
  }
}

/**
 * Deletes a capture so that it can be undone.
 *
 * @param {string} path
 * @returns {Promise<{restore: () => Promise<boolean>}|null>} null if it failed
 */
export async function deleteCapture(path) {
  const dir = PathUtils.parent(path);
  const holdDir = PathUtils.join(dir, HOLD_NAME);
  const held = PathUtils.join(holdDir, PathUtils.filename(path));
  try {
    await purgeOldHolds(dir);
    await IOUtils.makeDirectory(holdDir, { ignoreExisting: true });
    await IOUtils.move(path, held);
  } catch (e) {
    console.error("Whimsy: delete capture", e);
    return null;
  }
  Services.obs.notifyObservers(null, SAVED_TOPIC);
  return {
    held,
    async restore() {
      try {
        await IOUtils.move(held, path, { noOverwrite: true });
      } catch (e) {
        console.error("Whimsy: restore capture", e);
        return false;
      }
      Services.obs.notifyObservers(null, SAVED_TOPIC, path);
      return true;
    },
  };
}

/** Puts a capture's image on the clipboard. */
export async function copyCapture(path) {
  const bytes = await IOUtils.read(path);
  lazy.BrowserUtils.copyImageToClipboard(bytes.buffer);
}

installCaptureHook();
