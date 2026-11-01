/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9/menus: W9-09 right-click ↔ command parity, W9-10 container rows.
// - Every new command is in the command bar and has a <key> about:keyboard
//   lists (no default shortcut); Firefox's own commands keep their own key.
// - The commands do what their menu rows do, on the current tab or page.
// - Every new menu row exists in its menu, is listed in Settings → Menus,
//   and is off by default (collapsed, what a native menu reads) except Allow
//   Copy and Paste (only on a page that blocks copying) and Move Tab ▸ New
//   Space… (first in its submenu).
// - Share ▸ lists the share services itself.
// - Firefox's container rows start off; Open Link in Space stays.

const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { WhimsyMenuPrefs, ADDED_HIDDEN } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyMenuPrefs.sys.mjs"
);
const { WhimsyMenuParity } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMenuParity.sys.mjs");
const { WhimsyShareMenu } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyShareMenu.sys.mjs");
const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");

const PAGE = `https://example.com/browser/whimsy-parity?plain`;
const PLAIN_PAGE = "data:text/html,<p id='t'>Copy me freely</p><a id='l' href='https://example.com/linked' style='display:block;padding:30px'>a link</a>";

const startTabs = new Set(gBrowser.tabs);
add_setup(async function () {
  registerCleanupFunction(() => {
    for (const menu of WhimsyMenuPrefs.menus) {
      WhimsyMenuPrefs.restoreDefaults(menu.id);
    }
    WhimsyShareMenu._service = undefined;
    for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
      BrowserTestUtils.removeTab(tab);
    }
  });
});

function shows(node) {
  return !!node && !node.hidden && node.getAttribute("collapsed") != "true";
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
  if (menu.state == "closed") {
    return;
  }
  const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
  menu.hidePopup();
  await hidden;
}

const NEW_COMMANDS = [
  "cmd_whimsyRenameTab",
  "cmd_whimsyUnloadTab",
  "cmd_whimsyArchiveTabsBelow",
  "cmd_whimsyCloseDuplicateTabs",
  "cmd_whimsyCloseOtherTabs",
  "cmd_whimsyCloseTabsBelow",
  "cmd_whimsySelectAllTabs",
  "cmd_whimsyMuteTab",
  "cmd_whimsyAddSiteToRouting",
  "cmd_whimsyReplacePinnedUrl",
  "cmd_whimsyShareTab",
  "cmd_zenChangeWorkspaceName",
  "cmd_zenChangeWorkspaceIcon",
  "cmd_zenUnloadWorkspace",
  "cmd_zenCtxShareWorkspace",
  "cmd_zenCtxDeleteWorkspace",
  "cmd_whimsyShareSplit",
  "cmd_whimsyChangeSplitIcon",
  "cmd_whimsyRenameSplit",
  "cmd_whimsyDuplicateSplit",
  "cmd_whimsyMutePane",
  "Browser:Back",
  "Browser:Forward",
  "View:PageSource",
  "Browser:SavePage",
  "Browser:AddBookmarkAs",
  "cmd_whimsyInspectAccessibility",
  "cmd_whimsyCopyLinkToHighlight",
  "cmd_whimsyPrintSelection",
];

add_task(async function test_every_new_command_is_listed_and_unbound() {
  is(
    WhimsyMenuParity.commandSpecs().length,
    NEW_COMMANDS.length,
    "The test covers every command the module adds"
  );
  for (const id of NEW_COMMANDS) {
    const entry = WhimsyCommands.get(id);
    ok(entry?.l10nId, `${id} is registered with a name`);
    ok(WhimsyCommands.title(entry), `${id}: "${WhimsyCommands.title(entry)}"`);
    ok(document.getElementById(id), `${id} has a <command>`);
    ok(
      globalActions.some(a => a.whimsyCommand == id),
      `${id} is in the command bar`
    );
    if (entry.elsewhere) {
      // Firefox's own command keeps its own key, in its own about:keyboard group.
      ok(document.getElementById(entry.elsewhere), `${id} keeps Firefox's key ${entry.elsewhere}`);
      continue;
    }
    const keyEl = entry.keyId && document.getElementById(entry.keyId);
    ok(keyEl, `${id} has a <key>, so about:keyboard lists it and a shortcut can be assigned`);
    is(keyEl?.parentElement?.id, "whimsyKeyset", `${id}'s key is in Whimsy's keyset`);
    ok(!keyEl?.hasAttribute("key") && !keyEl?.hasAttribute("keycode"), `${id} has no default shortcut`);
  }
  ok(!WhimsyCommands.get("cmd_whimsyChangeTabIcon") || !NEW_COMMANDS.includes("cmd_whimsyChangeTabIcon"),
    "Change Tab Icon… is wave9/restore's, not added twice here");
});

