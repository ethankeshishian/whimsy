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

// "This Site" clears the whole site (base domain, subdomains included), so
// the row names the site and explains the scope; it's disabled off the web.
add_task(async function test_site_scope_names_the_site() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://www.example.com/?fire-label");
  const panel = WhimsyFireButton.panel(window);
  const button = panel.querySelector('.whimsy-fire-scope[data-scope="site"]');
  WhimsyFireButton.updateSiteScope(window, panel);
  let { id, args } = document.l10n.getAttributes(button);
  is(id, "whimsy-fire-site", "A website names its site");
  is(args.site, "example.com", "...by base domain, the scope that's cleared");
  ok(!button.disabled, "...and is enabled");
  const [message] = await document.l10n.formatMessages([{ id, args }]);
  ok(message.value.includes("example.com"), "The label names the site");
  ok(message.attributes.find(a => a.name == "tooltiptext")?.value.includes("subdomains"),
    "The tooltip says subdomains, history and tabs go too");

  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, "about:robots");
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, "about:robots");
  WhimsyFireButton.updateSiteScope(window, panel);
  ({ id } = document.l10n.getAttributes(button));
  is(id, "whimsy-fire-site-none", "Off the web the row is generic");
  ok(button.disabled, "...and disabled");
  BrowserTestUtils.removeTab(tab);
});
