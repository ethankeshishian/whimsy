/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function per_site_persistence_and_private_isolation() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await darkState(browser, "generated");
    WhimsyDarkPages.setChoice(browser, "off");
    await darkState(browser, "original");
    const saved = Services.prefs.getStringPref(SITES);
    is(WhimsyDarkPages.choice(browser), "off", "Original is remembered for the site");
    const loaded = BrowserTestUtils.browserLoaded(browser);
    browser.reload();
    await loaded;
    await darkState(browser, "original");
    is((await colors(browser)).background, "rgb(255, 255, 255)", "Persisted Original survives reload");
    const privateWindow = await BrowserTestUtils.openNewBrowserWindow({ private: true });
    try {
      await BrowserTestUtils.withNewTab({ gBrowser: privateWindow.gBrowser, url: PAGE }, async privateBrowser => {
        await darkState(privateBrowser, "generated");
        is(WhimsyDarkPages.choice(privateBrowser), "automatic", "Public exceptions do not leak into private visits");
        WhimsyDarkPages.setChoice(privateBrowser, "off");
        await darkState(privateBrowser, "original");
        is(Services.prefs.getStringPref(SITES), saved, "Private site choice never writes the profile");
      });
    } finally {
      await BrowserTestUtils.closeWindow(privateWindow);
    }
    const nextPrivate = await BrowserTestUtils.openNewBrowserWindow({ private: true });
    try {
      await BrowserTestUtils.withNewTab({ gBrowser: nextPrivate.gBrowser, url: PAGE }, async privateBrowser => {
        await darkState(privateBrowser, "generated");
        is(WhimsyDarkPages.choice(privateBrowser), "automatic", "Private choice is forgotten with the last private window");
      });
    } finally {
      await BrowserTestUtils.closeWindow(nextPrivate);
    }
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
