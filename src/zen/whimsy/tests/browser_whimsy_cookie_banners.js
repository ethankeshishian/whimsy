/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Reject cookie banners: Whimsy's built-in Autoconsent add-on clicks "Reject"
// on consent popups, in normal and private windows, and the Settings toggle
// and the feature switch turn it off.

const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
const { WhimsyCookieBanners } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyCookieBanners.sys.mjs"
);

const PAGE = "https://example.com/browser/zen/whimsy/tests/cookie_banner.html";

function choice(browser) {
  return SpecialPowers.spawn(browser, [], () => content.document.body.dataset.choice || null);
}

async function waitForChoice(browser) {
  await TestUtils.waitForCondition(async () => (await choice(browser)) !== null, "The banner was answered", 100, 100);
  return choice(browser);
}

async function waitForAddon(active) {
  await TestUtils.waitForCondition(async () => {
    const addon = await AddonManager.getAddonByID(WhimsyCookieBanners.ADDON_ID);
    return addon?.isActive == active;
  }, `The add-on is ${active ? "on" : "off"}`);
}

add_task(async function test_builtin_addon() {
  ok(Services.prefs.getBoolPref("whimsy.feature.cookie-banners"), "The feature switch is on");
  ok(Services.prefs.getBoolPref(WhimsyCookieBanners.PREF), "Rejecting is on by default");
  const addon = await AddonManager.getAddonByID(WhimsyCookieBanners.ADDON_ID);
  ok(addon, "The add-on is built in");
  ok(addon.isActive, "It runs");
  ok(addon.hidden, "It doesn't show in Add-ons and Themes");
  ok(addon.isPrivileged, "It is privileged");
  ok(!(addon.permissions & AddonManager.PERM_CAN_UNINSTALL), "It can't be uninstalled");
});

add_task(async function test_rejects_banner() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    is(await waitForChoice(browser), "reject", "Autoconsent clicked Reject, not Accept");
  });
});

add_task(async function test_private_window() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, PAGE);
  is(await waitForChoice(tab.linkedBrowser), "reject", "Banners are rejected in private windows too");
  await BrowserTestUtils.closeWindow(win);
});

async function expectBannerLeftAlone(message) {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    // Give Autoconsent the time it needs on the page above (well under 1 s).
    // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
    await new Promise(resolve => setTimeout(resolve, 2000));
    is(await choice(browser), null, message);
  });
}

add_task(async function test_toggle_off() {
  Services.prefs.setBoolPref(WhimsyCookieBanners.PREF, false);
  await waitForAddon(false);
  await expectBannerLeftAlone("With the toggle off, the banner is left alone");
  Services.prefs.clearUserPref(WhimsyCookieBanners.PREF);
  await waitForAddon(true);
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    is(await waitForChoice(browser), "reject", "Turning it back on rejects again");
  });
});

add_task(async function test_feature_switch_off() {
  Services.prefs.setBoolPref("whimsy.feature.cookie-banners", false);
  await waitForAddon(false);
  Services.prefs.clearUserPref("whimsy.feature.cookie-banners");
  await waitForAddon(true);
});

add_task(async function test_settings_toggle() {
  await BrowserTestUtils.withNewTab("about:preferences#privacy", async browser => {
    const doc = browser.contentDocument;
    const checkbox = await TestUtils.waitForCondition(() => doc.getElementById("whimsyRejectCookieBanners"));
    ok(checkbox.checked, "The Settings toggle is on");
    checkbox.click();
    await TestUtils.waitForCondition(() => !Services.prefs.getBoolPref(WhimsyCookieBanners.PREF), "Unchecking turns it off");
    await waitForAddon(false);
    checkbox.click();
    await TestUtils.waitForCondition(() => Services.prefs.getBoolPref(WhimsyCookieBanners.PREF), "Checking turns it on");
    await waitForAddon(true);
  });
  Services.prefs.clearUserPref(WhimsyCookieBanners.PREF);
});
