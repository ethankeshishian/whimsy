/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Liquid Glass (whimsy.look.liquid-glass, off by default): on macOS 26+ the
// chrome goes see-through over the window's native glass (the engine side,
// whimsy-nsCocoaWindow-mm.patch, swaps the backdrop view; Gecko can't see
// it, so this covers the pref wiring). At transparency 0 it uses a light
// level; a chosen level wins; the feature switches and Reduce Transparency
// turn it off; Settings has the checkbox only where glass exists.

const GLASS = "whimsy.look.liquid-glass";
const GLASS_FEATURE = "whimsy.feature.liquid-glass";
const TRANSPARENCY = "whimsy.look.transparency";
const TRANSPARENCY_FEATURE = "whimsy.feature.transparency";

const { GLASS_TRANSPARENCY } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLook.sys.mjs");

registerCleanupFunction(() => {
  for (const pref of [GLASS, GLASS_FEATURE, TRANSPARENCY, TRANSPARENCY_FEATURE]) {
    Services.prefs.clearUserPref(pref);
  }
});

const root = () => document.documentElement;
const hasGlass = () => matchMedia("(-moz-mac-tahoe-theme)").matches;
const reduced = () => matchMedia("(prefers-reduced-transparency: reduce)").matches;

function backgroundOpacity() {
  return parseFloat(getComputedStyle(document.getElementById("zen-browser-background")).opacity);
}

function waitForOpacity(expected, message) {
  return TestUtils.waitForCondition(() => Math.abs(backgroundOpacity() - expected) < 0.01, message);
}

add_task(async function test_off_by_default() {
  is(Services.prefs.getBoolPref(GLASS), false, "Liquid Glass is off by default");
  ok(Services.prefs.getBoolPref(GLASS_FEATURE), "The feature switch is on");
  ok(!root().hasAttribute("whimsy-liquid-glass"), "Nothing applied by default");
  is(backgroundOpacity(), 1, "Zen's opaque background");
});

add_task(async function test_pref_wiring() {
  Services.prefs.setBoolPref(GLASS, true);
  if (!hasGlass() || reduced()) {
    // Older macOS (or Reduce Transparency): the setting changes nothing.
    ok(!root().hasAttribute("whimsy-liquid-glass"), "No glass without macOS 26 or with Reduce Transparency");
    is(backgroundOpacity(), 1, "The chrome stays opaque");
    Services.prefs.clearUserPref(GLASS);
    return;
  }
  ok(root().hasAttribute("whimsy-liquid-glass"), "Applied");
  ok(root().hasAttribute("whimsy-transparency"), "The chrome goes see-through");
  await waitForOpacity(1 - GLASS_TRANSPARENCY / 100, "A light level when Transparency is off");

  Services.prefs.setIntPref(TRANSPARENCY, 60);
  await waitForOpacity(0.4, "The chosen Transparency level wins");
  Services.prefs.clearUserPref(TRANSPARENCY);
  await waitForOpacity(1 - GLASS_TRANSPARENCY / 100, "back to the light level");

  Services.prefs.setBoolPref(GLASS_FEATURE, false);
  ok(!root().hasAttribute("whimsy-liquid-glass"), "The feature switch turns it off");
  await waitForOpacity(1, "opaque again");
  Services.prefs.clearUserPref(GLASS_FEATURE);
  ok(root().hasAttribute("whimsy-liquid-glass"), "and back on");

  Services.prefs.setBoolPref(TRANSPARENCY_FEATURE, false);
  ok(!root().hasAttribute("whimsy-liquid-glass"), "It needs the transparency switch");
  await waitForOpacity(1, "opaque without transparency");
  Services.prefs.clearUserPref(TRANSPARENCY_FEATURE);

  Services.prefs.setBoolPref(GLASS, false);
  ok(!root().hasAttribute("whimsy-liquid-glass"), "Turning it off removes it");
  await waitForOpacity(1, "Zen's look again");
  Services.prefs.clearUserPref(GLASS);
});

add_task(async function test_settings_checkbox() {
  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const doc = browser.contentDocument;
    const slider = await TestUtils.waitForCondition(() => doc.getElementById("whimsyTransparency"));
    ok(slider, "Look and Feel is ready");
    const checkbox = doc.getElementById("whimsyLiquidGlass");
    const supported = AppConstants.isPlatformAndVersionAtLeast("macosx", "25");
    if (!supported) {
      ok(!checkbox, "No Liquid Glass setting before macOS 26");
      return;
    }
    ok(checkbox, "Settings → Look and Feel has Liquid Glass");
    ok(!checkbox.checked, "unchecked by default");
    const description = doc.getElementById("whimsyLiquidGlassDescription");
    await TestUtils.waitForCondition(() => description.textContent.length, "It explains itself");
    checkbox.click();
    await TestUtils.waitForCondition(() => Services.prefs.getBoolPref(GLASS), "Checking it sets the pref");
    checkbox.click();
    await TestUtils.waitForCondition(() => !Services.prefs.getBoolPref(GLASS), "Unchecking clears it");
    Services.prefs.clearUserPref(GLASS);
  });
});

add_task(async function test_settings_hidden_with_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [[GLASS_FEATURE, false]] });
  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.getElementById("whimsyTransparency"));
    ok(!doc.getElementById("whimsyLiquidGlass"), "The feature switch removes the setting");
  });
  await SpecialPowers.popPrefEnv();
});
