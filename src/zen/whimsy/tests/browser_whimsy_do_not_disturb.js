/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/focus: Do Not Disturb. One command pauses site notifications
// (Firefox's alerts service: manualDoNotDisturb, or on the macOS backend
// suppressForScreenSharing), holds the WebRTC silencing pref so a call
// can't end the pause, puts everything back when it ends, and keeps
// Whimsy's unprompted toasts quiet meanwhile.

const { WhimsyDoNotDisturb } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyDoNotDisturb.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");

const WEBRTC_PREF = "privacy.webrtc.allowSilencingNotifications";
const RESTORE_PREF = "whimsy.dnd.restore-webrtc-silencing";
const COMMAND = "cmd_whimsyDoNotDisturb";

const service = () =>
  Cc["@mozilla.org/alerts-service;1"].getService(Ci.nsIAlertsService).QueryInterface(Ci.nsIAlertsDoNotDisturb);

// Whichever flag this backend honours.
function silenced() {
  let manual = false;
  try {
    manual = service().manualDoNotDisturb;
  } catch (e) {}
  let suppressed = false;
  try {
    suppressed = service().suppressForScreenSharing;
  } catch (e) {}
  return manual || suppressed;
}

const action = id => globalActions.find(a => a.l10nId == id);

registerCleanupFunction(() => {
  WhimsyDoNotDisturb.setPaused(false);
  Services.prefs.clearUserPref(RESTORE_PREF);
});

add_task(async function test_command() {
  const entry = WhimsyCommands.get(COMMAND);
  ok(entry?.keyId && document.getElementById(entry.keyId), "A command with an assignable shortcut");
  ok(!WhimsyDoNotDisturb.paused && !silenced(), "Off at start");
  ok(action("whimsy-action-dnd-on")?.isAvailable(window), "The command bar offers to turn it on");
  ok(!action("whimsy-action-dnd-off")?.isAvailable(window), "not off");

  document.getElementById(COMMAND).doCommand();
  ok(WhimsyDoNotDisturb.paused && WhimsyDoNotDisturb.quiet, "On");
  ok(silenced(), "Site notifications are paused in the alerts service");
  ok(action("whimsy-action-dnd-off")?.isAvailable(window), "and the command bar offers to turn it off");

  document.getElementById(COMMAND).doCommand();
  ok(!WhimsyDoNotDisturb.paused && !WhimsyDoNotDisturb.quiet && !silenced(), "Off again, everything restored");
});

add_task(async function test_webrtc_silencing_held_and_restored() {
  const before = Services.prefs.getBoolPref(WEBRTC_PREF);
  WhimsyDoNotDisturb.setPaused(true);
  let suppressPath = false;
  try {
    service().manualDoNotDisturb;
  } catch (e) {
    suppressPath = true;
  }
  if (suppressPath) {
    ok(!Services.prefs.getBoolPref(WEBRTC_PREF), "A call can't end the pause while it's on");
    ok(Services.prefs.prefHasUserValue(RESTORE_PREF), "and the old value is remembered");
  } else {
    is(Services.prefs.getBoolPref(WEBRTC_PREF), before, "The manual mode leaves WebRTC alone");
  }
  WhimsyDoNotDisturb.setPaused(false);
  is(Services.prefs.getBoolPref(WEBRTC_PREF), before, "Put back");
  ok(!Services.prefs.prefHasUserValue(RESTORE_PREF), "and forgotten");

  // A crash mid-pause: the next start puts it back.
  Services.prefs.setBoolPref(RESTORE_PREF, before);
  Services.prefs.setBoolPref(WEBRTC_PREF, !before);
  WhimsyDoNotDisturb.restoreWebRTCSilencing();
  is(Services.prefs.getBoolPref(WEBRTC_PREF), before, "Restored after a crash");
  ok(!Services.prefs.prefHasUserValue(RESTORE_PREF), "once");
});

add_task(async function test_quiet_toasts() {
  const { WhimsySeasonToast } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySeasonToast.sys.mjs");
  const seen = Services.prefs.getStringPref("whimsy.seasons.last-toast", "");
  WhimsyDoNotDisturb.setPaused(true);
  is(WhimsySeasonToast.maybeShow(window), null, "No season toast while it's on");
  is(Services.prefs.getStringPref("whimsy.seasons.last-toast", ""), seen, "and the season isn't used up");
  WhimsyDoNotDisturb.setPaused(false);
});

add_task(async function test_switch_off() {
  WhimsyDoNotDisturb.setPaused(true);
  ok(WhimsyDoNotDisturb.paused, "On");
  await SpecialPowers.pushPrefEnv({ set: [[WhimsyDoNotDisturb.FEATURE_PREF, false]] });
  await TestUtils.waitForCondition(() => !WhimsyDoNotDisturb.paused, "Turning the switch off ends the pause");
  ok(!silenced(), "and resumes notifications");
  is(WhimsyDoNotDisturb.setPaused(true), false, "It can't start while the switch is off");
  document.getElementById(COMMAND).doCommand();
  ok(!WhimsyDoNotDisturb.paused, "nor from the command");
  ok(!action("whimsy-action-dnd-on")?.isAvailable(window), "and the command bar doesn't offer it");
  await SpecialPowers.popPrefEnv();
});

add_task(function test_focus_is_macos() {
  if (AppConstants.platform != "macosx") {
    ok(!WhimsyDoNotDisturb.followsSystemFocus, "Only macOS has Focus");
    return;
  }
  ok(
    Services.prefs.getBoolPref("alerts.useSystemBackend"),
    "Site notifications go to Notification Center, so macOS Focus holds them"
  );
  ok(WhimsyDoNotDisturb.followsSystemFocus, "and Whimsy knows it");
});
