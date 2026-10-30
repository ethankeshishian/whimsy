/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { PlacesTestUtils } = ChromeUtils.importESModule("resource://testing-common/PlacesTestUtils.sys.mjs");

registerCleanupFunction(async () => {
  Services.prefs.clearUserPref("whimsy.feature.year-in-tabs");
  await PlacesUtils.history.clear();
});

add_task(async function test_top_site_card_from_seeded_visit() {
  await PlacesUtils.history.clear();
  const url = "https://example.com/whimsy-year-test/";
  await PlacesTestUtils.addVisits(url);

  await BrowserTestUtils.withNewTab("about:whimsy?year", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => browser.contentWindow.__whimsyYear, "The page has loaded its data");
    const topSitesCard = doc.querySelector('.whimsy-year-card[data-card="2"]');
    ok(topSitesCard, "A seeded visit always gives a top-sites card at index 2");
    const firstRow = topSitesCard.querySelector(".whimsy-year-card-list li:first-child span:first-child");
    ok(firstRow?.textContent.includes("example.com"), "The seeded site is listed first");
  });
  await PlacesUtils.history.clear();
});

add_task(async function test_no_history_omits_the_topsites_card() {
  await PlacesUtils.history.clear();
  await BrowserTestUtils.withNewTab("about:whimsy?year", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => browser.contentWindow.__whimsyYear);
    ok(!doc.querySelector(".whimsy-year-card-list"), "No visits: the top-sites card doesn't render at all");
  });
});

add_task(async function test_arrow_right_advances_the_card() {
  await BrowserTestUtils.withNewTab("about:whimsy?year", async browser => {
    const doc = browser.contentDocument;
    const win = browser.contentWindow;
    await TestUtils.waitForCondition(() => win.__whimsyYear);
    is(doc.getElementById("whimsy-year-cards").dataset.card, "0", "Starts on the first card");
    win.focus();
    EventUtils.synthesizeKey("KEY_ArrowRight", {}, win);
    await TestUtils.waitForCondition(() => doc.getElementById("whimsy-year-cards").dataset.card == "1");
    is(win.__whimsyYear.cardIndex, 1, "ArrowRight advances to the next card");
  });
});

add_task(async function test_feature_off_shows_nothing() {
  Services.prefs.setBoolPref("whimsy.feature.year-in-tabs", false);
  await BrowserTestUtils.withNewTab("about:whimsy?year", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.getElementById("whimsy-year-off"));
    ok(!browser.contentWindow.__whimsyYear, "With the feature off, the recap never builds");
  });
  Services.prefs.clearUserPref("whimsy.feature.year-in-tabs");
});
