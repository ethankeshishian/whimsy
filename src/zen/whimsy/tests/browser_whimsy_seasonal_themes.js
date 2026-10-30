/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { WhimsySeasons } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySeasons.sys.mjs");
requestLongerTimeout(2);

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
    is(checkbox.getAttribute("label"), "Seasonal loading colors", "Short, plain label");
    await TestUtils.waitForCondition(() => checkbox.checked, "Setting is enabled");
    checkbox.click();
    await TestUtils.waitForCondition(() => !Services.prefs.getBoolPref(SEASON_ENABLED), "Setting turns colors off");
    ok(!document.documentElement.hasAttribute("whimsy-season"), "Settings updates the window");
    checkbox.click();
    await TestUtils.waitForCondition(() => Services.prefs.getBoolPref(SEASON_ENABLED), "Setting turns colors back on");
    ok(document.documentElement.hasAttribute("whimsy-season"), "Settings restores seasonal colors");
  });
});
