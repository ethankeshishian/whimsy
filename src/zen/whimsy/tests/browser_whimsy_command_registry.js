/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave5: the command registry (WhimsyCommands.sys.mjs). Every registered
// command is in the command bar and in Settings → Keyboard Shortcuts
// (about:keyboard) under "Whimsy"; changing a shortcut works, lasts, and
// refuses a key that's already taken; the shipped defaults are unchanged.

const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
const { CustomKeys } = ChromeUtils.importESModule("moz-src:///browser/components/customkeys/CustomKeys.sys.mjs");
const { ZenKeyboardShortcuts } = ChromeUtils.importESModule("resource:///modules/zen/kbs/ZenKeyboardShortcuts.sys.mjs");
const { ShortcutUtils } = ChromeUtils.importESModule("resource://gre/modules/ShortcutUtils.sys.mjs");

// Unused on macOS and Windows (Zen's kbs tests use the same one).
const FREE = { modifiers: "accel,shift", key: "Y" };
const FREE_EVENT = { accelKey: true, shiftKey: true };

// The defaults Whimsy shipped before the registry, by <key> id.
const DEFAULTS = {
  key_whimsyCheatsheet: { key: "/", modifiers: "accel" },
  key_whimsyQuickWindow: { key: "N", modifiers: "accel,alt" },
  key_whimsyNewPrivateTab: { key: "T", modifiers: "accel,alt" },
  key_whimsyNewScratch: { key: "N", modifiers: "accel,shift" },
  key_whimsyTabNext: { keycode: "VK_DOWN", modifiers: "accel,alt" },
  key_whimsyTabPrev: { keycode: "VK_UP", modifiers: "accel,alt" },
  key_whimsyCopyFullPage: { keycode: "VK_1", modifiers: "accel,shift" },
  key_whimsyScreenshotArc: { keycode: "VK_2", modifiers: "accel,shift" },
  key_whimsyTranslateSelection: { key: "T", modifiers: "accel,alt,shift" },
  key_whimsySpeedUp: { key: ".", modifiers: "accel,alt" },
  key_whimsySlowDown: { key: ",", modifiers: "accel,alt" },
  key_whimsySpeedReset: { key: "0", modifiers: "accel,alt" },
  key_whimsyCloseOtherPanes: { key: "W", modifiers: "accel,alt,shift" },
};

function listed() {
  return WhimsyCommands.entries.filter(entry => entry.l10nId);
}

registerCleanupFunction(() => CustomKeys.resetAll());

add_task(async function test_every_command_is_in_the_command_bar() {
  const entries = listed();
  Assert.greater(entries.length, 30, "Whimsy's commands are registered");
  for (const entry of entries) {
    const actions = globalActions.filter(a => a.command == entry.id || a.whimsyCommand == entry.id);
    Assert.greater(actions.length, 0, `${entry.id} is in the command bar`);
    for (const action of actions) {
      ok(action.label, `${entry.id}: "${action.label}" has a name`);
    }
    if (entry.variants.length) {
      Assert.deepEqual(
        actions.map(a => a.l10nId).sort(),
        [...entry.variants].sort(),
        `${entry.id} has one command-bar name per state`
      );
    }
  }
  const focus = globalActions.find(a => a.command == "whimsy-focus-sidebar");
  is(focus?.label, "Focus Sidebar", "Focus Sidebar can be reached from the command bar");
});

add_task(async function test_command_bar_runs_the_command_and_shows_its_key() {
  const action = globalActions.find(a => a.l10nId == "whimsy-action-cheatsheet");
  is(action.command, "whimsy-cheatsheet", "The command bar runs the registered <command>");
  is(
    ZenKeyboardShortcuts.getShortcutDisplayFromCommand(window, action.command),
    ShortcutUtils.prettifyShortcut(document.getElementById("key_whimsyCheatsheet")),
    "and shows its current shortcut"
  );
});

