/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// browser-chrome loads only head.js automatically; load this suite explicitly.
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_whimsy_dark_pages.js",
  this
);

add_task(async function per_site_persistence_and_global_override() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await darkState(browser, "generated");
    WhimsyDarkPages.setChoice(browser, "off");
    await darkState(browser, "original");
    is(WhimsyDarkPages.choice(browser), "off", "Original is remembered for the site");
    const loaded = BrowserTestUtils.browserLoaded(browser);
    browser.reload();
    await loaded;
    await darkState(browser, "original");
    is((await colors(browser)).background, "rgb(255, 255, 255)", "Persisted Original survives reload");
    WhimsyDarkPages.setChoice(browser, "automatic");
    await darkState(browser, "generated");
    await SpecialPowers.pushPrefEnv({ set: [[MODE, "off"]] });
    await darkState(browser, "original");
    WhimsyDarkPages.setChoice(browser, "on");
    await darkState(browser, "generated");
    is(WhimsyDarkPages.choice(browser), "on", "Dark explicitly overrides the global default");
    WhimsyDarkPages.setChoice(browser, "automatic");
    await darkState(browser, "original");
    await SpecialPowers.popPrefEnv();
  });
});

// The URL bar moon: a shared page action that auto-hides like its siblings,
// and one click flips the page between dark and original live, no reload.
add_task(async function moon_toggles_live_without_reload() {
  await SpecialPowers.pushPrefEnv({ set: [[MODE, "off"]] });
  const moon = document.getElementById("whimsy-dark-page-button");
  try {
    for (const theme of ["native", "light"]) {
      await BrowserTestUtils.withNewTab(`${PAGE}?theme=${theme}`, async browser => {
        await darkState(browser, "original");
        ok(moon.classList.contains("urlbar-page-action"), "The moon uses the shared page-action class");
        ok(moon.querySelector(":scope > .urlbar-icon"), "The moon's glyph is a shared urlbar icon");
        ok(!moon.hidden && !moon.hasAttribute("active"), "The moon shows the original state");
        if (document.documentElement.getAttribute("zen-single-toolbar") == "true") {
          gNavToolbox.removeAttribute("zen-has-implicit-hover");
          await TestUtils.waitForCondition(() => getComputedStyle(moon).visibility != "visible",
            "Unhovered, the moon hides like the other page actions");
        }
        gNavToolbox.setAttribute("zen-has-implicit-hover", "true");
        await TestUtils.waitForCondition(() => getComputedStyle(moon).visibility == "visible" &&
          getComputedStyle(moon).opacity == "1", "Hovering the toolbar reveals the moon");
        const before = await colors(browser);
        const windowId = browser.innerWindowID;
        let popups = 0;
        const counter = () => popups++;
        document.addEventListener("popupshowing", counter);
        EventUtils.synthesizeMouseAtCenter(moon, {}, window);
        await darkState(browser, theme == "native" ? "native" : "generated");
        await TestUtils.waitForCondition(() => moon.hasAttribute("active"), "The moon shows the dark state");
        is(moon.getAttribute("aria-pressed"), "true", "The moon is a pressed toggle");
        const dark = await colors(browser);
        is(browser.innerWindowID, windowId, "Dark applied to the same document, without a reload");
        if (theme == "native") {
          isnot(dark.background, before.background, "The site's own dark theme applied live");
          ok(!dark.inverted, "A native theme is never inverted on top");
        } else {
          ok(dark.inverted, "Generated colors applied live");
          ok(Math.max(...dark.paintedBackground.slice(0, 3)) < 100, "The painted page is dark");
        }
        is(WhimsyDarkPages.choice(browser), "on", "The click is remembered for the site");
        EventUtils.synthesizeMouseAtCenter(moon, {}, window);
        await darkState(browser, "original");
        await TestUtils.waitForCondition(() => !moon.hasAttribute("active"), "The moon shows the original state again");
        const original = await colors(browser);
        is(browser.innerWindowID, windowId, "Original restored in the same document");
        is(original.background, before.background, "The original colors are back");
        ok(!original.inverted, "No inversion remains");
        document.removeEventListener("popupshowing", counter);
        is(popups, 0, "A click never opens a menu or panel");
        WhimsyDarkPages.setChoice(browser, "automatic");
      });
    }
  } finally {
    gNavToolbox.removeAttribute("zen-has-implicit-hover");
    await SpecialPowers.popPrefEnv();
  }
});
