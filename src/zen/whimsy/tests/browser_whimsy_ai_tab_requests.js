/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 page-act: tab requests (page-10.1–10.3, fu-page 10.4). Applied with
// no confirm and Undo in the toast; a loose match asks with choices while
// the composer stays live.

const { WhimsyAITabRequests } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAITabRequests.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyChat } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChat.sys.mjs");
const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyUndo } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyUndo.sys.mjs");

const DIR = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const STORE = DIR + "whimsy_ai_store.html";
const ARTICLE = DIR + "whimsy_ai_article_edit.html";

let answer = null;

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-hints", false], ["browser.tabs.warnOnCloseOtherTabs", false]] });
  WhimsyAIProviders.setTestProvider(async request => answer(request));
  registerCleanupFunction(async () => {
    WhimsyAIProviders.setTestProvider(null);
    if (WhimsyChat.isOpen(window)) {
      await WhimsyChat.close(window, { reason: "hide" });
    }
    closeToasts();
  });
});

// The ids of the tabs whose line in the request matches `re`.
const idsFor = (request, re) => request.prompt.split("\n").filter(line => re.test(line)).map(line => /^(t\d+):/.exec(line)?.[1]).filter(Boolean);
const storeTabs = () => gBrowser.tabs.filter(t => t.linkedBrowser.currentURI.spec == STORE);

async function openTabs() {
  const tabs = [];
  for (const url of [STORE, STORE, ARTICLE]) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, url));
  }
  return tabs;
}

async function card(kind) {
  return TestUtils.waitForCondition(() => [...document.querySelectorAll(`.whimsy-pa-card[data-kind=${kind}]`)].at(-1), `The ${kind} card shows`);
}

add_task(async function tab_request_applies_with_undo() {
  const [, , article] = await openTabs();
  const rows = WhimsyAITabRequests.typedRows(window, "close the other store tabs");
  is(rows.length, 1, "⌘K offers a row from the typed words");
  is(rows[0].label, "Close 2 “other store” tabs", "Naming the count");

  answer = request => JSON.stringify({ action: "close", tabs: idsFor(request, /Other store/) });
  await WhimsyChat.open(window, { prompt: "Close the other store tabs", send: true });
  await card("tabs-done");
  is(storeTabs().length, 0, "Applied at once, with no confirm");
  const toast = await TestUtils.waitForCondition(() => document.querySelector("[data-l10n-id=whimsy-tabs-closed-toast]"), "The toast says what closed");
  ok(toast, "With Undo");
  WhimsyUndo.undo(window);
  await TestUtils.waitForCondition(() => storeTabs().length == 2, "Undo reopens them");
  await WhimsyChat.close(window, { reason: "hide" });
  closeToasts();
  for (const tab of [...storeTabs(), article]) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function loose_match_asks_typing_works() {
  const [, , article] = await openTabs();
  answer = request => JSON.stringify({
    action: "close",
    ask: [
      { label: "Store", tabs: idsFor(request, /Other store/) },
      { label: "Article", tabs: idsFor(request, /night train/i) },
    ],
  });
  await WhimsyChat.open(window, { prompt: "Close my shopping tabs", send: true });
  const ask = await card("tabs-ask");
  Assert.deepEqual([...ask.querySelectorAll(".whimsy-pa-btn")].map(b => b.dataset.button), ["option:0", "option:1", "both"], "Choices, plus Both");
  is(storeTabs().length, 2, "Nothing applied while it asks");
  const panel = WhimsyChatPanel.forWindow(window);
  ok(!panel.composer.disabled, "The composer stays live");
  panel.composer.focus();
  EventUtils.sendString("the store ones", window);
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(() => storeTabs().length == 0, "Typing an answer picks the store tabs");
  ok(article.isConnected, "The article stays");
  await card("tabs-done");
  await WhimsyChat.close(window, { reason: "hide" });
  closeToasts();
  BrowserTestUtils.removeTab(article);
});
