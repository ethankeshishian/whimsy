/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave6: Trails. Going back and clicking somewhere new keeps the pages you
// left as branch rows in the Back/Forward menu, right above the page they
// branched from; picking one opens it again. The menu ends with where the tab
// came from. Switch off, Clear History, and non-web pages leave no rows.

ChromeUtils.defineESModuleGetters(this, {
  WhimsyTrails: "resource:///modules/whimsy/WhimsyTrails.sys.mjs",
});

const FEATURE = "whimsy.feature.trails";
const BASE = "https://example.com/browser/whimsy-trails";
const A = `${BASE}?a`;
const B = `${BASE}?b`;
const C = `${BASE}?c`;
const D = `${BASE}?d`;

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      [FEATURE, true],
      // Every entry counts for Back and the menu, user interaction or not.
      ["browser.navigation.requireUserInteraction", false],
    ],
  });
});

async function load(browser, url) {
  const loaded = BrowserTestUtils.browserLoaded(browser, false, url);
  BrowserTestUtils.startLoadingURIString(browser, url);
  await loaded;
}

async function back(browser, url) {
  const changed = BrowserTestUtils.waitForLocationChange(gBrowser, url);
  browser.goBack();
  await changed;
}

async function openHistoryMenu() {
  const popup = document.getElementById("backForwardMenu");
  const shown = BrowserTestUtils.waitForEvent(popup, "popupshown");
  popup.openPopup(gURLBar, "after_start");
  await shown;
  return popup;
}

async function closeMenu(popup) {
  if (popup.state == "closed") {
    return;
  }
  const hidden = BrowserTestUtils.waitForEvent(popup, "popuphidden");
  popup.hidePopup();
  await hidden;
}

// A, B, C, back to A, then D: B and C would be gone from Forward.
async function branchyTab() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, A);
  const browser = tab.linkedBrowser;
  await load(browser, B);
  await load(browser, C);
  await back(browser, B);
  await back(browser, A);
  await load(browser, D);
  return tab;
}

add_task(async function test_branch_recorded_and_shown() {
  const tab = await branchyTab();
  const browser = tab.linkedBrowser;
  is(browser.browsingContext.sessionHistory.count, 2, "Gecko kept A and D only");
  const branches = WhimsyTrails.branchesFor(browser);
  is(branches.length, 1, "One branch recorded");
  Assert.deepEqual(
    branches[0].entries.map(e => e.url),
    [B, C],
    "with the pages Forward lost, in order"
  );
  is(branches[0].anchorUrl, A, "branching from A");

  const popup = await openHistoryMenu();
  const rows = [...popup.querySelectorAll(".whimsy-trail-branch")];
  Assert.deepEqual(
    rows.map(r => r.dataset.whimsyTrailUrl),
    [C, B],
    "Branch rows newest first, like Firefox's own rows"
  );
  const anchorRow = rows.at(-1).nextElementSibling;
  is(anchorRow?.getAttribute("index"), "0", "They sit right above A, where they left the trail");
  is(rows[0].previousElementSibling?.getAttribute("index"), "1", "and below the current page");
  ok(rows.every(r => r.getAttribute("label")), "Each row is labeled");

  const loaded = BrowserTestUtils.browserLoaded(browser, false, C);
  popup.activateItem(rows[0]);
  await loaded;
  is(browser.currentURI.spec, C, "Picking a branch row opens it in the tab");
  Assert.deepEqual(
    WhimsyTrails.branchesFor(browser).flatMap(b => b.entries.map(e => e.url)),
    [B],
    "The reopened page is on the trail again, not a branch"
  );
  await closeMenu(popup);

  const again = await openHistoryMenu();
  ok(!again.querySelector(`.whimsy-trail-branch[data-whimsy-trail-url="${C}"]`), "Old rows were cleared");
  is(again.querySelectorAll(".whimsy-trail-branch").length, 1, "No duplicates across openings");
  await closeMenu(again);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_origin_row() {
  const opener = await BrowserTestUtils.openNewForegroundTab(gBrowser, A);
  const child = BrowserTestUtils.addTab(gBrowser, B, {
    openerTab: opener,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(child.linkedBrowser, false, B);
  await BrowserTestUtils.switchTab(gBrowser, child);
  await load(child.linkedBrowser, C);

  const popup = await openHistoryMenu();
  const origin = popup.querySelector(".whimsy-trail-origin");
  ok(origin, "The menu ends with where the tab came from");
  is(origin.dataset.whimsyTrailUrl, A, "the opener's page");
  is(origin.getAttribute("data-l10n-id"), "whimsy-trail-origin", "labeled Opened from …");
  await TestUtils.waitForCondition(() => origin.getAttribute("label"), "Label filled");
  popup.activateItem(origin);
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == opener, "Goes to the opener tab");
  await closeMenu(popup);
  BrowserTestUtils.removeTab(child);
  BrowserTestUtils.removeTab(opener);
});

add_task(async function test_switch_off_and_clear_history() {
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
  const off = await branchyTab();
  is(WhimsyTrails.branchesFor(off.linkedBrowser).length, 0, "Switch off: nothing recorded");
  const popup = await openHistoryMenu();
  ok(!popup.querySelector(".whimsy-trail-item"), "Switch off: Firefox's menu only");
  await closeMenu(popup);
  BrowserTestUtils.removeTab(off);
  await SpecialPowers.popPrefEnv();

  const tab = await branchyTab();
  is(WhimsyTrails.branchesFor(tab.linkedBrowser).length, 1, "Recorded");
  Services.obs.notifyObservers(null, "browser:purge-session-history");
  is(WhimsyTrails.branchesFor(tab.linkedBrowser).length, 0, "Clear History empties trails");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_only_web_pages() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, A);
  const browser = tab.linkedBrowser;
  await load(browser, "about:robots");
  await back(browser, A);
  await load(browser, D);
  is(WhimsyTrails.branchesFor(browser).length, 0, "about: pages are never kept");
  BrowserTestUtils.removeTab(tab);
});