add_task(async function test_every_command_is_in_the_shortcut_editor() {
  const expected = listed().map(entry => ({
    id: entry.id,
    keyId: entry.keyId ?? entry.elsewhere,
    whimsy: !!entry.keyId,
    title: WhimsyCommands.title(entry),
  }));
  const heading = await new Localization(["browser/whimsy.ftl"]).formatValue("whimsy-cheatsheet-group-whimsy");
  await BrowserTestUtils.withNewTab("about:keyboard", async browser => {
    await SpecialPowers.spawn(browser, [expected, heading], async (rows, groupTitle) => {
      const doc = content.document;
      if (!doc.getElementById("table").firstElementChild) {
        await ContentTaskUtils.waitForEvent(content, "CustomKeysUpdate", false, null, true);
      }
      const cards = [...doc.querySelectorAll("moz-card.category")];
      const first = cards[0].wrappedJSObject;
      is(first.heading, groupTitle, "Whimsy's group comes first...");
      ok(first.expanded, "...open, so Edit Shortcuts… lands on it");
      for (const row of rows) {
        const el = doc.querySelector(`.key[data-id="${row.keyId}"]`);
        ok(el, `${row.id} is listed (${row.keyId})`);
        if (el && row.whimsy) {
          is(el.closest("moz-card").wrappedJSObject.heading, groupTitle, `${row.id} is under Whimsy`);
          is(el.dataset.label, row.title, `${row.id} has the same name as in the command bar`);
        }
      }
      const focus = doc.querySelector('.key[data-id="key_whimsyFocusSidebar"]');
      ok(focus, "Focus Sidebar can be given a shortcut");
      is(focus.querySelector(".currentShortcut").wrappedJSObject.value, "", "and has none by default");
    });
  });
});

add_task(async function test_switch_off_hides_the_group() {
  const actor = {
    browsingContext: { topChromeWindow: window },
    getKeyData: id => (document.getElementById(id) ? { shortcut: "" } : null),
  };
  const heading = await new Localization(["browser/whimsy.ftl"]).formatValue("whimsy-cheatsheet-group-whimsy");
  ok(heading in (await ZenKeyboardShortcuts.addKeys(actor, {})), "Listed with the switch on");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.command-registry", false]] });
  ok(!(heading in (await ZenKeyboardShortcuts.addKeys(actor, {}))), "Not listed with it off");
  await SpecialPowers.popPrefEnv();
});

add_task(function test_defaults_are_unchanged() {
  for (const [id, binding] of Object.entries(DEFAULTS)) {
    const keyEl = document.getElementById(id);
    ok(keyEl, `${id} exists`);
    is(keyEl?.parentElement.id, "whimsyKeyset", `${id} is in Whimsy's keyset`);
    for (const [attr, value] of Object.entries(binding)) {
      is(keyEl?.getAttribute(attr), value, `${id} keeps ${attr}="${value}"`);
    }
    is(WhimsyCommands.findConflict(document, binding, id), null, `${id} is the only key on its shortcut`);
  }
  // Swap Panes' old Cmd+Opt+Shift+S was Zen's Save Page; wave6 moved Save
  // Page to Arc's Cmd+Shift+S (while Capture has Cmd+Shift+2).
  ok(!document.getElementById("key_whimsySwapPanes").hasAttribute("key"), "Swap Panes has no default");
  is(
    document.getElementById("key_savePage").getAttribute("modifiers"),
    Services.prefs.getBoolPref("whimsy.feature.capture", true) ? "accel,shift" : "accel,alt,shift",
    "Save Page has Arc's key"
  );
  // Zen's own keys stay where they are.
  is(document.getElementById("zen-compact-mode-toggle").getAttribute("key"), "S", "Cmd+S is still compact mode");
  is(document.getElementById("zen-compact-mode-show-sidebar").getAttribute("modifiers"), "accel,alt", "Cmd+Opt+S is still Zen's");
  ok(!document.getElementById("key_whimsyFocusSidebar").hasAttribute("key"), "Focus Sidebar has no default");
});

