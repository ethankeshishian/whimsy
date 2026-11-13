/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave10/mini W10-38: 1Password's Unlock popup didn't open in Mini.
// Two causes, both covered with an extension pinned to the toolbar, as
// 1Password pins itself:
// - Mini hides the toolbars, so a pinned extension's button was invisible,
//   missing from the puzzle list (which shows only unpinned ones), and its
//   popup anchored to that invisible button. Mini now lists toolbar
//   extensions under its one puzzle button, and their popups open from it
//   (Firefox's own handling of a collapsed toolbar).
// - action.openPopup() (a password manager's in-page Unlock) aimed at the
//   "top normal window", which skips Mini (a popup window), and refused
//   because that window wasn't focused. It opens in Mini when Mini is the
//   focused window (whimsy-ext-browserAction-js.patch).
// - An unpinned extension's popup anchors to Zen's site-controls icon,
//   which is in Mini's hidden nav bar; it opens from the puzzle instead.

const { WhimsyQuickWindow } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs");
const { CustomizableUI } = ChromeUtils.importESModule("moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs");

let EXTENSION_ID = "mini-unlock@tests.whimsy";
let WIDGET_ID = "mini-unlock_tests_whimsy-browser-action";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.quick-window.size", ""],
      // The test opens the popup from the background page, with no click.
      ["extensions.openPopupWithoutUserGesture.enabled", true],
    ],
  });
});

registerCleanupFunction(async () => {
  for (const win of WhimsyQuickWindow.windows()) {
    await WhimsyQuickWindow.whenReady(win);
    await BrowserTestUtils.closeWindow(win);
  }
});

async function loadPinnedExtension(area = "navbar") {
  const extension = ExtensionTestUtils.loadExtension({
    useAddonManager: "temporary",
    manifest: {
      browser_specific_settings: { gecko: { id: EXTENSION_ID } },
      browser_action: { default_popup: "popup.html", default_area: area, default_title: "Unlock" },
    },
    files: {
      "popup.html": `<!DOCTYPE html><html><head><meta charset="utf-8"><script src="popup.js"></script></head>
        <body style="width: 220px; height: 120px">Unlock</body></html>`,
      "popup.js": `window.addEventListener("load", () => browser.test.sendMessage("popup-open"));`,
    },
    background() {
      browser.test.onMessage.addListener(async msg => {
        if (msg == "open-popup") {
          try {
            await browser.browserAction.openPopup();
            browser.test.sendMessage("opened", "ok");
          } catch (e) {
            browser.test.sendMessage("opened", String(e?.message ?? e));
          }
        }
      });
      browser.test.sendMessage("ready");
    },
  });
  await extension.startup();
  await extension.awaitMessage("ready");
  // W26 extpin: a manifest's "navbar" no longer pins the button by itself;
  // it's pinned the way the user pins it (Pin to Toolbar).
  if (area == "navbar") {
    CustomizableUI.addWidgetToArea(WIDGET_ID, CustomizableUI.AREA_NAVBAR);
  }
  return extension;
}

async function openMini() {
  const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
  await WhimsyQuickWindow.whenReady(win);
  await TestUtils.waitForCondition(() => win.gBrowser.selectedBrowser.currentURI.spec == "https://example.com/",
    "Mini loaded its page");
  await SimpleTest.promiseFocus(win);
  return win;
}

const widgetIn = win => CustomizableUI.getWidget(WIDGET_ID)?.forWindow(win);
const actionPanel = win => win.document.getElementById("customizationui-widget-panel");

add_task(async function test_pinned_extensions_live_under_minis_puzzle_button() {
  const extension = await loadPinnedExtension();
  const win = await openMini();
  try {
    isnot(CustomizableUI.getPlacementOfWidget(WIDGET_ID)?.area, CustomizableUI.AREA_ADDONS,
      "The extension is pinned to the toolbar, like 1Password");
    const puzzle = win.document.getElementById("unified-extensions-button");
    // F20 (10-38): the puzzle button shows in Mini's address strip.
    await TestUtils.waitForCondition(() => puzzle.checkVisibility() && puzzle.getBoundingClientRect().width > 0,
      `The extensions button shows in Mini (hidden=${puzzle.hidden})`);
    is(puzzle.parentElement?.id, "whimsy-quick-window-address-field", "...in the address strip");
    await TestUtils.waitForCondition(() => widgetIn(win)?.node?.hasAttribute("artificallyOverflowed"),
      "In Mini, its button moves under the puzzle button");
    is(widgetIn(win).node.parentElement?.id, "overflowed-extensions-list", "...listed in the extensions panel");
    is(widgetIn(win).anchor, puzzle, "...and its popup anchors to the puzzle button");
    ok(!widgetIn(window).node.hasAttribute("artificallyOverflowed"), "The main window's toolbar keeps it");

    // The puzzle button (also a command, for a shortcut) shows it.
    ok(win.document.getElementById("key_whimsyMiniExtensions"), "Show Extensions can take a shortcut");
    win.document.getElementById("cmd_whimsyMiniExtensions").doCommand();
    await TestUtils.waitForCondition(() => win.gUnifiedExtensions.panel.state == "open", "The extensions panel opens");
    ok(widgetIn(win).node.checkVisibility(), "The pinned extension is in the list");
    const hidden = BrowserTestUtils.waitForEvent(win.gUnifiedExtensions.panel, "popuphidden");
    win.gUnifiedExtensions.panel.hidePopup();
    await hidden;

    // Clicking it there opens its popup from the puzzle button.
    win.document.getElementById("cmd_whimsyMiniExtensions").doCommand();
    await TestUtils.waitForCondition(() => win.gUnifiedExtensions.panel.state == "open", "The panel opens again");
    const shown = extension.awaitMessage("popup-open");
    widgetIn(win).node.querySelector(".unified-extensions-item-action-button").click();
    await shown;
    await TestUtils.waitForCondition(() => actionPanel(win)?.state == "open", "Its popup opens in Mini");
    ok(puzzle.contains(actionPanel(win).anchorNode) || actionPanel(win).anchorNode == puzzle,
      "...anchored to the puzzle button");
    const closed = BrowserTestUtils.waitForEvent(actionPanel(win), "popuphidden");
    actionPanel(win).hidePopup();
    await closed;
  } finally {
    await BrowserTestUtils.closeWindow(win);
    await extension.unload();
  }
});

