/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave10/mini W10-13: Mini Whimsy's model (the user's picks, 2026-10-31).
// - One page looks exactly like Little Arc: no tab row at all.
// - A second page (target=_blank, a Cmd-click, a sign-in popup, Cmd+Opt+T)
//   brings in a row of pill tabs under the bar; it leaves at one page.
// - Sign-in popups (window.open with features) open as Mini tabs that keep
//   window.opener and postMessage; when one closes itself, its opener's
//   tab is selected again. (Needs whimsy-nsWindowWatcher-cpp.patch.)
// - Links from other apps join the open Mini as its front tab.
// - Cmd+O moves every page into the space; its label counts them.
// - Cmd+W closes the current page; the last one closes Mini.
// - The new actions are commands with assignable shortcuts.
// - The switch (whimsy.feature.mini-tabs) off restores the one-page Mini.

const { WhimsyQuickWindow } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs");
const { WhimsyCommands } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs");
ChromeUtils.defineESModuleGetters(this, {
  UrlbarTestUtils: "resource://testing-common/UrlbarTestUtils.sys.mjs",
});

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const LINKS = ROOT + "whimsy_mini_links.html";
const OPENER = ROOT + "whimsy_oauth_opener.html";
const POPUP = ROOT + "whimsy_oauth_popup.html";
const SYSTEM_PRINCIPAL = Services.scriptSecurityManager.getSystemPrincipal();

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.quick-window.size", ""],
      ["whimsy.feature.mini-tabs", true],
      // Firefox's defaults, pinned: popups with features open windows, and
      // a diverted page opens in front.
      ["browser.link.open_newwindow.restriction", 2],
      ["browser.tabs.loadDivertedInBackground", false],
    ],
  });
});

registerCleanupFunction(async () => {
  for (const win of WhimsyQuickWindow.windows()) {
    await WhimsyQuickWindow.whenReady(win);
    await BrowserTestUtils.closeWindow(win);
  }
});

async function openMini(url) {
  const win = WhimsyQuickWindow.open(url, { opener: window });
  await WhimsyQuickWindow.whenReady(win);
  await TestUtils.waitForCondition(() => win.gBrowser.selectedBrowser.currentURI.spec == url, "Mini loaded its page");
  await SpecialPowers.spawn(win.gBrowser.selectedBrowser, [], () =>
    ContentTaskUtils.waitForCondition(() => content.document.readyState == "complete", "Page complete"));
  await SimpleTest.promiseFocus(win);
  return win;
}

const pages = win => WhimsyQuickWindow.pages(win);
const row = win => win.document.getElementById("whimsy-quick-window-tabs");
const rowShown = win =>
  win.document.documentElement.hasAttribute("whimsy-mini-tabs") && row(win).checkVisibility();
const cardTop = win =>
  win.gBrowser.selectedBrowser.closest(".browserSidebarContainer").getBoundingClientRect().top;
const moveButton = win => win.document.getElementById("whimsy-quick-window-move-to-space");

// Counts browser windows opened while `fn` runs (a popup must not make one).
async function countNewWindows(fn) {
  let opened = 0;
  const observer = (subject, topic) => {
    if (topic == "domwindowopened") {
      opened++;
    }
  };
  Services.ww.registerNotification(observer);
  try {
    await fn();
  } finally {
    Services.ww.unregisterNotification(observer);
  }
  return opened;
}

