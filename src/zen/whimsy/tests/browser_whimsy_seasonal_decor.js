/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// wave7/season: seasonal touches beyond the balloon. One calendar
// (WhimsySeasons' CALENDAR) drives the floating command bar's trim, Balloon
// Dash's occasions and weather, and the changelog's header art. Dates are
// mocked; the one seasonal switch takes every touch away; reduced motion
// stops every animation; the trim never takes clicks or covers the input.

const { WhimsySeasons, CALENDAR, lookForDate } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsySeasons.sys.mjs"
);
const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");
requestLongerTimeout(4);

const SEASON_FEATURE = "whimsy.feature.seasonal-themes";
const SEASON_ENABLED = "whimsy.seasons.enabled";

// [date, season, look, art above the top edge, art below the bottom edge]
const LOOKS = [
  [[2026, 10, 30], "autumn", "halloween", "trim-halloween.svg", null],
  [[2026, 11, 10], "autumn", "autumn", "trim-autumn.svg", null],
  [[2026, 12, 20], "winter", "holidays", null, "trim-lights.svg"],
  [[2027, 2, 10], "winter", "winter", "trim-winter.svg", null],
  [[2026, 4, 15], "spring", "spring", "trim-spring.svg", null],
  [[2026, 7, 15], "summer", "summer", "trim-summer.svg", null],
];

function mockDate([year, month, day]) {
  WhimsySeasons._now = () => new Date(year, month - 1, day, 12);
}

async function setReducedMotion(reduced) {
  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", reduced]] });
  await TestUtils.waitForCondition(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches == !!reduced,
    "Motion preference applied"
  );
}

add_setup(async function () {
  const original = WhimsySeasons._now;
  registerCleanupFunction(() => {
    WhimsySeasons._now = original;
    WhimsySeasons.apply(window);
    for (const pref of ["whimsy.game.style", "whimsy.game.high-score"]) {
      Services.prefs.clearUserPref(pref);
    }
  });
  await SpecialPowers.pushPrefEnv({ set: [
    [SEASON_FEATURE, true], [SEASON_ENABLED, true],
    ["whimsy.feature.home", true], ["whimsy.feature.game", true],
  ] });
});

add_task(async function one_calendar_with_occasions() {
  const cases = [
    [[2026, 9, 21], "summer", null], [[2026, 9, 22], "autumn", null],
    [[2026, 10, 19], "autumn", null], [[2026, 10, 20], "autumn", "halloween"],
    [[2026, 10, 31], "autumn", "halloween"], [[2026, 11, 1], "autumn", null],
    [[2026, 11, 30], "autumn", null], [[2026, 12, 1], "winter", "holidays"],
    [[2026, 12, 31], "winter", "holidays"], [[2027, 1, 1], "winter", "holidays"],
    [[2027, 1, 2], "winter", null], [[2028, 2, 29], "winter", null],
    [[2026, 3, 1], "spring", null], [[2026, 6, 1], "summer", null],
  ];
  for (const [[y, m, d], season, occasion] of cases) {
    const look = lookForDate(new Date(y, m - 1, d, 12));
    is(look.season, season, `${y}-${m}-${d} is ${season}`);
    is(look.occasion, occasion, `${y}-${m}-${d} occasion`);
    is(look.id, occasion ?? season, "The look is the occasion when there is one");
  }
  // Every day of a leap year has a season, and each occasion sits wholly
  // inside the season it names.
  for (let day = new Date(2028, 0, 1, 12); day.getFullYear() == 2028; day.setDate(day.getDate() + 1)) {
    const look = lookForDate(day);
    if (!look) {
      ok(false, `${day.toDateString()} has no season`);
      continue;
    }
    const occasion = CALENDAR.find(entry => entry.id == look.occasion);
    if (occasion) {
      is(occasion.season, look.season, `${look.occasion} on ${day.toDateString()} is inside ${look.season}`);
    }
  }

  mockDate([2026, 10, 30]);
  WhimsySeasons.apply(window);
  const root = document.documentElement;
  is(root.getAttribute("whimsy-season"), "autumn", "The window keeps the season for older touches");
  is(root.getAttribute("whimsy-season-decor"), "halloween", "and gets the occasion for new ones");
  is(WhimsySeasons.current().id, "autumn", "current() still returns the season");
});

