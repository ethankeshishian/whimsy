/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// browser-chrome loads only head.js automatically; load this suite explicitly.
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_whimsy_dark_pages.js",
  this
);

add_task(async function match_whimsy_screenshots() {
  await SpecialPowers.pushPrefEnv({ set: [[MODE, "match"]] });
  try {
    await whimsyBothSchemes("w24-darkpages-match", async dark => {
      const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
      await darkState(tab.linkedBrowser, dark ? "generated" : "original");
      return () => BrowserTestUtils.removeTab(tab);
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});
