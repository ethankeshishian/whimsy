/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Private tabs, follow-ups: "switch to tab" never crosses between private
// and normal tabs, a private tab's downloads behave like a private
// window's, and Archive leaves private tabs out. Needs the engine patches
// (whimsy-Tabbrowser-sys-mjs, whimsy-UrlbarParentController-sys-mjs,
// whimsy-URILoadingHelper-sys-mjs, whimsy-DownloadsCommon-sys-mjs and the
// batch9p ones).

const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const { WhimsyArchive } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyArchive.sys.mjs");
const { UrlbarProviderOpenTabs } = ChromeUtils.importESModule(
  "moz-src:///browser/components/urlbar/UrlbarProviderOpenTabs.sys.mjs"
);
const { DownloadsCommon } = ChromeUtils.importESModule("resource:///modules/DownloadsCommon.sys.mjs");
const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");

function uniqueURL(tag) {
  return `https://example.com/?${tag}=${Date.now()}${Math.random().toString(36).slice(2)}`;
}

async function openPrivateTab(url) {
  const tab = WhimsyPrivate.openPrivateTab(window, { url });
  ok(tab, "A private tab opened");
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  ok(tab.linkedBrowser.browsingContext.usePrivateBrowsing, "It browses privately");
  return tab;
}

async function closeTab(tab) {
  BrowserTestUtils.removeTab(tab, { animate: false });
  await TestUtils.waitForCondition(() => !tab.isConnected, "The tab was removed");
}

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(async () => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    if (tab.isConnected && !tab.closing) {
      BrowserTestUtils.removeTab(tab, { animate: false });
    }
  }
  await WhimsyPrivate.closeScratch?.(window);
});

add_task(async function test_open_tab_registry_is_split() {
  const normalURL = uniqueURL("normal");
  const privateURL = uniqueURL("private");
  const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, normalURL);
  const priv = await openPrivateTab(privateURL);

  await TestUtils.waitForCondition(
    () => UrlbarProviderOpenTabs.getOpenTabUrls(true).has(privateURL),
    "The private tab registers as a private open page"
  );
  ok(!UrlbarProviderOpenTabs.getOpenTabUrls(false).has(privateURL), "... and not as a normal one");
  ok(UrlbarProviderOpenTabs.getOpenTabUrls(false).has(normalURL), "The normal tab registers as normal");
  ok(!UrlbarProviderOpenTabs.getOpenTabUrls(true).has(normalURL), "... and not as private");

  await closeTab(priv);
  await TestUtils.waitForCondition(
    () => !UrlbarProviderOpenTabs.getOpenTabUrls(true).has(privateURL),
    "Closing the private tab unregisters it"
  );
  await closeTab(normal);
});

add_task(async function test_switch_to_tab_stays_on_its_side() {
  const normalURL = uniqueURL("switch-normal");
  const privateURL = uniqueURL("switch-private");
  const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, normalURL);
  const priv = await openPrivateTab(privateURL);
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");

  // From a normal tab.
  ok(!window.switchToTabHavingURI(privateURL, false), "A normal tab can't switch to a private tab");
  is(gBrowser.selectedTab, other, "Selection didn't move");
  ok(window.switchToTabHavingURI(normalURL, false), "... but can to a normal one");
  is(gBrowser.selectedTab, normal, "Switched to the normal tab");

  // From a private tab.
  gBrowser.selectedTab = priv;
  const priv2 = await openPrivateTab(uniqueURL("switch-private-2"));
  is(gBrowser.selectedTab, priv2, "A second private tab is selected");
  ok(!window.switchToTabHavingURI(normalURL, false), "A private tab can't switch to a normal tab");
  is(gBrowser.selectedTab, priv2, "Selection didn't move");
  ok(window.switchToTabHavingURI(privateURL, false), "... but can to another private one");
  is(gBrowser.selectedTab, priv, "Switched to the private tab");

  await closeTab(priv2);
  await closeTab(priv);
  await closeTab(other);
  await closeTab(normal);
});

add_task(async function test_downloads_follow_the_selected_tab() {
  const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?dl-normal");
  const publicIndicator = DownloadsCommon.getIndicatorData(window);
  const publicData = DownloadsCommon.getData(window);
  ok(!window.whimsyDownloadsPrivate, "A normal tab shows normal downloads");

  const priv = await openPrivateTab("https://example.com/?dl-private");
  ok(window.whimsyDownloadsPrivate, "Selecting a private tab switches to private downloads");
  isnot(DownloadsCommon.getIndicatorData(window), publicIndicator, "The indicator reads the private list");
  isnot(DownloadsCommon.getData(window), publicData, "The panel reads the private list");

  // A download started in the private tab is a private download.
  const privateList = await Downloads.getList(Downloads.PRIVATE);
  const added = new Promise(resolve => {
    const view = {
      onDownloadAdded(download) {
        privateList.removeView(view);
        resolve(download);
      },
    };
    privateList.addView(view);
  });
  BrowserTestUtils.startLoadingURIString(priv.linkedBrowser, ROOT + "whimsy_slow_download.sjs");
  const download = await added;
  ok(download.source.isPrivate, "The download is private");
  const publicList = await Downloads.getList(Downloads.PUBLIC);
  ok(!(await publicList.getAll()).includes(download), "... and not in the normal list");
  await download.whenSucceeded().catch(() => {});

  gBrowser.selectedTab = normal;
  ok(!window.whimsyDownloadsPrivate, "Back on a normal tab: normal downloads");
  is(DownloadsCommon.getIndicatorData(window), publicIndicator, "The indicator reads the normal list again");

  // Closing the last private tab ends the private session, like closing the
  // last private window.
  await closeTab(priv);
  await TestUtils.waitForCondition(
    async () => !(await privateList.getAll()).length,
    "Private downloads are cleared when the last private tab closes"
  );
  await closeTab(normal);
});

add_task(async function test_archive_skips_private_tabs() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.tabs.archive.idle-after", "12h"]] });
  const old = Date.now() - 13 * 3600 * 1000;
  const priv = await openPrivateTab(uniqueURL("archive-private"));
  const fresh = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?archive-fresh");
  priv.updateLastAccessed(old);

  ok(WhimsyArchive.isSweepExempt(priv), "The idle sweep never takes a private tab");
  WhimsyArchive.sweepWindow(window);
  await TestUtils.waitForTick();
  ok(priv.isConnected, "The old private tab is still open");

  // An explicit archive (fire button, tree close) just closes it.
  const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, uniqueURL("archive-normal"));
  const normalURL = normal.linkedBrowser.currentURI.spec;
  const privateURL = priv.linkedBrowser.currentURI.spec;
  gBrowser.selectedTab = fresh;
  WhimsyArchive.archiveTabs(window, [priv, normal], { reason: "manual" });
  await TestUtils.waitForCondition(() => !priv.isConnected && !normal.isConnected, "Both tabs closed");
  await TestUtils.waitForCondition(
    () => WhimsyArchive.listEntries(window).some(e => e.url == normalURL),
    "The normal tab is in the archive"
  );
  ok(!WhimsyArchive.listEntries(window).some(e => e.url == privateURL), "The private tab isn't");

  await SpecialPowers.popPrefEnv();
  await closeTab(fresh);
});
