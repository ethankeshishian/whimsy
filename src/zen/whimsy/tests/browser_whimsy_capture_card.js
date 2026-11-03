/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W13 F04 (wave12 F04, option A): Redact after the capture. A Screenshots
// copy brings up a card at the page's bottom end: Copied · Save · Redact ·
// Edit, and what was hidden. "Hide private details" is on by default, so
// the copy already has them hidden. Redact opens the editor with the hand
// picked (drag a box: it's blacked out); Edit with nothing picked
// (Backdrop, Shape; remembered). Done copies the result and the card
// shows it. The Screenshots bar no longer has a Redact toggle.

const { WhimsyCaptureCard, layoutFor } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCaptureCard.sys.mjs");
const { WhimsyRedact } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyRedactParent.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { ScreenshotsUtils } = ChromeUtils.importESModule("moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs");
const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_redact.html";

const card = () => document.getElementById("whimsy-capture-card");
const editor = () => document.getElementById("whimsy-capture-editor");
const action = name => card().querySelector(`.whimsy-capture-action[data-action="${name}"]`);

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["screenshots.browser.component.enabled", true],
      ["whimsy.feature.redact", true],
      ["whimsy.feature.capture-card", true],
      ["whimsy.capture.redact-style", "black"],
      ["whimsy.capture.backdrop", "none"],
      ["whimsy.capture.shape", "auto"],
    ],
  });
});

add_task(function test_defaults_and_layout() {
  ok(Services.prefs.getDefaultBranch("").getBoolPref("whimsy.capture.redact"), "Hide private details is on by default");
  Assert.deepEqual(layoutFor(400, 200), { width: 400, height: 200, x: 0, y: 0, radius: 0 }, "No backdrop, Auto: the image as it is");
  const square = layoutFor(400, 200, { backdrop: "white", shape: "1:1" });
  is(square.width, square.height, "1:1 is square");
  Assert.greater(square.x, 0, "…with the image inset");
  const wide = layoutFor(300, 300, { backdrop: "dark", shape: "16:9" });
  Assert.less(Math.abs(wide.width / wide.height - 16 / 9), 0.01, "16:9");
  const tall = layoutFor(300, 300, { backdrop: "gradient", shape: "4:5" });
  Assert.less(Math.abs(tall.width / tall.height - 4 / 5), 0.01, "4:5");
});

// Frames the shot in Screenshots and copies a region, the way its Copy
// button does; returns the card.
async function captureAndCopy(browser) {
  await ScreenshotsUtils.start(browser, "Shortcut");
  await TestUtils.waitForCondition(() => {
    const panel = ScreenshotsUtils.panelForBrowser(browser);
    return panel && !panel.hidden && panel.querySelector("screenshots-buttons")?.shadowRoot?.getElementById("visible-page");
  }, "The Screenshots bar shows");
  const bar = ScreenshotsUtils.panelForBrowser(browser).querySelector("screenshots-buttons").shadowRoot;
  ok(!bar.getElementById("whimsy-redact"), "No Redact toggle in the bar: Redact comes after the capture");
  await TestUtils.waitForCondition(async () => (await WhimsyRedact.state(browser))?.active, "Private details are hidden while framing");
  const focused = document.activeElement;
  await ScreenshotsUtils.copyScreenshotFromRegion(
    { left: 0, top: 0, right: 700, bottom: 420, devicePixelRatio: window.devicePixelRatio },
    browser
  );
  ScreenshotsUtils.exit(browser);
  const panel = await TestUtils.waitForCondition(() => (card()?.state == "open" ? card() : null), "The card opens");
  is(document.activeElement, focused, "It doesn't take the keyboard");
  ok(!(await WhimsyRedact.state(browser))?.active, "The page is back to normal");
  return panel;
}

