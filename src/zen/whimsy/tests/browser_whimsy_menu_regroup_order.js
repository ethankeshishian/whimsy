/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29/ctxmenu: the page and tab menus, regrouped with the most-used
// actions first (design's option B). Page: go, keep or share, make, save,
// developer. Tab: this tab, where it lives, split view, sound and time,
// share and save, the AI rows (grouped on their own, the owner asked for
// this, 2026-11-14), label, archive. The tab menu's chat row also reads
// "Ask AI" now (was "Ask an AI Chatbot"). The selection, link and image
// menus keep Firefox's order (the owner accepted leaving them alone).

const { WhimsyMenuPrefs, defaultHiddenIdsFor, ORDER_SEP_CLASS } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyMenuPrefs.sys.mjs"
);

const PAGE =
  "https://example.com/document-builder.sjs?html=" +
  encodeURIComponent(
    '<a id="l" href="https://example.com/" style="display:block;padding:20px">go</a>' +
      '<img id="img" alt="" width=40 height=40 src="/browser/zen/whimsy/tests/whimsy_test_image.png">' +
      '<p id="t" style="padding:20px">Some words to select</p>' +
      '<div id="blank" style="height:200px"></div>'
  );

function shows(node) {
  return !!node && !node.hidden && node.getAttribute("collapsed") != "true" && node.checkVisibility();
}

// The visible rows' ids in order; separators as "-".
function visibleRows(popup) {
  return [...popup.children].filter(shows).map(node => (node.localName == "menuseparator" ? "-" : node.id));
}

async function openContentMenu(browser, selector) {
  const menu = document.getElementById("contentAreaContextMenu");
  const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
  await BrowserTestUtils.synthesizeMouseAtCenter(selector, { type: "contextmenu", button: 2 }, browser);
  await shown;
  return menu;
}

async function openTabMenu(tab) {
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
  await shown;
  return menu;
}

async function closeMenu(menu) {
  const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
  menu.hidePopup();
  await hidden;
}

