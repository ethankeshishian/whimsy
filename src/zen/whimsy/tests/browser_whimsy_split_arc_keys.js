/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave6/parity: Arc's Split View commands and Ctrl+Shift keys.

async function threePaneSplit() {
  const tabs = [];
  for (const name of ["a", "b", "c"]) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, `https://example.com/?pane-${name}`));
  }
  gZenViewSplitter.splitTabs(tabs, "vsep", 0);
  await TestUtils.waitForCondition(() => tabs.every(t => t.splitView), "Three panes");
  gBrowser.selectedTab = tabs[0];
  return tabs;
}

function cleanup(tabs) {
  for (const tab of tabs) {
    if (tab.isConnected && !tab.closing) {
      BrowserTestUtils.removeTab(tab);
    }
  }
}

function press(code, key) {
  EventUtils.synthesizeKey(key, { ctrlKey: true, shiftKey: true, code });
}

add_task(function test_keys_registered() {
  for (const [id, keycode] of [
    ["key_whimsyAddSplitView", "VK_EQUALS"],
    ["key_whimsyCloseSplitPane", "VK_HYPHEN_MINUS"],
    ["key_whimsyFocusPane1", "VK_1"],
    ["key_whimsyFocusPane4", "VK_4"],
    ["key_whimsyPrevPane", "VK_OPEN_BRACKET"],
    ["key_whimsyNextPane", "VK_CLOSE_BRACKET"],
  ]) {
    const key = document.getElementById(id);
    ok(key, `${id} exists`);
    is(key.getAttribute("keycode"), keycode, `${id} keycode`);
    is(key.getAttribute("modifiers"), "control,shift", `${id} is Ctrl+Shift`);
  }
  for (const id of ["menu_whimsyAddSplitView", "menu_whimsyCloseSplitPane", "menu_whimsySeparatePage", "menu_whimsyExpandSplit"]) {
    ok(document.getElementById(id), `View menu has ${id}`);
  }
  ok(document.getElementById("zen-split-view-vertical")?.getAttribute("key"), "Zen's own split keys stay");
});

add_task(async function test_focus_and_cycle_panes() {
  const tabs = await threePaneSplit();
  const space = gZenWorkspaces.activeWorkspace;
  press("Digit3", "#");
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == tabs[2], "Ctrl+Shift+3 focuses the third pane");
  is(gZenWorkspaces.activeWorkspace, space, "and doesn't switch space (Ctrl+3)");
  press("BracketRight", "}");
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == tabs[0], "Ctrl+Shift+] wraps to the first pane");
  press("BracketLeft", "{");
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == tabs[2], "Ctrl+Shift+[ goes back");
  cleanup(tabs);
});

add_task(async function test_separate_and_close_pane() {
  const tabs = await threePaneSplit();
  gBrowser.selectedTab = tabs[1];
  document.getElementById("cmd_whimsySeparatePage").doCommand();
  await TestUtils.waitForCondition(() => !tabs[1].splitView, "Separated");
  is(gBrowser.selectedTab, tabs[1], "The separated page stays in front");
  ok(tabs[0].splitView && tabs[2].splitView, "The other two stay split");

  gBrowser.selectedTab = tabs[2];
  press("Minus", "_");
  await TestUtils.waitForCondition(() => !tabs[2].isConnected || tabs[2].closing, "Ctrl+Shift+- closes the pane");
  ok(!tabs[0].splitView, "The last pane is a plain tab again");
  cleanup(tabs);
});

add_task(async function test_switch_off() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.split-arc-keys", false]] });
  const tabs = await threePaneSplit();
  press("BracketRight", "}");
  await new Promise(resolve => setTimeout(resolve, 100));
  is(gBrowser.selectedTab, tabs[0], "The keys do nothing with the switch off");
  cleanup(tabs);
  await SpecialPowers.popPrefEnv();
});
