/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// w27-tabkeys: Move Tab Up/Down (WhimsyTabMove), plus the sidebar's Left/Right
// tree navigation and Option+Up/Down (WhimsySidebarNav), which calls the same
// move() for a tab that isn't always gBrowser.selectedTab.

const { WhimsyTabMove, DIRECTION_BACKWARD, DIRECTION_FORWARD } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyTabMove.sys.mjs"
);
const { WhimsyTreeTabs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTreeTabs.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");

const TREE_FEATURE = "whimsy.feature.tree-tabs";
const TREE_STYLE = "whimsy.tabs.tree-style";
const FREE = { modifiers: "accel,shift", key: "Y" };

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(async () => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    if (tab.isConnected && !tab.closing) {
      await BrowserTestUtils.removeTab(tab);
    }
  }
});

function focusSidebarOn(tab) {
  gBrowser.selectedTab = tab;
  window.document.getElementById("whimsy-focus-sidebar").doCommand();
}

// A plain row of four tabs forced into a known order, for the regular-tab
// move and boundary tests.
async function makeRow(count) {
  const tabs = [];
  for (let i = 0; i < count; i++) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, `https://example.com/?move-row-${i}`));
  }
  for (let i = 0; i < tabs.length; i++) {
    gBrowser.moveTabTo(tabs[i], { tabIndex: tabs[0].index + i });
  }
  return tabs;
}

async function removeRow(tabs) {
  for (const tab of tabs) {
    if (tab.isConnected && !tab.closing) {
      await BrowserTestUtils.removeTab(tab);
    }
  }
}

// `before`, a folder holding `a`/`b`, and `c`, all adjacent and in that
// order, for the folder-entry/exit/collapsed-skip tests.
async function makeFolderRow() {
  const before = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?move-folder-before");
  const a = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?move-folder-a");
  const b = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?move-folder-b");
  const c = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?move-folder-c");
  gBrowser.moveTabTo(a, { tabIndex: before.index + 1 });
  gBrowser.moveTabTo(b, { tabIndex: a.index + 1 });
  gBrowser.moveTabTo(c, { tabIndex: b.index + 1 });
  const folder = await gZenFolders.createFolder([a, b], { renameFolder: false, label: "Move Test" });
  // ZenFolders.createFolder pins its members and relocates the folder into
  // the pinned tabs row (ZenFolders.mjs's createFolder). Pin `before`/`c`
  // too and place them on either side of the folder there, so the row stays
  // one contiguous pinned-space strip: before, [folder: a, b], c.
  gBrowser.pinTab(before);
  gBrowser.pinTab(c);
  gBrowser.zenHandleTabMove(before, () => folder.before(before));
  gBrowser.zenHandleTabMove(c, () => folder.after(c));
  return { before, a, b, c, folder };
}

// ZenFolders.createFolder() always adds its own "about:blank" placeholder
// tab (zen-empty-tab) as a folder member alongside the real tabs passed in,
// so `folder.allItems` for a 2-tab folder is 3, not 2. Filter it out to
// check real membership.
function realMembers(folder) {
  return folder.allItems.filter(tab => !tab.hasAttribute("zen-empty-tab"));
}

async function removeFolderRow({ before, c, folder }) {
  const removed = BrowserTestUtils.waitForEvent(folder, "TabGroupRemoved");
  folder.delete();
  await removed;
  for (const tab of [before, c]) {
    if (tab.isConnected && !tab.closing) {
      gBrowser.unpinTab(tab);
      await BrowserTestUtils.removeTab(tab);
    }
  }
}

add_task(async function test_move_up_down_regular_tabs() {
  const [home, a, b, c] = await makeRow(4);
  try {
    // makeRow() appends after whatever unpinned tabs already exist in the
    // window (e.g. the test window's own startup tab), so `home` isn't
    // necessarily the strip's absolute first tab until repositioned there.
    gBrowser.moveTabTo(home, { tabIndex: gBrowser.tabs.findIndex(t => !t.pinned) });
    const homeIndex = home.index;
    is(WhimsyTabMove.canMove(window, home, DIRECTION_BACKWARD), false, "The first tab can't move up");
    ok(!WhimsyTabMove.move(window, home, DIRECTION_BACKWARD), "...move() agrees");
    is(home.index, homeIndex, "...and stays put");

    ok(WhimsyTabMove.canMove(window, b, DIRECTION_BACKWARD), "b can move up");
    ok(WhimsyTabMove.move(window, b, DIRECTION_BACKWARD), "");
    is(b.index, a.index - 1, "b swapped above a");

    ok(WhimsyTabMove.move(window, b, DIRECTION_FORWARD), "Moving back down");
    is(b.index, a.index + 1, "...restores the original order");

    is(WhimsyTabMove.canMove(window, c, DIRECTION_FORWARD), false, "The last tab can't move down");
    ok(!WhimsyTabMove.move(window, c, DIRECTION_FORWARD), "...move() agrees");
    is(c.index, gBrowser.tabs.length - 1, "...and stays put");
  } finally {
    await removeRow([home, a, b, c]);
  }
});

