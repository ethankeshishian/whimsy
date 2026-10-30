/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// QR code for any page (whimsy.feature.qr-code): Firefox's QR dialog from the
// page context menu and the command bar. Covers the main flow (dialog opens
// with the page's URL), where the menu item shows (pages, not links), pages
// with nothing to share (about:), private tabs and Scratch (never offered,
// Firefox's own QR entries hidden too), Firefox's pref, and the switch.

const PAGE = "https://example.com/browser/";
const { WhimsyQRCode } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyQRCode.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");

function qrAction() {
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  return globalActions.find(a => a.l10nId == "whimsy-action-qrcode");
}

async function waitForQRDialog(browser) {
  const manager = gBrowser.getTabDialogBox(browser).getTabDialogManager();
  await TestUtils.waitForCondition(
    () => manager._dialogs.some(d => d._openedURL?.includes("qrcode-dialog")),
    "the QR code dialog opened"
  );
  const dialog = manager._dialogs.find(d => d._openedURL.includes("qrcode-dialog"));
  await dialog._dialogReady;
  const doc = dialog._frame.contentDocument;
  await TestUtils.waitForCondition(() => !doc.getElementById("success-container").hidden, "the QR code is drawn");
  return { dialog, doc, manager };
}

async function closeDialog({ dialog, manager }) {
  const closed = TestUtils.waitForCondition(() => !manager._dialogs.includes(dialog));
  dialog.close();
  await closed;
}

async function openPageMenu(browser, selector = "body") {
  const menu = document.getElementById("contentAreaContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  await BrowserTestUtils.synthesizeMouse(selector, 2, 2, { type: "contextmenu", button: 2 }, browser);
  await shown;
  return menu;
}

async function closeMenu(menu) {
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
}

add_task(async function test_command_bar_opens_dialog() {
  const action = qrAction();
  ok(action, "the command bar action is registered");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  ok(action.isAvailable(window), "available on a web page");
  is(WhimsyQRCode.urlFor(window), PAGE, "encodes the page's URL");

  document.getElementById("cmd_whimsyShowQRCode").doCommand();
  const opened = await waitForQRDialog(tab.linkedBrowser);
  is(opened.doc.documentElement.id, "qrcode-dialog", "Firefox's own QR dialog, not a new one");
  is(opened.doc.getElementById("qrcode-url").textContent, PAGE, "the dialog shows the page's URL");
  ok(opened.doc.getElementById("qrcode-image").src, "a QR image was generated");
  await closeDialog(opened);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_page_menu_item() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "data:text/html,<body style='height:300px'><p>Some text</p><a id='l' href='https://example.org/'>link</a></body>"
  );
  // data: pages have nothing to share.
  let menu = await openPageMenu(tab.linkedBrowser);
  ok(document.getElementById("context-whimsy-qrcode").hidden, "hidden where there is no URL to share");
  await closeMenu(menu);
  BrowserTestUtils.removeTab(tab);

  const page = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await SpecialPowers.spawn(page.linkedBrowser, [], () => {
    const a = content.document.createElement("a");
    a.id = "l";
    a.href = "https://example.org/";
    a.textContent = "a link";
    content.document.body.prepend(a);
  });
  menu = await openPageMenu(page.linkedBrowser);
  const item = document.getElementById("context-whimsy-qrcode");
  ok(!item.hidden, "shown on the page");
  is(item.previousElementSibling?.id, "context-savepage", "sits beside Save Page As");
  menu.activateItem(item);
  const opened = await waitForQRDialog(page.linkedBrowser);
  is(opened.doc.getElementById("qrcode-url").textContent, PAGE, "the menu item encodes the page");
  await closeDialog(opened);

  menu = await openPageMenu(page.linkedBrowser, "#l");
  ok(item.hidden, "not on a link (that's a different URL)");
  await closeMenu(menu);
  BrowserTestUtils.removeTab(page);
});

add_task(async function test_about_pages_unavailable() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:robots");
  ok(!qrAction().isAvailable(window), "nothing to encode on about: pages");
  ok(!WhimsyQRCode.show(window), "show does nothing there");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_private_tab_and_scratch() {
  const tab = WhimsyPrivate.openPrivateTab(window, { url: PAGE, force: true });
  if (tab) {
    await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
    ok(WhimsyPrivate.isPrivateTab(tab), "a private tab opened");
    ok(!qrAction().isAvailable(window), "not offered for a private tab");
    is(WhimsyQRCode.urlFor(window), null, "no URL leaves a private tab");
    ok(!WhimsyQRCode.show(window), "show refuses a private tab");

    // Firefox's own QR item (address bar menu, Share submenus) is hidden too.
    const popup = document.createXULElement("menupopup");
    const qr = document.createXULElement("menuitem");
    qr.className = "share-qrcode-item";
    popup.append(qr);
    WhimsyQRCode.hideFirefoxItems(window, popup);
    ok(qr.hidden, "Firefox's QR entry is hidden for a private tab");
    BrowserTestUtils.removeTab(tab);
  } else {
    ok(true, "private tabs are off in this profile");
  }

  const scratch = await WhimsyPrivate.openScratch(window);
  if (scratch) {
    const scratchTab = BrowserTestUtils.addTab(gBrowser, PAGE);
    gBrowser.selectedTab = scratchTab;
    await BrowserTestUtils.browserLoaded(scratchTab.linkedBrowser);
    ok(!qrAction().isAvailable(window), "not offered in Scratch");
    BrowserTestUtils.removeTab(scratchTab);
    await WhimsyPrivate.closeScratch(window);
  }

  const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const popup = document.createXULElement("menupopup");
  const qr = document.createXULElement("menuitem");
  qr.className = "share-qrcode-item";
  popup.append(qr);
  WhimsyQRCode.hideFirefoxItems(window, popup);
  ok(!qr.hidden, "Firefox's QR entry stays for a normal tab");
  BrowserTestUtils.removeTab(normal);
});

add_task(async function test_switches() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.qr-code", false]] });
  ok(!qrAction().isAvailable(window), "the switch hides the command bar action");
  let menu = await openPageMenu(tab.linkedBrowser);
  ok(document.getElementById("context-whimsy-qrcode").hidden, "the switch hides the menu item");
  await closeMenu(menu);
  await SpecialPowers.popPrefEnv();

  await SpecialPowers.pushPrefEnv({ set: [["browser.shareqrcode.enabled", false]] });
  ok(!qrAction().isAvailable(window), "Firefox's own QR switch is respected");
  await SpecialPowers.popPrefEnv();
  ok(qrAction().isAvailable(window), "back on");
  BrowserTestUtils.removeTab(tab);
});
