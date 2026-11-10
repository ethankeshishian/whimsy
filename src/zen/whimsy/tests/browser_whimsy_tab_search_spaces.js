/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W24/tabsearch (BUGS.md #16): typing in the new-tab bar or ⌘L finds an open
// tab in every space and every Whimsy profile (profiles are containers;
// spaces carry containerTabId), by title or by a renamed tab's custom
// label, essentials and pinned tabs included. A row for a tab in another
// space shows that space's icon and name after the title; the current
// space never does. Firefox's own "Switch to Tab" row for the same tab
// never shows twice. Private windows are unchanged: this file owns
// ZenUrlbarProviderSidebar's part of that (src/zen/urlbar/ZenUBSidebarProvider.sys.mjs);
// the typed-address jump across profiles is covered in
// browser_whimsy_already_open.js's test_cross_profile_jump_and_private_never_match.

ChromeUtils.defineESModuleGetters(this, {
  UrlbarShared: "chrome://browser/content/urlbar/UrlbarShared.mjs",
  UrlbarTestUtils: "resource://testing-common/UrlbarTestUtils.sys.mjs",
  WhimsyAlreadyOpen: "resource:///modules/whimsy/WhimsyAlreadyOpen.sys.mjs",
  SessionSaver: "moz-src:///browser/components/sessionstore/SessionSaver.sys.mjs",
  TabStateFlusher: "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs",
});

const PROVIDER_NAME = "ZenUrlbarProviderSidebar";

let homeSpace;

add_setup(async function () {
  homeSpace = gZenWorkspaces.getWorkspaces().find(
    w => w.uuid == gZenWorkspaces.activeWorkspace
  );
  registerCleanupFunction(async () => {
    await gZenWorkspaces.changeWorkspace(homeSpace);
  });
});

async function collectSidebarData() {
  await TabStateFlusher.flushWindow(window);
  await SessionSaver.run();
}

// Every ZenUrlbarProviderSidebar row for this search, in result order, with
// the DOM row (so a test can read what's actually drawn, not just the
// result payload).
async function searchSidebarRows(value) {
  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    waitForFocus,
    value,
  });
  const rowsEl = window.gURLBar.view.panel.querySelector(".urlbarView-results");
  const rows = [];
  for (let index = 0; index < UrlbarTestUtils.getResultCount(window); index++) {
    const { result } = await UrlbarTestUtils.getRowAt(window, index);
    if (result.providerName == PROVIDER_NAME) {
      rows.push({ index, result, row: rowsEl.children[index] });
    }
  }
  return rows;
}

async function addTab(url) {
  const tab = BrowserTestUtils.addTab(gBrowser, url, { skipAnimation: true });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  return tab;
}

function labelTab(tab, label) {
  tab.zenStaticLabel = label;
  gBrowser._setTabLabel(tab, label);
}

async function containerSpace(name, icon, containerTabId) {
  const space = await gZenWorkspaces.createAndSaveWorkspace(name, icon, true, containerTabId);
  registerCleanupFunction(async () => {
    for (const tab of gZenWorkspaces.allStoredTabs.filter(
      t =>
        t.getAttribute("zen-workspace-id") == space.uuid &&
        !t.hasAttribute("zen-essential") &&
        !t.hasAttribute("zen-empty-tab")
    )) {
      BrowserTestUtils.removeTab(tab);
    }
    if (gZenWorkspaces.getWorkspaces().some(w => w.uuid == space.uuid)) {
      await gZenWorkspaces.removeWorkspace(space.uuid);
    }
  });
  return space;
}

// Picks a row and waits for the space switch (or none, for a current-space
// row) and the tab selection it causes.
async function pickRow(row) {
  UrlbarTestUtils.setSelectedRowIndex(window, row.index);
  await UrlbarTestUtils.promisePopupClose(window, () =>
    EventUtils.synthesizeKey("KEY_Enter")
  );
}

add_task(async function test_other_space_same_profile_by_title_and_label() {
  const titled = await addTab("data:text/html,<title>Tabsearch report alpha</title>");
  const custom = await addTab("https://example.com/");
  labelTab(custom, "Tabsearch custom beta");

  const spaceB = await containerSpace("Tabsearch space B", "🅱️");
  await gZenWorkspaces.changeWorkspace(spaceB);
  await collectSidebarData();

  let rows = await searchSidebarRows("tabsearch report alpha");
  Assert.equal(rows.length, 1, "The other-space tab is found by its real title");
  ok(
    rows[0].result.payload.zenSpaceBadge?.includes(homeSpace.name),
    "Labelled with the tab's own space name"
  );
  if (homeSpace.icon && !homeSpace.icon.endsWith(".svg")) {
    ok(
      rows[0].result.payload.zenSpaceBadge.includes(homeSpace.icon),
      "...and its icon"
    );
  }
  is(
    rows[0].row.querySelector(".urlbarView-url").textContent,
    rows[0].result.payload.zenSpaceBadge,
    "The row shows the space badge where the url would otherwise go"
  );
  await pickRow(rows[0]);
  await TestUtils.waitForCondition(
    () => gZenWorkspaces.activeWorkspace == homeSpace.uuid && gBrowser.selectedTab == titled,
    "Picking it switches space and selects the tab"
  );
  is(
    titled.getAttribute("zen-workspace-id"),
    homeSpace.uuid,
    "The tab's space is unchanged"
  );

  await gZenWorkspaces.changeWorkspace(spaceB);
  rows = await searchSidebarRows("tabsearch custom beta");
  Assert.equal(rows.length, 1, "The other-space tab is also found by its custom label");
  ok(
    rows[0].result.payload.zenSpaceBadge?.includes(homeSpace.name),
    "Labelled the same way"
  );
  await UrlbarTestUtils.promisePopupClose(window);

  await gZenWorkspaces.changeWorkspace(homeSpace);
  BrowserTestUtils.removeTab(titled);
  BrowserTestUtils.removeTab(custom);
});