add_task(async function test_pinned_and_essentials_boundaries() {
  const essential = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?move-essential");
  const pinned = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?move-pinned");
  const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?move-normal");
  gZenPinnedTabManager.addToEssentials(essential);
  gBrowser.pinTab(pinned);
  gBrowser.moveTabTo(normal, { tabIndex: pinned.index + 1 });
  try {
    ok(essential.pinned, "An essential tab also reports pinned (ZenPinnedTabManager.addToEssentials)");

    ok(!WhimsyTabMove.canMove(window, essential, DIRECTION_FORWARD), "An essential tab can't move forward into the pinned row");
    ok(!WhimsyTabMove.move(window, essential, DIRECTION_FORWARD), "...move() refuses it");

    ok(!WhimsyTabMove.canMove(window, pinned, DIRECTION_BACKWARD), "A pinned tab can't move back into essentials");
    ok(!WhimsyTabMove.move(window, pinned, DIRECTION_BACKWARD), "...move() refuses it");

    ok(!WhimsyTabMove.canMove(window, pinned, DIRECTION_FORWARD), "A pinned tab can't move forward into normal tabs");
    ok(!WhimsyTabMove.move(window, pinned, DIRECTION_FORWARD), "...move() refuses it");

    ok(!WhimsyTabMove.canMove(window, normal, DIRECTION_BACKWARD), "A normal tab can't move back into the pinned row");
    ok(!WhimsyTabMove.move(window, normal, DIRECTION_BACKWARD), "...move() refuses it");
  } finally {
    gZenPinnedTabManager.removeEssentials(essential);
    gBrowser.unpinTab(pinned);
    await removeRow([essential, pinned, normal]);
  }
});

add_task(async function test_move_exits_a_folder() {
  const row = await makeFolderRow();
  try {
    ok(WhimsyTabMove.move(window, row.b, DIRECTION_FORWARD), "b (last in the folder) moves forward");
    ok(!row.b.group, "...leaving the folder");
    is(row.b.index, row.c.index - 1, "...landing right before c");
    is(realMembers(row.folder).length, 1, "Only a is left in the folder");
  } finally {
    // b is now a standalone pinned tab (outside the folder); unpin before
    // removing it, same as before/c in removeFolderRow.
    gBrowser.unpinTab(row.b);
    await removeRow([row.b]);
    await removeFolderRow(row);
  }
});

add_task(async function test_move_enters_a_folder() {
  const row = await makeFolderRow();
  try {
    ok(WhimsyTabMove.move(window, row.c, DIRECTION_BACKWARD), "c moves backward into the open folder");
    is(row.c.group, row.folder, "...joining it");
    is(row.folder.allItems.at(-1), row.c, "...as its last member");
  } finally {
    // a, b and c are now all inside the folder; deleting it closes all three.
    const removed = BrowserTestUtils.waitForEvent(row.folder, "TabGroupRemoved");
    row.folder.delete();
    await removed;
    gBrowser.unpinTab(row.before);
    await removeRow([row.before]);
  }
});

add_task(async function test_move_skips_a_collapsed_folder() {
  const row = await makeFolderRow();
  row.folder.collapsed = true;
  try {
    ok(WhimsyTabMove.move(window, row.c, DIRECTION_BACKWARD), "c moves backward past the collapsed folder");
    ok(!row.c.group, "...never entering it");
    is(row.c.index, row.before.index + 1, "...landing right after `before`, skipping the whole folder");
    is(realMembers(row.folder).length, 2, "The folder's own tabs are untouched");
  } finally {
    row.folder.collapsed = false;
    await removeFolderRow(row);
    await removeRow([row.a, row.b]);
  }
});

