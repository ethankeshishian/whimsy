/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 page-act: the scam warning (fu-page dec-13, page-8.2–8.4). An
// on-device pattern check; a standard warning notification with reasons
// and Leave / I trust this; no close button; Esc does nothing; trust is
// per site, undoable, and resettable.

const { WhimsyScamCheck } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyScamCheck.sys.mjs");
const { WhimsyUndo } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUndo.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const SCAM = ROOT + "whimsy_ai_scam.html";
const BAKERY = ROOT + "whimsy_ai_bakery.html";
const FORM = ROOT + "whimsy_ai_form.html";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-hints", false]] });
  WhimsyScamCheck._visitCount = () => 0;
  registerCleanupFunction(() => {
    WhimsyScamCheck._visitCount = null;
    Services.prefs.clearUserPref("whimsy.ai.scam.trusted");
    closeToasts();
  });
});

const box = browser => gBrowser.getNotificationBox(browser);
const warning = browser => box(browser).getNotificationWithValue("whimsy-scam-warning");
// The bar is in the box (buttons and all) while it's still being localized;
// its message goes in after that, so wait for the message.
const drawn = browser => warning(browser)?.querySelector(".whimsy-scam-body") ? warning(browser) : null;

async function shown(browser) {
  const notification = await TestUtils.waitForCondition(() => drawn(browser), "The scam warning shows");
  await TestUtils.waitForCondition(() => notification.querySelector("button.notification-button")?.getBoundingClientRect().width > 0, "Its buttons are laid out");
  return notification;
}

add_task(async function scam_notification_no_close_esc_inert() {
  await BrowserTestUtils.withNewTab(SCAM, async browser => {
    const notification = await shown(browser);
    is(notification.priority, box(browser).PRIORITY_WARNING_HIGH, "Warning priority");
    ok(!notification.dismissable, "No close button");
    ok(!notification.shadowRoot?.querySelector(".close:not([hidden])"), "None drawn either");
    const reasons = [...notification.querySelectorAll(".whimsy-scam-body li")].map(li => li.getAttribute("data-l10n-id"));
    ok(reasons.includes("whimsy-scam-reason-account-elsewhere"), "Names an account that isn't this site's");
    ok(reasons.includes("whimsy-scam-reason-threat"), "Names the threat");
    ok(reasons.includes("whimsy-scam-reason-new-site"), "And that you've never been here");
    is(notification.querySelector(".whimsy-scam-body span").getAttribute("data-l10n-id"), "whimsy-scam-sub", "Here’s what looks off");
    const leave = [...notification.querySelectorAll("button.notification-button")].find(b => b.getAttribute("data-l10n-id") == "whimsy-scam-leave");
    ok(leave.classList.contains("primary"), "Leave is the primary choice");
    leave.focus();
    EventUtils.synthesizeKey("KEY_Escape");
    await new Promise(r => setTimeout(r, 300));
    ok(warning(browser), "Esc does nothing: it stays until you choose");
  });

  // A small shop's real checkout: it might be fine, and says why it flagged.
  await BrowserTestUtils.withNewTab(BAKERY, async browser => {
    const notification = await shown(browser);
    is(notification.querySelector(".whimsy-scam-body span").getAttribute("data-l10n-id"), "whimsy-scam-sub-weak", "It could be fine");
    const rush = notification.querySelector("li[data-l10n-id=whimsy-scam-reason-rush]");
    ok(JSON.parse(rush.getAttribute("data-l10n-args")).quote.includes("Only 2 slots left"), "Quotes the rushing words");
  });

  // A familiar site's ordinary checkout gets nothing.
  WhimsyScamCheck._visitCount = () => 12;
  await BrowserTestUtils.withNewTab(FORM, async browser => {
    const signals = await browser.browsingContext.currentWindowGlobal.getActor("WhimsyScamCheck").sendQuery("WhimsyScamCheck:Check");
    is(await WhimsyScamCheck.onSignals(browser, signals), null, "No warning");
    ok(!warning(browser), "None shown");
  });
  WhimsyScamCheck._visitCount = () => 0;
});

add_task(async function trust_per_site_undo() {
  await BrowserTestUtils.withNewTab(SCAM, async browser => {
    const notification = await shown(browser);
    const trust = [...notification.querySelectorAll("button.notification-button")].find(b => b.getAttribute("data-l10n-id") == "whimsy-scam-trust");
    EventUtils.synthesizeMouseAtCenter(trust, {});
    await TestUtils.waitForCondition(() => !warning(browser), "I trust this closes it");
    ok(WhimsyScamCheck.isTrusted("example.com"), "Remembered for the site");
    ok(document.querySelector("[data-l10n-id=whimsy-scam-trusted-toast]") || gZenUIManager.toasts, "The toast offers Undo");

    WhimsyUndo.undo(window);
    ok(!WhimsyScamCheck.isTrusted("example.com"), "Undo forgets it");
    await shown(browser);

    WhimsyScamCheck.setTrusted("example.com", true);
    warning(browser)?.remove();
    BrowserTestUtils.reloadTab(gBrowser.selectedTab);
    await BrowserTestUtils.browserLoaded(browser);
    const signals = await browser.browsingContext.currentWindowGlobal.getActor("WhimsyScamCheck").sendQuery("WhimsyScamCheck:Check");
    is(await WhimsyScamCheck.onSignals(browser, signals), null, "A trusted site isn't warned again");

    // This Site's menu resets it.
    const popup = document.getElementById("zenSiteDataActions");
    if (popup) {
      popup.dispatchEvent(new Event("popupshowing"));
      const reset = document.getElementById("whimsy-scam-reset");
      ok(reset && !reset.hidden, "The site menu offers the reset");
    }
    WhimsyScamCheck.setTrusted("example.com", false);
    ok(!WhimsyScamCheck.isTrusted("example.com"), "Reset");
  });
  closeToasts();
});
