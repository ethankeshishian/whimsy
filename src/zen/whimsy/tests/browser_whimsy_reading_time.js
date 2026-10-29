/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Reading time: on an article (the Reader View button shows), "N min"
// sits next to the button, in Reader View's own range; a page that isn't
// an article shows nothing, and the setting hides it.

const ARTICLE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_article.html";
const label = () => document.getElementById("whimsy-reading-time");
const button = () => document.getElementById("reader-mode-button");

add_task(async function test_article() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, ARTICLE);
  await TestUtils.waitForCondition(() => !button().hidden, "The Reader View button shows");
  await TestUtils.waitForCondition(() => label() && !label().hidden && label().value, "The reading time shows");
  const minutes = parseInt(label().value, 10);
  ok(/^\d+ min$/.test(label().value), `It reads "${label().value}"`);
  ok(minutes >= 5 && minutes <= 15, "In the expected range for ~1,500 words");
  is(label().nextElementSibling, button(), "next to the Reader View button");

  // Not an article: nothing.
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  await TestUtils.waitForCondition(() => !label() || label().hidden, "A normal page shows no reading time");
  gBrowser.selectedTab = tab;
  await TestUtils.waitForCondition(() => !label().hidden, "back on the article it shows again");

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.reader.reading-time", false]] });
  await TestUtils.waitForCondition(() => label().hidden, "The setting hides it");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.reading-time", false]] });
  gBrowser.selectedTab = other;
  gBrowser.selectedTab = tab;
  await TestUtils.waitForCondition(() => label().hidden, "and so does the switch");
  await SpecialPowers.popPrefEnv();
  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_minutes() {
  const { WhimsyPage } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPage.sys.mjs");
  is(WhimsyPage.readingMinutes(987 * 6, "en"), 6, "6 minutes of English");
  is(WhimsyPage.readingMinutes(255 * 6, "zh-CN"), 6, "Chinese reads at its own speed");
  is(WhimsyPage.readingMinutes(10, "en"), 1, "Never less than a minute");
});
