/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Mini Whimsy (Arc's "Little Arc"; Cmd+Opt+N, and also where
// WhimsyExternalLinks lands a link when the target is "quick-window"): a
// small window with no sidebar, just the nav bar and the page, floating
// above every other window. Covers the main flow (open, reuse, float,
// move to space by button/Cmd+O/Cmd+Shift+O, Esc to close), the switch off,
// and closing it leaving no trace (including no geometry left behind for
// ordinary windows to inherit).

add_setup(async function isolate_mini_size() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.quick-window.size", ""]] });
});

const { WhimsyQuickWindow } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs");

registerCleanupFunction(async () => {
  const win = WhimsyQuickWindow.current();
  if (win) {
    await WhimsyQuickWindow.whenReady(win);
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_open_hides_the_sidebar() {
  const win = WhimsyQuickWindow.open("https://example.com/");
  await WhimsyQuickWindow.whenReady(win);
  ok(win._whimsyQuickWindow, "Tagged as a quick window");
  await TestUtils.waitForCondition(
    () => win.document.documentElement.hasAttribute("whimsy-quick-window"),
    "whimsy-quick-window attribute set"
  );
  const sidebar = win.document.getElementById("navigator-toolbox");
  is(win.getComputedStyle(sidebar).display, "none", "The vertical sidebar is hidden");
  ok(!win.toolbar.visible, "Opened as a popup window (no trace once closed)");
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_floats_above_other_windows_on_its_own_space() {
  const win = WhimsyQuickWindow.open("https://example.com/");
  await WhimsyQuickWindow.whenReady(win);
  // Same technique engine/dom/documentpip's browser_pip_ui.js uses: the
  // widget itself can't be introspected from here, but the chrome flags
  // that drive NSFloatingWindowLevel + FullScreenAuxiliary (and not
  // CanJoinAllSpaces) on macOS can be. Arc's Little Arc floats on its own
  // Space, not every Space (see the module's banner comment for the
  // evidence) -- CHROME_ALWAYS_ON_TOP alone would be a deviation from Arc.
  const chromeFlags = win.docShell.treeOwner
    .QueryInterface(Ci.nsIInterfaceRequestor)
    .getInterface(Ci.nsIAppWindow).chromeFlags;
  ok(
    chromeFlags & Ci.nsIWebBrowserChrome.CHROME_ALWAYS_ON_TOP,
    "Mini Whimsy floats (Arc parity)"
  );
  ok(
    chromeFlags & Ci.nsIWebBrowserChrome.CHROME_ALWAYS_ON_TOP_FULLSCREEN_AUX,
    "...but only above its own Space / a full-screen app, not every Space (Arc parity)"
  );
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_does_not_persist_its_geometry() {
  // browser.xhtml's <html id="main-window"> persists screenX/screenY/
  // width/height under that id for every window, quick or not; a quick
  // window must not write its small size over an ordinary window's.
  const win = WhimsyQuickWindow.open("https://example.com/");
  await WhimsyQuickWindow.whenReady(win);
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
  await WhimsyQuickWindow.whenReady(first);
  is(first, second, "The same quick window is reused, not a second one");
  await TestUtils.waitForCondition(
    () => first.gBrowser.selectedBrowser.currentURI.spec == "https://example.org/",
    "The reused window navigated to the new link"
  );
  await BrowserTestUtils.closeWindow(first);
});

add_task(async function test_move_to_space_adopts_the_tab_and_closes_the_window() {
  const spaceId = window.gZenWorkspaces.activeWorkspace;
  const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
  await WhimsyQuickWindow.whenReady(win);
  await TestUtils.waitForCondition(
    () => win.gBrowser.selectedBrowser.currentURI.spec == "https://example.com/",
    "The quick window loaded its page"
  );
  const tabCountBefore = gBrowser.tabs.length;
  const adopted = WhimsyQuickWindow.moveToSpace(win, spaceId);
  ok(adopted, "moveToSpace returns the adopted tab");
  is(gBrowser.tabs.length, tabCountBefore + 1, "The tab landed in this window");
  is(adopted.linkedBrowser.currentURI.spec, "https://example.com/", "It's the quick window's page");
  await TestUtils.waitForCondition(() => win.closed, "The quick window closes once the tab is adopted");
  BrowserTestUtils.removeTab(adopted);
});

add_task(async function test_cmd_o_opens_in_current_space() {
  // Arc parity: Cmd+O moves the page into the current space directly, no
  // picker. Zen's own Cmd+O ("Expand Glance") must not fire instead.
  const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
  await WhimsyQuickWindow.whenReady(win);
  await TestUtils.waitForCondition(
    () => win.gBrowser.selectedBrowser.currentURI.spec == "https://example.com/",
    "The quick window loaded its page"
  );
  const tabCountBefore = gBrowser.tabs.length;
  EventUtils.synthesizeKey("o", { accelKey: true }, win);
  await TestUtils.waitForCondition(() => win.closed, "Cmd+O moves the tab and closes the quick window");
  is(gBrowser.tabs.length, tabCountBefore + 1, "The tab landed in the current space");
  const adopted = gBrowser.tabs[gBrowser.tabs.length - 1];
  is(adopted.linkedBrowser.currentURI.spec, "https://example.com/", "It's the quick window's page");
  BrowserTestUtils.removeTab(adopted);
});

add_task(async function test_cmd_shift_o_opens_the_space_picker() {
  const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
  await WhimsyQuickWindow.whenReady(win);
  EventUtils.synthesizeKey("o", { accelKey: true, shiftKey: true }, win);
  await TestUtils.waitForCondition(
    () => win.document.getElementById("whimsy-quick-window-space-picker")?.state == "open",
    "Cmd+Shift+O opens the space picker"
  );
  const popup = win.document.getElementById("whimsy-quick-window-space-picker");
  ok(popup.children.length >= 1, "The picker lists at least this window's space");
  popup.hidePopup();
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_escape_closes_the_window_without_a_trace() {
  const win = WhimsyQuickWindow.open("https://example.com/");
  await WhimsyQuickWindow.whenReady(win);
  EventUtils.synthesizeKey("KEY_Escape", {}, win);
  await TestUtils.waitForCondition(() => win.closed, "Esc vanishes the window, as in Arc");
});

add_task(async function test_feature_off_does_nothing() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.quick-window", false]] });
  const win = WhimsyQuickWindow.open("https://example.com/");
  is(win, null, "No quick window opens with the feature off");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_shortcut_opens_an_empty_focused_window() {
  const win = WhimsyQuickWindow.open(null, { opener: window });
  await WhimsyQuickWindow.whenReady(win);
  is(win.gBrowser.selectedBrowser.currentURI.spec, "about:blank", "An empty window for the bare shortcut");
  await BrowserTestUtils.closeWindow(win);
});

// wave2: named destination, inherited theme and Arc's separate saved size.
async function readyMini(win) {
  await WhimsyQuickWindow.whenReady(win);
  await TestUtils.waitForCondition(
    () => win.document.getElementById("whimsy-quick-window-move-to-space"),
    "Mini chrome is ready"
  );
}

add_task(async function test_destination_name_and_theme_follow_the_target() {
  const original = gZenWorkspaces.getActiveWorkspace();
  let created;
  let win;
  try {
    await gZenWorkspaces.createAndSaveWorkspace("Design & café");
    created = gZenWorkspaces.getActiveWorkspace();
    created.theme = {
      type: "gradient", opacity: 0.7, texture: 0.3,
      gradientColors: [{
        c: [230, 60, 80], isPrimary: true, isCustom: false,
        position: { x: 10, y: 10 }, type: "primary", lightness: 50,
      }],
    };
    gZenThemePicker.onWorkspaceChange(created);
    win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
    await readyMini(win);
    const button = win.document.getElementById("whimsy-quick-window-move-to-space");
    await TestUtils.waitForCondition(() =>
      win.document.l10n.getAttributes(button).args?.space == created.name,
    "Fluent receives the actual destination name");
    await win.document.l10n.translateElements([button]);
    ok(button.getAttribute("label").includes(created.name), "Open in names the space, including Unicode");
    ok(button.getAttribute("label").startsWith("Open in "), "Arc's exact action label");
    for (const [id, property] of [
      ["main-window", "--zen-primary-color"],
      ["main-window", "--toolbox-textcolor"],
      ["main-window", "--toolbar-color-scheme"],
      ["main-window", "color-scheme"],
      ["zen-browser-background", "--zen-main-browser-background"],
      ["zen-toolbar-background", "--zen-main-browser-background-toolbar"],
      ["zen-browser-background", "--zen-grainy-background-opacity"],
    ]) {
      await TestUtils.waitForCondition(() =>
        win.getComputedStyle(win.document.getElementById(id)).getPropertyValue(property) ==
        getComputedStyle(document.getElementById(id)).getPropertyValue(property),
      `Mini inherits ${property}`);
    }
    created.name = "Renamed space";
    window.dispatchEvent(new CustomEvent("ZenWorkspaceDataChanged"));
    await TestUtils.waitForCondition(() =>
      win.document.l10n.getAttributes(button).args?.space == created.name,
    "Renaming the destination updates Fluent");
    await gZenWorkspaces.changeWorkspace(original);
    await TestUtils.waitForCondition(() =>
      win.document.l10n.getAttributes(button).args?.space == original.name,
    "Switching the target space updates the action");
    await TestUtils.waitForCondition(() =>
      win.getComputedStyle(win.document.documentElement).getPropertyValue("--zen-primary-color") ==
      getComputedStyle(document.documentElement).getPropertyValue("--zen-primary-color"),
    "Switching the target space updates its colors too");
    is(WhimsyQuickWindow.defaultSpaceId(win), original.uuid, "Cmd+O and the label use the same destination");
  } finally {
    if (win && !win.closed) {
      await BrowserTestUtils.closeWindow(win);
    }
    await gZenWorkspaces.changeWorkspace(original);
    if (created) {
      await gZenWorkspaces.removeWorkspace(created.uuid);
    }
  }
});

add_task(async function test_resize_is_remembered_only_for_mini() {
  const pref = "whimsy.quick-window.size";
  Services.prefs.setStringPref(pref, "");
  const normalSize = [window.outerWidth, window.outerHeight];
  let win = WhimsyQuickWindow.open("about:blank", { opener: window });
  try {
    await readyMini(win);
    const before = [win.innerWidth, win.innerHeight];
    win.resizeBy(-40, -40);
    await TestUtils.waitForCondition(() => {
      const saved = WhimsyQuickWindow.savedSize();
      return saved.width == win.innerWidth && saved.height == win.innerHeight &&
        (saved.width != before[0] || saved.height != before[1]);
    }, "The resized Mini dimensions are saved");
    const size = WhimsyQuickWindow.savedSize();
    await BrowserTestUtils.closeWindow(win);
    win = WhimsyQuickWindow.open("about:blank", { opener: window });
    await readyMini(win);
    is(win.innerWidth, size.width, "Reopened Mini restores its width");
    is(win.innerHeight, size.height, "Reopened Mini restores its height");
    is(window.outerWidth, normalSize[0], "Ordinary window width is unchanged");
    is(window.outerHeight, normalSize[1], "Ordinary window height is unchanged");
    ok(!win.document.documentElement.hasAttribute("persist"), "Shared XUL geometry stays disabled");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
  for (const value of ["invalid", "null", '{"width":-1,"height":0}', '{"width":"480","height":720}']) {
    Services.prefs.setStringPref(pref, value);
    Assert.deepEqual(WhimsyQuickWindow.savedSize(), { width: 480, height: 720 }, "Invalid saved size uses defaults");
  }
});
