/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Private window indicator: private windows get a violet tint, a violet
// accent and an "Incognito" badge; normal windows don't.

const { Whimsy } = ChromeUtils.importESModule("resource:///modules/whimsy/Whimsy.sys.mjs");

function background(win) {
  const el = win.document.getElementById("zen-browser-background");
  return win.getComputedStyle(el).getPropertyValue("--zen-main-browser-background");
}

add_task(async function test_normal_window_untouched() {
  ok(Services.prefs.getBoolPref("whimsy.feature.private-indicator"), "The feature switch is on");
  ok(!document.documentElement.hasAttribute("whimsy-private"), "A normal window has no private marker");
  ok(!background(window).includes("rgb(52, 30, 92)"), "A normal window keeps its space's gradient");
});

add_task(async function test_private_window_tinted() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  await win.gZenWorkspaces?.promiseInitialized;
  const root = win.document.documentElement;
  ok(root.hasAttribute("whimsy-private"), "The private window is marked");
  ok(background(win).includes("rgb(52, 30, 92)"), "Its background has the violet tint");
  is(
    win.getComputedStyle(root).getPropertyValue("--zen-primary-color").trim(),
    "rgb(152, 110, 255)",
    "Its accent is violet"
  );
  const name = await TestUtils.waitForCondition(() =>
    [...win.document.querySelectorAll(".zen-current-workspace-indicator-name")].find(el => el.checkVisibility())
  );
  is(name.textContent || name.value, "Incognito", "The space badge reads Incognito");
  isnot(win.getComputedStyle(name).backgroundColor, "rgba(0, 0, 0, 0)", "The badge has a fill");

  // A second private window is marked too.
  const win2 = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  ok(win2.document.documentElement.hasAttribute("whimsy-private"), "Every private window is marked");
  await BrowserTestUtils.closeWindow(win2);
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_feature_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.private-indicator", false]] });
  ok(!Whimsy.featureEnabled("private-indicator"), "Switch reads off");
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  ok(!win.document.documentElement.hasAttribute("whimsy-private"), "With the switch off, Zen's look is untouched");
  await BrowserTestUtils.closeWindow(win);
  await SpecialPowers.popPrefEnv();
});