add_task(async function test_one_page_is_little_arc() {
  const win = await openMini("https://example.com/");
  try {
    const root = win.document.documentElement;
    ok(row(win), "Mini has a tab row ready");
    ok(!root.hasAttribute("whimsy-mini-tabs"), "...not shown with one page");
    ok(!row(win).checkVisibility(), "...and taking no space");
    is(row(win).children.length, 0, "No pills for a single page");
    ok(root.hasAttribute("whimsy-popups-as-tabs"), "Mini keeps its pages' popups as its own tabs");
    const bar = win.document.getElementById("whimsy-quick-window-bar");
    Assert.greaterOrEqual(cardTop(win), bar.getBoundingClientRect().bottom, "The page sits right under the bar");
    is(moveButton(win).getAttribute("label"), `Open in ${gZenWorkspaces.getActiveWorkspace().name}`,
      "Arc's own label for one page");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_target_blank_opens_a_mini_tab_and_cmd_w_closes_it() {
  const win = await openMini(LINKS);
  const first = win.gBrowser.selectedTab;
  const top = cardTop(win);
  const mainTabs = gBrowser.tabs.length;
  const added = BrowserTestUtils.waitForNewTab(win.gBrowser, "https://example.org/", true);
  await BrowserTestUtils.synthesizeMouseAtCenter("#blank", {}, win.gBrowser.selectedBrowser);
  const tab = await added;
  is(gBrowser.tabs.length, mainTabs, "Nothing opened in the main window behind Mini");
  is(win.gBrowser.selectedTab, tab, "The new page is in front");
  is(pages(win).length, 2, "Mini holds two pages");
  await TestUtils.waitForCondition(() => rowShown(win), "The pill row appears");
  const pills = [...row(win).children];
  is(pills.length, 2, "One pill per page");
  ok(pills[1].hasAttribute("selected") && pills[1].getAttribute("aria-selected") == "true",
    "The front page's pill is lit");
  ok(!pills[0].hasAttribute("selected"), "...the other isn't");
  await TestUtils.waitForCondition(() => pills[1].querySelector(".whimsy-mini-tab-label").textContent,
    "Pills show the page title");
  Assert.greater(cardTop(win), top, "The page makes room for the row");

  // Cmd+W closes the current page and returns to the one that opened it.
  EventUtils.synthesizeKey("w", { accelKey: true }, win);
  await TestUtils.waitForCondition(() => pages(win).length == 1, "Cmd+W closes the current page");
  ok(!win.closed, "...not Mini");
  is(win.gBrowser.selectedTab, first, "Back on the page that opened it");
  await TestUtils.waitForCondition(() => !rowShown(win), "The row leaves at one page");
  await TestUtils.waitForCondition(() => Math.abs(cardTop(win) - top) < 1, "Little Arc's layout again");

  // The last page closes Mini.
  const closed = BrowserTestUtils.domWindowClosed(win);
  EventUtils.synthesizeKey("w", { accelKey: true }, win);
  await closed;
  ok(win.closed, "Cmd+W on the last page closes Mini");
});

add_task(async function test_cmd_click_opens_a_background_mini_tab() {
  await SpecialPowers.pushPrefEnv({ set: [["browser.tabs.loadInBackground", true]] });
  const win = await openMini(LINKS);
  try {
    const first = win.gBrowser.selectedTab;
    const mainTabs = gBrowser.tabs.length;
    const added = BrowserTestUtils.waitForNewTab(win.gBrowser, "https://example.org/?plain", true);
    await BrowserTestUtils.synthesizeMouseAtCenter("#plain", { accelKey: true }, win.gBrowser.selectedBrowser);
    const tab = await added;
    is(gBrowser.tabs.length, mainTabs, "A Cmd-click in Mini stays in Mini");
    is(win.gBrowser.selectedTab, first, "...as a background page");
    ok(pages(win).includes(tab), "...listed as a Mini page");
    await TestUtils.waitForCondition(() => rowShown(win), "The pill row appears");
  } finally {
    await BrowserTestUtils.closeWindow(win);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_sign_in_popup_is_a_mini_tab_that_keeps_its_opener() {
  const win = await openMini(OPENER);
  const openerTab = win.gBrowser.selectedTab;
  const openerBrowser = openerTab.linkedBrowser;
  let tab;
  const windows = await countNewWindows(async () => {
    const added = BrowserTestUtils.waitForNewTab(win.gBrowser, POPUP, true);
    await BrowserTestUtils.synthesizeMouseAtCenter("#continue", {}, openerBrowser);
    tab = await added;
  });
  try {
    is(windows, 0, "No popup window opened");
    is(win.gBrowser.selectedTab, tab, "The sign-in page is Mini's front page");
    is(tab.linkedBrowser.browsingContext.opener, openerBrowser.browsingContext, "It keeps its opener");
    is(await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.body.dataset.hasOpener), "true",
      "window.opener is there for the page");
    await TestUtils.waitForCondition(() => rowShown(win), "Two pages: the pill row shows");

    // The provider posts the result to its opener, which tells it to close.
    const closing = BrowserTestUtils.waitForTabClosing(tab);
    await BrowserTestUtils.synthesizeMouseAtCenter("#account", {}, tab.linkedBrowser);
    await SpecialPowers.spawn(openerBrowser, [], () =>
      ContentTaskUtils.waitForCondition(() => content.document.body.dataset.token == "signed-in",
        "The opener got the result through postMessage"));
    await closing;
    ok(!win.closed, "Mini stays");
    is(win.gBrowser.selectedTab, openerTab, "Back on the page that asked to sign in");
    await TestUtils.waitForCondition(() => !rowShown(win), "One page again: no row");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_cmd_opt_t_adds_a_page_through_the_command_bar() {
  const win = await openMini("https://example.com/");
  try {
    const key = win.document.getElementById("key_whimsyMiniNewTab");
    is(key?.getAttribute("modifiers"), "accel,alt", "Cmd+Opt+T is Mini's new-page key");
    is(key?.getAttribute("key")?.toUpperCase(), "T", "...on T");

    // Dismissed without a pick: the empty page goes away again.
    EventUtils.synthesizeKey("t", { accelKey: true, altKey: true }, win);
    await TestUtils.waitForCondition(() => pages(win).length == 2 && win.gURLBar.focused,
      "A new page, with the command bar open on it");
    ok(rowShown(win), "The row shows the new page");
    for (let i = 0; i < 3 && win.gURLBar.focused; i++) {
      EventUtils.synthesizeKey("KEY_Escape", {}, win);
      await new Promise(resolve => win.requestAnimationFrame(resolve));
    }
    if (win.gURLBar.focused) {
      info("Esc left the bar focused; dismiss it by focusing the page");
      win.gBrowser.selectedBrowser.focus();
    }
    await TestUtils.waitForCondition(() => pages(win).length == 1, "Dismissing the bar takes the empty page away");
    is(win.gBrowser.selectedBrowser.currentURI.spec, "https://example.com/", "Back on the page");

    // With a pick: it loads in the new page; the first one is untouched.
    EventUtils.synthesizeKey("t", { accelKey: true, altKey: true }, win);
    await TestUtils.waitForCondition(() => pages(win).length == 2 && win.gURLBar.focused, "Another new page");
    await UrlbarTestUtils.promiseAutocompleteResultPopup({
      window: win, waitForFocus: SimpleTest.waitForFocus, value: "https://example.org/",
    });
    const loaded = BrowserTestUtils.browserLoaded(win.gBrowser.selectedBrowser, false, "https://example.org/");
    EventUtils.synthesizeKey("KEY_Enter", {}, win);
    await loaded;
    await new Promise(resolve => win.setTimeout(resolve, 50));
    is(pages(win).length, 2, "The picked page stays");
    is(pages(win)[0].linkedBrowser.currentURI.spec, "https://example.com/", "The first page is untouched");
    is(win.gBrowser.selectedBrowser.currentURI.spec, "https://example.org/", "The pick is in the new page");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_links_from_other_apps_join_the_open_mini() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.external-links.target", "quick-window"]] });
  const win = await openMini("https://example.com/");
  try {
    let tab;
    const windows = await countNewWindows(async () => {
      const added = BrowserTestUtils.waitForNewTab(win.gBrowser, "https://example.org/", true);
      const context = window.browserDOMWindow.openURI(Services.io.newURI("https://example.org/"), null,
        Ci.nsIBrowserDOMWindow.OPEN_NEWTAB, Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL, SYSTEM_PRINCIPAL);
      is(context, null, "Handled by Mini");
      tab = await added;
    });
    is(windows, 0, "No second Mini");
    is(WhimsyQuickWindow.windows().length, 1, "Still one Mini");
    is(win.gBrowser.selectedTab, tab, "The link is Mini's front page");
    await TestUtils.waitForCondition(() => rowShown(win), "...with the pill row");
  } finally {
    await BrowserTestUtils.closeWindow(win);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_cmd_o_moves_every_page_and_counts_them() {
  const win = await openMini("https://example.com/");
  const space = gZenWorkspaces.getActiveWorkspace();
  const added = BrowserTestUtils.waitForNewTab(win.gBrowser, "https://example.org/", true);
  WhimsyQuickWindow.openLinkTab(win, "https://example.org/");
  await added;
  // Look at the first page; it's the one that stays selected.
  win.gBrowser.selectedTab = pages(win)[0];
  await TestUtils.waitForCondition(() => moveButton(win).getAttribute("label") == `Open 2 Tabs in ${space.name}`,
    "The button says how many pages move");
  const before = new Set(gBrowser.tabs);
  EventUtils.synthesizeKey("o", { accelKey: true }, win);
  await TestUtils.waitForCondition(() => win.closed, "Cmd+O moves the pages and closes Mini");
  const landed = [...gBrowser.tabs].filter(tab => !before.has(tab));
  is(landed.length, 2, "Both pages landed in the space");
  const urls = landed.map(tab => tab.linkedBrowser.currentURI.spec).sort();
  Assert.deepEqual(urls, ["https://example.com/", "https://example.org/"], "...as they were");
  ok(landed.every(tab => tab.getAttribute("zen-workspace-id") == space.uuid), "...in the current space");
  is(gBrowser.selectedTab.linkedBrowser.currentURI.spec, "https://example.com/", "The page you were on stays in front");
  for (const tab of landed) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_pills_select_close_and_follow_the_keyboard() {
  const win = await openMini("https://example.com/");
  try {
    for (const url of ["https://example.org/", "https://example.net/"]) {
      const added = BrowserTestUtils.waitForNewTab(win.gBrowser, url, true);
      WhimsyQuickWindow.openLinkTab(win, url);
      await added;
    }
    await TestUtils.waitForCondition(() => row(win).children.length == 3, "Three pills");
    const pill = i => row(win).children[i];

    EventUtils.synthesizeMouseAtCenter(pill(0), {}, win);
    await TestUtils.waitForCondition(() => win.gBrowser.selectedTab == pages(win)[0], "Clicking a pill selects it");
    ok(pill(0).hasAttribute("selected"), "...and lights it");

    pill(0).focus();
    EventUtils.synthesizeKey("KEY_ArrowRight", {}, win);
    await TestUtils.waitForCondition(() => win.gBrowser.selectedTab == pages(win)[1], "Arrow keys move along the pills");
    is(win.document.activeElement, pill(1), "...with focus");

    const third = pages(win)[2];
    EventUtils.synthesizeMouseAtCenter(pill(2), { button: 1 }, win);
    await TestUtils.waitForCondition(() => !pages(win).includes(third), "Middle-click closes a pill's page");

    const second = pages(win)[1];
    EventUtils.synthesizeMouseAtCenter(pill(1).querySelector(".whimsy-mini-tab-close"), {}, win);
    await TestUtils.waitForCondition(() => !pages(win).includes(second), "The close button closes its page");
    await TestUtils.waitForCondition(() => !rowShown(win), "One page left: the row goes");
    ok(!win.closed, "Mini stays open");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_new_actions_are_commands_with_shortcuts() {
  const win = await openMini("https://example.com/");
  try {
    ok(win.document.getElementById("cmd_whimsyMiniNewTab"), "New Tab in Mini Whimsy is a command in Mini");
    ok(win.document.getElementById("key_whimsyMiniNewTab"), "...with a key that can be rebound");
    ok(WhimsyCommands.forKey("key_whimsyMiniNewTab")?.l10nId, "...listed by name");
    is(WhimsyCommands.forKey("key_whimsyMiniNewTab").defaultKey?.modifiers, "accel,alt", "Cmd+Opt+T by default");
    ok(!document.getElementById("cmd_whimsyMiniNewTab"), "Main windows don't get Mini's commands");
    // Cmd+Opt+T stays New Private Tab in main windows.
    const privateKey = document.getElementById("key_whimsyNewPrivateTab");
    if (privateKey?.getAttribute("key")) {
      is(privateKey.getAttribute("modifiers"), "accel,alt", "Main windows keep Cmd+Opt+T for a private tab");
    }
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_switch_off_restores_the_one_page_mini() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.mini-tabs", false]] });
  const win = await openMini(LINKS);
  try {
    ok(!win.document.documentElement.hasAttribute("whimsy-popups-as-tabs"), "Popups aren't kept as tabs");
    const added = BrowserTestUtils.waitForNewTab(gBrowser, "https://example.org/", true);
    await BrowserTestUtils.synthesizeMouseAtCenter("#blank", {}, win.gBrowser.selectedBrowser);
    const tab = await added;
    ok(tab, "target=_blank goes to the main window, as before");
    is(pages(win).length, 1, "Mini keeps one page");
    ok(!rowShown(win), "No tab row");
    BrowserTestUtils.removeTab(tab);
  } finally {
    await BrowserTestUtils.closeWindow(win);
    await SpecialPowers.popPrefEnv();
  }
});
