/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9: Battery Saver (Arc parity: threshold < 20%, banner, auto-off when
// charged/charging, frame rate and background throttles, command with assignable shortcut).

const { WhimsyBatterySaver } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyBatterySaver.sys.mjs"
);
const { WhimsyCommands } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyCommands.sys.mjs"
);
const { globalActions } = ChromeUtils.importESModule(
  "resource:///modules/ZenUBGlobalActions.sys.mjs"
);

const COMMAND = "cmd_whimsyToggleBatterySaver";
const action = id => globalActions.find(a => a.l10nId == id);

registerCleanupFunction(() => {
  WhimsyBatterySaver.resetBatteryForTesting();
});

add_task(async function test_command_registration() {
  const entry = WhimsyCommands.get(COMMAND);
  ok(entry, "Command is registered in WhimsyCommands");
  ok(
    entry?.keyId && document.getElementById(entry.keyId),
    "Command has a <key> element with an assignable shortcut"
  );
  ok(
    document.getElementById(COMMAND),
    "Command element exists in the window"
  );

  ok(!WhimsyBatterySaver.active, "Inactive at start");
  ok(
    action("whimsy-action-turn-on-battery-saver")?.isAvailable(window),
    "Command bar offers 'Turn On Battery Saver'"
  );
  ok(
    !action("whimsy-action-turn-off-battery-saver")?.isAvailable(window),
    "Command bar does not offer 'Turn Off Battery Saver' while inactive"
  );
});

add_task(async function test_automatic_trigger_and_banner() {
  const toasts = [];
  const origToast = window.gZenUIManager?.showToast;
  if (window.gZenUIManager) {
    window.gZenUIManager.showToast = (id, options) => {
      toasts.push({ id, options });
      return origToast?.call(window.gZenUIManager, id, options);
    };
  }

  try {
    // Battery drops to 15% while discharging -> automatic activation
    WhimsyBatterySaver.setBatteryForTesting(
      { level: 0.15, charging: false },
      window
    );

    ok(WhimsyBatterySaver.active, "Battery Saver automatically engaged at < 20%");
    is(
      Services.prefs.getIntPref("layout.frame_rate"),
      30,
      "Frame rate throttled to 30 FPS"
    );
    is(
      Services.prefs.getIntPref("dom.timeout.throttling_delay"),
      0,
      "Background timer delay set to 0"
    );

    const bannerToast = toasts.find(
      t => t.id === "whimsy-battery-saver-active-toast"
    );
    ok(bannerToast, "Heads-up toast banner shown on activation");
    is(
      bannerToast?.options?.descriptionId,
      "whimsy-battery-saver-active-toast-description",
      "Banner toast includes description"
    );
  } finally {
    if (origToast) {
      window.gZenUIManager.showToast = origToast;
    }
    WhimsyBatterySaver.resetBatteryForTesting();
  }
});

add_task(async function test_auto_off_when_charging_or_charged() {
  // Activate below 20%
  WhimsyBatterySaver.setBatteryForTesting(
    { level: 0.12, charging: false },
    window
  );
  ok(WhimsyBatterySaver.active, "Active at 12%");

  // Plugged in (charging: true) -> auto-off
  WhimsyBatterySaver.setBatteryForTesting(
    { level: 0.12, charging: true },
    window
  );
  ok(!WhimsyBatterySaver.active, "Automatically disengaged when plugged in");
  ok(
    !Services.prefs.prefHasUserValue("layout.frame_rate"),
    "layout.frame_rate restored to default"
  );
  ok(
    !Services.prefs.prefHasUserValue("dom.timeout.throttling_delay"),
    "dom.timeout.throttling_delay restored to default"
  );

  // Unplugged again above 20% -> stays inactive
  WhimsyBatterySaver.setBatteryForTesting(
    { level: 0.50, charging: false },
    window
  );
  ok(!WhimsyBatterySaver.active, "Remains inactive at 50% battery");
});

add_task(async function test_manual_toggle_command() {
  ok(!WhimsyBatterySaver.active, "Inactive initially");

  // Run command to toggle ON
  document.getElementById(COMMAND).doCommand();
  ok(WhimsyBatterySaver.active, "Command toggles Battery Saver ON");
  is(
    Services.prefs.getIntPref("layout.frame_rate"),
    30,
    "layout.frame_rate throttled"
  );
  ok(
    action("whimsy-action-turn-off-battery-saver")?.isAvailable(window),
    "Command bar variant updates to 'Turn Off'"
  );

  // Run command to toggle OFF
  document.getElementById(COMMAND).doCommand();
  ok(!WhimsyBatterySaver.active, "Command toggles Battery Saver OFF");
  ok(
    !Services.prefs.prefHasUserValue("layout.frame_rate"),
    "layout.frame_rate restored"
  );
});

add_task(async function test_custom_user_pref_preserved() {
  // If user had a custom frame rate configured (e.g. 120 FPS)
  await SpecialPowers.pushPrefEnv({
    set: [
      ["layout.frame_rate", 120],
      ["dom.timeout.throttling_delay", 15000],
    ],
  });

  WhimsyBatterySaver.activate({ reason: "manual", win: window });
  is(
    Services.prefs.getIntPref("layout.frame_rate"),
    30,
    "Throttled to 30 while active"
  );

  WhimsyBatterySaver.deactivate({ reason: "manual", win: window });
  is(
    Services.prefs.getIntPref("layout.frame_rate"),
    120,
    "Custom 120 FPS setting restored"
  );
  is(
    Services.prefs.getIntPref("dom.timeout.throttling_delay"),
    15000,
    "Custom 15000ms delay restored"
  );
});

add_task(async function test_feature_switch_disables() {
  WhimsyBatterySaver.activate({ reason: "manual", win: window });
  ok(WhimsyBatterySaver.active, "Active before switch");

  // Disable feature switch
  await SpecialPowers.pushPrefEnv({
    set: [[WhimsyBatterySaver.FEATURE_PREF, false]],
  });
  await TestUtils.waitForCondition(
    () => !WhimsyBatterySaver.active,
    "Disabling feature switch turns Battery Saver off"
  );
  ok(
    !Services.prefs.prefHasUserValue("layout.frame_rate"),
    "Throttles restored when feature disabled"
  );

  // Attempting to activate while switch is off does nothing
  is(
    WhimsyBatterySaver.activate({ reason: "manual", win: window }),
    false,
    "Cannot activate while feature is disabled"
  );
});
