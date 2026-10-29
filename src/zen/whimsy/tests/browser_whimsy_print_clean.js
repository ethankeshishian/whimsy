/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Print a clean page: reader mode, then print, without changing the tab
// the person is looking at. Covers the command-bar action being available
// only for an article, the non-readerable fallback to a normal print, and
// the feature switch.

const { WhimsyPrintClean } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyPrintClean.sys.mjs"
);

add_task(async function test_action_availability() {
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const action = globalActions.find(a => a.l10nId == "whimsy-action-print-clean");
  ok(action, "the command bar action was registered");

  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  ok(action.isAvailable(window), "available whenever a tab has a URL");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_non_readerable_falls_back_to_normal_print() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  gBrowser.selectedBrowser.isArticle = false;

  let printedBrowsingContext = null;
  const stub = { startPrintWindow: bc => (printedBrowsingContext = bc) };
  const original = window.PrintUtils;
  window.PrintUtils = stub;
  try {
    WhimsyPrintClean.run(window);
  } finally {
    window.PrintUtils = original;
  }
  is(printedBrowsingContext, gBrowser.selectedBrowser.browsingContext, "falls back to printing the visible tab as-is");
  is(gBrowser.selectedTab, tab, "the visible tab never changed");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_feature_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.print-clean", false]] });
  ok(!WhimsyPrintClean.enabled, "the switch turns the feature off");
  await SpecialPowers.popPrefEnv();
});
