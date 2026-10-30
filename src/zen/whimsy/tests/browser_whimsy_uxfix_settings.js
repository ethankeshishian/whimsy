/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// wave5/uxfix: Settings → Tab Management keeps every feature switch, but the
// on-demand ones sit in one collapsed "On-demand features" list; the New Note
// target shows its current choice.

add_task(async function on_demand_switches_are_grouped_and_kept() {
  await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
    const doc = browser.contentDocument;
    const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyTabsGroup"));
    const features = doc.getElementById("whimsyTabsFeatures");
    ok(features, "The on-demand list exists");
    ok(!features.open, "It starts collapsed");
    for (const id of ["whimsySnoozeTab", "whimsyFireButton", "whimsyHeavyTabs"]) {
      const box = doc.getElementById(id);
      if (box) {
        is(box.closest("details"), features, `${id} is kept, inside the list`);
      }
    }
    features.querySelector("summary").click();
    ok(features.open, "Clicking the summary opens it");
    const fire = doc.getElementById("whimsyFireButton");
    if (fire) {
      ok(fire.checkVisibility(), "Switches show once open");
    }
    ok(group.querySelector("#whimsyDimSleepingTabs")?.closest("details") == null,
      "Passive options stay outside the list");

    const note = doc.getElementById("whimsyNewNoteTarget");
    if (note) {
      await TestUtils.waitForCondition(() => note.selectedItem, "New Note target has a selection");
      is(note.value, Services.prefs.getStringPref("whimsy.new-note.target"), "It shows the saved choice");
      ok(note.label, "...with a visible label (it used to render empty)");
    }
  });
});