add_task(async function test_rebinding_works_and_persists() {
  const keyId = "key_whimsyFocusSidebar";
  const result = WhimsyCommands.rebind("whimsy-focus-sidebar", FREE);
  ok(result.ok, "A free shortcut is accepted");
  const keyEl = document.getElementById(keyId);
  is(keyEl.getAttribute("key"), "Y", "The key takes it");
  is(keyEl.getAttribute("modifiers"), FREE.modifiers, "...with its modifiers");
  ok(CustomKeys.getDefaultKey(keyId), "Recorded as a customization");

  EventUtils.synthesizeKey("y", FREE_EVENT);
  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab.hasAttribute("whimsy-sidebar-focused"),
    "The new shortcut runs Focus Sidebar"
  );
  EventUtils.synthesizeKey("KEY_Escape");

  await TestUtils.waitForCondition(async () => {
    const path = PathUtils.join(PathUtils.profileDir, "customKeys.json");
    return (await IOUtils.exists(path)) && (await IOUtils.readUTF8(path)).includes(keyId);
  }, "Saved to customKeys.json, so it lasts across restarts");

  // Zen syncs tabs between windows: the new window's first tab also lands
  // here, so remember what was open to tidy up after.
  const tabsBefore = new Set(gBrowser.tabs);
  const win = await BrowserTestUtils.openNewBrowserWindow();
  await TestUtils.waitForCondition(() => win.document.getElementById(keyId), "The new window has the command");
  await TestUtils.waitForCondition(
    () => win.document.getElementById(keyId).getAttribute("key") == "Y",
    "A new window gets the customized shortcut"
  );
  await BrowserTestUtils.closeWindow(win);
  for (const tab of gBrowser.tabs.filter(t => !tabsBefore.has(t))) {
    BrowserTestUtils.removeTab(tab);
  }

  WhimsyCommands.reset("whimsy-focus-sidebar");
  ok(!keyEl.hasAttribute("key"), "Reset goes back to no shortcut");
});

add_task(function test_rebinding_a_default_and_back() {
  const keyEl = document.getElementById("key_whimsyCheatsheet");
  ok(WhimsyCommands.rebind("whimsy-cheatsheet", FREE).ok, "Keyboard Shortcuts moves to a free key");
  is(keyEl.getAttribute("key"), "Y", "...and takes it");
  WhimsyCommands.reset("whimsy-cheatsheet");
  is(keyEl.getAttribute("key"), "/", "Reset brings back Cmd+/");
  is(keyEl.getAttribute("modifiers"), "accel", "...with Cmd");
});

add_task(function test_conflicts_are_refused() {
  const keyEl = document.getElementById("key_whimsyFocusSidebar");
  const taken = WhimsyCommands.rebind("whimsy-focus-sidebar", { key: "S", modifiers: "accel" });
  ok(!taken.ok, "Cmd+S is refused");
  is(taken.conflict?.id, "zen-compact-mode-toggle", "...because compact mode has it");
  ok(!keyEl.hasAttribute("key"), "Focus Sidebar stays unbound");

  const own = WhimsyCommands.rebind("whimsy-tab-prev", { keycode: "VK_DOWN", modifiers: "accel,alt" });
  ok(!own.ok, "Another Whimsy command's shortcut is refused too");
  is(own.conflict?.id, "key_whimsyTabNext", "...naming the command that has it");
  is(document.getElementById("key_whimsyTabPrev").getAttribute("keycode"), "VK_UP", "Previous Tab keeps its key");

  // A default that collides is registered unbound rather than shadowing.
  const probe = WhimsyCommands.register(window, {
    id: "whimsy-test-conflict-probe",
    run: () => {},
    keyId: "key_whimsyTestConflictProbe",
    key: { key: "S", modifiers: "accel" },
    commandBar: false,
  });
  const probeKey = document.getElementById("key_whimsyTestConflictProbe");
  ok(probe && probeKey, "The command and its key exist");
  ok(!probeKey.hasAttribute("key"), "...but the taken default isn't applied");
  is(document.getElementById("zen-compact-mode-toggle").getAttribute("key"), "S", "Zen keeps Cmd+S");
  probeKey.remove();
  probe.remove();
});

add_task(async function test_cheat_sheet_uses_the_same_names() {
  const { WhimsyCheatSheet } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCheatSheet.sys.mjs");
  const rows = await WhimsyCheatSheet.rows(window);
  for (const keyId of ["key_whimsyCheatsheet", "key_whimsyCopyFullPage", "key_whimsyTabNext"]) {
    const row = rows.find(r => r.keyId == keyId);
    is(row?.title, WhimsyCommands.title(WhimsyCommands.forKey(keyId)), `${keyId} has its command's name`);
  }
});
