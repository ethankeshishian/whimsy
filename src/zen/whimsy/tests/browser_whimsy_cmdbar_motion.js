/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W10-27: the floating command bar opens with a quick, subtle scale-and-fade
// (160ms); Reduce Motion makes it a plain fade.
// C1 (wave 13): Zen closes the bar at once, as Zen does; the close motion is
// only an inert stand-in (110ms) where the bar was. Real ⌘T / type / Esc
// cycles: the bar is never left floating or half-closed, the input is empty
// on every reopen, and the stand-in never takes the pointer, focus or a11y.

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
  await SimpleTest.promiseFocus(window);
  EventUtils.synthesizeKey("KEY_Escape");
  if (gURLBar.view.isOpen) {
    EventUtils.synthesizeKey("KEY_Escape");
  }
  gURLBar.blur();
}

async function waitClosed() {
  await TestUtils.waitForCondition(() => gURLBar.getAttribute("zen-floating-urlbar") != "true", "The bar is hidden");
}

const ghosts = () => [...document.querySelectorAll(".whimsy-command-bar-ghost")];

// Zen's ⌘T, the way the app runs it (tests otherwise get a real new tab).
function commandT() {
  const testing = gZenUIManager.testingEnabled;
  gZenUIManager.testingEnabled = false;
  try {
    document.getElementById("cmd_newNavigatorTab").doCommand();
  } finally {
    gZenUIManager.testingEnabled = testing;
  }
}

const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));

add_task(async function open_motion_and_a_visual_close() {
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
  const floating = gURLBar.querySelector(".urlbar-background").getBoundingClientRect();
  // The bar's picture is taken once it has settled.
  await new Promise(resolve => setTimeout(resolve, 300));

  await closeBar();
  isnot(gURLBar.getAttribute("zen-floating-urlbar"), "true", "Zen closed the bar at once");
  is(gURLBar.getAnimations().length, 0, "Nothing animates the real bar");
  const [ghost] = ghosts();
  ok(ghost, "A stand-in plays the close");
  const box = ghost.getBoundingClientRect();
  ok(Math.abs(box.top - floating.top) < 2 && Math.abs(box.width - floating.width) < 2,
    "...where the floating bar was");
  ok(ghost.querySelector("canvas"), "...showing the bar as it last looked");
  ok(ghost.inert && ghost.getAttribute("aria-hidden") == "true", "It's inert and hidden from accessibility");
  ok(!ghost.querySelector("[tabindex], input, button, a"), "...with nothing focusable in it");
  is(getComputedStyle(ghost).pointerEvents, "none", "...and never takes the pointer");
  const [fade] = ghost.getAnimations();
  is(fade.effect.getTiming().duration, COMMAND_BAR_MOTION.close.duration, "Close lasts 110ms");
  await TestUtils.waitForCondition(() => !ghosts().length, "The stand-in goes away");
});

// The user's path, ten times: ⌘T, type, Esc, ⌘T. The real bar is closed
// (not floating, not half open) from the frame after Esc, never overlaps
// the stand-in, and every reopen starts empty.
add_task(async function command_t_cycles_reopen_empty() {
  gReduceMotionOverride = false;
  gBrowser.selectedBrowser.focus();
  for (let i = 0; i < 10; i++) {
    commandT();
    await TestUtils.waitForCondition(() => gURLBar.hasAttribute("zen-newtab") && gURLBar.focused, `⌘T ${i}`);
    is(gURLBar.value, "", `Reopen ${i}: the input is empty`);
    EventUtils.sendString(i % 2 ? "example" : "whimsy cycle");
    await TestUtils.waitForCondition(() => gURLBar.view.isOpen, "Results show");
    ok(UrlbarTestUtils.getResultCount(window) > 0, "...with rows, never an empty bar");
    EventUtils.synthesizeKey("KEY_Escape");
    if (gURLBar.view.isOpen || gURLBar.focused) {
      EventUtils.synthesizeKey("KEY_Escape");
    }
    for (let f = 0; f < 4; f++) {
      await frame();
      ok(gURLBar.getAttribute("zen-floating-urlbar") != "true", `Cycle ${i}, frame ${f}: the real bar is closed`);
      const bar = gURLBar.getBoundingClientRect();
      for (const ghost of ghosts()) {
        const g = ghost.getBoundingClientRect();
        const overlap = !(bar.right <= g.left || g.right <= bar.left || bar.bottom <= g.top || g.bottom <= bar.top);
        ok(!overlap || bar.width == 0, `Cycle ${i}, frame ${f}: no small bar behind the stand-in`);
      }
    }
  }
  await TestUtils.waitForCondition(() => !ghosts().length, "Stand-ins gone");
});

