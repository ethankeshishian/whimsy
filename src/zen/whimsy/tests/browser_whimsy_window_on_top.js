/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W28: Keep Window on Top (Settings → Look and Feel, macOS only). The
// design (float-on-top.md) proposed a per-window, session-only toggle; the
// owner's sign-off overrode that with "Need for mini whimsy as a global
// setting. Generally the user only has one window open." So one pref
// (whimsy.window-on-top.enabled) applies to every open Whimsy window,
// including Mini Whimsy, and persists across restarts: this file covers the
// global semantics, not the design's original per-window assumptions
// (a second window was unaffected; closing a window forgot it).

const { WhimsyWindowOnTop } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyWindowOnTop.sys.mjs");
const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");

const ON_PREF = "whimsy.window-on-top.enabled";
const FEATURE_PREF = "whimsy.feature.window-on-top";

function action(l10nId) {
  return globalActions.find(a => a.l10nId == l10nId);
}

function nativeAlwaysOnTop(win) {
  return win.docShell.treeOwner
    .QueryInterface(Ci.nsIInterfaceRequestor)
    .getInterface(Ci.nsIAppWindow).alwaysOnTop;
}

function setPref(value) {
  Services.prefs.setBoolPref(ON_PREF, value);
}

registerCleanupFunction(() => {
  Services.prefs.clearUserPref(ON_PREF);
  Services.prefs.clearUserPref(FEATURE_PREF);
});

add_task(async function test_off_by_default() {
  is(Services.prefs.getBoolPref(ON_PREF), false, "Keep Window on Top is off by default");
  ok(Services.prefs.getBoolPref(FEATURE_PREF), "The feature switch is on");
  if (AppConstants.platform != "macosx") {
    ok(!WhimsyWindowOnTop.enabled, "Not on a platform that isn't macOS");
    return;
  }
  ok(WhimsyWindowOnTop.enabled, "Enabled on macOS");
  ok(!WhimsyWindowOnTop.on, "Off to start");
  is(nativeAlwaysOnTop(window), false, "The real window isn't floating");
});

