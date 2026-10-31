/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Screenshot to sidebar (whimsy.feature.screenshot-sidebar): every capture
// path funnels through ScreenshotsUtils.copyScreenshot before it reaches
// the clipboard, so wrapping that one method also lands a PNG file in the
// Library, not just the clipboard.

const { listCaptures } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyFilesSection.sys.mjs"
);
const { ScreenshotsUtils } = ChromeUtils.importESModule(
  "moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs"
);

function getLibrary() {
  return window.document.querySelector("zen-library");
}

function capturesDir() {
  const sub = Services.prefs.getStringPref("whimsy.captures.folder", "") || "whimsy-captures";
  return PathUtils.join(PathUtils.profileDir, sub);
}

add_task(async function test_copy_screenshot_also_saves_a_file() {
  const before = listCaptures().length;

  const canvas = new OffscreenCanvas(4, 4);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "red";
  ctx.fillRect(0, 0, 4, 4);
  const blob = await canvas.convertToBlob();

  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  registerCleanupFunction(() => BrowserTestUtils.removeTab(tab));

  const actor = ScreenshotsUtils.getActor(tab.linkedBrowser);
  // copyScreenshot consumes telemetry from the active capture overlay.
  await actor.sendQuery("Screenshots:ShowOverlay");
  try {
    await ScreenshotsUtils.copyScreenshot(blob, tab.linkedBrowser, "OverlayCopy");
  } finally {
    await actor.sendQuery("Screenshots:HideOverlay");
  }

  await TestUtils.waitForCondition(
    () => listCaptures().length > before,
    "copyScreenshot also wrote a file, not only the clipboard"
  );

  const files = listCaptures();
  ok(
    Services.clipboard.hasDataMatchingFlavors(["image/png"], Services.clipboard.kGlobalClipboard),
    "The clipboard still gets the usual copy"
  );

  // Clean up every file this test added.
  for (const file of files) {
    if (file.leafName.startsWith("whimsy-capture-")) {
      try {
        file.remove(false);
      } catch {
        // Already gone.
      }
    }
  }
});

add_task(async function test_switch_off_removes_the_tab() {
  const lib = getLibrary();
  if (!lib) {
    ok(true, "No <zen-library> in this window; nothing to check");
    return;
  }
  ok("whimsy-files" in lib.zenLibrarySections, "Files is in the Library rail by default");

  Services.prefs.setBoolPref("whimsy.feature.screenshot-sidebar", false);
  registerCleanupFunction(() => Services.prefs.clearUserPref("whimsy.feature.screenshot-sidebar"));
  await TestUtils.waitForCondition(
    () => !("whimsy-files" in lib.zenLibrarySections),
    "Turning the switch off removes the tab"
  );

  Services.prefs.setBoolPref("whimsy.feature.screenshot-sidebar", true);
  await TestUtils.waitForCondition(() => "whimsy-files" in lib.zenLibrarySections, "Turning it back on restores the tab");
});

add_task(async function test_listing_never_throws() {
  const result = listCaptures();
  ok(Array.isArray(result), "listCaptures always returns an array, even before the folder exists");
  info(`captures dir: ${capturesDir()}`);
});

// wave9/designfix (M9): Delete can be undone, and right-click opens a menu
// (Open, Show in Finder, Copy, Delete) instead of revealing the file.
add_task(async function test_delete_undo_and_menu() {
  const lib = getLibrary();
  if (!lib) {
    ok(true, "No <zen-library> in this window; nothing to check");
    return;
  }
  const { WhimsyToast } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyToast.sys.mjs");
  const dir = capturesDir();
  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  const canvas = new OffscreenCanvas(4, 4);
  canvas.getContext("2d").fillRect(0, 0, 4, 4);
  const bytes = new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer());
  const path = PathUtils.join(dir, "whimsy-capture-undo-test.png");
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
    [...section.querySelectorAll(".zen-library-row")].find(r => r.textContent.includes("whimsy-capture-undo-test"));
  let row = await TestUtils.waitForCondition(findRow, "The screenshot has a row");

  // Right-click: a menu, nothing revealed.
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, screenX: 100, screenY: 100 }));
  const menu = await TestUtils.waitForCondition(() => document.querySelector(".whimsy-library-files-menu"), "A menu");
  if (menu.state != "open") {
    await BrowserTestUtils.waitForPopupEvent(menu, "shown");
  }
  const actions = [...menu.querySelectorAll("menuitem")].map(i => i.dataset.action);
  Assert.deepEqual(actions, ["open", "reveal", "copy", "delete"], "Open, Show in Finder, Copy, Delete");
  for (const item of menu.querySelectorAll("menuitem")) {
    ok(item.getAttribute("label"), `${item.dataset.action} has a label`);
  }
  ok(row.hasAttribute("menu-open"), "The row shows it has the menu");

  // Copy puts the image on the clipboard.
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(menu.querySelector('[data-action="copy"]'));
  await hidden;
  await TestUtils.waitForCondition(
    () => Services.clipboard.hasDataMatchingFlavors(["image/png"], Services.clipboard.kGlobalClipboard),
    "Copy puts the image on the clipboard"
  );

  // Delete from the trash button: the file goes, a toast offers Undo.
  row = findRow();
  row.querySelector('toolbarbutton[data-l10n-id="whimsy-library-files-delete"]').click();
  await TestUtils.waitForCondition(async () => !(await IOUtils.exists(path)), "Delete takes the file away");
  await TestUtils.waitForCondition(() => !findRow(), "and its row");
  const toast = await TestUtils.waitForCondition(() => WhimsyToast.current(window), "A toast says so");
  is(toast._messageId, "whimsy-library-files-deleted-toast", "Deleted screenshot");
  toast.querySelector(".whimsy-toast-action").click();
  await TestUtils.waitForCondition(() => IOUtils.exists(path), "Undo puts the file back");
  await TestUtils.waitForCondition(findRow, "and its row");
  Assert.deepEqual(await IOUtils.read(path), bytes, "unchanged");
  ok(!listCaptures().some(f => f.isDirectory()), "The held copy never shows as a screenshot");
});
