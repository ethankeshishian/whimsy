/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function screenshots_site_panel() {
  await whimsyBothSchemes("w24-darkpages-site-panel", async () => {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
    await darkState(tab.linkedBrowser, "generated");
    gNavToolbox.setAttribute("zen-has-implicit-hover", "true");
    const panel = document.getElementById("zen-unified-site-data-panel");
    const shown = BrowserTestUtils.waitForEvent(panel, "popupshown");
    const moon = document.getElementById("whimsy-dark-page-button");
    ok(moon.checkVisibility(), "The moon is reachable beside the address");
    EventUtils.synthesizeMouseAtCenter(moon, {}, window);
    await shown;
    const row = document.querySelector('[whimsy-site-setting="dark-pages"]');
    ok(row?.checkVisibility(), "Dark page control is visible above Zoom");
    const zoom = document.querySelector('[whimsy-site-setting="zoom"]');
    ok(row.getBoundingClientRect().bottom <= zoom.getBoundingClientRect().top, "Matches the mockup's position");
    const undo = whimsyStandInPopups();
    return async () => {
      undo();
      await WhimsySiteSettings.hidePanel(window);
      gNavToolbox.removeAttribute("zen-has-implicit-hover");
      BrowserTestUtils.removeTab(tab);
    };
  });
});
