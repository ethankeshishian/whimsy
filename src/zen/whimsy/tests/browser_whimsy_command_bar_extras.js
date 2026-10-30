/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// batch6 #13 ("/" enters the command bar's actions mode) and #16 (Arc's
// "New ..." actions, plus the configurable "New Note").

const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
const { UrlbarShared } = ChromeUtils.importESModule("chrome://browser/content/urlbar/UrlbarShared.mjs");

function action(l10nId) {
  return globalActions.find(a => a.l10nId == l10nId);
}

async function typeInUrlbar(text) {
  gURLBar.blur();
  await EventUtils.synthesizeMouseAtCenter(gURLBar.inputField, {});
  await TestUtils.waitForCondition(() => gURLBar.hasAttribute("breakout-extend"), "URL bar expanded");
  gURLBar.value = text;
  gURLBar.inputField.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
}

registerCleanupFunction(() => {
  gURLBar.searchMode = null;
  gURLBar.value = "";
  gURLBar.blur();
});

add_task(async function test_slash_enters_commands_mode_empty() {
  await typeInUrlbar("/");
  await TestUtils.waitForCondition(
    () => gURLBar.searchMode?.source == UrlbarShared.RESULT_SOURCE.ZEN_ACTIONS,
    "Commands mode entered"
  );
  is(gURLBar.value, "", "The slash itself is cleared");
});

add_task(async function test_slash_with_query_keeps_it() {
  gURLBar.searchMode = null;
  await typeInUrlbar("/foo");
  await TestUtils.waitForCondition(
    () => gURLBar.searchMode?.source == UrlbarShared.RESULT_SOURCE.ZEN_ACTIONS,
    "Still commands mode"
  );
  is(gURLBar.value, "foo", "The rest of the typed text is kept as the query");
});

add_task(async function test_switch_off_restores_literal_slash() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.command-bar-slash", false]] });
  gURLBar.searchMode = null;
  await typeInUrlbar("/path");
  is(gURLBar.searchMode, null, "The switch off: no mode change");
  is(gURLBar.value, "/path", "The text is left alone");
  await SpecialPowers.popPrefEnv();
});

add_task(function test_new_thing_actions_registered() {
  ok(action("whimsy-action-new-doc"), "New Google Doc is registered");
  ok(action("whimsy-action-new-linear"), "New Linear Issue is registered");
  ok(action("whimsy-action-new-doc").isAvailable(window), "Available by default");
});

add_task(function test_new_thing_opens_its_url() {
  const opened = [];
  const stub = (url, where) => opened.push({ url, where });
  const original = window.openTrustedLinkIn;
  window.openTrustedLinkIn = stub;
  try {
    action("whimsy-action-new-doc").command(window);
    Assert.deepEqual(opened, [{ url: "https://docs.new", where: "tab" }], "Opens docs.new in a new tab");
  } finally {
    window.openTrustedLinkIn = original;
  }
});

add_task(async function test_new_note_hidden_until_configured() {
  ok(!action("whimsy-action-new-note").isAvailable(window), "Hidden with no target chosen");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.new-note.target", "notion"]] });
  ok(action("whimsy-action-new-note").isAvailable(window), "Shown once a target is set");

  const opened = [];
  const original = window.openTrustedLinkIn;
  window.openTrustedLinkIn = (url, where) => opened.push({ url, where });
  try {
    action("whimsy-action-new-note").command(window);
    Assert.deepEqual(opened, [{ url: "https://notion.new", where: "tab" }], "Opens the chosen target");
  } finally {
    window.openTrustedLinkIn = original;
  }
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_create_switch_hides_all_new_actions() {
  await SpecialPowers.pushPrefEnv({
    set: [["whimsy.feature.command-bar-create", false], ["whimsy.new-note.target", "notion"]],
  });
  ok(!action("whimsy-action-new-doc").isAvailable(window), "Switch off: hidden");
  ok(!action("whimsy-action-new-note").isAvailable(window), "Switch off: hidden even with a target");
  await SpecialPowers.popPrefEnv();
});
