/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/split: a split pane's header has a ⋯ menu. wave7/split2: it holds
// exactly Arc's per-pane items (the split row's "<page title> ▸" submenu),
// and "Always show split pane headers" keeps the header up like Arc's.

const { WhimsySplitPane } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySplitPane.sys.mjs");

// Arc's per-pane submenu (arc-ref menus-context.txt), as l10n ids.
const ARC_PANE_ITEMS = [
  "whimsy-split-pane-separate",
  "-",
  "menu-file-share-url",
  "whimsy-split-pane-mute",
  "whimsy-split-pane-copy-link",
  "whimsy-split-pane-copy-markdown",
  "-",
  "whimsy-split-pane-archive",
];

async function makeSplit(count, prefix = "pane") {
  const tabs = [];
  for (let i = 0; i < count; i++) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, `https://example.com/?${prefix}-${i}`));
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

async function closePaneMenu() {
  const hidden = BrowserTestUtils.waitForPopupEvent(paneMenu(), "hidden");
  paneMenu().hidePopup();
  await hidden;
}

function describe(popup) {
  return [...popup.children]
    .filter(el => !el.hidden)
    .map(el => (el.localName == "menuseparator" ? "-" : document.l10n.getAttributes(el).id));
}

async function choose(id) {
  const menu = paneMenu();
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(document.getElementById(id));
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
  for (const cls of ["whimsy-split-pane-back", "whimsy-split-pane-forward", "whimsy-split-pane-reload", "whimsy-split-pane-host"]) {
    is(getComputedStyle(header.querySelector(`.${cls}`)).display, "none", `${cls} only shows with headers always on`);
  }

  button.focus();
  ok(header.matches(":focus-within"), "Keyboard focus on the ⋯ button shows the header");
  button.blur();
  cleanup(tabs);
});

add_task(async function test_menu_is_arcs_pane_submenu() {
  const tabs = await makeSplit(3);
  const menu = await openPaneMenu(tabs[1]);
  ok(headerOf(tabs[1]).hasAttribute("whimsy-menu-open"), "The header stays up while its menu is open");
  Assert.deepEqual(describe(menu), ARC_PANE_ITEMS, "Arc's per-pane items, in Arc's order");
  ok(document.getElementById("whimsySplitPane-mute").disabled, "Mute is greyed out on a silent pane, like Arc");
  is(document.getElementById("whimsySplitPane-copyLink").getAttribute("key"), "zen-copy-url", "Copy Link shows ⇧⌘C");
  await closePaneMenu();
  ok(!headerOf(tabs[1]).hasAttribute("whimsy-menu-open"), "The header hides again with the menu");
  cleanup(tabs);
});

add_task(async function test_separate_acts_on_its_pane() {
  const tabs = await makeSplit(3);
  is(gBrowser.selectedTab, tabs[0], "The first pane is focused");
  await openPaneMenu(tabs[2]);
  await choose("whimsySplitPane-separate");
  await TestUtils.waitForCondition(() => !tabs[2].splitView, "The pane the menu came from left the split");
  is(gBrowser.selectedTab, tabs[2], "and it's in front");
  ok(tabs[0].splitView && tabs[1].splitView, "The other two stay split");
  cleanup(tabs);
});

add_task(async function test_copy_link_copies_that_pane() {
  const tabs = await makeSplit(2, "copy");
  await openPaneMenu(tabs[1]);
  await SimpleTest.promiseClipboardChange("https://example.com/?copy-1", () => choose("whimsySplitPane-copyLink"));
  await openPaneMenu(tabs[0]);
  await SimpleTest.promiseClipboardChange(
    data => data.includes("](https://example.com/?copy-0)"),
    () => choose("whimsySplitPane-copyMarkdown")
  );
  ok(true, "Each pane's own link, plain and as Markdown");
  cleanup(tabs);
});

add_task(async function test_archive_closes_that_pane() {
  const tabs = await makeSplit(3);
  await openPaneMenu(tabs[2]);
  await choose("whimsySplitPane-archive");
  await TestUtils.waitForCondition(() => !tabs[2].isConnected || tabs[2].closing, "Archive Item closes that pane");
  ok(tabs[0].splitView && tabs[1].splitView, "The others stay split");
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
  await closePaneMenu();
  cleanup(tabs);
});

add_task(async function test_always_show_headers_setting() {
  const tabs = await makeSplit(2, "always");
  const header = headerOf(tabs[1]);
  // Nothing hovers the second pane here.
  await TestUtils.waitForCondition(() => getComputedStyle(header).opacity == "0", "Off (default): the header waits for hover");
  ok(!Services.prefs.getBoolPref("whimsy.split.always-show-headers"), "Off by default");

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.split.always-show-headers", true]] });
  await TestUtils.waitForCondition(() => getComputedStyle(header).opacity == "1", "On: the header is always up, like Arc's");
  const container = tabs[1].linkedBrowser.closest(".browserSidebarContainer");
  ok(parseFloat(getComputedStyle(container).paddingTop) > 0, "and the pane makes room for it");
  is(getComputedStyle(header).pointerEvents, "auto", "Its buttons take clicks without a hover");
  for (const cls of ["whimsy-split-pane-back", "whimsy-split-pane-forward", "whimsy-split-pane-reload"]) {
    isnot(getComputedStyle(header.querySelector(`.${cls}`)).display, "none", `Arc's ${cls} button shows`);
  }
  is(header.querySelector(".whimsy-split-pane-host-label").getAttribute("value"), "example.com", "The pane's host, centred like Arc's");
  ok(header.querySelector(".whimsy-split-pane-back").hasAttribute("disabled"), "Back is off on a fresh page");

  await SpecialPowers.popPrefEnv();
  await TestUtils.waitForCondition(() => getComputedStyle(header).opacity == "0", "Off again: back to the hover header");
  is(parseFloat(getComputedStyle(container).paddingTop) || 0, 0, "and the page gets its room back");
  cleanup(tabs);
});

add_task(async function test_switch_off_gives_the_tab_menu_back() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.split-pane-menu", false],
      ["whimsy.feature.split-row-menu", false],
    ],
  });
  const tabs = [];
  for (let i = 0; i < 2; i++) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, `https://example.com/?off-${i}`));
  }
  gZenViewSplitter.splitTabs(tabs, "vsep", 0);
  await TestUtils.waitForCondition(() => tabs.every(t => t.splitView), "Split");
  ok(!WhimsySplitPane.openMenuForTab(window, tabs[0]), "No pane menu with the switch off");
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(tabs[0], { type: "contextmenu", button: 2 });
  await shown;
  ok(!document.getElementById("context_zenSplitTabs").hidden, "Zen's item is back on a split tab");
  ok(!document.getElementById("context_whimsyFollowerSplit")?.hidden, "and so is the follower item");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
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
      "browser/menubar.ftl",
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
  is(label("whimsy-menu-expand-split"), "Expand Current Split", "Arc's View menu: keep this pane, close the others");
  is(value("whimsy-action-close-other-panes"), "Expand Current Split", "same action in the command bar");
  is(label("whimsy-menu-close-split-pane"), "Close this Split Pane", "Arc's Close this Split Pane");
  is(label("whimsy-menu-separate-page"), "Separate Page from Split View", "One pane (View menu)");
  Assert.deepEqual(
    ARC_PANE_ITEMS.filter(id => id != "-").map(id => label(id)),
    ["Separate from Split View", "Share", "Mute", "Copy Link", "Copy link as Markdown", "Archive Item"],
    "Arc's per-pane labels, word for word"
  );
  is(label("whimsy-split-always-show-headers"), "Always show split pane headers", "The setting");
});
