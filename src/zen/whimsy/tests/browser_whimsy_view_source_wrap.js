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

const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");

const COMMAND_ID = "cmd_whimsyToggleViewSourceWrap";
// The command bar's "Wrap…" and "Stop Wrapping…" rows (its variants).
const variant = l10nId => globalActions.find(a => a.l10nId == l10nId);
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

  const onVariant = variant("whimsy-action-view-source-wrap-on");
  const offVariant = variant("whimsy-action-view-source-wrap-off");

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
  // Settings → Tab Management → On-demand features.
  await BrowserTestUtils.withNewTab("about:preferences", async browser => {
    const doc = browser.contentDocument;
    const wrapCb = await TestUtils.waitForCondition(
      () => doc.getElementById("template-whimsyTabs")?.content.querySelector("#whimsyViewSourceWrap") ??
        doc.getElementById("whimsyViewSourceWrap"),
      "Settings has the line wrap switch"
    );
    is(wrapCb.getAttribute("preference"), PREF_NAME, `Controls preference ${PREF_NAME}`);
    is(wrapCb.getAttribute("data-whimsy-feature"), "view-source-wrap", "Has data-whimsy-feature='view-source-wrap'");
    is(wrapCb.getAttribute("data-l10n-id"), "whimsy-view-source-wrap", "Has whimsy-view-source-wrap string");
  });
});

add_task(async function test_view_source_wrap_switch_disabled() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [FEATURE_PREF, false],
      [PREF_NAME, false],
    ],
  });

  const onVariant = variant("whimsy-action-view-source-wrap-on");
  const offVariant = variant("whimsy-action-view-source-wrap-off");

  ok(!onVariant.isAvailable(window), "When feature switch is off, variants are unavailable");
  ok(!offVariant.isAvailable(window), "When feature switch is off, variants are unavailable");

  // Attempting to run command should not change pref
  const cmdEl = document.getElementById(COMMAND_ID);
  cmdEl.doCommand();
  is(Services.prefs.getBoolPref(PREF_NAME), false, "Command did nothing when feature switch was off");
});

// W10-34 (lane): the command wraps an open View Page Source tab at once,
// the same way Firefox's own "Wrap Long Lines" context item does.
add_task(async function test_view_source_wrap_applies_live() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [FEATURE_PREF, true],
      [PREF_NAME, false],
    ],
  });
  const long = "x".repeat(4000);
  const url = "view-source:data:text/html," + encodeURIComponent(`<p>${long}</p>`);
  await BrowserTestUtils.withNewTab(url, async browser => {
    const whiteSpace = () =>
      // The source is laid out in body#viewsource (one span per line).
      SpecialPowers.spawn(browser, [], () => content.getComputedStyle(content.document.body).whiteSpace);
    is(await whiteSpace(), "pre", "long lines don't wrap to start with");
    document.getElementById(COMMAND_ID).doCommand();
    await TestUtils.waitForCondition(async () => (await whiteSpace()) == "pre-wrap", "the open source view wraps");
    document.getElementById(COMMAND_ID).doCommand();
    await TestUtils.waitForCondition(async () => (await whiteSpace()) == "pre", "and stops wrapping again");
  });
  await SpecialPowers.popPrefEnv();
});
