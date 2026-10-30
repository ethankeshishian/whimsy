/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Mini Whimsy (Arc's "Little Arc"; Cmd+Opt+N, and also where
// WhimsyExternalLinks lands a link when the target is "quick-window"): a
// small window with no sidebar, just the nav bar and the page, floating
// above every other window. Covers the main flow (open, reuse, float,
// move to space by button/Cmd+O/Cmd+Opt+O, Esc to close), the switch off,
// and closing it leaving no trace (including no geometry left behind for
// ordinary windows to inherit).

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

add_task(async function test_floats_above_other_windows() {
  const win = WhimsyQuickWindow.open("https://example.com/");
  // Same technique engine/dom/documentpip's browser_pip_ui.js uses: the
  // widget itself can't be introspected from here, but the chrome flag that
  // drives NSFloatingWindowLevel on macOS (and the equivalent elsewhere) can.
  const chromeFlags = win.docShell.treeOwner
    .QueryInterface(Ci.nsIInterfaceRequestor)
    .getInterface(Ci.nsIAppWindow).chromeFlags;
  ok(
    chromeFlags & Ci.nsIWebBrowserChrome.CHROME_ALWAYS_ON_TOP,
    "Mini Whimsy has the alwaysontop chrome flag (Arc parity: floats above other windows)"
  );
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_does_not_persist_its_geometry() {
  // browser.xhtml's <html id="main-window"> persists screenX/screenY/
  // width/height under that id for every window, quick or not; a quick
  // window must not write its small size over an ordinary window's.
  const win = WhimsyQuickWindow.open("https://example.com/");
  is(
    win.document.documentElement.getAttribute("persist"),
    null,
    "Mini Whimsy doesn't persist its geometry (would clobber ordinary windows')"
  );
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

add_task(async function test_cmd_o_opens_in_current_space() {
  // Arc parity: Cmd+O moves the page into the current space directly, no
  // picker. Zen's own Cmd+O ("Expand Glance") must not fire instead.
  const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
  const tabCountBefore = gBrowser.tabs.length;
  EventUtils.synthesizeKey("o", { accelKey: true }, win);
  await BrowserTestUtils.waitForCondition(() => win.closed, "Cmd+O moves the tab and closes the quick window");
  is(gBrowser.tabs.length, tabCountBefore + 1, "The tab landed in the current space");
  const adopted = gBrowser.tabs[gBrowser.tabs.length - 1];
  is(adopted.linkedBrowser.currentURI.spec, "https://example.com/", "It's the quick window's page");
  BrowserTestUtils.removeTab(adopted);
});

add_task(async function test_cmd_opt_o_opens_the_space_picker() {
  const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
  EventUtils.synthesizeKey("o", { accelKey: true, altKey: true }, win);
  await BrowserTestUtils.waitForCondition(
    () => win.document.getElementById("whimsy-quick-window-space-picker")?.state == "open",
    "Cmd+Opt+O opens the space picker"
  );
  const popup = win.document.getElementById("whimsy-quick-window-space-picker");
  ok(popup.children.length >= 1, "The picker lists at least this window's space");
  popup.hidePopup();
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_escape_closes_the_window_without_a_trace() {
  const win = WhimsyQuickWindow.open("https://example.com/");
  EventUtils.synthesizeKey("KEY_Escape", {}, win);
  await BrowserTestUtils.waitForCondition(() => win.closed, "Esc vanishes the window, as in Arc");
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
