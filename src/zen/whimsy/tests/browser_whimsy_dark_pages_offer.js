/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// browser-chrome loads only head.js automatically; load this suite explicitly.
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_whimsy_dark_pages.js",
  this
);

add_task(async function first_conversion_toast_once_and_turn_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.dark-pages.offered", false]] });
  try {
    await BrowserTestUtils.withNewTab(PAGE + "?theme=native", async browser => {
      await darkState(browser, "native");
      ok(!Services.prefs.getBoolPref("whimsy.dark-pages.offered"), "Native theme does not consume the offer");
    });
    await BrowserTestUtils.withNewTab(PAGE, async browser => {
      await darkState(browser, "generated");
      await TestUtils.waitForCondition(() => document.getElementById("whimsyDarkPagesTurnOff"), "Conversion shows the shared toast");
      const button = document.getElementById("whimsyDarkPagesTurnOff");
      ok(button.closest(".zen-toast"), "Uses the same styled component as other Whimsy toasts");
      EventUtils.synthesizeMouseAtCenter(button, {}, window);
      is(Services.prefs.getStringPref(MODE), "off", "Turn off disables Dark pages globally");
      await darkState(browser, "original");
      Services.prefs.setStringPref(MODE, "always");
      await darkState(browser, "generated");
      await TestUtils.waitForCondition(() => !document.getElementById("whimsyDarkPagesTurnOff"), "Offer does not reappear");
      ok(Services.prefs.getBoolPref("whimsy.dark-pages.offered"), "Offer is remembered across pages");
    });
    await BrowserTestUtils.withNewTab(PAGE, async browser => {
      await darkState(browser, "generated");
      ok(!document.getElementById("whimsyDarkPagesTurnOff"), "A new light page does not repeat the offer");
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});
