/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// wave5/uxfix: a sheet's search field shows where keyboard focus is. The
// input drops its own ring, so the pill around it must draw one.

const { WhimsyPanels } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPanels.sys.mjs");

add_task(async function sheet_search_shows_focus() {
  const { panel, search, body } = WhimsyPanels.create(window, {
    id: "whimsy-uxfix-focus-test",
    titleL10nId: "whimsy-cookie-editor-title",
    search: { l10nId: "whimsy-cookie-editor-search" },
  });
  body.append(WhimsyPanels.empty(document, { l10nId: "whimsy-cookie-editor-empty", l10nArgs: { site: "example.com" } }));
  const shown = BrowserTestUtils.waitForEvent(panel, "popupshown");
  WhimsyPanels.open(window, panel);
  await shown;
  await TestUtils.waitForCondition(() => document.activeElement == search, "Search takes focus");
  const pill = search.closest(".whimsy-sheet-search");
  const style = getComputedStyle(pill);
  isnot(style.outlineStyle, "none", "The search pill draws a focus outline");
  Assert.greaterOrEqual(parseFloat(style.outlineWidth), 1, "...at least a pixel wide");
  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  await hidden;
});
