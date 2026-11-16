/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// browser-chrome loads only head.js automatically; load this suite explicitly.
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_whimsy_dark_pages.js",
  this
);

requestLongerTimeout(2);

// The URL bar moon: a shared page action that auto-hides like its siblings.
// Owner (W29): the global setting decides and the site switch overrides
// it, so the moon shows only on an overridden site; one click sets the site
// back to the global setting, live, with no reload.
add_task(async function moon_shows_on_overrides_and_resets_live() {
  await SpecialPowers.pushPrefEnv({ set: [[MODE, "off"]] });
  // A light browser: in a dark one (macOS's automatic appearance after
  // sunset), a site's own dark theme is already its original look, so the
  // live change below couldn't be seen.
  await whimsySetScheme(false);
  const moon = document.getElementById("whimsy-dark-page-button");
  try {
    for (const theme of ["native", "light"]) {
      await BrowserTestUtils.withNewTab(`${PAGE}?theme=${theme}`, async browser => {
        await darkState(browser, "original");
        ok(moon.hidden, "A site that follows the global setting shows no moon");
        const before = await colors(browser);
        ok(!before.scheme, "The browser is light, so the page starts in its light look");
        const windowId = browser.innerWindowID;
        // The site panel's switch overrides the global setting.
        WhimsyDarkPages.setDark(browser, true);
        await darkState(browser, theme == "native" ? "native" : "generated");
        is(WhimsyDarkPages.choice(browser), "on", "The override is remembered for the site");
        await TestUtils.waitForCondition(() => !moon.hidden && moon.hasAttribute("active"),
          "The overridden site shows the moon, in the dark state");
        ok(moon.classList.contains("urlbar-page-action"), "The moon uses the shared page-action class");
        ok(moon.querySelector(":scope > .urlbar-icon"), "The moon's glyph is a shared urlbar icon");
        is(moon.getAttribute("aria-pressed"), "true", "The moon is a pressed toggle");
        if (document.documentElement.getAttribute("zen-single-toolbar") == "true") {
          gNavToolbox.removeAttribute("zen-has-implicit-hover");
          await TestUtils.waitForCondition(() => getComputedStyle(moon).visibility != "visible",
            "Unhovered, the moon hides like the other page actions");
        }
        gNavToolbox.setAttribute("zen-has-implicit-hover", "true");
        await TestUtils.waitForCondition(() => getComputedStyle(moon).visibility == "visible" &&
          getComputedStyle(moon).opacity == "1", "Hovering the toolbar reveals the moon");
        const dark = await colors(browser);
        is(browser.innerWindowID, windowId, "Dark applied to the same document, without a reload");
        if (theme == "native") {
          isnot(dark.background, before.background, "The site's own dark theme applied live");
          ok(!dark.inverted, "A native theme is never inverted on top");
        } else {
          ok(dark.inverted, "Generated colors applied live");
          ok(Math.max(...dark.paintedBackground.slice(0, 3)) < 100, "The painted page is dark");
        }
        let popups = 0;
        const counter = () => popups++;
        document.addEventListener("popupshowing", counter);
        EventUtils.synthesizeMouseAtCenter(moon, {}, window);
        await darkState(browser, "original");
        is(WhimsyDarkPages.choice(browser), "automatic", "Back at the global setting, nothing is remembered");
        await TestUtils.waitForCondition(() => moon.hidden, "The moon goes away with the override");
        const original = await colors(browser);
        is(browser.innerWindowID, windowId, "Original restored in the same document");
        is(original.background, before.background, "The original colors are back");
        ok(!original.inverted, "No inversion remains");
        document.removeEventListener("popupshowing", counter);
        is(popups, 0, "A click never opens a menu or panel");
      });
    }
  } finally {
    gNavToolbox.removeAttribute("zen-has-implicit-hover");
    await SpecialPowers.popPrefEnv();
    await SpecialPowers.popPrefEnv();
  }
});

// Global on: the switch starts on, a site turned off is the override that
// shows the moon, and matching the global setting again clears the entry.
add_task(async function override_is_stored_only_when_it_differs() {
  await SpecialPowers.pushPrefEnv({ set: [[MODE, "always"]] });
  const moon = document.getElementById("whimsy-dark-page-button");
  try {
    await BrowserTestUtils.withNewTab(PAGE, async browser => {
      await darkState(browser, "generated");
      ok(WhimsyDarkPages.isDark(browser), "The site switch starts at the global value");
      ok(moon.hidden, "No override, no moon");
      WhimsyDarkPages.setDark(browser, true);
      is(WhimsyDarkPages.choice(browser), "automatic", "Matching the global setting stores nothing");
      WhimsyDarkPages.setDark(browser, false);
      await darkState(browser, "original");
      is(WhimsyDarkPages.choice(browser), "off", "A site that differs is stored");
      await TestUtils.waitForCondition(() => !moon.hidden && !moon.hasAttribute("active"),
        "The overridden site shows the moon, in the original state");
      WhimsyDarkPages.setDark(browser, true);
      await darkState(browser, "generated");
      Assert.deepEqual(WhimsyDarkPages.sites(), {}, "Setting it back clears the entry");
      await TestUtils.waitForCondition(() => moon.hidden, "The moon goes away");
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function screenshots_moon_rest_and_hover() {
  await SpecialPowers.pushPrefEnv({ set: [[MODE, "off"]] });
  const moon = document.getElementById("whimsy-dark-page-button");
  try {
    await BrowserTestUtils.withNewTab(PAGE, async browser => {
      await darkState(browser, "original");
      // The moon shows only on an overridden site.
      WhimsyDarkPages.setDark(browser, true);
      await darkState(browser, "generated");
      for (const dark of [false, true]) {
        await whimsySetScheme(dark);
        try {
          gNavToolbox.setAttribute("zen-has-implicit-hover", "true");
          await TestUtils.waitForCondition(() => getComputedStyle(moon).opacity == "1", "The moon shows on toolbar hover");
          await whimsySettled(document);
          await whimsyShot(`w25-moon-rest-${dark ? "dark" : "light"}`);
          // The test window may not own the OS pointer: lock :hover instead.
          InspectorUtils.addPseudoClassLock(moon, ":hover");
          try {
            ok(moon.matches(":hover"), "The moon shows its hover state");
            await whimsySettled(document);
            await whimsyShot(`w25-moon-hover-${dark ? "dark" : "light"}`);
          } finally {
            InspectorUtils.removePseudoClassLock(moon, ":hover");
          }
        } finally {
          await SpecialPowers.popPrefEnv();
        }
      }
      WhimsyDarkPages.setChoice(browser, "automatic");
    });
  } finally {
    gNavToolbox.removeAttribute("zen-has-implicit-hover");
    await SpecialPowers.popPrefEnv();
  }
});
