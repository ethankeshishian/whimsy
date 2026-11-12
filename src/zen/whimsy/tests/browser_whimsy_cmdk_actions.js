/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W26 actions: ⌘K (the real key) with no tabs open and on settings pages is
// Actions, with the commands that apply there, never the web search; a tab
// request typed there is still the top row with Undo; a page's rows never
// show where there's no page; and reader view opens like any page
// (intake-w26/audit-actions.md).

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_cmdbar_ai.js", this);

const { WhimsyVerbs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVerbs.sys.mjs");
const { WhimsyCommandBarAgent } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommandBarAgent.sys.mjs");
const { UrlbarShared } = ChromeUtils.importESModule("chrome://browser/content/urlbar/UrlbarShared.mjs");

const YOUTUBE = n => `data:text/html,<title>YouTube - video ${n}</title><p>video ${n}`;
// Rows that act on a page or a selection: never with no page.
const PAGE_ONLY = /^(ai:|translate$|copy-markdown$|note$|email$|zap$|pip$|change-page$|ask$|web-search$|cmd:|edit-commands$)/;

add_setup(async function () {
  await setupAI();
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-agent", true], ["whimsy.feature.ai-tab-requests", true]] });
  registerCleanupFunction(async () => {
    WhimsyCommandBarAgent._resetForTesting();
    await leaveBar();
    if (!gBrowser.tabs.some(t => !t.hasAttribute("zen-empty-tab") && !t.closing)) {
      await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
    }
  });
});

async function cmdK() {
  WhimsyVerbs.sessions.delete(window);
  gBrowser.selectedBrowser.focus();
  EventUtils.synthesizeKey("k", { accelKey: true });
  await TestUtils.waitForCondition(() => gURLBar.focused, "⌘K focused the bar");
  await gURLBar.lastQueryContextPromise;
  await UrlbarTestUtils.promiseSearchComplete(window);
}

async function typeInActions(text) {
  for (let i = 0; i < 3 && gURLBar.value != text; i++) {
    gURLBar.select();
    const done = UrlbarTestUtils.promiseSearchComplete(window);
    EventUtils.sendString(text);
    await done;
  }
  await TestUtils.waitForCondition(() => gURLBar.value == text, `typed "${text}"`);
  await gURLBar.lastQueryContextPromise;
}

async function leaveBar() {
  WhimsyCommandBarAgent.leave(window);
  if (gURLBar.view.isOpen) {
    gURLBar.view.close();
  }
  gURLBar.searchMode = null;
  gURLBar.value = "";
  WhimsyVerbs.sessions.delete(window);
  gBrowser.selectedBrowser.focus();
}

async function results() {
  const out = [];
  for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
    const { result, element } = await UrlbarTestUtils.getDetailsOfResultAt(window, i);
    out.push({ result, element, verb: result.payload.whimsyVerb ?? null, zen: !!result.payload.zenCommand, type: result.type });
  }
  return out;
}

/** The checks every no-page context shares (Fix 1 and 2 of the brief). */
async function expectActions(context) {
  is(gURLBar.searchMode?.source, UrlbarShared.RESULT_SOURCE.ZEN_ACTIONS, `${context}: ⌘K opened Actions mode`);
  is(WhimsyVerbs.sessions.get(window)?.web, false, `${context}: a session with no page`);
  const rows = await results();
  ok(rows.some(r => r.zen), `${context}: at least one action is listed (${rows.length} rows)`);
  ok(rows.every(r => r.result.source == UrlbarShared.RESULT_SOURCE.ZEN_ACTIONS), `${context}: every row is an action`);
  ok(!rows.some(r => r.type == UrlbarShared.RESULT_TYPE.SEARCH || r.verb == "web-search"), `${context}: no search or Google rows`);
  ok(!rows.some(r => r.verb && PAGE_ONLY.test(r.verb)), `${context}: no page or selection rows`);
  return rows;
}

async function noTabs() {
  const keep = t => t.hasAttribute("zen-empty-tab") || t.hasAttribute("zen-essential");
  for (const t of [...gBrowser.tabs]) {
    if (!keep(t)) {
      BrowserTestUtils.removeTab(t);
    }
  }
  await TestUtils.waitForCondition(() => gBrowser.selectedTab.hasAttribute("zen-empty-tab"), "Only the space's empty tab is left");
}

