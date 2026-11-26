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
  is(window.getComputedStyle(bar, "::after").content, "none", "The line is drawn by one layer");
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

// Samples the panel's progress every frame while the bar is up.
function sampler(tab) {
  const samples = [];
  let stop = false;
  const done = (async () => {
    const panel = gBrowser.getPanel(tab.linkedBrowser);
    while (!stop) {
      if (panel.querySelector(":scope > #zen-loading-progress-bar")) {
        samples.push(parseFloat(panel.style.getPropertyValue("--whimsy-load-progress")));
      }
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  })();
  return { samples, finish: async () => { stop = true; await done; } };
}

add_task(async function test_never_backward_complete_and_fresh() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  const second = `${SLOW_URL}?delay=700&second=1`;
  const first = `${SLOW_URL}?delay=500&replace=${encodeURIComponent(second)}`;
  const s = sampler(tab);
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, second);
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, first);
  await TestUtils.waitForCondition(indicator, "The indicator shows");
  await loaded;
  await TestUtils.waitForCondition(() => !indicator(), "Zen hides the bar");
  await s.finish();
  Assert.greater(s.samples.length, 5, "Sampled while the bar was up");
  for (let i = 1; i < s.samples.length; i++) {
    Assert.greaterOrEqual(s.samples[i], s.samples[i - 1], `Sample ${i} didn't go backward`);
  }
  is(s.samples.at(-1), 1, "The last sample is full");

  const next = sampler(tab);
  const again = await load(tab, 800);
  await TestUtils.waitForCondition(() => next.samples.length, "Sampled the next load");
  Assert.less(next.samples[0], 0.1, "A fresh load starts near zero");
  await again.loaded;
  await next.finish();
  BrowserTestUtils.removeTab(tab);
});

// W32 perf: the line's 100 ms creep timer runs only while a load is under
// way with the bar up; once it finishes, nothing wakes the browser.
add_task(async function test_timer_stops_when_the_load_finishes() {
  const { WhimsyTabs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTabs.sys.mjs");
  const line = WhimsyTabs._loadingLines.get(window);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  await TestUtils.waitForCondition(() => !line.ticking, "No load: no timer");
  const { loaded } = await load(tab, 1500);
  ok(line.ticking, "Mid-load, the line creeps");
  await loaded;
  await TestUtils.waitForCondition(() => !line.ticking, "The load finished: the timer is cleared");
  is(progress(tab), 1, "with the line full");
  await TestUtils.waitForCondition(() => !indicator(), "Zen hides the bar");
  await TestUtils.waitForCondition(() => !line.states.size, "and nothing is tracked any more");
  ok(!line.ticking, "The timer stays off");

  // A load in a background tab shows no bar, so it needs no timer.
  const background = BrowserTestUtils.addTab(gBrowser, "about:blank");
  await BrowserTestUtils.browserLoaded(background.linkedBrowser);
  const url = `${SLOW_URL}?delay=800&r=${Math.random()}`;
  const done = BrowserTestUtils.browserLoaded(background.linkedBrowser, false, url);
  BrowserTestUtils.startLoadingURIString(background.linkedBrowser, url);
  let ticked = false;
  const watch = setInterval(() => (ticked ||= line.ticking), 20);
  await done;
  clearInterval(watch);
  ok(!ticked, "A background load never starts the timer");
  await TestUtils.waitForCondition(() => !line.states.size, "and it isn't tracked once done");
  BrowserTestUtils.removeTab(background);
  BrowserTestUtils.removeTab(tab);
});
