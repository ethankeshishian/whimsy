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