// ⌘L: Esc gives the page's address back, never old text.
add_task(async function command_l_reverts_to_the_page() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?c1-revert");
  for (let i = 0; i < 3; i++) {
    document.getElementById("Browser:OpenLocation").doCommand();
    await TestUtils.waitForCondition(() => gURLBar.focused, "⌘L");
    EventUtils.sendString("typed text");
    EventUtils.synthesizeKey("KEY_Escape");
    EventUtils.synthesizeKey("KEY_Escape");
    gBrowser.selectedBrowser.focus();
    await TestUtils.waitForCondition(() => gURLBar.untrimmedValue.includes("example.com"), `Reverted ${i}`);
  }
  BrowserTestUtils.removeTab(tab);
});

// "/" enters commands mode and stays (what a fast close and reopen once
// cleared).
add_task(async function slash_commands_mode_stays() {
  gBrowser.selectedBrowser.focus();
  for (let i = 0; i < 3; i++) {
    commandT();
    await TestUtils.waitForCondition(() => gURLBar.focused, "⌘T");
    EventUtils.sendString("/");
    await frame();
    await TestUtils.waitForCondition(() => gURLBar.searchMode, "Commands mode");
    await frame();
    await frame();
    ok(gURLBar.searchMode, `Still in commands mode (${i})`);
    EventUtils.synthesizeKey("KEY_Escape");
    EventUtils.synthesizeKey("KEY_Escape");
    gURLBar.searchMode = null;
    gBrowser.selectedBrowser.focus();
    await waitClosed();
  }
});

add_task(async function reduced_motion_is_a_fade() {
  gReduceMotionOverride = true;
  const open = await openBar();
  ok(open, "Reduced motion still fades in");
  is(open.effect.getTiming().duration, COMMAND_BAR_MOTION.openReduced.duration, "Fade in lasts 100ms");
  for (const frame_ of open.effect.getKeyframes()) {
    ok(!("scale" in frame_) && !("translate" in frame_), "Only opacity moves");
  }
  await open.finished;
  await closeBar();
  const [ghost] = ghosts();
  ok(ghost, "The close is a fade");
  is(ghost.getAnimations()[0].effect.getTiming().duration, COMMAND_BAR_MOTION.closeReduced.duration, "Fade out lasts 80ms");
  await TestUtils.waitForCondition(() => !ghosts().length, "Gone");
  gReduceMotionOverride = false;
});

add_task(async function a_stand_in_that_never_animates_still_goes() {
  gReduceMotionOverride = false;
  const open = await openBar();
  await open?.finished;
  await closeBar();
  const [ghost] = ghosts();
  ghost.getAnimations()[0].pause();
  await TestUtils.waitForCondition(() => !ghost.isConnected, "Removed on a timeout too");
});

add_task(async function switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.command-bar-motion", false]] });
  await openBar();
  is(barAnimations("whimsy-command-bar-open").length, 0, "No open animation with the switch off");
  await closeBar();
  await waitClosed();
  is(ghosts().length, 0, "No close stand-in with the switch off");
  await SpecialPowers.popPrefEnv();
});
