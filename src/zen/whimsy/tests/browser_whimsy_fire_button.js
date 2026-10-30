/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Fire button: every scope clears real data and then closes the tabs it
// affected — except pinned tabs and Essentials, which keep their cookies
// burned but stay open (the build-plan answer: a pinned Gmail tab may lose
// its cookies without losing the tab). This only exercises the tab-closing
// half (closableTabs/burnTabs): the scopes themselves call the real,
// already-tested ForgetAboutSite/Services.clearData, which this test
// deliberately doesn't invoke so it isn't wiping the shared test profile's
// cookies and cache.

const { WhimsyFireButton } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFireButton.sys.mjs");

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    if (tab.isConnected && !tab.closing) {
      if (tab.pinned) {
        gBrowser.unpinTab(tab);
      }
      BrowserTestUtils.removeTab(tab);
    }
  }
});

add_task(function test_closable_tabs_excludes_pinned_and_essentials() {
  const fakeEssential = { pinned: false, closing: false, hasAttribute: name => name == "zen-essential" };
  const fakePinned = { pinned: true, closing: false, hasAttribute: () => false };
  const fakeNormal = { pinned: false, closing: false, hasAttribute: () => false };
  const result = WhimsyFireButton.closableTabs(window, [fakeEssential, fakePinned, fakeNormal]);
  is(result.length, 1, "Only the plain tab is closable");
  is(result[0], fakeNormal, "...and it's the right one");
});

add_task(async function test_burn_tabs_closes_only_closable_ones() {
  const pinned = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?pinned-survivor");
  gBrowser.pinTab(pinned);
  const plain = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?burn-me");
  const before = gBrowser.tabs.length;

  WhimsyFireButton.burnTabs(window, [pinned, plain], "test");

  await TestUtils.waitForCondition(() => gBrowser.tabs.length == before - 1, "Only the plain tab closed");
  ok(pinned.isConnected, "The pinned tab survived");
  ok(!plain.isConnected, "The plain tab didn't");
});

// fixB: the Fire sheet (WhimsyPanels): four scopes, each saying what it
// clears (the site row names the site), "Everything" marked destructive,
// and "This Site" disabled on a page that has no site. Closing it with
// the close button burns nothing.
add_task(async function test_fire_sheet() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?fire-sheet");
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsyFirePanel");
  WhimsyFireButton.openPanel(window);
  await shown;
  const panel = document.getElementById("whimsyFirePanel");
  ok(panel.classList.contains("whimsy-sheet"), "It is a Whimsy sheet");
  const scopes = [...panel.querySelectorAll(".whimsy-fire-scope")].map(i => i.getAttribute("whimsy-fire-scope"));
  Assert.deepEqual(scopes, ["site", "last-15-min", "space", "everything"], "Four scopes, narrowest first");
  const site = panel.querySelector('[whimsy-fire-scope="site"]');
  Assert.deepEqual(document.l10n.getAttributes(site.querySelector(".whimsy-sheet-item-subtitle")).args,
    { site: "example.com" }, "The site row names the site it clears");
  ok(panel.querySelector('[whimsy-fire-scope="everything"]').hasAttribute("destructive"), "Everything is marked destructive");

  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  panel.querySelector(".whimsy-sheet-close").doCommand();
  await hidden;
  ok(tab.isConnected, "Closing the sheet burns nothing");

  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, "about:blank");
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, "about:blank");
  const shownAgain = BrowserTestUtils.waitForEvent(document, "popupshown", true, e => e.target.id == "whimsyFirePanel");
  WhimsyFireButton.openPanel(window);
  await shownAgain;
  const again = document.getElementById("whimsyFirePanel");
  ok(again.querySelector('[whimsy-fire-scope="site"]').hasAttribute("disabled"), "No site, no This Site");
  const hiddenAgain = BrowserTestUtils.waitForEvent(again, "popuphidden");
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  await hiddenAgain;
  BrowserTestUtils.removeTab(tab);
});
