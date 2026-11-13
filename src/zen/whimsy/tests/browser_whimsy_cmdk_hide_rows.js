/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W26 actions audit 16 and 17 (intake-w26/audit-actions.md): the bar's
// action rows ("/" lists them all) hide the rows that can't do anything on
// the screen they're opened on.
// - No tabs: no row that needs a page or a tab (Copy Current URL, Reload,
//   Add to Essentials), and no Next Tab or Previous Tab without another
//   tab to move to.
// - Settings: the rows that work on a settings tab stay, and each is run
//   here to prove it (Capture Screenshot, Find in Page, Print, Copy URL).
// - A "Problem loading page": the page's content rows hide (Change This
//   Page…, Translate Page, Copy as Markdown, Add to Note, Email, the AI
//   rows); the address rows stay, and Copy Current URL copies the address.
// WHIMSY_SHOTS=<dir> writes w26-hide-<context>-<scheme>.png.

requestLongerTimeout(3);

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_cmdbar_ai.js", this);

const { WhimsyVerbs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVerbs.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
const { WhimsyCommandBarAgent } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommandBarAgent.sys.mjs");
const { UrlbarShared } = ChromeUtils.importESModule("chrome://browser/content/urlbar/UrlbarShared.mjs");
const { ScreenshotsUtils, UIPhases } = ChromeUtils.importESModule("moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs");

const ERROR_PAGE = "http://does-not-exist.invalid/";
// Rows that need a tab, or another tab: never with no tabs.
const NEED_A_TAB = ["Copy Current URL", "Reload Tab", "Reload Tab Without Cache", "Add to Essentials", "Pin Tab", "Close Tab", "Capture Screenshot", "Find in Page", "Print"];
const MOVE_TABS = ["Next Tab", "Previous Tab"];
// The page's content rows: never on an error page.
const CONTENT_ROWS = ["Change This Page…", "Translate Page", "Copy as Markdown", "Add to Note", "Email", "Summarize This Page", "Ask About This Page", "Copy Page as Markdown", "Capture Full Page", "Edit Text on Page"];
// Whimsy commands that act on a page or a tab: never with no tab (finding
// 13 and 14).
const PAGE_COMMANDS = ["Summarize This Page", "Summarize This Video", "Speed Up Video", "Slow Down Video", "Reset Video Speed", "Capture Full Page", "Capture in Portrait Mode", "Edit Text on Page", "Translate Selection", "Save Video to Playlist", "Paste Image to Upload", "Find Options", "Turn Developer Mode On for This Site"];
const TAB_COMMANDS = ["Mute Tab", "Rename Tab", "Reveal Tab in Sidebar", "Snooze Tab…", "Snooze Tab Until Tonight"];
// The address rows: kept on an error page.
const ADDRESS_ROWS = ["Copy Current URL", "Reload Tab", "Copy URL as Quote"];

add_setup(async function () {
  await setupAI();
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.ai-agent", true], ["whimsy.feature.ai-tab-requests", true]] });
  closeToasts();
  const outer = { width: window.outerWidth, height: window.outerHeight };
  window.resizeTo(1280, 800);
  await TestUtils.waitForCondition(() => window.outerWidth == 1280, "Resized");
  registerCleanupFunction(async () => {
    WhimsyCommandBarAgent._resetForTesting?.();
    await leaveBar();
    window.resizeTo(outer.width, outer.height);
    if (!gBrowser.tabs.some(t => !t.hasAttribute("zen-empty-tab") && !t.closing)) {
      await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
    }
  });
});

// ⌘K opens the bar in no mode (owner, W26); "/" then lists every action.
async function cmdK() {
  WhimsyVerbs.sessions.delete(window);
  gBrowser.selectedBrowser.focus();
  EventUtils.synthesizeKey("k", { accelKey: true });
  await TestUtils.waitForCondition(() => gURLBar.focused, "⌘K focused the bar");
  await gURLBar.lastQueryContextPromise;
  is(gURLBar.searchMode, null, "⌘K opened the bar in no mode");
}

// "/" in the bar lists every action. On a page ⌘K is the page's commands, so
// the list is opened from the bar itself, as clicking into it would.
async function actionsList() {
  WhimsyVerbs.sessions.delete(window);
  gURLBar.searchMode = null;
  gURLBar.focus();
  gURLBar.select();
  await TestUtils.waitForCondition(() => gURLBar.focused, "the bar is focused");
  const done = UrlbarTestUtils.promiseSearchComplete(window);
  EventUtils.sendString("/");
  await TestUtils.waitForCondition(() => gURLBar.searchMode?.source == UrlbarShared.RESULT_SOURCE.ZEN_ACTIONS, "\"/\" entered Actions");
  await done;
  await gURLBar.lastQueryContextPromise;
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
  WhimsyCommandBarAgent.leave?.(window);
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
    out.push({ result, element, title: result.payload.title, verb: result.payload.whimsyVerb ?? null });
  }
  return out;
}

