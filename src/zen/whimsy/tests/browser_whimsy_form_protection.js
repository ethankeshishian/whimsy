/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W9-03: Form protection: tabs with half-filled forms are exempt from
// Whimsy's archive sweep, and typed text is restored after reload/crash.

const { WhimsyFormProtection } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyFormProtection.sys.mjs"
);
const { WhimsyArchive } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyArchive.sys.mjs"
);
const { TabStateCache } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/TabStateCache.sys.mjs"
);

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content/", "http://mochi.test:8888/");
const FORM_PAGE = ROOT + "whimsy_email_form.html";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.form-protection", true],
      ["whimsy.feature.auto-archive-tabs", true],
      ["whimsy.tabs.archive.idle-after", "12h"],
    ],
  });
});

add_task(async function test_defaults_and_command() {
  ok(WhimsyFormProtection.enabled, "Form protection is enabled by default");
  const cmd = document.getElementById(WhimsyFormProtection.COMMAND_ID);
  ok(cmd, "Protect form command is registered");

  await BrowserTestUtils.withNewTab(FORM_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    ok(tab, "Tab exists");
    ok(!tab.hasAttribute("whimsy-form-protected"), "Tab has no form protection initially");

    // Command toggles protection manually
    cmd.doCommand();
    ok(tab.hasAttribute("whimsy-form-protected"), "Command marks tab protected");
    ok(WhimsyArchive.isSweepExempt(tab), "Protected tab is sweep exempt");

    cmd.doCommand();
    ok(!tab.hasAttribute("whimsy-form-protected"), "Command toggles protection off");
  });
});

add_task(async function test_typing_protects_tab_and_exempts_from_sweep() {
  await BrowserTestUtils.withNewTab(FORM_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);

    // Type text into the input field
    await SpecialPowers.spawn(browser, [], async () => {
      const input = content.document.getElementById("name");
      input.value = "Whimsy User";
      input.dispatchEvent(new content.Event("input", { bubbles: true }));
      input.dispatchEvent(new content.Event("change", { bubbles: true }));
    });

    await TestUtils.waitForCondition(
      () => tab.hasAttribute("whimsy-form-protected"),
      "Tab becomes form-protected after typing"
    );
    ok(WhimsyFormProtection.isFormProtected(tab), "isFormProtected returns true");
    ok(WhimsyArchive.isSweepExempt(tab), "Tab with half-filled form is exempt from auto-archive sweep");

    // Now test that the sweep does not archive this tab even when past the idle threshold
    const twelveHoursAgo = Date.now() - 13 * 3600 * 1000;
    tab.lastAccessed = twelveHoursAgo;

    // Open a second, clean tab to be the selected tab and one idle clean tab
    const cleanTab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com");
    cleanTab.lastAccessed = twelveHoursAgo;

    // Run the sweep
    WhimsyArchive.sweepWindow(window);

    // Form-protected tab must survive the sweep
    ok(tab.isConnected && !tab.closing, "Form-protected tab survived the sweep");

    BrowserTestUtils.removeTab(cleanTab);
  });
});

add_task(async function test_sessionstore_formdata_preservation() {
  await BrowserTestUtils.withNewTab(FORM_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);

    // Populate TabStateCache mock formdata to test SessionStore restoration awareness
    TabStateCache.update(browser.permanentKey, {
      formdata: {
        id: { name: "Saved Draft" },
      },
    });

    ok(WhimsyFormProtection.hasSessionRestoreFormData(tab), "Detects SessionStore form data in cache");
    ok(WhimsyFormProtection.isFormProtected(tab), "Tab is protected via SessionStore cache");
    ok(WhimsyArchive.isSweepExempt(tab), "Tab with cached form data is exempt from sweep");

    // Clear TabStateCache mock
    TabStateCache.update(browser.permanentKey, { formdata: null });
  });
});

add_task(async function test_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.form-protection", false]] });
  await BrowserTestUtils.withNewTab(FORM_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    tab.setAttribute("whimsy-form-protected", "true");
    ok(!WhimsyFormProtection.isFormProtected(tab), "With feature switch off, tab is not form protected");
  });
  await SpecialPowers.popPrefEnv();
});
