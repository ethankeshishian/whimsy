/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9: W9-02 Element Inspector Lite.
// Pick an element to inspect its box model (margin, border, padding, content),
// colours, and text-contrast ratio (WCAG pass/fail).
// Hold Option or select two elements to measure the distance/gap between them.
// Shares the element picker with Zap and W9-01. Includes "Open in DevTools" link.

const { WhimsyInspector } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyInspector.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");

const PAGE = "https://example.com/document-builder.sjs?html=" + encodeURIComponent(`
  <html>
    <head><title>Element Inspector Test</title></head>
    <body>
      <div id="box-card" style="margin: 16px; border: 2px solid rgb(0,0,0); padding: 12px; width: 220px; height: 120px; color: rgb(0, 0, 0); background-color: rgb(255, 255, 255);">
        <p id="box-text" style="font-size: 16px; margin: 0;">Card Text</p>
      </div>
      <div id="box-neighbor" style="margin: 16px; width: 220px; height: 60px; background-color: rgb(240, 240, 240);">
        Neighbor Box
      </div>
    </body>
  </html>
`);

add_task(async function test_element_inspector_commands() {
  ok(WhimsyInspector.elementInspectorEnabled, "Element Inspector is enabled by default");

  const cmdInspect = WhimsyCommands.get("cmd_whimsyInspectElement");
  ok(cmdInspect, "cmd_whimsyInspectElement is registered in WhimsyCommands");
  is(cmdInspect.l10nId, "whimsy-action-inspect-element", "Inspect Element command has correct l10n id");

  const cmdMeasure = WhimsyCommands.get("cmd_whimsyMeasureGap");
  ok(cmdMeasure, "cmd_whimsyMeasureGap is registered in WhimsyCommands");
  is(cmdMeasure.l10nId, "whimsy-action-measure-gap", "Measure Gap command has correct l10n id");
});

