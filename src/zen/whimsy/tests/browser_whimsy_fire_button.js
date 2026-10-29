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
