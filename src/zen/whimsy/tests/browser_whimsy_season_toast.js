/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// New season toast (whimsy.feature.season-toast). Covers the first window of
// a season showing Zen's toast with the balloon in the season's costume,
// never twice in a season (winter spans the new year), a new season showing
// again, the seasonal and feature switches, Mini Whimsy and test automation
// staying quiet, and the balloon's bob respecting reduced motion. Toasts
// are left to hide on their own (removing one mid-animation would reject
// Zen's animation).

const { WhimsySeasons } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySeasons.sys.mjs");
const { WhimsySeasonToast } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySeasonToast.sys.mjs");
const SEEN_PREF = "whimsy.seasons.last-toast";
const originalNow = WhimsySeasons._now;

function at(year, month, day) {
  WhimsySeasons._now = () => new Date(year, month - 1, day, 12);
}

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({ set: [[SEEN_PREF, ""]] });
  registerCleanupFunction(() => {
    WhimsySeasons._now = originalNow;
  });
});

add_task(async function test_first_window_of_a_season() {
  at(2026, 10, 15);
  const toast = WhimsySeasonToast.maybeShow(window);
  ok(toast, "the first window of autumn shows a toast");
  ok(toast.classList.contains("zen-toast"), "it's Zen's toast");
  const balloon = toast.querySelector(".whimsy-season-toast-balloon");
  ok(balloon?.src.endsWith("whimsy-season-balloon.svg#autumn"), "with the balloon in its autumn costume");
  await TestUtils.waitForCondition(() => balloon.complete && balloon.naturalWidth > 0, "the balloon image loads");
  await TestUtils.waitForCondition(
    () => toast.querySelector("label")?.textContent && toast.querySelector(".description")?.textContent,
    "both lines are localized"
  );
  is(Services.prefs.getStringPref(SEEN_PREF), "2026-autumn", "autumn is marked as seen");

  is(WhimsySeasonToast.maybeShow(window), null, "never twice in a season");
  at(2026, 11, 30);
  is(WhimsySeasonToast.maybeShow(window), null, "still autumn on Nov 30");

  at(2026, 12, 1);
  const winter = WhimsySeasonToast.maybeShow(window);
  ok(winter?.querySelector("img").src.endsWith("#winter"), "a new season shows again, dressed for it");
  is(Services.prefs.getStringPref(SEEN_PREF), "2026-winter", "winter is marked");
  at(2027, 2, 10);
  is(WhimsySeasonToast.maybeShow(window), null, "winter carries across the new year");
  at(2027, 3, 1);
  ok(WhimsySeasonToast.maybeShow(window), "spring gets its own");
});

add_task(async function test_quiet_cases() {
  at(2027, 7, 1);
  Services.prefs.setStringPref(SEEN_PREF, "2027-spring");

  WhimsySeasonToast.initWindow(window);
  await new Promise(r => setTimeout(r, 100));
  is(Services.prefs.getStringPref(SEEN_PREF), "2027-spring", "never shown under test automation at window open");

  is(WhimsySeasonToast.pending({ _whimsyQuickWindow: true }), null, "never in Mini Whimsy");

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.seasons.enabled", false]] });
  is(WhimsySeasonToast.maybeShow(window), null, "the seasonal switch turns it off");
  await SpecialPowers.popPrefEnv();

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.seasonal-themes", false]] });
  is(WhimsySeasonToast.maybeShow(window), null, "so does the seasonal feature switch");
  await SpecialPowers.popPrefEnv();

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.season-toast", false]] });
  is(WhimsySeasonToast.maybeShow(window), null, "and this feature's switch");
  await SpecialPowers.popPrefEnv();
  is(Services.prefs.getStringPref(SEEN_PREF), "2027-spring", "nothing was marked while off");

  ok(WhimsySeasonToast.maybeShow(window), "summer shows once everything is on");
});

add_task(async function test_reduced_motion() {
  for (const [reduce, expectBob] of [
    [0, true],
    [1, false],
  ]) {
    await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", reduce]] });
    Services.prefs.setStringPref(SEEN_PREF, "");
    at(2027, 7, 1);
    const toast = WhimsySeasonToast.maybeShow(window);
    const balloon = toast.querySelector(".whimsy-season-toast-balloon");
    const name = window.getComputedStyle(balloon).animationName;
    is(name != "none", expectBob, reduce ? "no bob with reduced motion" : "the balloon bobs");
      await SpecialPowers.popPrefEnv();
  }
});
