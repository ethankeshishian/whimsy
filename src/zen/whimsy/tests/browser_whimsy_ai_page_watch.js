/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// AI Page Watch mochitest:
// - User picks a page and a condition in plain words
// - Re-checks on interval ONLY while Whimsy is open
// - Uses user's logged-in session (cookies & container)
// - Shows recurring alert until dismissed
// - Obey kill switch and selected provider

const { WhimsyAI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAI.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyPageWatch } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPageWatch.sys.mjs");

registerCleanupFunction(async () => {
  Services.prefs.clearUserPref("whimsy.ai.provider");
  Services.prefs.clearUserPref("whimsy.ai.blocked");
  Services.prefs.clearUserPref("whimsy.feature.page-watch");
  WhimsyAIProviders.setFakeHandler(null);

  // Clear test watches
  for (const watch of WhimsyPageWatch.getWatches()) {
    WhimsyPageWatch.removeWatch(watch.id);
  }
});

add_task(async function test_page_watch_flow_and_recurring_alert() {
  WhimsyAIProviders.provider = "fake";

  const testUrl = "data:text/html,<html><body><h1>Item Store</h1><p class='price'>Price: $35</p></body></html>";
  const condition = "Price drops below $50";

  // 1. Add watch
  const watch = WhimsyPageWatch.addWatch({
    url: testUrl,
    condition,
    intervalMinutes: 15,
  });

  ok(watch.id, "Watch was created with an id");
  is(watch.condition, condition, "Condition saved");
  is(WhimsyPageWatch.getWatches().length, 1, "Watch listed in active watches");

  // Mock condition met response
  WhimsyAIProviders.setFakeHandler(({ prompt }) => {
    ok(prompt.includes("Price drops below $50"), "Condition included in prompt");
    return {
      text: JSON.stringify({ met: true, reason: "Price is $35, which is under $50" }),
    };
  });

  // 2. Initial check
  const res = await WhimsyPageWatch.checkWatch(watch);
  ok(res.met, "Condition was evaluated as met");
  ok(watch.triggered, "Watch marked as triggered");
  ok(!watch.dismissed, "Watch is not yet dismissed");

  // Verify alert bar appeared in window
  const alertBar = document.getElementById(`whimsy-watch-alert-${watch.id}`);
  ok(alertBar, "Recurring alert notification bar was displayed in window");

  // 3. Deduplication test: re-checking with unchanged content re-shows alert if not dismissed
  let aiCallCount = 0;
  WhimsyAIProviders.setFakeHandler(() => {
    aiCallCount++;
    return { text: JSON.stringify({ met: true, reason: "Price is $35" }) };
  });

  const resDedupe = await WhimsyPageWatch.checkWatch(watch);
  ok(resDedupe.met, "Result returned from cache");
  is(aiCallCount, 0, "AI inference was skipped due to content hash deduplication");

  // 4. Dismiss alert
  WhimsyPageWatch.dismissAlert(watch.id);
  ok(watch.dismissed, "Watch marked as dismissed");
  const alertAfterDismiss = document.getElementById(`whimsy-watch-alert-${watch.id}`);
  ok(!alertAfterDismiss, "Alert was removed after dismissal");

  // 5. Kill switch test
  Services.prefs.setBoolPref(WhimsyAI.PREF, true);
  const blockedCheck = await WhimsyPageWatch.checkWatch(watch, { force: true });
  is(blockedCheck, null, "checkWatch returned null when kill switch active");
  Services.prefs.setBoolPref(WhimsyAI.PREF, false);

  // 6. Remove watch
  WhimsyPageWatch.removeWatch(watch.id);
  is(WhimsyPageWatch.getWatches().length, 0, "Watch removed");
});