async function labels(context) {
  is(gURLBar.searchMode?.source, UrlbarShared.RESULT_SOURCE.ZEN_ACTIONS, `${context}: "/" lists the actions`);
  const rows = await results();
  info(`AUDIT ${context}: ${JSON.stringify(rows.map(r => r.verb ?? r.title))}`);
  return rows.map(r => r.title);
}

function none(list, shown, context, why) {
  is(list.filter(l => shown.includes(l)).join(", "), "", `${context}: ${why}`);
}

function all(list, shown, context, why) {
  is(list.filter(l => !shown.includes(l)).join(", "), "", `${context}: ${why}`);
}

/** Types the row's label and clicks that row, as a person would. */
async function runRow(label) {
  await actionsList();
  await typeInActions(label);
  const row = (await results()).find(r => r.title == label);
  ok(row, `"${label}" is listed`);
  row.element.row.scrollIntoView({ block: "nearest" });
  EventUtils.synthesizeMouseAtCenter(row.element.row, {});
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

/** The only tab in the space (besides the empty one) is `url`. */
async function onlyTab(url) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  for (const t of [...gBrowser.tabs]) {
    if (t != tab && !t.hasAttribute("zen-empty-tab") && !t.hasAttribute("zen-essential")) {
      BrowserTestUtils.removeTab(t);
    }
  }
  return tab;
}

async function shoot(id) {
  await whimsyBothSchemes(`w26-hide-${id}-cmdk`, async () => {
    await cmdK();
    await whimsySettled();
    return () => leaveBar();
  });
  await whimsyBothSchemes(`w26-hide-${id}-actions`, async () => {
    await actionsList();
    await whimsySettled();
    return () => leaveBar();
  });
}

add_task(async function no_tabs_hides_what_needs_a_tab() {
  await noTabs();
  ok(!WhimsyCommands.hasTab(window) && !WhimsyCommands.hasOtherTab(window), "No tab, and none to move to");
  await actionsList();
  const shown = await labels("no tabs");
  none(NEED_A_TAB, shown, "no tabs", "no row that needs a tab");
  none(MOVE_TABS, shown, "no tabs", "no Next Tab or Previous Tab with no tab to move to");
  none(PAGE_COMMANDS, shown, "no tabs", "no command that needs a page");
  none(TAB_COMMANDS, shown, "no tabs", "no command that needs a tab");
  all(["Settings", "Open New Window", "New Space…"], shown, "no tabs", "the window's own rows stay");
  await leaveBar();
  await shoot("notabs");
  await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
});

add_task(async function one_tab_has_no_next_tab_two_do() {
  const first = await onlyTab("https://example.com/");
  await actionsList();
  let shown = await labels("one tab");
  none(MOVE_TABS, shown, "one tab", "no Next Tab or Previous Tab with nowhere to move");
  all(["Copy Current URL", "Reload Tab"], shown, "one tab", "the tab's own rows stay");
  await leaveBar();
  const second = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  await actionsList();
  shown = await labels("two tabs");
  all(MOVE_TABS, shown, "two tabs", "Next Tab and Previous Tab with another tab");
  is(shown.filter(l => l == "Next Tab").length, 1, "two tabs: Next Tab is listed once");
  await leaveBar();
  await runRow("Previous Tab");
  await TestUtils.waitForCondition(() => gBrowser.selectedTab == first, "Previous Tab moved to the other tab");
  BrowserTestUtils.removeTab(second);
});

