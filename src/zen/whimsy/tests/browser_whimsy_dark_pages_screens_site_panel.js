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
    ok(row?.checkVisibility(), "The Automatic dark mode row is visible");
    const autoplay = document.querySelector('[whimsy-site-setting="autoplay"]');
    const kinds = [...row.parentNode.querySelectorAll(":scope > [whimsy-site-setting]")]
      .map(el => el.getAttribute("whimsy-site-setting"));
    Assert.deepEqual(kinds.slice(0, 4), ["zoom", "autoplay", "dark-pages", "reader"],
      "Zoom, Autoplay, Automatic dark mode, then Reader View");
    is(row.className.replace("whimsy-site-settings-dark-pages", ""),
      autoplay.className.replace("whimsy-site-settings-autoplay", ""), "The row uses Autoplay's row classes");
    const style = el => {
      const cs = getComputedStyle(el);
      return [cs.paddingTop, cs.paddingBottom, cs.paddingInlineStart, cs.paddingInlineEnd, cs.font,
        Math.round(el.getBoundingClientRect().height)];
    };
    Assert.deepEqual(style(row), style(autoplay), "Same padding, font, and height as Autoplay");
    const control = row.querySelector("button");
    is(control.className, autoplay.querySelector("button").className, "Same dropdown as Autoplay");
    ok(!row.querySelector(".whimsy-surface-seg"), "No segmented control");
    is(row.parentNode, autoplay.parentNode, "A row of the site list, not a separate tinted box");
    ok(!row.querySelector(".whimsy-surface-group, .whimsy-surface-caption"), "No box, heading, or subtitle");
    is(document.getElementById("whimsy-dark-page-site-label").textContent, "Automatic dark mode", "The row's label");
    // The moon and the row stay in sync live.
    WhimsyDarkPages.toggle(tab.linkedBrowser);
    await darkState(tab.linkedBrowser, "original");
    await TestUtils.waitForCondition(() =>
      document.getElementById("whimsy-site-settings-dark-pages-button")?.querySelector(".whimsy-surface-dropdown-value")
        ?.getAttribute("data-l10n-id") == "whimsy-dark-pages-original", "The row follows the moon live");
    WhimsyDarkPages.setChoice(tab.linkedBrowser, "automatic");
    await darkState(tab.linkedBrowser, "generated");
    await TestUtils.waitForCondition(() =>
      document.getElementById("whimsy-site-settings-dark-pages-button")?.querySelector(".whimsy-surface-dropdown-value")
        ?.getAttribute("data-l10n-id") == "whimsy-dark-pages-automatic", "The row is back on Automatic");
    const undo = whimsyStandInPopups();
    return async () => {
      undo();
      await WhimsySiteSettings.hidePanel(window);
      gNavToolbox.removeAttribute("zen-has-implicit-hover");
      BrowserTestUtils.removeTab(tab);
    };
  });
});
