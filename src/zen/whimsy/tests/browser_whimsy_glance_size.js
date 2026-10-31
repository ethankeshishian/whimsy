/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// batch3glance: Glance size (whimsy.glance.size). The card, and the arc
// animation Zen draws to it, use the chosen width; "standard" and the
// switch off both leave Zen's 80%.

const { openGlanceOnTab } = ChromeUtils.importESModule("resource://testing-common/GlanceTestUtils.sys.mjs");

const SIZE_PREF = "whimsy.glance.size";

// The open card's width as a fraction of the tab panels' width.
async function openedWidthFraction() {
  let fraction;
  await openGlanceOnTab(window, async glanceTab => {
    const wrapper = glanceTab.linkedBrowser.closest(".browserContainer");
    await TestUtils.waitForCondition(
      () => wrapper.getAttribute("has-finished-animation") == "true",
      "The Glance finished opening"
    );
    const panels = gBrowser.tabpanels.getBoundingClientRect().width;
    fraction = wrapper.getBoundingClientRect().width / panels;
  });
  return fraction;
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.glance-size", true]] });
  registerCleanupFunction(() => Services.prefs.clearUserPref(SIZE_PREF));
});

add_task(async function test_sizes_change_the_open_card() {
  const parent = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  for (const [size, expected] of [
    ["compact", 0.6],
    ["standard", 0.8],
    ["wide", 0.9],
  ]) {
    Services.prefs.setStringPref(SIZE_PREF, size);
    is(gZenGlanceManager.whimsyWidthPercent, expected, `${size}: Zen's arc animates to ${expected}`);
    is(
      document.documentElement.style.getPropertyValue("--whimsy-glance-width"),
      `${Math.round(expected * 100)}%`,
      `${size}: the CSS width matches`
    );
    const fraction = await openedWidthFraction();
    Assert.less(Math.abs(fraction - expected), 0.01, `${size}: the open card is ${Math.round(expected * 100)}% wide (${fraction})`);
  }
  BrowserTestUtils.removeTab(parent);
});

add_task(async function test_unknown_value_falls_back_to_standard() {
  Services.prefs.setStringPref(SIZE_PREF, "enormous");
  is(gZenGlanceManager.whimsyWidthPercent, 0.8, "An unknown size is Zen's 80%");
  Services.prefs.clearUserPref(SIZE_PREF);
  is(gZenGlanceManager.whimsyWidthPercent, 0.8, "The default is Zen's 80%");
});

add_task(async function test_switch_off_hands_back_to_zen() {
  Services.prefs.setStringPref(SIZE_PREF, "compact");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.glance-size", false]] });
  is(gZenGlanceManager.whimsyWidthPercent, undefined, "Zen's own 80% applies");
  ok(!document.documentElement.hasAttribute("whimsy-glance-sizing"), "The size rule is off");
  const parent = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  const fraction = await openedWidthFraction();
  Assert.less(Math.abs(fraction - 0.8), 0.01, `The card is Zen's 80% (${fraction})`);
  BrowserTestUtils.removeTab(parent);
  await SpecialPowers.popPrefEnv();
  ok(document.documentElement.hasAttribute("whimsy-glance-sizing"), "Turning it back on applies at once");
  Services.prefs.clearUserPref(SIZE_PREF);
});

add_task(async function test_resizes_already_open_glance() {
  const parent = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  Services.prefs.setStringPref(SIZE_PREF, "standard");
  await openGlanceOnTab(window, async glanceTab => {
    const wrapper = glanceTab.linkedBrowser.closest(".browserContainer");
    await TestUtils.waitForCondition(
      () => wrapper.getAttribute("has-finished-animation") == "true",
      "The Glance finished opening"
    );
    const panels = gBrowser.tabpanels.getBoundingClientRect().width;
    let fraction = wrapper.getBoundingClientRect().width / panels;
    Assert.less(Math.abs(fraction - 0.8), 0.01, "Starts standard (80%)");

    Services.prefs.setStringPref(SIZE_PREF, "wide");
    await TestUtils.waitForCondition(
      () => Math.abs(wrapper.getBoundingClientRect().width / panels - 0.9) < 0.01,
      "Resized to wide (90%) while open"
    );

    Services.prefs.setStringPref(SIZE_PREF, "compact");
    await TestUtils.waitForCondition(
      () => Math.abs(wrapper.getBoundingClientRect().width / panels - 0.6) < 0.01,
      "Resized to compact (60%) while open"
    );
  });
  BrowserTestUtils.removeTab(parent);
  Services.prefs.clearUserPref(SIZE_PREF);
});
