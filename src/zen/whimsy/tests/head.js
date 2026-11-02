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
// wave13/toast: toasts stack and some stay for seconds, so one a file left
// up would sit above the next file's toasts. Each file starts clean.
registerCleanupFunction(function whimsyCloseToasts() {
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    win.gZenUIManager?.toasts?.getToasts({ includeClosing: true }).forEach(toast => toast.close({ instant: true }));
  }
});

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

// A snapshot of a window paints each remote frame in its own process. When
// one of those frames goes away or is replaced mid-paint (a tab closing or
// switching process, a page committing), Gecko drops its fragment and the
// whole snapshot rejects with NS_ERROR_LOSS_OF_SIGNIFICANT_DATA
// (CrossProcessPaint::LostFragment). That's a race with the page, not a
// failed check: paint again, once the frames have settled.
async function whimsySnapshot(windowGlobal, rect, scale = 1, background = "white") {
  for (let attempt = 1; ; attempt++) {
    try {
      return await windowGlobal.drawSnapshot(rect, scale, background);
    } catch (e) {
      if (e?.result != Cr.NS_ERROR_LOSS_OF_SIGNIFICANT_DATA || attempt >= 5) {
        throw e;
      }
      info(`Snapshot lost a frame mid-paint (attempt ${attempt}); painting again`);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
  }
}

// wave13/toast: Whimsy's toasts are Zen's (gZenUIManager.toasts,
// WhimsyZenToasts.sys.mjs). The newest toast showing in `win`, as the
// handle open() returned (element, messageId, update(), close()), or null.
function currentToast(win = window) {
  return win.gZenUIManager.toasts.getToasts()[0] ?? null;
}

// The toast showing in `win` for this message, or null.
function toastFor(messageId, win = window) {
  return win.gZenUIManager.toasts.getToasts().find(t => t.messageId == messageId) ?? null;
}

// Takes every toast down at once, without motion, including any still
// fading out.
function closeToasts(win = window) {
  for (const toast of win.gZenUIManager.toasts.getToasts({ includeClosing: true })) {
    toast.close({ instant: true });
  }
}