add_task(async function test_page_menu_order() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const menu = await openContentMenu(tab.linkedBrowser, "#blank");
  const rows = visibleRows(menu);
  info(rows.join(" "));
  const order = [
    "context-back",
    "context-forward",
    "context-reload",
    "context-bookmarkpage",
    "context-whimsy-copy-markdown",
    "context-whimsy-qrcode",
    "context-sendpagetodevice",
    "context-whimsy-new-note",
    "context-take-screenshot",
    "context-whimsy-edit-page",
    "context-savepage",
    "context-selectall",
    "context-viewsource",
    "context-inspect-a11y",
    "context-inspect",
  ].filter(id => shows(document.getElementById(id)));
  Assert.deepEqual(rows.filter(id => order.includes(id)), order, "The page menu shows the regrouped order");
  is(rows[0], "context-back", "Back (Go) is first");
  ok(rows.indexOf("context-bookmarkpage") < rows.indexOf("context-whimsy-new-note"), "Keep or share comes before Make");
  ok(rows.indexOf("context-whimsy-new-note") < rows.indexOf("context-savepage"), "Make comes before Save");
  ok(rows.indexOf("context-savepage") < rows.indexOf("context-viewsource"), "Save comes before Developer");
  ok(!rows.some((id, i) => id == "-" && rows[i + 1] == "-"), "No doubled separators");
  is(rows.at(-1) == "-", false, "No trailing separator");
  await closeMenu(menu);
  ok(!menu.querySelector(`:scope > menuseparator.${ORDER_SEP_CLASS}:not([hidden])`), "Whimsy's separators hide again");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_page_menu_restores_firefox_order_on_close() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const popup = document.getElementById("contentAreaContextMenu");
  // Whimsy inserts and removes its own rows (e.g. the AI Improve/Fix/
  // Translate selection items) independent of reorder(), so only compare
  // the popup's own children, as the pre-existing selection-order test does.
  const ids = () => [...popup.children].map(n => n.id).filter(id => id && !id.startsWith("context-whimsy"));
  const before = ids();
  await closeMenu(await openContentMenu(tab.linkedBrowser, "#blank"));
  const after = ids();
  Assert.deepEqual(after, before, "Closing the page menu puts the popup's own children back in order");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_tab_menu_order() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const menu = await openTabMenu(tab);
  const rows = visibleRows(menu);
  info(rows.join(" "));
  const order = [
    // This tab.
    "context_openANewTab",
    "context_duplicateTab",
    "context_reloadTab",
    "context_unloadTab",
    // Where it lives.
    "context_pinTab",
    "context_zen-add-essential",
    "context_moveTabOptions",
    "context_zenMoveToFolder",
    "context_whimsyGroupByDomain",
    "context_zen-add-domain-to-routing",
    // Split view.
    "context_zenSplitTabs",
    "context_zenShareSplitView",
    "context_whimsyFollowerSplit",
    // Sound and time.
    "context_playTab",
    "context_toggleMuteTab",
    "context_whimsyMuteSite",
    "context_whimsySnooze",
    // Share and save.
    "context_whimsyCopyLinks",
    "context_sendTabToDevice",
    "context_bookmarkTab",
    // AI.
    "context_whimsyWatchPage",
    "context_askChat",
    // Label.
    "context_zen-edit-tab-title",
    "context_zen-edit-tab-icon",
    "context_selectAllTabs",
    // Archive.
    "context_closeTab",
    "context_closeTabsToTheEnd",
    "context_closeDuplicateTabs",
    "context_closeTabOptions",
    "context_undoCloseTab",
  ].filter(id => shows(document.getElementById(id)));
  Assert.deepEqual(rows.filter(id => order.includes(id)), order, "The tab menu shows the regrouped order");
  is(rows[0], "context_openANewTab", "New Tab Below (This tab) is first");
  ok(rows.indexOf("context_pinTab") < rows.indexOf("context_zenSplitTabs"), "Where it lives comes before Split view");
  ok(rows.indexOf("context_whimsyMuteSite") < rows.indexOf("context_whimsyCopyLinks"), "Sound and time comes before Share and save");
  ok(rows.indexOf("context_closeTab") > rows.indexOf("context_selectAllTabs"), "Archive is last, after Label");
  ok(!rows.some((id, i) => id == "-" && rows[i + 1] == "-"), "No doubled separators");
  await closeMenu(menu);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_tab_menu_restores_firefox_order_on_close() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const menu = document.getElementById("tabContextMenu");
  const before = [...menu.children].map(n => n.id);
  await closeMenu(await openTabMenu(tab));
  const after = [...menu.children].map(n => n.id);
  Assert.deepEqual(after, before, "Closing the tab menu puts the popup's own children back in order");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_ask_ai_label_and_ai_group() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const menu = await openTabMenu(tab);
  let found = false;
  for (const id of ["context_askChat", "context_createAITab"]) {
    const node = document.getElementById(id);
    if (!node || !shows(node)) {
      continue;
    }
    found = true;
    is(node.getAttribute("data-l10n-id"), "whimsy-tab-context-ask-ai", `${id} reads the new Fluent id`);
    await document.l10n.translateElements([node]);
    is(node.label, "Ask AI", `…and ${id}'s label is Ask AI`);
  }
  const summarize = document.getElementById("context_askChatSummarize");
  if (summarize) {
    isnot(summarize.getAttribute("data-l10n-id"), "whimsy-tab-context-ask-ai", "Summarize Page keeps its own wording");
  }
  const watch = document.getElementById("context_whimsyWatchPage");
  if (found && shows(watch)) {
    const rows = visibleRows(menu);
    const watchIndex = rows.indexOf("context_whimsyWatchPage");
    const askIndex = rows.findIndex(id => id == "context_askChat" || id == "context_createAITab");
    is(Math.abs(watchIndex - askIndex), 1, "Watch This Page and Ask AI sit next to each other");
  } else {
    todo(false, "Ask Chat isn't on in this build; the adjacency can't be checked here");
  }
  await closeMenu(menu);
  BrowserTestUtils.removeTab(tab);
});

// Exercises WhimsyMenuPrefs.relabelAskAI directly, so the rename is
// checked even on a build where Firefox's chat rows aren't showing.
add_task(async function test_relabel_ask_ai_function() {
  const popup = document.getElementById("tabContextMenu");
  const before = {};
  for (const id of ["context_askChat", "context_createAITab", "context_askChatSummarize"]) {
    const node = document.getElementById(id);
    if (node) {
      before[id] = node.getAttribute("data-l10n-id");
    }
  }
  WhimsyMenuPrefs.relabelAskAI(popup);
  for (const id of ["context_askChat", "context_createAITab"]) {
    const node = document.getElementById(id);
    if (node) {
      is(node.getAttribute("data-l10n-id"), "whimsy-tab-context-ask-ai", `${id} reads the new label`);
    }
  }
  const summarize = document.getElementById("context_askChatSummarize");
  if (summarize && "context_askChatSummarize" in before) {
    is(summarize.getAttribute("data-l10n-id"), before.context_askChatSummarize, "Summarize Page is untouched");
  }
  // Calling it again is a no-op, not a second swap.
  WhimsyMenuPrefs.relabelAskAI(popup);
  const askChat = document.getElementById("context_askChat");
  if (askChat) {
    is(askChat.getAttribute("data-l10n-id"), "whimsy-tab-context-ask-ai", "Relabelling twice is harmless");
  }
});

