/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Reader typography: Reader View's font list has the macOS reading fonts,
// and choosing one sets the page's font.

const ARTICLE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_article.html";

add_task(async function test_reader_fonts() {
  const fonts = JSON.parse(Services.prefs.getStringPref("reader.font_type.values"));
  if (AppConstants.platform != "macosx") {
    Assert.deepEqual(fonts, ["sans-serif", "serif", "monospace"], "Other platforms keep Firefox's list");
    return;
  }
  ok(fonts.includes("Charter") && fonts.includes("Iowan Old Style"), "The list has the macOS reading fonts");
  ok(fonts[0] == "sans-serif" && fonts.includes("serif"), "Firefox's own choices stay");

  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:reader?url=" + encodeURIComponent(ARTICLE));
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const doc = content.document;
    await ContentTaskUtils.waitForCondition(() => doc.getElementById("font-type-selector")?.options.length > 3, "font list built");
    const selector = doc.getElementById("font-type-selector");
    const charter = [...selector.options].find(o => o.value == "Charter");
    Assert.ok(charter, "Reader View offers Charter");
    Assert.equal(charter.textContent, "Charter", "shown by name");
    selector.value = "Charter";
    selector.dispatchEvent(new content.Event("change", { bubbles: true }));
    Assert.equal(doc.documentElement.style.getPropertyValue("--font-family"), "Charter", "Picking it sets the font");
    selector.value = "Iowan Old Style";
    selector.dispatchEvent(new content.Event("change", { bubbles: true }));
    Assert.equal(doc.documentElement.style.getPropertyValue("--font-family"), '"Iowan Old Style"', "Names with spaces are quoted");
  });
  Services.prefs.clearUserPref("reader.font_type");
  BrowserTestUtils.removeTab(tab);
});
