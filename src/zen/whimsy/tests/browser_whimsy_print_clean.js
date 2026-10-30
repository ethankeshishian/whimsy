/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Print a clean page: the print dialog on the visible tab with "Simplify
// page" (Firefox's reader-mode print) picked. Covers the command-bar action,
// that an article opens the dialog in the same tab with no extra tab
// (regression: a hidden reader tab was opened and closed, taking the dialog
// with it), the non-readerable fallback to a normal print, and the switch.

const ARTICLE_URL =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_article.html";

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

add_task(async function test_article_prints_simplified_in_place() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, ARTICLE_URL);
  const browser = tab.linkedBrowser;
  await TestUtils.waitForCondition(() => browser.isArticle, "the test article is readerable");
  const tabCount = gBrowser.tabs.length;
  let opened = 0;
  const onOpen = () => opened++;
  gBrowser.tabContainer.addEventListener("TabOpen", onOpen);

  WhimsyPrintClean.run(window);

  const manager = PrintUtils.getTabDialogBox(browser).getTabDialogManager();
  const dialog = manager._dialogs.findLast(d => d._box?.querySelector("print-preview"));
  ok(dialog, "the print dialog opened on the visible tab");
  await dialog._dialogReady;
  const printWin = dialog.frameContentWindow;
  await printWin._initialized;
  await TestUtils.waitForCondition(
    () => printWin.document.getElementById("source-version-simplified-radio")?.checked,
    "Simplify page was chosen"
  );
  is(printWin.PrintEventHandler.viewSettings.sourceVersion, "simplified", "the preview prints the reader version");
  is(gBrowser.tabs.length, tabCount, "no extra tab was left behind");
  is(opened, 0, "no hidden tab was opened");
  is(gBrowser.selectedTab, tab, "the visible tab never changed");
  ok(dialog._frame.isConnected, "the dialog is still open");

  gBrowser.tabContainer.removeEventListener("TabOpen", onOpen);
  const closed = TestUtils.waitForCondition(() => !dialog._frame?.contentWindow || !manager._dialogs.includes(dialog));
  dialog.close();
  await closed;
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
