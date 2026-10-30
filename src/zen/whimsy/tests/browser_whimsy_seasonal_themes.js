/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { WhimsySeasons } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySeasons.sys.mjs");

add_task(async function test_seasonal_themes() {
  const root = window.document.documentElement;
  const original = WhimsySeasons._now;
  registerCleanupFunction(() => {
    WhimsySeasons._now = original;
    Services.prefs.clearUserPref("whimsy.seasons.enabled");
    WhimsySeasons.apply(window);
  });

  WhimsySeasons._now = () => new Date(2026, 9, 30); // Oct 30: Halloween.
  WhimsySeasons.apply(window);
  is(root.getAttribute("whimsy-season"), "halloween", "Halloween season is set");
  is(root.getAttribute("whimsy-season-flourish"), "leaves", "Halloween flourish is leaves");

  const flourish = getComputedStyle(document.getElementById("zen-appcontent-wrapper"), "::after");
  is(flourish.animationIterationCount, "1", "The seasonal entrance ends instead of animating forever");
  ok(parseFloat(flourish.animationDuration) <= 1, "The entrance settles within a second");

  // Each flourish is a real shape (a mask tile), not a dot gradient.
  const masks = {};
  for (const [date, kind] of [[new Date(2026, 9, 30), "leaves"], [new Date(2026, 11, 20), "snow"], [new Date(2026, 2, 25), "blossom"]]) {
    WhimsySeasons._now = () => date;
    WhimsySeasons.apply(window);
    is(root.getAttribute("whimsy-season-flourish"), kind, `${kind} flourish`);
    const style = getComputedStyle(document.getElementById("zen-appcontent-wrapper"), "::after");
    ok(style.maskImage.includes("data:image/svg+xml"), `${kind}: drawn from an SVG shape`);
    is(style.backgroundImage, "none", `${kind}: no dot gradient`);
    masks[kind] = style.maskImage;
  }
  is(new Set(Object.values(masks)).size, 3, "Leaves, snow and blossom have their own shapes");
  WhimsySeasons._now = () => new Date(2026, 9, 30);
  WhimsySeasons.apply(window);

  WhimsySeasons._now = () => new Date(2026, 6, 1); // July 1: no season.
  WhimsySeasons.apply(window);
  ok(!root.hasAttribute("whimsy-season"), "No season on July 1");

  WhimsySeasons._now = () => new Date(2026, 9, 30);
  Services.prefs.setBoolPref("whimsy.seasons.enabled", false);
  WhimsySeasons.apply(window);
  ok(!root.hasAttribute("whimsy-season"), "Pref off clears the season even on Halloween");
  Services.prefs.clearUserPref("whimsy.seasons.enabled");
});
