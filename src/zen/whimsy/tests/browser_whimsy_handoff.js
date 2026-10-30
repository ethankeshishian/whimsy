/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Handoff (whimsy.feature.handoff): Firefox's own Handoff, minus private tabs
// and Scratch, URL only, with a Settings switch. The native updater is
// swapped for a recorder (headless Gecko ignores the real one anyway).

const { WhimsyHandoff } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyHandoff.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_article.html";

const calls = [];
const realUpdater = WhimsyHandoff.updater;
WhimsyHandoff.updater = {
  updateLocation(url, title) {
    calls.push({ url, title });
  },
};

registerCleanupFunction(async () => {
  WhimsyHandoff.updater = realUpdater;
  if (WhimsyPrivate.getScratch(window)) {
    await WhimsyPrivate.closeScratch(window);
  }
});

function last() {
  return calls.at(-1);
}

async function openTab(url) {
  calls.length = 0;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  await TestUtils.waitForCondition(() => calls.length, "Handoff was updated");
  return tab;
}

add_task(async function test_wrapper_installed() {
  ok(window.XULBrowserWindow._whimsyHandoffOriginal, "Firefox's Handoff update is wrapped");
});

add_task(async function test_offers_url_only() {
  const url = PAGE + "?handoff=1";
  const tab = await openTab(url);
  is(last().url, url, "A normal page is offered");
  is(last().title, url, "Only the URL goes out (no page title)");

  calls.length = 0;
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, "about:robots");
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, "about:robots");
  is(last()?.url, "", "Internal pages aren't offered");

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_private_tab_not_offered() {
  const normal = await openTab(PAGE + "?handoff=normal");
  calls.length = 0;
  const url = PAGE + "?handoff=private";
  const tab = WhimsyPrivate.openPrivateTab(window, { url });
  ok(tab && WhimsyPrivate.isPrivateTab(tab), "A private tab opened");
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  await TestUtils.waitForCondition(() => calls.length, "Handoff was updated");
  ok(calls.every(c => c.url == "" && c.title == ""), "The private tab's URL never went out");

  calls.length = 0;
  gBrowser.selectedTab = normal;
  await TestUtils.waitForCondition(() => calls.length, "Handoff was updated");
  is(last().url, normal.linkedBrowser.currentURI.spec, "Switching back offers the normal page again");

  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(normal);
});

add_task(async function test_scratch_not_offered() {
  calls.length = 0;
  const scratch = await WhimsyPrivate.openScratch(window);
  ok(scratch, "Scratch opened");
  const url = PAGE + "?handoff=scratch";
  BrowserTestUtils.startLoadingURIString(gBrowser.selectedBrowser, url);
  await BrowserTestUtils.browserLoaded(gBrowser.selectedBrowser, false, url);
  ok(!calls.some(c => c.url.includes("handoff=scratch")), "Scratch pages never went out");
  is(WhimsyHandoff.payloadFor(window, gBrowser.currentURI), "", "Scratch is excluded");
  await WhimsyPrivate.closeScratch(window);
});

add_task(async function test_settings_switch() {
  const url = PAGE + "?handoff=switch";
  const tab = await openTab(url);
  calls.length = 0;
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.handoff.send", false]] });
  await TestUtils.waitForCondition(() => calls.length, "Handoff was updated");
  is(last().url, "", "Turning Handoff off withdraws the current page");

  calls.length = 0;
  await SpecialPowers.popPrefEnv();
  await TestUtils.waitForCondition(() => calls.length, "Handoff was updated");
  is(last().url, url, "Turning it back on offers the page again");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_feature_off_is_firefox() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.handoff", false]] });
  calls.length = 0;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE + "?handoff=off");
  is(calls.length, 0, "With the switch off, Firefox's own Handoff runs instead");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
