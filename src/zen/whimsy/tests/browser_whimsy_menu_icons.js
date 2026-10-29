/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Menu icons (macOS 26 style): context menu and tab menu items carry Zen's
// monochrome icons; checkbox items stay plain; the Settings option and the
// feature switch turn them off.

const FEATURE = "whimsy.feature.menu-icons";
const OPTION = "whimsy.look.menu-icons";
const PAGE = `data:text/html,<a id="l" href="https://example.com/" style="display:block;padding:40px">go</a>`;

registerCleanupFunction(() => {
  Services.prefs.clearUserPref(FEATURE);
  Services.prefs.clearUserPref(OPTION);
});

function iconOf(id) {
  const icon = document.getElementById(id)?.querySelector(":scope > .menu-icon");
  return icon ? window.getComputedStyle(icon).content : null;
}

async function withLinkMenu(tab, fn) {
  const menu = document.getElementById("contentAreaContextMenu");
  const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
  await BrowserTestUtils.synthesizeMouseAtCenter("#l", { type: "contextmenu", button: 2 }, tab.linkedBrowser);
  await shown;
  try {
    await fn();
  } finally {
    const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
    menu.hidePopup();
    await hidden;
  }
}

add_task(async function test_icons() {
  ok(Services.prefs.getBoolPref(OPTION), "On by default");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await withLinkMenu(tab, async () => {
    ok(iconOf("context-openlinkintab")?.includes("zen-icons/plus.svg"), "Open Link in New Tab has an icon");
    ok(iconOf("context-copylink")?.includes("zen-icons/link.svg"), "Copy Link has an icon");
  });

  Services.prefs.setBoolPref(OPTION, false);
  await withLinkMenu(tab, async () => {
    ok(!iconOf("context-copylink")?.includes("zen-icons/"), "The option turns them off");
  });
  Services.prefs.clearUserPref(OPTION);

  Services.prefs.setBoolPref(FEATURE, false);
  await withLinkMenu(tab, async () => {
    ok(!iconOf("context-copylink")?.includes("zen-icons/"), "So does the feature switch");
  });
  Services.prefs.clearUserPref(FEATURE);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_tab_menu() {
  const tab = BrowserTestUtils.addTab(gBrowser, "about:blank", { skipAnimation: true });
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
  await shown;
  ok(iconOf("context_duplicateTab")?.includes("zen-icons/duplicate-tab.svg"), "Duplicate Tab has an icon");
  ok(iconOf("context_closeTab")?.includes("zen-icons/close.svg"), "Close Tab has an icon");
  const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
  menu.hidePopup();
  await hidden;
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_setting() {
  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const box = await TestUtils.waitForCondition(() => browser.contentDocument.getElementById("whimsyMenuIcons"));
    ok(box, "Settings → Look and Feel has the option");
    await TestUtils.waitForCondition(() => box.checked, "checked by default");
    box.click();
    ok(!Services.prefs.getBoolPref(OPTION), "Unchecking turns icons off");
    Services.prefs.clearUserPref(OPTION);
  });
});
