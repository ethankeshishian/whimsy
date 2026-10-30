/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Internet Archive for dead pages: a 404 shows a bar offering the
// Wayback Machine's copy (with its date) when one exists; the button opens
// it. No bar without a copy, for live pages, in private windows, or with
// the setting off. "Open in Wayback Machine" is in the command bar.

const BASE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_archive.sjs";
const { WhimsyPage } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPage.sys.mjs");

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.archive.api", BASE + "?api&url="]] });
});

const bar = browser => gBrowser.getNotificationBox(browser).getNotificationWithValue("whimsy-archive");

add_task(async function test_dead_page() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, BASE + "?gone");
  const browser = tab.linkedBrowser;
  const notification = await TestUtils.waitForCondition(() => bar(browser), "A gone page offers the archived copy");
  await TestUtils.waitForCondition(() => notification.messageText?.textContent.includes("2024"), "with its date");
  const button = notification.buttonContainer.querySelector("button");
  ok(button, "and a button");
  const loaded = BrowserTestUtils.browserLoaded(browser, false, "https://example.org/?archived");
  button.click();
  await loaded;
  ok(true, "The button opens the archived copy");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_no_bar() {
  const live = await BrowserTestUtils.openNewForegroundTab(gBrowser, BASE + "?live");
  const none = await BrowserTestUtils.openNewForegroundTab(gBrowser, BASE + "?nocopy");
  await new Promise(r => setTimeout(r, 800));
  ok(!bar(live.linkedBrowser), "A live page has no bar");
  ok(!bar(none.linkedBrowser), "A gone page with no archived copy has no bar");
  BrowserTestUtils.removeTab(live);
  BrowserTestUtils.removeTab(none);

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
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_settings() {
  await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
    const row = await TestUtils.waitForCondition(() => browser.contentDocument.getElementById("whimsyArchivePrompt"), "Settings row");
    await TestUtils.waitForCondition(() => row.checked, "on by default");
  });
});