add_task(function test_default_shortcut_listing_and_rebind() {
  const upKey = document.getElementById("key_whimsyMoveTabUp");
  const downKey = document.getElementById("key_whimsyMoveTabDown");
  ok(upKey && downKey, "Both keys are registered");
  is(upKey.getAttribute("keycode"), "VK_UP", "Move Tab Up defaults to Ctrl+Shift+Up");
  is(upKey.getAttribute("modifiers"), "control,shift", "...with Ctrl+Shift");
  is(downKey.getAttribute("keycode"), "VK_DOWN", "Move Tab Down defaults to Ctrl+Shift+Down");
  is(downKey.getAttribute("modifiers"), "control,shift", "...with Ctrl+Shift");

  const upEntry = WhimsyCommands.get("cmd_whimsyMoveTabUp");
  const downEntry = WhimsyCommands.get("cmd_whimsyMoveTabDown");
  ok(upEntry && downEntry, "Both are registered commands");
  is(WhimsyCommands.title(upEntry), "Move Tab Up", "Listed in the command bar as Move Tab Up");
  is(WhimsyCommands.title(downEntry), "Move Tab Down", "...and Move Tab Down");

  const result = WhimsyCommands.rebind("cmd_whimsyMoveTabUp", FREE);
  ok(result.ok, "Move Tab Up's shortcut is rebindable, like any other command");
  is(upKey.getAttribute("key"), "Y", "The new key takes effect");
  WhimsyCommands.reset("cmd_whimsyMoveTabUp");
  is(upKey.getAttribute("keycode"), "VK_UP", "Reset restores the default");
  ok(!upKey.hasAttribute("key"), "...clearing the rebound key attribute");
});

add_task(async function test_default_shortcut_fires_and_cheat_sheet() {
  const [home, a, b] = await makeRow(3);
  try {
    gBrowser.selectedTab = b;
    const start = b.index;
    EventUtils.synthesizeKey("KEY_ArrowUp", { ctrlKey: true, shiftKey: true }, window);
    is(b.index, start - 1, "Ctrl+Shift+Up runs Move Tab Up");
    EventUtils.synthesizeKey("KEY_ArrowDown", { ctrlKey: true, shiftKey: true }, window);
    is(b.index, start, "Ctrl+Shift+Down runs Move Tab Down");

    const { WhimsyCheatSheet } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCheatSheet.sys.mjs");
    const rows = await WhimsyCheatSheet.rows(window);
    is(rows.find(r => r.keyId == "key_whimsyMoveTabUp")?.title, "Move Tab Up", "Listed in the cheat sheet");
    is(rows.find(r => r.keyId == "key_whimsyMoveTabDown")?.title, "Move Tab Down", "...both of them");
  } finally {
    await removeRow([home, a, b]);
  }
});

