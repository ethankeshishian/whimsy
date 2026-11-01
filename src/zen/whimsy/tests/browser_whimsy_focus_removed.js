/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W10-60: Whimsy's toasts no longer wait for a macOS Focus. The module, the
// native component and the switch are gone, and a value someone set by hand
// is cleared at startup.

const PREF = "whimsy.feature.macos-focus";

add_task(async function test_focus_feature_gone() {
  Assert.throws(
    () => ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFocus.sys.mjs"),
    /./,
    "WhimsyFocus.sys.mjs isn't shipped"
  );
  ok(!("@whimsy/focus;1" in Cc), "The native Focus component isn't built");
  is(Services.prefs.getDefaultBranch("").getPrefType(PREF), Services.prefs.PREF_INVALID, "No default for the old switch");
});

add_task(async function test_retired_switch_cleared() {
  const { RETIRED_PREFS, clearRetiredPrefs } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyStartup.sys.mjs"
  );
  ok(RETIRED_PREFS.includes(PREF), "The old switch is listed as retired");
  Services.prefs.setBoolPref(PREF, false);
  clearRetiredPrefs();
  ok(!Services.prefs.prefHasUserValue(PREF), "A hand-set value is cleared");
  clearRetiredPrefs();
  ok(true, "Clearing again is fine");
});
