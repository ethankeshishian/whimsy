/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// batch10: View Page Source line wrap option + command (W10-34).
// Option in Settings (Tab Management -> On-demand features) controlling
// view_source.wrap_long_lines, and an assignable command in WhimsyCommands.

const { WhimsyAccessCommands } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyAccessCommands.sys.mjs"
);
const { WhimsyCommands } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyCommands.sys.mjs"
);

const COMMAND_ID = "cmd_whimsyToggleViewSourceWrap";
const PREF_NAME = "view_source.wrap_long_lines";
const FEATURE_PREF = "whimsy.feature.view-source-wrap";

add_task(async function test_view_source_wrap_command_registered() {
  const entry = WhimsyCommands.get(COMMAND_ID);
  ok(entry, `${COMMAND_ID} is registered in WhimsyCommands`);
  is(entry?.l10nId, "whimsy-action-view-source-wrap-toggle", "Command has expected l10nId");
  ok(WhimsyCommands.title(entry), `${COMMAND_ID} has a localized title`);

  const cmdEl = document.getElementById(COMMAND_ID);
  ok(cmdEl, `${COMMAND_ID} has a <command> element in the window`);

  const keyEl = entry?.keyId && document.getElementById(entry.keyId);
  ok(keyEl, `${COMMAND_ID} has a <key> in Whimsy's keyset for shortcut assignment`);
  is(keyEl?.parentElement?.id, "whimsyKeyset", "Key belongs to whimsyKeyset");

  is(WhimsyCommands.menuOf(COMMAND_ID), "view-menu", "Command belongs to view-menu for cheat sheet");
});

add_task(async function test_view_source_wrap_toggle_execution() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [FEATURE_PREF, true],
      [PREF_NAME, false],
    ],
  });

  const entry = WhimsyCommands.get(COMMAND_ID);
  const onVariant = entry?.variants?.find(v => v.l10nId == "whimsy-action-view-source-wrap-on");
  const offVariant = entry?.variants?.find(v => v.l10nId == "whimsy-action-view-source-wrap-off");

  ok(onVariant, "Has 'on' variant");
  ok(offVariant, "Has 'off' variant");

  ok(onVariant.isAvailable(window), "When line wrap is off, 'on' variant is available");
  ok(!offVariant.isAvailable(window), "When line wrap is off, 'off' variant is not available");

  // Run the command
  const cmdEl = document.getElementById(COMMAND_ID);
  cmdEl.doCommand();

  is(Services.prefs.getBoolPref(PREF_NAME), true, "Running command enabled wrap_long_lines");
  ok(!onVariant.isAvailable(window), "When line wrap is on, 'on' variant is not available");
  ok(offVariant.isAvailable(window), "When line wrap is on, 'off' variant is available");

  // Run again to toggle back off
  cmdEl.doCommand();
  is(Services.prefs.getBoolPref(PREF_NAME), false, "Running command again disabled wrap_long_lines");
});

add_task(async function test_view_source_wrap_settings_option() {
  const tabsTemplate = document.getElementById("template-whimsyTabs");
  ok(tabsTemplate, "template-whimsyTabs exists");
  if (tabsTemplate) {
    const content = tabsTemplate.content;
    const wrapCb = content.querySelector("#whimsyViewSourceWrap");
    ok(wrapCb, "whimsyViewSourceWrap checkbox exists in Settings Tab Management template");
    is(wrapCb?.getAttribute("preference"), PREF_NAME, `Controls preference ${PREF_NAME}`);
    is(wrapCb?.getAttribute("data-whimsy-feature"), "view-source-wrap", "Has data-whimsy-feature='view-source-wrap'");
    is(wrapCb?.getAttribute("data-l10n-id"), "whimsy-view-source-wrap", "Has whimsy-view-source-wrap string");
  }
});

add_task(async function test_view_source_wrap_switch_disabled() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [FEATURE_PREF, false],
      [PREF_NAME, false],
    ],
  });

  const entry = WhimsyCommands.get(COMMAND_ID);
  const onVariant = entry?.variants?.find(v => v.l10nId == "whimsy-action-view-source-wrap-on");
  const offVariant = entry?.variants?.find(v => v.l10nId == "whimsy-action-view-source-wrap-off");

  ok(!onVariant.isAvailable(window), "When feature switch is off, variants are unavailable");
  ok(!offVariant.isAvailable(window), "When feature switch is off, variants are unavailable");

  // Attempting to run command should not change pref
  const cmdEl = document.getElementById(COMMAND_ID);
  cmdEl.doCommand();
  is(Services.prefs.getBoolPref(PREF_NAME), false, "Command did nothing when feature switch was off");
});
