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
  is(panel.getAttribute("size"), "medium", "Panel uses medium sheet width");

  // Check selector header
  const tag = panel.querySelector(".whimsy-element-tag");
  ok(tag?.textContent.includes("box-card"), `Tag contains selector: ${tag?.textContent}`);

  // Check Box Model concentric values
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

  // Check Colours and Contrast ratio
  const contrastCard = panel.querySelector(".whimsy-contrast-card");
  ok(contrastCard, "Contrast card exists");

  const ratio = panel.querySelector(".whimsy-contrast-ratio");
  ok(ratio?.textContent.includes(":1"), `Contrast ratio is displayed: ${ratio?.textContent}`);

  const badge = panel.querySelector(".whimsy-wcag-badge");
  ok(badge?.classList.contains("pass"), "WCAG badge shows pass for black on white");
  ok(badge?.textContent.includes("WCAG"), `Badge text: ${badge?.textContent}`);

  // Check DevTools link
  const devtoolsBtn = Array.from(panel.querySelectorAll("button")).find(b => b.textContent === "Open in DevTools");
  ok(devtoolsBtn, "Open in DevTools button exists");

  // Check Inspect Font button
  const fontBtn = Array.from(panel.querySelectorAll("button")).find(b => b.textContent === "Inspect Font");
  ok(fontBtn, "Inspect Font button exists");

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
