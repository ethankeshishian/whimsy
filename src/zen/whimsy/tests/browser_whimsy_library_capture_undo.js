/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W10-43: Cmd+Shift+1 (full page) and Capture in Portrait Mode land in
// Library → Screenshots like every other capture, and Cmd+Z undoes
// deleting a screenshot there although the Library's search field has the
// keyboard (it took Cmd+Z and did nothing; only the toast's Undo worked).
// A search the person typed is still undone first, by the field.

const { listCaptures } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFilesSection.sys.mjs");
const { WhimsyPage } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPage.sys.mjs");
const { WhimsyToast } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyToast.sys.mjs");

const PAGE = "https://example.com/browser/";

function capturesDir() {
  const sub = Services.prefs.getStringPref("whimsy.captures.folder", "") || "whimsy-captures";
  return PathUtils.join(PathUtils.profileDir, sub);
}

async function newCaptures(before, capture, what) {
  const paths = new Set(before.map(f => f.path));
  await capture();
  await TestUtils.waitForCondition(() => listCaptures().some(f => !paths.has(f.path)), what);
  const added = listCaptures().filter(f => !paths.has(f.path));
  is(added.length, 1, `${what}: one file`);
  for (const file of added) {
    registerCleanupFunction(() => IOUtils.remove(file.path, { ignoreAbsent: true }));
  }
  return added[0];
}

add_task(async function test_whimsy_captures_reach_the_library() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  let size;
  const full = await newCaptures(
    listCaptures(),
    async () => (size = await WhimsyPage.copyFullPageScreenshot(window)),
    "Cmd+Shift+1's full-page capture is in Library → Screenshots"
  );
  ok(size, "The capture was taken");
  ok(full.fileSize > 0, "as a PNG file");

  await newCaptures(
    listCaptures(),
    () => WhimsyPage.copyPortraitScreenshot(window),
    "Capture in Portrait Mode is there too"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_full_page_capture_from_the_key() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await newCaptures(
    listCaptures(),
    async () => {
      gBrowser.selectedBrowser.focus();
      EventUtils.synthesizeKey("1", { accelKey: true, shiftKey: true, code: "Digit1" });
    },
    "Pressing Cmd+Shift+1 saves into the Library"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_cmd_z_undoes_a_library_delete() {
  const lib = document.querySelector("zen-library");
  ok(lib, "The window has its Library");
  const dir = capturesDir();
  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  const canvas = new OffscreenCanvas(4, 4);
  canvas.getContext("2d").fillRect(0, 0, 4, 4);
  const bytes = new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer());
  const path = PathUtils.join(dir, "whimsy-capture-cmdz-test.png");
  await IOUtils.write(path, bytes);
  registerCleanupFunction(() => IOUtils.remove(path, { ignoreAbsent: true }));
  Services.obs.notifyObservers(null, "whimsy-capture-saved", path);

  const wasOpen = lib.constructor.isLibraryOpen;
  await TestUtils.waitForCondition(() => lib.zenLibrarySections["whimsy-files"]);
  lib.activeTab = "whimsy-files";
  await lib.constructor.animateProgress(1);
  registerCleanupFunction(() => lib.constructor.animateProgress(wasOpen ? 1 : 0));
  const section = await TestUtils.waitForCondition(() => lib.querySelector("whimsy-library-files-section"));
  const findRow = () =>
    [...section.querySelectorAll(".zen-library-row")].find(r => r.textContent.includes("whimsy-capture-cmdz-test"));
  const search = await TestUtils.waitForCondition(() => section.querySelector(".zen-library-search-box input"));

  // As when the Library opens: the keyboard is in the search field.
  section.focusSearch();
  is(document.activeElement, search, "The search field has the keyboard");
  await TestUtils.waitForCondition(findRow, "The screenshot has a row");
  findRow().querySelector('toolbarbutton[data-l10n-id="whimsy-library-files-delete"]').click();
  await TestUtils.waitForCondition(async () => !(await IOUtils.exists(path)), "Deleted");
  await TestUtils.waitForCondition(() => WhimsyToast.current(window)?._messageId == "whimsy-library-files-deleted-toast");
  search.focus();
  EventUtils.synthesizeKey("z", { accelKey: true });
  await TestUtils.waitForCondition(() => IOUtils.exists(path), "Cmd+Z in the Library puts the file back");
  await TestUtils.waitForCondition(findRow, "and its row");
  ok(!WhimsyToast.current(window) || WhimsyToast.current(window)._messageId != "whimsy-library-files-deleted-toast",
    "The Undo toast went with it");

  // Typed a search, then deleted: the first Cmd+Z undoes the typing, the
  // second the delete.
  search.focus();
  EventUtils.sendString("cmdz");
  is(search.value, "cmdz", "Typed a search");
  await TestUtils.waitForCondition(findRow, "The search still finds it");
  findRow().querySelector('toolbarbutton[data-l10n-id="whimsy-library-files-delete"]').click();
  await TestUtils.waitForCondition(async () => !(await IOUtils.exists(path)), "Deleted again");
  search.focus();
  EventUtils.synthesizeKey("z", { accelKey: true });
  await TestUtils.waitForCondition(() => search.value != "cmdz", "The first Cmd+Z undoes the typing");
  ok(!(await IOUtils.exists(path)), "and leaves the screenshot deleted");
  // Undo until the field has nothing left to undo, then the delete.
  for (let i = 0; i < 8 && !(await IOUtils.exists(path)); i++) {
    EventUtils.synthesizeKey("z", { accelKey: true });
    await new Promise(r => setTimeout(r, 50));
  }
  await TestUtils.waitForCondition(() => IOUtils.exists(path), "Then Cmd+Z undoes the delete");
  is(search.value, "", "with the search empty again");
  Assert.deepEqual(await IOUtils.read(path), bytes, "The file is unchanged");
});
