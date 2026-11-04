/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// fix7 settings: the command bar reaches the settings people looked for
// there: View History, Liquid Glass, Glance size and the VPN.

const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");
const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");

function action(l10nId) {
  return globalActions.find(a => a.l10nId == l10nId);
}

// A row runs its own function or the registered <command>.
function run(row) {
  if (typeof row.command == "function") {
    row.command(window);
  } else {
    document.getElementById(row.command).doCommand();
  }
}

add_task(async function test_registered_with_labels() {
  for (const id of [
    "whimsy-action-view-history",
    "whimsy-action-liquid-glass-on",
    "whimsy-action-liquid-glass-off",
    "whimsy-action-glance-size-compact",
    "whimsy-action-glance-size-standard",
    "whimsy-action-glance-size-wide",
    "whimsy-action-vpn-on",
    "whimsy-action-vpn-off",
    "whimsy-action-vpn-setup",
  ]) {
    ok(action(id), `${id} is registered`);
    ok(action(id).label, `${id} has a label (${action(id).label})`);
  }
  // Exactly one VPN action applies in any state, so "vpn" always finds one.
  const vpn = ["whimsy-action-vpn-on", "whimsy-action-vpn-off", "whimsy-action-vpn-setup"];
  is(vpn.filter(id => action(id).isAvailable(window)).length, 1, "One VPN action is offered");
});

add_task(async function test_glance_size() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.glance.size", "standard"]] });
  ok(!action("whimsy-action-glance-size-standard").isAvailable(window), "The current size isn't offered");
  ok(action("whimsy-action-glance-size-wide").isAvailable(window), "Other sizes are");
  run(action("whimsy-action-glance-size-wide"));
  is(Services.prefs.getStringPref("whimsy.glance.size"), "wide", "The command sets the size");

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.glance-size", false]] });
  ok(!action("whimsy-action-glance-size-compact").isAvailable(window), "Switch off: no size commands");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});

