/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Follower tabs (Vivaldi 7.9): in a 2-pane split, a link clicked in the
// source pane loads in the follower pane instead, leaving the source's own
// page untouched. Covers the main flow, a click inside the follower pane
// itself, direct navigation in the source, the tab-menu item's
// availability, and the switch off.

const { WhimsyFollowerTabs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyFollowerTabs.sys.mjs");

const SOURCE_PAGE = "data:text/html,<a id=link href='https://example.org/followed'>next</a>";

function addTab(url) {
  return BrowserTestUtils.openNewForegroundTab(gBrowser, url);
}

function splitOf(tab) {
  return gZenViewSplitter._data.find(g => g.tabs.includes(tab));
}

async function split(tabA, tabB) {
  gBrowser.selectedTab = tabA;
  gZenViewSplitter.splitTabs([tabA, tabB], "vsep");
  await TestUtils.waitForCondition(() => splitOf(tabA)?.tabs.length == 2, "Starts as a 2-pane split");
}

function clickLink(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    content.document.getElementById("link").click();
  });
}

registerCleanupFunction(() => Services.prefs.clearUserPref("whimsy.feature.follower-tabs"));

add_task(async function test_follow_redirects_clicks_to_the_partner_pane() {
  const source = await addTab(SOURCE_PAGE);
  const follower = await addTab("about:blank");
  await split(source, follower);

  WhimsyFollowerTabs.toggle(window, source);
  ok(WhimsyFollowerTabs.isSource(source), "Marked as the split's source");

  await clickLink(source.linkedBrowser);
  await TestUtils.waitForCondition(
    () => follower.linkedBrowser.currentURI.spec == "https://example.org/followed",
    "The link opened in the follower pane"
  );
  is(source.linkedBrowser.currentURI.spec, SOURCE_PAGE, "The source pane's own page never changed");

  BrowserTestUtils.removeTab(source);
  BrowserTestUtils.removeTab(follower);
});

add_task(async function test_a_link_clicked_inside_the_follower_pane_navigates_it_normally() {
  const source = await addTab(SOURCE_PAGE);
  const follower = await addTab(SOURCE_PAGE);
  await split(source, follower);
  WhimsyFollowerTabs.toggle(window, source);

  await clickLink(follower.linkedBrowser);
  await TestUtils.waitForCondition(
    () => follower.linkedBrowser.currentURI.spec == "https://example.org/followed",
    "The follower pane navigates on a link clicked inside it"
  );
  is(source.linkedBrowser.currentURI.spec, SOURCE_PAGE, "The source, not a target of this click, stayed put");

  BrowserTestUtils.removeTab(source);
  BrowserTestUtils.removeTab(follower);
});

add_task(async function test_direct_navigation_in_the_source_is_not_redirected() {
  const source = await addTab(SOURCE_PAGE);
  const follower = await addTab("about:blank");
  await split(source, follower);
  WhimsyFollowerTabs.toggle(window, source);

  BrowserTestUtils.startLoadingURIString(source.linkedBrowser, "https://example.com/");
  await BrowserTestUtils.browserLoaded(source.linkedBrowser, false, "https://example.com/");
  is(source.linkedBrowser.currentURI.spec, "https://example.com/", "Typing/loading a URL navigates the source itself");
  is(follower.linkedBrowser.currentURI.spec, "about:blank", "The follower pane is untouched");

  BrowserTestUtils.removeTab(source);
  BrowserTestUtils.removeTab(follower);
});

add_task(async function test_menu_item_only_offered_on_a_2_pane_split() {
  const lone = await addTab("about:blank");
  gBrowser.selectedTab = lone;
  window.TabContextMenu.contextTab = lone;
  document.getElementById("tabContextMenu").dispatchEvent(new Event("popupshowing", { bubbles: false }));
  const item = document.getElementById("context_whimsyFollowerSplit");
  ok(!item || item.hidden, "Not offered on a tab with no split partner");
  BrowserTestUtils.removeTab(lone);
});

add_task(async function test_feature_off_ignores_toggle() {
  const source = await addTab(SOURCE_PAGE);
  const follower = await addTab("about:blank");
  await split(source, follower);

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.follower-tabs", false]] });
  WhimsyFollowerTabs.toggle(window, source);
  ok(!WhimsyFollowerTabs.isSource(source), "The switch off: toggle does nothing");

  await clickLink(source.linkedBrowser);
  await TestUtils.waitForCondition(
    () => source.linkedBrowser.currentURI.spec == "https://example.org/followed",
    "With no source marked, the click just navigates the source normally"
  );
  is(follower.linkedBrowser.currentURI.spec, "about:blank", "The follower pane is untouched");
  await SpecialPowers.popPrefEnv();

  BrowserTestUtils.removeTab(source);
  BrowserTestUtils.removeTab(follower);
});
