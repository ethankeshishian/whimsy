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
    document.getElementById(action("whimsy-action-new-doc").command).doCommand();
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
    document.getElementById(action("whimsy-action-new-note").command).doCommand();
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

// Searching "dark" (or "light") shows all the appearance choices, not only
// the one whose label contains the word; the direct match ranks first.
add_task(async function test_appearance_actions_match_each_other() {
  const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");
  UrlbarTestUtils.init(this);
  const [auto, light, dark] = [
    "zen-action-switch-to-automatic-appearance",
    "zen-action-switch-to-light-mode",
    "zen-action-switch-to-dark-mode",
  ].map(action);
  ok(light.whimsyKeywords.includes(dark.label), "Light also matches Dark's label");
  ok(auto.whimsyKeywords.includes(light.label), "Automatic also matches Light's label");
  ok(!dark.whimsyKeywords.includes(dark.label), "An action isn't its own keyword");

  // Automatic now: Light and Dark are both offered.
  await SpecialPowers.pushPrefEnv({ set: [["zen.view.window.scheme", 2]] });
  const titles = async query => {
    gURLBar.searchMode = null;
    await typeInUrlbar(`/${query}`);
    await UrlbarTestUtils.promiseSearchComplete(window);
    const found = [];
    for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
      const { result } = await UrlbarTestUtils.getDetailsOfResultAt(window, i);
      if (result.payload.zenAction) {
        found.push(result.payload.title);
      }
    }
    return found;
  };
  let found = await titles("dark");
  is(found[0], dark.label, '"dark": Dark Mode first');
  ok(found.includes(light.label), '"dark" also shows Light Mode');
  found = await titles("light");
  is(found[0], light.label, '"light": Light Mode first');
  ok(found.includes(dark.label), '"light" also shows Dark Mode');

  // Dark now: "dark" still shows the other two.
  await SpecialPowers.pushPrefEnv({ set: [["zen.view.window.scheme", 0]] });
  found = await titles("dark");
  ok(found.includes(light.label) && found.includes(auto.label), '"dark" in dark mode shows Light and Automatic');
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
  gURLBar.searchMode = null;
});

// wave7/ux: the configurable "New ..." opens Notion, Google Docs or Word,
// so it mustn't share a name with the Library's Notes pad.
add_task(async function test_new_document_is_not_named_like_notes() {
  const [command, setting, off, notes] = await document.l10n.formatMessages([
    { id: "whimsy-action-new-note" },
    { id: "whimsy-new-note-target" },
    { id: "whimsy-new-note-target-none" },
    { id: "whimsy-library-notes-title" },
  ]);
  is(command.value, "New Document", "The command is named for what it makes");
  ok(!/note/i.test(command.value), "...not like the Notes pad");
  ok(!/note/i.test(setting.value), "The setting's label matches the command");
  is(off.attributes.find(a => a.name == "label").value, "Off", "Its first choice is a short Off");
  is(notes.value, "Notes", "The Library's Notes keeps its own name");
});
