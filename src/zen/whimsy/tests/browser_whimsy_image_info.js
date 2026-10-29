/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Image info: right-click an image → "View Image Info" opens Page Info on
// the image (dimensions, size, type, alt text).

const PAGE =
  "https://example.com/document-builder.sjs?html=" +
  encodeURIComponent("<img id=img alt='A test image' width=64 height=64 src='/browser/zen/whimsy/tests/whimsy_test_image.png'>");

add_task(async function test_view_image_info() {
  ok(Services.prefs.getBoolPref("browser.menu.showViewImageInfo"), "The item is on");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const menu = document.getElementById("contentAreaContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  await BrowserTestUtils.synthesizeMouseAtCenter("#img", { type: "contextmenu", button: 2 }, tab.linkedBrowser);
  await shown;
  const item = document.getElementById("context-viewimageinfo");
  ok(item && !item.hidden, "View Image Info is on the image menu");
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(null, win => win.document.documentURI.startsWith("chrome://browser/content/pageinfo/pageInfo.xhtml"));
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(item);
  await hidden;
  const pageInfo = await opened;
  ok(pageInfo, "It opens Page Info");
  await BrowserTestUtils.closeWindow(pageInfo);
  BrowserTestUtils.removeTab(tab);
});
