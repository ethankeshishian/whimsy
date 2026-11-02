/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W10-06 (user, 2026-10-31): archiving a tab shows no Undo toast. Closing
// it is still undoable: Cmd+Z (outside a text field) and Edit → Undo
// Archive Tab bring the tab back, from the tab menu's Archive Tab row, from
// Archive Tabs Below, and from Cmd+W.

const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
const { WhimsyArchive } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyArchive.sys.mjs");
const { BELOW_ID } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyArchiveMenu.sys.mjs");
const { WhimsyUndo } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUndo.sys.mjs");

const BASE = "https://example.com/?no-toast-";

const startTabs = new Set(gBrowser.tabs);
add_setup(async function () {
  // Toasts an earlier test left up (W10-15/25/30 toasts can stay) aren't
  // this test's: it checks that archiving shows none.
  closeToasts();
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.undo-tab-actions", true],
      ["whimsy.feature.archive-tab-menu", true],
      // Teach's one-time tips aren't about archiving; keep them out of the
      // toast count.
      ["whimsy.feature.teach-once", false],
    ],
  });
  await gZenWorkspaces.promiseInitialized;
  registerCleanupFunction(() => {
    for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
      if (tab.isConnected && !tab.closing) {
        BrowserTestUtils.removeTab(tab);
      }
    }
    WhimsyArchive.clear(window, { confirm: false });
  });
});

// Records every toast (Zen's toast, which Whimsy uses too) that
// appears while `fn` runs, and for a moment after it.
async function toastsDuring(fn) {
  const container = document.getElementById("zen-toast-container");
  const seen = [];
  const observer = container
    ? new MutationObserver(records => {
        for (const record of records) {
          seen.push(...[...record.addedNodes].filter(n => n.nodeType == Node.ELEMENT_NODE));
        }
      })
    : null;
  observer?.observe(container, { childList: true, subtree: true });
  try {
    await fn();
    // Toasts are added on the next tick or two; give them the chance.
    await new Promise(resolve => window.requestAnimationFrame(() => window.setTimeout(resolve, 300)));
  } finally {
    observer?.disconnect();
  }
  return seen;
}

function noToast(seen, what) {
  is(seen.length, 0, `${what}: no toast appears`);
  ok(!currentToast(), `${what}: no toast is up`);
  ok(!document.getElementById("whimsy-undo-toast-button"), `${what}: no Undo button`);
}

async function openTabs(names) {
  const tabs = [];
  for (const name of names) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, BASE + name));
  }
  return tabs;
}

async function openTabMenu(tab) {
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
  await shown;
  return menu;
}

function focusAnchor(anchor) {
  gBrowser.selectedTab = anchor;
  gURLBar.view.close();
  anchor.focus();
  is(document.activeElement, anchor, "Focus is on a tab, outside any text field");
}

function pressUndo() {
  const modifiers = AppConstants.platform == "macosx" ? { metaKey: true } : { ctrlKey: true };
  EventUtils.synthesizeKey("z", modifiers, window);
}

function findTab(url) {
  return gBrowser.tabs.find(t => t.linkedBrowser?.currentURI?.spec == url && !t.closing);
}

add_task(async function archive_tab_row_shows_no_toast_and_cmd_z_restores() {
  const [anchor, tab] = await openTabs(["anchor", "row"]);
  const recorded = BrowserTestUtils.waitForSessionStoreUpdate(tab);
  const seen = await toastsDuring(async () => {
    const menu = await openTabMenu(tab);
    const row = document.getElementById("context_closeTab");
    is(row.getAttribute("data-l10n-id"), "whimsy-tab-context-archive-tabs", "The row reads Archive Tab");
    const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
    menu.activateItem(row);
    await hidden;
    await TestUtils.waitForCondition(() => !tab.isConnected, "The tab is archived");
    await recorded;
  });
  noToast(seen, "Archive Tab");
  await TestUtils.waitForCondition(
    () => WhimsyArchive.listEntries(window).some(e => e.url == BASE + "row"),
    "It's in the Archive"
  );

  ok(WhimsyUndo.canUndo(window), "Closing it is still undoable");
  focusAnchor(anchor);
  pressUndo();
  const restored = await TestUtils.waitForCondition(() => findTab(BASE + "row"), "Cmd+Z brings it back");
  ok(restored, "The archived tab is back");
  BrowserTestUtils.removeTab(restored);
  BrowserTestUtils.removeTab(anchor);
});

add_task(async function archive_tabs_below_shows_no_toast_and_undoes_together() {
  const [anchor, b, c] = await openTabs(["below-anchor", "below-b", "below-c"]);
  const seen = await toastsDuring(async () => {
    const menu = await openTabMenu(anchor);
    // F15: Archive Tabs Below lives in the "Archive Multiple Tabs" submenu
    // now, so activateItem (top-level rows only) can't reach it.
    const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
    document.getElementById(BELOW_ID).doCommand();
    menu.hidePopup();
    await hidden;
    await TestUtils.waitForCondition(() => !b.isConnected && !c.isConnected, "The tabs below are archived");
  });
  noToast(seen, "Archive Tabs Below");

  focusAnchor(anchor);
  pressUndo();
  await TestUtils.waitForCondition(
    () => findTab(BASE + "below-b") && findTab(BASE + "below-c"),
    "One Cmd+Z brings the whole batch back"
  );
  BrowserTestUtils.removeTab(findTab(BASE + "below-b"));
  BrowserTestUtils.removeTab(findTab(BASE + "below-c"));
  BrowserTestUtils.removeTab(anchor);
});

add_task(async function cmd_w_shows_no_toast_and_edit_undo_restores() {
  const [anchor, tab] = await openTabs(["w-anchor", "w-tab"]);
  is(gBrowser.selectedTab, tab, "The tab to close is selected");
  const recorded = BrowserTestUtils.waitForSessionStoreUpdate(tab);
  const seen = await toastsDuring(async () => {
    EventUtils.synthesizeKey("w", { accelKey: true }, window);
    await TestUtils.waitForCondition(() => !tab.isConnected, "Cmd+W closes it");
    await recorded;
  });
  noToast(seen, "Cmd+W");

  // Edit → Undo Archive Tab runs the same undo (WhimsyArcMenus points the
  // Edit menu's Undo at this command while a tab action is pending).
  focusAnchor(anchor);
  is(WhimsyUndo.pendingUndo(window), "close", "Edit's Undo names the close");
  const command = document.getElementById("cmd_whimsyUndoTabAction");
  ok(command, "The Undo command exists for the Edit menu and shortcuts");
  command.doCommand();
  const restored = await TestUtils.waitForCondition(() => findTab(BASE + "w-tab"), "Edit → Undo brings it back");
  BrowserTestUtils.removeTab(restored);
  BrowserTestUtils.removeTab(anchor);
});