add_task(async function test_card_after_a_copy() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.capture.redact", true]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  const panel = await captureAndCopy(browser);

  // The card: the image, then Copied · Save · Redact · Edit.
  Assert.deepEqual([...panel.querySelectorAll(".whimsy-capture-action")].map(b => b.dataset.action),
    ["copy", "save", "redact", "edit"], "Copied · Save · Redact · Edit");
  ok(panel.querySelector(".whimsy-capture-thumb").src.startsWith("blob:"), "The image");
  const view = panel.querySelector(".whimsy-surface-view").getBoundingClientRect();
  Assert.less(Math.abs(view.width - (236 - 16)), 1.5, "236px wide");
  ok(action("copy").hasAttribute("done"), "Copied is done");
  isnot(getComputedStyle(action("copy")).color, getComputedStyle(action("save")).color, "…in green");

  // Where: the page's bottom end corner, 12px in.
  const area = document.getElementById("tabbrowser-tabbox").getBoundingClientRect();
  const box = panel.getOuterScreenRect();
  const bottom = window.mozInnerScreenY + area.bottom;
  Assert.less(Math.abs(bottom - (box.top + box.height) - 12), 3, "12px above the page's bottom");

  // What it hid: the fixture's email, phone, key and card (and its fixed email).
  const detail = panel.querySelector(".whimsy-capture-detail");
  await document.l10n.translateFragment(panel);
  const args = document.l10n.getAttributes(detail).args;
  is(args.kind, "mixed", "Several kinds hidden");
  Assert.greaterOrEqual(args.count, 4, `At least the email, phone, key and card (${args.count})`);
  ok(/private details hidden · drag out to make a file/.test(detail.textContent), `"${detail.textContent}"`);

  // Redact: the editor, hand picked; drag a box and it's blacked out.
  EventUtils.synthesizeMouseAtCenter(action("redact"), {});
  const ed = await TestUtils.waitForCondition(() => (editor()?.state == "open" ? editor() : null), "Redact opens the editor");
  is(ed.querySelector(".whimsy-capture-hand").getAttribute("aria-pressed"), "true", "…with Redact by hand picked");
  ok(ed.querySelector(".whimsy-surface-header").classList.contains("whimsy-surface-drag-handle"), "Its header drags it");
  ok(ed.querySelector("#whimsy-capture-hide").checked, "Hide private details is on, as the copy is");
  const preview = ed.querySelector(".whimsy-capture-preview");
  await TestUtils.waitForCondition(() => preview.width > 50, "The image is drawn");
  const p = preview.getBoundingClientRect();
  // The fixture's "Plain: Nothing secret here" row is around y=300 of 420.
  const from = { x: p.left + p.width * 0.1, y: p.top + p.height * 0.6 };
  const to = { x: p.left + p.width * 0.5, y: p.top + p.height * 0.75 };
  EventUtils.synthesizeMouseAtPoint(from.x, from.y, { type: "mousedown" });
  EventUtils.synthesizeMouseAtPoint((from.x + to.x) / 2, (from.y + to.y) / 2, { type: "mousemove" });
  EventUtils.synthesizeMouseAtPoint(to.x, to.y, { type: "mousemove" });
  EventUtils.synthesizeMouseAtPoint(to.x, to.y, { type: "mouseup" });
  const midX = Math.round((from.x + to.x) / 2 - p.left);
  const midY = Math.round((from.y + to.y) / 2 - p.top);
  const px = preview.getContext("2d").getImageData(Math.round(midX * preview.width / p.width), Math.round(midY * preview.height / p.height), 1, 1).data;
  Assert.deepEqual([...px.slice(0, 3)], [0, 0, 0], "The box is blacked out in the preview");

  // Done copies it, and the card shows what's hidden now.
  EventUtils.synthesizeMouseAtCenter(ed.querySelector(".whimsy-capture-toolbar .whimsy-surface-button"), {});
  await TestUtils.waitForCondition(() => !editor(), "Done closes the editor");
  const capture = WhimsyCaptureCard.lastCapture(window);
  ok(capture.edited, "The edit is what was copied");
  const bitmap = await createImageBitmap(capture.edited);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  const scale = bitmap.width / preview.width;
  const pixel = canvas.getContext("2d").getImageData(Math.round(midX * scale * preview.width / p.width), Math.round(midY * scale * preview.height / p.height), 1, 1).data;
  Assert.deepEqual([...pixel.slice(0, 3)], [0, 0, 0], "…blacked out in the copied image too");
  await document.l10n.translateFragment(card());
  is(document.l10n.getAttributes(detail).args.count, args.count + 1, "The card counts the hand-drawn box");

  // Edit: nothing picked; a backdrop and a shape, remembered.
  EventUtils.synthesizeMouseAtCenter(action("edit"), {});
  const ed2 = await TestUtils.waitForCondition(() => (editor()?.state == "open" ? editor() : null), "Edit opens the editor");
  is(ed2.querySelector(".whimsy-capture-hand").getAttribute("aria-pressed"), "false", "…with nothing picked");
  EventUtils.synthesizeMouseAtCenter(ed2.querySelector('.whimsy-capture-backdrop[data-backdrop="white"]'), {});
  is(Services.prefs.getStringPref("whimsy.capture.backdrop"), "white", "The backdrop is remembered");
  is(ed2.querySelector('.whimsy-capture-backdrop[data-backdrop="white"]').getAttribute("aria-checked"), "true", "…and picked");
  EventUtils.synthesizeMouseAtCenter(ed2.querySelector('.whimsy-surface-segment[data-value="1:1"]'), {});
  is(Services.prefs.getStringPref("whimsy.capture.shape"), "1:1", "The shape is remembered");
  EventUtils.synthesizeMouseAtCenter(ed2.querySelector(".whimsy-capture-toolbar .whimsy-surface-button"), {});
  await TestUtils.waitForCondition(() => !editor(), "Done");
  const square = await createImageBitmap(WhimsyCaptureCard.lastCapture(window).edited);
  is(square.width, square.height, "1:1 came out square");

  // Switching tabs puts the card away.
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  await TestUtils.waitForCondition(() => !card(), "The card goes with the tab switch");
  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_hide_private_details_can_be_turned_off_after() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.capture.redact", true], ["whimsy.capture.backdrop", "none"], ["whimsy.capture.shape", "auto"]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await captureAndCopy(tab.linkedBrowser);
  EventUtils.synthesizeMouseAtCenter(action("edit"), {});
  const ed = await TestUtils.waitForCondition(() => (editor()?.state == "open" ? editor() : null), "The editor");
  const hide = ed.querySelector("#whimsy-capture-hide");
  ok(hide.checked, "On, as captured");
  EventUtils.synthesizeMouseAtCenter(hide, {});
  await TestUtils.waitForCondition(() => !hide.checked && !hide.disabled, "Off: the same region again, unhidden");
  ok(!Services.prefs.getBoolPref("whimsy.capture.redact"), "…and remembered for the next capture");
  ok(!(await WhimsyRedact.state(tab.linkedBrowser))?.active, "The page is left normal");
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(() => !editor(), "Esc closes the editor without copying");
  ok(!WhimsyCaptureCard.lastCapture(window).edited, "Nothing was copied");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(function test_commands() {
  for (const id of ["cmd_whimsyCaptureEdit", "cmd_whimsyCaptureRedactLast", "cmd_whimsyCaptureRedact"]) {
    const entry = WhimsyCommands.get(id);
    ok(entry?.keyId && document.getElementById(entry.keyId), `${id} has a key Settings can bind`);
  }
});
