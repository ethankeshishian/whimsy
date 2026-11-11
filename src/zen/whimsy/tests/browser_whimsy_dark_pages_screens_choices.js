/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function screenshots_choices() {
  await whimsyBothSchemes("w24-darkpages-original", async () => {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
    await darkState(tab.linkedBrowser, "generated");
    WhimsyDarkPages.setChoice(tab.linkedBrowser, "off");
    await darkState(tab.linkedBrowser, "original");
    return () => {
      WhimsyDarkPages.setChoice(tab.linkedBrowser, "automatic");
      BrowserTestUtils.removeTab(tab);
    };
  });
  await whimsyBothSchemes("w24-darkpages-dim-images", async () => {
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.dark-pages.dim-images", true]] });
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
    await darkState(tab.linkedBrowser, "generated");
    return async () => {
      BrowserTestUtils.removeTab(tab);
      await SpecialPowers.popPrefEnv();
    };
  });
  await whimsyBothSchemes("w24-darkpages-first-toast", async () => {
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.dark-pages.offered", false]] });
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
    await darkState(tab.linkedBrowser, "generated");
    await TestUtils.waitForCondition(() => document.getElementById("whimsyDarkPagesTurnOff"), "First conversion offers Turn off");
    return async () => {
      gZenUIManager.toasts.getToasts({ includeClosing: true }).forEach(toast => toast.close({ instant: true }));
      BrowserTestUtils.removeTab(tab);
      await SpecialPowers.popPrefEnv();
    };
  });
});
