/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// browser-chrome loads only head.js automatically; load this suite explicitly.
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_whimsy_dark_pages.js",
  this
);

add_task(async function per_site_private_isolation() {
  // Seed a public exception independently of the persistence test file.
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await darkState(browser, "generated");
    WhimsyDarkPages.setChoice(browser, "off");
    await darkState(browser, "original");
    const saved = Services.prefs.getStringPref(SITES);
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
  });
});
