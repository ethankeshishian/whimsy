/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Dim sleeping tabs: off by default; when on, every unloaded tab's icon and
// title fade (not just explicitly unloaded tabs' favicons, Firefox's own
// fade); loaded and selected tabs stay bright.

function opacity(tab) {
  return parseFloat(window.getComputedStyle(tab.querySelector(".tab-label-container")).opacity);
}

async function sleepingTab(url) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  const other = gBrowser.tabs.find(t => t != tab && !t.pinned && !t.hasAttribute("pending")) || gBrowser.tabs[0];
  gBrowser.selectedTab = other;
  await gBrowser.explicitUnloadTabs([tab]);
  await TestUtils.waitForCondition(() => tab.hasAttribute("pending"), "The tab is asleep");
  return tab;
}

async function settled(tab, expected, message) {
  await TestUtils.waitForCondition(() => Math.abs(opacity(tab) - expected) < 0.01, message);
}

add_task(async function test_default_off() {
  ok(Services.prefs.getBoolPref("whimsy.feature.dim-sleeping"), "The feature switch is on");
  ok(!Services.prefs.getBoolPref("whimsy.tabs.dim-sleeping"), "Dimming is off by default");
  const tab = await sleepingTab("https://example.com/");
  is(opacity(tab), 1, "Off: a sleeping tab's title isn't dimmed");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_dims_sleeping_tabs() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.tabs.dim-sleeping", true]] });
  const awake = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  const tab = await sleepingTab("https://example.com/");
  await settled(tab, 0.5, "A sleeping tab fades");
  is(opacity(awake), 1, "A loaded tab stays bright");
  is(
    parseFloat(window.getComputedStyle(tab.querySelector(".tab-icon-image")).opacity),
    1,
    "Firefox's favicon fade isn't stacked on top"
  );

  // Waking it up brings it back.
  gBrowser.selectedTab = tab;
  await TestUtils.waitForCondition(() => !tab.hasAttribute("pending"), "The tab wakes up");
  await settled(tab, 1, "A woken tab is bright again");

  // A tab restored but never opened (session restore's lazy tabs) is asleep too.
  const lazyTab = BrowserTestUtils.addTab(gBrowser, "https://example.com/lazy", { createLazyBrowser: true });
  await TestUtils.waitForCondition(() => lazyTab.hasAttribute("pending"), "A lazy tab is pending");
  await settled(lazyTab, 0.5, "It is dimmed too");

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.dim-sleeping", false]] });
  await settled(lazyTab, 1, "With the feature switch off, nothing is dimmed");
  await SpecialPowers.popPrefEnv();

  for (const t of [lazyTab, tab, awake]) {
    BrowserTestUtils.removeTab(t);
  }
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_settings_toggle() {
  await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
    const checkbox = await TestUtils.waitForCondition(() => browser.contentDocument.getElementById("whimsyDimSleepingTabs"));
    ok(!checkbox.checked, "The toggle is off");
    checkbox.click();
    await TestUtils.waitForCondition(() => Services.prefs.getBoolPref("whimsy.tabs.dim-sleeping"), "Checking turns it on");
    checkbox.click();
    await TestUtils.waitForCondition(() => !Services.prefs.getBoolPref("whimsy.tabs.dim-sleeping"), "Unchecking turns it off");
  });
  Services.prefs.clearUserPref("whimsy.tabs.dim-sleeping");
});
