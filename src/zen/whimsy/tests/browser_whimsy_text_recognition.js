/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W30: text in images is recognized on Whimsy's own queue instead of
// Gecko's background-IO pool. This runs the real macOS recognizer (no
// stand-in) on a sign with known words and checks the words come back.
// The first recognition in a fresh browser waits on macOS compiling the
// text model, which can take over a minute, hence the longer timeout. Where
// the accurate model fails outright (macOS 27.0.1), the read falls back to
// the fast level, and this checks that path returns the words too.

requestLongerTimeout(10);

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = `${ROOT}whimsy_image_text.html?img=en`;

add_setup(async () => {
  // The page's own reader stays out of it; this test calls the recognizer.
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.image-text", false]] });
});

add_task(async function text_in_an_image_is_recognized() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const img = content.document.getElementById("photo");
    if (!img.complete || !img.naturalWidth) {
      await new Promise(resolve => img.addEventListener("load", resolve, { once: true }));
    }
    await img.decode();
  });
  info("sign decoded; recognizing (the first read waits on the model compile)");
  const started = Date.now();
  try {
    const lines = await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
      const quads = await content.document.getElementById("photo").recognizeCurrentImageText();
      return quads.map(q => q.string);
    });
    info(`recognized in ${Date.now() - started} ms: ${JSON.stringify(lines)}`);
    const text = lines.join(" ");
    ok(/hoshino/i.test(text), "the sign's name is read");
    ok(/tea\s*house/i.test(text), "the rest of the name is read");
    ok(/1887/.test(text), "the year is read");
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});