add_task(async function test_feature_off_disables_move() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.move-tab", false]] });
  const [home, a, b] = await makeRow(3);
  try {
    gBrowser.selectedTab = b;
    const start = b.index;
    EventUtils.synthesizeKey("KEY_ArrowUp", { ctrlKey: true, shiftKey: true }, window);
    is(b.index, start, "With the feature off, the default shortcut no-ops");
    ok(!WhimsyTabMove.canMove(window, b, DIRECTION_BACKWARD), "...and the API itself refuses");
    ok(!WhimsyTabMove.move(window, b, DIRECTION_BACKWARD), "");
  } finally {
    await removeRow([home, a, b]);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_sidebar_left_right_tree_tabs() {
  await SpecialPowers.pushPrefEnv({ set: [[TREE_FEATURE, true], [TREE_STYLE, "tree"]] });
  const root = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?nav-root");
  const child = await BrowserTestUtils.addTab(gBrowser, "https://example.com/?nav-child", {
    openerBrowser: root.linkedBrowser,
  });
  await BrowserTestUtils.browserLoaded(child.linkedBrowser);
  const leaf = await BrowserTestUtils.addTab(gBrowser, "https://example.com/?nav-leaf", {
    openerBrowser: child.linkedBrowser,
  });
  await BrowserTestUtils.browserLoaded(leaf.linkedBrowser);
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?nav-other");
  WhimsyTreeTabs.render(window);
  try {
    focusSidebarOn(root);
    is(gBrowser.tabContainer.ariaFocusedItem, root, "Sidebar focus starts on root");

    EventUtils.synthesizeKey("KEY_ArrowLeft", {}, window);
    ok(root.hasAttribute("whimsy-tree-collapsed"), "Left collapses root's branch");
    is(gBrowser.tabContainer.ariaFocusedItem, root, "...and keeps focus on root");
    ok(!child.visible && !leaf.visible, "child and leaf are hidden");

    EventUtils.synthesizeKey("KEY_ArrowLeft", {}, window);
    is(gBrowser.tabContainer.ariaFocusedItem, root, "Already collapsed, no parent, no folder: Left is a no-op");

    EventUtils.synthesizeKey("KEY_ArrowRight", {}, window);
    ok(!root.hasAttribute("whimsy-tree-collapsed"), "Right expands it again");
    ok(child.visible && leaf.visible, "child and leaf are visible again");

    EventUtils.synthesizeKey("KEY_ArrowDown", {}, window);
    is(gBrowser.tabContainer.ariaFocusedItem, child, "ArrowDown moves the cursor to child");

    EventUtils.synthesizeKey("KEY_ArrowLeft", {}, window);
    ok(child.hasAttribute("whimsy-tree-collapsed"), "Left collapses child's own branch");
    is(gBrowser.tabContainer.ariaFocusedItem, child, "...keeping focus on child");
    ok(!leaf.visible, "leaf is hidden");
    ok(child.visible, "child itself stays visible");

    EventUtils.synthesizeKey("KEY_ArrowLeft", {}, window);
    is(gBrowser.tabContainer.ariaFocusedItem, root, "Leaf-collapsed with no folder: Left moves focus to its tree parent");
    ok(!child.hasAttribute("whimsy-sidebar-focused"), "child's focus ring is gone");

    EventUtils.synthesizeKey("KEY_ArrowDown", {}, window);
    is(gBrowser.tabContainer.ariaFocusedItem, child, "Back on child");
    EventUtils.synthesizeKey("KEY_ArrowRight", {}, window);
    ok(!child.hasAttribute("whimsy-tree-collapsed"), "Right expands child's branch");
    ok(leaf.visible, "leaf is visible again");
  } finally {
    await SpecialPowers.pushPrefEnv({ set: [[TREE_FEATURE, false]] });
    await removeRow([leaf, child, root, other]);
    await SpecialPowers.popPrefEnv();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_sidebar_left_right_zen_folders() {
  const before = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?nav-folder-before");
  const x = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?nav-folder-x");
  const y = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?nav-folder-y");
  gBrowser.moveTabTo(x, { tabIndex: before.index + 1 });
  gBrowser.moveTabTo(y, { tabIndex: x.index + 1 });
  const folder = await gZenFolders.createFolder([x, y], { renameFolder: false, label: "Nav Test" });
  try {
    // y is selected, so it's the folder's visible stand-in once collapsed
    // (tab.mjs's `visible` getter): focus should stay there.
    focusSidebarOn(y);
    EventUtils.synthesizeKey("KEY_ArrowLeft", {}, window);
    ok(folder.collapsed, "Left collapses the folder y sits in");
    is(gBrowser.tabContainer.ariaFocusedItem, y, "y is the collapsed folder's visible stand-in, so focus stays on it");

    EventUtils.synthesizeKey("KEY_ArrowRight", {}, window);
    ok(!folder.collapsed, "Right expands it again");

    // Move the cursor to x, the folder's *other*, non-selected member.
    EventUtils.synthesizeKey("KEY_ArrowUp", {}, window);
    is(gBrowser.tabContainer.ariaFocusedItem, x, "ArrowUp moves the cursor to x");

    EventUtils.synthesizeKey("KEY_ArrowLeft", {}, window);
    ok(folder.collapsed, "Left collapses the folder from x too");
    is(gBrowser.tabContainer.ariaFocusedItem, before, "x isn't the stand-in once hidden, so focus falls back outside the folder");

    EventUtils.synthesizeKey("KEY_ArrowLeft", {}, window);
    is(gBrowser.tabContainer.ariaFocusedItem, before, "`before` has no parent or folder: Left is a no-op");
  } finally {
    folder.collapsed = false;
    const removed = BrowserTestUtils.waitForEvent(folder, "TabGroupRemoved");
    folder.delete();
    await removed;
    await removeRow([before]);
  }
});

add_task(async function test_sidebar_option_up_down_moves_focused_tab() {
  const [home, a, b, c] = await makeRow(4);
  try {
    gBrowser.selectedTab = home;
    window.document.getElementById("whimsy-focus-sidebar").doCommand();
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, window);
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, window);
    is(gBrowser.tabContainer.ariaFocusedItem, b, "The sidebar cursor is on b");
    is(gBrowser.selectedTab, home, "...which isn't the selected tab");

    EventUtils.synthesizeKey("KEY_ArrowUp", { altKey: true }, window);
    is(b.index, a.index - 1, "Option+Up moves the focused tab (b), not the selection");
    is(gBrowser.selectedTab, home, "The selected tab never changed");
    is(gBrowser.tabContainer.ariaFocusedItem, b, "The sidebar cursor stays on b");
    ok(b.hasAttribute("whimsy-sidebar-focused"), "...with its focus ring");

    EventUtils.synthesizeKey("KEY_ArrowDown", { altKey: true }, window);
    is(b.index, a.index + 1, "Option+Down moves it back");
  } finally {
    await removeRow([home, a, b, c]);
  }
});
