/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Open with the key -> the panel shows the "zen-duplicate-tab" row with
// its current binding. Customize a key -> the sheet shows the new binding.
// Esc closes it.

add_task(async function test_cheatsheet_shows_and_closes() {
  const command = window.document.getElementById("whimsy-cheatsheet");
  ok(command, "The cheat sheet command is registered");

  const shown = BrowserTestUtils.waitForEvent(window.document, "popupshown", true,
    e => e.target.id == "whimsy-cheatsheet-panel");
  command.doCommand();
  await shown;
  const panel = window.document.getElementById("whimsy-cheatsheet-panel");
  ok(panel, "The panel opened");

  // The list is built from the keysets after the panel opens.
  const row = await TestUtils.waitForCondition(
    () => panel.querySelector('.whimsy-cheatsheet-row[data-key-id="zen-duplicate-tab"]'),
    "The shortcut list rendered"
  );
  ok(row, "Duplicate Tab's row is shown with a key label");
  is(row.getAttribute("whimsy-key"), "zen-duplicate-tab", "...tagged with its key");
  ok(row.querySelector(".whimsy-sheet-item-keys").value.includes("D"), "With its key caps");
  ok(panel.classList.contains("whimsy-sheet"), "It is a Whimsy sheet");
  ok(panel.querySelectorAll(".whimsy-sheet-caption").length >= 3, "Shortcuts are grouped");

  // Typing filters; groups with nothing left hide.
  const search = panel.querySelector(".whimsy-sheet-search-input");
  is(document.activeElement, search, "The search field has focus");
  EventUtils.sendString("duplicate", window);
  ok(panel.querySelector('.whimsy-cheatsheet-row[whimsy-key="zen-duplicate-tab"]:not([hidden])'),
    "The matching row stays");
  ok(panel.querySelector('.whimsy-cheatsheet-row[whimsy-key="key_find"]')?.hidden ?? true, "Others hide");

  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  await hidden;
  ok(!window.document.getElementById("whimsy-cheatsheet-panel"), "Esc closes and removes the panel");
});

add_task(async function test_disabled_feature_does_nothing() {
  Services.prefs.setBoolPref("whimsy.feature.cheatsheet", false);
  registerCleanupFunction(() => Services.prefs.clearUserPref("whimsy.feature.cheatsheet"));
  window.document.getElementById("whimsy-cheatsheet").doCommand();
  ok(!window.document.getElementById("whimsy-cheatsheet-panel"), "With the feature off, nothing opens");
  Services.prefs.clearUserPref("whimsy.feature.cheatsheet");
});
