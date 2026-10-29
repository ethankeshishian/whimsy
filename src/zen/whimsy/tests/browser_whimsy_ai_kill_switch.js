/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// AI kill switch: whimsy.ai.blocked turns off every Firefox AI feature (like
// Firefox's "Block AI enhancements") and Whimsy's, and turning it back off
// restores every pref exactly, Zen's defaults included.

const { WhimsyAI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAI.sys.mjs");

function controls() {
  return WhimsyAI.FEATURES.map(f => Services.prefs.getStringPref(f.control, ""));
}

async function setBlocked(value) {
  Services.prefs.setBoolPref(WhimsyAI.PREF, value);
  await WhimsyAI.pending;
}

add_task(async function test_defaults() {
  ok(Services.prefs.getBoolPref("whimsy.feature.ai-kill-switch"), "The feature switch is on");
  ok(!Services.prefs.getBoolPref(WhimsyAI.PREF), "AI isn't blocked by default");
  ok(!WhimsyAI.blocked, "WhimsyAI.blocked is false");
  is(Services.prefs.getStringPref("browser.ai.control.default"), "available", "Firefox's AI controls say available");
});

add_task(async function test_block_and_restore() {
  // A user choice that must survive the round trip.
  Services.prefs.setBoolPref("browser.tabs.groups.smart.userEnabled", true);
  const before = {
    smart: Services.prefs.prefHasUserValue("browser.tabs.groups.smart.enabled"),
    chat: Services.prefs.getBoolPref("browser.ml.chat.enabled"),
    linkPreview: Services.prefs.getBoolPref("browser.ml.linkPreview.enabled"),
    ml: Services.prefs.getBoolPref("browser.ml.enable"),
    translations: Services.prefs.getBoolPref("browser.translations.enable"),
  };

  await setBlocked(true);
  ok(WhimsyAI.blocked, "WhimsyAI.blocked is true, for Whimsy's own AI");
  is(Services.prefs.getStringPref("browser.ai.control.default"), "blocked", "Firefox's global AI control is blocked");
  ok(controls().every(c => c == "blocked"), "Every AI feature's control is blocked");
  ok(!Services.prefs.getBoolPref("browser.ml.chat.enabled"), "The chatbot is off");
  ok(!Services.prefs.getBoolPref("browser.ml.linkPreview.enabled"), "Link previews are off");
  ok(!Services.prefs.getBoolPref("browser.tabs.groups.smart.enabled"), "Smart tab groups are off");
  ok(!Services.prefs.getBoolPref("browser.ml.enable"), "The ML engine is off");
  ok(!Services.prefs.getBoolPref("extensions.ml.enabled"), "The ML API for extensions is off");
  is(Services.prefs.getBoolPref("browser.translations.enable"), before.translations, "Translations are left alone");

  // Applying again is a no-op.
  await WhimsyAI.apply();
  ok(controls().every(c => c == "blocked"), "Still blocked");

  await setBlocked(false);
  ok(!WhimsyAI.blocked, "Unblocked");
  ok(!Services.prefs.prefHasUserValue("browser.ai.control.default"), "The global control is back to its default");
  ok(controls().every(c => c != "blocked"), "No feature control is left blocked");
  is(Services.prefs.getBoolPref("browser.ml.chat.enabled"), before.chat, "The chatbot is as before (Zen: off)");
  is(Services.prefs.getBoolPref("browser.ml.linkPreview.enabled"), before.linkPreview, "Link previews as before");
  is(Services.prefs.getBoolPref("browser.ml.enable"), before.ml, "The ML engine as before");
  is(Services.prefs.prefHasUserValue("browser.tabs.groups.smart.enabled"), before.smart, "Untouched prefs have no user value again");
  ok(Services.prefs.getBoolPref("browser.tabs.groups.smart.userEnabled"), "The user's own choice is restored");
  ok(!Services.prefs.prefHasUserValue("whimsy.ai.restore"), "Nothing is left to restore");
  Services.prefs.clearUserPref("browser.tabs.groups.smart.userEnabled");
});

add_task(async function test_feature_switch_off() {
  await setBlocked(true);
  Services.prefs.setBoolPref("whimsy.feature.ai-kill-switch", false);
  await WhimsyAI.pending;
  ok(!WhimsyAI.blocked, "With the feature switch off, nothing is blocked");
  ok(!Services.prefs.prefHasUserValue("browser.ai.control.default"), "And Firefox's controls are restored");
  Services.prefs.clearUserPref("whimsy.feature.ai-kill-switch");
  await WhimsyAI.pending;
  ok(WhimsyAI.blocked, "Switching the feature back on re-applies the user's choice");
  await setBlocked(false);
  Services.prefs.clearUserPref(WhimsyAI.PREF);
});

add_task(async function test_settings_toggle() {
  await BrowserTestUtils.withNewTab("about:preferences#privacy", async browser => {
    const doc = browser.contentDocument;
    const checkbox = await TestUtils.waitForCondition(() => doc.getElementById("whimsyBlockAI"));
    ok(!checkbox.checked, "The toggle is off");
    checkbox.click();
    await TestUtils.waitForCondition(() => WhimsyAI.blocked, "Checking it blocks AI");
    await WhimsyAI.pending;
    is(Services.prefs.getStringPref("browser.ai.control.default"), "blocked", "Firefox's AI is blocked");
    checkbox.click();
    await TestUtils.waitForCondition(() => !WhimsyAI.blocked, "Unchecking restores it");
    await WhimsyAI.pending;
  });
  Services.prefs.clearUserPref(WhimsyAI.PREF);
});
