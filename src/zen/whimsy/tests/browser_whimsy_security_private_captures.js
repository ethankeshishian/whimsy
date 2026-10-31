/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9/secfix (security-full-1 M3): Whimsy keeps every copied screenshot
// as a PNG in the Library. A private page's capture (private tab, Scratch,
// private window) stays on the clipboard only, as in Firefox.

const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const { listCaptures } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFilesSection.sys.mjs");
const { ScreenshotsUtils } = ChromeUtils.importESModule("moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs");

const PAGE = "https://example.com/?secfix-m3";

async function pngBlob() {
  const canvas = new OffscreenCanvas(4, 4);
  canvas.getContext("2d").fillRect(0, 0, 4, 4);
  return canvas.convertToBlob({ type: "image/png" });
}

// Copy through Firefox Screenshots' own funnel (the one Whimsy wraps);
// only its actor round trip and telemetry are stood in for.
async function copyFrom(browser) {
  const saved = [];
  const observe = (subject, topic, path) => saved.push(path);
  Services.obs.addObserver(observe, "whimsy-capture-saved");
  const { getActor, recordTelemetryEvent } = ScreenshotsUtils;
  ScreenshotsUtils.getActor = () => ({ sendQuery: async () => ({}) });
  ScreenshotsUtils.recordTelemetryEvent = () => {};
  try {
    await ScreenshotsUtils.copyScreenshot(await pngBlob(), browser, "Test");
  } finally {
    ScreenshotsUtils.getActor = getActor;
    ScreenshotsUtils.recordTelemetryEvent = recordTelemetryEvent;
    Services.obs.removeObserver(observe, "whimsy-capture-saved");
  }
  return saved;
}

add_task(async function a_normal_capture_is_kept() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const before = listCaptures().length;
  const saved = await copyFrom(tab.linkedBrowser);
  is(saved.length, 1, "A normal page's capture is saved");
  is(listCaptures().length, before + 1, "…and listed in the Library");
  for (const path of saved) {
    await IOUtils.remove(path);
  }
  BrowserTestUtils.removeTab(tab);
});

add_task(async function a_private_tab_capture_stays_off_disk() {
  const tab = WhimsyPrivate.openPrivateTab(window, { url: PAGE, force: true });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PAGE);
  const before = listCaptures().length;
  const saved = await copyFrom(tab.linkedBrowser);
  is(saved.length, 0, "A private tab's capture isn't saved");
  is(listCaptures().length, before, "…and the Library has nothing new");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function a_private_window_capture_stays_off_disk() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  BrowserTestUtils.startLoadingURIString(win.gBrowser.selectedBrowser, PAGE);
  await BrowserTestUtils.browserLoaded(win.gBrowser.selectedBrowser, false, PAGE);
  const before = listCaptures().length;
  const saved = await copyFrom(win.gBrowser.selectedBrowser);
  is(saved.length, 0, "A private window's capture isn't saved");
  is(listCaptures().length, before, "…and the Library has nothing new");
  await BrowserTestUtils.closeWindow(win);
});