// F20 (10-38): Mini's puzzle button shows even when the extensions button
// is set to hide in normal windows (Firefox's "Remove from Toolbar" turns
// extensions.unifiedExtensions.button.always_visible off and hides it).
add_task(async function test_puzzle_button_shows_when_hidden_elsewhere() {
  await SpecialPowers.pushPrefEnv({ set: [["extensions.unifiedExtensions.button.always_visible", false]] });
  const win = await openMini();
  try {
    const puzzle = win.document.getElementById("unified-extensions-button");
    await TestUtils.waitForCondition(() => puzzle.checkVisibility() && puzzle.getBoundingClientRect().width > 0,
      `The extensions button shows in Mini (hidden=${puzzle.hidden})`);
    win.gUnifiedExtensions.updateButtonVisibility();
    ok(!puzzle.hidden && puzzle.checkVisibility(), "...and stays after Firefox updates it");
  } finally {
    await BrowserTestUtils.closeWindow(win);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_in_page_unlock_opens_the_popup_in_mini() {
  const extension = await loadPinnedExtension();
  const win = await openMini();
  try {
    await TestUtils.waitForCondition(() => widgetIn(win)?.node?.hasAttribute("artificallyOverflowed"),
      "The pinned extension is under Mini's puzzle button");
    is(Services.focus.activeWindow, win, "Mini is the focused window");
    // What 1Password's inline Unlock does: action.openPopup() with no window.
    const shown = extension.awaitMessage("popup-open");
    extension.sendMessage("open-popup");
    is(await extension.awaitMessage("opened"), "ok", "openPopup succeeds from Mini");
    await shown;
    await TestUtils.waitForCondition(() => actionPanel(win)?.state == "open", "The popup opens in Mini");
    ok(actionPanel(window)?.state != "open", "...not in the main window behind it");
    const closed = BrowserTestUtils.waitForEvent(actionPanel(win), "popuphidden");
    actionPanel(win).hidePopup();
    await closed;
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }

  // A main window still gets its own popup (Firefox's behaviour unchanged).
  await SimpleTest.promiseFocus(window);
  const shown = extension.awaitMessage("popup-open");
  extension.sendMessage("open-popup");
  is(await extension.awaitMessage("opened"), "ok", "openPopup still works in a main window");
  await shown;
  await TestUtils.waitForCondition(() => actionPanel(window)?.state == "open", "The popup opens there");
  const closed = BrowserTestUtils.waitForEvent(actionPanel(window), "popuphidden");
  actionPanel(window).hidePopup();
  await closed;
  await extension.unload();
});

add_task(async function test_unpinned_extension_popup_opens_from_the_puzzle() {
  // Another id: Firefox remembers where an uninstalled extension's button
  // was, so the pinned one above would come back pinned.
  EXTENSION_ID = "mini-unlock-unpinned@tests.whimsy";
  WIDGET_ID = "mini-unlock-unpinned_tests_whimsy-browser-action";
  const extension = await loadPinnedExtension("menupanel");
  const win = await openMini();
  try {
    is(CustomizableUI.getPlacementOfWidget(WIDGET_ID)?.area, CustomizableUI.AREA_ADDONS, "Not pinned");
    const puzzle = win.document.getElementById("unified-extensions-button");
    win.document.getElementById("cmd_whimsyMiniExtensions").doCommand();
    await TestUtils.waitForCondition(() => win.gUnifiedExtensions.panel.state == "open", "The extensions panel opens");
    const shown = extension.awaitMessage("popup-open");
    widgetIn(win).node.querySelector(".unified-extensions-item-action-button").click();
    await shown;
    await TestUtils.waitForCondition(() => actionPanel(win)?.state == "open", "Its popup opens in Mini");
    ok(puzzle.contains(actionPanel(win).anchorNode) || actionPanel(win).anchorNode == puzzle,
      "...from the puzzle button, not Zen's hidden site-controls icon");
    const closed = BrowserTestUtils.waitForEvent(actionPanel(win), "popuphidden");
    actionPanel(win).hidePopup();
    await closed;
  } finally {
    await BrowserTestUtils.closeWindow(win);
    await extension.unload();
  }
});
