/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// wave8/cheatsheet: the Cmd+/ sheet. Cmd+/ opens it with the search
// focused; shortcuts are grouped by menu with one key cap per key; typing
// filters at once (by name, menu, key names or "custom") with an empty
// state; arrows move through the rows and back to the search; rows run
// nothing; Esc clears a search, then closes; Cmd+/ again closes;
// "Edit Shortcuts…" opens about:keyboard; a customized shortcut says so.

const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");

const PANEL_ID = "whimsy-cheatsheet-panel";

async function openSheet(how = () => document.getElementById("whimsy-cheatsheet").doCommand()) {
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == PANEL_ID);
  how();
  await shown;
  return document.getElementById(PANEL_ID);
}

async function closeSheet(panel) {
  if (panel?.state == "open") {
    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    panel.hidePopup();
    await hidden;
  }
}

function type(panel, text) {
  const search = panel.querySelector(".whimsy-sheet-search-input");
  search.value = text;
  search.dispatchEvent(new Event("input"));
}

const visibleRows = panel => [...panel.querySelectorAll(".whimsy-cheatsheet-row")].filter(
  row => !row.hidden && !row.closest(".whimsy-cheatsheet-group").hidden);

add_task(async function test_opens_grouped_with_key_caps() {
  const panel = await openSheet(() => EventUtils.synthesizeKey("/", { accelKey: true }, window));
  try {
    ok(panel.classList.contains("whimsy-sheet"), "It is a Whimsy sheet");
    is(document.activeElement, panel.querySelector(".whimsy-sheet-search-input"), "The search field has focus");

    const groups = panel.querySelectorAll(".whimsy-cheatsheet-group");
    Assert.greaterOrEqual(groups.length, 4, "Shortcuts are grouped");
    const file = panel.querySelector('.whimsy-cheatsheet-group[data-menu="file-menu"]');
    is(file?.querySelector("h2").textContent, document.getElementById("file-menu").label, "...by menu-bar menu");
    const other = panel.querySelector('.whimsy-cheatsheet-group[data-menu="other"]');
    ok(!other || other == groups[groups.length - 1], "Other, when there is one, comes last");

    const row = panel.querySelector('.whimsy-cheatsheet-row[data-key-id="zen-duplicate-tab"]');
    ok(row, "Duplicate Tab is listed");
    const caps = [...row.querySelectorAll("kbd")].map(kbd => kbd.textContent);
    Assert.greaterOrEqual(caps.length, 2, "...as separate key caps");
    is(caps.at(-1), "D", "...ending with its key");
    ok(row.getAttribute("aria-label").includes(row.querySelector(".whimsy-cheatsheet-title").textContent),
      "Rows have an accessible name with the command");

    // Exactly one action: Edit Shortcuts….
    const footerButtons = panel.querySelectorAll(".whimsy-sheet-footer .footer-button");
    is(footerButtons.length, 1, "One footer action");
    ok(footerButtons[0].classList.contains("whimsy-cheatsheet-edit"), "...Edit Shortcuts…");
    ok(!panel.querySelector(".whimsy-cheatsheet-row toolbarbutton, .whimsy-cheatsheet-row button"),
      "Rows hold no buttons of their own");
  } finally {
    await closeSheet(panel);
  }
});

add_task(async function test_search_filters_instantly() {
  const panel = await openSheet();
  try {
    const all = visibleRows(panel).length;
    type(panel, "duplicate");
    ok(visibleRows(panel).some(row => row.dataset.keyId == "zen-duplicate-tab"), "The matching row stays");
    ok(visibleRows(panel).every(row => row.dataset.keyId != "key_find"), "Others hide at once");
    ok(panel.querySelectorAll(".whimsy-cheatsheet-group:not([hidden])").length < panel.querySelectorAll(".whimsy-cheatsheet-group").length,
      "Groups with nothing left hide");
    ok(panel.querySelector(".whimsy-cheatsheet-status").textContent, "The count is announced");

    type(panel, document.getElementById("file-menu").label);
    ok(visibleRows(panel).some(row => row.dataset.keyId == "key_newNavigatorTab"), "A menu's name shows its shortcuts");

    const caps = [...panel.querySelectorAll('.whimsy-cheatsheet-row[data-key-id="key_newNavigatorTab"] kbd')].map(k => k.textContent);
    type(panel, caps.join(AppConstants.platform == "macosx" ? "" : "+"));
    ok(visibleRows(panel).some(row => row.dataset.keyId == "key_newNavigatorTab"), "Typing the keys finds the shortcut");
    if (AppConstants.platform == "macosx") {
      type(panel, "cmd t");
      ok(visibleRows(panel).some(row => row.dataset.keyId == "key_newNavigatorTab"), "So do key names");
    }

    type(panel, "no such shortcut 824831");
    is(visibleRows(panel).length, 0, "No rows for a miss");
    ok(!panel.querySelector(".whimsy-cheatsheet-empty").hidden, "...and an empty state");

    type(panel, "");
    is(visibleRows(panel).length, all, "Clearing the search shows everything again");
    ok(panel.querySelector(".whimsy-cheatsheet-empty").hidden, "...without the empty state");
  } finally {
    await closeSheet(panel);
  }
});

