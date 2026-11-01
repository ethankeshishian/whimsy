/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// W10-39: Settings → Keyboard Shortcuts (about:keyboard) only looked for
// conflicts among the rows it listed. A shortcut held by any other <key>
// (Zen's, Firefox's, DevTools', or one only Mini Whimsy windows have) was
// taken silently, and the new shortcut then lost to the older key. Now every
// bound key in every browser window is listed (WhimsyCommands.addUnlistedKeys):
// the page shows the conflict, asks, clears the old key, and the old key can
// be reassigned like any other.

const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { CustomKeys } = ChromeUtils.importESModule("moz-src:///browser/components/customkeys/CustomKeys.sys.mjs");
const { PromptTestUtils } = ChromeUtils.importESModule("resource://testing-common/PromptTestUtils.sys.mjs");

// Unused on macOS (the command registry's test uses the same one).
const FREE_EVENT = { accelKey: true, shiftKey: true };
const OTHER_MODIFIERS = "accel,alt,shift";
const OTHER_FREE_EVENT = { accelKey: true, altKey: true, shiftKey: true };
const UNLISTED_ID = "whimsy-test-unlisted-key";
const ELSEWHERE_ID = "whimsy-test-other-window-key";

let unlistedRuns = 0;

// Letters no key in any open window holds with ⌘⌥⇧.
function freeLetters(count) {
  const windows = [...Services.wm.getEnumerator("navigator:browser")];
  const free = [];
  for (const letter of "QWERTYUIOPASDFGHJKLZXCVBNM") {
    const binding = { key: letter, modifiers: OTHER_MODIFIERS };
    if (windows.every(w => !WhimsyCommands.findConflict(w.document, binding))) {
      free.push(letter);
    }
    if (free.length == count) {
      break;
    }
  }
  Assert.equal(free.length, count, `Found ${count} free ⌘⌥⇧ letters: ${free.join(", ")}`);
  return free;
}

function addTestKey(win, { id, key, modifiers, onCommand }) {
  const { document } = win;
  const command = document.createXULElement("command");
  command.id = `${id}-command`;
  command.addEventListener("command", onCommand);
  document.getElementById("mainCommandSet").append(command);
  const keyset = document.createXULElement("keyset");
  keyset.id = `${id}-keyset`;
  const keyEl = document.createXULElement("key");
  keyEl.id = id;
  keyEl.setAttribute("key", key);
  keyEl.setAttribute("modifiers", modifiers);
  keyEl.setAttribute("command", command.id);
  keyset.append(keyEl);
  document.getElementById("mainKeyset").parentElement.append(keyset);
  return () => {
    keyset.remove();
    command.remove();
  };
}

async function waitForTable(browser) {
  await SpecialPowers.spawn(browser, [], async () => {
    if (!content.document.getElementById("table").firstElementChild) {
      await ContentTaskUtils.waitForEvent(content, "CustomKeysUpdate", false, null, true);
    }
  });
}

// Zen's window sync copies a second window's blank tab into this one; take
// those along at the end.
const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_setup(async function () {
  const removeKey = addTestKey(window, {
    id: UNLISTED_ID,
    key: "Y",
    modifiers: "accel,shift",
    onCommand: () => unlistedRuns++,
  });
  registerCleanupFunction(() => {
    removeKey();
    CustomKeys.resetAll();
  });
  ok(
    !WhimsyCommands.findConflict(document, { key: "Y", modifiers: "accel,shift" }, UNLISTED_ID),
    "Only the test key holds ⌘⇧Y"
  );
});

