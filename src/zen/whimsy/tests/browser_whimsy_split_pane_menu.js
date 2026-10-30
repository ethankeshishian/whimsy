/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/split: a split pane's actions live in its header's ⋯ menu; the tab
// menu keeps only the item that creates a split; Arc's split view names.

const { WhimsySplitPane } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySplitPane.sys.mjs");
const { WhimsyFollowerTabs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFollowerTabs.sys.mjs");
const { WhimsySplitKeys } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySplitKeys.sys.mjs");

async function makeSplit(count) {
  const tabs = [];
  for (let i = 0; i < count; i++) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, `https://example.com/?pane-${i}`));
  }
  gZenViewSplitter.splitTabs(tabs, "vsep", 0);
  await TestUtils.waitForCondition(() => tabs.every(t => t.splitView), `${count} panes`);
  gBrowser.selectedTab = tabs[0];
  await TestUtils.waitForCondition(() => tabs.every(t => headerOf(t)?.querySelector(".whimsy-split-pane-menu-button")), "Every pane header has a ⋯ button");
  return tabs;
}

function headerOf(tab) {
  return tab.linkedBrowser.closest(".browserSidebarContainer")?.querySelector(".zen-view-splitter-header-container");
}

function cleanup(tabs) {
  for (const tab of tabs) {
    if (tab.isConnected && !tab.closing) {
      BrowserTestUtils.removeTab(tab);
    }
  }
}

function paneMenu() {
  return document.getElementById("whimsySplitPaneMenu");
}

async function openPaneMenu(tab, options) {
  WhimsySplitPane.ensureMenu(window);
  const shown = BrowserTestUtils.waitForPopupEvent(paneMenu(), "shown");
  ok(WhimsySplitPane.openMenuForTab(window, tab, options), "The pane menu opens");
  await shown;
  return paneMenu();
}

function visibleIds(menu) {
  return [...menu.children].filter(el => el.localName == "menuitem" && !el.hidden).map(el => el.id);
}

async function choose(id) {
  const menu = paneMenu();
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(document.getElementById(id));
  await hidden;
}

async function openTabMenu(tab) {
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
  await shown;
  return menu;
}

async function closeTabMenu() {
  const menu = document.getElementById("tabContextMenu");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
}

add_task(async function test_header_has_a_menu_button() {
  const tabs = await makeSplit(2);
  const header = headerOf(tabs[1]);
  const button = header.querySelector(".whimsy-split-pane-menu-button");
  is(button.getAttribute("tabindex"), "0", "The ⋯ button is reachable by keyboard");
  is(document.l10n.getAttributes(button).id, "whimsy-split-pane-menu-button", "The ⋯ button has a name");
  is(document.l10n.getAttributes(header.querySelector(".zen-tab-rearrange-button")).id, "whimsy-split-pane-drag", "The drag handle has a name");
  is(getComputedStyle(header.querySelector(".zen-tab-unsplit-button")).display, "none", "Zen's unlabelled separate button is gone (it's in the menu)");

  button.focus();
  ok(header.matches(":focus-within"), "Keyboard focus on the ⋯ button shows the header");
  button.blur();
  cleanup(tabs);
});

add_task(async function test_menu_lists_the_pane_actions() {
  const tabs = await makeSplit(3);
  const menu = await openPaneMenu(tabs[1]);
  ok(headerOf(tabs[1]).hasAttribute("whimsy-menu-open"), "The header stays up while its menu is open");
  const expected = [
    "whimsySplitPane-separate",
    "whimsySplitPane-separateAll",
    "whimsySplitPane-swap",
    "whimsySplitPane-favorite",
    ...(gZenShareManager.enabled ? ["whimsySplitPane-share"] : []),
    "whimsySplitPane-close",
    "whimsySplitPane-closeOthers",
  ];
  Assert.deepEqual(visibleIds(menu), expected, "Three panes: every pane action but Follower (2 panes only)");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
  ok(!headerOf(tabs[1]).hasAttribute("whimsy-menu-open"), "The header hides again with the menu");
  cleanup(tabs);
});

add_task(async function test_separate_page_acts_on_its_pane() {
  const tabs = await makeSplit(3);
  is(gBrowser.selectedTab, tabs[0], "The first pane is focused");
  await openPaneMenu(tabs[2]);
  await choose("whimsySplitPane-separate");
  await TestUtils.waitForCondition(() => !tabs[2].splitView, "The pane the menu came from left the split");
  is(gBrowser.selectedTab, tabs[2], "and it's in front");
  ok(tabs[0].splitView && tabs[1].splitView, "The other two stay split");
  cleanup(tabs);
});

add_task(async function test_separate_all_tabs() {
  const tabs = await makeSplit(3);
  await openPaneMenu(tabs[1]);
  await choose("whimsySplitPane-separateAll");
  await TestUtils.waitForCondition(() => tabs.every(t => !t.splitView), "Every pane is its own tab again");
  cleanup(tabs);
});

