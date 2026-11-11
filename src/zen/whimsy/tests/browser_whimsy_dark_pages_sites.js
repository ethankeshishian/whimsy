/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// browser-chrome loads only head.js automatically; load this suite explicitly.
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_whimsy_dark_pages.js",
  this
);

add_task(async function per_site_persistence_and_global_override() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await darkState(browser, "generated");
    WhimsyDarkPages.setChoice(browser, "off");
    await darkState(browser, "original");
    is(WhimsyDarkPages.choice(browser), "off", "Original is remembered for the site");
    const loaded = BrowserTestUtils.browserLoaded(browser);
    browser.reload();
    await loaded;
    await darkState(browser, "original");
    is((await colors(browser)).background, "rgb(255, 255, 255)", "Persisted Original survives reload");
    WhimsyDarkPages.setChoice(browser, "automatic");
    await darkState(browser, "generated");
    await SpecialPowers.pushPrefEnv({ set: [[MODE, "off"]] });
    await darkState(browser, "original");
    WhimsyDarkPages.setChoice(browser, "on");
    await darkState(browser, "generated");
    is(WhimsyDarkPages.choice(browser), "on", "Dark explicitly overrides the global default");
    WhimsyDarkPages.setChoice(browser, "automatic");
    await darkState(browser, "original");
    await SpecialPowers.popPrefEnv();
  });
});
