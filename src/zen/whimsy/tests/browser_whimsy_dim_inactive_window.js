/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W27 winprefs: Settings → Look and Feel → "Dim the window when it’s not in
// front", bound to Zen's zen.view.grey-out-inactive-windows. Whimsy ships
// it off (overlay.py PREF_OVERRIDES, W10-31;
// browser_whimsy_inactive_window_theme.js tests the colors), so the row
// starts unchecked and turns Zen's grey-out on and off.

const GREY_OUT = "zen.view.grey-out-inactive-windows";

add_task(async function test_settings_row() {
  ok(!Services.prefs.getDefaultBranch("").getBoolPref(GREY_OUT), "The overlay default stays off");
  ok(!Services.prefs.prefHasUserValue(GREY_OUT), "No user value to start");

  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const doc = browser.contentDocument;
    const box = await TestUtils.waitForCondition(() => doc.getElementById("whimsyDimInactiveWindow"), "The row is shown");
    ok(doc.getElementById("whimsyLookGroup")?.contains(box), "In Whimsy's Look group");
    is(box.closest("[data-category]")?.getAttribute("data-category"), "paneZenLooks", "In Look and Feel");
    await TestUtils.waitForCondition(() => box.label, "It has its label");
    is(box.label, "Dim the window when it’s not in front", "Its label");
    ok(!box.checked, "Off by default");

    box.click();
    await TestUtils.waitForCondition(() => Services.prefs.getBoolPref(GREY_OUT), "Checking it turns the grey-out on");
    ok(box.checked, "Checked");

    box.click();
    await TestUtils.waitForCondition(() => !Services.prefs.getBoolPref(GREY_OUT), "Unchecking it turns the grey-out off");
    ok(!box.checked, "Unchecked");
  });
  Services.prefs.clearUserPref(GREY_OUT);
});
