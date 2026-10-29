/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Transparency: whimsy.look.transparency fades the sidebar's and toolbars'
// painted background (0 = Zen's look, capped at 80 %), live, and the
// Settings slider sets it. The feature switch puts Zen's look back.

const FEATURE = "whimsy.feature.transparency";
const PREF = "whimsy.look.transparency";

registerCleanupFunction(() => {
  Services.prefs.clearUserPref(FEATURE);
  Services.prefs.clearUserPref(PREF);
});

function backgroundOpacity() {
  const background = document.getElementById("zen-browser-background");
  return parseFloat(window.getComputedStyle(background).opacity);
}

add_task(async function test_transparency() {
  is(Services.prefs.getIntPref(PREF), 0, "Opaque by default");
  ok(!document.documentElement.hasAttribute("whimsy-transparency"), "Nothing applied by default");
  is(backgroundOpacity(), 1, "Zen's opaque background");

  Services.prefs.setIntPref(PREF, 40);
  ok(document.documentElement.hasAttribute("whimsy-transparency"), "Applied");
  await TestUtils.waitForCondition(() => Math.abs(backgroundOpacity() - 0.6) < 0.01, "40 % lets 40 % through");
  const toolbar = document.getElementById("zen-toolbar-background");
  if (toolbar) {
    await TestUtils.waitForCondition(
      () => Math.abs(parseFloat(window.getComputedStyle(toolbar).opacity) - 0.6) < 0.01,
      "The toolbar's background too"
    );
  }

  Services.prefs.setIntPref(PREF, 500);
  await TestUtils.waitForCondition(() => Math.abs(backgroundOpacity() - 0.2) < 0.01, "Capped at 80 %");

  Services.prefs.setBoolPref(FEATURE, false);
  ok(!document.documentElement.hasAttribute("whimsy-transparency"), "The switch turns it off");
  await TestUtils.waitForCondition(() => backgroundOpacity() == 1, "back to opaque");
  Services.prefs.clearUserPref(FEATURE);
  Services.prefs.clearUserPref(PREF);
});

add_task(async function test_settings_slider() {
  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const doc = browser.contentDocument;
    const slider = await TestUtils.waitForCondition(() => doc.getElementById("whimsyTransparency"));
    ok(slider, "Settings → Look and Feel has the slider");
    is(slider.max, "80", "up to 80 %");
    const label = await TestUtils.waitForCondition(() => doc.getElementById("whimsyTransparencyValue"));
    await TestUtils.waitForCondition(() => label.textContent == "Off", "It reads Off at 0");
    slider.value = 25;
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    is(Services.prefs.getIntPref(PREF), 25, "Moving it sets the pref");
    await TestUtils.waitForCondition(() => label.textContent == "25%", "and shows the value");
    Services.prefs.clearUserPref(PREF);
  });
});
