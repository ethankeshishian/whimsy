/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W27: Turn Off / Turn On Page Animations (WhimsyAccessCommands). The
// command sets ui.prefersReducedMotion to 1, so pages match
// prefers-reduced-motion: reduce, and clears it again; the command bar
// names the next step, and a toast confirms each change.

const { WhimsyAccessCommands } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyAccessCommands.sys.mjs"
);
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");

const ID = "cmd_whimsyTogglePageAnimations";
const PREF = "ui.prefersReducedMotion";
const PAGE = "https://example.com/browser/";

function action(l10nId) {
  return globalActions.find(a => a.whimsyCommand == ID && a.l10nId == l10nId);
}

function available(l10nId) {
  return !!action(l10nId)?.isAvailable(window);
}

registerCleanupFunction(() => {
  Services.prefs.clearUserPref(PREF);
  closeToasts();
});

add_setup(() => {
  Services.prefs.clearUserPref(PREF);
  closeToasts();
});

add_task(function test_registered_unbound_and_named() {
  const entry = WhimsyCommands.get(ID);
  ok(entry, "The command is registered");
  is(entry?.l10nId, "whimsy-action-page-animations-toggle", "Its neutral name is for about:keyboard");
  ok(document.getElementById(ID), "It has a <command>");
  const keyEl = entry?.keyId && document.getElementById(entry.keyId);
  ok(keyEl, "It has a <key>, so a shortcut can be assigned");
  ok(!keyEl?.hasAttribute("key") && !keyEl?.hasAttribute("keycode"), "No default shortcut");
  is(action("whimsy-action-page-animations-off")?.label, "Turn Off Page Animations", "The command bar's off row");
  is(action("whimsy-action-page-animations-on")?.label, "Turn On Page Animations", "The command bar's on row");
  ok(
    action("whimsy-action-page-animations-off")?.whimsyKeywords?.includes("Reduce Motion"),
    "Found by Reduce Motion too"
  );
});

add_task(async function test_toggle_reaches_pages_and_confirms() {
  ok(available("whimsy-action-page-animations-off"), "Animations start on: Turn Off Page Animations is offered");
  ok(!available("whimsy-action-page-animations-on"), "and Turn On Page Animations isn't");

  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    document.getElementById(ID).doCommand();
    is(Services.prefs.getIntPref(PREF, 0), 1, "Turning them off sets ui.prefersReducedMotion to 1");
    ok(WhimsyAccessCommands.pageAnimationsOff(), "They read as off");
    await SpecialPowers.spawn(browser, [], async () => {
      await ContentTaskUtils.waitForCondition(
        () => content.matchMedia("(prefers-reduced-motion: reduce)").matches,
        "The page matches prefers-reduced-motion: reduce"
      );
    });
    ok(true, "The page sees reduced motion");
    await TestUtils.waitForCondition(() => toastFor("whimsy-page-animations-off-toast"), "The off toast shows");
    ok(available("whimsy-action-page-animations-on"), "Turn On Page Animations is offered next");
    ok(!available("whimsy-action-page-animations-off"), "and Turn Off Page Animations isn't");

    document.getElementById(ID).doCommand();
    ok(!Services.prefs.prefHasUserValue(PREF), "Turning them on clears the pref, so the Mac's setting applies again");
    ok(!WhimsyAccessCommands.pageAnimationsOff(), "They read as on");
    await TestUtils.waitForCondition(() => toastFor("whimsy-page-animations-on-toast"), "The on toast shows");
    ok(!toastFor("whimsy-page-animations-off-toast"), "It replaced the off toast (one at a time)");
    ok(available("whimsy-action-page-animations-off"), "Turn Off Page Animations is offered again");
  });
  closeToasts();
});

add_task(async function test_switch_off_hides_and_disarms_it() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.page-animations-command", false]] });
  ok(!available("whimsy-action-page-animations-off"), "Hidden with its switch off");
  ok(!available("whimsy-action-page-animations-on"), "Both rows hidden");
  document.getElementById(ID).doCommand();
  ok(!Services.prefs.prefHasUserValue(PREF), "Running it does nothing with its switch off");
  await SpecialPowers.popPrefEnv();
});