add_task(async function test_element_inspector_picker_and_box_model() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;

  // Start picker in element mode
  const started = WhimsyInspector.startPicker(window, "element");
  ok(started, "Picker started in element mode");

  // Inspect element by selector
  await WhimsyInspector.inspectElementBySelector(window, "#box-card");

  const panel = document.getElementById("whimsy-element-inspector-panel");
  ok(panel, "Element inspector panel was opened");
  ok(panel.classList.contains("whimsy-surface"), "A Whimsy surface (W13 F10)");

  // The header: the element's short name, its full selector as the tooltip.
  const tag = panel.querySelector(".whimsy-surface-header .whimsy-element-tag");
  is(tag?.textContent, "div#box-card", "Tag shows the element's short name");
  is(tag?.title, "#box-card", "Tag tooltip shows full CSS selector");
  is(panel.querySelector(".whimsy-element-dims").textContent, "220 × 120", "Its size beside it");

  const boxModel = panel.querySelector(".whimsy-box-model-container");
  ok(boxModel, "Box model container exists");

  const mTop = panel.querySelector(".whimsy-box-margin .whimsy-box-val-top");
  is(mTop?.textContent, "16", "Margin top is 16");

  const bTop = panel.querySelector(".whimsy-box-border .whimsy-box-val-top");
  is(bTop?.textContent, "2", "Border top is 2");

  const pTop = panel.querySelector(".whimsy-box-padding .whimsy-box-val-top");
  is(pTop?.textContent, "12", "Padding top is 12");

  const contentBox = panel.querySelector(".whimsy-box-content");
  ok(contentBox?.textContent.includes("220 × 120"), `Content dimensions are 220 × 120: ${contentBox?.textContent}`);

  // Colours as rows, each with its role.
  const roles = [...panel.querySelectorAll(".whimsy-element-color .whimsy-color-chip-label")].map(l => l.getAttribute("data-l10n-id"));
  Assert.deepEqual(roles, ["whimsy-element-text-color", "whimsy-element-bg-color"], "Text and background rows");
  is(panel.querySelector('[data-color="text"] .whimsy-element-color-value').textContent, "#000000", "Text colour");
  is(panel.querySelector('[data-color="background"] .whimsy-element-color-value').textContent, "#FFFFFF", "Background");

  const ratioLabel = panel.querySelector('[data-fact="contrast"] .k');
  is(ratioLabel?.getAttribute("data-l10n-id"), "whimsy-element-contrast-ratio", "Contrast ratio label has data-l10n-id");

  const ratio = panel.querySelector(".whimsy-contrast-ratio");
  is(ratio?.textContent, "21.00:1", "Contrast ratio is truncated to two decimal places: 21.00:1");

  const badge = panel.querySelector(".whimsy-wcag-badge");
  ok(badge?.classList.contains("pass"), "WCAG badge shows pass for black on white");
  await document.l10n.translateFragment(panel);
  ok(badge?.textContent.includes("WCAG"), `Badge text: ${badge?.textContent}`);

  // Actions in the footer.
  const labels = [...panel.querySelectorAll(".whimsy-surface-footer button")].map(b => b.getAttribute("label"));
  ok(labels.includes("Open in DevTools"), "Open in DevTools button exists");
  ok(labels.includes("Pick Another"), "Pick Another button exists");

  // Close panel
  panel.hidePopup();
  await BrowserTestUtils.waitForPopupEvent(panel, "hidden");

  // Stop picker
  WhimsyInspector.stopPicker(window);
  ok(!WhimsyInspector._activePickers.has(window), "Picker stopped");

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_element_inspector_gap_measurement() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;

  // Test gap measurement calculation between two elements
  const gapResult = await SpecialPowers.spawn(browser, [], () => {
    const el1 = content.document.getElementById("box-card");
    const el2 = content.document.getElementById("box-neighbor");
    const r1 = el1.getBoundingClientRect();
    const r2 = el2.getBoundingClientRect();
    const gapY = Math.round(r2.top - r1.bottom);
    return { gapY, r1Top: r1.top, r2Top: r2.top };
  });

  ok(gapResult.gapY >= 0, `Measured vertical gap between elements: ${gapResult.gapY}px`);

  // Verify onGapMeasured notification handler displays whimsy-element-gap-toast
  let shownToast = null;
  const originalShowToast = window.gZenUIManager?.showToast;
  window.gZenUIManager = window.gZenUIManager || {};
  window.gZenUIManager.showToast = (id, options) => {
    shownToast = { id, options };
  };

  WhimsyInspector.onGapMeasured(window, {
    firstSelector: "#box-card",
    secondSelector: "#box-neighbor",
    gapX: 0,
    gapY: gapResult.gapY,
  });

  is(shownToast?.id, "whimsy-element-gap-toast", "onGapMeasured uses dedicated gap toast, not copied toast");
  is(shownToast?.options?.l10nArgs?.gapX, 0, "Toast l10nArgs has gapX");
  is(shownToast?.options?.l10nArgs?.gapY, gapResult.gapY, "Toast l10nArgs has gapY");

  if (originalShowToast) {
    window.gZenUIManager.showToast = originalShowToast;
  } else {
    delete window.gZenUIManager.showToast;
  }

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_element_inspector_disabled() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.element-inspector", false]] });
  ok(!WhimsyInspector.elementInspectorEnabled, "Element inspector switch is off");

  WhimsyInspector.startPicker(window, "element");
  ok(!WhimsyInspector._activePickers.has(window), "Cannot start picker when switch is off");

  await SpecialPowers.popPrefEnv();
  ok(WhimsyInspector.elementInspectorEnabled, "Element inspector switch is on again");
});

add_task(async function test_inspector_settings_switches() {
  const tabsTemplate = document.getElementById("template-whimsyTabs");
  if (tabsTemplate) {
    const content = tabsTemplate.content;
    const fontCb = content.querySelector("#whimsyFontInspector");
    ok(fontCb, "whimsyFontInspector checkbox exists in Settings Tab Management template");
    is(fontCb?.getAttribute("preference"), "whimsy.feature.font-inspector", "Controls whimsy.feature.font-inspector");
    is(fontCb?.getAttribute("data-l10n-id"), "whimsy-tabs-font-inspector", "Has whimsy-tabs-font-inspector string");

    const elCb = content.querySelector("#whimsyElementInspector");
    ok(elCb, "whimsyElementInspector checkbox exists in Settings Tab Management template");
    is(elCb?.getAttribute("preference"), "whimsy.feature.element-inspector", "Controls whimsy.feature.element-inspector");
    is(elCb?.getAttribute("data-l10n-id"), "whimsy-tabs-element-inspector", "Has whimsy-tabs-element-inspector string");
  }
});

