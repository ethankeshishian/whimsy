/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Allow copy and paste: on a page that blocks pasting, selecting and
// copying, the command bar's "Allow Copy and Paste on This Site"
// makes them work, for every page on the site, until it's turned off.

const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_no_copy.html";
const { WhimsyPage } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPage.sys.mjs");
const site = Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI("https://example.com"), {});

registerCleanupFunction(() => Services.perms.removeFromPrincipal(site, "whimsy-allow-copy"));

async function tryPaste(browser) {
  SpecialPowers.clipboardCopyString("pasted");
  await SpecialPowers.spawn(browser, [], () => {
    const input = content.document.getElementById("confirm");
    input.value = "";
    input.focus();
  });
  browser.focus();
  goDoCommand("cmd_paste");
  await new Promise(r => setTimeout(r, 200));
  return SpecialPowers.spawn(browser, [], () => content.document.getElementById("confirm").value);
}

const userSelect = browser =>
  SpecialPowers.spawn(browser, [], () => content.getComputedStyle(content.document.body).userSelect);

// A copy event the page's handler cancels (no clipboard access needed).
const copyBlocked = browser =>
  SpecialPowers.spawn(browser, [], () => {
    const event = new content.ClipboardEvent("copy", { bubbles: true, cancelable: true });
    return !content.document.getElementById("p").dispatchEvent(event);
  });

add_task(async function test_allow_copy() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  is(await tryPaste(browser), "", "The page blocks pasting");
  is(await userSelect(browser), "none", "and selecting");
  ok(await copyBlocked(browser), "and copying");

  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const allow = globalActions.find(a => a.l10nId == "whimsy-action-allow-copy");
  const disallow = globalActions.find(a => a.l10nId == "whimsy-action-disallow-copy");
  ok(allow.isAvailable(window) && !disallow.isAvailable(window), "The command bar offers Allow Copy and Paste");
  is(allow.label, "Allow Copy and Paste on This Site", "labelled");

  ok(WhimsyPage.toggleAllowCopy(window), "Allowed");
  await TestUtils.waitForCondition(async () => (await userSelect(browser)) == "text", "Text can be selected");
  is(await tryPaste(browser), "pasted", "Pasting works");
  ok(!(await copyBlocked(browser)), "The page can't block copying");
  ok(disallow.isAvailable(window) && !allow.isAvailable(window), "now offers to stop");

  // Remembered for the site: a reload keeps it.
  BrowserTestUtils.reloadTab(tab);
  await BrowserTestUtils.browserLoaded(browser);
  await TestUtils.waitForCondition(async () => (await tryPaste(browser)) == "pasted", "Still allowed after a reload");

  ok(!WhimsyPage.toggleAllowCopy(window), "Turned off");
  await TestUtils.waitForCondition(async () => (await userSelect(browser)) == "none", "The page's rules are back");
  is(await tryPaste(browser), "", "and it blocks pasting again");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_switch_and_empty() {
  const blank = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  ok(!WhimsyPage.toggleAllowCopy(window), "Nothing to allow on a page without a site");
  BrowserTestUtils.removeTab(blank);
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.allow-copy", false]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  ok(!WhimsyPage.toggleAllowCopy(window), "The switch turns it off");
  is(await tryPaste(tab.linkedBrowser), "", "the page keeps its rules");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
