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
    const reader = document.querySelector('[whimsy-site-setting="reader"]');
    const control = row.querySelector("input.whimsy-surface-switch");
    ok(control, "An on/off switch");
    is(control.className, reader.querySelector("input").className, "The same switch as Always Open in Reader View");
    ok(!row.querySelector("button, .whimsy-surface-seg"), "No dropdown or segmented control");
    is(row.parentNode, autoplay.parentNode, "A row of the site list, not a separate tinted box");
    ok(!row.querySelector(".whimsy-surface-group, .whimsy-surface-caption"), "No box, heading, or subtitle");
    is(document.getElementById("whimsy-dark-page-site-label").textContent, "Automatic dark mode", "The row's label");
    const switchOn = () => document.getElementById("whimsy-site-settings-dark-pages-switch")?.checked;
    ok(switchOn(), "On while the page is dark");
    // The moon and the switch flip the same state, live.
    WhimsyDarkPages.toggle(tab.linkedBrowser);
    await darkState(tab.linkedBrowser, "original");
    await TestUtils.waitForCondition(() => switchOn() === false, "The switch follows the moon live");
    EventUtils.synthesizeMouseAtCenter(document.getElementById("whimsy-site-settings-dark-pages-switch"), {});
    await darkState(tab.linkedBrowser, "generated");
    ok(WhimsyDarkPages.isDark(tab.linkedBrowser), "The switch turns the page dark live");
    is(WhimsyDarkPages.choice(tab.linkedBrowser), "automatic", "On is the default here, so nothing is remembered");
    await TestUtils.waitForCondition(switchOn, "The switch is on again");
    const undo = whimsyStandInPopups();
    return async () => {
      undo();
      await WhimsySiteSettings.hidePanel(window);
      gNavToolbox.removeAttribute("zen-has-implicit-hover");
      BrowserTestUtils.removeTab(tab);
    };
  });
});
