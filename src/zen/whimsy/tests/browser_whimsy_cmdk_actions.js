/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W26 actions: ⌘K (the real key) with no tabs open and on settings pages
// opens the bar as it always is, in no mode (the owner: no automatic
// Actions), where a question gets Ask AI and a task the agent's Do this;
// "/" still enters Actions; a page's rows never show where there's no
// page; and reader view opens like any page (intake-w26/audit-actions.md).

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_cmdbar_ai.js", this);

const { WhimsyVerbs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVerbs.sys.mjs");
const { WhimsyCommandBarAgent } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommandBarAgent.sys.mjs");
const { UrlbarShared } = ChromeUtils.importESModule("chrome://browser/content/urlbar/UrlbarShared.mjs");

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

/**
 * The checks every no-page context shares (owner, W26): ⌘K opens the bar
 * as it always is, in no mode (no Actions pill, not Google's search mode),
 * with no ⌘K session and no page rows.
 */
async function expectBar(context) {
  is(gURLBar.searchMode, null, `${context}: ⌘K opened the bar in no mode`);
  ok(gURLBar.focused, `${context}: the bar has focus`);
  ok(!WhimsyVerbs.sessions.get(window), `${context}: no ⌘K session`);
  ok(!(await results()).some(r => r.verb && PAGE_ONLY.test(r.verb)), `${context}: no page or selection rows`);
}

/** Typed into the bar ⌘K opened: a question gets Ask, a task Do this. */
async function expectAskAndAgent(context) {
  await typeInActions("why is the sky blue?");
  await TestUtils.waitForCondition(() => askRow(), `${context}: a question gets the Ask AI row`);
  ok(!rowOf(WhimsyCommandBarAgent.ROW_TYPE), `${context}: and no Do this row`);
  is(gURLBar.searchMode, null, `${context}: still in no mode`);
  await typeInActions("book a table for 4 at the cafe on Friday");
  await TestUtils.waitForCondition(() => rowOf(WhimsyCommandBarAgent.ROW_TYPE), `${context}: a task gets the Do this row`);
  ok(!askRow(), `${context}: and no Ask AI row beside it`);
  is(gURLBar.searchMode, null, `${context}: still in no mode`);
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

add_task(async function no_tabs_opens_the_bar() {
  await noTabs();
  await cmdK();
  await expectBar("no tabs");
  await expectAskAndAgent("no tabs");
  await leaveBar();
  await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
});

add_task(async function settings_opens_the_bar() {
  await BrowserTestUtils.withNewTab("about:preferences", async () => {
    await cmdK();
    await expectBar("settings");
    await expectAskAndAgent("settings");
    await leaveBar();
  });
});

add_task(async function other_privileged_pages_open_the_bar() {
  for (const url of ["about:blank", "about:whimsy", "about:about"]) {
    await BrowserTestUtils.withNewTab(url, async () => {
      await cmdK();
      await expectBar(url);
      await leaveBar();
    });
  }
});

add_task(async function slash_still_enters_actions() {
  await BrowserTestUtils.withNewTab("about:preferences", async () => {
    await cmdK();
    EventUtils.sendString("/");
    await TestUtils.waitForCondition(() => gURLBar.searchMode?.source == UrlbarShared.RESULT_SOURCE.ZEN_ACTIONS, "\"/\" entered Actions");
    await leaveBar();
  });
});

add_task(async function reader_view_opens_like_a_page() {
  await BrowserTestUtils.withNewTab(`about:reader?url=${encodeURIComponent(ARTICLE)}`, async () => {
    await cmdK();
    is(gURLBar.searchMode?.source, UrlbarShared.RESULT_SOURCE.ZEN_ACTIONS, "Reader view: ⌘K opened Actions mode");
    const rows = await results();
    ok(rows.some(r => r.verb == "copy-markdown"), "with the page's rows");
    ok(!rows.some(r => r.verb == "translate"), "but no Translate Page: Firefox won't translate reader view");
    await leaveBar();
  });
});

add_task(async function pdf_hides_what_cannot_apply_to_a_document() {
  await BrowserTestUtils.withNewTab("https://example.com/browser/zen/whimsy/tests/whimsy_ai_lease.pdf", async browser => {
    await TestUtils.waitForCondition(() => browser.documentContentType == "application/pdf", "The PDF is open");
    await cmdK();
    is(gURLBar.searchMode?.source, UrlbarShared.RESULT_SOURCE.ZEN_ACTIONS, "PDF: ⌘K opened Actions mode");
    const rows = await results();
    ok(rows.some(r => r.verb == "copy-markdown"), "with the document's rows");
    ok(!rows.some(r => r.verb == "translate"), "no Translate Page: Firefox won't translate a PDF");
    ok(!rows.some(r => r.verb == "change-page"), "no Change This Page: a PDF is a document, not a site");
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
