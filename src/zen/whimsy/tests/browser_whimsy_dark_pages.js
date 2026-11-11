/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function authored_theme_then_generated_fallback() {
  await BrowserTestUtils.withNewTab(PAGE + "?theme=native", async browser => {
    await darkState(browser, "native");
    const native = await colors(browser);
    ok(native.scheme, "Gecko advertises dark to authored media queries and matchMedia");
    is(native.background, "rgb(24, 26, 32)", "Uses the site's exact dark background");
    is(native.color, "rgb(233, 230, 225)", "Uses the site's exact dark text");
    is(native.photo, "none", "Native-theme photos are untouched");
    ok(!native.inverted, "Native dark theme never enables inversion");
  });
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await darkState(browser, "generated");
    const generated = await colors(browser);
    ok(generated.scheme, "Native dark was requested before generating colors");
    ok(generated.startScheme, "The first parser script already sees the dark preference");
    is(generated.startCanvas, "rgb(28, 27, 34)", "A dark document-start canvas prevents the initial white flash");
    ok(generated.inverted, "Reuses the existing Zen Boosts paint-time engine");
    const kept = await SpecialPowers.spawn(browser, [], () => {
      const { darkPagesInversion } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyDarkPagesConfig.sys.mjs");
      const bc = content.browsingContext;
      bc.isZenBoostsInverted = darkPagesInversion(bc, false);
      return bc.isZenBoostsInverted;
    });
    ok(kept, "A late no-boost result cannot erase adaptation");
    is(generated.background, "rgb(255, 255, 255)", "The site's computed colors remain authored");
    ok(Math.max(...generated.paintedBackground.slice(0, 3)) < 100, "Painted background is dark");
    ok(generated.brightText, "Painted text is readable on the generated dark canvas");
    is(generated.photo, "none", "Photos are never inverted, and default dimming is off");
    Assert.deepEqual(generated.authoredRules, generated.expectedRules, "Authored CSSOM was preserved");
    WhimsyDarkPages.setChoice(browser, "off");
    await darkState(browser, "original");
    const original = await colors(browser);
    Assert.deepEqual(generated.photoPixel, original.photoPixel, "The bitmap keeps its exact painted colors");
    WhimsyDarkPages.setChoice(browser, "automatic");
    await darkState(browser, "generated");
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.dark-pages.dim-images", true]] });
    await SpecialPowers.spawn(browser, [], async () => {
      await ContentTaskUtils.waitForCondition(
        () => content.getComputedStyle(content.document.querySelector("img")).filter == "brightness(0.8)",
        "Opt-in dims the photo"
      );
    });
    await SpecialPowers.popPrefEnv();
  });
});

add_task(async function already_dark_is_untouched_and_switch_off_restores() {
  await BrowserTestUtils.withNewTab(PAGE + "?theme=already", async browser => {
    await darkState(browser, "native");
    const original = await colors(browser);
    is(original.background, "rgb(24, 26, 32)", "Already-dark page stays its exact authored color");
    is(original.photo, "none", "No image correction is applied");
    ok(!original.inverted, "Already-dark page never enables inversion");
  });
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await darkState(browser, "generated");
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.dark-pages", false]] });
    await darkState(browser, "original");
    is((await colors(browser)).background, "rgb(255, 255, 255)", "Feature switch removes generated colors live");
    await SpecialPowers.popPrefEnv();
  });
});
