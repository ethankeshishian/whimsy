/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Internet Archive for dead pages: a 404 shows a Whimsy toast (W10-15:
// "Page didn't load" · "Try a saved copy from the Wayback Machine" · Find
// Copy) owned by the tab; nothing goes to archive.org until Find Copy, and
// then only the address without its query or fragment (wave9/secfix,
// security-full-2 M3). Looking shows a busy action; a copy opens with a
// "Showing a saved copy" toast; no copy says so; a failed request offers
// Try Again. No offer for live pages, in private windows or private tabs,
// or with the setting off. "Open in Wayback Machine" is in the command bar.

const BASE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_archive.sjs";
const { WhimsyPage } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPage.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.archive.api", BASE + "?api&url="]] });
});

const { WhimsyToast } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyToast.sys.mjs");
const bar = browser => gBrowser.getNotificationBox(browser).getNotificationWithValue("whimsy-archive");
const server = async query => (await fetch(BASE + "?" + query, { cache: "no-store" })).text();
const lookups = async () => (await server("lookups")).split("\n").filter(Boolean);
const toastWith = (win, id) => {
  const toast = WhimsyToast.current(win);
  return toast?._messageId == id ? toast : null;
};
const offer = (win = window) => toastWith(win, "whimsy-archive-toast");

add_task(async function test_dead_page() {
  await server("reset");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, BASE + "?gone&token=s3cret#frag");
  const browser = tab.linkedBrowser;
  const toast = await TestUtils.waitForCondition(() => offer(), "A gone page offers a saved copy");
  ok(!bar(browser), "No notification bar");
  await document.l10n.translateFragment(toast);
  is(toast.querySelector(".whimsy-toast-message").textContent, "Page didn’t load", "The title");
  is(toast.querySelector(".whimsy-toast-detail").textContent, "Try a saved copy from the Wayback Machine",
    "The second line names the Wayback Machine");
  ok(toast.querySelector("img.whimsy-toast-icon"), "With its icon");
  await new Promise(r => setTimeout(r, 300));
  Assert.deepEqual(await lookups(), [], "Nothing was sent to the archive before the click");
  const button = toast.querySelector(".whimsy-toast-action");
  is(button.textContent, "Find Copy", "The action is Find Copy");
  const loaded = BrowserTestUtils.browserLoaded(browser, false, "https://example.org/?archived");
  button.click();
  ok(toast.hasAttribute("busy") || !toast.isConnected, "Looking: the action is busy");
  await loaded;
  ok(true, "Find Copy finds and opens the archived copy");
  const found = await TestUtils.waitForCondition(() => toastWith(window, "whimsy-archive-found"), "Showing a saved copy");
  await document.l10n.translateFragment(found);
  ok(found.querySelector(".whimsy-toast-detail").textContent.includes("2024"), "With the copy's date");
  Assert.deepEqual(await lookups(), [BASE], "Only the address went, without its query or fragment");
  WhimsyToast._dismissNow(found);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_no_copy() {
  await server("reset");
  await server("nocopy");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, BASE + "?gone");
  const toast = await TestUtils.waitForCondition(() => offer(), "The toast offers");
  toast.querySelector(".whimsy-toast-action").click();
  const none = await TestUtils.waitForCondition(() => toastWith(window, "whimsy-archive-none-toast"), "No copy says so");
  is(tab.linkedBrowser.currentURI.spec, BASE + "?gone", "…and the page stays");
  WhimsyToast._dismissNow(none);
  BrowserTestUtils.removeTab(tab);
  await server("reset");
});

add_task(async function test_lookup_fails() {
  await server("reset");
  await server("fail");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, BASE + "?gone&fail");
  const toast = await TestUtils.waitForCondition(() => offer(), "The toast offers");
  toast.querySelector(".whimsy-toast-action").click();
  const error = await TestUtils.waitForCondition(() => toastWith(window, "whimsy-archive-error"), "A failed request says so");
  await document.l10n.translateFragment(error);
  is(error.querySelector(".whimsy-toast-action").textContent, "Try Again", "and offers Try Again");
  await server("reset");
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, "https://example.org/?archived");
  error.querySelector(".whimsy-toast-action").click();
  await loaded;
  ok(true, "Try Again looks again and opens the copy");
  Assert.equal((await lookups()).length, 1, "One lookup after the reset");
  const found = toastWith(window, "whimsy-archive-found");
  if (found) {
    WhimsyToast._dismissNow(found);
  }
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_switching_tabs_dismisses() {
  await server("reset");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, BASE + "?gone&switch");
  const toast = await TestUtils.waitForCondition(() => offer(), "The toast offers");
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  ok(!toast.isConnected, "Switching tabs dismisses the offer");
  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(tab);
  Assert.deepEqual(await lookups(), [], "Nothing was asked");
});

add_task(async function test_no_bar() {
  await server("reset");
  const live = await BrowserTestUtils.openNewForegroundTab(gBrowser, BASE + "?live");
  await new Promise(r => setTimeout(r, 800));
  ok(!offer() && !bar(live.linkedBrowser), "A live page offers nothing");
  BrowserTestUtils.removeTab(live);

  await SpecialPowers.pushPrefEnv({ set: [["whimsy.archive.prompt", false]] });
  const off = await BrowserTestUtils.openNewForegroundTab(gBrowser, BASE + "?gone");
  await new Promise(r => setTimeout(r, 800));
  ok(!offer(), "With the setting off, no offer");
  BrowserTestUtils.removeTab(off);
  await SpecialPowers.popPrefEnv();

  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const priv = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, BASE + "?gone");
  await new Promise(r => setTimeout(r, 800));
  ok(!offer(win), "Private windows never ask");
  await BrowserTestUtils.closeWindow(win);

  // A private tab (and Scratch) lives in a normal window.
  const privTab = WhimsyPrivate.openPrivateTab(window, { url: BASE + "?gone&private", force: true });
  await BrowserTestUtils.browserLoaded(privTab.linkedBrowser, false, BASE + "?gone&private");
  await new Promise(r => setTimeout(r, 800));
  ok(!offer(), "Private tabs never ask");
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
