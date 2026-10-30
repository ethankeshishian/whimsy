/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// fix7 settings: Zen's onboarding, run to its real finish(), leaves no
// zen-browser.app tab (welcome or privacy policy, which profiles made by
// builds before 46fe4b3 still carry) and no "zen basics" folder. Pages are
// skipped (WhimsyWelcome.skipPagesForTest) so the test doesn't click through
// the default-browser or import steps; everything after them is Zen's code.

const { WhimsyWelcome } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyWelcome.sys.mjs");

function urlOf(tab) {
  return tab.linkedBrowser?.currentURI?.spec ?? "";
}

add_task(async function test_first_run_prefs_are_whimsy() {
  const defaults = Services.prefs.getDefaultBranch("");
  is(defaults.getStringPref("startup.homepage_welcome_url"), "about:whimsy", "A new profile opens Whimsy's home");
  is(defaults.getStringPref("startup.homepage_welcome_url.additional"), "", "and no second page");
  ok(!/zen-browser\.app/.test(defaults.getStringPref("startup.homepage_override_url", "")), "No Zen what's-new page");
});

add_task(async function test_onboarding_finish_leaves_no_zen_tabs() {
  ok(WhimsyWelcome.isZenFirstRunPage("https://zen-browser.app/privacy-policy/"), "Zen's privacy policy is a first-run page");
  ok(WhimsyWelcome.isZenFirstRunPage("https://www.zen-browser.app/welcome/"), "so is its welcome page");
  ok(!WhimsyWelcome.isZenFirstRunPage("https://zen-browser.app/mods/"), "other Zen pages aren't");
  ok(!WhimsyWelcome.isZenFirstRunPage("https://example.com/welcome/"), "nor other sites");

  const win = await BrowserTestUtils.openNewBrowserWindow();
  const { gBrowser, document } = win;
  WhimsyWelcome.skipPagesForTest = true;
  try {
    // What a profile from an older build restores: Zen's two first-run pages.
    const lazy = { createLazyBrowser: true, inBackground: true };
    gBrowser.addTrustedTab("https://zen-browser.app/welcome/", lazy);
    gBrowser.addTrustedTab("https://zen-browser.app/privacy-policy/", lazy);
    const mine = gBrowser.addTrustedTab("https://example.com/", lazy);
    is(
      gBrowser.tabs.filter(tab => urlOf(tab).includes("zen-browser.app")).length,
      2,
      "The Zen pages are open before onboarding"
    );

    // What ZenStartup does on a first run.
    Services.scriptloader.loadSubScript("chrome://browser/content/zen-components/ZenWelcome.mjs", win);
    await TestUtils.waitForCondition(() => {
      // The start button listens once its title animation is done.
      document.getElementById("zen-welcome-start-button")?.click();
      return !document.getElementById("zen-welcome-start");
    }, "Onboarding starts");
    await TestUtils.waitForCondition(
      () => !document.getElementById("zen-welcome") && !document.documentElement.hasAttribute("zen-welcome-stage"),
      "Onboarding finishes",
      100,
      200
    );

    const urls = gBrowser.tabs.map(urlOf);
    ok(!urls.some(url => url.includes("zen-browser.app")), `No zen-browser.app tab is left (${urls.join(", ")})`);
    ok(gBrowser.tabs.includes(mine), "The user's own tab stays");
    ok(!gBrowser.tabGroups.some(group => /zen basics/i.test(group.label ?? "")), "No \"zen basics\" folder");
  } finally {
    WhimsyWelcome.skipPagesForTest = false;
    await BrowserTestUtils.closeWindow(win);
  }
});
