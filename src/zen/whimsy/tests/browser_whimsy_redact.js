/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave5: Redact in the Screenshots panel. Detectors, the remembered toggle,
// click-to-blur through the overlay, captures carrying the blur (visible
// and full page), cleanup afterwards, and the feature switch.

const { WhimsyRedact } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyRedactParent.sys.mjs");
const { ScreenshotsUtils } = ChromeUtils.importESModule("moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs");
const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_redact.html";
const SECRET = ["email", "phone", "key", "card", "bottom", "fixedmail"];
const CLEAN = ["notcard", "date", "plain"];

function buttons(browser) {
  return ScreenshotsUtils.panelForBrowser(browser)?.querySelector("screenshots-buttons")?.shadowRoot;
}

async function openScreenshots(browser) {
  await ScreenshotsUtils.start(browser, "Shortcut");
  await TestUtils.waitForCondition(() => {
    const panel = ScreenshotsUtils.panelForBrowser(browser);
    return panel && !panel.hidden && buttons(browser)?.getElementById("visible-page");
  }, "The Screenshots panel shows");
  await TestUtils.waitForCondition(
    () => SpecialPowers.spawn(browser, [], () => !!content.windowGlobalChild.getExistingActor("ScreenshotsComponent")?.overlay?.initialized),
    "The Screenshots overlay is up"
  );
}

async function closeScreenshots(browser) {
  ScreenshotsUtils.cancel(browser, "Escape");
  await TestUtils.waitForCondition(async () => !(await WhimsyRedact.state(browser))?.active, "Redaction is cleared");
}

// Page rects of the fixture's spans.
function spanRects(browser) {
  return SpecialPowers.spawn(browser, [[...SECRET, ...CLEAN]], ids => {
    const out = {};
    for (const id of ids) {
      const r = content.document.getElementById(id).getBoundingClientRect();
      out[id] = { left: r.left + content.scrollX, top: r.top + content.scrollY, width: r.width, height: r.height };
    }
    return out;
  });
}

function covered(boxes, r) {
  return boxes.some(b => {
    const w = Math.min(b.left + b.width, r.left + r.width) - Math.max(b.left, r.left);
    const h = Math.min(b.top + b.height, r.top + r.height) - Math.max(b.top, r.top);
    return w > 0 && h > 0 && w * h >= 0.6 * r.width * r.height;
  });
}

async function boxes(browser) {
  return (await WhimsyRedact.state(browser))?.rects ?? [];
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["screenshots.browser.component.enabled", true],
      ["whimsy.feature.redact", true],
      ["whimsy.capture.redact", false],
    ],
  });
});