add_task(async function test_about_keyboard_lists_them() {
  const rows = ["cmd_whimsySelectAllTabs", "cmd_whimsyCloseDuplicateTabs", "cmd_zenUnloadWorkspace"].map(id => {
    const entry = WhimsyCommands.get(id);
    return { id, keyId: entry.keyId, title: WhimsyCommands.title(entry) };
  });
  await BrowserTestUtils.withNewTab("about:keyboard", async browser => {
    await SpecialPowers.spawn(browser, [rows], async expected => {
      const doc = content.document;
      if (!doc.getElementById("table").firstElementChild) {
        await ContentTaskUtils.waitForEvent(content, "CustomKeysUpdate", false, null, true);
      }
      for (const row of expected) {
        const el = doc.querySelector(`.key[data-id="${row.keyId}"]`);
        ok(el, `${row.id} is listed`);
        is(el?.dataset.label, row.title, `${row.id} has the command bar's name`);
      }
    });
  });
});

add_task(async function test_tab_commands_act_on_the_current_tab() {
  const a = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const b = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  gBrowser.selectedTab = a;

  // Mute: the row the command bar offers follows the tab's state.
  const muteRow = l10nId => globalActions.find(r => r.l10nId == l10nId);
  ok(muteRow("whimsy-action-mute-tab").isAvailable(window), "Mute Tab is offered");
  ok(!muteRow("whimsy-action-unmute-tab").isAvailable(window), "Unmute Tab is not");
  document.getElementById("cmd_whimsyMuteTab").doCommand();
  ok(a.hasAttribute("muted"), "Mute Tab muted the current tab");
  ok(!b.hasAttribute("muted"), "…only that one");
  ok(muteRow("whimsy-action-unmute-tab").isAvailable(window), "Now Unmute Tab is offered");
  document.getElementById("cmd_whimsyMuteTab").doCommand();
  ok(!a.hasAttribute("muted"), "And it unmutes");

  // Close Duplicate Tabs: b is a's duplicate.
  const closed = BrowserTestUtils.waitForTabClosing(b);
  document.getElementById("cmd_whimsyCloseDuplicateTabs").doCommand();
  await closed;
  ok(!b.isConnected || b.closing, "The duplicate closed");
  ok(a.isConnected, "The current tab stays");

  // Select All Tabs.
  document.getElementById("cmd_whimsySelectAllTabs").doCommand();
  ok(gBrowser.allTabsSelected(), "Select All Tabs selected every tab");
  gBrowser.clearMultiSelectedTabs();
  BrowserTestUtils.removeTab(a);
});

add_task(async function test_copy_link_to_highlight() {
  // A static page (not a 404 rewritten in place) so the text is laid out
  // before the directive is built; then wait until the selection is the text.
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_highlight.html"
  );
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const doc = content.document;
    const range = doc.createRange();
    range.selectNodeContents(doc.getElementById("p"));
    content.getSelection().removeAllRanges();
    content.getSelection().addRange(range);
    await ContentTaskUtils.waitForCondition(
      () => content.getSelection().toString() == "The quick brown fox jumps over the lazy dog",
      "The paragraph is selected"
    );
    await new Promise(r => content.requestAnimationFrame(() => content.requestAnimationFrame(r)));
  });
  const url = await WhimsyMenuParity.copyLinkToHighlight(window);
  ok(url?.includes("#:~:text="), `A link to the highlight: ${url}`);
  const copied = await TestUtils.waitForCondition(
    () => SpecialPowers.getClipboardData("text/plain") == url && url,
    "It's on the clipboard"
  );
  ok(copied, "Copied");
  BrowserTestUtils.removeTab(tab);
});

// The new rows: listed in Settings → Menus, and off by default except the
// ones the user wanted shown.
add_task(async function test_new_rows_are_registered_and_off_by_default() {
  for (const spec of WhimsyMenuParity.rowSpecs()) {
    const item = WhimsyMenuPrefs.items(spec.menu).find(entry =>
      entry.selectors.some(selector => selector == `#${spec.id}`)
    );
    ok(item, `${spec.id} is listed in Settings → Menus (${spec.menu})`);
    const shown = spec.id == "context-whimsy-allow-copy";
    is(WhimsyMenuPrefs.isHidden(spec.menu, item?.id), !shown, `${spec.id} is ${shown ? "on" : "off"} by default`);
  }
  ok(!WhimsyMenuPrefs.isHidden("tab", "move-to-new-space"), "Move Tab ▸ New Space… is on by default");
  ok(!WhimsyMenuPrefs.isHidden("tab", "share"), "Share ▸ is on by default");
  // W9-10: containers are picked through spaces.
  ok(WhimsyMenuPrefs.isHidden("link", "open-in-container"), "Open Link in New Container Tab is off by default");
  ok(WhimsyMenuPrefs.isHidden("tab", "reopen-in-container"), "Reopen in Container is off by default");
  ok(!WhimsyMenuPrefs.isHidden("link", "open-in-space"), "Open Link in Space stays on");
  ok(WhimsyMenuPrefs.isDefault("page"), "That is the default, not a user setting");
});

