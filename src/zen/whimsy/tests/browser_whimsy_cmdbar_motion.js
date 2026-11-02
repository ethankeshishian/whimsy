/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W10-27: the floating command bar opens with a quick, subtle scale-and-fade
// (160ms) and closes a little faster (110ms); Reduce Motion makes both a
// plain fade. A reopen during the close picks up from what is on screen, and
// the bar is usable at once.

const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");
const { COMMAND_BAR_MOTION } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommandBar.sys.mjs");

registerCleanupFunction(() => {
  gReduceMotionOverride = undefined;
});

// Opens the bar; resolves to its open animation, caught as it starts (a
// short one can be over before the bar has its results).
async function openBar(value = "example") {
  gURLBar.blur();
  await SimpleTest.promiseFocus(window);
  let open = null;
  const observer = new MutationObserver(() => {
    open ??= gURLBar.getAnimations().find(a => a.id == "whimsy-command-bar-open") ?? null;
  });
  observer.observe(gURLBar, { attributes: true });
  try {
    document.getElementById("Browser:OpenLocation").doCommand();
    await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, waitForFocus: SimpleTest.waitForFocus, value });
    await TestUtils.waitForCondition(
      () => gURLBar.getAttribute("zen-floating-urlbar") == "true" && gURLBar.hasAttribute("open"),
      "The command bar floats open"
    );
  } finally {
    observer.disconnect();
  }
  return open;
}

function barAnimations(id) {
  return gURLBar.getAnimations().filter(a => a.id == id);
}

async function closeBar() {
  EventUtils.synthesizeKey("KEY_Escape");
  if (gURLBar.view.isOpen) {
    EventUtils.synthesizeKey("KEY_Escape");
  }
  gURLBar.blur();
}

async function waitClosed() {
  await TestUtils.waitForCondition(
    () => gURLBar.getAttribute("zen-floating-urlbar") != "true" && !gURLBar.hasAttribute("whimsy-closing"),
    "The bar is hidden"
  );
}

add_task(async function open_and_close_motion() {
  gReduceMotionOverride = false;
  ok(window.WhimsyCommandBarMotion, "The window has the command bar motion");
  const open = await openBar();
  ok(open, "Opening the bar runs one open animation");
  const timing = open.effect.getTiming();
  is(timing.duration, COMMAND_BAR_MOTION.open.duration, "Open lasts 160ms");
  is(timing.easing, "cubic-bezier(0.2, 0, 0, 1)", "Open uses the standard curve");
  const frames = open.effect.getKeyframes();
  is(frames[0].opacity, "0", "Open starts transparent");
  is(frames[0].scale, "0.97", "Open starts slightly smaller");
  ok(/-\s?6px\)?$/.test(frames[0].translate), `Open starts 6px higher (${frames[0].translate})`);
  ok(!("transform" in frames[0]), "Open never animates transform (Zen centres with translate)");
  await open.finished;

  await closeBar();
  await TestUtils.waitForCondition(() => barAnimations("whimsy-command-bar-close").length, "Close animation runs");
  const [close] = barAnimations("whimsy-command-bar-close");
  is(close.effect.getTiming().duration, COMMAND_BAR_MOTION.close.duration, "Close lasts 110ms");
  is(close.effect.getTiming().easing, "cubic-bezier(0.4, 0, 1, 1)", "Close accelerates out");
  const closeFrames = close.effect.getKeyframes();
  ok(closeFrames[0].translate.includes("-50%"), `Close starts centered (${closeFrames[0].translate})`);
  ok(/-\s?4px\)?$/.test(closeFrames[1].translate), `Close rises 4px (${closeFrames[1].translate})`);
  is(closeFrames[1].opacity, "0", "Close ends transparent");
  is(gURLBar.getAttribute("whimsy-closing"), "true", "The bar ignores the pointer while it closes");
  ok(getComputedStyle(gURLBar).translate.includes("-50%"), "Bar stays floating while closing");
  isnot(document.activeElement, gURLBar.inputField, "Focus left the bar at once, as before");
  await waitClosed();
  is(gURLBar.getAnimations().length, 0, "Nothing is left running on the bar");
});