add_task(async function settings_keeps_what_works_there() {
  const tab = await onlyTab("about:preferences");
  const browser = tab.linkedBrowser;
  await actionsList();
  const shown = await labels("settings");
  none(MOVE_TABS, shown, "settings", "no Next Tab or Previous Tab as the only tab");
  all(["Copy Current URL", "Reload Tab", "Pin Tab", "Capture Screenshot", "Find in Page", "Print"], shown, "settings", "the rows that work on a settings tab stay");
  none(CONTENT_ROWS, shown, "settings", "no page content rows");
  none(PAGE_COMMANDS, shown, "settings", "no command that needs a page");
  await leaveBar();
  await shoot("settings");

  // Each kept row really works here.
  await runRow("Capture Screenshot");
  await TestUtils.waitForCondition(() => ScreenshotsUtils.getUIPhase(browser) != UIPhases.CLOSED, "Capture Screenshot opened its overlay on Settings");
  ScreenshotsUtils.cancel(browser, "Escape");
  await TestUtils.waitForCondition(() => ScreenshotsUtils.getUIPhase(browser) == UIPhases.CLOSED, "and closed");

  await runRow("Find in Page");
  await TestUtils.waitForCondition(() => gBrowser.isFindBarInitialized(tab) && !gBrowser.getCachedFindBar(tab).hidden, "Find in Page opened the find bar on Settings");
  gBrowser.getCachedFindBar(tab).close(true);

  await runRow("Print");
  const sheets = await TestUtils.waitForCondition(() => {
    const frame = gBrowser.getTabDialogBox(browser).getTabDialogManager()._dialogs[0]?._frame;
    const count = frame?.contentDocument?.getElementById("sheet-count");
    return count && !count.hasAttribute("loading") && count;
  }, "Print previewed the settings page");
  ok(/"sheetCount":[1-9]/.test(sheets.getAttribute("data-l10n-args") ?? ""), "with at least one sheet");
  gBrowser.getTabDialogBox(browser).abortAllDialogs();
  await TestUtils.waitForCondition(() => !gBrowser.getTabDialogBox(browser).getTabDialogManager()._dialogs.length, "Print closed");

  await runRow("Copy Current URL");
  await TestUtils.waitForCondition(() => SpecialPowers.getClipboardData("text/plain") == "about:preferences", "Copy Current URL copied the settings address");
  closeToasts();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function error_page_hides_the_page_content_rows() {
  const tab = BrowserTestUtils.addTab(gBrowser, ERROR_PAGE);
  gBrowser.selectedTab = tab;
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, null, true);
  ok(tab.linkedBrowser.documentURI.spec.startsWith("about:neterror"), "The tab shows Problem loading page");
  ok(WhimsyCommands.isErrorPage(tab.linkedBrowser), "an error page");
  ok(WhimsyCommands.hasAddress(window) && !WhimsyCommands.hasPage(window), "with the address but no page content");
  await actionsList();
  const shown = await labels("error page");
  none(CONTENT_ROWS, shown, "error page", "no row that acts on the page's content");
  none(PAGE_COMMANDS.filter(l => !l.includes("Developer Mode")), shown, "error page", "no command that needs the page's content");
  all(ADDRESS_ROWS, shown, "error page", "the address rows stay");
  ok(!(await results()).some(r => r.verb && !r.verb.startsWith("typed:")), "error page: no page or AI rows");
  await leaveBar();
  await shoot("error");

  await runRow("Copy Current URL");
  await TestUtils.waitForCondition(() => SpecialPowers.getClipboardData("text/plain") == ERROR_PAGE, "Copy Current URL copied the address that failed");
  closeToasts();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function a_loaded_page_keeps_its_content_rows() {
  await BrowserTestUtils.withNewTab(ARTICLE, async browser => {
    ok(!WhimsyCommands.isErrorPage(browser) && WhimsyCommands.hasPage(window), "A loaded page is a page");
    // On a page, ⌘K is still its commands, in Actions.
    WhimsyVerbs.sessions.delete(window);
    browser.focus();
    EventUtils.synthesizeKey("k", { accelKey: true });
    await TestUtils.waitForCondition(() => gURLBar.focused, "⌘K focused the bar");
    await gURLBar.lastQueryContextPromise;
    await UrlbarTestUtils.promiseSearchComplete(window);
    const rows = await results();
    ok(rows.some(r => r.verb == "copy-markdown"), "with Copy as Markdown");
    ok(rows.some(r => r.verb == "email"), "and Email");
    await leaveBar();
  });
});
