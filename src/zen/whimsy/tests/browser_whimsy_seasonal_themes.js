/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { WhimsySeasons } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySeasons.sys.mjs");
requestLongerTimeout(4);

const SEASON_FEATURE = "whimsy.feature.seasonal-themes";
const SEASON_ENABLED = "whimsy.seasons.enabled";
const SEASON_DATES = [
  [2026, 1, 1, "winter"], [2026, 2, 28, "winter"],
  [2028, 2, 29, "winter"], [2026, 3, 1, "spring"],
  [2026, 5, 31, "spring"], [2026, 6, 1, "summer"],
  [2026, 9, 21, "summer"], [2026, 9, 22, "autumn"],
  [2026, 11, 30, "autumn"], [2026, 12, 1, "winter"],
  [2026, 12, 31, "winter"],
];
const SEASON_COLORS = {
  autumn: ["rgb(255, 191, 71)", "rgb(183, 65, 14)"],
  winter: ["rgb(139, 211, 255)", "rgb(255, 255, 255)"],
  spring: ["rgb(246, 165, 192)", "rgb(101, 184, 122)"],
  summer: ["rgb(255, 218, 85)", "rgb(255, 127, 110)"],
};

add_setup(async function setup_seasons() {
  const original = WhimsySeasons._now;
  registerCleanupFunction(() => {
    WhimsySeasons._now = original;
    WhimsySeasons.apply(window);
  });
  await SpecialPowers.pushPrefEnv({ set: [
    [SEASON_FEATURE, true], [SEASON_ENABLED, true],
    ["zen.view.enable-loading-indicator", true],
    ["whimsy.feature.loading-line", true],
    ["zen.theme.hide-tab-throbber", false],
  ] });
});

add_task(async function calendar_boundaries_and_live_switches() {
  const root = document.documentElement;
  for (const [year, month, day, season] of SEASON_DATES) {
    WhimsySeasons._now = () => new Date(year, month - 1, day, 12);
    WhimsySeasons.apply(window);
    is(root.getAttribute("whimsy-season"), season, `${year}-${month}-${day}`);
    ok(!root.hasAttribute("whimsy-season-flourish"), "No flourish attribute");
  }
  for (const pref of [SEASON_FEATURE, SEASON_ENABLED]) {
    await SpecialPowers.pushPrefEnv({ set: [[pref, false]] });
    ok(!root.hasAttribute("whimsy-season"), `${pref} off updates the window immediately`);
    is(WhimsySeasons.current(), null, "Disabled calendar has no season");
    await SpecialPowers.popPrefEnv();
    is(root.getAttribute("whimsy-season"), "winter", "Re-enabling updates immediately");
  }
  WhimsySeasons._now = () => new Date(2026, 2, 1, 12);
  window.dispatchEvent(new Event("focus"));
  is(root.getAttribute("whimsy-season"), "spring", "Focus updates a window across a date boundary");
  WhimsySeasons._now = () => new Date(2026, 5, 1, 12);
  gBrowser.tabContainer.dispatchEvent(new CustomEvent("TabAttrModified", {
    detail: { changed: ["busy"] },
  }));
  is(root.getAttribute("whimsy-season"), "summer", "Navigation updates the season too");
});

function assertSeasonGradient(element, pseudo, season) {
  const image = getComputedStyle(element, pseudo).backgroundImage;
  ok(image.includes("linear-gradient"), `${season}: ${pseudo || element.className} has a gradient`);
  for (const color of SEASON_COLORS[season]) {
    ok(image.includes(color), `${season}: gradient contains ${color}`);
  }
}

