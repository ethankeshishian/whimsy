/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// AI kill switch: Enable AI (whimsy.ai.enabled, Settings → AI; W10-28, it
// was "Turn off all AI features", whimsy.ai.blocked) off turns off every
// Firefox AI feature (like Firefox's "Block AI enhancements") and Whimsy's,
// and turning it back on restores every pref exactly, Zen's defaults
// included.

const { WhimsyAI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAI.sys.mjs");

function controls() {
  return WhimsyAI.FEATURES.map(f => Services.prefs.getStringPref(f.control, ""));
}

async function setBlocked(value) {
  Services.prefs.setBoolPref(WhimsyAI.PREF, !value);
  await WhimsyAI.pending;
}

add_task(async function test_defaults() {
  ok(Services.prefs.getBoolPref("whimsy.feature.ai-kill-switch"), "The feature switch is on");
  is(WhimsyAI.PREF, "whimsy.ai.enabled", "Enable AI is the switch");
  // W23: off until a provider connects (browser.toml turns it on for tests).
  ok(!Services.prefs.getDefaultBranch("").getBoolPref(WhimsyAI.PREF), "AI is off by default");
  Services.prefs.clearUserPref(WhimsyAI.PREF);
  await WhimsyAI.pending;
  ok(!WhimsyAI.enabled && WhimsyAI.blocked, "A fresh profile starts with AI off");
  is(Services.prefs.getStringPref("browser.ai.control.default"), "blocked", "and Firefox's AI blocked too");
  Services.prefs.setBoolPref(WhimsyAI.PREF, true);
  await WhimsyAI.pending;
  ok(!WhimsyAI.blocked, "On: WhimsyAI.blocked is false");
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
  Services.prefs.setBoolPref(WhimsyAI.PREF, true);
});

// The old switch: a profile that had AI turned off keeps it off, the
// controls aren't touched, and for one release the old pref mirrors the new
// one (a rolled-back build reads it).
add_task(async function test_migration_and_mirror() {
  Services.prefs.clearUserPref(WhimsyAI.PREF);
  Services.prefs.setBoolPref(WhimsyAI.LEGACY_PREF, true);
  Services.prefs.setStringPref("browser.ai.control.default", "blocked");
  WhimsyAI.migrate();
  ok(!Services.prefs.getBoolPref(WhimsyAI.PREF), "Blocked before: Enable AI is off");
  ok(WhimsyAI.blocked, "AI stays blocked");
  is(Services.prefs.getStringPref("browser.ai.control.default"), "blocked", "The controls are left as they were");
  WhimsyAI.migrate();
  ok(!Services.prefs.getBoolPref(WhimsyAI.PREF), "Running it again changes nothing");
  Services.prefs.setBoolPref(WhimsyAI.PREF, true);
  await WhimsyAI.pending;
  ok(!Services.prefs.prefHasUserValue(WhimsyAI.LEGACY_PREF), "Enabled: the old pref says not blocked");
  Services.prefs.setBoolPref(WhimsyAI.PREF, false);
  await WhimsyAI.pending;
  ok(Services.prefs.getBoolPref(WhimsyAI.LEGACY_PREF), "Disabled: the old pref says blocked");
  await setBlocked(false);
  Services.prefs.setBoolPref(WhimsyAI.PREF, true);
  Services.prefs.clearUserPref("browser.ai.control.default");
  await WhimsyAI.pending;
});

// W10-28: Settings → AI: Enable AI heads its own pane; off dims and
// disables everything below it, with a note.
add_task(async function test_settings_pane() {
  await BrowserTestUtils.withNewTab("about:preferences#whimsyAI", async browser => {
    const doc = browser.contentDocument;
    const nav = await TestUtils.waitForCondition(() => doc.getElementById("category-whimsy-ai"), "AI is in the sidebar");
    is(nav.getAttribute("view"), "paneWhimsyAI", "It opens the AI pane");
    const toggle = await TestUtils.waitForCondition(() => doc.getElementById("whimsyAIEnable"));
    await TestUtils.waitForCondition(() => toggle.checkVisibility(), "Enable AI shows");
    ok(toggle.pressed, "Enable AI is on");
    ok(!doc.getElementById("whimsyBlockAI"), "The old Privacy switch is gone");
    ok(!doc.querySelector('#mainPrefPane [data-category="panePrivacy"] #whimsyAIUse'), "No AI controls left in Privacy");
    const rest = [...doc.querySelectorAll('[data-category="paneWhimsyAI"].whimsy-ai-rest')];
    ok(rest.length >= 2, "Provider and Features sit under it");
    const note = doc.getElementById("whimsyAIOffNote");
    ok(note.hidden, "No note while AI is on");

    toggle.click();
    await TestUtils.waitForCondition(() => WhimsyAI.blocked, "Turning it off blocks AI");
    await WhimsyAI.pending;
    is(Services.prefs.getStringPref("browser.ai.control.default"), "blocked", "Firefox's AI is blocked");
    await TestUtils.waitForCondition(() => !note.hidden, "The note says AI is off");
    for (const section of rest) {
      ok(section.inert && section.hasAttribute("data-ai-off"), `#${section.id} is dimmed and out of reach`);
      const controls = [...section.querySelectorAll("input, button, menulist, moz-toggle")];
      ok(controls.every(c => c.disabled), `#${section.id}: every control is disabled`);
    }
    toggle.click();
    await TestUtils.waitForCondition(() => !WhimsyAI.blocked, "Turning it on restores it");
    await WhimsyAI.pending;
    await TestUtils.waitForCondition(() => note.hidden, "The note goes");
    ok(rest.every(section => !section.inert), "Everything is usable again");
    ok(!doc.getElementById("whimsyAITidyTabs").disabled, "A feature switch works again");
  });
  Services.prefs.setBoolPref(WhimsyAI.PREF, true);
});

// The old links to AI in Privacy & Security land on the AI pane.
add_task(async function test_old_links() {
  await BrowserTestUtils.withNewTab("about:preferences#privacy-whimsyAI", async browser => {
    const win = browser.contentWindow;
    await TestUtils.waitForCondition(() => win.gLastCategory?.category == "paneWhimsyAI", "Lands on Settings → AI");
  });
});
