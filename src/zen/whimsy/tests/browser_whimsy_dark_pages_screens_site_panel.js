/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// browser-chrome loads only head.js automatically; load this suite explicitly.
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_whimsy_dark_pages.js",
  this
);

add_task(async function screenshots_site_panel() {
  await whimsyBothSchemes("w24-darkpages-site-panel", async () => {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
    await darkState(tab.linkedBrowser, "generated");
    gNavToolbox.setAttribute("zen-has-implicit-hover", "true");
    const panel = document.getElementById("zen-unified-site-data-panel");
    const shown = BrowserTestUtils.waitForEvent(panel, "popupshown");
    WhimsySiteSettings.open(window, { focus: "dark-pages" });
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
