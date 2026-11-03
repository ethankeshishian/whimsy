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
const LOW = { level: 0.15, charging: false };

function toastId() {
  return currentToast()?.messageId ?? null;
}

function clearToast() {
  closeToasts();
}

function reset() {
  clearToast();
  WhimsyBatterySaver.resetBatteryForTesting();
}
const action = id => globalActions.find(a => a.l10nId == id);

registerCleanupFunction(reset);

// test_settings_switch_is_reachable and test_settings_search_finds_battery_saver
// open about:preferences, which makes Firefox's own FxAccounts code compute
// and cache a device name the first time anything reads it. Nothing here
// cares about Sync, so just restore whatever this pref held before.
const HAD_DEVICE_NAME = Services.prefs.prefHasUserValue("identity.fxaccounts.account.device.name");
registerCleanupFunction(() => {
  if (!HAD_DEVICE_NAME) {
    Services.prefs.clearUserPref("identity.fxaccounts.account.device.name");
  }
});

add_task(async function test_command_registration() {
  const entry = WhimsyCommands.get(COMMAND);
  ok(entry, "Command is registered in WhimsyCommands");
  ok(entry?.keyId && document.getElementById(entry.keyId), "Command has a <key>, so a shortcut can be assigned");
  ok(!entry?.defaultKey, "No default shortcut (assignable in about:keyboard)");
  ok(document.getElementById(COMMAND), "Command element exists in the window");

  ok(!WhimsyBatterySaver.active, "Inactive at start");
  ok(action("whimsy-action-turn-on-battery-saver")?.isAvailable(window), "Command bar offers 'Turn Battery Saver On'");
  ok(
    !action("whimsy-action-turn-off-battery-saver")?.isAvailable(window),
    "Command bar does not offer 'Turn Battery Saver Off' while inactive"
  );
  for (const id of [
    "whimsy-action-toggle-battery-saver",
    "whimsy-action-turn-on-battery-saver",
    "whimsy-action-turn-off-battery-saver",
    "whimsy-battery-saver-active-toast",
    "whimsy-battery-saver-turn-off-button",
  ]) {
    ok(await document.l10n.formatValue(id), `${id} is localized`);
  }
});

add_task(async function test_automatic_trigger_and_banner() {
  try {
    WhimsyBatterySaver.setBatteryForTesting(LOW, window);
    ok(WhimsyBatterySaver.active, "Battery Saver engages below 20% while discharging");
    is(Services.prefs.getIntPref("layout.frame_rate"), 30, "Frame rate capped at 30 fps");
    const delay = Services.prefs.getIntPref("dom.timeout.throttling_delay");
    ok(
      delay > 0 && delay < 30000,
      "Background timers throttle soon after load (> 0: Gecko reads 0 as never throttle)"
    );
    is(gBrowser.tabs.filter(t => t.hasAttribute("pending")).length, 0, "No tab was unloaded");

    is(toastId(), "whimsy-battery-saver-active-toast", "Heads-up toast shown on activation");
    const button = currentToast().element.querySelector(".whimsy-toast-button");
    ok(button, "The heads-up offers Turn Off");

    // Turn Off from the toast: stays off while still low...
    button.click();
    ok(!WhimsyBatterySaver.active, "Turn Off in the heads-up turns it off");
    WhimsyBatterySaver.setBatteryForTesting({ level: 0.14, charging: false }, window);
    ok(!WhimsyBatterySaver.active, "Stays off as the battery keeps draining");
    // ...until the next time it is charged and runs low again.
    WhimsyBatterySaver.setBatteryForTesting({ level: 0.14, charging: true }, window);
    WhimsyBatterySaver.setBatteryForTesting({ level: 0.13, charging: false }, window);
    ok(WhimsyBatterySaver.active, "Runs again after a charge, the next time the battery is low");
  } finally {
    reset();
  }
});

add_task(async function test_auto_off_when_charging_or_charged() {
  WhimsyBatterySaver.setBatteryForTesting({ level: 0.12, charging: false }, window);
  ok(WhimsyBatterySaver.active, "Active at 12%");

  WhimsyBatterySaver.setBatteryForTesting({ level: 0.12, charging: true }, window);
  ok(!WhimsyBatterySaver.active, "Automatically off when plugged in");
  ok(!Services.prefs.prefHasUserValue("layout.frame_rate"), "layout.frame_rate restored to default");
  ok(!Services.prefs.prefHasUserValue("dom.timeout.throttling_delay"), "dom.timeout.throttling_delay restored to default");

  WhimsyBatterySaver.setBatteryForTesting({ level: 0.12, charging: false }, window);
  ok(WhimsyBatterySaver.active, "On again when unplugged while low");
  WhimsyBatterySaver.setBatteryForTesting({ level: 0.25, charging: false }, window);
  ok(!WhimsyBatterySaver.active, "Automatically off once back above 20%");
  WhimsyBatterySaver.setBatteryForTesting({ level: 0.5, charging: false }, window);
  ok(!WhimsyBatterySaver.active, "Remains off at 50%");
  reset();
});

