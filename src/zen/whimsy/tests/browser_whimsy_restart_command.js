/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W27: Restart Whimsy (WhimsyAccessCommands). A command-bar command that
// asks for a "restart" quit, as about:profiles does, and quits with
// eAttemptQuit | eRestart unless something cancels. The real quit is
// replaced, so the test browser stays up.

const { WhimsyAccessCommands } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyAccessCommands.sys.mjs"
);
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");

const ID = "cmd_whimsyRestart";
const NAME = "whimsy-action-restart";

function action() {
  return globalActions.find(a => a.whimsyCommand == ID && a.l10nId == NAME);
}

// Replaces the real quit for one task; returns the flags each call got.
function stubQuit() {
  const calls = [];
  const original = WhimsyAccessCommands.startupQuit;
  WhimsyAccessCommands.startupQuit = flags => calls.push(flags);
  registerCleanupFunction(() => {
    WhimsyAccessCommands.startupQuit = original;
  });
  return { calls, restore: () => (WhimsyAccessCommands.startupQuit = original) };
}

// Watches quit-application-requested; `cancel` sets the subject's data.
function watchQuitRequests(cancel) {
  const seen = [];
  const observer = (subject, topic, data) => {
    seen.push(data);
    if (cancel) {
      subject.QueryInterface(Ci.nsISupportsPRBool).data = true;
    }
  };
  Services.obs.addObserver(observer, "quit-application-requested");
  const stop = () => {
    try {
      Services.obs.removeObserver(observer, "quit-application-requested");
    } catch (e) {}
  };
  registerCleanupFunction(stop);
  return { seen, stop };
}

add_task(function test_registered_unbound_and_listed() {
  const entry = WhimsyCommands.get(ID);
  ok(entry, "cmd_whimsyRestart is registered");
  is(entry?.l10nId, NAME, "Named from whimsy-action-restart");
  is(WhimsyCommands.title(entry), "Restart Whimsy", "The command bar calls it Restart Whimsy");
  ok(document.getElementById(ID), "It has a <command>");
  const keyEl = entry?.keyId && document.getElementById(entry.keyId);
  ok(keyEl, "It has a <key>, so a shortcut can be assigned in about:keyboard");
  ok(!keyEl?.hasAttribute("key") && !keyEl?.hasAttribute("keycode"), "No default shortcut");
  ok(action(), "The command bar lists it");
  ok(action()?.isAvailable(window), "Available while its switch is on");
  ok(action()?.whimsyKeywords?.includes("Relaunch"), "Found by Relaunch too");
});

add_task(async function test_switch_off_hides_and_disarms_it() {
  const quit = stubQuit();
  const requests = watchQuitRequests(true);
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.restart-command", false]] });
  ok(!action()?.isAvailable(window), "Hidden from the command bar with its switch off");
  document.getElementById(ID).doCommand();
  is(requests.seen.length, 0, "No quit is asked for with the switch off");
  is(quit.calls.length, 0, "Nothing quits with the switch off");
  await SpecialPowers.popPrefEnv();
  requests.stop();
  quit.restore();
});

add_task(function test_a_cancelled_request_keeps_the_browser_open() {
  const quit = stubQuit();
  const requests = watchQuitRequests(true);
  document.getElementById(ID).doCommand();
  Assert.deepEqual(requests.seen, ["restart"], "Asks once, as a restart");
  is(quit.calls.length, 0, "A listener that cancels keeps the browser open");
  ok(!WhimsyAccessCommands.restart(), "restart() reports that it didn't go ahead");
  requests.stop();
  quit.restore();
});

add_task(function test_restart_quits_with_restart_flags() {
  const quit = stubQuit();
  const requests = watchQuitRequests(false);
  document.getElementById(ID).doCommand();
  Assert.deepEqual(requests.seen, ["restart"], "Asks first, as a restart");
  is(quit.calls.length, 1, "Then quits once");
  is(
    quit.calls[0],
    Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart,
    "With eAttemptQuit | eRestart, so the session store resumes the session once"
  );
  requests.stop();
  quit.restore();
});