add_task(async function test_toggle_detectors_and_cleanup() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  await openScreenshots(browser);
  const button = buttons(browser).getElementById("whimsy-redact");
  ok(button, "Redact sits in the Screenshots panel");
  is(button.getAttribute("data-l10n-id"), "whimsy-redact-button", "with its string");
  is(button.getAttribute("aria-pressed"), "false", "off by default");
  ok(!(await WhimsyRedact.state(browser))?.active, "and nothing is blurred");

  button.click();
  ok(Services.prefs.getBoolPref("whimsy.capture.redact"), "The toggle is remembered");
  is(button.getAttribute("aria-pressed"), "true", "and shows pressed");
  await TestUtils.waitForCondition(async () => (await boxes(browser)).length >= SECRET.length, "Sensitive text is blurred");

  const rects = await spanRects(browser);
  const found = await boxes(browser);
  for (const id of SECRET) {
    ok(covered(found, rects[id]), `#${id} is blurred`);
  }
  for (const id of CLEAN) {
    ok(!covered(found, rects[id]), `#${id} is left alone`);
  }

  // A fixed element moves on the page as it scrolls; its box follows.
  await SpecialPowers.spawn(browser, [], () => content.scrollTo(0, 300));
  await TestUtils.waitForCondition(async () => {
    const r = (await spanRects(browser)).fixedmail;
    return covered(await boxes(browser), r);
  }, "The box follows a fixed element on scroll");
  await SpecialPowers.spawn(browser, [], () => content.scrollTo(0, 0));

  await closeScreenshots(browser);
  is((await boxes(browser)).length, 0, "Cancelling puts the page back");

  // Reopening applies the remembered state.
  await openScreenshots(browser);
  is(buttons(browser).getElementById("whimsy-redact").getAttribute("aria-pressed"), "true", "Still on next time");
  await TestUtils.waitForCondition(async () => (await WhimsyRedact.state(browser))?.active, "and redacts right away");
  await closeScreenshots(browser);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_click_to_blur() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.capture.redact", true]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  await openScreenshots(browser);
  await TestUtils.waitForCondition(async () => (await WhimsyRedact.state(browser))?.active, "Redaction is on");

  await BrowserTestUtils.synthesizeMouseAtCenter("#plain", {}, browser);
  await TestUtils.waitForCondition(async () => (await WhimsyRedact.state(browser))?.added == 1, "Clicking text blurs it");
  ok(covered(await boxes(browser), (await spanRects(browser)).plain), "#plain is now blurred");
  ok(!ScreenshotsUtils.browserToScreenshotsState.get(browser)?.hasOverlaySelection, "The click didn't select the element");
  ok(!ScreenshotsUtils.panelForBrowser(browser).hidden, "and the panel stays up");

  await BrowserTestUtils.synthesizeMouseAtCenter("#plain", {}, browser);
  await TestUtils.waitForCondition(async () => (await WhimsyRedact.state(browser))?.added == 0, "A second click unblurs it");
  ok(!covered(await boxes(browser), (await spanRects(browser)).plain), "#plain is clear again");

  await BrowserTestUtils.synthesizeMouseAtCenter("#email", {}, browser);
  await TestUtils.waitForCondition(async () => (await WhimsyRedact.state(browser))?.removed == 1, "Clicking a detected email unblurs it");
  ok(!covered(await boxes(browser), (await spanRects(browser)).email), "#email is clear");

  // Dragging still selects a region.
  await BrowserTestUtils.synthesizeMouse("#date", -40, -40, { type: "mousedown" }, browser);
  await BrowserTestUtils.synthesizeMouse("#date", 100, 60, { type: "mousemove" }, browser);
  await BrowserTestUtils.synthesizeMouse("#date", 200, 120, { type: "mousemove" }, browser);
  await BrowserTestUtils.synthesizeMouse("#date", 200, 120, { type: "mouseup" }, browser);
  await TestUtils.waitForCondition(() => ScreenshotsUtils.browserToScreenshotsState.get(browser)?.hasOverlaySelection, "A drag selects a region");
  is((await WhimsyRedact.state(browser))?.added, 0, "and blurs nothing");

  await closeScreenshots(browser);
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

function averageDiff(a, b, rect, region) {
  const dpr = region.devicePixelRatio;
  const x = Math.max(0, Math.round((rect.left - region.left) * dpr));
  const y = Math.max(0, Math.round((rect.top - region.top) * dpr));
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  const da = a.getContext("2d").getImageData(x, y, w, h).data;
  const db = b.getContext("2d").getImageData(x, y, w, h).data;
  let sum = 0;
  for (let i = 0; i < da.length; i++) {
    sum += Math.abs(da[i] - db[i]);
  }
  return sum / da.length;
}

add_task(async function test_full_page_capture_has_redactions() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.capture.redact", true]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  await openScreenshots(browser);
  await TestUtils.waitForCondition(async () => (await boxes(browser)).length >= SECRET.length, "Redaction is on");
  const rects = await spanRects(browser);

  // What takeScreenshot does: hide the overlay, then draw.
  ScreenshotsUtils.closeOverlay(browser);
  const region = await ScreenshotsUtils.fetchFullPageBounds(browser);
  const redacted = await ScreenshotsUtils.createCanvas({ ...region }, browser);
  ok(!(await WhimsyRedact.state(browser))?.active, "The page is back to normal once the image is made");
  const clean = await ScreenshotsUtils.createCanvas({ ...region }, browser);

  for (const id of ["email", "card", "bottom"]) {
    Assert.greater(averageDiff(redacted, clean, rects[id], region), 4, `#${id} is blurred in the full-page image`);
  }
  Assert.less(averageDiff(redacted, clean, rects.plain, region), 2, "Plain text is untouched");

  await closeScreenshots(browser);
  ScreenshotsUtils.exit(browser);
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_visible_button_clears_after_capture() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.capture.redact", true]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  await openScreenshots(browser);
  await TestUtils.waitForCondition(async () => (await WhimsyRedact.state(browser))?.active, "Redaction is on");
  const ready = TestUtils.topicObserved("screenshots-preview-ready");
  buttons(browser).getElementById("visible-page").click();
  await ready;
  ok(!(await WhimsyRedact.state(browser))?.active, "Visible capture leaves the page normal afterwards");
  ScreenshotsUtils.exit(browser);
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_feature_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.redact", false], ["whimsy.capture.redact", true]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  await openScreenshots(browser);
  ok(!buttons(browser).getElementById("whimsy-redact"), "No Redact button with the switch off");
  ok(!(await WhimsyRedact.state(browser))?.active, "and nothing is blurred");
  ScreenshotsUtils.cancel(browser, "Escape");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
