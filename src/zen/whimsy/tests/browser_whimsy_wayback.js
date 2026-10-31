/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Internet Archive for dead pages: a 404 shows a bar asking whether to look
// for the Wayback Machine's copy; nothing goes to archive.org until "Look
// for a Copy", and then only the address without its query or fragment
// (wave9/secfix, security-full-2 M3). A copy opens; no copy says so. No
// bar for live pages, in private windows or private tabs, or with the
// setting off. "Open in Wayback Machine" is in the command bar.

const BASE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_archive.sjs";
const { WhimsyPage } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPage.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.archive.api", BASE + "?api&url="]] });
});

const bar = browser => gBrowser.getNotificationBox(browser).getNotificationWithValue("whimsy-archive");
const server = async query => (await fetch(BASE + "?" + query, { cache: "no-store" })).text();
const lookups = async () => (await server("lookups")).split("\n").filter(Boolean);

add_task(async function test_dead_page() {
  await server("reset");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, BASE + "?gone&token=s3cret#frag");
  const browser = tab.linkedBrowser;
  const notification = await TestUtils.waitForCondition(() => bar(browser), "A gone page offers to look");
  await new Promise(r => setTimeout(r, 300));
  Assert.deepEqual(await lookups(), [], "Nothing was sent to the archive before the click");
  const button = notification.buttonContainer.querySelector("button");
  ok(button, "The bar has a button");
  const loaded = BrowserTestUtils.browserLoaded(browser, false, "https://example.org/?archived");
  button.click();
  await loaded;
  ok(true, "The button finds and opens the archived copy");
  Assert.deepEqual(await lookups(), [BASE], "Only the address went, without its query or fragment");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_no_copy() {
  await server("reset");
  await server("nocopy");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, BASE + "?gone");
  const notification = await TestUtils.waitForCondition(() => bar(tab.linkedBrowser), "The bar asks");
  notification.buttonContainer.querySelector("button").click();
  await TestUtils.waitForCondition(() => !bar(tab.linkedBrowser), "With no copy, the bar goes");
  is(tab.linkedBrowser.currentURI.spec, BASE + "?gone", "…and the page stays");
  BrowserTestUtils.removeTab(tab);
  await server("reset");
});

add_task(async function test_no_bar() {
  await server("reset");
  const live = await BrowserTestUtils.openNewForegroundTab(gBrowser, BASE + "?live");
  await new Promise(r => setTimeout(r, 800));
  ok(!bar(live.linkedBrowser), "A live page has no bar");
  BrowserTestUtils.removeTab(live);

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.archive.prompt", false]] });
  const off = await BrowserTestUtils.openNewForegroundTab(gBrowser, BASE + "?gone");
  await new Promise(r => setTimeout(r, 800));
  ok(!bar(off.linkedBrowser), "With the setting off, no bar");
  BrowserTestUtils.removeTab(off);
  await SpecialPowers.popPrefEnv();

  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const priv = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, BASE + "?gone");
  await new Promise(r => setTimeout(r, 800));
  ok(!win.gBrowser.getNotificationBox(priv.linkedBrowser).getNotificationWithValue("whimsy-archive"), "Private windows never ask");
  await BrowserTestUtils.closeWindow(win);

  // A private tab (and Scratch) lives in a normal window.
  const privTab = WhimsyPrivate.openPrivateTab(window, { url: BASE + "?gone&private", force: true });
  await BrowserTestUtils.browserLoaded(privTab.linkedBrowser, false, BASE + "?gone&private");
  await new Promise(r => setTimeout(r, 800));
  ok(!bar(privTab.linkedBrowser), "Private tabs never ask");
  BrowserTestUtils.removeTab(privTab);
  Assert.deepEqual(await lookups(), [], "None of these reached the archive");
});

add_task(async function test_command_bar() {
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const action = globalActions.find(a => a.l10nId == "whimsy-action-open-archive");
  is(action?.label, "Open in Wayback Machine", "The command bar has Open in Wayback Machine");
  const blank = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  ok(!action.isAvailable(window), "not for about:blank");
  BrowserTestUtils.removeTab(blank);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?page");
  ok(action.isAvailable(window), "offered on a web page");
  is(WhimsyPage.archivableURL(Services.io.newURI("http://localhost:8080/")), null, "Local addresses are never sent");
  is(WhimsyPage.archivableURL(Services.io.newURI("https://192.168.1.2/")), null, "nor IP addresses");
  is(WhimsyPage.archivableURL(Services.io.newURI("http://intranet/wiki")), null, "nor one-label intranet names");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_settings() {
  await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
    const row = await TestUtils.waitForCondition(() => browser.contentDocument.getElementById("whimsyArchivePrompt"), "Settings row");
    await TestUtils.waitForCondition(() => row.checked, "on by default");
  });
});