// wave9/menus (design-full-4 M12): View History and Glance size can be given
// a shortcut (about:keyboard lists them), and Change Glance Size cycles.
add_task(async function test_assignable() {
  const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
  for (const id of ["cmd_whimsyViewHistory", "cmd_whimsyGlanceSize"]) {
    const entry = WhimsyCommands.get(id);
    const keyEl = entry?.keyId && document.getElementById(entry.keyId);
    ok(keyEl, `${id} has a <key> about:keyboard lists`);
    ok(!keyEl?.hasAttribute("key") && !keyEl?.hasAttribute("keycode"), `${id} has no default shortcut`);
  }
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.glance.size", "compact"]] });
  const cmd = document.getElementById("cmd_whimsyGlanceSize");
  cmd.doCommand();
  is(Services.prefs.getStringPref("whimsy.glance.size"), "standard", "Compact → Standard");
  cmd.doCommand();
  is(Services.prefs.getStringPref("whimsy.glance.size"), "wide", "Standard → Wide");
  cmd.doCommand();
  is(Services.prefs.getStringPref("whimsy.glance.size"), "compact", "Wide → Compact");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_liquid_glass() {
  const cmd = document.getElementById("cmd_whimsyLiquidGlassToggle");
  ok(cmd, "cmd_whimsyLiquidGlassToggle is registered");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.look.liquid-glass", false]] });
  const on = action("whimsy-action-liquid-glass-on");
  const off = action("whimsy-action-liquid-glass-off");
  if (AppConstants.platform != "macosx") {
    ok(!on.isAvailable(window) && !off.isAvailable(window), "No Liquid Glass outside macOS");
  } else {
    ok(on.isAvailable(window) && !off.isAvailable(window), "Off: Turn On is offered");
    on.command(window);
    ok(Services.prefs.getBoolPref("whimsy.look.liquid-glass"), "and turns it on");
    ok(off.isAvailable(window) && !on.isAvailable(window), "On: Turn Off is offered");
    off.command(window);
    ok(!Services.prefs.getBoolPref("whimsy.look.liquid-glass"), "and turns it off");
  }
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.liquid-glass", false]] });
  ok(!on.isAvailable(window), "Switch off: no Liquid Glass commands");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_view_history() {
  const Library = customElements.get("zen-library");
  if (!Library || !Services.prefs.getBoolPref("zen.library.enabled", false)) {
    ok(action("whimsy-action-view-history").isAvailable(window), "Available without Zen's Library too");
    return;
  }
  run(action("whimsy-action-view-history"));
  await TestUtils.waitForCondition(() => Library.isLibraryOpen, "The Library opens");
  is(Library.getInstance().activeTab, "history", "on History");
  run(action("whimsy-action-view-history"));
  ok(Library.isLibraryOpen, "Running it again leaves History open");
  Library.toggle();
  await TestUtils.waitForCondition(() => !Library.isLibraryOpen, "Closed again");
});

// W13-B6: Settings → Home and startup, and Go Home: both are commands with
// an assignable shortcut, and the settings one opens the right pane.
add_task(async function test_open_home_settings_command() {
  const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
  const entry = WhimsyCommands.get("cmd_whimsyOpenHomeSettings");
  ok(entry, "cmd_whimsyOpenHomeSettings is registered");
  const keyEl = document.getElementById(entry.keyId ?? entry.elsewhere);
  ok(keyEl, "and has a <key>, so a shortcut can be assigned");
  const row = action("whimsy-action-open-home-settings");
  ok(row?.label, `and is in the command bar ("${row?.label}")`);

  const original = window.openPreferences;
  let openedWith = null;
  window.openPreferences = pane => {
    openedWith = pane;
  };
  try {
    document.getElementById("cmd_whimsyOpenHomeSettings").doCommand();
  } finally {
    window.openPreferences = original;
  }
  is(openedWith, "paneHome", "Running it opens Settings on the Home and startup pane");
});

// W14 21.3: Go Home goes to the home page, from an assigned shortcut and
// from the command bar row.
add_task(async function test_go_home_command() {
  const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
  const { CustomKeys } = ChromeUtils.importESModule("moz-src:///browser/components/customkeys/CustomKeys.sys.mjs");
  const home = "https://example.com/?whimsy-home";
  await SpecialPowers.pushPrefEnv({ set: [["browser.startup.homepage", home]] });
  const entry = WhimsyCommands.get("cmd_whimsyGoHome");
  ok(entry, "Go Home is registered as a Whimsy command");
  ok(document.getElementById("cmd_whimsyGoHome"), "...with a <command> to run");
  const keyEl = document.getElementById(entry.keyId);
  ok(keyEl, "and has a <key>, so a shortcut can be assigned");
  is(keyEl.getAttribute("command"), "cmd_whimsyGoHome", "The key runs that command");

  const result = WhimsyCommands.rebind("cmd_whimsyGoHome", { modifiers: "accel,alt,shift", key: "Y" });
  ok(result.ok, "A shortcut is assigned");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  let loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, home);
  await SimpleTest.promiseFocus(window);
  EventUtils.synthesizeKey("y", { accelKey: true, altKey: true, shiftKey: true });
  await loaded;
  is(tab.linkedBrowser.currentURI.spec, home, "The shortcut goes to the home page");
  CustomKeys.resetKey(entry.keyId);

  const row = action("whimsy-action-go-home");
  ok(row?.label, `and is in the command bar ("${row?.label}")`);
  is(row.command, "cmd_whimsyGoHome", "The row runs Go Home");
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, "https://example.org/");
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, "https://example.org/");
  loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, home);
  gURLBar.blur();
  await SimpleTest.promiseFocus(window);
  document.getElementById("Browser:OpenLocation").doCommand();
  await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, waitForFocus: SimpleTest.waitForFocus, value: row.label });
  let index = -1;
  for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
    const { result } = await UrlbarTestUtils.getRowAt(window, i);
    if (result.payload.zenCommand == "cmd_whimsyGoHome") {
      index = i;
      break;
    }
  }
  Assert.greaterOrEqual(index, 0, "Typing its name offers Go Home");
  UrlbarTestUtils.setSelectedRowIndex(window, index);
  EventUtils.synthesizeKey("KEY_Enter");
  await loaded;
  is(tab.linkedBrowser.currentURI.spec, home, "The command bar row goes to the home page");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
