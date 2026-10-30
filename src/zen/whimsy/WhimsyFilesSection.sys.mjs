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
