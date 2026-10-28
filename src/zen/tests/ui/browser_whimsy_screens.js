/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Whimsy: a screenshot tool, so changes can be checked by eye without macOS
// Screen Recording permission. It draws the real window from inside Gecko.
//   WHIMSY_SHOTS=/some/dir npm test -- ui/browser_whimsy_screens.js
// Without WHIMSY_SHOTS it only does a quick smoke check.

const SHOTS = Services.env.get("WHIMSY_SHOTS");

async function shot(name, windowGlobal = window.browsingContext.currentWindowGlobal) {
  if (!SHOTS) {
    return;
  }
  const bitmap = await windowGlobal.drawSnapshot(null, 1, "white");
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  const blob = await new Promise(resolve => canvas.toBlob(resolve));
  const path = PathUtils.join(SHOTS, `${name}.png`);
  await IOUtils.write(path, new Uint8Array(await blob.arrayBuffer()));
  info(`Saved ${path}`);
}

add_task(async function window_with_tabs() {
  const tabs = [];
  for (const url of ["https://example.com/", "https://example.org/"]) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, url));
  }
  await shot("01-window");

  // The tab context menu: every item labelled, and wide enough to read.
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(tabs[0], { type: "contextmenu", button: 2 });
  await shown;
  const items = [...menu.children].filter(
    el => el.localName == "menuitem" && !el.hidden && el.checkVisibility()
  );
  ok(items.length > 3, "The tab context menu has items");
  // Some labels (like Mute Tab) are set as the menu opens and arrive a moment later.
  await TestUtils.waitForCondition(
    () => items.every(item => item.getAttribute("label")),
    "Every menu item gets a label"
  ).catch(() => {});
  for (const item of items) {
    ok(item.getAttribute("label"), `Menu item ${item.id} has a label`);
  }
  Assert.greater(menu.getBoundingClientRect().width, 150, "The menu is wide enough to read");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;

  for (const tab of tabs) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function settings_app_icon() {
  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const doc = browser.contentDocument;
    const group = await TestUtils.waitForCondition(() => doc.getElementById("zenAppIconGroup"));
    await TestUtils.waitForCondition(() => group.checkVisibility(), "App icon settings visible");
    group.scrollIntoView({ block: "start" });
    await new Promise(resolve => browser.contentWindow.requestAnimationFrame(resolve));
    await shot("02-settings-app-icon", browser.browsingContext.currentWindowGlobal);
  });
});