add_task(async function test_command_registered() {
  const cmd = document.getElementById("cmd_whimsyKeepWindowOnTop");
  ok(cmd, "cmd_whimsyKeepWindowOnTop is registered");
  const on = action("whimsy-action-window-on-top-on");
  const off = action("whimsy-action-window-on-top-off");
  ok(on && off, "Both variants are in the command bar");
  if (AppConstants.platform != "macosx") {
    ok(!on.isAvailable(window) && !off.isAvailable(window), "Unavailable outside macOS");
    return;
  }
  setPref(false);
  ok(on.isAvailable(window) && !off.isAvailable(window), "Off: 'Keep Window on Top' is offered");
  is(on.label, "Keep Window on Top", "Title Case command name");
  on.command(window);
  ok(Services.prefs.getBoolPref(ON_PREF), "Running it turns the pref on");
  ok(off.isAvailable(window) && !on.isAvailable(window), "On: 'Stop Keeping Window on Top' is offered");
  is(off.label, "Stop Keeping Window on Top", "Title Case command name");
  off.command(window);
  ok(!Services.prefs.getBoolPref(ON_PREF), "Running it turns the pref off");

  await SpecialPowers.pushPrefEnv({ set: [[FEATURE_PREF, false]] });
  ok(!on.isAvailable(window) && !off.isAvailable(window), "Switch off: neither variant is offered");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_applies_to_real_window() {
  if (AppConstants.platform != "macosx") {
    return;
  }
  setPref(true);
  await TestUtils.waitForCondition(() => nativeAlwaysOnTop(window), "The pref floats this window");
  setPref(false);
  await TestUtils.waitForCondition(() => !nativeAlwaysOnTop(window), "Turning it off stops floating it");
});

add_task(async function test_global_not_per_window() {
  if (AppConstants.platform != "macosx") {
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
  if (AppConstants.platform != "macosx") {
    return;
  }
  // Closing a window must not reset the global pref (the design's original
  // per-window behavior did); a window opened afterward still picks it up.
  setPref(true);
  const win2 = await BrowserTestUtils.openNewBrowserWindow();
  await TestUtils.waitForCondition(() => nativeAlwaysOnTop(win2), "New window starts floating, since the pref is already on");
  await BrowserTestUtils.closeWindow(win2);
  ok(Services.prefs.getBoolPref(ON_PREF), "Closing a window leaves the global pref on");

  const win3 = await BrowserTestUtils.openNewBrowserWindow();
  try {
    await TestUtils.waitForCondition(() => nativeAlwaysOnTop(win3), "A newly opened window still floats");
  } finally {
    await BrowserTestUtils.closeWindow(win3);
  }
  setPref(false);
});

add_task(async function test_full_screen_unavailable() {
  // Full screen can't float (Cocoa), so the command is unavailable there,
  // and apply() must drop the native bit without touching the pref itself
  // (restored once the window leaves full screen). A fake window avoids an
  // actual, slow OS-level full-screen transition in the test window.
  const fakeAppWindow = { alwaysOnTop: false };
  const fakeWin = {
    fullScreen: false,
    docShell: {
      treeOwner: {
        QueryInterface() {
          return this;
        },
        getInterface() {
          return fakeAppWindow;
        },
      },
    },
  };

  if (AppConstants.platform != "macosx") {
    ok(!WhimsyWindowOnTop.isAvailable(fakeWin), "Disabled outside macOS even when not full screen");
    return;
  }

  setPref(true);
  WhimsyWindowOnTop.apply(fakeWin);
  ok(fakeAppWindow.alwaysOnTop, "Floats when not full screen");
  ok(WhimsyWindowOnTop.isAvailable(fakeWin), "Command available outside full screen");

  fakeWin.fullScreen = true;
  WhimsyWindowOnTop.apply(fakeWin);
  ok(!fakeAppWindow.alwaysOnTop, "Full screen drops the native bit");
  ok(!WhimsyWindowOnTop.isAvailable(fakeWin), "Command unavailable in full screen");
  ok(Services.prefs.getBoolPref(ON_PREF), "The pref itself is untouched by entering full screen");

  fakeWin.fullScreen = false;
  WhimsyWindowOnTop.apply(fakeWin);
  ok(fakeAppWindow.alwaysOnTop, "Leaving full screen restores floating, since the pref never changed");

  setPref(false);
});

add_task(async function test_settings_checkbox() {
  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.getElementById("whimsyDimInactiveWindow"), "Look and Feel is ready");
    const checkbox = doc.getElementById("whimsyWindowOnTop");
    if (AppConstants.platform != "macosx") {
      ok(!checkbox, "No Keep Window on Top setting outside macOS");
      return;
    }
    ok(checkbox, "Settings → Look and Feel has Keep Window on Top");
    ok(!checkbox.checked, "Unchecked by default");
    await TestUtils.waitForCondition(() => checkbox.label, "It has its label");
    is(checkbox.label, "Keep Window on Top", "Its label");

    checkbox.click();
    await TestUtils.waitForCondition(() => Services.prefs.getBoolPref(ON_PREF), "Checking it sets the pref");
    checkbox.click();
    await TestUtils.waitForCondition(() => !Services.prefs.getBoolPref(ON_PREF), "Unchecking clears it");
  });
  Services.prefs.clearUserPref(ON_PREF);
});

add_task(async function test_settings_hidden_with_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE_PREF, false]] });
  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.getElementById("whimsyDimInactiveWindow"));
    ok(!doc.getElementById("whimsyWindowOnTop"), "The feature switch removes the setting");
  });
  await SpecialPowers.popPrefEnv();
});

// Settings search for this row's label, short name and keywords is covered
// generically, for every SETTINGS entry including this one, by
// browser_whimsy_settings_audit.js's test_every_setting_is_found_by_search.