async function openFloatingBar() {
  gURLBar.blur();
  await SimpleTest.promiseFocus(window);
  document.getElementById("Browser:OpenLocation").doCommand();
  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    waitForFocus: SimpleTest.waitForFocus,
    value: "example",
  });
  await TestUtils.waitForCondition(
    () => gURLBar.getAttribute("zen-floating-urlbar") == "true" && gURLBar.hasAttribute("open"),
    "The command bar floats open"
  );
  // Let the trim's one-shot fade finish.
  await TestUtils.waitForCondition(() => document.getAnimations().every(a =>
    a.animationName != "whimsy-season-trim-in" || a.playState != "running"), "Trim has faded in");
}

async function closeBar() {
  await UrlbarTestUtils.promisePopupClose(window);
  gURLBar.blur();
}

function trimParts() {
  const trim = WhimsySeasons.trim(window);
  return {
    trim,
    top: trim?.querySelector(".whimsy-season-trim-top"),
    bottom: trim?.querySelector(".whimsy-season-trim-bottom"),
  };
}

function assertOutsideTheBar(label) {
  const { trim, top, bottom } = trimParts();
  const background = gURLBar.querySelector(":scope > .urlbar-background").getBoundingClientRect();
  const input = gURLBar.querySelector(".urlbar-input-container").getBoundingClientRect();
  const topRect = top.getBoundingClientRect();
  const bottomRect = bottom.getBoundingClientRect();
  Assert.lessOrEqual(topRect.bottom, background.top + 0.5, `${label}: the top trim sits on the bar's top edge`);
  Assert.lessOrEqual(topRect.bottom, input.top, `${label}: the top trim never overlaps the input`);
  Assert.greaterOrEqual(bottomRect.top, background.bottom - 0.5, `${label}: the bottom trim hangs below the bar`);
  Assert.greaterOrEqual(bottomRect.top, input.bottom, `${label}: the bottom trim never overlaps the input`);
  for (const [element, pseudo] of [[trim, null], [top, null], [top, "::before"], [top, "::after"],
    [bottom, null], [bottom, "::before"], [bottom, "::after"]]) {
    is(getComputedStyle(element, pseudo).pointerEvents, "none",
      `${label}: ${element.className}${pseudo ?? ""} takes no pointer events`);
  }
  is(trim.getAttribute("aria-hidden"), "true", `${label}: the trim is hidden from assistive tech`);
  // A click where the art is drawn goes to whatever is under it.
  const hit = document.elementFromPoint(topRect.left + 30, topRect.bottom - 4);
  ok(!hit || !trim.contains(hit), `${label}: the trim never receives a click`);
}

