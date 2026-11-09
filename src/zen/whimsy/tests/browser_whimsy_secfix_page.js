/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 secfix M7: a page can't hide from the scam warning by drawing its
// form late, putting it in a frame, or reloading itself to look familiar.

const { WhimsyScamCheck } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyScamCheck.sys.mjs");
const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const warning = browser => gBrowser.getNotificationBox(browser).getNotificationWithValue("whimsy-scam-warning");

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-hints", false], ["whimsy.ai.enabled", true]] });
  WhimsyScamCheck._visitCount = () => 0;
  registerCleanupFunction(async () => {
    WhimsyScamCheck._visitCount = null;
    Services.prefs.clearUserPref("whimsy.ai.scam.trusted");
    await PlacesUtils.history.clear();
    closeToasts();
  });
});

add_task(async function a_form_drawn_late_is_checked() {
  await BrowserTestUtils.withNewTab(ROOT + "whimsy_secfix_late_scam.html", async browser => {
    const notification = await TestUtils.waitForCondition(() => warning(browser), "The warning shows once the late form arrives");
    const reasons = [...notification.querySelectorAll(".whimsy-scam-body li")].map(li => li.getAttribute("data-l10n-id"));
    ok(reasons.includes("whimsy-scam-reason-threat"), "for what the page says");
  });
});

add_task(async function a_form_in_a_frame_is_checked() {
  await BrowserTestUtils.withNewTab(ROOT + "whimsy_secfix_scam_frame.html", async browser => {
    await TestUtils.waitForCondition(() => warning(browser), "A login form inside another site's frame warns on the tab");
  });
});

add_task(async function reloads_never_make_a_site_familiar() {
  WhimsyScamCheck._visitCount = null;
  await PlacesUtils.history.clear();
  const url = "https://phish.example/login";
  const now = new Date();
  await PlacesUtils.history.insert({ url, visits: [{ date: now }, { date: new Date(now - 1000) }, { date: new Date(now - 2000) }] });
  is(await WhimsyScamCheck.visits("phish.example"), 0, "Three visits today (a page reloading itself) still count as new");
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 2);
  await PlacesUtils.history.insert({ url, visits: [{ date: yesterday }] });
  is(await WhimsyScamCheck.visits("phish.example"), 1, "A visit before today makes it familiar");
  WhimsyScamCheck._visitCount = () => 0;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, ROOT + "whimsy_secfix_inject.html");
  let shownHost = null;
  const real = WhimsyScamCheck.show;
  WhimsyScamCheck.show = async (browser, host) => {
    shownHost = host;
    return null;
  };
  try {
    await WhimsyScamCheck.onSignals(tab.linkedBrowser, { host: "bank.example", password: true, card: false, signals: [{ id: "threat", quote: "x" }, { id: "account-elsewhere", quote: "Bank" }] });
  } finally {
    WhimsyScamCheck.show = real;
    BrowserTestUtils.removeTab(tab);
  }
  is(shownHost, "example.com", "The site is the tab's own, not what the page reports");
});
