/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Edit Field in Text Editor: the current tab's focused field goes to a temp
// file under the profile, which "opens" in the editor (stubbed here) and is
// watched for edits, written back into the same field until the tab
// navigates or the session is stopped. A matching button sits in the
// bottom-end corner of qualifying fields; qualifies() in
// WhimsyFieldEditorChild.sys.mjs is the single shared check behind both the
// button and cmd_whimsyEditFieldInEditor, so they always agree.

const { WhimsyFieldEditor } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyFieldEditor.sys.mjs"
);
const { WhimsyCommands } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyCommands.sys.mjs"
);
const { globalActions } = ChromeUtils.importESModule(
  "resource:///modules/ZenUBGlobalActions.sys.mjs"
);

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_field_editor.html";
const HOST_ID = "whimsy-field-editor-host";

const opened = [];
const realOpenInEditor = WhimsyFieldEditor.openInEditor;

add_setup(async function () {
  WhimsyFieldEditor.openInEditor = path => opened.push(path);
  registerCleanupFunction(() => {
    WhimsyFieldEditor.openInEditor = realOpenInEditor;
  });
});

function reset() {
  opened.length = 0;
}

async function focusField(browser, id) {
  await SpecialPowers.spawn(browser, [id], fieldId => content.document.getElementById(fieldId).focus());
}

function blurAll(browser) {
  return SpecialPowers.spawn(browser, [], () => content.document.activeElement?.blur());
}

function fieldValue(browser, id) {
  return SpecialPowers.spawn(browser, [id], fieldId => {
    const el = content.document.getElementById(fieldId);
    return "value" in el ? el.value : el.textContent;
  });
}

function hasButton(browser) {
  return SpecialPowers.spawn(browser, [HOST_ID], hostId => !!content.document.getElementById(hostId));
}

function action() {
  return globalActions.find(a => a.whimsyCommand == "cmd_whimsyEditFieldInEditor");
}

async function cleanUp(...paths) {
  WhimsyFieldEditor.stop(window);
  for (const path of paths) {
    await IOUtils.remove(path, { ignoreAbsent: true });
  }
}

add_task(async function test_command_registered() {
  const entry = WhimsyCommands.get("cmd_whimsyEditFieldInEditor");
  ok(entry, "cmd_whimsyEditFieldInEditor is registered");
  is(entry.l10nId, "whimsy-action-edit-field-in-editor", "Named Edit Field in Text Editor");
  const keyEl = entry.keyId && document.getElementById(entry.keyId);
  ok(!keyEl?.hasAttribute("key") && !keyEl?.hasAttribute("keycode"), "No default shortcut");
});

add_task(async function test_availability() {
  await BrowserTestUtils.withNewTab(PAGE, async () => {
    ok(action()?.isAvailable(window), "Available on an http(s) page");
  });
  await BrowserTestUtils.withNewTab("about:blank", async () => {
    ok(!action()?.isAvailable(window), "Unavailable on a non-http(s) page");
  });
});

// The design's qualifies() cases: size, field type/autocomplete exclusions.
// Checked against both the button and the command in lockstep, since a
// single qualifies() in WhimsyFieldEditorChild.sys.mjs decides both, and
// that 1:1 agreement is the thing under test here.
const QUALIFYING_CASES = [
  { id: "area", expect: true, label: "a qualifying textarea" },
  { id: "edit", expect: true, label: "a qualifying contenteditable" },
  { id: "text", expect: false, label: "a single-line input" },
  { id: "password", expect: false, label: "a password field" },
  { id: "otpArea", expect: false, label: "a one-time-code textarea" },
  { id: "ccArea", expect: false, label: "a card-number textarea" },
  { id: "smallArea", expect: false, label: "an undersized textarea" },
  { id: "smallEdit", expect: false, label: "an undersized contenteditable" },
  { id: "readonlyArea", expect: false, label: "a read-only textarea" },
];

