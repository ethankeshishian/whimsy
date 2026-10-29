/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Little Arc (Cmd+Opt+N; also where WhimsyExternalLinks lands a link when
// the target is "quick-window"): a small window with no sidebar, just the
// nav bar and the page. Covers the main flow (open, reuse, move to space),
// the switch off, and closing it leaving no trace.

const { WhimsyQuickWindow } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs");

registerCleanupFunction(async () => {
  const win = WhimsyQuickWindow.current();
  if (win) {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_open_hides_the_sidebar() {
  const win = WhimsyQuickWindow.open("https://example.com/");
  ok(win._whimsyQuickWindow, "Tagged as a quick window");
  await BrowserTestUtils.waitForCondition(
    () => win.document.documentElement.hasAttribute("whimsy-quick-window"),
    "whimsy-quick-window attribute set"
  );
  const sidebar = win.document.getElementById("navigator-toolbox");
  is(win.getComputedStyle(sidebar).display, "none", "The vertical sidebar is hidden");
  ok(!win.toolbar.visible, "Opened as a popup window (no trace once closed)");
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_a_second_link_reuses_the_same_window() {
  const first = WhimsyQuickWindow.open("https://example.com/");
  const second = WhimsyQuickWindow.open("https://example.org/");
  is(first, second, "The same quick window is reused, not a second one");
  await BrowserTestUtils.waitForCondition(
    () => first.gBrowser.selectedBrowser.currentURI.spec == "https://example.org/",
    "The reused window navigated to the new link"
  );
  await BrowserTestUtils.closeWindow(first);
});

add_task(async function test_move_to_space_adopts_the_tab_and_closes_the_window() {
  const spaceId = window.gZenWorkspaces.activeWorkspace;
  const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
  const tabCountBefore = gBrowser.tabs.length;
  const adopted = WhimsyQuickWindow.moveToSpace(win, spaceId);
  ok(adopted, "moveToSpace returns the adopted tab");
  is(gBrowser.tabs.length, tabCountBefore + 1, "The tab landed in this window");
  is(adopted.linkedBrowser.currentURI.spec, "https://example.com/", "It's the quick window's page");
  await BrowserTestUtils.waitForCondition(() => win.closed, "The quick window closes once the tab is adopted");
  BrowserTestUtils.removeTab(adopted);
});

add_task(async function test_feature_off_does_nothing() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.quick-window", false]] });
  const win = WhimsyQuickWindow.open("https://example.com/");
  is(win, null, "No quick window opens with the feature off");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_shortcut_opens_an_empty_focused_window() {
  const win = WhimsyQuickWindow.open(null, { opener: window });
  is(win.gBrowser.selectedBrowser.currentURI.spec, "about:blank", "An empty window for the bare shortcut");
  await BrowserTestUtils.closeWindow(win);
});