add_task(async function test_link_and_image_menus_unchanged() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);

  // Open and close the page menu first (same shared popup), so a reorder
  // there can't leave the link or image menu looking any different.
  await closeMenu(await openContentMenu(tab.linkedBrowser, "#blank"));

  const linkMenu = await openContentMenu(tab.linkedBrowser, "#l");
  const linkRows = visibleRows(linkMenu);
  info("link: " + linkRows.join(" "));
  const linkOrder = [
    "context-openlinkintab",
    "context-openlink",
    "context-openlinkprivate",
    "context-bookmarklink",
    "context-savelink",
    "context-copylink",
    "context-sendlinktodevice",
    "context-inspect",
  ].filter(id => shows(document.getElementById(id)));
  Assert.deepEqual(linkRows.filter(id => linkOrder.includes(id)), linkOrder, "The link menu keeps Firefox's order");
  ok(!linkMenu.querySelector(`:scope > menuseparator.${ORDER_SEP_CLASS}:not([hidden])`), "No registry separators on the link menu");
  await closeMenu(linkMenu);

  const imageMenu = await openContentMenu(tab.linkedBrowser, "#img");
  const imageRows = visibleRows(imageMenu);
  info("image: " + imageRows.join(" "));
  const imageOrder = [
    "context-viewimage",
    "context-saveimage",
    "context-copyimage-contents",
    "context-copyimage",
    "context-sendimage",
    "context-setDesktopBackground",
    "context-inspect",
  ].filter(id => shows(document.getElementById(id)));
  Assert.deepEqual(imageRows.filter(id => imageOrder.includes(id)), imageOrder, "The image menu keeps Firefox's order");
  ok(!imageMenu.querySelector(`:scope > menuseparator.${ORDER_SEP_CLASS}:not([hidden])`), "No registry separators on the image menu");
  await closeMenu(imageMenu);

  const tabMenu = await openTabMenu(tab);
  await closeMenu(tabMenu);

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_selection_menu_unaffected() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.getSelection().selectAllChildren(content.document.getElementById("t"));
  });
  const menu = await openContentMenu(tab.linkedBrowser, "#t");
  ok(shows(document.getElementById("context-searchselect")), "The selection menu still opens and shows Search");
  await closeMenu(menu);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_extension_row_lands_at_end() {
  const extension = ExtensionTestUtils.loadExtension({
    manifest: { permissions: ["menus"] },
    background() {
      browser.menus.create({ id: "testpagerow", title: "Save to Test", contexts: ["page"] }, () =>
        browser.test.sendMessage("ready")
      );
    },
  });
  await extension.startup();
  await extension.awaitMessage("ready");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const menu = await openContentMenu(tab.linkedBrowser, "#blank");
  const rows = [...menu.children].filter(shows);
  const ext = rows.find(node => node.label?.includes("Save to Test"));
  ok(ext, "The extension's row shows on the page menu");
  const inspect = document.getElementById("context-inspect");
  if (shows(inspect)) {
    ok(rows.indexOf(ext) > rows.indexOf(inspect), "It lands after the regrouped rows, including Developer");
  }
  await closeMenu(menu);
  BrowserTestUtils.removeTab(tab);
  await extension.unload();
});

add_task(async function test_hidden_rows_stay_hidden() {
  for (const id of defaultHiddenIdsFor("tab")) {
    ok(WhimsyMenuPrefs.isHidden("tab", id), `Tab menu: ${id} still starts off`);
  }
  for (const id of defaultHiddenIdsFor("page")) {
    ok(WhimsyMenuPrefs.isHidden("page", id), `Page menu: ${id} still starts off`);
  }
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const tabMenu = await openTabMenu(tab);
  for (const id of ["context_whimsyTabVolume", "context_whimsyPlaylistSave", "context_whimsyCopyLinkMarkdown"]) {
    ok(!shows(document.getElementById(id)), `${id} is hidden by default in the regrouped tab menu`);
  }
  await closeMenu(tabMenu);
  const pageMenu = await openContentMenu(tab.linkedBrowser, "#blank");
  for (const id of ["context-whimsy-capture-full-page", "context-whimsy-capture-portrait", "context-whimsy-wayback", "context-whimsy-dev-mode"]) {
    ok(!shows(document.getElementById(id)), `${id} is hidden by default in the regrouped page menu`);
  }
  await closeMenu(pageMenu);
  BrowserTestUtils.removeTab(tab);
});