add_task(async function command_bar_trim_per_season() {
  await setReducedMotion(0);
  try {
    // Without decoration first: the bar's own geometry, to compare with.
    await SpecialPowers.pushPrefEnv({ set: [[SEASON_ENABLED, false]] });
    await openFloatingBar();
    const plain = gURLBar.querySelector(".urlbar-input-container").getBoundingClientRect();
    const plainBar = gURLBar.getBoundingClientRect();
    is(WhimsySeasons.trim(window), null, "No trim while the switch is off");
    await closeBar();
    await SpecialPowers.popPrefEnv();

    for (const [date, season, look, topArt, bottomArt] of LOOKS) {
      mockDate(date);
      WhimsySeasons.apply(window);
      await openFloatingBar();
      const { trim, top, bottom } = trimParts();
      ok(trim, `${look}: the bar has a trim`);
      is(getComputedStyle(trim).display, "block", `${look}: the trim shows while the bar floats open`);
      if (topArt) {
        ok(getComputedStyle(top, "::after").backgroundImage.includes(topArt), `${look}: ${topArt} on the top edge`);
        is(getComputedStyle(bottom).backgroundImage, "none", `${look}: nothing hangs below`);
      } else {
        is(getComputedStyle(top, "::after").content, "none", `${look}: nothing on the top edge`);
        ok(getComputedStyle(bottom).backgroundImage.includes(bottomArt), `${look}: ${bottomArt} along the bottom edge`);
      }
      if (look == "halloween") {
        is(getComputedStyle(top, "::before").content, "none", "Halloween: one cluster of pumpkins, at the end");
      } else if (topArt) {
        ok(getComputedStyle(top, "::before").backgroundImage.includes(topArt), `${look}: a mirrored cluster at the start`);
      }
      if (look == "holidays") {
        is(getComputedStyle(bottom, "::before").animationName, "whimsy-season-twinkle", "Holiday lights twinkle");
      }
      assertOutsideTheBar(look);
      const input = gURLBar.querySelector(".urlbar-input-container").getBoundingClientRect();
      for (const side of ["top", "left", "width", "height"]) {
        is(input[side], plain[side], `${look}: the input's ${side} is unchanged`);
        is(gURLBar.getBoundingClientRect()[side], plainBar[side], `${look}: the bar's ${side} is unchanged`);
      }
      is(document.documentElement.getAttribute("whimsy-season"), season, `${look}: the season stays ${season}`);
      await closeBar();
      is(getComputedStyle(trim).display, "none", `${look}: no trim on the docked address bar`);
    }
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function command_bar_trim_switch_and_reduced_motion() {
  mockDate([2026, 12, 20]);
  WhimsySeasons.apply(window);
  await setReducedMotion(1);
  try {
    await openFloatingBar();
    const { top, bottom } = trimParts();
    for (const [element, pseudo] of [[top, null], [bottom, null], [bottom, "::before"], [bottom, "::after"]]) {
      is(getComputedStyle(element, pseudo).animationName, "none", `Reduced motion: ${element.className}${pseudo ?? ""} is still`);
    }
    ok(getComputedStyle(bottom).backgroundImage.includes("trim-lights.svg"), "Reduced motion keeps the lights, unlit motion");
    assertOutsideTheBar("reduced motion");

    for (const pref of [SEASON_FEATURE, SEASON_ENABLED]) {
      await SpecialPowers.pushPrefEnv({ set: [[pref, false]] });
      is(WhimsySeasons.trim(window), null, `${pref} off removes the trim at once`);
      ok(!document.documentElement.hasAttribute("whimsy-season-decor"), `${pref} off removes the look`);
      await SpecialPowers.popPrefEnv();
      ok(WhimsySeasons.trim(window), `${pref} back on restores it`);
    }
    await closeBar();
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

async function withGame(fn) {
  await BrowserTestUtils.withNewTab("about:whimsy?game", async browser => {
    const win = browser.contentWindow;
    const game = await TestUtils.waitForCondition(() => win.__whimsyGame, "The game has loaded");
    game.freeze();
    game.setAutoSpawn(false);
    await browser.contentDocument.l10n.ready;
    await fn({ win, doc: browser.contentDocument, game });
  });
}

add_task(async function balloon_dash_occasions_keep_the_rules() {
  // The calendar picks the look when the game loads.
  for (const [date, season, look] of LOOKS) {
    mockDate(date);
    await withGame(async ({ doc, game }) => {
      is(game.look, look, `${date.join("-")}: the game dresses for ${look}`);
      is(game.season, season, `${look}: the balloon wears its ${season} costume`);
      is(doc.getElementById("whimsy-game-root").dataset.look, look, "The root reflects the look");
    });
  }
  await SpecialPowers.pushPrefEnv({ set: [[SEASON_ENABLED, false]] });
  await withGame(async ({ game }) => {
    is(game.look, null, "Switch off: no seasonal look");
    is(game.season, null, "Switch off: no costume");
  });
  await SpecialPowers.popPrefEnv();

  await setReducedMotion(0);
  try {
    await withGame(async ({ doc, game }) => {
      for (const look of ["halloween", "holidays", null]) {
        game.setSeason(look);
        // Every hazard still pops the balloon, with the occasion's line for
        // the bat.
        for (const kind of ["seed", "plane", "bird", "zap"]) {
          game.start();
          game.clear();
          game.state.player.invuln = 0;
          game.state.player.shield = 0;
          game.spawn(kind);
          game.tick(1 / 60);
          is(game.state.deathKind, kind, `${look}: a ${kind} still pops the balloon`);
          if (kind == "bird") {
            is(doc.getElementById("whimsy-game-death").getAttribute("data-l10n-id"),
              look == "halloween" ? "whimsy-game-death-bird-halloween" : "whimsy-game-death-bird",
              `${look}: the bird's line`);
          }
        }
        // A sweet or a present scores exactly like a sparkle.
        game.start();
        game.clear();
        const before = game.state.bonus;
        const treat = game.spawn("sparkle");
        game.tick(1 / 60);
        ok(treat.gone, `${look}: the treat is collected`);
        Assert.greater(game.state.bonus, before, `${look}: and scores`);
      }

      // Weather: falls behind the hills in winter, none in summer.
      game.setSeason("winter");
      game.start();
      game.clear();
      game.state.player.invuln = 99;
      game.tick(0.2);
      Assert.greater(game.state.ambient.length, 0, "Winter: snow falls");
      ok(game.state.ambient.every(a => a.r < 2), "Snow is tiny next to the snowflake hazard");
      game.setSeason("summer");
      game.tick(0.2);
      is(game.state.ambient.length, 0, "Summer: no weather");
    });
    await setReducedMotion(1);
    try {
      await withGame(async ({ game }) => {
        game.setSeason("holidays");
        game.start();
        game.state.player.invuln = 99;
        game.tick(0.2);
        is(game.state.ambient.length, 0, "Reduced motion: no falling snow");
      });
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function changelog_header_in_season() {
  for (const [date, , look, topArt, bottomArt] of LOOKS) {
    mockDate(date);
    await BrowserTestUtils.withNewTab("about:whimsy?tab=changelog", async browser => {
      const doc = browser.contentDocument;
      const win = browser.contentWindow;
      const shelf = await TestUtils.waitForCondition(() => doc.getElementById("whimsy-changelog-season"));
      is(doc.documentElement.getAttribute("whimsy-season-decor"), look, `${look}: the page knows the look`);
      is(win.getComputedStyle(shelf).display, "block", `${look}: the header has seasonal art`);
      is(shelf.getAttribute("aria-hidden"), "true", "The art is decorative");
      const top = shelf.querySelector(".wh-season-shelf-top");
      const bottom = shelf.querySelector(".wh-season-shelf-bottom");
      if (topArt) {
        ok(win.getComputedStyle(top).backgroundImage.includes(topArt), `${look}: ${topArt} on the line`);
      } else {
        ok(win.getComputedStyle(bottom).backgroundImage.includes(bottomArt), `${look}: ${bottomArt} from the line`);
      }
      is(win.getComputedStyle(shelf).pointerEvents, "none", "The art takes no clicks");
      const lede = doc.querySelector("#whimsy-panel-changelog .wh-page-lede").getBoundingClientRect();
      const art = (topArt ? top : bottom).getBoundingClientRect();
      Assert.greaterOrEqual(art.top, lede.bottom, `${look}: the art never covers the heading`);
    });
  }

  // Reduced motion: the holiday lights hold still.
  mockDate([2026, 12, 20]);
  await setReducedMotion(1);
  try {
    await BrowserTestUtils.withNewTab("about:whimsy?tab=changelog", async browser => {
      const bottom = browser.contentDocument.querySelector("#whimsy-changelog-season .wh-season-shelf-bottom");
      for (const pseudo of ["::before", "::after"]) {
        is(browser.contentWindow.getComputedStyle(bottom, pseudo).animationName, "none", `Reduced motion: ${pseudo} still`);
      }
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }

  // The switch takes it away.
  await SpecialPowers.pushPrefEnv({ set: [[SEASON_ENABLED, false]] });
  await BrowserTestUtils.withNewTab("about:whimsy?tab=changelog", async browser => {
    const doc = browser.contentDocument;
    ok(!doc.documentElement.hasAttribute("whimsy-season-decor"), "Switch off: no look");
    is(browser.contentWindow.getComputedStyle(doc.getElementById("whimsy-changelog-season")).display, "none",
      "Switch off: no header art");
  });
  await SpecialPowers.popPrefEnv();
});
