/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W30 (owner: "I can't Ctrl+Tab out of a tab when I opened a Glance from a
// link in a pinned tab, it opens as a normal tab, and now Ctrl+Tab doesn't
// work. Switching from the command bar doesn't work either."). After a Glance
// is expanded into its own tab, from any kind of parent, every way of
// switching tabs leaves it: Ctrl+Tab, selecting a tab (the command bar's
// switch-to-tab and the sidebar do this), and the page shown follows.

const { openGlanceOnTab } = ChromeUtils.importESModule("resource://testing-common/GlanceTestUtils.sys.mjs");

async function expandFrom(parent) {
  gBrowser.selectedTab = parent;
  let expanded;
  await openGlanceOnTab(
    window,
    async glanceTab => {
      await gZenGlanceManager.fullyOpenGlance();
      expanded = glanceTab;
    },
    false
  );
  return expanded;
}

function panelOf(tab) {
  return tab.linkedBrowser.closest(".browserSidebarContainer");
}

async function assertShown(tab, label) {
  is(gBrowser.selectedTab, tab, `${label}: selected`);
  await TestUtils.waitForCondition(
    () => gBrowser.tabpanels.selectedPanel == panelOf(tab) && panelOf(tab).classList.contains("deck-selected"),
    `${label}: its page is the one shown`
  );
}

async function select(tab) {
  const onSelect = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabSelect");
  gBrowser.selectedTab = tab;
  await onSelect;
}

async function quickCtrlTab() {
  const onSelect = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabSelect");
  EventUtils.synthesizeKey("VK_TAB", { ctrlKey: true });
  EventUtils.synthesizeKey("VK_CONTROL", { type: "keyup" });
  await onSelect;
}

async function checkSwitching(makeParent, cleanupParent, label, { onlyPinned = false } = {}) {
  await SpecialPowers.pushPrefEnv({ set: [["browser.ctrlTab.sortByRecentlyUsed", true]] });
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "data:text/plain,other");
  // A space with only pinned tabs (Arc-style): no normal tab to sit above.
  const pinnedHere = [];
  if (onlyPinned) {
    for (const t of gBrowser.tabs.filter(t => !t.pinned && !t.hasAttribute("zen-empty-tab"))) {
      gBrowser.pinTab(t);
      pinnedHere.push(t);
    }
  }
  const parent = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  await makeParent(parent);

  const tab = await expandFrom(parent);
  await assertShown(tab, `${label}: expanded`);
  ok(!tab.hasAttribute("glance-id") && !parent.hasAttribute("glance-id"), `${label}: no Glance link is left`);

  // Selecting a tab: the command bar's switch-to-tab, the sidebar, and
  // every other picker go through this.
  await select(other);
  await assertShown(other, `${label}: selecting another tab`);
  ok(!panelOf(tab).classList.contains("deck-selected"), `${label}: the expanded page is hidden`);

  await select(tab);
  await assertShown(tab, `${label}: selecting it again`);

  // Ctrl+Tab flips to the last-used tab and back.
  await quickCtrlTab();
  await assertShown(other, `${label}: Ctrl+Tab out`);
  await quickCtrlTab();
  await assertShown(tab, `${label}: Ctrl+Tab back`);
  await quickCtrlTab();
  await assertShown(other, `${label}: Ctrl+Tab out again`);

  // The parent is reachable too.
  await select(parent);
  await assertShown(parent, `${label}: the parent`);

  BrowserTestUtils.removeTab(tab);
  await cleanupParent(parent);
  for (const t of pinnedHere) {
    if (t != other) {
      gBrowser.unpinTab(t);
    }
  }
  BrowserTestUtils.removeTab(other);
  await SpecialPowers.popPrefEnv();
}

add_task(async function from_pinned_tab() {
  await checkSwitching(
    p => gBrowser.pinTab(p),
    p => BrowserTestUtils.removeTab(p),
    "pinned"
  );
});

add_task(async function from_pinned_tab_in_a_space_of_pinned_tabs() {
  await checkSwitching(
    p => gBrowser.pinTab(p),
    p => BrowserTestUtils.removeTab(p),
    "only pinned",
    { onlyPinned: true }
  );
});

add_task(async function from_essential_in_a_space_of_pinned_tabs() {
  await checkSwitching(
    p => gZenPinnedTabManager.addToEssentials(p),
    p => {
      gZenPinnedTabManager.removeEssentials(p);
      BrowserTestUtils.removeTab(p);
    },
    "essential, only pinned",
    { onlyPinned: true }
  );
});

add_task(async function from_essential() {
  await checkSwitching(
    p => gZenPinnedTabManager.addToEssentials(p),
    p => {
      gZenPinnedTabManager.removeEssentials(p);
      BrowserTestUtils.removeTab(p);
    },
    "essential"
  );
});

add_task(async function from_normal_tab() {
  await checkSwitching(
    () => {},
    p => BrowserTestUtils.removeTab(p),
    "normal"
  );
});
