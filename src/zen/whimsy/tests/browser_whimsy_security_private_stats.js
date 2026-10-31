/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9/secfix (security-full-1 M6): Year in Tabs kept the longest-open
// tab's title and URL in prefs.js, private tabs included, and nothing ever
// cleared it. Private browsing is left out now, and Clear History or Forget
// About This Site take the record with them.

const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const { WhimsyStats } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyStats.sys.mjs");

const LONGEST_PREF = "whimsy.stats.longest-tab";
const PRIVATE_URL = "https://example.com/?secfix-m6-private";
const NORMAL_URL = "https://example.org/?secfix-m6-normal";
const AGES_AGO = String(Date.now() - 400 * 86400000);

registerCleanupFunction(() => Services.prefs.clearUserPref(LONGEST_PREF));

add_task(async function a_private_tab_is_never_the_longest() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.year-in-tabs", true]] });
  Services.prefs.clearUserPref(LONGEST_PREF);
  const tab = WhimsyPrivate.openPrivateTab(window, { url: PRIVATE_URL, force: true });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PRIVATE_URL);
  tab.setAttribute("whimsy-opened-at", AGES_AGO);
  ok(!(WhimsyStats.getLiveLongestTab()?.url ?? "").includes("secfix-m6"), "An open private tab isn't the live longest");
  BrowserTestUtils.removeTab(tab);
  ok(!Services.prefs.getStringPref(LONGEST_PREF, "").includes("secfix-m6"),
    "Closing it writes nothing to prefs.js");
  await SpecialPowers.popPrefEnv();
});

async function recordNormalLongest() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, NORMAL_URL);
  tab.setAttribute("whimsy-opened-at", AGES_AGO);
  BrowserTestUtils.removeTab(tab);
  ok(Services.prefs.getStringPref(LONGEST_PREF, "").includes("secfix-m6-normal"), "A normal tab is recorded");
}

add_task(async function clear_history_forgets_the_longest_tab() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.year-in-tabs", true]] });
  Services.prefs.clearUserPref(LONGEST_PREF);
  await recordNormalLongest();
  Services.obs.notifyObservers(null, "browser:purge-session-history-for-domain", "example.com");
  ok(Services.prefs.prefHasUserValue(LONGEST_PREF), "Forgetting another site keeps it");
  Services.obs.notifyObservers(null, "browser:purge-session-history-for-domain", "example.org");
  ok(!Services.prefs.prefHasUserValue(LONGEST_PREF), "Forgetting its site clears it");

  await recordNormalLongest();
  Services.obs.notifyObservers(null, "browser:purge-session-history");
  ok(!Services.prefs.prefHasUserValue(LONGEST_PREF), "Clear History clears it");
  await SpecialPowers.popPrefEnv();
});
