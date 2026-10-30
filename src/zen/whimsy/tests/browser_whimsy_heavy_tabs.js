/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Find heavy tabs: ChromeUtils.requestProcInfo()'s per-process windows map
// back to real tabs, grouped by process (so same-site tabs sharing one
// content process are counted together, not double-counted), and closing a
// tab from the list removes it.

const { WhimsyHeavyTabs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyHeavyTabs.sys.mjs");

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    if (tab.isConnected && !tab.closing) {
      BrowserTestUtils.removeTab(tab);
    }
  }
});

add_task(async function test_sample_maps_processes_to_real_tabs() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?heavy");
  const groups = await WhimsyHeavyTabs.sample(window);
  ok(Array.isArray(groups), "A list of groups");
  const allTabs = groups.flatMap(g => g.tabs);
  ok(allTabs.includes(tab), "The new tab shows up in some process group");
  const owningGroup = groups.find(g => g.tabs.includes(tab));
  ok(owningGroup.memory >= 0, "Its process reports a memory figure");
  // No tab is double-counted across groups.
  const seen = new Set();
  for (const t of allTabs) {
    ok(!seen.has(t), "Each tab appears in only one process group");
    seen.add(t);
  }
  BrowserTestUtils.removeTab(tab);
});

add_task(function test_format_bytes() {
  is(WhimsyHeavyTabs.formatBytes(50 * 1024 * 1024), "50 MB", "Megabytes below 1 GB");
  is(WhimsyHeavyTabs.formatBytes(2.5 * 1024 * 1024 * 1024), "2.5 GB", "Gigabytes above that");
});

// fixB: the Heavy Tabs sheet (WhimsyPanels): a caption per process with
// its memory, then that process's tabs; a row's close button closes the
// tab, and the polling stops once the sheet is closed.
add_task(async function test_heavy_tabs_sheet() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?heavy-sheet");
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsyHeavyTabsPanel");
  WhimsyHeavyTabs.openPanel(window);
  await shown;
  const panel = document.getElementById("whimsyHeavyTabsPanel");
  ok(panel.classList.contains("whimsy-sheet"), "It is a Whimsy sheet");
  await TestUtils.waitForCondition(() => panel.querySelector(".whimsy-heavy-tabs-group"), "Process captions render");
  ok(/\d+ (MB|GB)/.test(panel.querySelector(".whimsy-heavy-tabs-group label").value), "A caption shows memory");
  const line = [...panel.querySelectorAll(".whimsy-sheet-line")].find(l => l._whimsyTab == tab);
  ok(line, "The new tab has a row");
  ok(panel._timer != null, "It refreshes while open");
  line.querySelector(".whimsy-heavy-tabs-close").doCommand();
  await TestUtils.waitForCondition(() => !tab.isConnected, "The row's close button closes the tab");

  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  await hidden;
  is(panel._timer, null, "Polling stops when the sheet closes");
});
