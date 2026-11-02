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
    [...section.querySelectorAll(".whimsy-library-shot-cell")].find(r => r.textContent.includes("whimsy-capture-undo-test"));
  let row = await TestUtils.waitForCondition(findRow, "The screenshot has a row");

  // Right-click: a menu, nothing revealed.
  row.querySelector(".whimsy-library-shot").dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, screenX: 100, screenY: 100 }));
  const menu = await TestUtils.waitForCondition(() => document.querySelector(".whimsy-library-files-menu"), "A menu");
  if (menu.state != "open") {
    await BrowserTestUtils.waitForPopupEvent(menu, "shown");
  }
  const actions = [...menu.querySelectorAll("menuitem")].map(i => i.dataset.action);
  Assert.deepEqual(actions, ["open", "reveal", "copy", "delete"], "Open, Show in Finder, Copy, Delete");
  for (const item of menu.querySelectorAll("menuitem")) {
    ok(item.getAttribute("label"), `${item.dataset.action} has a label`);
  }
  ok(row.querySelector(".whimsy-library-shot").hasAttribute("menu-open"), "The thumbnail shows it has the menu");

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
  const toast = await TestUtils.waitForCondition(() => currentToast(), "A toast says so");
  is(toast.messageId, "whimsy-library-files-deleted-toast", "Deleted screenshot");
  toast.element.querySelector(".whimsy-toast-button").click();
  await TestUtils.waitForCondition(() => IOUtils.exists(path), "Undo puts the file back");
  await TestUtils.waitForCondition(findRow, "and its row");
  Assert.deepEqual(await IOUtils.read(path), bytes, "unchanged");
  ok(!listCaptures().some(f => f.isDirectory()), "The held copy never shows as a screenshot");
});

// W10-24: real thumbnails in a grid; Finder's size slider sets 96, 150 or
// 240px columns and is remembered.
add_task(async function test_thumbnail_grid_and_size() {
  const lib = getLibrary();
  if (!lib) {
    ok(true, "No <zen-library> in this window; nothing to check");
    return;
  }
  const dir = capturesDir();
  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  const canvas = new OffscreenCanvas(320, 200);
  canvas.getContext("2d").fillRect(0, 0, 320, 200);
  const path = PathUtils.join(dir, "whimsy-capture-grid-test.png");
  await IOUtils.write(path, new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer()));
  registerCleanupFunction(() => IOUtils.remove(path, { ignoreAbsent: true }));
  registerCleanupFunction(() => Services.prefs.clearUserPref("whimsy.library.screenshot-size"));
  Services.obs.notifyObservers(null, "whimsy-capture-saved", path);

  const wasOpen = lib.constructor.isLibraryOpen;
  await TestUtils.waitForCondition(() => lib.zenLibrarySections["whimsy-files"]);
  lib.activeTab = "whimsy-files";
  await lib.constructor.animateProgress(1);
  registerCleanupFunction(() => lib.constructor.animateProgress(wasOpen ? 1 : 0));
  const section = await TestUtils.waitForCondition(() => lib.querySelector("whimsy-library-files-section"));
  const cell = await TestUtils.waitForCondition(() =>
    [...section.querySelectorAll(".whimsy-library-shot-cell")].find(c => c.textContent.includes("whimsy-capture-grid-test")),
  "The screenshot has a tile");
  const image = cell.querySelector("img.whimsy-library-shot-image");
  ok(image.src.endsWith("whimsy-capture-grid-test.png"), "The tile shows the screenshot itself");
  is(getComputedStyle(section.querySelector(".whimsy-library-shots")).display, "grid", "in a grid");

  const slider = section.querySelector("input.whimsy-library-shot-size");
  ok(slider, "A size slider");
  const setSize = async value => {
    slider.value = String(value);
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    await TestUtils.waitForCondition(() =>
      section.querySelector(".whimsy-library-shots").style.getPropertyValue("--whimsy-shot-size") ==
        `${[96, 150, 240][value]}px`, `Size ${value}`);
  };
  await setSize(0);
  Assert.greaterOrEqual(image.getBoundingClientRect().width, 95, "Small thumbnails are still at least 96px");
  await setSize(2);
  is(Services.prefs.getIntPref("whimsy.library.screenshot-size"), 2, "The size is remembered");
  ok(getComputedStyle(section.querySelector(".whimsy-library-shots")).gridTemplateColumns.split(" ")
    .every(w => parseFloat(w) >= 239), "Large: columns at least 240px");
});
