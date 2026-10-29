/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Loading progress line: Zen's loading pill becomes a thin line across the
// top of the page, filled by the page's real progress (--whimsy-load-progress
// on the tab's panel: 0 when a load starts, 1 when it stops). Off, or with
// the feature switch off, Zen's own pill is back.

const SLOW_URL = "http://mochi.test:8888/browser/zen/whimsy/tests/whimsy_slow_load.sjs";

function indicator() {
  return document.getElementById("zen-loading-progress-bar");
}

function progress(tab) {
  return parseFloat(gBrowser.getPanel(tab.linkedBrowser).style.getPropertyValue("--whimsy-load-progress"));
}

async function load(tab, delay) {
  const url = `${SLOW_URL}?delay=${delay}&r=${Math.random()}`;
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, url);
  const bar = await TestUtils.waitForCondition(indicator, "The loading indicator shows");
  return { bar, loaded };
}

add_task(async function test_line() {
  ok(Services.prefs.getBoolPref("whimsy.feature.loading-line"), "The feature switch is on");
  ok(Services.prefs.getBoolPref("whimsy.tabs.loading-line"), "The line is on by default");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  const { bar, loaded } = await load(tab, 1500);
  const style = window.getComputedStyle(bar);
  is(style.height, "2px", "The indicator is a thin line");
  const panel = gBrowser.getPanel(tab.linkedBrowser).getBoundingClientRect();
  Assert.greater(bar.getBoundingClientRect().width, panel.width * 0.8, "running across the page");
  Assert.lessOrEqual(Math.abs(bar.getBoundingClientRect().top - panel.top), 4, "along its top edge");
  Assert.less(progress(tab), 1, "Mid-load, the line isn't full");
  is(window.getComputedStyle(bar, "::before").backgroundColor, window.getComputedStyle(bar, "::after").backgroundColor, "Real and creeping progress share one color");
  await loaded;
  await TestUtils.waitForCondition(() => progress(tab) == 1, "Finished: the line fills");
  await TestUtils.waitForCondition(() => !indicator(), "and Zen hides it");

  // A new load starts from zero again.
  const next = await load(tab, 800);
  Assert.less(progress(tab), 1, "A new load starts over");
  await next.loaded;
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_off() {
  for (const pref of ["whimsy.tabs.loading-line", "whimsy.feature.loading-line"]) {
    await SpecialPowers.pushPrefEnv({ set: [[pref, false]] });
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
    const { bar, loaded } = await load(tab, 800);
    isnot(window.getComputedStyle(bar).height, "2px", `${pref} off: Zen's pill is back`);
    await loaded;
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_settings() {
  await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
    const doc = browser.contentDocument;
    const indicatorBox = await TestUtils.waitForCondition(() => doc.getElementById("whimsyLoadingIndicator"), "Indicator toggle shown");
    const line = doc.getElementById("whimsyLoadingLine");
    await TestUtils.waitForCondition(() => indicatorBox.checked && line.checked, "Both on by default");
    line.click();
    await TestUtils.waitForCondition(() => !Services.prefs.getBoolPref("whimsy.tabs.loading-line"), "Unchecking the line turns it off");
    indicatorBox.click();
    await TestUtils.waitForCondition(() => !Services.prefs.getBoolPref("zen.view.enable-loading-indicator"), "Unchecking the indicator turns Zen's off");
  });
  Services.prefs.clearUserPref("whimsy.tabs.loading-line");
  Services.prefs.clearUserPref("zen.view.enable-loading-indicator");
});