add_task(async function test_keyboard() {
  const panel = await openSheet();
  try {
    const search = panel.querySelector(".whimsy-sheet-search-input");
    const rows = visibleRows(panel);
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, window);
    is(document.activeElement, rows[0], "Down moves into the list");
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, window);
    is(document.activeElement, rows[1], "...and along it");
    EventUtils.synthesizeKey("KEY_End", {}, window);
    is(document.activeElement, rows.at(-1), "End goes to the last shortcut");
    EventUtils.synthesizeKey("KEY_Home", {}, window);
    is(document.activeElement, rows[0], "Home to the first");
    EventUtils.synthesizeKey("KEY_Enter", {}, window);
    is(panel.state, "open", "Enter on a row runs nothing; the sheet stays");
    EventUtils.synthesizeKey("KEY_ArrowUp", {}, window);
    is(document.activeElement, search, "Up from the first row returns to the search");

    EventUtils.synthesizeKey("KEY_ArrowDown", {}, window);
    EventUtils.sendString("dup", window);
    is(document.activeElement, search, "Typing on a row goes back to the search");
    is(search.value, "dup", "...with what was typed");

    EventUtils.synthesizeKey("KEY_Escape", {}, window);
    is(panel.state, "open", "Esc with a search clears it");
    is(search.value, "", "...emptying the field");
    is(visibleRows(panel).length, rows.length, "...and showing everything");

    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    EventUtils.synthesizeKey("KEY_Escape", {}, window);
    await hidden;
    ok(!document.getElementById(PANEL_ID), "A second Esc closes and removes the sheet");
  } finally {
    await closeSheet(document.getElementById(PANEL_ID));
  }
});

add_task(async function test_toggle_and_edit_link() {
  let panel = await openSheet();
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  document.getElementById("whimsy-cheatsheet").doCommand();
  await hidden;
  ok(!document.getElementById(PANEL_ID), "The shortcut again closes it");

  panel = await openSheet();
  // about:keyboard loads in the parent process, often before a load
  // listener on the new tab is in place: wait for its address instead.
  const before = new Set(gBrowser.tabs);
  panel.querySelector(".whimsy-cheatsheet-edit").doCommand();
  await TestUtils.waitForCondition(() => gBrowser.selectedBrowser.currentURI?.spec == "about:keyboard",
    "about:keyboard opened");
  const tab = gBrowser.selectedTab;
  info(`about:keyboard ${before.has(tab) ? "reused the blank tab" : "opened in a new tab"}`);
  ok(!document.getElementById(PANEL_ID), "Edit Shortcuts… closes the sheet");
  is(gBrowser.selectedBrowser.currentURI.spec, "about:keyboard", "...and opens about:keyboard");
  if (before.has(tab)) {
    BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, "about:blank");
    await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, "about:blank");
  } else {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_customized_rows() {
  registerCleanupFunction(() => WhimsyCommands.reset("whimsy-tab-next"));
  ok(WhimsyCommands.rebind("whimsy-tab-next", { modifiers: "accel,alt,shift", key: "U" }).ok, "Next Tab gets a custom key");
  const panel = await openSheet();
  try {
    const row = panel.querySelector('.whimsy-cheatsheet-row[data-key-id="key_whimsyTabNext"]');
    is(row?.getAttribute("customized"), "true", "The row is marked customized");
    ok(row.querySelector(".whimsy-cheatsheet-custom")?.textContent, "...with a word, not only a colour");
    ok(row.title, "...and the default in its tooltip");
    is(row.querySelector("kbd:last-child").textContent, "U", "...showing the custom key");
    ok(!panel.querySelector('.whimsy-cheatsheet-row[data-key-id="key_whimsyCheatsheet"]').hasAttribute("customized"),
      "Default shortcuts aren't marked");

    type(panel, await new Localization(["browser/whimsy.ftl"]).formatValue("whimsy-cheatsheet-custom"));
    ok(visibleRows(panel).includes(row), "Searching \"custom\" finds it");
  } finally {
    await closeSheet(panel);
    WhimsyCommands.reset("whimsy-tab-next");
  }
});

add_task(async function test_disabled_feature_does_nothing() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.cheatsheet", false]] });
  document.getElementById("whimsy-cheatsheet").doCommand();
  await new Promise(resolve => setTimeout(resolve, 100));
  ok(!document.getElementById(PANEL_ID), "With the feature off, nothing opens");
  await SpecialPowers.popPrefEnv();
});