// A close whose animation never finishes (its timeline stalled: a
// throttled or occluded window, as in the release quick verify) or gets
// cancelled still ends the hide; the next close must not wait on it
// forever (the view never closed and the test hung for 20s).
add_task(async function a_stalled_or_cancelled_close_still_hides() {
  gReduceMotionOverride = false;
  for (const how of ["stall", "cancel"]) {
    const open = await openBar();
    await open?.finished;
    await closeBar();
    const close = await TestUtils.waitForCondition(() => barAnimations("whimsy-command-bar-close")[0],
      `${how}: close animation runs`);
    if (how == "stall") {
      close.pause();
    } else {
      close.cancel();
    }
    await waitClosed();
    ok(!WhimsyCommandBarMotion.closing, `${how}: the hide finished`);
    // And the bar opens and closes normally afterwards.
    await openBar();
    const closed = UrlbarTestUtils.promisePopupClose(window, () => gURLBar.blur());
    await closed;
    await waitClosed();
  }
});

add_task(async function reduced_motion_is_a_fade() {
  gReduceMotionOverride = true;
  const open = await openBar();
  ok(open, "Reduced motion still fades in");
  is(open.effect.getTiming().duration, COMMAND_BAR_MOTION.openReduced.duration, "Fade in lasts 100ms");
  for (const frame of open.effect.getKeyframes()) {
    ok(!("scale" in frame) && !("translate" in frame), "Only opacity moves");
  }
  await open.finished;
  await closeBar();
  await TestUtils.waitForCondition(() => barAnimations("whimsy-command-bar-close").length, "Fade out runs");
  is(barAnimations("whimsy-command-bar-close")[0].effect.getTiming().duration,
    COMMAND_BAR_MOTION.closeReduced.duration, "Fade out lasts 80ms");
  await waitClosed();
  gReduceMotionOverride = false;
});

add_task(async function reopen_during_close() {
  gReduceMotionOverride = false;
  await openBar();
  await Promise.all(gURLBar.getAnimations().map(a => a.finished));
  await closeBar();
  await TestUtils.waitForCondition(() => window.WhimsyCommandBarMotion.closing, "Closing");
  // Hold the close halfway, so half the bar is on screen.
  const [close] = barAnimations("whimsy-command-bar-close");
  close.pause();
  close.currentTime = COMMAND_BAR_MOTION.close.duration / 2;
  // Reopen within the close: the hide finishes at once and the open
  // continues from what is visible. The open starts in the same mutation
  // batch that floats the bar, so look at it there (it is short).
  let open = null;
  const observer = new MutationObserver(() => {
    open ??= barAnimations("whimsy-command-bar-open")[0] ?? null;
  });
  observer.observe(gURLBar, { attributes: true });
  try {
    document.getElementById("Browser:OpenLocation").doCommand();
    await TestUtils.waitForCondition(() => !window.WhimsyCommandBarMotion.closing, "The pending hide ended on reopen");
    await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, waitForFocus: SimpleTest.waitForFocus, value: "exam" });
    await TestUtils.waitForCondition(
      () => gURLBar.getAttribute("zen-floating-urlbar") == "true" && gURLBar.hasAttribute("open"),
      "Open again"
    );
  } finally {
    observer.disconnect();
  }
  ok(open, "The reopen animates");
  ok(open.currentTime >= COMMAND_BAR_MOTION.open.duration * 0.4, `from about halfway (${open.currentTime}ms)`);
  await open.finished;
  ok(gURLBar.focused, "The bar has the keyboard");
  EventUtils.sendString("ple");
  is(gURLBar.value, "example", "Typing goes straight into the bar");
  await closeBar();
  await waitClosed();
});

add_task(async function return_loads_before_close_finishes() {
  gReduceMotionOverride = false;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  await openBar("https://example.com/");
  await Promise.all(gURLBar.getAnimations().map(a => a.finished));
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, "https://example.com/");
  let closeFinished = false;
  let sawStartBeforeFinish = false;
  const listener = {
    onLocationChange(browser) {
      if (browser == tab.linkedBrowser && !closeFinished) {
        sawStartBeforeFinish = true;
      }
    },
  };
  gBrowser.addTabsProgressListener(listener);
  EventUtils.synthesizeKey("KEY_Enter");
  const close = barAnimations("whimsy-command-bar-close")[0];
  close?.finished.then(() => (closeFinished = true), () => (closeFinished = true));
  await loaded;
  gBrowser.removeTabsProgressListener(listener);
  ok(sawStartBeforeFinish || !close, "The page started loading before the close animation finished");
  await waitClosed();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.command-bar-motion", false]] });
  await openBar();
  is(barAnimations("whimsy-command-bar-open").length, 0, "No open animation with the switch off");
  await closeBar();
  is(gURLBar.getAttribute("zen-floating-urlbar") == "true" && gURLBar.hasAttribute("whimsy-closing"), false,
    "The bar hides at once with the switch off");
  await waitClosed();
  await SpecialPowers.popPrefEnv();
});