add_task(async function real_loading_indicators_and_restored_accent() {
  // Exercise both Whimsy's progress line and Zen's original pill, with each
  // motion preference. Native busy state must still disappear after loading.
  for (const line of [true, false]) {
    for (const reduced of [0, 1]) {
      await SpecialPowers.pushPrefEnv({ set: [
        ["whimsy.tabs.loading-line", line], ["ui.prefersReducedMotion", reduced],
        [SEASON_ENABLED, false],
      ] });
      await TestUtils.waitForCondition(
        () => matchMedia("(prefers-reduced-motion: reduce)").matches == !!reduced,
        "Motion preference applied"
      );
      const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
      try {
        const url = `http://mochi.test:8888/browser/zen/whimsy/tests/whimsy_slow_load.sjs?delay=8000&r=${Math.random()}`;
        const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
        BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, url);
        const bar = await TestUtils.waitForCondition(
          () => document.getElementById("zen-loading-progress-bar"), "Real load shows the progress bar"
        );
        // Stabilize Zen's long-load state before taking the native baseline;
        // its timer would otherwise change the pill during pref assertions.
        bar.setAttribute("long-load", "true");
        const throbber = tab.querySelector(".tab-throbber");
        await TestUtils.waitForCondition(() => throbber.hasAttribute("busy"), "Native tab is busy");
        const normal = {
          tabImage: getComputedStyle(throbber).backgroundImage,
          mask: getComputedStyle(throbber).maskImage,
          barImage: getComputedStyle(bar).backgroundImage,
          lineColor: getComputedStyle(bar, "::before").backgroundColor,
          shadow: getComputedStyle(document.getElementById("tabbrowser-tabbox")).boxShadow,
          flourish: getComputedStyle(document.getElementById("zen-appcontent-wrapper"), "::after").content,
          accent: getComputedStyle(document.documentElement).getPropertyValue("--zen-primary-color"),
        };
        await SpecialPowers.pushPrefEnv({ set: [[SEASON_ENABLED, true]] });
        try {
          for (const [season, month] of [["autumn", 10], ["winter", 12], ["spring", 4], ["summer", 7]]) {
            WhimsySeasons._now = () => new Date(2026, month - 1, 15, 12);
            WhimsySeasons.apply(window);
            if (reduced) {
              assertSeasonGradient(throbber, null, season);
              ok(getComputedStyle(throbber).maskImage.includes("loading.svg"), "Reduced motion uses the static native icon");
              is(getComputedStyle(throbber, "::before").content, "none", "No sprite over the static gradient");
            } else {
              isnot(getComputedStyle(throbber, "::before").animationName, "none", "Normal motion retains the native spinning throbber");
              isnot(getComputedStyle(throbber, "::before").content, "none", "Native animated sprite remains present");
            }
            assertSeasonGradient(bar, "::before", season);
            if (line) {
              assertSeasonGradient(bar, "::after", season);
              is(getComputedStyle(bar).backgroundColor, "rgba(0, 0, 0, 0)", "Line track stays transparent");
            } else {
              assertSeasonGradient(bar, null, season);
            }
            if (reduced) {
              for (const pseudo of [null, "::before", "::after"]) {
                is(getComputedStyle(bar, pseudo).animationName, "none", "Reduced motion: no pulse or creep");
                is(getComputedStyle(bar, pseudo).transitionDuration, "0s", "Reduced motion: no transition");
              }
              is(getComputedStyle(throbber).animationName, "none", "Reduced motion: static tab indicator");
            }
          }
          is(getComputedStyle(document.getElementById("tabbrowser-tabbox")).boxShadow, normal.shadow, "No seasonal top border");
          is(getComputedStyle(document.getElementById("zen-appcontent-wrapper"), "::after").content, normal.flourish, "No seasonal overlay");
          is(getComputedStyle(document.documentElement).getPropertyValue("--zen-primary-color"), normal.accent, "Space accent stays unchanged");
          for (const pref of [SEASON_FEATURE, SEASON_ENABLED]) {
            await SpecialPowers.pushPrefEnv({ set: [[pref, false]] });
            is(getComputedStyle(throbber).backgroundImage, normal.tabImage, "Off restores native tab paint");
            is(getComputedStyle(throbber).maskImage, normal.mask, "Off restores native mask");
            is(getComputedStyle(bar).backgroundImage, normal.barImage, "Off restores native bar paint");
            is(getComputedStyle(bar, "::before").backgroundColor, normal.lineColor, "Off restores accent progress color");
            await SpecialPowers.popPrefEnv();
          }
          await loaded;
          await TestUtils.waitForCondition(() => !throbber.hasAttribute("busy"), "Completed tab loses its loading indicator");
          await TestUtils.waitForCondition(() => !bar.isConnected, "Completed page loses its progress bar");
        } finally {
          await SpecialPowers.popPrefEnv();
        }
      } finally {
        BrowserTestUtils.removeTab(tab);
        await SpecialPowers.popPrefEnv();
      }
    }
  }
});

