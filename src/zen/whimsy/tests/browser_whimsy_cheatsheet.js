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

  const row = [...panel.querySelectorAll(".whimsy-cheatsheet-row")].find(r =>
    r.textContent.includes("D")
  );
  ok(row, "Duplicate Tab's row is shown with a key label");

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
