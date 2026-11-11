/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// browser-chrome loads only head.js automatically; load this suite explicitly.
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_whimsy_dark_pages.js",
  this
);

add_task(async function preserves_existing_smart_invert() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await darkState(browser, "generated");
    await SpecialPowers.spawn(browser, [], () => {
      const { darkPagesInversion } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyDarkPagesConfig.sys.mjs");
      const bc = content.browsingContext;
      bc.isZenBoostsInverted = darkPagesInversion(bc, true);
    });
    try {
      WhimsyDarkPages.setChoice(browser, "off");
      await darkState(browser, "original");
      ok((await colors(browser)).inverted, "Original restores the user's existing Smart Invert");
    } finally {
      await SpecialPowers.spawn(browser, [], () => {
        const { darkPagesInversion } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyDarkPagesConfig.sys.mjs");
        const bc = content.browsingContext;
        bc.isZenBoostsInverted = darkPagesInversion(bc, false);
      });
      WhimsyDarkPages.setChoice(browser, "automatic");
    }
  });
});

add_task(async function delayed_theme_and_long_page() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await darkState(browser, "generated");
    await SpecialPowers.spawn(browser, [], () => {
      const fragment = content.document.createDocumentFragment();
      for (let i = 0; i < 5000; i++) {
        const p = content.document.createElement("p");
        p.textContent = "A contour joins points of equal height.";
        fragment.append(p);
      }
      content.document.querySelector("main").append(fragment);
      content.document.documentElement.className = "already";
    });
    await darkState(browser, "native");
    is((await colors(browser)).background, "rgb(24, 26, 32)", "Late native theme removes generated colors on a long page");
  });
});