add_task(async function seasonal_settings_label_and_toggle() {
  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const doc = browser.contentDocument;
    const checkbox = await TestUtils.waitForCondition(
      () => doc.getElementById("whimsySeasonalThemes"), "Seasonal checkbox exists"
    );
    await doc.l10n.translateElements([checkbox]);
    is(checkbox.getAttribute("label"), "Seasonal colors and costumes", "Short, plain label");
    await TestUtils.waitForCondition(() => checkbox.checked, "Setting is enabled");
    checkbox.click();
    await TestUtils.waitForCondition(() => !Services.prefs.getBoolPref(SEASON_ENABLED), "Setting turns colors off");
    ok(!document.documentElement.hasAttribute("whimsy-season"), "Settings updates the window");
    checkbox.click();
    await TestUtils.waitForCondition(() => Services.prefs.getBoolPref(SEASON_ENABLED), "Setting turns colors back on");
    ok(document.documentElement.hasAttribute("whimsy-season"), "Settings restores seasonal colors");
  });
});

// wave5: the Whimsy balloon dresses for the season on the homepage, the
// offline error page and in Balloon Dash. Dates are mocked; the switches
// take every costume off again.
const SEASON_MONTHS = [["autumn", 10], ["winter", 12], ["spring", 4], ["summer", 7]];
const COSTUME_DEATHS = {
  autumn: "whimsy-game-death-seed-autumn",
  winter: "whimsy-game-death-seed-winter",
  spring: "whimsy-game-death-seed-spring",
  summer: "whimsy-game-death-seed",
};

add_task(async function home_balloon_dresses_for_the_season() {
  const original = WhimsySeasons._now;
  try {
    await BrowserTestUtils.withNewTab("about:whimsy", async browser => {
      const doc = browser.contentDocument;
      const win = browser.contentWindow;
      const recheck = () => doc.dispatchEvent(new win.Event("visibilitychange"));
      const shown = () => [...doc.querySelectorAll("#whimsy-home-balloon .wh-costume")]
        .filter(g => win.getComputedStyle(g).display != "none")
        .map(g => g.dataset.season);
      for (const [season, month] of SEASON_MONTHS) {
        WhimsySeasons._now = () => new Date(2026, month - 1, 15, 12);
        recheck();
        is(doc.documentElement.getAttribute("whimsy-season"), season, `${season}: page knows the season`);
        Assert.deepEqual(shown(), [season], `${season}: exactly one costume shows`);
      }
      for (const pref of [SEASON_FEATURE, SEASON_ENABLED]) {
        await SpecialPowers.pushPrefEnv({ set: [[pref, false]] });
        recheck();
        ok(!doc.documentElement.hasAttribute("whimsy-season"), `${pref} off: no season`);
        Assert.deepEqual(shown(), [], `${pref} off: the balloon is undressed`);
        await SpecialPowers.popPrefEnv();
      }
      for (const costume of doc.querySelectorAll(".wh-costume")) {
        ok(costume.closest("svg[aria-hidden='true']"), "Costumes are decorative");
      }
      // Static: costumes add no animation of their own.
      WhimsySeasons._now = () => new Date(2026, 11, 15, 12);
      recheck();
      for (const costume of doc.querySelectorAll(".wh-costume")) {
        is(win.getComputedStyle(costume).animationName, "none", "No costume animation");
      }
    });
  } finally {
    WhimsySeasons._now = original;
  }
});

add_task(async function game_wears_the_season_in_both_styles() {
  const original = WhimsySeasons._now;
  try {
    for (const [season, month] of [...SEASON_MONTHS, [null, 10]]) {
      WhimsySeasons._now = () => new Date(2026, month - 1, 15, 12);
      if (!season) {
        await SpecialPowers.pushPrefEnv({ set: [[SEASON_ENABLED, false]] });
      }
      try {
        await BrowserTestUtils.withNewTab("about:whimsy?game", async browser => {
          const win = browser.contentWindow;
          const doc = browser.contentDocument;
          const game = await TestUtils.waitForCondition(() => win.__whimsyGame, "The game has loaded");
          game.freeze();
          game.setAutoSpawn(false);
          is(game.season, season, `${season}: the game reads the calendar`);
          is(doc.getElementById("whimsy-game-root").dataset.season, season ?? undefined, "Root carries the season");
          const radius = game.constants.HIT_R;
          for (const style of ["retro", "gradient"]) {
            doc.getElementById(`whimsy-game-style-${style}`).click();
            game.start();
            game.clear();
            game.spawn("seed", { x: 260, y: 60, vx: -30 });
            game.spawn("plane", { x: 330, y: 40, vx: -120, vy: 20 });
            game.spawn("bird", { cx: 400, cy: 90, R: 16, a: 1, vx: -40 });
            game.spawn("zap", { x: 200, t: 1.05, seed: 3 });
            game.spawn("sparkle", { x: 170, y: 100 });
            game.state.player.shield = 5;
            game.state.player.invuln = 5;
            game.tick(0.1);
            ok(true, `${season}/${style}: every costumed sprite renders`);
            game.clear();
            game.state.player.shield = 0;
            game.state.player.invuln = 0;
            game.spawn("seed");
            game.tick(0.4);
            is(game.state.state, "over", `${season}/${style}: the seed still hits like a seed`);
            is(game.state.deathKind, "seed", "Same hazard underneath");
            is(doc.getElementById("whimsy-game-death").getAttribute("data-l10n-id"),
              season ? COSTUME_DEATHS[season] : "whimsy-game-death-seed", "The game-over line matches the costume");
          }
          is(game.constants.HIT_R, radius, "Hitbox unchanged");
          await doc.l10n.translateRoots();
          ok(doc.getElementById("whimsy-game-death").textContent.trim(), "The seasonal line is localized");
        });
      } finally {
        if (!season) {
          await SpecialPowers.popPrefEnv();
        }
      }
    }
  } finally {
    WhimsySeasons._now = original;
    for (const pref of ["whimsy.game.style", "whimsy.game.high-score"]) {
      Services.prefs.clearUserPref(pref);
    }
  }
});

