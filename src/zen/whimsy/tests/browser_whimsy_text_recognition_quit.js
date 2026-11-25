/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W30: text in images is recognized off Gecko's background-IO pool. A first
// recognition waits on macOS compiling the text model, and quitting while
// one was in flight hung shutdown (XPCOMShutdownThreads) until the browser
// crashed. This starts a real recognition and leaves it running (that
// first compile takes longer than a test may wait), so the test browser
// quits with it in flight; a hang there turns the run red.

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = `${ROOT}whimsy_image_text.html?img=en`;

add_setup(async () => {
  // The page's own reader stays out of it; this test calls the recognizer.
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.image-text", false]] });
});

async function decodedPhoto(browser) {
  await SpecialPowers.spawn(browser, [], async () => {
    const img = content.document.getElementById("photo");
    if (!img.complete || !img.naturalWidth) {
      await new Promise(resolve => img.addEventListener("load", resolve, { once: true }));
    }
    await img.decode();
  });
}

add_task(async function quitting_with_a_recognition_in_flight() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await decodedPhoto(tab.linkedBrowser);
  const started = await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const pending = content.document.getElementById("photo").recognizeCurrentImageText();
    // Left unawaited, so it may still be running when the browser quits.
    pending.then(
      () => {},
      () => {}
    );
    return typeof pending.then == "function";
  });
  ok(started, "a recognition is running as the test ends");
  BrowserTestUtils.removeTab(tab);
});
