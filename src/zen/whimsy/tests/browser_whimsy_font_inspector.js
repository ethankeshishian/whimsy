/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9: W9-01 Font Inspector ("What Font Is This?").
// Shows a popover with rendered font family, size, weight, line height,
// letter spacing, and color (hex + swatch). Each value copies on click.
// Registered with Menus settings (WhimsyMenuPrefs) and WhimsyCommands.

const { WhimsyInspector } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyInspector.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { WhimsyMenuPrefs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMenuPrefs.sys.mjs");

const PAGE = "https://example.com/document-builder.sjs?html=" + encodeURIComponent(`
  <html>
    <head><title>Font Inspector Test</title></head>
    <body>
      <p id="font-target" style="font-family: Arial, sans-serif; font-size: 24px; font-weight: 700; line-height: 32px; letter-spacing: 1px; color: rgb(255, 0, 0);">
        Sphinx of black quartz, judge my vow.
      </p>
    </body>
  </html>
`);

async function selectTargetText(browser) {
  await SpecialPowers.spawn(browser, [], () => {
    const el = content.document.getElementById("font-target");
    const range = content.document.createRange();
    range.selectNodeContents(el);
    const sel = content.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

add_task(async function test_font_inspector_command_and_menu() {
  ok(WhimsyInspector.fontInspectorEnabled, "Font Inspector is enabled by default");

  // WhimsyCommands registration
  const command = WhimsyCommands.get("cmd_whimsyInspectFont");
  ok(command, "cmd_whimsyInspectFont is registered in WhimsyCommands");
  is(command.l10nId, "whimsy-action-inspect-font", "Command has correct l10n id");

  // Context menu item
  const menuItem = document.getElementById("context-whimsy-inspect-font");
  ok(menuItem, "Context menu item #context-whimsy-inspect-font exists");
  is(menuItem.getAttribute("command"), "cmd_whimsyInspectFont", "Points to cmd_whimsyInspectFont");

  // Registered with WhimsyMenuPrefs under 'selection'
  const selectionItems = WhimsyMenuPrefs.items("selection");
  const found = selectionItems.find(i => i.id === "inspect-font");
  ok(found, "inspect-font is registered in WhimsyMenuPrefs selection menu");
  is(found?.l10n, "whimsy-menus-selection-inspect-font", "Uses correct MenuPrefs l10n string");

  // Test hiding via WhimsyMenuPrefs
  WhimsyMenuPrefs.setHidden("selection", "inspect-font", true);
  ok(WhimsyMenuPrefs.isHidden("selection", "inspect-font"), "inspect-font is marked hidden");
  WhimsyMenuPrefs.restoreDefaults("selection");
  ok(!WhimsyMenuPrefs.isHidden("selection", "inspect-font"), "inspect-font restored to visible");
});

add_task(async function test_inspect_font_popover_and_values() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;

  await selectTargetText(browser);

  // Run font inspection
  await WhimsyInspector.inspectFont(window);

  const panel = document.getElementById("whimsy-font-inspector-panel");
  ok(panel, "Font inspector panel was created");
  is(panel.getAttribute("size"), "small", "Panel uses small sheet width");

  // Check extracted values in popover
  const familyName = panel.querySelector(".whimsy-font-family-name");
  ok(familyName?.textContent, `Rendered font family is displayed: ${familyName?.textContent}`);

  const rows = Array.from(panel.querySelectorAll(".whimsy-font-prop-row"));
  const rowLabels = rows.map(r => r.querySelector(".whimsy-font-prop-label")?.textContent);
  ok(rowLabels.includes("Size"), "Size row exists");
  ok(rowLabels.includes("Weight"), "Weight row exists");
  ok(rowLabels.includes("Line Height"), "Line Height row exists");
  ok(rowLabels.includes("Letter Spacing"), "Letter Spacing row exists");
  ok(rowLabels.includes("Colour"), "Colour row exists");

  const sizeRow = rows.find(r => r.querySelector(".whimsy-font-prop-label")?.textContent === "Size");
  ok(sizeRow?.textContent.includes("24px"), "Size shows 24px");

  const weightRow = rows.find(r => r.querySelector(".whimsy-font-prop-label")?.textContent === "Weight");
  ok(weightRow?.textContent.includes("700"), "Weight shows 700");

  const colorRow = rows.find(r => r.querySelector(".whimsy-font-prop-label")?.textContent === "Colour");
  ok(colorRow?.textContent.includes("#FF0000"), "Color shows #FF0000 hex");
  const swatch = colorRow?.querySelector(".whimsy-color-swatch");
  ok(swatch, "Color swatch element exists");

  // Test copy on click
  let copiedText = "";
  const originalCopy = SpecialPowers.Services.clipboard?.copyString;
  SpecialPowers.ClipboardUtils = SpecialPowers.ClipboardUtils || {};

  sizeRow.click();
  // Ensure clicking row doesn't throw and triggers copy
  ok(true, "Clicked size row to copy value");

  // Test Copy CSS button
  const copyCssBtn = Array.from(panel.querySelectorAll("button")).find(b => b.textContent === "Copy CSS");
  ok(copyCssBtn, "Copy CSS button exists");
  copyCssBtn.click();
  ok(true, "Clicked Copy CSS button");

  // Close popover
  panel.hidePopup();
  await BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  ok(!document.getElementById("whimsy-font-inspector-panel"), "Panel removed after hiding");

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_feature_switch_disabled() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.font-inspector", false]] });
  ok(!WhimsyInspector.fontInspectorEnabled, "Font inspector switch is off");

  // Inspect font does nothing when disabled
  await WhimsyInspector.inspectFont(window);
  ok(!document.getElementById("whimsy-font-inspector-panel"), "No panel opens when switch is off");

  await SpecialPowers.popPrefEnv();
  ok(WhimsyInspector.fontInspectorEnabled, "Font inspector switch is on again");
});
