/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W10-20: the selected-text menu, regrouped. Search first, then copying,
// then Add to Note and Quick Actions ▸ (the actions that hand the text to
// another app, each naming the app), Print, extensions, developer rows.
// Rows few people use start off. The page menu keeps Firefox's order.

const { WhimsyMenuPrefs, ADDED_HIDDEN, ORDER_SEP_CLASS } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyMenuPrefs.sys.mjs"
);
const { WhimsyVerbs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVerbs.sys.mjs");

const PAGE =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_verbs.html";

async function select(browser, id, text = null) {
  await SpecialPowers.spawn(browser, [id, text], (elementId, replacement) => {
    const node = content.document.getElementById(elementId);
    if (replacement) {
      node.textContent = replacement;
    }
    const selection = content.getSelection();
    selection.removeAllRanges();
    const range = content.document.createRange();
    range.selectNodeContents(node);
    selection.addRange(range);
  });
}

async function openMenu(browser, id) {
  const menu = document.getElementById("contentAreaContextMenu");
  const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
  await BrowserTestUtils.synthesizeMouseAtCenter(`#${id}`, { type: "contextmenu", button: 2 }, browser);
  await shown;
  return menu;
}

async function closeMenu(menu) {
  const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
  menu.hidePopup();
  await hidden;
}

function shows(node) {
  return !!node && !node.hidden && node.getAttribute("collapsed") != "true" && node.checkVisibility();
}

// The visible rows' ids in order; separators as "-".
function visibleRows(popup) {
  return [...popup.children].filter(shows).map(node => (node.localName == "menuseparator" ? "-" : node.id));
}

add_task(async function test_defaults() {
  for (const id of ADDED_HIDDEN[2].selection) {
    ok(WhimsyMenuPrefs.isHidden("selection", id), `${id} starts off`);
  }
  for (const id of ["calendar", "map", "email", "linear-new", "linear-search"]) {
    is(WhimsyMenuPrefs.parentOf("selection", id)?.id, "quick-actions", `${id} is in Quick Actions`);
  }
});

add_task(async function test_order_and_quick_actions() {
  const linear = WhimsyVerbs.linearConfigured;
  WhimsyVerbs.linearConfigured = () => true;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  try {
    await select(tab.linkedBrowser, "event");
    const menu = await openMenu(tab.linkedBrowser, "event");
    const rows = visibleRows(menu);
    info(rows.join(" "));
    const order = [
      "context-searchselect",
      "context-copy",
      "context-copy-link-to-highlight",
      "context-whimsy-copy-markdown",
      "context-whimsy-verb-note",
      "context-whimsy-quick-actions",
      "context-print-selection",
      "context-whimsy-inspect-font",
      "context-inspect",
    ].filter(id => shows(document.getElementById(id)));
    Assert.deepEqual(rows.filter(id => order.includes(id)), order, "The rows show in the new order");
    is(rows[0], "context-searchselect", "Search is first");
    ok(rows.indexOf("context-copy") < rows.indexOf("context-whimsy-verb-note"), "Copying comes before actions");
    ok(!rows.includes("-") || rows.indexOf("-") > 0, "No leading separator");
    is(rows.at(-1) == "-", false, "No trailing separator");
    ok(!rows.some((id, i) => id == "-" && rows[i + 1] == "-"), "No doubled separators");
    for (const id of ["context-selectall", "context-searchselect-private", "context-viewpartialsource-selection", "context-inspect-a11y"]) {
      ok(!shows(document.getElementById(id)), `${id} is off by default`);
    }
    ok(!shows(document.getElementById("context-whimsy-quick-action-solo")), "No single row with several actions");

    const quick = document.getElementById("context-whimsy-quick-actions");
    const children = [...quick.menupopup.children].filter(n => !n.hidden).map(n => (n.localName == "menuseparator" ? "-" : n.id));
    Assert.deepEqual(children, [
      "context-whimsy-verb-calendar",
      "context-whimsy-verb-map",
      "context-whimsy-verb-email",
      "-",
      "context-whimsy-verb-linear-new",
      "context-whimsy-verb-linear-search",
    ], "Quick Actions holds the app actions, Linear after a divider");
    const email = document.getElementById("context-whimsy-verb-email");
    is(JSON.parse(email.getAttribute("data-l10n-args")).app, WhimsyVerbs.mailAppName(), "Email names the mail app");
    await document.l10n.translateElements([quick, email]);
    is(quick.label, "Quick Actions", "The submenu is called Quick Actions");
    ok(email.label.startsWith("Email with "), `Email says which app (${email.label})`);
    await closeMenu(menu);
    ok(!menu.querySelector(`:scope > menuseparator.${ORDER_SEP_CLASS}:not([hidden])`), "Whimsy's separators hide again");
  } finally {
    WhimsyVerbs.linearConfigured = linear;
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_page_menu_keeps_firefox_order() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const popup = document.getElementById("contentAreaContextMenu");
  const before = [...popup.children].filter(n => n.id && !n.id.startsWith("context-whimsy")).map(n => n.id);
  await select(tab.linkedBrowser, "event");
  await closeMenu(await openMenu(tab.linkedBrowser, "event"));
  const after = [...popup.children].filter(n => n.id && !n.id.startsWith("context-whimsy")).map(n => n.id);
  Assert.deepEqual(after, before, "Closing the selection menu puts Firefox's rows back in its order");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_one_action_shows_as_a_row() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  // Too long for Maps, no date, Linear not connected: only Email applies.
  await select(tab.linkedBrowser, "rich", "word ".repeat(60));
  const menu = await openMenu(tab.linkedBrowser, "rich");
  ok(!shows(document.getElementById("context-whimsy-quick-actions")), "No one-row submenu");
  const solo = document.getElementById("context-whimsy-quick-action-solo");
  ok(shows(solo), "The one action shows in its place");
  is(solo.getAttribute("data-l10n-id"), "whimsy-context-verb-email", "…as Email with the app");
  const rows = visibleRows(menu);
  is(rows.indexOf("context-whimsy-quick-action-solo"), rows.indexOf("context-whimsy-verb-note") + 1, "Right after Add to Note");
  await closeMenu(menu);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_child_switch() {
  WhimsyMenuPrefs.setHidden("selection", "map", true);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await select(tab.linkedBrowser, "place");
  const menu = await openMenu(tab.linkedBrowser, "place");
  ok(document.getElementById("context-whimsy-verb-map").hidden, "Show in Maps follows its own switch");
  await closeMenu(menu);
  WhimsyMenuPrefs.setHidden("selection", "quick-actions", true);
  await openMenu(tab.linkedBrowser, "place");
  ok(!shows(document.getElementById("context-whimsy-quick-actions")) &&
    !shows(document.getElementById("context-whimsy-quick-action-solo")), "Turning Quick Actions off hides it all");
  await closeMenu(menu);
  WhimsyMenuPrefs.restoreDefaults("selection");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_migration_adds_new_defaults_once() {
  Services.prefs.setStringPref("whimsy.menus.hidden.selection", "email");
  Services.prefs.setIntPref("whimsy.menus.defaults-version", 1);
  WhimsyMenuPrefs.migrateDefaults();
  const hidden = WhimsyMenuPrefs.hiddenIds("selection");
  ok(hidden.has("email"), "Their own choice stays");
  for (const id of ADDED_HIDDEN[2].selection) {
    ok(hidden.has(id), `${id} is off now too`);
  }
  ok(!hidden.has("copy-url-quote"), "Version 1's list isn't applied again");
  is(Services.prefs.getIntPref("whimsy.menus.defaults-version"), 2, "Migrated to version 2");
  WhimsyMenuPrefs.restoreDefaults("selection");
  Services.prefs.clearUserPref("whimsy.menus.defaults-version");
});

add_task(async function test_extension_rows_after_print() {
  const extension = ExtensionTestUtils.loadExtension({
    manifest: { permissions: ["menus"] },
    background() {
      browser.menus.create({ id: "testsaverow", title: "Save to Test", contexts: ["selection"] }, () =>
        browser.test.sendMessage("ready")
      );
    },
  });
  await extension.startup();
  await extension.awaitMessage("ready");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await select(tab.linkedBrowser, "event");
  const menu = await openMenu(tab.linkedBrowser, "event");
  const ext = [...menu.children].find(node => shows(node) && node.label?.includes("Save to Test"));
  ok(ext, "The extension's row shows");
  const rows = [...menu.children].filter(shows);
  const print = document.getElementById("context-print-selection");
  if (shows(print)) {
    ok(rows.indexOf(ext) > rows.indexOf(print), "Extension rows come after Print");
  }
  ok(rows.indexOf(ext) < rows.indexOf(document.getElementById("context-inspect")), "…and before the developer rows");
  await closeMenu(menu);
  BrowserTestUtils.removeTab(tab);
  await extension.unload();
});
