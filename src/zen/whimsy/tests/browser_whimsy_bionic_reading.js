/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Bionic reading: bolds the leading letters of each word in Reader View,
// toggled by its own toolbar button, off by default. Covers the expected
// letter-count prefix, exact restoration on toggle-off (a string compare,
// not just visual), and that Find-in-page still matches words with the
// feature on.

const TEST_ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const ARTICLE_URL = TEST_ROOT + "whimsy_article.html";

add_task(async function test_toggle_bolds_and_restores_exactly() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.bionic-reading", true], ["whimsy.reader.bionic", false]] });

  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `about:reader?url=${encodeURIComponent(ARTICLE_URL)}`);
  const browser = tab.linkedBrowser;
  await TestUtils.waitForCondition(
    () => SpecialPowers.spawn(browser, [], () => !!content.document.querySelector(".reader-controls .whimsy-bionic-button")),
    "the toggle button was added"
  );

  const look = await SpecialPowers.spawn(browser, [], () => {
    const glyph = content.document.querySelector(".whimsy-bionic-button > .whimsy-bionic-glyph");
    return { text: glyph?.textContent, display: glyph && content.getComputedStyle(glyph).display };
  });
  is(look.text, "B", "the button shows a glyph (it was an empty, invisible square)");
  is(look.display, "grid", "its sheet loads despite about:reader's CSP");

  const originalText = await SpecialPowers.spawn(browser, [], () =>
    content.document.querySelector(".moz-reader-content")?.textContent
  );
  ok(originalText && originalText.trim().length, "the article has text content");

  await SpecialPowers.spawn(browser, [], () => {
    content.document.querySelector(".reader-controls .whimsy-bionic-button")?.click();
  });

  await TestUtils.waitForCondition(
    () => SpecialPowers.spawn(browser, [], () => !!content.document.querySelector(".moz-reader-content .whimsy-bionic-word")),
    "bionic markup appeared"
  );

  const firstWordMarkup = await SpecialPowers.spawn(browser, [], () => {
    const word = content.document.querySelector(".moz-reader-content .whimsy-bionic-word");
    return { bold: word?.textContent, boldLength: word?.textContent.length };
  });
  ok(firstWordMarkup.boldLength > 0, "the bolded prefix isn't empty");

  const textWithBionicOn = await SpecialPowers.spawn(browser, [], () =>
    content.document.querySelector(".moz-reader-content").textContent
  );
  is(textWithBionicOn, originalText, "the flattened text content is unchanged (Find-in-page still matches)");

  await SpecialPowers.spawn(browser, [], () => {
    content.document.querySelector(".reader-controls .whimsy-bionic-button")?.click();
  });
  await TestUtils.waitForCondition(
    () => SpecialPowers.spawn(browser, [], () => !content.document.querySelector(".moz-reader-content .whimsy-bionic-word")),
    "the bionic markup was removed"
  );
  const restoredText = await SpecialPowers.spawn(browser, [], () =>
    content.document.querySelector(".moz-reader-content").textContent
  );
  is(restoredText, originalText, "turning it off restores the original text content exactly");
  const restoredHTML = await SpecialPowers.spawn(browser, [], () =>
    content.document.querySelectorAll(".moz-reader-content .whimsy-bionic-word").length
  );
  is(restoredHTML, 0, "no leftover bionic markup in the DOM, not just visually hidden");

  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_feature_switch_off_adds_no_button() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.bionic-reading", false]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `about:reader?url=${encodeURIComponent(ARTICLE_URL)}`);
  await TestUtils.waitForCondition(() =>
    SpecialPowers.spawn(tab.linkedBrowser, [], () => !!content.document.querySelector(".reader-controls"))
  );
  const hasButton = await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    !!content.document.querySelector(".whimsy-bionic-button")
  );
  ok(!hasButton, "no toggle button when the feature switch is off");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
