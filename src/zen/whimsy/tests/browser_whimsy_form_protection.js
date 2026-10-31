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

// Review design-full-4 L5: the command bar says Protect or Stop Protecting.
add_task(async function test_command_variants() {
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const action = id => globalActions.find(a => a.l10nId == id);
  await BrowserTestUtils.withNewTab(FORM_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    ok(action("whimsy-action-protect-form-on")?.isAvailable(window), "Offers Protect on an unprotected tab");
    ok(!action("whimsy-action-protect-form-off")?.isAvailable(window), "No Stop Protecting yet");
    ok(await document.l10n.formatValue("whimsy-action-protect-form-off"), "Stop Protecting is localized");

    document.getElementById(WhimsyFormProtection.COMMAND_ID).doCommand();
    ok(tab.hasAttribute("whimsy-form-protected"), "Protected");
    ok(!action("whimsy-action-protect-form-on")?.isAvailable(window), "Protect is no longer offered");
    ok(action("whimsy-action-protect-form-off")?.isAvailable(window), "Stop Protecting is offered");

    // Protection by hand survives a navigation in the tab.
    BrowserTestUtils.startLoadingURIString(browser, FORM_PAGE + "?again");
    await BrowserTestUtils.browserLoaded(browser);
    ok(tab.hasAttribute("whimsy-form-protected"), "Still protected after navigating");

    document.getElementById(WhimsyFormProtection.COMMAND_ID).doCommand();
    ok(!tab.hasAttribute("whimsy-form-protected"), "Stop Protecting clears it");
    ok(action("whimsy-action-protect-form-on")?.isAvailable(window), "Protect is offered again");
  });
});

// Review design-full-4 M10: the dot has its own pseudo-element and its
// meaning is in the tooltip, not a title the tab tooltip overrides.
add_task(async function test_indicator_and_tooltip() {
  await BrowserTestUtils.withNewTab(FORM_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    const stack = tab.querySelector(".tab-icon-stack");
    const afterBefore = getComputedStyle(stack, "::after").cssText || getComputedStyle(stack, "::after").content;
    const plain = gBrowser.getTabTooltip(tab, true);

    WhimsyFormProtection.updateTabProtection(tab, true);
    ok(tab.hasAttribute("whimsy-form-protected"), "Typed text protects the tab");
    isnot(getComputedStyle(stack, "::before").content, "none", "The dot is drawn on ::before");
    is(
      getComputedStyle(stack, "::after").cssText || getComputedStyle(stack, "::after").content,
      afterBefore,
      "::after (unread count, title-changed dot) is untouched"
    );
    ok(!tab.hasAttribute("title"), "No title attribute on the tab");
    const tip = gBrowser.getTabTooltip(tab, true);
    ok(tip.startsWith(plain), "The tab's tooltip keeps its own text");
    ok(tip.includes("Protected from auto-archive"), "and says why the tab is protected");
    ok(gBrowser.getTabTooltip(tab, false).includes("Protected from auto-archive"), "as does its accessible description");

    WhimsyFormProtection.updateTabProtection(tab, false);
    ok(!tab.hasAttribute("whimsy-form-protected"), "Clearing the form unprotects it");
    is(getComputedStyle(stack, "::before").content, "none", "No dot");
    is(gBrowser.getTabTooltip(tab, true), plain, "Tooltip back to normal");
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
