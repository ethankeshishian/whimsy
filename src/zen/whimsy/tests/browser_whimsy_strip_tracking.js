/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Strip tracking from links: Firefox's query stripping is on by default in
// normal and private windows, copies are clean, and Settings → Privacy &
// Security has one switch for both.

const STRIP_PREFS = [
  "privacy.query_stripping.enabled",
  "privacy.query_stripping.enabled.pbmode",
  "privacy.query_stripping.strip_on_share.enabled",
];

async function waitForListService() {
  const listService = Cc["@mozilla.org/query-stripping-list-service;1"].getService(
    Ci.nsIURLQueryStrippingListService
  );
  await listService.testWaitForInit();
}

add_task(async function test_defaults() {
  ok(Services.prefs.getBoolPref("whimsy.feature.strip-tracking"), "The feature switch is on");
  const defaults = Services.prefs.getDefaultBranch("");
  for (const pref of STRIP_PREFS) {
    ok(defaults.getBoolPref(pref), `${pref} defaults to on`);
  }
  ok(
    !Services.prefs.prefHasUserValue("privacy.query_stripping.enabled"),
    "A default, not a user value, so Tracking Protection stays Standard"
  );
});

add_task(async function test_opening_a_link_strips_it() {
  await SpecialPowers.pushPrefEnv({ set: [["privacy.query_stripping.strip_list", "whimsy_track"]] });
  await waitForListService();
  await BrowserTestUtils.withNewTab("https://example.com/?whimsy_track=1&keep=2", async browser => {
    is(browser.currentURI.spec, "https://example.com/?keep=2", "The tracking parameter is gone");
  });
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_copy_is_clean() {
  await waitForListService();
  await BrowserTestUtils.withNewTab("https://example.com/?utm_source=whimsy&keep=1", async () => {
    SpecialPowers.clipboardCopyString("");
    document.getElementById("cmd_zenCopyCurrentURL").doCommand();
    await TestUtils.waitForCondition(() => SpecialPowers.getClipboardData("text/plain")).catch(() => {});
    is(SpecialPowers.getClipboardData("text/plain"), "https://example.com/?keep=1", "Copy URL copies the clean link");

    await SpecialPowers.pushPrefEnv({ set: [["privacy.query_stripping.strip_on_share.enabled", false]] });
    SpecialPowers.clipboardCopyString("");
    document.getElementById("cmd_zenCopyCurrentURL").doCommand();
    await TestUtils.waitForCondition(() => SpecialPowers.getClipboardData("text/plain")).catch(() => {});
    is(
      SpecialPowers.getClipboardData("text/plain"),
      "https://example.com/?utm_source=whimsy&keep=1",
      "With stripping off, the link is copied as is"
    );
    await SpecialPowers.popPrefEnv();
  });
});

async function withPrivacySettings(fn) {
  await BrowserTestUtils.withNewTab("about:preferences#privacy", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(
      () => doc.getElementById("whimsyStripTrackingGroup") || !doc.getElementById("template-whimsyPrivacy"),
      "The privacy groups were inserted"
    );
    await fn(doc);
  });
}

add_task(async function test_settings_toggle() {
  await withPrivacySettings(async doc => {
    const group = doc.getElementById("whimsyStripTrackingGroup");
    ok(group, "The Tracking in links group is in Privacy & Security");
    await TestUtils.waitForCondition(() => group.checkVisibility(), "and visible");
    const checkbox = doc.getElementById("whimsyStripTracking");
    await checkbox.updateComplete;
    ok(checkbox.checked, "Checked by default");

    checkbox.inputEl.click();
    for (const pref of STRIP_PREFS) {
      ok(!Services.prefs.getBoolPref(pref), `Unchecking turns ${pref} off`);
    }
    checkbox.inputEl.click();
    for (const pref of STRIP_PREFS) {
      ok(!Services.prefs.prefHasUserValue(pref), `Checking restores ${pref}'s default`);
    }
    ok(checkbox.checked, "Checked again");

    // The checkbox follows the pref (e.g. Strict/Custom tracking protection).
    Services.prefs.setBoolPref(STRIP_PREFS[0], false);
    await TestUtils.waitForCondition(() => !checkbox.checked, "Unchecked when the pref changes");
    Services.prefs.clearUserPref(STRIP_PREFS[0]);
    await TestUtils.waitForCondition(() => checkbox.checked, "Checked when it changes back");
  });
});

add_task(async function test_switch_off_hides_the_setting() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.strip-tracking", false]] });
  await withPrivacySettings(async doc => {
    ok(!doc.getElementById("whimsyStripTrackingGroup"), "No Whimsy group with the feature off");
  });
  await SpecialPowers.popPrefEnv();
});