add_task(async function error_page_balloon_and_embedded_game_wear_the_season() {
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.feature.game", true],
    ["whimsy.feature.net-error-branding", true],
    ["security.certerrors.felt-privacy-v1", false],
  ] });
  try {
    for (const [season, month] of [...SEASON_MONTHS, [null, 10]]) {
      if (!season) {
        await SpecialPowers.pushPrefEnv({ set: [[SEASON_ENABLED, false]] });
      }
      const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
      const browser = tab.linkedBrowser;
      try {
        const loaded = BrowserTestUtils.waitForErrorPage(browser);
        await SpecialPowers.spawn(browser, [], () => {
          content.location = "about:neterror?e=netOffline&u=https%3A%2F%2Fexample.com%2F&d=Offline";
        });
        await loaded;
        // Mock the date in the page's own process, then let the actor
        // dress the page again.
        await SpecialPowers.spawn(browser, [season, month], async (season, month) => {
          const doc = content.document;
          await ContentTaskUtils.waitForCondition(() => doc.getElementById("whimsy-neterror-brand"), "Branded");
          const { WhimsySeasons } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySeasons.sys.mjs");
          WhimsySeasons._realNow ??= WhimsySeasons._now;
          WhimsySeasons._now = () => new Date(2026, month - 1, 15, 12);
          content.windowGlobalChild.getActor("WhimsyNetError").handleEvent({ type: "DOMContentLoaded" });
          doc.activeElement?.blur?.();
          is(doc.documentElement.getAttribute("data-whimsy-season"), season, `${season}: error page knows the season`);
          await ContentTaskUtils.waitForCondition(
            () => doc.getElementById("whimsy-neterror-style")?.sheet, "Stylesheet loaded"
          );
          const image = content.getComputedStyle(doc.getElementById("text-container"), "::before").backgroundImage;
          ok(image.includes("whimsy-deflated-balloon.svg"), "The balloon stays");
          if (season) {
            ok(image.includes(`whimsy-season-${season}.svg`), `${season}: the accent sits over it`);
            ok(image.indexOf(`whimsy-season-${season}.svg`) < image.indexOf("whimsy-deflated-balloon.svg"),
              "The accent is the top layer");
          } else {
            ok(!image.includes("whimsy-season-"), "Off: no accent");
          }
        });
        browser.focus();
        await BrowserTestUtils.synthesizeKey(" ", {}, browser);
        await SpecialPowers.spawn(browser, [season], async season => {
          const win = content.wrappedJSObject;
          await ContentTaskUtils.waitForCondition(() => win.__whimsyGame, "The embedded game ran");
          is(win.__whimsyGame.season, season, `${season}: the embedded game wears the same costume`);
        });
      } finally {
        await SpecialPowers.spawn(browser, [], () => {
          const { WhimsySeasons } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySeasons.sys.mjs");
          if (WhimsySeasons._realNow) {
            WhimsySeasons._now = WhimsySeasons._realNow;
            delete WhimsySeasons._realNow;
          }
        }).catch(() => {});
        BrowserTestUtils.removeTab(tab);
        if (!season) {
          await SpecialPowers.popPrefEnv();
        }
      }
    }
  } finally {
    await SpecialPowers.popPrefEnv();
    for (const pref of ["whimsy.game.style", "whimsy.game.high-score"]) {
      Services.prefs.clearUserPref(pref);
    }
  }
});
