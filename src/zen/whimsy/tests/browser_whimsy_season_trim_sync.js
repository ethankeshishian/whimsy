/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// W10-08/W10-32: the command bar's seasonal trim (Halloween's pumpkins)
// appears in the same frame as the bar, with no delay. Two things made it
// late: its art was only asked for when the bar opened (the trim was
// display: none until then), and it had its own 80ms-delayed fade. Now the
// art is loaded and decoded as soon as the window takes the look, and the
// trim turns visible in the same style change that floats the bar open.

const { WhimsySeasons, TRIM_ART } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySeasons.sys.mjs"
);
const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");

const HALLOWEEN = new Date(2026, 9, 31, 12);

add_setup(async function () {
  const original = WhimsySeasons._now;
  registerCleanupFunction(() => {
    WhimsySeasons._now = original;
    WhimsySeasons.apply(window);
  });
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.seasonal-themes", true],
      ["whimsy.seasons.enabled", true],
      ["ui.prefersReducedMotion", 0],
    ],
  });
  WhimsySeasons._now = () => HALLOWEEN;
  WhimsySeasons.apply(window);
});

function parts() {
  const trim = WhimsySeasons.trim(window);
  return { trim, top: trim?.querySelector(".whimsy-season-trim-top") };
}

async function closeBar() {
  if (gURLBar.view.isOpen) {
    await UrlbarTestUtils.promisePopupClose(window);
  }
  gURLBar.blur();
}

add_task(async function art_is_ready_before_the_bar_opens() {
  is(document.documentElement.getAttribute("whimsy-season-decor"), "halloween", "Halloween look");
  ok(await WhimsySeasons.artReady(window), "The pumpkins are loaded and decoded as soon as the look is set");

  const { trim, top } = parts();
  ok(trim, "The bar has a trim");
  ok(!gURLBar.hasAttribute("open"), "The bar is docked");
  const style = getComputedStyle(trim);
  is(style.display, "block", "Docked, the trim is laid out, so its art loads now, not when the bar opens");
  is(style.visibility, "hidden", "...but it isn't painted");
  is(style.pointerEvents, "none", "...and never takes a click");
  ok(
    getComputedStyle(top, "::after").backgroundImage.includes(TRIM_ART.halloween[0]),
    "The pumpkins' image is already resolved while docked"
  );

  // Docked, the hidden trim changes nothing about the address bar.
  const docked = gURLBar.getBoundingClientRect();
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.seasons.enabled", false]] });
  is(WhimsySeasons.trim(window), null, "Switch off: no trim");
  const plain = gURLBar.getBoundingClientRect();
  for (const side of ["top", "left", "width", "height"]) {
    is(docked[side], plain[side], `The docked bar's ${side} is the same with or without the trim`);
  }
  await SpecialPowers.popPrefEnv();
  ok(WhimsySeasons.trim(window), "Switch back on: the trim is back");
  ok(await WhimsySeasons.artReady(window), "...with its art ready");
});

add_task(async function trim_shows_in_the_same_frame_as_the_bar() {
  const { trim, top } = parts();
  // Read the trim's style the moment the bar floats open: a mutation
  // observer runs before the next paint, so this is the frame the bar
  // first appears in.
  let atOpen = null;
  const observer = new MutationObserver(() => {
    if (atOpen || !gURLBar.hasAttribute("open") || gURLBar.getAttribute("zen-floating-urlbar") != "true") {
      return;
    }
    const trimStyle = getComputedStyle(trim);
    const topStyle = getComputedStyle(top);
    const art = getComputedStyle(top, "::after");
    atOpen = {
      visibility: trimStyle.visibility,
      overflow: trimStyle.overflow,
      topOpacity: topStyle.opacity,
      artOpacity: art.opacity,
      topAnimation: topStyle.animationName,
      artAnimation: art.animationName,
      art: art.backgroundImage,
    };
  });
  observer.observe(gURLBar, { attributes: true, attributeFilter: ["open", "zen-floating-urlbar"] });
  try {
    gURLBar.blur();
    await SimpleTest.promiseFocus(window);
    document.getElementById("Browser:OpenLocation").doCommand();
    await UrlbarTestUtils.promiseAutocompleteResultPopup({
      window,
      waitForFocus: SimpleTest.waitForFocus,
      value: "example",
    });
    await TestUtils.waitForCondition(() => atOpen, "The command bar floated open");
  } finally {
    observer.disconnect();
  }

  is(atOpen.visibility, "visible", "The trim is visible in the frame the bar opens");
  is(atOpen.overflow, "visible", "...and not clipped");
  is(atOpen.topOpacity, "1", "No fade: the pumpkins' strip is fully opaque at once");
  is(atOpen.artOpacity, "1", "No fade on the pumpkins themselves");
  is(atOpen.topAnimation, "none", "No entrance animation on the strip");
  is(atOpen.artAnimation, "none", "No entrance animation on the art");
  ok(atOpen.art.includes(TRIM_ART.halloween[0]), "The pumpkins are drawn from the start");
  ok(
    document.getAnimations().every(a => !a.animationName?.startsWith("whimsy-season-trim")),
    "No trim animation runs at all"
  );

  await closeBar();
  is(getComputedStyle(trim).visibility, "hidden", "Closing the bar hides the trim in the same change");
});

add_task(async function every_look_preloads_its_own_art() {
  const looks = [
    [new Date(2026, 10, 10, 12), "autumn"],
    [new Date(2026, 11, 20, 12), "holidays"],
    [new Date(2027, 1, 10, 12), "winter"],
    [new Date(2026, 3, 15, 12), "spring"],
    [new Date(2026, 6, 15, 12), "summer"],
    [HALLOWEEN, "halloween"],
  ];
  for (const [date, look] of looks) {
    WhimsySeasons._now = () => date;
    WhimsySeasons.apply(window);
    is(document.documentElement.getAttribute("whimsy-season-decor"), look, `${look}: the look is set`);
    ok(await WhimsySeasons.artReady(window), `${look}: its art (${TRIM_ART[look].join(", ")}) is decoded before any open`);
  }
  // Applying again (every window focus does) keeps the same preload.
  const before = WhimsySeasons.artReady(window);
  WhimsySeasons.apply(window);
  is(WhimsySeasons.artReady(window), before, "Re-applying the same look doesn't load the art again");
});
