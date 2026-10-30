/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/split2: right-clicking a split's sidebar row opens Arc's split menu
// (arc-ref menus-context.txt "split-tab"): same items, order, labels and a
// submenu per pane that acts on that pane.

const { WhimsySplitRow } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySplitRow.sys.mjs");
const { WhimsySplitKeys } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySplitKeys.sys.mjs");

// Arc's row menu, top to bottom. "pane" is one "<page title> ▸" per pane.
const ARC_ROW = [
  "Share Split View…",
  "-",
  "Separate All Tabs",
  "Add Tab…",
  "Convert to Vertical Split View",
  "-",
  "Tab Options",
  "pane",
  "pane",
  "-",
  "Change Icon…",
  "Rename…",
  "-",
  "Duplicate",
  "Move to",
  "-",
  "Archive Item",
  "Archive Tabs Below",
];

const ARC_PANE = ["Separate from Split View", "-", "Share", "Mute", "Copy Link", "Copy link as Markdown", "-", "Archive Item"];

const l10n = new Localization(["browser/menubar.ftl", "browser/whimsy.ftl"], true);

function labelOf(el) {
  if (el.localName == "menuseparator") {
    return "-";
  }
  const { id, args } = document.l10n.getAttributes(el);
  if (!id) {
    return el.getAttribute("label");
  }
  return l10n.formatMessagesSync([{ id, args }])[0].attributes.find(a => a.name == "label").value;
}

function describe(popup) {
  return [...popup.children].filter(el => !el.hidden).map(el => (el.classList.contains("whimsy-split-row-pane") ? "pane" : labelOf(el)));
}

async function makeSplit(count, prefix = "row") {
  const tabs = [];
  for (let i = 0; i < count; i++) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, `https://example.com/?${prefix}-${i}`));
  }
  gZenViewSplitter.splitTabs(tabs, "vsep", 0);
  await TestUtils.waitForCondition(() => tabs.every(t => t.splitView), `${count} panes`);
  gBrowser.selectedTab = tabs[0];
  return tabs;
}

function groupOf(tab) {
  return gZenViewSplitter._data.find(g => g.tabs.includes(tab));
}

function rowMenu() {
  return document.getElementById("whimsySplitRowMenu");
}

async function openRowMenu(tab) {
  WhimsySplitRow.ensureMenu(window);
  const shown = BrowserTestUtils.waitForPopupEvent(rowMenu(), "shown");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
  await shown;
  return rowMenu();
}

async function closeRowMenu() {
  const hidden = BrowserTestUtils.waitForPopupEvent(rowMenu(), "hidden");
  rowMenu().hidePopup();
  await hidden;
}

async function chooseRow(item) {
  const hidden = BrowserTestUtils.waitForPopupEvent(rowMenu(), "hidden");
  rowMenu().activateItem(item);
  await hidden;
}

function paneMenus() {
  return [...rowMenu().querySelectorAll(".whimsy-split-row-pane")];
}

function paneItem(paneMenu, action) {
  return paneMenu.menupopup.querySelector(`[data-whimsy-pane-action="${action}"]`);
}

async function choosePane(paneMenu, action) {
  const sub = paneMenu.menupopup;
  const subShown = BrowserTestUtils.waitForPopupEvent(sub, "shown");
  paneMenu.openMenu(true);
  await subShown;
  const hidden = BrowserTestUtils.waitForPopupEvent(rowMenu(), "hidden");
  sub.activateItem(paneItem(paneMenu, action));
  await hidden;
}

function cleanup(tabs) {
  for (const tab of tabs) {
    if (tab.isConnected && !tab.closing) {
      BrowserTestUtils.removeTab(tab);
    }
  }
}

add_task(async function test_row_menu_is_arcs() {
  const tabs = await makeSplit(2);
  const tabMenu = document.getElementById("tabContextMenu");
  let tabMenuOpened = false;
  const onTabMenu = () => (tabMenuOpened = true);
  tabMenu.addEventListener("popupshowing", onTabMenu);
  const menu = await openRowMenu(tabs[1]);
  tabMenu.removeEventListener("popupshowing", onTabMenu);
  ok(!tabMenuOpened, "A split row opens Arc's split menu, not the tab menu");
  Assert.deepEqual(describe(menu), ARC_ROW, "Arc's items, order and labels");
  ok(document.getElementById("whimsySplitRow-tabOptions").disabled, "Tab Options is a greyed heading, like Arc's");

  const panes = paneMenus();
  Assert.deepEqual(
    panes.map(p => p.getAttribute("label")),
    WhimsySplitKeys.panes(groupOf(tabs[0])).map(t => t.label),
    "One submenu per pane, named for its page, in layout order"
  );
  for (const pane of panes) {
    Assert.deepEqual(describe(pane.menupopup), ARC_PANE, "Each pane's submenu is Arc's per-pane list");
  }
  await closeRowMenu();
  cleanup(tabs);
});

