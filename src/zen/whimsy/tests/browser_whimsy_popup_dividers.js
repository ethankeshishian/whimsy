/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W10-24 audit: a stray vertical divider at the far left of some popups.
// WhimsyPanels appended a bare <toolbarseparator> straight into a <panel>
// with no orient; a panel lays its children out in a row, and Firefox's
// panel stylesheet draws a separator in a row as a full-height line. Every
// Whimsy sheet and surface is opened here and no divider in it may be
// taller than it is wide.

const { WhimsyPanels } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPanels.sys.mjs");
const { WhimsySurface } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySurface.sys.mjs");

const DIVIDERS = "toolbarseparator, menuseparator, .whimsy-sheet-rule, .whimsy-surface-rule";

function checkDividers(panel, name) {
  is(panel.getAttribute("orient"), "vertical", `${name}: the panel stacks its children`);
  for (const divider of panel.querySelectorAll(DIVIDERS)) {
    const rect = divider.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      continue;
    }
    Assert.lessOrEqual(rect.height, rect.width, `${name}: ${divider.localName}.${divider.className} lies flat`);
  }
}

async function openAndCheck(name, panelId, open) {
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == panelId);
  await open();
  await shown;
  const panel = document.getElementById(panelId);
  await document.l10n.translateFragment(panel);
  checkDividers(panel, name);
  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  panel.hidePopup();
  await hidden;
}

add_task(async function sheet_with_search_has_a_flat_rule() {
  const parts = WhimsyPanels.create(window, {
    id: "dividerTestSheet",
    titleL10nId: "whimsy-surface-copied",
    search: { l10nId: "whimsy-surface-copied", onInput() {} },
  });
  ok(!parts.panel.querySelector("toolbarseparator"), "No toolbarseparator in a sheet");
  ok(parts.panel.querySelector(".whimsy-sheet-rule"), "A rule under the search field");
  await openAndCheck("search sheet", "dividerTestSheet", () => WhimsyPanels.open(window, parts.panel));
});

add_task(async function sheet_without_search_has_no_rule() {
  const parts = WhimsyPanels.create(window, { id: "dividerTestPlain", titleL10nId: "whimsy-surface-copied" });
  ok(!parts.panel.querySelector(".whimsy-sheet-rule, toolbarseparator"), "No rule without a search field");
  await openAndCheck("plain sheet", "dividerTestPlain", () => WhimsyPanels.open(window, parts.panel));
});

add_task(async function surface_is_vertical_and_arrowless() {
  const parts = WhimsySurface.create(window, { id: "dividerTestSurface", titleL10nId: "whimsy-surface-copied", close: true, footer: true });
  parts.view.append(WhimsySurface.rule(document));
  WhimsySurface.finish(parts);
  is(parts.panel.getAttribute("hidepopovertail"), "true", "No arrow tail");
  await openAndCheck("surface", "dividerTestSurface", () => WhimsySurface.open(window, parts.panel, { at: "page-top-center" }));
});

add_task(async function every_whimsy_popup() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?whimsy-dividers");
  const { WhimsySnooze } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySnooze.sys.mjs");
  const { WhimsyFireButton } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFireButton.sys.mjs");
  const { WhimsyHeavyTabs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyHeavyTabs.sys.mjs");
  const { WhimsySplitFavorites } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySplitFavorites.sys.mjs");
  const { WhimsyCookieEditor } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCookieEditor.sys.mjs");
  const { WhimsyCheatSheet } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCheatSheet.sys.mjs");
  const { WhimsyPageDev } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPageDev.sys.mjs");
  const { WhimsyEasel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyEasel.sys.mjs");
  const { WhimsyTrails } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTrails.sys.mjs");
  try {
    await openAndCheck("snooze", "whimsySnoozePanel", () => WhimsySnooze.openPanel(window, tab));
    await openAndCheck("heavy tabs", "whimsyHeavyTabsPanel", async () => WhimsyHeavyTabs.openPanel(window));
    await openAndCheck("split favorites", "whimsySplitFavoritesPanel", () => WhimsySplitFavorites.openFavoritesPanel(window));
    await openAndCheck("cookies", "whimsy-cookie-editor-panel", () => WhimsyCookieEditor.open(window));
    await openAndCheck("fire", "whimsyFirePanel", () => WhimsyFireButton.openPanel(window));
    await openAndCheck("cheat sheet", "whimsy-cheatsheet-panel", () => WhimsyCheatSheet.open(window));
    await openAndCheck("page tools", "whimsy-pagedev", () => WhimsyPageDev.open(window, "fonts"));
    await openAndCheck("easel picker", "whimsy-easel-picker", () =>
      WhimsyEasel.showPicker(window, { kind: "still", width: 1280, height: 720 }, { onPick() {}, onCancel() {} }));
    await openAndCheck("trail", "whimsy-trail", () => WhimsyTrails.openTrail(window, document.getElementById("back-button")));
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});
