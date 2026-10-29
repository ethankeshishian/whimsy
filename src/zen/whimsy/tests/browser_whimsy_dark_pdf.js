/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Dark PDFs: the Settings toggle (off by default) sets pdf.js's page
// colours and dark theme and reloads open PDFs; turning it off restores
// pdf.js's defaults.

const PDF = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_test.pdf";
const { DARK_PDF_PREFS } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPage.sys.mjs");

registerCleanupFunction(() => Services.prefs.clearUserPref("whimsy.pdf.dark"));

const forced = browser =>
  SpecialPowers.spawn(browser, [], async () => {
    await ContentTaskUtils.waitForCondition(() => content.wrappedJSObject.PDFViewerApplication?.pdfDocument, "PDF loaded");
    return content.wrappedJSObject.PDFViewerApplicationOptions.get("forcePageColors");
  });

add_task(async function test_dark_pdf() {
  ok(!Services.prefs.getBoolPref("whimsy.pdf.dark"), "Off by default");
  ok(!Services.prefs.getBoolPref("pdfjs.forcePageColors"), "pdf.js keeps its colours");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PDF);
  ok(!(await forced(tab.linkedBrowser)), "A PDF opens with its own colours");

  const reloaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  Services.prefs.setBoolPref("whimsy.pdf.dark", true);
  for (const [name, value] of Object.entries(DARK_PDF_PREFS)) {
    is(Services.prefs.getPrefType(name) == Services.prefs.PREF_INT ? Services.prefs.getIntPref(name) : Services.prefs.getPrefType(name) == Services.prefs.PREF_BOOL ? Services.prefs.getBoolPref(name) : Services.prefs.getStringPref(name), value, `${name} set`);
  }
  await reloaded;
  ok(await forced(tab.linkedBrowser), "The open PDF reloads with dark pages");

  Services.prefs.setBoolPref("whimsy.pdf.dark", false);
  for (const name of Object.keys(DARK_PDF_PREFS)) {
    ok(!Services.prefs.prefHasUserValue(name), `${name} back to pdf.js's default`);
  }
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_settings() {
  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const row = await TestUtils.waitForCondition(() => browser.contentDocument.getElementById("whimsyDarkPdf"), "Settings row");
    ok(!row.checked, "unchecked by default");
  });
});
