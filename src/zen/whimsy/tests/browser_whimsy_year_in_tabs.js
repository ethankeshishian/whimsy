/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Year in tabs (whimsy://year): a story of slides revealed one at a time.
// window.__whimsyYear exposes the deck (kinds, cardIndex, done, goTo,
// next, prev, skip) so the flow can be checked without waiting on timers.

const { PlacesTestUtils } = ChromeUtils.importESModule("resource://testing-common/PlacesTestUtils.sys.mjs");

const SEEDED_URL = "https://example.com/whimsy-year-test/";

registerCleanupFunction(async () => {
  Services.prefs.clearUserPref("whimsy.feature.year-in-tabs");
  await PlacesUtils.history.clear();
});

async function withYear(fn) {
  await BrowserTestUtils.withNewTab("about:whimsy?year", async browser => {
    const win = browser.contentWindow;
    await TestUtils.waitForCondition(() => win.__whimsyYear, "The page has loaded its data");
    await fn({ browser, win, doc: browser.contentDocument, year: win.__whimsyYear });
  });
}

add_task(async function test_story_with_a_seeded_visit() {
  await PlacesUtils.history.clear();
  await PlacesTestUtils.addVisits(SEEDED_URL);
  await withYear(async ({ doc, year }) => {
    is(year.kinds[0], "intro", "The story opens on the intro");
    is(year.kinds.at(-1), "finale", "and ends on the summary card");
    ok(year.kinds.includes("topsites"), "A seeded visit gives a top-sites slide");
    const slot = doc.querySelector('.whimsy-year-slide[data-kind="topsites"] .whimsy-year-slot');
    is(slot.dataset.site, "example.com", "The seeded site is number one");
    is(doc.querySelectorAll(".whimsy-year-seg").length, year.cardCount, "One progress segment per slide");
  });
});

add_task(async function test_year_is_never_number_formatted() {
  await PlacesTestUtils.addVisits(SEEDED_URL);
  await withYear(async ({ doc, year }) => {
    const thisYear = String(new Date().getFullYear());
    const hero = doc.querySelector('.whimsy-year-slide[data-kind="intro"] .whimsy-year-odometer');
    is(hero.textContent, thisYear, "The intro shows the year as plain digits");
    is(hero.getAttribute("aria-label"), thisYear, "and reads it as a year");
    year.goTo(year.cardCount - 1);
    year.skip();
    is(doc.querySelector(".whimsy-year-finale-year").textContent, thisYear, "The finale too (no 2,026)");
  });
});

add_task(async function test_no_privacy_subtitle() {
  await PlacesTestUtils.addVisits(SEEDED_URL);
  await withYear(async ({ doc, year }) => {
    year.skip();
    const intro = doc.querySelector('.whimsy-year-slide[data-kind="intro"]');
    await TestUtils.waitForCondition(() => intro.querySelector(".whimsy-year-punch").textContent, "The intro is localized");
    ok(!intro.textContent.includes("sent anywhere"), "The privacy subtitle is gone");
  });
});

add_task(async function test_a_press_mid_reveal_finishes_it_then_advances() {
  await PlacesTestUtils.addVisits(SEEDED_URL);
  await withYear(async ({ win, doc, year }) => {
    is(year.cardIndex, 0, "Starts on the first slide");
    year.skip();
    ok(year.done, "Skipping finishes the reveal");
    ok(doc.querySelector('.whimsy-year-slide[data-kind="intro"] .whimsy-year-punch').classList.contains("is-shown"),
      "with every line shown");

    win.focus();
    EventUtils.synthesizeKey("KEY_ArrowRight", {}, win);
    is(year.cardIndex, 1, "ArrowRight then moves on");
    is(doc.getElementById("whimsy-year-cards").dataset.card, "1", "and the deck says so");
    // Under reduced motion every slide arrives fully revealed.
    if (!win.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      ok(!year.done, "The new slide starts its reveal");
      EventUtils.synthesizeKey(" ", {}, win);
      is(year.cardIndex, 1, "Space mid-reveal stays on the slide");
    }
    ok(year.done, "The reveal is finished");
    const big = doc.querySelector('.whimsy-year-slide[data-card="1"] .whimsy-year-big, .whimsy-year-slide[data-card="1"] .whimsy-year-slot-name');
    if (big) {
      ok(big.classList.contains("is-landed"), "The stat lands at its final value");
    }

    EventUtils.synthesizeKey(" ", {}, win);
    is(year.cardIndex, 2, "The next Space advances");
    EventUtils.synthesizeKey("KEY_ArrowLeft", {}, win);
    is(year.cardIndex, 1, "ArrowLeft goes back");
    ok(year.done, "to a slide that's already revealed");
  });
});

add_task(async function test_count_up_lands_on_the_real_number() {
  await PlacesTestUtils.addVisits(SEEDED_URL);
  await withYear(async ({ doc, year }) => {
    const index = year.kinds.indexOf("nightowl");
    ok(index > 0, "A visit gives a night-owl slide");
    year.goTo(index);
    year.skip();
    const big = doc.querySelector('.whimsy-year-slide[data-kind="nightowl"] .whimsy-year-big');
    ok(/^\d+%$/.test(big.textContent), `The night-owl share is a percentage (${big.textContent})`);
  });
});

add_task(async function test_finale_actions() {
  await PlacesTestUtils.addVisits(SEEDED_URL);
  await withYear(async ({ doc, year }) => {
    year.goTo(year.cardCount - 1);
    year.skip();
    ok(doc.querySelector(".whimsy-year-finale-card .whimsy-year-tile"), "The summary card has stat tiles");
    ok(doc.getElementById("whimsy-year-copy"), "Copy card is offered");
    ok(doc.getElementById("whimsy-year-done"), "and Done");
    doc.getElementById("whimsy-year-replay").click();
    is(year.cardIndex, 0, "Watch again starts over");
    is(doc.getElementById("whimsy-year-cards").dataset.card, "0", "from the intro");
  });
});

add_task(async function test_auto_play_toggle() {
  await PlacesTestUtils.addVisits(SEEDED_URL);
  await withYear(async ({ doc, year }) => {
    const button = doc.getElementById("whimsy-year-auto");
    const was = button.getAttribute("aria-pressed") == "true";
    button.click();
    is(button.getAttribute("aria-pressed"), String(!was), "Auto-play toggles");
    year.setAuto(false);
  });
});

add_task(async function test_no_history_omits_the_topsites_slide() {
  await PlacesUtils.history.clear();
  await withYear(async ({ doc }) => {
    ok(!doc.querySelector('.whimsy-year-slide[data-kind="topsites"]'), "No visits: no top-sites slide");
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

add_task(async function leaving_finale_removes_actions_from_keyboard_and_accessibility() {
  await withYear(async ({ doc, year }) => {
    year.goTo(year.cardCount - 1);
    year.skip();
    const copy = doc.getElementById("whimsy-year-copy");
    copy.focus();
    year.goTo(year.cardCount - 2);
    const finale = copy.closest(".whimsy-year-slide");
    ok(finale.inert, "Outgoing finale is inert immediately");
    is(finale.getAttribute("aria-hidden"), "true", "Outgoing slide is hidden from assistive technology");
    ok(!finale.contains(doc.activeElement), "Focus leaves outgoing actions");
    copy.focus();
    ok(doc.activeElement !== copy, "Invisible Copy action cannot regain focus");
    await TestUtils.waitForCondition(() => !finale.hasAttribute("data-leaving"), "Outgoing paint is cleared after transition");
  });
});
