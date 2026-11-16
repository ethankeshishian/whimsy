/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W28: Keep Window on Top (Settings → Look and Feel, macOS only), the real
// native effect. A real top-level window is a HeadlessWidget under
// --headless (AppWindow.cpp: gfxPlatform::IsHeadless() swaps in
// CreateHeadlessWidget, which doesn't override nsIWidget's
// SetAlwaysOnTop/GetAlwaysOnTop), so AppWindow.alwaysOnTop can never
// observably become true in a headless run: this file needs a real,
// headed window and is skipped when headless (verify.sh's whimsy-native
// suite), the same split browser_whimsy_ctrl_tab_native.js and
// browser_whimsy_arc_menu_keys_native.js use. The pref, command and
// Settings-row model (which doesn't need the real widget) is covered
// headless in browser_whimsy_window_on_top.js.
//
// The browser.toml skip-if = ["headless"] doesn't apply here: lane.sh's
// test.sh passes this file's path straight to `./mach test`, which doesn't
// resolve it through the manifest's conditions, so a lane's headless run
// executes it anyway and every wait times out (the floating effect is
// unreachable, not broken). Each task below also checks MOZ_HEADLESS
// itself, the same way browser_whimsy_upload_targets.js does, so the file
// is a no-op headless regardless of how it was invoked.

const { WhimsyWindowOnTop } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyWindowOnTop.sys.mjs");

const ON_PREF = "whimsy.window-on-top.enabled";
const FEATURE_PREF = "whimsy.feature.window-on-top";

// Records a pass when skipping: a file with no assertions at all is a
// harness failure.
function skip() {
  if (AppConstants.platform != "macosx" || Services.env.get("MOZ_HEADLESS")) {
    ok(true, "Skipped: needs a real, headed macOS window (verify.sh's whimsy-native suite)");
    return true;
  }
  return false;
}

function nativeAlwaysOnTop(win) {
  return win.docShell.treeOwner
    .QueryInterface(Ci.nsIInterfaceRequestor)
    .getInterface(Ci.nsIAppWindow).alwaysOnTop;
}

function setPref(value) {
  Services.prefs.setBoolPref(ON_PREF, value);
}

registerCleanupFunction(async () => {
  Services.prefs.clearUserPref(ON_PREF);
  Services.prefs.clearUserPref(FEATURE_PREF);
  // Closing a BrowserTestUtils-opened window headed hits a pre-existing
  // "swapping browsers ... during close" error in Tabbrowser.sys.mjs (not
  // Whimsy's code, and not specific to alwaysOnTop) that can leave a stray
  // about:blank tab in this file's own window; close anything but the
  // original tab so the run doesn't end with an unexpected tab.
  while (window.gBrowser.tabs.length > 1) {
    await BrowserTestUtils.removeTab(window.gBrowser.tabs[1]);
  }
});

add_task(async function test_applies_to_real_window() {
  if (skip()) {
    return;
  }
  setPref(true);
  await TestUtils.waitForCondition(() => nativeAlwaysOnTop(window), "The pref floats this window");
  setPref(false);
  await TestUtils.waitForCondition(() => !nativeAlwaysOnTop(window), "Turning it off stops floating it");
});

add_task(async function test_global_not_per_window() {
  if (skip()) {
    return;
  }
  setPref(false);
  const win2 = await BrowserTestUtils.openNewBrowserWindow();
  try {
    await TestUtils.waitForCondition(() => win2._whimsyWindowOnTop, "The second window's bootstrap ran");
    is(nativeAlwaysOnTop(win2), false, "The second window starts off, same as the first");

    // The global pref, not a per-window toggle: turning it on from either
    // window floats both, unlike the design's original per-window proposal.
    setPref(true);
    await TestUtils.waitForCondition(() => nativeAlwaysOnTop(window), "First window floats");
    await TestUtils.waitForCondition(() => nativeAlwaysOnTop(win2), "Second window floats too");

    setPref(false);
    await TestUtils.waitForCondition(() => !nativeAlwaysOnTop(window), "First window stops floating");
    await TestUtils.waitForCondition(() => !nativeAlwaysOnTop(win2), "Second window stops floating too");
  } finally {
    await BrowserTestUtils.closeWindow(win2);
  }
});

add_task(async function test_persists_across_window_open_close() {
  if (skip()) {
    return;
  }
  // Closing a window must not reset the global pref (the design's original
  // per-window behavior did); a window opened afterward still picks it up.
  setPref(true);
  const win2 = await BrowserTestUtils.openNewBrowserWindow();
  try {
    await TestUtils.waitForCondition(() => nativeAlwaysOnTop(win2), "New window starts floating, since the pref is already on");
  } finally {
    await BrowserTestUtils.closeWindow(win2);
  }
  ok(Services.prefs.getBoolPref(ON_PREF), "Closing a window leaves the global pref on");

  const win3 = await BrowserTestUtils.openNewBrowserWindow();
  try {
    await TestUtils.waitForCondition(() => nativeAlwaysOnTop(win3), "A newly opened window still floats");
  } finally {
    await BrowserTestUtils.closeWindow(win3);
  }
  setPref(false);
});
