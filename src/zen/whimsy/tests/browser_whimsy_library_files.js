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

// copyScreenshot (Firefox's own) remembers which button was last used.
add_setup(function () {
  const PREF = "screenshots.browser.component.last-saved-method";
  const hadUserValue = Services.prefs.prefHasUserValue(PREF);
  const value = hadUserValue ? Services.prefs.getStringPref(PREF) : undefined;
  registerCleanupFunction(() => {
    if (hadUserValue) {
      Services.prefs.setStringPref(PREF, value);
    } else {
      Services.prefs.clearUserPref(PREF);
    }
  });
});

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
  // animateProgress resolves as the spring starts; clicks wait for it to
  // settle, as a person's would.
  await TestUtils.waitForCondition(() => lib.openProgress == 1 && !lib.hasAttribute("transitioning"),
    "The Library has finished sliding in");
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

// W10-24: real thumbnails in a grid with Finder's size slider, remembered.
// F11 (W13): each stop draws a different size. The stops were minimum
// widths (96/150/240px); in the Library's ~280px grid the middle and right
// ones both came out as one full-width column. Real clicks on the slider's
// left end, middle and right end; the thumbnail must shrink at each step.
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
  // animateProgress resolves as the spring starts; clicks wait for it to
  // settle, as a person's would.
  await TestUtils.waitForCondition(() => lib.openProgress == 1 && !lib.hasAttribute("transitioning"),
    "The Library has finished sliding in");
  const section = await TestUtils.waitForCondition(() => lib.querySelector("whimsy-library-files-section"));
  const cell = await TestUtils.waitForCondition(() =>
    [...section.querySelectorAll(".whimsy-library-shot-cell")].find(c => c.textContent.includes("whimsy-capture-grid-test")),
  "The screenshot has a tile");
  const image = cell.querySelector("img.whimsy-library-shot-image");
  ok(image.src.endsWith("whimsy-capture-grid-test.png"), "The tile shows the screenshot itself");
  is(getComputedStyle(section.querySelector(".whimsy-library-shots")).display, "grid", "in a grid");

  const slider = section.querySelector("input.whimsy-library-shot-size");
  ok(slider, "A size slider");
  is(slider.min, "0", "Three stops: 0");
  is(slider.max, "2", "...to 2");
  is(slider.step, "1", "...one apart");
  const grid = section.querySelector(".whimsy-library-shots");
  // A real click on the slider's track, at a share of its width.
  const clickAt = async (share, value) => {
    const rect = slider.getBoundingClientRect();
    const x = Math.min(rect.width - 1, Math.max(1, Math.round(rect.width * share)));
    EventUtils.synthesizeMouse(slider, x, rect.height / 2, {}, window);
    await TestUtils.waitForCondition(() => slider.value == String(value), `The click puts the slider on ${value}`);
    await TestUtils.waitForCondition(() => grid.style.getPropertyValue("--whimsy-shot-columns") == String([3, 2, 1][value]),
      `Stop ${value}: ${[3, 2, 1][value]} per row`);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    is(Services.prefs.getIntPref("whimsy.library.screenshot-size"), value, `Stop ${value} is remembered`);
    return image.getBoundingClientRect().width;
  };
  const small = await clickAt(0, 0);
  const medium = await clickAt(0.5, 1);
  const large = await clickAt(1, 2);
  info(`Thumbnail widths: ${small} / ${medium} / ${large}px in a ${grid.clientWidth}px grid`);
  Assert.greater(small, 40, "Small thumbnails are still big enough to see");
  Assert.less(small, medium * 0.77, "Small is clearly smaller than medium");
  Assert.less(medium, large * 0.77, "Medium is clearly smaller than large (the F11 bug: they were the same)");
  Assert.lessOrEqual(large, grid.clientWidth + 0.5, "Large fits the grid");
  const cells = [...section.querySelectorAll(".whimsy-library-shot-cell")];
  const lefts = new Set(cells.map(c => Math.round(c.getBoundingClientRect().left)));
  is(lefts.size, 1, "Large: one per row");

  // Back down with the keyboard: the slider steps to medium.
  slider.focus();
  EventUtils.synthesizeKey("KEY_ArrowLeft", {}, window);
  await TestUtils.waitForCondition(() => slider.value == "1", "Left arrow steps to medium");
  await TestUtils.waitForCondition(() => Math.abs(image.getBoundingClientRect().width - medium) < 1, "...the medium size again");
});
