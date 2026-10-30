/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// AI Page features mochitest:
// (1) Ask on Page
// (2) 5-second hover preview summary

const { WhimsyAI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAI.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIPage } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIPage.sys.mjs");

registerCleanupFunction(async () => {
  Services.prefs.clearUserPref("whimsy.ai.provider");
  Services.prefs.clearUserPref("whimsy.ai.blocked");
  Services.prefs.clearUserPref("whimsy.feature.ask-on-page");
  Services.prefs.clearUserPref("whimsy.ai.hover-preview");
  WhimsyAIProviders.setFakeHandler(null);
});

add_task(async function test_ask_on_page() {
  WhimsyAIProviders.provider = "fake";

  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "data:text/html,<html><body><h1>Pricing Information</h1><p>The standard plan is 20 dollars per month.</p></body></html>"
  );

  WhimsyAIProviders.setFakeHandler(({ prompt }) => {
    ok(prompt.includes("The standard plan is 20 dollars"), "Page text was included in the prompt");
    return { text: "The standard plan costs $20/month." };
  });

  const answer = await WhimsyAIPage.askOnPage(window, "How much is the plan?");
  is(answer, "The standard plan costs $20/month.", "Ask on page returned grounded answer");

  // Verify kill switch blocks Ask on Page
  Services.prefs.setBoolPref(WhimsyAI.PREF, true);
  let threw = false;
  try {
    await WhimsyAIPage.askOnPage(window, "How much is the plan?");
  } catch (e) {
    threw = true;
  }
  ok(threw, "Ask on Page threw when kill switch was active");
  Services.prefs.setBoolPref(WhimsyAI.PREF, false);

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_hover_preview_summary() {
  WhimsyAIProviders.provider = "fake";

  WhimsyAIProviders.setFakeHandler(({ prompt }) => {
    return { text: "• First key point\n• Second key point" };
  });

  // Mock link summarization
  const testUrl = "data:text/html,<html><body><h1>Destination Page</h1><p>Detailed article text here.</p></body></html>";
  const summary = await WhimsyAIPage.summarizeLink(testUrl);
  ok(summary?.includes("First key point"), "Summary returned key points");

  // Kill switch test
  Services.prefs.setBoolPref(WhimsyAI.PREF, true);
  const blockedSummary = await WhimsyAIPage.summarizeLink(testUrl);
  is(blockedSummary, null, "Hover summary returns null when kill switch is on");
  Services.prefs.setBoolPref(WhimsyAI.PREF, false);
});