add_task(async function test_page_rows_collapse_until_turned_on() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  let menu = await openContentMenu(tab.linkedBrowser, "body");
  const fullPage = document.getElementById("context-whimsy-capture-full-page");
  ok(fullPage, "Capture Full Page is in the page menu");
  is(fullPage.getAttribute("collapsed"), "true", "…collapsed by default (a native menu hides it)");
  is(fullPage.previousElementSibling?.id, "context-take-screenshot", "…right after Take Screenshot");
  is(fullPage.getAttribute("command"), "cmd_whimsyCopyFullPage", "…running the command");
  await closeMenu(menu);

  WhimsyMenuPrefs.setHidden("page", "capture-full-page", false);
  WhimsyMenuPrefs.setHidden("page", "wayback", false);
  menu = await openContentMenu(tab.linkedBrowser, "body");
  ok(shows(fullPage), "Turned on in Settings, Capture Full Page shows");
  ok(shows(document.getElementById("context-whimsy-wayback")), "So does Open in Wayback Machine");
  await closeMenu(menu);
  WhimsyMenuPrefs.restoreDefaults("page");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_allow_copy_only_on_blocking_pages() {
  // A real site (Allow Copy is per site), with or without a copy blocker.
  const open = async (path, block) => {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `https://example.com/browser/${path}`);
    await SpecialPowers.spawn(tab.linkedBrowser, [block], blocks => {
      const doc = content.document;
      doc.body.innerHTML = "<p id='t' style='padding:30px'>Copy me if you can</p>";
      if (blocks) {
        doc.body.setAttribute("oncopy", "return false");
      }
    });
    return tab;
  };
  const plain = await open("whimsy-copy-plain", false);
  let menu = await openContentMenu(plain.linkedBrowser, "#t");
  let item = document.getElementById("context-whimsy-allow-copy");
  ok(!shows(item), "No Allow Copy row on a page that doesn't block copying");
  await closeMenu(menu);
  BrowserTestUtils.removeTab(plain);

  const blocking = await open("whimsy-copy-blocking", true);
  menu = await openContentMenu(blocking.linkedBrowser, "#t");
  item = document.getElementById("context-whimsy-allow-copy");
  ok(shows(item), "The row shows on a page that blocks copying");
  is(document.l10n.getAttributes(item).id, "whimsy-context-allow-copy", "…offering to allow it");
  await closeMenu(menu);
  BrowserTestUtils.removeTab(blocking);
});

add_task(async function test_tab_rows_and_move_to_new_space() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const menu = await openTabMenu(tab);
  const markdown = document.getElementById("context_whimsyCopyLinkMarkdown");
  ok(markdown, "Copy Link as Markdown is in the tab menu");
  ok(!shows(markdown), "…off by default");
  const moveTab = document.getElementById("context_moveTabOptions");
  if (moveTab && !moveTab.hidden && gZenWorkspaces.workspaceEnabled) {
    const sub = moveTab.menupopup;
    const shown = BrowserTestUtils.waitForEvent(sub, "popupshown");
    moveTab.openMenu(true);
    await shown;
    const first = [...sub.children].find(shows);
    is(first?.id, "context_whimsyMoveToNewSpace", "New Space… is first in Move Tab ▸");
    await closeMenu(sub);
  }
  await closeMenu(menu);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_share_is_a_real_submenu() {
  const shared = [];
  WhimsyShareMenu._service = {
    getServices(urls, names, titles, icons) {
      names.value = ["test.airdrop", "test.mail"];
      titles.value = ["AirDrop", "Mail"];
      icons.value = ["", ""];
    },
    share(name, urls, subject) {
      shared.push({ name, urls, subject });
      return true;
    },
  };
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const menu = await openTabMenu(tab);
  const share = menu.querySelector(".share-tab-url-item");
  ok(share, "The tab menu has Share ▸");
  ok(shows(share), "…shown by default");
  const sub = share.menupopup;
  const shown = BrowserTestUtils.waitForEvent(sub, "popupshown");
  share.openMenu(true);
  await shown;
  const rows = [...sub.querySelectorAll(".whimsy-share-service")];
  Assert.deepEqual(
    rows.map(r => r.getAttribute("label")),
    ["AirDrop", "Mail"],
    "The submenu lists the share services"
  );
  // W10-40: every service stays, and no row at the bottom reopens the same
  // list in macOS's picker ("AirDrop, Messages, and More…").
  const visible = [...sub.children].filter(shows);
  is(visible.at(-1), rows.at(-1), "The last row is the last share service");
  ok(!visible.some(n => n.classList.contains("share-mac-picker-item")), "No picker row repeats the services");
  ok(sub.querySelector(".share-copy-link") && shows(sub.querySelector(".share-copy-link")), "Copy Link stays");
  sub.activateItem(rows[1]);
  await TestUtils.waitForCondition(() => shared.length, "Picking one shares");
  is(shared[0].name, "test.mail", "…with that service");
  ok(shared[0].urls[0].startsWith("https://example.com/"), "…the tab's address");
  await closeMenu(menu);
  WhimsyShareMenu._service = undefined;
  BrowserTestUtils.removeTab(tab);
});

