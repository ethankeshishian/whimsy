/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W28: Search With ▸, right after "Search <engine> for "…"" in the
// selection menu. Lists the other visible engines (Settings order, minus
// the default); clicking one searches it for the selection exactly like the
// row above: same code path (gContextMenu.loadSearch ->
// SearchUIUtils.loadSearchFromContext), same tab-placement rule, same
// foreground/background pref, same private handling.

const { SearchTestUtils } = ChromeUtils.importESModule("resource://testing-common/SearchTestUtils.sys.mjs");
const { SearchService } = ChromeUtils.importESModule("moz-src:///toolkit/components/search/SearchService.sys.mjs");
const { WhimsyMenuPrefs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMenuPrefs.sys.mjs");

SearchTestUtils.init(this);

const PAGE =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_verbs.html";
const ROW_ID = "context-whimsy-searchwith";

async function select(browser, id, text = null) {
  await SpecialPowers.spawn(browser, [id, text], (elementId, replacement) => {
    const node = content.document.getElementById(elementId);
    if (replacement) {
      node.textContent = replacement;
    }
    const selection = content.getSelection();
    selection.removeAllRanges();
    const range = content.document.createRange();
    range.selectNodeContents(node);
    selection.addRange(range);
  });
}

async function openMenu(browser, elementId = "event") {
  const menu = document.getElementById("contentAreaContextMenu");
  const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
  await BrowserTestUtils.synthesizeMouseAtCenter(`#${elementId}`, { type: "contextmenu", button: 2 }, browser);
  await shown;
  return menu;
}

async function closeMenu(menu) {
  const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
  menu.hidePopup();
  await hidden;
}

function shows(node) {
  return !!node && !node.hidden && node.getAttribute("collapsed") != "true";
}

// Opens the Search With submenu itself (as browser_whimsy_screens_4.js does
// for Quick Actions ▸), so XULPopupElement.activateItem can run an item
// inside it: it requires the item's own containing popup to be open.
async function openSubmenu(row) {
  const shown = BrowserTestUtils.waitForEvent(row.menupopup, "popupshown");
  row.openMenu(true);
  await shown;
}

async function installEngine(name, path, options = {}) {
  await SearchTestUtils.installSearchExtension(
    { name, search_url: `https://example.com/${path}`, search_url_get_params: "q={searchTerms}" },
    options
  );
  return SearchService.getEngineByName(name);
}

// Hides every other visible engine and puts `engines` in that order, so the
// submenu's contents are deterministic whatever else the test profile ships.
async function onlyTheseEngines(engines) {
  const keep = new Set(engines.map(e => e.name));
  const others = SearchService.visibleEngines.filter(e => !keep.has(e.name));
  for (const engine of others) {
    engine.hidden = true;
  }
  for (let i = 0; i < engines.length; i++) {
    await SearchService.moveEngine(engines[i], i, null, true);
  }
  return () => {
    for (const engine of others) {
      engine.hidden = false;
    }
  };
}

function rowFor(popup, label) {
  return [...popup.children].find(n => n.getAttribute("label") == label);
}

let engineA, engineB, engineC;

add_setup(async function () {
  engineA = await installEngine("Whimsy Search A", "a", { setAsDefault: true });
  engineB = await installEngine("Whimsy Search B", "b");
  engineC = await installEngine("Whimsy Search C", "c");
});

add_task(async function test_lists_other_engines_in_settings_order() {
  const restore = await onlyTheseEngines([engineA, engineB, engineC]);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  try {
    await select(tab.linkedBrowser, "event");
    const menu = await openMenu(tab.linkedBrowser);
    const row = document.getElementById(ROW_ID);
    ok(shows(row), "Search With shows with three visible engines");
    const labels = [...row.menupopup.children].filter(n => !n.hidden).map(n => n.getAttribute("label"));
    Assert.deepEqual(labels, [engineB.name, engineC.name], "Lists the other two engines, without the default, in Settings order");
    await closeMenu(menu);
  } finally {
    await BrowserTestUtils.removeTab(tab);
    restore();
  }
});

// Each task below starts from its own fresh tab, so the tab-placement
// assertion ("right next to the tab that opened the menu") is compared
// against that one originating tab only — no chaining of two consecutive
// searches, which would instead exercise relatedToCurrent's "next to the
// most-recently-opened related tab" rule and isn't what's being proven here.
async function searchAndGetResultTab(tab, activate) {
  await select(tab.linkedBrowser, "event", "whimsy search with test");
  const menu = await openMenu(tab.linkedBrowser);
  const tabOpened = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabOpen");
  await activate(menu);
  const resultTab = (await tabOpened).target;
  // The tab exists as soon as TabOpen fires, but navigation to the engine's
  // URL is still async — wait for it before reading currentURI.
  await BrowserTestUtils.browserLoaded(resultTab.linkedBrowser);
  return resultTab;
}

add_task(async function test_opens_like_the_default_row_default_engine() {
  // Owner's sign-off: "Does it open in another tab? It should match the
  // google/default one." The default row's own baseline: a new tab right
  // after the tab that opened the menu, foreground by default.
  const restore = await onlyTheseEngines([engineA, engineB, engineC]);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const originalIndex = gBrowser.tabs.indexOf(tab);
  let resultTab;
  try {
    resultTab = await searchAndGetResultTab(tab, menu => {
      menu.activateItem(document.getElementById("context-searchselect"));
    });
    is(gBrowser.tabs.indexOf(resultTab), originalIndex + 1, "The default row's results open right next to the tab that opened the menu");
    is(gBrowser.selectedTab, resultTab, "…in the foreground (loadInBackground is off by default)");
    is(resultTab.linkedBrowser.currentURI.spec, "https://example.com/a?q=whimsy+search+with+test", "The default engine's results, for the selection");
  } finally {
    if (resultTab) {
      await BrowserTestUtils.removeTab(resultTab);
    }
    await BrowserTestUtils.removeTab(tab);
    restore();
  }
});

add_task(async function test_opens_like_the_default_row_search_with_engine() {
  // Same scenario, same assertions, but through the Search With row —
  // proving it matches the default row's placement exactly.
  const restore = await onlyTheseEngines([engineA, engineB, engineC]);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const originalIndex = gBrowser.tabs.indexOf(tab);
  let resultTab;
  try {
    resultTab = await searchAndGetResultTab(tab, async menu => {
      const searchWithRow = document.getElementById(ROW_ID);
      await openSubmenu(searchWithRow);
      menu.activateItem(rowFor(searchWithRow.menupopup, engineB.name));
    });
    // TEMP DIAGNOSTIC (W28): a terse tab-list dump, short enough to survive
    // reason.py's 220-char line truncation (the earlier verbose dump with
    // full URLs got cut off before the useful part).
    const map = gBrowser.tabs
      .map(t => (t == tab ? "O" : t == resultTab ? "R" : t.linkedBrowser.currentURI.spec == "about:blank" ? "b" : "x"))
      .join("");
    is(gBrowser.tabs.indexOf(resultTab), originalIndex + 1, `same placement as default row (orig=${originalIndex} n=${gBrowser.tabs.length} map=${map})`);
    is(gBrowser.selectedTab, resultTab, "…in the foreground, exactly like the default row");
    is(resultTab.linkedBrowser.currentURI.spec, "https://example.com/b?q=whimsy+search+with+test", "That engine's results, for the same selection");
  } finally {
    if (resultTab) {
      await BrowserTestUtils.removeTab(resultTab);
    }
    await BrowserTestUtils.removeTab(tab);
    restore();
  }
});

add_task(async function test_background_pref_matches_the_default_row() {
  const restore = await onlyTheseEngines([engineA, engineB, engineC]);
  await SpecialPowers.pushPrefEnv({ set: [["browser.search.context.loadInBackground", true]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  let resultTab;
  try {
    await select(tab.linkedBrowser, "event");
    const menu = await openMenu(tab.linkedBrowser);
    const searchWithRow = document.getElementById(ROW_ID);
    await openSubmenu(searchWithRow);
    const engineBRow = rowFor(searchWithRow.menupopup, engineB.name);
    const tabOpened = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabOpen");
    menu.activateItem(engineBRow);
    resultTab = (await tabOpened).target;
    is(gBrowser.selectedTab, tab, "Opens in the background, following browser.search.context.loadInBackground — same as the default row would");
  } finally {
    if (resultTab) {
      await BrowserTestUtils.removeTab(resultTab);
    }
    await BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
    restore();
  }
});

add_task(async function test_private_window_excludes_the_private_default() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.search.separatePrivateDefault.enabled", true],
      ["browser.search.separatePrivateDefault.featureGate", true],
    ],
  });
  const previousPrivate = SearchService.defaultPrivateEngine;
  await SearchService.setDefaultPrivate(engineB, SearchService.CHANGE_REASON.UNKNOWN);
  const privateWin = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  // Hide the rest only now: separatePrivateDefault + setDefaultPrivate can
  // asynchronously re-surface app-provided engines (e.g. "Google") as part
  // of reconfiguring the engine list, racing a hide done any earlier.
  let resultTab,
    restore = await onlyTheseEngines([engineA, engineB, engineC]);
  try {
    const tab = await BrowserTestUtils.openNewForegroundTab(privateWin.gBrowser, PAGE);
    const originalIndex = privateWin.gBrowser.tabs.indexOf(tab);
    await select(tab.linkedBrowser, "event");
    const menu = privateWin.document.getElementById("contentAreaContextMenu");
    const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
    await BrowserTestUtils.synthesizeMouseAtCenter("#event", { type: "contextmenu", button: 2 }, tab.linkedBrowser);
    await shown;

    const row = privateWin.document.getElementById(ROW_ID);
    ok(shows(row), "Search With still shows in a private window");
    const labels = [...row.menupopup.children].filter(n => !n.hidden).map(n => n.getAttribute("label"));
    Assert.deepEqual(labels, [engineA.name, engineC.name], "Excludes the private default (B), not the regular default (A)");

    const shownSub = BrowserTestUtils.waitForEvent(row.menupopup, "popupshown");
    row.openMenu(true);
    await shownSub;
    const engineARow = rowFor(row.menupopup, engineA.name);
    const tabOpened = BrowserTestUtils.waitForEvent(privateWin.gBrowser.tabContainer, "TabOpen");
    menu.activateItem(engineARow);
    resultTab = (await tabOpened).target;
    ok(PrivateBrowsingUtils.isBrowserPrivate(resultTab.linkedBrowser), "The result tab stays in the private window, as the row above does");
    is(privateWin.gBrowser.tabs.indexOf(resultTab), originalIndex + 1, "Right next to the tab that opened the menu, same as in a regular window");
  } finally {
    if (resultTab) {
      await BrowserTestUtils.removeTab(resultTab);
    }
    await BrowserTestUtils.closeWindow(privateWin);
    await SearchService.setDefaultPrivate(previousPrivate, SearchService.CHANGE_REASON.UNKNOWN);
    restore();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_one_visible_engine_hides_the_row() {
  const restore = await onlyTheseEngines([engineA]);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  try {
    await select(tab.linkedBrowser, "event");
    const menu = await openMenu(tab.linkedBrowser);
    ok(!shows(document.getElementById(ROW_ID)), "With only the default engine visible, the row is hidden");
    await closeMenu(menu);
  } finally {
    await BrowserTestUtils.removeTab(tab);
    restore();
  }
});

add_task(async function test_settings_menus_can_hide_it() {
  const restore = await onlyTheseEngines([engineA, engineB, engineC]);
  WhimsyMenuPrefs.setHidden("selection", "search-with", true);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  try {
    await select(tab.linkedBrowser, "event");
    const menu = await openMenu(tab.linkedBrowser);
    ok(!shows(document.getElementById(ROW_ID)), "Settings → Menus can turn the row off");
    await closeMenu(menu);
  } finally {
    await BrowserTestUtils.removeTab(tab);
    WhimsyMenuPrefs.restoreDefaults("selection");
    restore();
  }
});
