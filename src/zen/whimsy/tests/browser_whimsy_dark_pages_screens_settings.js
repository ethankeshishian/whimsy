/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// browser-chrome loads only head.js automatically; load this suite explicitly.
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_whimsy_dark_pages.js",
  this
);

add_task(async function screenshots_settings() {
  await whimsyBothSchemes("w24-darkpages-settings", async () => {
    const page = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
    await darkState(page.linkedBrowser, "generated");
    WhimsyDarkPages.setChoice(page.linkedBrowser, "off");
    await darkState(page.linkedBrowser, "original");
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences#zenLooks");
    await TestUtils.waitForCondition(() => tab.linkedBrowser.contentDocument?.getElementById("whimsyDarkPagesMode"), "Appearance control is initialized");
    const doc = tab.linkedBrowser.contentDocument;
    ok(!doc.getElementById("whimsyDarkPdf"), "PDF appearance is folded into the one global control");
    doc.getElementById("whimsyDarkPagesGroup").scrollIntoView({ block: "center" });
    ok(!doc.getElementById("whimsyDarkPagesSites").hidden, "Appearance lists the site's remembered exception and Reset");
    return () => {
      WhimsyDarkPages.setChoice(page.linkedBrowser, "automatic");
      BrowserTestUtils.removeTab(tab);
      BrowserTestUtils.removeTab(page);
    };
  });
});
