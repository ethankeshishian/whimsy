/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Finder folders in the sidebar (whimsy.feature.finder-folders): pin a
// folder with the native picker, browse its contents without a second app.
// Listing is a flat nsIFile.directoryEntries walk (nsIZenLibraryFiles'
// scanMedia is for the media grid's extension filter and matches nothing
// with an empty one), plus nsIZenLibraryFiles.isCloudPlaceholder for the
// one piece that needs the native service.

const { gWhimsyFinderFoldersStore, listFolderEntries } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyFinderFoldersSection.sys.mjs"
);

function getLibrary() {
  return window.document.querySelector("zen-library");
}

add_task(async function test_list_three_files() {
  const dir = Services.dirsvc.get("TmpD", Ci.nsIFile);
  dir.append("whimsy-finder-folders-test");
  dir.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  registerCleanupFunction(() => dir.remove(true));

  for (const name of ["a.txt", "b.txt", "c.txt"]) {
    const file = dir.clone();
    file.append(name);
    file.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
  }
  const subdir = dir.clone();
  subdir.append("sub");
  subdir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);

  const entries = listFolderEntries(dir.path);
  is(entries.length, 4, "Three files and one folder are listed");
  ok(entries[0].isDirectory(), "Folders sort before files");
  const names = entries.map(e => e.leafName).sort();
  Assert.deepEqual(names, ["a.txt", "b.txt", "c.txt", "sub"], "Every entry is listed");
});

add_task(async function test_empty_and_missing_folder() {
  Assert.deepEqual(listFolderEntries("/does/not/exist"), [], "A missing folder lists as empty, not an error");

  const dir = Services.dirsvc.get("TmpD", Ci.nsIFile);
  dir.append("whimsy-finder-folders-empty-test");
  dir.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  registerCleanupFunction(() => dir.remove(true));
  Assert.deepEqual(listFolderEntries(dir.path), [], "An empty folder lists as empty");
});

add_task(async function test_store_add_remove() {
  const path = "/tmp/whimsy-pinned-test-folder";
  await gWhimsyFinderFoldersStore.add(path);
  let list = await gWhimsyFinderFoldersStore.list();
  ok(list.includes(path), "A pinned folder's path is stored");

  await gWhimsyFinderFoldersStore.add(path);
  list = await gWhimsyFinderFoldersStore.list();
  is(list.filter(p => p == path).length, 1, "Pinning the same folder twice doesn't duplicate it");

  await gWhimsyFinderFoldersStore.remove(path);
  list = await gWhimsyFinderFoldersStore.list();
  ok(!list.includes(path), "Unpinning removes it");
});

add_task(async function test_switch_off_removes_the_tab() {
  const lib = getLibrary();
  if (!lib) {
    ok(true, "No <zen-library> in this window; nothing to check");
    return;
  }
  ok("whimsy-finder-folders" in lib.zenLibrarySections, "Finder folders is in the Library rail by default");

  Services.prefs.setBoolPref("whimsy.feature.finder-folders", false);
  registerCleanupFunction(() => Services.prefs.clearUserPref("whimsy.feature.finder-folders"));
  await TestUtils.waitForCondition(
    () => !("whimsy-finder-folders" in lib.zenLibrarySections),
    "Turning the switch off removes the tab"
  );

  Services.prefs.setBoolPref("whimsy.feature.finder-folders", true);
  await TestUtils.waitForCondition(
    () => "whimsy-finder-folders" in lib.zenLibrarySections,
    "Turning it back on restores the tab"
  );
});