add_task(async function test_swap_and_follower_on_two_panes() {
  const tabs = await makeSplit(2);
  const group = () => gZenViewSplitter._data.find(g => g.tabs.includes(tabs[0]));
  const menu = await openPaneMenu(tabs[0]);
  ok(visibleIds(menu).includes("whimsySplitPane-follow"), "Two panes: Follower is offered");
  await choose("whimsySplitPane-swap");
  await TestUtils.waitForCondition(() => WhimsySplitKeys.panes(group())[0] == tabs[1], "The panes swapped");

  await openPaneMenu(tabs[0]);
  is(document.l10n.getAttributes(document.getElementById("whimsySplitPane-follow")).id, "tab-context-whimsy-follow", "Make This a Follower Split");
  await choose("whimsySplitPane-follow");
  await TestUtils.waitForCondition(() => WhimsyFollowerTabs.isSource(tabs[0]), "The pane is the follower split's source");

  await openPaneMenu(tabs[0]);
  is(document.l10n.getAttributes(document.getElementById("whimsySplitPane-follow")).id, "tab-context-whimsy-unfollow", "then Stop Following");
  await choose("whimsySplitPane-follow");
  ok(!WhimsyFollowerTabs.isSource(tabs[0]), "Stopped");
  cleanup(tabs);
});

add_task(async function test_close_pane_and_close_others() {
  const tabs = await makeSplit(3);
  await openPaneMenu(tabs[2]);
  await choose("whimsySplitPane-close");
  await TestUtils.waitForCondition(() => !tabs[2].isConnected || tabs[2].closing, "Close this Split Pane closes that pane");
  ok(tabs[0].splitView && tabs[1].splitView, "The others stay split");

  await openPaneMenu(tabs[0]);
  await choose("whimsySplitPane-closeOthers");
  await TestUtils.waitForCondition(() => !tabs[1].isConnected || tabs[1].closing, "Close Other Panes closes the rest");
  ok(tabs[0].isConnected && !tabs[0].splitView, "The pane it came from stays, on its own");
  cleanup(tabs);
});

add_task(async function test_keyboard_command_opens_the_focused_panes_menu() {
  const tabs = await makeSplit(2);
  gBrowser.selectedTab = tabs[1];
  const menu = WhimsySplitPane.ensureMenu(window);
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  document.getElementById("cmd_whimsySplitPaneMenu").doCommand();
  await shown;
  is(menu.whimsyTab, tabs[1], "The menu is the focused pane's");
  await TestUtils.waitForCondition(() => menu.querySelector("menuitem[_moz-menuactive]"), "Its first item is active for the arrow keys");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
  cleanup(tabs);
});

add_task(async function test_tab_menu_no_longer_duplicates_pane_actions() {
  const tabs = await makeSplit(2);
  await openTabMenu(tabs[1]);
  ok(document.getElementById("context_zenSplitTabs").hidden, "No split item on a tab that's already in a split");
  ok(document.getElementById("context_zenShareSplitView").hidden, "Share Split View is in the pane menu instead");
  const follower = document.getElementById("context_whimsyFollowerSplit");
  ok(!follower || follower.hidden, "Make This a Follower Split is in the pane menu instead");
  await closeTabMenu();

  const lone = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?lone");
  await openTabMenu(lone);
  const create = document.getElementById("context_zenSplitTabs");
  ok(!create.hidden, "A tab on its own keeps the one item that creates a split");
  is(document.l10n.getAttributes(create).args.tabCount, 1, "as Add Split View");
  await closeTabMenu();
  cleanup([...tabs, lone]);
});

add_task(async function test_switch_off_gives_the_tab_menu_back() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.split-pane-menu", false]] });
  const tabs = [];
  for (let i = 0; i < 2; i++) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, `https://example.com/?off-${i}`));
  }
  gZenViewSplitter.splitTabs(tabs, "vsep", 0);
  await TestUtils.waitForCondition(() => tabs.every(t => t.splitView), "Split");
  ok(!WhimsySplitPane.openMenuForTab(window, tabs[0]), "No pane menu with the switch off");
  await openTabMenu(tabs[0]);
  ok(!document.getElementById("context_zenSplitTabs").hidden, "Zen's item is back on a split tab");
  ok(!document.getElementById("context_whimsyFollowerSplit")?.hidden, "and so is the follower item");
  await closeTabMenu();
  cleanup(tabs);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_arc_labels() {
  const l10n = new Localization(
    [
      "browser/zen-split-view.ftl",
      "browser/zen-command-palette.ftl",
      "browser/zen-workspaces.ftl",
      "browser/preferences/zen-preferences.ftl",
      "browser/whimsy.ftl",
    ],
    true
  );
  const label = (id, args) => l10n.formatMessagesSync([{ id, args }])[0].attributes.find(a => a.name == "label").value;
  const value = id => l10n.formatValueSync(id);
  is(label("tab-zen-split-tabs", { tabCount: 1 }), "Add Split View", "Tab menu, one tab");
  is(label("tab-zen-split-tabs", { tabCount: 3 }), "Open 3 Tabs in Split View", "Tab menu, several tabs");
  is(label("tab-zen-split-tabs", { tabCount: -1 }), "Separate Page from Split View", "Never 'Split Out Tab'");
  is(label("zen-split-link"), "Open Link in Split View", "Link menu");
  is(label("zen-panel-ui-new-empty-split"), "Add Split View", "New tab menu");
  is(value("zen-action-new-split-view"), "Add Split View", "Command bar: create");
  is(value("zen-action-unsplit-view"), "Separate All Tabs", "Command bar: undo");
  is(value("zen-split-view-shortcut-unsplit"), "Separate All Tabs", "Shortcuts: undo");
  is(value("zen-new-empty-split-view-shortcut"), "Add Split View", "Shortcuts: create");
  is(value("whimsy-cheatsheet-unsplit"), "Separate All Tabs", "Cheat sheet");
  is(label("whimsy-menu-expand-split"), "Separate All Tabs", "View menu and pane menu");
  is(label("whimsy-menu-separate-page"), "Separate Page from Split View", "One pane");
});