// W9-16: the picker's overlay in the page (anonymous content) is styled by
// whimsy-inspector.css, and its hint, "Esc to stop" included, is localized.
add_task(async function test_picker_overlay_styled_and_localized() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  ok(WhimsyInspector.startPicker(window, "element"), "Picker started");
  const expected = await new Localization(["browser/whimsy.ftl"], true).formatValue("whimsy-element-picker-hint");
  ok(expected.includes("Esc"), "the string says how to stop");
  const overlay = await SpecialPowers.spawn(browser, [], async () => {
    const actor = content.windowGlobalChild.getActor("WhimsyInspector");
    await ContentTaskUtils.waitForCondition(() => actor._hintPill, "the hint pill is shown");
    await ContentTaskUtils.waitForCondition(
      () => content.getComputedStyle(actor._hintPill).position == "fixed",
      "the overlay sheet applies to the page's anonymous content"
    );
    const style = content.getComputedStyle(actor._hintPill);
    const outline = content.getComputedStyle(actor._hoverOutline);
    return { text: actor._hintPill.textContent, position: style.position, outline: outline.position };
  });
  is(overlay.text, expected, "the hint comes from whimsy.ftl");
  is(overlay.position, "fixed", "the hint pill is styled");
  is(overlay.outline, "fixed", "the hover outline is styled");
  WhimsyInspector.stopPicker?.(window);
  BrowserTestUtils.removeTab(tab);
});

// W10-45: Element Info is in the right-click menu, beside Inspect, and opens
// on the element that was right-clicked; the command bar finds it by other
// words too.
add_task(async function test_element_info_from_the_context_menu() {
  const { WhimsyMenuPrefs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMenuPrefs.sys.mjs");
  for (const menuId of ["page", "selection", "image", "link", "media"]) {
    ok(
      WhimsyMenuPrefs.items(menuId).some(entry => entry.id == "element-info"),
      `Settings → Menus lists Element Info in the ${menuId} menu`
    );
    // W10-45 (user): the row starts off, like the other rows W9-09 added.
    ok(WhimsyMenuPrefs.isHidden(menuId, "element-info"), `…off by default (${menuId})`);
    ok(WhimsyMenuPrefs.defaultHiddenIds(menuId).has("element-info"), `…by the pref's default (${menuId})`);
  }
  // Turned on in Settings → Menus, it shows beside Inspect.
  WhimsyMenuPrefs.setHidden("page", "element-info", false);
  registerCleanupFunction(() => WhimsyMenuPrefs.restoreDefaults("page"));
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const action = globalActions.find(a => a.l10nId == "whimsy-action-inspect-element");
  const keywords = action?.whimsyKeywords ?? [];
  ok(String(keywords).toLowerCase().includes("box model"), "The command bar also finds it as Box Model");

  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const menu = document.getElementById("contentAreaContextMenu");
  const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
  await BrowserTestUtils.synthesizeMouseAtCenter("#box-neighbor", { type: "contextmenu", button: 2 }, tab.linkedBrowser);
  await shown;
  const item = document.getElementById("context-whimsy-element-info");
  ok(item && !item.hidden && item.getAttribute("collapsed") != "true", "Element Info is in the menu");
  const inspect = document.getElementById("context-inspect");
  if (inspect && !inspect.hidden) {
    let node = inspect.nextElementSibling;
    while (node && node != item && node.id == "context-inspect-a11y") {
      node = node.nextElementSibling;
    }
    is(node?.id, item.id, "right after Inspect");
  }
  const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
  menu.activateItem(item);
  await hidden;
  const panel = await TestUtils.waitForCondition(
    () => document.getElementById("whimsy-element-inspector-panel"),
    "Element Info opens"
  );
  await TestUtils.waitForCondition(
    () => panel.querySelector(".whimsy-element-tag")?.title == "#box-neighbor",
    "on the element that was right-clicked"
  );
  const closed = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  panel.hidePopup();
  await closed;
  BrowserTestUtils.removeTab(tab);
});