add_task(async function no_tabs_opens_actions_not_google() {
  await noTabs();
  await cmdK();
  await expectActions("no tabs");
  // Nothing matches: still no search row, no Ask row.
  await typeInActions("zzqx");
  const rows = await results();
  ok(!rows.some(r => r.verb || r.type == UrlbarShared.RESULT_TYPE.SEARCH), "no tabs, no match: no Ask or search rows");
  await leaveBar();
  await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
});

add_task(async function settings_opens_actions_not_google() {
  await BrowserTestUtils.withNewTab("about:preferences", async () => {
    await cmdK();
    await expectActions("settings");
    await typeInActions("zzqx");
    const rows = await results();
    ok(!rows.some(r => r.verb || r.type == UrlbarShared.RESULT_TYPE.SEARCH), "settings, no match: no Ask or search rows");
    await leaveBar();
  });
});

add_task(async function other_privileged_pages_open_actions() {
  for (const url of ["about:blank", "about:whimsy", "about:about"]) {
    await BrowserTestUtils.withNewTab(url, async () => {
      await cmdK();
      await expectActions(url);
      await leaveBar();
    });
  }
});

add_task(async function tab_request_on_settings_is_the_top_row_with_undo() {
  const tabs = [await BrowserTestUtils.openNewForegroundTab(gBrowser, YOUTUBE(1)), await BrowserTestUtils.openNewForegroundTab(gBrowser, YOUTUBE(2))];
  await BrowserTestUtils.withNewTab("about:preferences", async () => {
    const before = gBrowser.tabs.length;
    await cmdK();
    await typeInActions("close all my youtube tabs");
    const rows = await results();
    is(rows[0]?.verb, "typed:tabs-close", "The tab request is the top row on a settings page");
    is(rows[0].result.payload.title, "Close 2 “youtube” tabs", "and says what will happen");
    ok(rows[0].element.hasAttribute("selected"), "selected, so Enter does it");
    ok(!rows.some(r => r.verb == "ask" || r.verb == "web-search"), "No Ask or Search with Google rows");
    EventUtils.synthesizeKey("KEY_Enter");
    await TestUtils.waitForCondition(() => tabs.every(t => !t.isConnected), "Enter closed them");
    ok(!gURLBar.searchMode, "and left Actions mode");
    const undo = await TestUtils.waitForCondition(() => document.getElementById("whimsy-undo-toast-button"), "The toast offers Undo");
    undo.click();
    await TestUtils.waitForCondition(() => gBrowser.tabs.length == before, "Undo restored them");
    closeToasts();
  });
  for (const t of [...gBrowser.tabs].filter(t => /YouTube/.test(t.label))) {
    BrowserTestUtils.removeTab(t);
  }
});

add_task(async function request_on_settings_gets_do_this() {
  await BrowserTestUtils.withNewTab("about:preferences", async () => {
    await cmdK();
    await typeInActions("book a table for 4 at the cafe on Friday");
    const row = await TestUtils.waitForCondition(() => rowOf(WhimsyCommandBarAgent.ROW_TYPE), "Do this is up with no page");
    is(rows()[0], row, "as the top row");
    ok(row.hasAttribute("selected"), "selected, so Enter does it");
    const all = await results();
    ok(!all.some(r => r.verb == "ask" || r.verb == "web-search"), "No Ask or Search with Google rows beside it");
    await leaveBar();
  });
});

add_task(async function reader_view_opens_like_a_page() {
  await BrowserTestUtils.withNewTab(`about:reader?url=${encodeURIComponent(ARTICLE)}`, async () => {
    await cmdK();
    is(gURLBar.searchMode?.source, UrlbarShared.RESULT_SOURCE.ZEN_ACTIONS, "Reader view: ⌘K opened Actions mode");
    const rows = await results();
    ok(rows.some(r => r.verb == "copy-markdown"), "with the page's rows");
    await leaveBar();
  });
});

add_task(async function switch_off_keeps_firefox_cmd_k() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.selection-verbs", false]] });
  await BrowserTestUtils.withNewTab("about:preferences", async () => {
    const command = document.getElementById("Tools:Search");
    const searched = BrowserTestUtils.waitForEvent(command, "command");
    gBrowser.selectedBrowser.focus();
    EventUtils.synthesizeKey("k", { accelKey: true });
    await searched;
    ok(!WhimsyVerbs.sessions.get(window), "With the switch off, ⌘K is Firefox's web search");
    await leaveBar();
  });
  await SpecialPowers.popPrefEnv();
});