add_task(async function test_qualifies_cases_match_button_and_command() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    for (const { id, expect, label } of QUALIFYING_CASES) {
      await focusField(browser, id);
      await TestUtils.waitForCondition(async () => (await hasButton(browser)) == expect,
        `${label}: button settles`);
      is(await hasButton(browser), expect, `${label}: button ${expect ? "shows" : "stays hidden"}`);
      await TestUtils.waitForCondition(() => !!action()?.isAvailable(window) == expect,
        `${label}: command settles`);
      is(!!action()?.isAvailable(window), expect, `${label}: command matches the button 1:1`);
    }
    await blurAll(browser);
  });
});

add_task(async function test_private_window_shows_neither() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, PAGE);
    const browser = tab.linkedBrowser;
    await focusField(browser, "area");
    await TestUtils.waitForCondition(async () => !(await action()?.isAvailable(win)),
      "The command settles to unavailable");
    ok(!action()?.isAvailable(win), "No command availability in a private window");
    is(await hasButton(browser), false, "No button in a private window either");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_pref_hides_button_but_not_command() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.field-editor.button", false]] });
  try {
    await BrowserTestUtils.withNewTab(PAGE, async browser => {
      await focusField(browser, "area");
      await TestUtils.waitForTick();
      is(await hasButton(browser), false, "The button stays hidden when the pref is off");
      await TestUtils.waitForCondition(() => action()?.isAvailable(window),
        "Edit Field in Text Editor still follows the field with the button off");
      ok(action()?.isAvailable(window), "The command works with the button off");
      reset();
      const result = await WhimsyFieldEditor.editFocusedField(window);
      is(result, "editing", "The command still opens the field with the button off");
      await cleanUp(opened.at(-1));
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_tooltip_is_the_command_label() {
  const { Localization } = ChromeUtils.importESModule("resource://gre/modules/Localization.sys.mjs");
  const l10n = new Localization(["browser/whimsy.ftl"], true);
  const expected = await l10n.formatValue("whimsy-action-edit-field-in-editor");
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await focusField(browser, "area");
    await TestUtils.waitForCondition(() => hasButton(browser), "The button appeared");
    const [title, ariaLabel] = await SpecialPowers.spawn(browser, [HOST_ID], hostId => {
      const button = content.document.getElementById(hostId).openOrClosedShadowRoot.querySelector("button");
      return [button.title, button.getAttribute("aria-label")];
    });
    is(title, expected, "The tooltip is the command's own label");
    is(ariaLabel, expected, "The accessible name matches too");
  });
});

add_task(async function test_no_field_focused() {
  reset();
  const toasts = [];
  const real = gZenUIManager.showToast;
  gZenUIManager.showToast = id => toasts.push(id);
  try {
    await BrowserTestUtils.withNewTab(PAGE, async browser => {
      await blurAll(browser);
      const result = await WhimsyFieldEditor.editFocusedField(window);
      is(result, "no-field", "Nothing focused: no-field");
      is(opened.length, 0, "No editor opened");
      is(toasts.length, 0, "No toast: the button is the only feedback now");
    });
  } finally {
    gZenUIManager.showToast = real;
  }
});

add_task(async function test_password_field_excluded() {
  reset();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await focusField(browser, "password");
    const result = await WhimsyFieldEditor.editFocusedField(window);
    is(result, "no-field", "A focused password field counts as nothing focused");
    is(opened.length, 0, "No editor opened");
  });
});

async function roundTrip(browser, id, initial, edited) {
  reset();
  await focusField(browser, id);
  const result = await WhimsyFieldEditor.editFocusedField(window);
  is(result, "editing", "A session starts");
  is(opened.length, 1, "The editor opened once");
  const path = opened[0];
  const written = await IOUtils.readUTF8(path);
  is(written, initial, `The temp file holds the ${id} field's current value`);
  ok(path.startsWith(PathUtils.profileDir), "The temp file lives under the profile");

  await IOUtils.writeUTF8(path, edited);
  await TestUtils.waitForCondition(async () => (await fieldValue(browser, id)) == edited,
    `The ${id} field picks up the edit`);

  await cleanUp(path);
}

add_task(async function test_round_trip_textarea() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await roundTrip(browser, "area", "multi\nline", "multi\nline\nmore");
  });
});

