/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W27 winprefs: Settings → Tab Management → "Open pop-up windows as tabs",
// nested under Firefox's "Open links in tabs instead of new windows". Off
// by default (browser.link.open_newwindow.restriction 2, Firefox's): a
// window.open() with features ("Continue with Google") opens a window.
// Checked (0), it opens a tab, still attached to its opener, so a sign-in
// pop-up reports back and closes itself.

const RESTRICTION = "browser.link.open_newwindow.restriction";
const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const OPENER = ROOT + "whimsy_oauth_opener.html";
const POPUP = ROOT + "whimsy_oauth_popup.html";

const windowCount = () => [...Services.wm.getEnumerator("navigator:browser")].length;

add_setup(async function () {
  // Zen opens links in tabs (3); the pop-up row needs that on.
  await SpecialPowers.pushPrefEnv({ set: [["browser.link.open_newwindow", 3]] });
});

add_task(async function test_settings_row() {
  is(Services.prefs.getDefaultBranch("").getIntPref(RESTRICTION), 2, "Pop-ups open as windows by default");
  ok(!Services.prefs.prefHasUserValue(RESTRICTION), "No user value to start");

  await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
    const doc = browser.contentDocument;
    const box = await TestUtils.waitForCondition(() => doc.getElementById("whimsyPopupsAsTabs"), "The row is shown");
    const parent = doc.getElementById("setting-control-linkTargeting");
    ok(parent?.contains(box), "Nested under Open links in tabs instead of new windows");
    is(box.closest("[data-category]")?.getAttribute("data-category"), "paneZenTabManagement", "In Tab Management");
    await TestUtils.waitForCondition(() => box.label, "It has its label");
    is(box.label, "Open pop-up windows as tabs", "Its label");
    ok(!box.checked, "Off by default");
    ok(!box.disabled && !box.parentDisabled, "Usable while links open in tabs");

    box.click();
    await TestUtils.waitForCondition(() => Services.prefs.getIntPref(RESTRICTION) == 0, "Checking it sets 0");
    ok(box.checked, "Checked");

    box.click();
    await TestUtils.waitForCondition(() => Services.prefs.getIntPref(RESTRICTION) == 2, "Unchecking it sets 2");
    ok(!box.checked, "Unchecked");
  });
  Services.prefs.clearUserPref(RESTRICTION);
});

async function openPopup(browser) {
  await SpecialPowers.spawn(browser, [], () =>
    ContentTaskUtils.waitForCondition(() => content.document.readyState == "complete", "Page complete"));
  await SpecialPowers.spawn(browser, [], () => content.document.getElementById("continue").click());
}

async function signIn(popupBrowser, browser) {
  await SpecialPowers.spawn(popupBrowser, [], async () => {
    await ContentTaskUtils.waitForCondition(() => content.document.readyState == "complete", "Pop-up complete");
    is(content.document.body.dataset.hasOpener, "true", "window.opener is set");
    content.document.getElementById("account").click();
  });
  await SpecialPowers.spawn(browser, [], () =>
    ContentTaskUtils.waitForCondition(() => content.document.body.dataset.token == "signed-in", "The opener got the result"));
}

add_task(async function test_on_opens_a_tab() {
  await SpecialPowers.pushPrefEnv({ set: [[RESTRICTION, 0]] });
  await BrowserTestUtils.withNewTab(OPENER, async browser => {
    const windows = windowCount();
    const opened = BrowserTestUtils.waitForNewTab(gBrowser, POPUP, true);
    await openPopup(browser);
    const tab = await opened;
    is(tab.ownerGlobal, window, "A tab in this window");
    is(windowCount(), windows, "No new window");
    is(tab.linkedBrowser.browsingContext.opener, browser.browsingContext, "Attached to the page that opened it");

    const closed = BrowserTestUtils.waitForTabClosing(tab);
    await signIn(tab.linkedBrowser, browser);
    await closed;
    ok(!tab.isConnected || tab.closing, "The sign-in tab closed itself");
  });
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_off_opens_a_window() {
  await SpecialPowers.pushPrefEnv({ set: [[RESTRICTION, 2]] });
  await BrowserTestUtils.withNewTab(OPENER, async browser => {
    const tabs = gBrowser.tabs.length;
    const opened = BrowserTestUtils.waitForNewWindow({ url: POPUP });
    await openPopup(browser);
    const popup = await opened;
    isnot(popup, window, "A window of its own");
    is(gBrowser.tabs.length, tabs, "No new tab here");
    const popupBrowser = popup.gBrowser.selectedBrowser;
    is(popupBrowser.browsingContext.opener, browser.browsingContext, "Attached to the page that opened it");

    const closed = BrowserTestUtils.domWindowClosed(popup);
    await signIn(popupBrowser, browser);
    await closed;
    ok(popup.closed, "The sign-in window closed itself");
  });
  await SpecialPowers.popPrefEnv();
});