// W10-40: with no services to list (the share component missing or failing),
// Firefox's picker row is the way to share, so it stays.
add_task(async function test_share_picker_is_the_fallback() {
  if (AppConstants.platform != "macosx") {
    ok(true, "The picker row is macOS only");
    return;
  }
  WhimsyShareMenu._service = {
    getServices(urls, names, titles, icons) {
      names.value = [];
      titles.value = [];
      icons.value = [];
    },
    share: () => false,
  };
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const menu = await openTabMenu(tab);
  const share = menu.querySelector(".share-tab-url-item");
  const sub = share.menupopup;
  const shown = BrowserTestUtils.waitForEvent(sub, "popupshown");
  share.openMenu(true);
  await shown;
  ok(!sub.querySelector(".whimsy-share-service"), "No services listed");
  ok(shows(sub.querySelector(".share-mac-picker-item")), "Firefox's picker row is there instead");
  await closeMenu(menu);
  WhimsyShareMenu._service = undefined;
  BrowserTestUtils.removeTab(tab);
});

// W9-10: on a fresh profile the link menu offers spaces, not containers.
add_task(async function test_container_rows_start_off() {
  await SpecialPowers.pushPrefEnv({ set: [["privacy.userContext.enabled", true]] });
  const second = await gZenWorkspaces.createAndSaveWorkspace("Parity", "💼", true);
  gZenWorkspaces.saveWorkspace({ ...second, containerTabId: 1 });
  const first = gZenWorkspaces.getWorkspaces().find(w => w.uuid == gZenWorkspaces.activeWorkspace);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PLAIN_PAGE);
  const menu = await openContentMenu(tab.linkedBrowser, "#l");
  const container = document.getElementById("context-openlinkincontainertab");
  ok(!shows(container), "Open Link in New Container Tab is off");
  const inSpace = document.getElementById("context-whimsyOpenLinkInSpace");
  ok(shows(inSpace), "Open Link in Space shows");
  const subShown = BrowserTestUtils.waitForEvent(inSpace.menupopup, "popupshown");
  inSpace.openMenu(true);
  await subShown;
  const option = [...inSpace.menupopup.children].find(o => o.getAttribute("zen-workspace-id") == second.uuid);
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, "https://example.com/linked", true);
  inSpace.menupopup.activateItem(option);
  const newTab = await opened;
  is(newTab.getAttribute("zen-workspace-id"), second.uuid, "The link opened in that space");
  is(newTab.userContextId, 1, "…in the space's container");
  BrowserTestUtils.removeTab(newTab);
  await gZenWorkspaces.changeWorkspace(first);
  BrowserTestUtils.removeTab(tab);
  await gZenWorkspaces.removeWorkspace(second.uuid);
  await SpecialPowers.popPrefEnv();
});

// Someone who had already changed a menu gets the new rows off too, once.
add_task(async function test_defaults_migrate_into_a_changed_menu() {
  Services.prefs.setStringPref("whimsy.menus.hidden.page", "back");
  Services.prefs.setIntPref("whimsy.menus.defaults-version", 0);
  WhimsyMenuPrefs.migrateDefaults();
  const hidden = WhimsyMenuPrefs.hiddenIds("page");
  ok(hidden.has("back"), "Their own choice stays");
  for (const id of ADDED_HIDDEN[1].page) {
    ok(hidden.has(id), `${id} is now off too`);
  }
  WhimsyMenuPrefs.setHidden("page", "wayback", false);
  WhimsyMenuPrefs.migrateDefaults();
  ok(!WhimsyMenuPrefs.isHidden("page", "wayback"), "It runs once: a row turned back on stays on");
  WhimsyMenuPrefs.restoreDefaults("page");
  Services.prefs.clearUserPref("whimsy.menus.defaults-version");
});
