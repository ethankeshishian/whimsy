/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// fix7 settings: the command bar reaches the settings people looked for
// there: View History, Liquid Glass, Glance size and the VPN.

const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");

function action(l10nId) {
  return globalActions.find(a => a.l10nId == l10nId);
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
  action("whimsy-action-glance-size-wide").command(window);
  is(Services.prefs.getStringPref("whimsy.glance.size"), "wide", "The command sets the size");

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.glance-size", false]] });
  ok(!action("whimsy-action-glance-size-compact").isAvailable(window), "Switch off: no size commands");
  await SpecialPowers.popPrefEnv();
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
  action("whimsy-action-view-history").command(window);
  await TestUtils.waitForCondition(() => Library.isLibraryOpen, "The Library opens");
  is(Library.getInstance().activeTab, "history", "on History");
  action("whimsy-action-view-history").command(window);
  ok(Library.isLibraryOpen, "Running it again leaves History open");
  Library.toggle();
  await TestUtils.waitForCondition(() => !Library.isLibraryOpen, "Closed again");
});
