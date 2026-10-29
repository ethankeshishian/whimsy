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

  await ScreenshotsUtils.copyScreenshot(blob, tab.linkedBrowser, "whimsyTest");

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