add_task(async function test_round_trip_contenteditable_plain_text_only() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    reset();
    await focusField(browser, "edit");
    const result = await WhimsyFieldEditor.editFocusedField(window);
    is(result, "editing", "A session starts");
    const path = opened[0];
    is(await IOUtils.readUTF8(path), "rich text", "Read as plain text, tags stripped");

    await IOUtils.writeUTF8(path, "<script>evil</script>");
    await TestUtils.waitForCondition(async () => (await fieldValue(browser, "edit")) == "<script>evil</script>",
      "The edit lands");
    const hasScript = await SpecialPowers.spawn(browser, [], () =>
      !!content.document.getElementById("edit").querySelector("script"));
    ok(!hasScript, "Written back as text (textContent), never parsed as markup");

    await cleanUp(path);
  });
});

add_task(async function test_stops_on_navigation() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    reset();
    await focusField(browser, "area");
    await WhimsyFieldEditor.editFocusedField(window);
    const path = opened[0];

    // A different query string, not just a hash: a same-document (hash-only)
    // navigation fires no "load" event for browserLoaded to wait on.
    const elsewhere = ROOT + "whimsy_field_editor.html?elsewhere";
    const loaded = BrowserTestUtils.browserLoaded(browser, false, elsewhere);
    BrowserTestUtils.startLoadingURIString(browser, elsewhere);
    await loaded;

    await TestUtils.waitForCondition(() => !WhimsyFieldEditor._sessions.get(window), "The session stopped");
    await IOUtils.writeUTF8(path, "should not land");
    // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
    await new Promise(resolve => window.setTimeout(resolve, 700));
    is(await fieldValue(browser, "area"), "multi\nline", "A post-navigation edit never reaches the field");
    await IOUtils.remove(path, { ignoreAbsent: true });
  });
});

add_task(async function test_a_second_run_replaces_the_first() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    reset();
    await focusField(browser, "area");
    await WhimsyFieldEditor.editFocusedField(window);
    const firstPath = opened[0];
    await focusField(browser, "edit");
    await WhimsyFieldEditor.editFocusedField(window);
    is(opened.length, 2, "A second run opens its own file");
    const secondPath = opened[1];
    isnot(firstPath, secondPath, "A fresh temp file, not reused");

    await IOUtils.writeUTF8(firstPath, "stale edit");
    // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
    await new Promise(resolve => window.setTimeout(resolve, 700));
    is(await fieldValue(browser, "area"), "multi\nline", "The replaced session's file is no longer watched");

    await cleanUp(firstPath, secondPath);
  });
});

add_task(async function test_deadline_is_armed() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    reset();
    await focusField(browser, "area");
    await WhimsyFieldEditor.editFocusedField(window);
    const session = WhimsyFieldEditor._sessions.get(window);
    ok(session?.deadline, "A ten-minute cap is armed for the session");
    await cleanUp(opened.at(-1));
  });
});

add_task(async function test_run_wires_the_command_to_editFocusedField() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    reset();
    await focusField(browser, "area");
    document.getElementById("cmd_whimsyEditFieldInEditor").doCommand();
    await TestUtils.waitForCondition(() => opened.length == 1, "doCommand() reaches editFocusedField");
    await cleanUp(opened[0]);
  });
});

add_task(async function test_press_opens_the_editor_and_sets_pressed() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    reset();
    await focusField(browser, "area");
    await TestUtils.waitForCondition(() => hasButton(browser), "The button appeared");

    await SpecialPowers.spawn(browser, [HOST_ID], hostId => {
      content.document.getElementById(hostId).openOrClosedShadowRoot.querySelector("button").click();
    });
    await TestUtils.waitForCondition(() => opened.length == 1, "Pressing the button opens the editor");
    const path = opened[0];

    await TestUtils.waitForCondition(async () => (await SpecialPowers.spawn(browser, [HOST_ID], hostId =>
      content.document.getElementById(hostId).openOrClosedShadowRoot.querySelector("button")
        .getAttribute("aria-pressed"))) == "true",
      "The button shows pressed while the session is open");

    await cleanUp(path);
    await TestUtils.waitForCondition(async () => (await SpecialPowers.spawn(browser, [HOST_ID], hostId =>
      content.document.getElementById(hostId).openOrClosedShadowRoot.querySelector("button")
        .getAttribute("aria-pressed"))) == "false",
      "Stopping the session un-presses the button");
  });
});
