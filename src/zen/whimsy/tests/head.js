/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W11-P1: the harness ends every test file by waiting up to 5s for vsync to
// switch off (no animation or paint still running), then fails the file.
// On a loaded machine (the parallel verify, or a busy Mac) an animation the
// test's last step started (a panel closing, a Glance, a toast leaving) can
// take longer than that to finish. Wait for that same state, longer, as the
// file's very last cleanup; a real endless animation still fails the
// harness's check afterwards.
registerCleanupFunction(function whimsyQueueSettle() {
  // Registered from inside a cleanup, so it runs after the test's own.
  registerCleanupFunction(async function whimsySettleVsync() {
    if (!ChromeUtils.vsyncEnabled()) {
      return;
    }
    await TestUtils.waitForCondition(() => !ChromeUtils.vsyncEnabled(), "Animations have finished", 100, 300)
      .catch(() => {});
  });
});
