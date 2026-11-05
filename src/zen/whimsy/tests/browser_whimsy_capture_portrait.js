/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/small: Capture in Portrait Mode (Arc's File menu) lays the page out at
// a phone's width for the shot, copies a 9:16 image, and puts the browser back.

const RESPONSIVE =
  "https://example.com/document-builder.sjs?html=" +
  encodeURIComponent(
    "<meta name=viewport content='width=device-width'><body style='margin:0'><div id=w style='height:3000px'>Wide</div></body>"
  );
const { WhimsyPage } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPage.sys.mjs");

function clipboardHasImage() {
  return Services.clipboard.hasDataMatchingFlavors(
    ["image/png", "image/jpeg", "application/x-moz-nativeimage"],
    Services.clipboard.kGlobalClipboard
  );
}

add_task(async function test_portrait_phone_width() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, RESPONSIVE);
  const browser = tab.linkedBrowser;
  const before = await SpecialPowers.spawn(browser, [], () => content.innerWidth);
  ok(before > WhimsyPage.PORTRAIT_WIDTH, `The page starts wider than a phone (${before}px)`);
  SpecialPowers.clipboardCopyString("not an image");
  const size = await WhimsyPage.copyPortraitScreenshot(window);
  ok(size, "Captured");
  ok(size.layoutWidth <= WhimsyPage.PORTRAIT_WIDTH + 1, `Laid out at a phone's width (${size.layoutWidth}px)`);
  ok(size.width <= WhimsyPage.PORTRAIT_WIDTH, `The image is phone-wide (${size.width}px)`);
  Assert.lessOrEqual(Math.abs(size.width / size.height - 9 / 16), 0.01, "A 9:16 frame");
  ok(clipboardHasImage(), "The clipboard holds the image");
  is(browser.style.maxWidth, "", "The browser's width is put back");
  await TestUtils.waitForCondition(
    () => SpecialPowers.spawn(browser, [], () => content.innerWidth).then(w => w == before),
    "The page reflows back to its width"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_portrait_command_and_switch() {
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const action = globalActions.find(a => a.l10nId == "whimsy-action-capture-portrait");
  ok(action, "The command bar has Capture in Portrait Mode");
  const blank = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  ok(!action.isAvailable(window), "Not offered on a blank tab");
  is(await WhimsyPage.copyPortraitScreenshot(window), null, "and does nothing there");
  BrowserTestUtils.removeTab(blank);
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.capture", false]] });
  ok(!action.isAvailable(window), "The switch hides it");
  await SpecialPowers.popPrefEnv();
});

add_task(function test_portrait_rect_top_anchored() {
  const tall = WhimsyPage.portraitRect({ left: 0, top: 100, width: 390, height: 900 });
  is(tall.top, 100, "A tall view keeps its top (what a phone shows)");
  is(tall.height, Math.round(390 / (9 / 16)), "and is cropped to 9:16");
});

// W10-59: Portrait is a tile in the Screenshots bar, between Visible and
// Full Page, in their style; it opens the same preview with a phone-shaped
// shot, and the command stays.
add_task(async function test_portrait_tile_in_the_bar() {
  const { ScreenshotsUtils } = ChromeUtils.importESModule("moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs");
  await SpecialPowers.pushPrefEnv({ set: [["screenshots.browser.component.enabled", true]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, RESPONSIVE);
  const browser = tab.linkedBrowser;
  const root = () => ScreenshotsUtils.panelForBrowser(browser)?.querySelector("screenshots-buttons")?.shadowRoot;
  await ScreenshotsUtils.start(browser, "Shortcut");
  await TestUtils.waitForCondition(() => root()?.getElementById("whimsy-portrait"), "The bar has a Portrait tile");
  // The overlay finishes starting before the click (as it has for anyone
  // clicking by hand); it shows the bar again when it does.
  await TestUtils.waitForCondition(
    () => SpecialPowers.spawn(browser, [], () => !!content.windowGlobalChild.getExistingActor("ScreenshotsComponent")?.overlay?.initialized),
    "The Screenshots overlay is up"
  );

  const tile = root().getElementById("whimsy-portrait");
  const visible = root().getElementById("visible-page");
  const full = root().getElementById("full-page");
  is(tile.parentNode, visible.parentNode, "beside Visible and Full Page");
  is(tile.className, visible.className, "in the same style");
  is(tile.getAttribute("data-l10n-id"), "whimsy-portrait-button", "with its name");
  const [v, p, f] = [visible, tile, full].map(el => el.getBoundingClientRect());
  ok(v.left < p.left && p.left < f.left, "between them");
  is(Math.round(p.height), Math.round(v.height), "and as tall");

  const ready = TestUtils.topicObserved("screenshots-preview-ready");
  tile.click();
  await ready;
  const state = ScreenshotsUtils.browserToScreenshotsState.get(browser);
  const preview = state.previewDialog._frame.contentDocument.querySelector("screenshots-preview");
  const img = preview.previewImg;
  // W15: the same viewer as Visible, Full Page and Capture.
  const viewer = await TestUtils.waitForCondition(() => preview.renderRoot?.getElementById("whimsy-capture-save-close") && preview.renderRoot,
    "The screenshot viewer's buttons");
  Assert.deepEqual([...viewer.querySelector(".preview-buttons").children].filter(b => b.getBoundingClientRect().width > 0).map(b => b.id),
    ["retry", "whimsy-capture-easel", "copy", "download", "whimsy-capture-edit", "whimsy-capture-save-close", "cancel"],
    "Retry · Add to Easel · Copy · Download · Edit · Save and Close · Cancel");
  await TestUtils.waitForCondition(() => img.complete && img.naturalWidth, "The preview shows the shot");
  Assert.lessOrEqual(Math.abs(img.naturalWidth / img.naturalHeight - 9 / 16), 0.01, "A 9:16 phone shot");
  ok(ScreenshotsUtils.panelForBrowser(browser).hidden, "The bar is out of the way");
  is(browser.style.width, "", "The browser's width is put back");

  ScreenshotsUtils.exit(browser);
  ok(document.getElementById("cmd_whimsyCapturePortrait"), "Capture in Portrait Mode is still a command");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_portrait_tile_follows_the_switch() {
  const { ScreenshotsUtils } = ChromeUtils.importESModule("moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs");
  await SpecialPowers.pushPrefEnv({ set: [["screenshots.browser.component.enabled", true], ["whimsy.feature.capture", false]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, RESPONSIVE);
  const browser = tab.linkedBrowser;
  await ScreenshotsUtils.start(browser, "Shortcut");
  const root = () => ScreenshotsUtils.panelForBrowser(browser)?.querySelector("screenshots-buttons")?.shadowRoot;
  await TestUtils.waitForCondition(() => root()?.getElementById("visible-page"), "The bar shows");
  ok(!root().getElementById("whimsy-portrait"), "No Portrait tile with Capture's switch off");
  ScreenshotsUtils.cancel(browser, "Escape");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
