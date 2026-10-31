/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9/secfix (security-full-1 H1): Whimsy's private tabs and Scratch live
// in normal windows, so Firefox's window-level private check let an
// extension without private-browsing permission list, watch, screenshot and
// drive them. The tab APIs now check each tab; an extension that is allowed
// in private windows still sees them.

const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");

const PRIVATE_URL = "https://example.com/?whimsy-h1-private";
const PRIVATE_NEXT = "https://example.com/?whimsy-h1-private-next";
const NORMAL_URL = "https://example.org/?whimsy-h1-normal";

function background() {
  const updated = [];
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status == "complete") {
      updated.push(tab.url);
    }
  });
  browser.test.onMessage.addListener(async (msg, arg) => {
    try {
      if (msg == "query") {
        const tabs = await browser.tabs.query({});
        browser.test.sendMessage("query", tabs.map(t => t.url));
      } else if (msg == "updated") {
        browser.test.sendMessage("updated", updated.slice());
      } else if (msg == "capture") {
        await browser.tabs.captureVisibleTab();
        browser.test.sendMessage("capture", "captured");
      } else if (msg == "update") {
        await browser.tabs.update(arg, { url: "https://example.net/?moved" });
        browser.test.sendMessage("update", "updated");
      }
    } catch (e) {
      browser.test.sendMessage(msg, "error: " + e.message);
    }
  });
  browser.test.sendMessage("ready");
}

async function loadExtension(incognitoOverride) {
  const extension = ExtensionTestUtils.loadExtension({
    incognitoOverride,
    manifest: { permissions: ["tabs", "<all_urls>"] },
    background,
  });
  await extension.startup();
  await extension.awaitMessage("ready");
  return extension;
}

async function ask(extension, msg, arg) {
  extension.sendMessage(msg, arg);
  return extension.awaitMessage(msg);
}

async function openPrivate() {
  const tab = WhimsyPrivate.openPrivateTab(window, { url: PRIVATE_URL, force: true });
  ok(tab && WhimsyPrivate.isPrivateTab(tab), "A private tab in a normal window");
  ok(!PrivateBrowsingUtils.isWindowPrivate(window), "…whose window isn't private");
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PRIVATE_URL);
  return tab;
}

add_task(async function extension_without_private_permission_cant_see_private_tabs() {
  const extension = await loadExtension("not_allowed");
  const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, NORMAL_URL);
  const priv = await openPrivate();

  const urls = await ask(extension, "query");
  ok(urls.includes(NORMAL_URL), "tabs.query lists the normal tab");
  ok(!urls.includes(PRIVATE_URL), "tabs.query doesn't list the private tab");

  // A navigation in the private tab, then one in the normal tab, so the
  // listener has had every chance to hear about the private one.
  BrowserTestUtils.startLoadingURIString(priv.linkedBrowser, PRIVATE_NEXT);
  await BrowserTestUtils.browserLoaded(priv.linkedBrowser, false, PRIVATE_NEXT);
  BrowserTestUtils.startLoadingURIString(normal.linkedBrowser, NORMAL_URL + "&again");
  await BrowserTestUtils.browserLoaded(normal.linkedBrowser, false, NORMAL_URL + "&again");
  await TestUtils.waitForCondition(async () => {
    const seen = await ask(extension, "updated");
    return seen.includes(NORMAL_URL + "&again");
  }, "onUpdated reports the normal tab's navigation");
  const seen = await ask(extension, "updated");
  ok(!seen.some(u => u.startsWith(PRIVATE_URL)), "onUpdated never reports the private tab");

  gBrowser.selectedTab = priv;
  const capture = await ask(extension, "capture");
  ok(capture.startsWith("error"), `captureVisibleTab refuses a private tab (${capture})`);

  // Firefox's tab ids count up; whatever id the private tab has, an
  // extension that guesses it gets "Invalid tab ID".
  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
  const { tabTracker } = ExtensionParent.apiManager.global;
  const privateId = tabTracker.getId(priv);
  const update = await ask(extension, "update", privateId);
  ok(update.startsWith("error"), `tabs.update refuses the private tab (${update})`);
  is(priv.linkedBrowser.currentURI.spec, PRIVATE_NEXT, "…and the private tab stays where it was");

  await extension.unload();
  BrowserTestUtils.removeTab(priv);
  BrowserTestUtils.removeTab(normal);
});

add_task(async function extension_allowed_in_private_still_sees_private_tabs() {
  const extension = await loadExtension("spanning");
  const priv = await openPrivate();
  const urls = await ask(extension, "query");
  ok(urls.includes(PRIVATE_URL), "An extension allowed in private windows lists the private tab");
  gBrowser.selectedTab = priv;
  const capture = await ask(extension, "capture");
  is(capture, "captured", "…and can capture it");
  await extension.unload();
  BrowserTestUtils.removeTab(priv);
});
