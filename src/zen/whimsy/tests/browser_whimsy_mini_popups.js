/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9/mini W8-23: "Continue with Google" and other OAuth sign-ins open a
// popup with window.open(url, name, features). It must stay a real popup
// window attached to its opener (window.opener, postMessage, window.close)
// so the sign-in completes, never a Mini Whimsy window. From a page in Mini
// (which floats above ordinary windows), Mini steps aside while the popup
// is open, so the popup isn't hidden behind it, and comes back after.

const { WhimsyQuickWindow } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const OPENER = ROOT + "whimsy_oauth_opener.html";
const POPUP = ROOT + "whimsy_oauth_popup.html";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.quick-window", true],
      ["whimsy.quick-window.size", ""],
      // Links from other apps open in Mini: in-page popups must still not.
      ["whimsy.feature.external-link-target", true],
      ["whimsy.external-links.target", "quick-window"],
      ["browser.link.open_newwindow.restriction", 2],
    ],
  });
});

registerCleanupFunction(async () => {
  for (const win of WhimsyQuickWindow.windows()) {
    await WhimsyQuickWindow.whenReady(win);
    await BrowserTestUtils.closeWindow(win);
  }
});

async function pageReady(browser) {
  await TestUtils.waitForCondition(() => browser.currentURI.spec == OPENER, "The sign-in page loaded");
  await SpecialPowers.spawn(browser, [], () =>
    ContentTaskUtils.waitForCondition(() => content.document.readyState == "complete", "Page complete")
  );
}

// Clicks "Continue with Google" in `browser` and returns the popup window.
async function openSignIn(browser) {
  const opened = BrowserTestUtils.waitForNewWindow({ url: POPUP });
  await BrowserTestUtils.synthesizeMouseAtCenter("#continue", {}, browser);
  return opened;
}

async function checkRealPopup(popup, openerBrowser) {
  ok(!popup._whimsyQuickWindow, "The sign-in popup isn't a Mini Whimsy window");
  ok(!popup.document.documentElement.hasAttribute("whimsy-quick-window"), "...and has no Mini chrome");
  ok(!popup.toolbar.visible, "It's a real popup window");
  ok(!WhimsyQuickWindow.windows().includes(popup), "Mini doesn't count it as one of its windows");
  const popupBrowser = popup.gBrowser.selectedBrowser;
  is(popupBrowser.browsingContext.opener, openerBrowser.browsingContext,
    "The popup is attached to the page that opened it");
  const hasOpener = await SpecialPowers.spawn(popupBrowser, [], () => content.document.body.dataset.hasOpener);
  is(hasOpener, "true", "The popup's page sees window.opener");
}

// Picks the account in the popup: it posts the result to its opener, the
// opener confirms, and the popup closes itself (window.close).
async function finishSignIn(popup, openerBrowser) {
  const closed = BrowserTestUtils.domWindowClosed(popup);
  await BrowserTestUtils.synthesizeMouseAtCenter("#account", {}, popup.gBrowser.selectedBrowser);
  await closed;
  ok(popup.closed, "The popup closed itself with window.close()");
  const token = await SpecialPowers.spawn(openerBrowser, [], async () => {
    await ContentTaskUtils.waitForCondition(() => content.document.body.dataset.token, "Result arrived");
    return content.document.body.dataset.token;
  });
  is(token, "signed-in", "The opener received the sign-in result through postMessage");
}

add_task(async function test_popup_from_a_tab_stays_a_popup() {
  const minis = WhimsyQuickWindow.windows().length;
  await BrowserTestUtils.withNewTab(OPENER, async browser => {
    await pageReady(browser);
    const popup = await openSignIn(browser);
    await checkRealPopup(popup, browser);
    is(WhimsyQuickWindow.windows().length, minis, "No Mini Whimsy window opened");
    is(WhimsyQuickWindow.miniOpenerOf(popup), null, "Opened from a normal window, not Mini");
    await finishSignIn(popup, browser);
  });
});

add_task(async function test_popup_from_mini_stays_a_popup_and_mini_steps_aside() {
  const mini = WhimsyQuickWindow.open(OPENER, { opener: window });
  try {
    await WhimsyQuickWindow.whenReady(mini);
    const browser = mini.gBrowser.selectedBrowser;
    await pageReady(browser);
    const minis = WhimsyQuickWindow.windows().length;
    const popup = await openSignIn(browser);
    await checkRealPopup(popup, browser);
    is(WhimsyQuickWindow.windows().length, minis, "No second Mini opened for the popup");
    is(WhimsyQuickWindow.miniOpenerOf(popup), mini, "The popup was opened by Mini's page");
    await TestUtils.waitForCondition(() => WhimsyQuickWindow.isSteppedAside(mini),
      "Mini steps aside so the popup isn't hidden behind it");
    ok(!mini.closed, "...without closing (its page is the popup's opener)");
    await finishSignIn(popup, browser);
    await TestUtils.waitForCondition(() => !WhimsyQuickWindow.isSteppedAside(mini),
      "Mini comes back when the popup closes");
    await TestUtils.waitForCondition(() => Services.focus.activeWindow == mini, "...in front, focused");
    is(browser.currentURI.spec, OPENER, "Mini still shows the signed-in page");
  } finally {
    await BrowserTestUtils.closeWindow(mini);
  }
});

add_task(async function test_mini_closed_while_popup_is_open() {
  const mini = WhimsyQuickWindow.open(OPENER, { opener: window });
  await WhimsyQuickWindow.whenReady(mini);
  const browser = mini.gBrowser.selectedBrowser;
  await pageReady(browser);
  const popup = await openSignIn(browser);
  await TestUtils.waitForCondition(() => WhimsyQuickWindow.isSteppedAside(mini), "Mini stepped aside");
  await BrowserTestUtils.closeWindow(mini);
  ok(mini.closed, "Mini can still be closed while it's aside");
  await BrowserTestUtils.closeWindow(popup);
  ok(popup.closed, "...and the popup closes on its own afterwards without errors");
});

add_task(async function test_feature_off_leaves_mini_alone() {
  const mini = WhimsyQuickWindow.open(OPENER, { opener: window });
  try {
    await WhimsyQuickWindow.whenReady(mini);
    const browser = mini.gBrowser.selectedBrowser;
    await pageReady(browser);
    await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.quick-window", false]] });
    const popup = await openSignIn(browser);
    await new Promise(resolve => popup.requestAnimationFrame(() => popup.setTimeout(resolve, 100)));
    ok(!WhimsyQuickWindow.isSteppedAside(mini), "With the switch off, Mini doesn't step aside");
    await finishSignIn(popup, browser);
    await SpecialPowers.popPrefEnv();
  } finally {
    await BrowserTestUtils.closeWindow(mini);
  }
});