add_task(async function test_manual_on_sticks_while_charging() {
  // Review M4: turning it on by hand while plugged in must not be undone by
  // the next levelchange/chargingchange.
  WhimsyBatterySaver.setBatteryForTesting({ level: 0.8, charging: true }, window);
  ok(!WhimsyBatterySaver.active, "Off while charging");

  document.getElementById(COMMAND).doCommand();
  ok(WhimsyBatterySaver.active, "Command turns it on while charging");
  is(Services.prefs.getIntPref("layout.frame_rate"), 30, "layout.frame_rate throttled");
  is(toastId(), "whimsy-battery-saver-on-toast", "A toast confirms it");
  ok(action("whimsy-action-turn-off-battery-saver")?.isAvailable(window), "Command bar now offers Turn Off");

  WhimsyBatterySaver.setBatteryForTesting({ level: 0.81, charging: true }, window);
  ok(WhimsyBatterySaver.active, "Still on after the next levelchange while charging");
  WhimsyBatterySaver.setBatteryForTesting({ level: 0.81, charging: false }, window);
  WhimsyBatterySaver.setBatteryForTesting({ level: 0.6, charging: false }, window);
  ok(WhimsyBatterySaver.active, "Still on after unplugging above 20%");

  document.getElementById(COMMAND).doCommand();
  ok(!WhimsyBatterySaver.active, "Command turns it off");
  is(toastId(), "whimsy-battery-saver-off-toast", "A toast confirms it");
  ok(!Services.prefs.prefHasUserValue("layout.frame_rate"), "layout.frame_rate restored");
  WhimsyBatterySaver.setBatteryForTesting({ level: 0.6, charging: true }, window);
  ok(!WhimsyBatterySaver.active, "Stays off");
  reset();
});

add_task(async function test_automatic_setting_off() {
  await SpecialPowers.pushPrefEnv({ set: [[WhimsyBatterySaver.ENABLED_PREF, false]] });
  WhimsyBatterySaver.setBatteryForTesting(LOW, window);
  ok(!WhimsyBatterySaver.active, "With the automatic setting off, a low battery doesn't turn it on");
  ok(action("whimsy-action-turn-on-battery-saver")?.isAvailable(window), "The command is still offered");
  document.getElementById(COMMAND).doCommand();
  ok(WhimsyBatterySaver.active, "The command still turns it on by hand");
  await SpecialPowers.popPrefEnv();
  ok(WhimsyBatterySaver.active, "A manual session survives the setting changing");
  reset();
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
  await SpecialPowers.popPrefEnv();
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
  ok(
    !action("whimsy-action-turn-on-battery-saver")?.isAvailable(window),
    "The command bar stops offering it while the feature is off"
  );
  await SpecialPowers.popPrefEnv();
  reset();
});

// Review design-full-5 H2 / design-full-4 H2: the switch must be reachable,
// labelled, and found by Settings search.
function shown(el) {
  for (let node = el; node && node.id != "mainPrefPane"; node = node.parentElement) {
    if (node.hidden) {
      return false;
    }
  }
  return !!el?.isConnected && el.checkVisibility();
}

add_task(async function test_settings_switch_is_reachable() {
  await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
    const win = browser.contentWindow;
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(
      () => doc.querySelector('[groupid="performance"]') && doc.getElementById("whimsyBatterySaverGroup"),
      "Battery Saver group is inserted"
    );
    const group = doc.getElementById("whimsyBatterySaverGroup");
    const perfPane = doc.querySelector('[groupid="performance"]').getAttribute("data-category");
    is(group.dataset.category, perfPane, "Battery Saver sits in the same pane as Performance");
    if (Services.prefs.getBoolPref("browser.settings-redesign.enabled", false)) {
      is(group.dataset.category, "paneZenTabManagement", "which is Tab Management with the settings redesign");
    }
    await TestUtils.waitForCondition(() => shown(group), "Battery Saver group is visible");
    const prev = group.previousElementSibling;
    ok(
      prev?.id == "whimsyPerformanceGroup" || prev?.getAttribute("groupid") == "performance",
      "It follows the Performance group"
    );

    const checkbox = doc.getElementById("whimsyBatterySaverEnabled");
    await TestUtils.waitForCondition(() => checkbox.label?.includes("20%"), "The checkbox has a label");
    // design-full-4 H2: a message with a value instead of .label makes Fluent
    // replace the checkbox's own children (its box and label) with text.
    ok(checkbox.hasAttribute("label"), "The message sets the label attribute");
    ok(checkbox.querySelector(".checkbox-check"), "…and leaves the checkbox's own children in place");
    ok(checkbox.checked, "On by default");

    const pref = WhimsyBatterySaver.ENABLED_PREF;
    registerCleanupFunction(() => Services.prefs.clearUserPref(pref));
    checkbox.click();
    await TestUtils.waitForCondition(() => !Services.prefs.getBoolPref(pref), "Unchecking turns the automatic mode off");
    checkbox.click();
    await TestUtils.waitForCondition(() => Services.prefs.getBoolPref(pref), "Checking turns it back on");
    is(win.gLastCategory.category, "paneZenTabManagement", "Still on Tab Management");
  });
});

add_task(async function test_settings_search_finds_battery_saver() {
  await BrowserTestUtils.withNewTab("about:preferences#privacy", async browser => {
    const win = browser.contentWindow;
    const doc = browser.contentDocument;
    await win.gSearchResultsPane.initializeCategories();
    const input = doc.getElementById("searchInput");
    input.value = "battery";
    input.dispatchEvent(new win.InputEvent("input", { bubbles: true }));
    await TestUtils.waitForCondition(
      () => shown(doc.getElementById("whimsyBatterySaverEnabled")),
      'Searching "battery" shows the Battery Saver switch'
    );
    is(doc.querySelectorAll("#whimsyBatterySaverGroup").length, 1, "One Battery Saver group");
    input.value = "";
    input.dispatchEvent(new win.InputEvent("input", { bubbles: true }));
  });
});
