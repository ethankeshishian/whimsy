/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave6: Trails. Going back and clicking somewhere new keeps the pages you
// left as branch rows, right below the page they branched from; picking one
// opens it again. The trail ends with where the tab came from. Switch off,
// Clear History, and non-web pages leave no rows.
// W10-54: the long-press / right-click on Back opens a drawn trail (a
// WhimsySurface, #whimsy-trail) instead of the native menu; with the
// feature off the native menu is back.

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

// Asks for the Back/Forward menu: with Trails on, the drawn trail opens
// instead (the native popup is cancelled); with it off, the native menu.
async function openHistoryMenu() {
  const popup = document.getElementById("backForwardMenu");
  if (Services.prefs.getBoolPref(FEATURE, true)) {
    const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsy-trail");
    popup.openPopup(document.getElementById("back-button"), "after_start");
    await shown;
    is(popup.state, "closed", "The native menu doesn't open");
    const panel = document.getElementById("whimsy-trail");
    await document.l10n.translateFragment(panel);
    return panel;
  }
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
  Assert.deepEqual(branches[0].entries.map(e => e.url), [B, C], "with the pages Forward lost, in order");
  is(branches[0].anchorUrl, A, "branching from A");

  const panel = await openHistoryMenu();
  ok(panel.classList.contains("whimsy-surface"), "A Whimsy surface");
  ok(!panel.querySelector("menuitem, menuseparator"), "not a native menu");
  const rows = [...panel.querySelectorAll(".whimsy-trail-list:not(.whimsy-trail-origin-list) [role=option]")];
  Assert.deepEqual(rows.map(r => [r.classList.contains("here") ? "here" : r.classList.contains("branch") ? "branch" : "trail", r.dataset.whimsyTrailUrl]),
    [["here", D], ["trail", A], ["branch", B], ["branch", C]],
    "D (here), A, then the branch that left A: B, C");
  const caption = panel.querySelector(".whimsy-trail-branch-caption");
  ok(caption, "A caption introduces the branch");
  is(caption.textContent, "You went back from", "You went back from");
  ok(rows[1].compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING, "right after A");
  is(rows[1].querySelector(".whimsy-trail-steps").textContent, "1 back", "A is 1 back");
  is(rows[0].querySelector(".whimsy-trail-title").textContent, "You’re here", "D says You're here");
  await TestUtils.waitForCondition(() => document.activeElement == rows[1], "Focus starts on the row below here");

  const loaded = BrowserTestUtils.browserLoaded(browser, false, C);
  rows[3].click();
  await loaded;
  is(browser.currentURI.spec, C, "Clicking a branch row opens it in the tab");
  ok(!panel.isConnected, "and closes the trail");
  Assert.deepEqual(
    WhimsyTrails.branchesFor(browser).flatMap(b => b.entries.map(e => e.url)),
    [B],
    "The reopened page is on the trail again, not a branch"
  );

  // Return on the focused row navigates: it's the row below "here".
  const again = await openHistoryMenu();
  await TestUtils.waitForCondition(() => again.contains(document.activeElement) &&
    document.activeElement.getAttribute("role") == "option", "A row has focus");
  const target = document.activeElement.dataset.whimsyTrailUrl;
  const changed = BrowserTestUtils.waitForLocationChange(gBrowser, target);
  EventUtils.synthesizeKey("KEY_Enter", {}, window);
  await changed;
  is(browser.currentURI.spec, target, "Return goes to the focused page");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_origin_row() {
  const opener = await BrowserTestUtils.openNewForegroundTab(gBrowser, A);
  const child = BrowserTestUtils.addTab(gBrowser, B, {
    openerBrowser: opener.linkedBrowser, // Gecko 159: addTab takes the opener browser
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(child.linkedBrowser, false, B);
  await BrowserTestUtils.switchTab(gBrowser, child);
  await load(child.linkedBrowser, C);

  const panel = await openHistoryMenu();
  const origin = panel.querySelector(".whimsy-trail-row.origin");
  ok(origin, "The trail ends with where the tab came from");
  is(origin.dataset.whimsyTrailUrl, A, "the opener's page");
  ok(panel.querySelector(".whimsy-surface-rule"), "after a hairline");
  ok(origin.querySelector(".whimsy-trail-title").textContent.startsWith("Opened from"), "Opened from …");
  origin.click();
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == opener, "Goes to the opener tab");
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