add_task(async function test_unlisted_keys_are_listed_and_conflict() {
  const otherHeading = await new Localization(["browser/whimsy.ftl"]).formatValue("whimsy-keys-group-other");
  const renameKeyId = WhimsyCommands.get("cmd_zenChangeWorkspaceName").keyId;
  await BrowserTestUtils.withNewTab("about:keyboard", async browser => {
    await waitForTable(browser);
    await SpecialPowers.spawn(browser, [UNLISTED_ID, otherHeading, renameKeyId], async (id, heading, renameId) => {
      const doc = content.document;
      const row = doc.querySelector(`.key[data-id="${id}"]`);
      ok(row, "A key the page didn't list before is listed now");
      is(row.closest("moz-card").wrappedJSObject.heading, heading, "...under Other Shortcuts");
      ok(row.querySelector(".currentShortcut").wrappedJSObject.value, "...with its shortcut");
      ok(row.dataset.label, `...and a name ("${row.dataset.label}")`);
      is(doc.querySelectorAll(`.key[data-id="${id}"]`).length, 1, "...once");
      // Nothing is listed twice anywhere.
      const ids = [...doc.querySelectorAll(".key")].map(el => el.dataset.id);
      const twice = [...new Set(ids.filter((id, i) => ids.indexOf(id) != i))];
      is(new Set(ids).size, ids.length, `No key is listed in two groups${twice.length ? ` (${twice.slice(0, 10).join(", ")})` : ""}`);

      content.otherRow = row;
      content.renameRow = doc.querySelector(`.key[data-id="${renameId}"]`);
      const card = content.renameRow.closest(".category").wrappedJSObject;
      card.expanded = true;
      await card.updateComplete;
      const input = content.renameRow.querySelector(".newKey").wrappedJSObject;
      const focused = ContentTaskUtils.waitForEvent(input, "focus");
      content.renameRow.querySelector(".change").click();
      await focused;
      content.changeFocused = ContentTaskUtils.waitForEvent(content.renameRow.querySelector(".change"), "focus");
    });

    // Give Rename Space the shortcut the unlisted key holds: the page asks.
    const asked = PromptTestUtils.handleNextPrompt(
      window,
      { modalType: Services.prompt.MODAL_TYPE_CONTENT },
      { buttonNumClick: 0 }
    );
    EventUtils.synthesizeKey("Y", FREE_EVENT, window);
    await asked;
    ok(true, "The page reported the conflict with the key it didn't list before");

    await SpecialPowers.spawn(browser, [], async () => {
      await content.changeFocused;
      ok(content.renameRow.classList.contains("customized"), "Rename Space takes the shortcut");
      ok(!content.otherRow.classList.contains("assigned"), "The other key gave it up");
    });
  });

  ok(!document.getElementById(UNLISTED_ID).hasAttribute("key"), "The other key no longer has ⌘⇧Y");
  is(document.getElementById(renameKeyId).getAttribute("key"), "Y", "Rename Space has it");
  gBrowser.selectedBrowser.focus();
  EventUtils.synthesizeKey("Y", FREE_EVENT, window);
  await TestUtils.waitForCondition(() => document.getElementById("tab-label-input"), "⌘⇧Y renames the space");
  is(unlistedRuns, 0, "The old key no longer fires");
  EventUtils.synthesizeKey("KEY_Escape");
  CustomKeys.resetAll();
  is(document.getElementById(UNLISTED_ID).getAttribute("key"), "Y", "Reset All gives the key its shortcut back");
});

add_task(async function test_keys_only_another_window_has() {
  // A key that exists only in another window (as Mini Whimsy's do).
  const win = await BrowserTestUtils.openNewBrowserWindow();
  let runs = 0;
  const [first, second] = freeLetters(2);
  const removeKey = addTestKey(win, {
    id: ELSEWHERE_ID,
    key: first,
    modifiers: OTHER_MODIFIERS,
    onCommand: () => runs++,
  });
  ok(!document.getElementById(ELSEWHERE_ID), "This window doesn't have it");
  // about:keyboard is used from this window: bring it forward (focus events
  // don't reach a page in a window behind another).
  await SimpleTest.promiseFocus(window);
  const miniHeading = await new Localization(["browser/whimsy.ftl"]).formatValue("whimsy-keys-group-mini");
  try {
    await BrowserTestUtils.withNewTab({ gBrowser, url: "about:keyboard" }, async browser => {
      await waitForTable(browser);
      await SpecialPowers.spawn(browser, [ELSEWHERE_ID, miniHeading], async (id, heading) => {
        const row = content.document.querySelector(`.key[data-id="${id}"]`);
        ok(row, "A key only another window has is listed too");
        is(row.closest("moz-card").wrappedJSObject.heading, heading, "...with Mini Whimsy's keys");
        is(row.dataset.scope, "mini", "...in Mini's scope");
        const card = row.closest(".category").wrappedJSObject;
        card.expanded = true;
        await card.updateComplete;
        content.row = row;
        const input = row.querySelector(".newKey").wrappedJSObject;
        const focused = ContentTaskUtils.waitForEvent(input, "focus");
        row.querySelector(".change").click();
        await focused;
        content.changeFocused = ContentTaskUtils.waitForEvent(row.querySelector(".change"), "focus");
      });
      // Reassign it from here; the page looks it up in its own window.
      EventUtils.synthesizeKey(second, OTHER_FREE_EVENT, window);
      await SpecialPowers.spawn(browser, [], async () => {
        await content.changeFocused;
        ok(content.row.classList.contains("customized"), "It can be reassigned from this window");
        ok(content.row.querySelector(".currentShortcut").wrappedJSObject.value, "...and shows its new shortcut");
      });
    });
    is(win.document.getElementById(ELSEWHERE_ID).getAttribute("key"), second, "The other window's key took it");
    await SimpleTest.promiseFocus(win);
    win.gBrowser.selectedBrowser.focus();
    EventUtils.synthesizeKey(second, OTHER_FREE_EVENT, win);
    await TestUtils.waitForCondition(() => runs == 1, "The new shortcut works there");
  } finally {
    removeKey();
    CustomKeys.resetAll();
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_cheat_sheet_is_unchanged() {
  // The shortcut sheet reads the same groups through a stand-in actor; it
  // keeps its own list rather than every key in the window.
  const { ZenKeyboardShortcuts } = ChromeUtils.importESModule("resource:///modules/zen/kbs/ZenKeyboardShortcuts.sys.mjs");
  const source = {
    browsingContext: { topChromeWindow: window },
    getKeyData: id => (document.getElementById(id)?.localName == "key" ? {} : null),
  };
  const groups = await ZenKeyboardShortcuts.addKeys(source, {});
  const otherHeading = await new Localization(["browser/whimsy.ftl"]).formatValue("whimsy-keys-group-other");
  ok(!groups[otherHeading], "No Other Shortcuts group outside about:keyboard");
});
