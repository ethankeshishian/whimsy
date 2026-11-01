/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave10/mini W10-13: Mini Whimsy's shortcuts have their own "Mini
// Whimsy" group in Settings → Keyboard Shortcuts, listed from every
// window, with bindings that apply only inside Mini:
// - main windows carry disabled stand-ins, so the page can show and change
//   Cmd+Opt+T and Cmd+O there while New Private Tab keeps Cmd+Opt+T;
// - the page never calls keys of different scopes a conflict;
// - inside Mini, Mini's key wins: another key on the same shortcut is
//   disabled there only, and comes back when Mini's key moves away.

const { WhimsyQuickWindow } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { CustomKeys } = ChromeUtils.importESModule("moz-src:///browser/components/customkeys/CustomKeys.sys.mjs");

const MINI_KEYS = [
  "key_whimsyMiniNewTab",
  "key_whimsyMiniExtensions",
  "key_whimsyQuickWindowOpenInSpace",
  "key_whimsyQuickWindowChooseSpace",
];

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.quick-window.size", ""], ["whimsy.feature.mini-tabs", true]] });
});

registerCleanupFunction(async () => {
  CustomKeys.resetKey("key_whimsyMiniNewTab");
  for (const win of WhimsyQuickWindow.windows()) {
    await WhimsyQuickWindow.whenReady(win);
    await BrowserTestUtils.closeWindow(win);
  }
});

async function openMini() {
  const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
  await WhimsyQuickWindow.whenReady(win);
  await SimpleTest.promiseFocus(win);
  return win;
}

add_task(async function test_main_windows_keep_their_keys() {
  for (const id of MINI_KEYS) {
    const key = document.getElementById(id);
    ok(key, `${id} has a stand-in in the main window`);
    is(key?.getAttribute("disabled"), "true", `${id} never fires outside Mini`);
  }
  const miniNewTab = document.getElementById("key_whimsyMiniNewTab");
  is(miniNewTab.getAttribute("modifiers"), "accel,alt", "The stand-in shows Mini's Cmd+Opt+T");
  is(miniNewTab.getAttribute("key")?.toUpperCase(), "T", "...on T");
  const privateKey = document.getElementById("key_whimsyNewPrivateTab");
  if (Services.prefs.getBoolPref("whimsy.feature.scratch", true) && privateKey) {
    is(WhimsyCommands.keySignature(privateKey), WhimsyCommands.keySignature(miniNewTab),
      "New Private Tab keeps Cmd+Opt+T in main windows");
    ok(privateKey.getAttribute("disabled") != "true", "...and it works there");
  }
});

add_task(async function test_settings_lists_a_mini_whimsy_group_without_false_conflicts() {
  await BrowserTestUtils.withNewTab("about:keyboard", async browser => {
    const result = await SpecialPowers.spawn(browser, [MINI_KEYS], async ids => {
      const doc = content.document;
      await ContentTaskUtils.waitForCondition(() => doc.querySelector('.key[data-id="key_whimsyMiniNewTab"]'),
        "The table lists Mini's keys");
      const rowOf = id => doc.querySelector(`.key[data-id="${id}"]`);
      const groupOf = id => rowOf(id)?.closest("moz-card")?.heading ?? null;
      const shortcutOf = id => rowOf(id)?.querySelector(".currentShortcut")?.value ?? null;
      const miniShortcut = shortcutOf("key_whimsyMiniNewTab");
      // Assigning Mini's key its own shortcut again meets New Private Tab's
      // row first: it must not ask to clear it (no prompt within 2 s).
      const conflict = await Promise.race([
        content.wrappedJSObject.maybeHandleConflict(Cu.cloneInto({ id: "key_whimsyMiniNewTab", shortcut: miniShortcut }, content)),
        new Promise(resolve => content.setTimeout(() => resolve("prompted"), 2000)),
      ]);
      return {
        groups: ids.map(groupOf),
        scopes: ids.map(id => rowOf(id)?.dataset.scope ?? null),
        rows: ids.map(id => doc.querySelectorAll(`.key[data-id="${id}"]`).length),
        miniShortcut,
        privateShortcut: shortcutOf("key_whimsyNewPrivateTab"),
        privateGroup: groupOf("key_whimsyNewPrivateTab"),
        conflict,
      };
    });
    Assert.deepEqual(result.groups, MINI_KEYS.map(() => "Mini Whimsy"), "Mini's keys sit in one Mini Whimsy group");
    Assert.deepEqual(result.scopes, MINI_KEYS.map(() => "mini"), "...marked as Mini's");
    Assert.deepEqual(result.rows, MINI_KEYS.map(() => 1), "...and listed once");
    ok(result.miniShortcut, `New Tab in Mini Whimsy shows its shortcut (${result.miniShortcut})`);
    if (result.privateShortcut) {
      is(result.privateShortcut, result.miniShortcut, "New Private Tab shows the same Cmd+Opt+T");
      isnot(result.privateGroup, "Mini Whimsy", "...in the main-window group");
    }
    is(result.conflict, false, "Different scopes are no conflict: nothing to clear, no prompt");
  });
});

add_task(async function test_mini_keys_win_inside_mini_only() {
  const win = await openMini();
  try {
    const miniKey = win.document.getElementById("key_whimsyMiniNewTab");
    ok(miniKey && miniKey.getAttribute("disabled") != "true", "Mini's own key is live in Mini");
    is(miniKey.getAttribute("modifiers"), "accel,alt", "...on Cmd+Opt+T");

    // Move Mini's key onto Cmd+L: inside Mini it shadows the key there,
    // while the main window keeps Cmd+L as it was.
    const binding = { modifiers: "accel", key: "L" };
    const other = WhimsyCommands.findConflict(win.document, binding, "key_whimsyMiniNewTab");
    CustomKeys.changeKey("key_whimsyMiniNewTab", binding);
    await TestUtils.waitForCondition(() => WhimsyCommands.keySignature(miniKey) == WhimsyCommands.keySignature(binding),
      "The changed shortcut reaches Mini");
    is(WhimsyCommands.keySignature(document.getElementById("key_whimsyMiniNewTab")),
      WhimsyCommands.keySignature(binding), "...and the main window's stand-in");
    is(document.getElementById("key_whimsyMiniNewTab").getAttribute("disabled"), "true", "...which stays inert");
    if (other?.id) {
      await TestUtils.waitForCondition(() => other.getAttribute("disabled") == "true",
        `Inside Mini, ${other.id} gives way to Mini's key`);
      const mainOther = document.getElementById(other.id);
      ok(!mainOther || mainOther.getAttribute("disabled") != "true", `${other.id} still works in the main window`);
    } else {
      info("Nothing else uses Cmd+L in Mini");
    }

    CustomKeys.resetKey("key_whimsyMiniNewTab");
    await TestUtils.waitForCondition(() => miniKey.getAttribute("modifiers") == "accel,alt", "Reset brings Cmd+Opt+T back");
    if (other?.id) {
      await TestUtils.waitForCondition(() => other.getAttribute("disabled") != "true",
        `${other.id} works in Mini again once Mini's key moves away`);
    }
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});