add_task(async function test_other_profile_space_found_labelled_and_container_kept() {
  const spaceC = await containerSpace("Tabsearch space C", "🅲", 1);
  await gZenWorkspaces.changeWorkspace(spaceC);
  const contained = await addTab("https://example.com/");
  labelTab(contained, "Tabsearch custom gamma");
  await gZenWorkspaces.changeWorkspace(homeSpace);
  await collectSidebarData();

  const rows = await searchSidebarRows("tabsearch custom gamma");
  Assert.equal(rows.length, 1, "A tab in another profile's space is found");
  ok(
    rows[0].result.payload.zenSpaceBadge?.includes(spaceC.name),
    "Labelled with that profile's space"
  );
  is(
    rows[0].result.payload.userContext?.id,
    1,
    "The result carries the tab's own container"
  );

  await pickRow(rows[0]);
  await TestUtils.waitForCondition(
    () => gZenWorkspaces.activeWorkspace == spaceC.uuid && gBrowser.selectedTab == contained,
    "Picking it switches to that profile's space and selects the tab"
  );
  is(
    WhimsyAlreadyOpen.userContextOf(contained),
    1,
    "The tab stays in its own container; nothing moved"
  );

  await gZenWorkspaces.changeWorkspace(homeSpace);
  await gZenWorkspaces.changeWorkspace(spaceC);
  BrowserTestUtils.removeTab(contained);
  await gZenWorkspaces.changeWorkspace(homeSpace);
});

add_task(async function test_current_space_ranks_above_other_space_no_duplicate() {
  const here = await addTab("https://example.com/");
  labelTab(here, "Tabsearch tie match");

  const spaceD = await containerSpace("Tabsearch space D", "🌀");
  await gZenWorkspaces.changeWorkspace(spaceD);
  const elsewhere = await addTab("https://example.org/");
  labelTab(elsewhere, "Tabsearch tie match");
  await gZenWorkspaces.changeWorkspace(homeSpace);
  await collectSidebarData();

  const rows = await searchSidebarRows("tabsearch tie match");
  Assert.equal(rows.length, 2, "Both tabs match once each; no duplicate for either");
  is(rows[0].result.payload.url, "https://example.com/", "Current-space tab ranks first");
  ok(!rows[0].result.payload.zenSpaceBadge, "...with no space label");
  is(rows[1].result.payload.url, "https://example.org/", "Other-space tab ranks second");
  ok(rows[1].result.payload.zenSpaceBadge, "...labelled with its space");

  await UrlbarTestUtils.promisePopupClose(window);
  BrowserTestUtils.removeTab(here);
  await gZenWorkspaces.changeWorkspace(spaceD);
  BrowserTestUtils.removeTab(elsewhere);
  await gZenWorkspaces.changeWorkspace(homeSpace);
});

add_task(async function test_dedup_drops_firefoxs_own_row_for_the_same_tab() {
  const TAB_SWITCH = UrlbarShared.RESULT_TYPE.TAB_SWITCH;
  const ours = {
    providerName: PROVIDER_NAME,
    type: TAB_SWITCH,
    payload: { url: "https://example.com/", userContext: { id: 0 } },
  };
  const native = {
    providerName: "UrlbarProviderOpenTabs",
    type: TAB_SWITCH,
    payload: { url: "https://example.com/", userContext: { id: 0 } },
  };
  const unrelated = {
    providerName: "UrlbarProviderOpenTabs",
    type: TAB_SWITCH,
    payload: { url: "https://example.org/", userContext: { id: 0 } },
  };
  const queryContext = { results: [ours, native, unrelated] };
  WhimsyAlreadyOpen.dropDuplicateSidebarRows(window, queryContext);
  Assert.deepEqual(
    queryContext.results,
    [ours, unrelated],
    "Firefox's own tab-switch row for the same tab is dropped; ours (the one with the label) stays"
  );
});

add_task(async function test_private_and_normal_windows_never_cross() {
  const normalTab = await addTab("https://example.com/");
  labelTab(normalTab, "Tabsearch private isolation");
  await collectSidebarData();

  const privateWin = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    await UrlbarTestUtils.promiseAutocompleteResultPopup({
      window: privateWin,
      waitForFocus,
      value: "tabsearch private isolation",
    });
    let found = false;
    for (let i = 0; i < UrlbarTestUtils.getResultCount(privateWin); i++) {
      const { result } = await UrlbarTestUtils.getRowAt(privateWin, i);
      if (result.providerName == PROVIDER_NAME) {
        found = true;
      }
    }
    ok(!found, "A private window never offers a normal tab");
    await UrlbarTestUtils.promisePopupClose(privateWin);

    const privateTab = await BrowserTestUtils.openNewForegroundTab(
      privateWin.gBrowser,
      "https://example.org/"
    );
    privateTab.zenStaticLabel = "Tabsearch private tab itself";
    privateWin.gBrowser._setTabLabel(privateTab, "Tabsearch private tab itself");

    const rows = await searchSidebarRows("tabsearch private tab itself");
    is(rows.length, 0, "A normal window never offers a private tab");
  } finally {
    await UrlbarTestUtils.promisePopupClose(window);
    await BrowserTestUtils.closeWindow(privateWin);
  }
  BrowserTestUtils.removeTab(normalTab);
});