add_task(async function test_pane_submenus_act_on_the_right_pane() {
  const tabs = await makeSplit(3, "which");
  await openRowMenu(tabs[0]);
  const third = paneMenus().find(p => p.whimsyTab == tabs[2]);
  ok(third, "The third pane has its submenu");
  await choosePane(third, "separate");
  await TestUtils.waitForCondition(() => !tabs[2].splitView, "Separate from Split View took out the pane its submenu names");
  ok(tabs[0].splitView && tabs[1].splitView, "The other panes stay split");

  await openRowMenu(tabs[0]);
  const second = paneMenus().find(p => p.whimsyTab == tabs[1]);
  await choosePane(second, "archive");
  await TestUtils.waitForCondition(() => !tabs[1].isConnected || tabs[1].closing, "Archive Item closed that pane only");
  ok(tabs[0].isConnected && !tabs[0].closing, "The pane right-clicked is still there");
  cleanup(tabs);
});

add_task(async function test_separate_all_tabs() {
  const tabs = await makeSplit(3, "all");
  await openRowMenu(tabs[1]);
  await chooseRow(document.getElementById("whimsySplitRow-separateAll"));
  await TestUtils.waitForCondition(() => tabs.every(t => !t.splitView), "Every pane is its own tab again");
  ok(tabs.every(t => t.isConnected && !t.closing), "Nothing closed");
  cleanup(tabs);
});

add_task(async function test_convert_orientation() {
  const tabs = await makeSplit(2, "convert");
  await openRowMenu(tabs[0]);
  is(labelOf(document.getElementById("whimsySplitRow-convert")), "Convert to Vertical Split View", "Side by side: offer stacked");
  await chooseRow(document.getElementById("whimsySplitRow-convert"));
  await TestUtils.waitForCondition(() => groupOf(tabs[0])?.layoutTree.direction == "column", "Now stacked");
  await openRowMenu(tabs[0]);
  is(labelOf(document.getElementById("whimsySplitRow-convert")), "Convert to Horizontal Split View", "Stacked: offer side by side");
  await chooseRow(document.getElementById("whimsySplitRow-convert"));
  await TestUtils.waitForCondition(() => groupOf(tabs[0])?.layoutTree.direction == "row", "Side by side again");
  cleanup(tabs);
});

add_task(async function test_add_tab_and_full_split() {
  const tabs = await makeSplit(4, "full");
  await openRowMenu(tabs[0]);
  ok(document.getElementById("whimsySplitRow-addTab").disabled, "Four panes: Add Tab… is off (Zen's limit)");
  await closeRowMenu();
  cleanup(tabs);
});

add_task(async function test_duplicate_and_archive() {
  const tabs = await makeSplit(2, "dup");
  const before = gZenViewSplitter._data.length;
  await openRowMenu(tabs[0]);
  await chooseRow(document.getElementById("whimsySplitRow-duplicate"));
  await TestUtils.waitForCondition(() => gZenViewSplitter._data.length == before + 1, "Duplicate makes a second split");
  const copy = gZenViewSplitter._data.at(-1);
  is(copy.tabs.length, 2, "with a copy of every pane");
  ok(copy.tabs.every(t => !tabs.includes(t)), "new tabs, not these");
  is(groupOf(tabs[0]).tabs.length, 2, "The original split is unchanged");

  await openRowMenu(copy.tabs[0]);
  await chooseRow(document.getElementById("whimsySplitRow-archive"));
  await TestUtils.waitForCondition(() => copy.tabs.every(t => !t.isConnected || t.closing), "Archive Item closes the whole split");
  ok(tabs.every(t => t.isConnected && !t.closing), "only that one");
  cleanup(tabs);
});

add_task(async function test_move_to_lists_spaces() {
  const tabs = await makeSplit(2, "move");
  await openRowMenu(tabs[0]);
  const popup = document.getElementById("whimsySplitRow-moveToPopup");
  const spaces = gZenWorkspaces.getWorkspaces();
  const items = [...popup.querySelectorAll("menuitem[data-whimsy-space]")];
  is(items.length, spaces.length, "Every space is listed");
  const checked = items.filter(i => i.getAttribute("checked") == "true").map(i => i.dataset.whimsySpace);
  Assert.deepEqual(checked, [tabs[0].getAttribute("zen-workspace-id")], "The split's own space is checked");
  is(labelOf(popup.lastElementChild), "New Space…", "then New Space…, like Arc");
  await closeRowMenu();
  cleanup(tabs);
});

add_task(async function test_plain_tab_and_switch_off_keep_the_tab_menu() {
  const lone = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?lone");
  const tabMenu = document.getElementById("tabContextMenu");
  let shown = BrowserTestUtils.waitForPopupEvent(tabMenu, "shown");
  EventUtils.synthesizeMouseAtCenter(lone, { type: "contextmenu", button: 2 });
  await shown;
  ok(true, "A tab that isn't in a split gets the tab menu");
  let hidden = BrowserTestUtils.waitForPopupEvent(tabMenu, "hidden");
  tabMenu.hidePopup();
  await hidden;

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.split-row-menu", false]] });
  const tabs = await makeSplit(2, "off");
  shown = BrowserTestUtils.waitForPopupEvent(tabMenu, "shown");
  EventUtils.synthesizeMouseAtCenter(tabs[0], { type: "contextmenu", button: 2 });
  await shown;
  ok(rowMenu()?.state != "open", "Switch off: a split row gets the tab menu");
  hidden = BrowserTestUtils.waitForPopupEvent(tabMenu, "hidden");
  tabMenu.hidePopup();
  await hidden;
  await SpecialPowers.popPrefEnv();
  cleanup([...tabs, lone]);
});
