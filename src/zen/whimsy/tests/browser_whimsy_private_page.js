/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// fixC: the private tab's page (about:privatebrowsing) is Whimsy's.
// fix7/private: it is calm: no search box (Firefox's stand-in that popped the
// command bar), and opening it doesn't open the command bar either, in a
// private tab or a private window. Cmd+L still opens the address bar.

const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");

async function waitForPrivatePage(browser) {
  await TestUtils.waitForCondition(
    () =>
      browser.browsingContext?.currentWindowGlobal?.documentURI.spec == "about:privatebrowsing" &&
      !browser.webProgress.isLoadingDocument,
    "The private page finished opening"
  );
}

async function openPrivatePage() {
  const tab = WhimsyPrivate.openPrivateTab(window);
  ok(tab, "A private tab opened");
  await waitForPrivatePage(tab.linkedBrowser);
  return tab;
}

// Whether the page's search box (or the private-engine banner) shows.
function searchShown(browser) {
  return SpecialPowers.spawn(browser, [], async () => {
    const doc = content.document;
    await ContentTaskUtils.waitForCondition(() => doc.readyState == "complete", "The page loaded");
    await new Promise(resolve => content.requestAnimationFrame(resolve));
    const visible = el => !!el && el.getBoxQuads().length > 0;
    return {
      box: visible(doc.querySelector("content-search-handoff-ui")),
      banner: visible(doc.getElementById("search-banner")),
      calm: doc.documentElement.getAttribute("whimsy-calm") == "true",
    };
  });
}

async function closeTab(tab) {
  BrowserTestUtils.removeTab(tab, { animate: false });
  await TestUtils.waitForCondition(() => !tab.isConnected, "The tab was removed");
  await TestUtils.waitForTick();
}

function resetUrlbar() {
  gURLBar.searchMode = null;
  gURLBar.removeHiddenFocus?.();
  gURLBar.handleRevert?.();
  gURLBar.blur();
}

add_task(async function test_branding() {
  const wordmark = await (await fetch("chrome://branding/content/firefox-wordmark.svg")).text();
  ok(wordmark.includes("Whimsy"), "The wordmark is Whimsy's");
  // The private page draws the PNG logo (about-logo-private.svg isn't
  // packaged); Firefox's own PNGs are 6,118 and 13,286 bytes.
  for (const [url, firefoxSize] of [
    ["chrome://branding/content/about-logo-private.png", 6118],
    ["chrome://branding/content/about-logo-private@2x.png", 13286],
  ]) {
    const bytes = (await (await fetch(url)).arrayBuffer()).byteLength;
    ok(bytes > 0 && bytes != firefoxSize, `${url} is Whimsy's (${bytes} bytes)`);
  }
  const tab = await openPrivatePage();
  const shown = await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const logo = content.document.querySelector(".logo-and-wordmark");
    return !!logo && content.getComputedStyle(logo).display != "none";
  });
  ok(shown, "The page shows the logo and wordmark");
  await closeTab(tab);
});

add_task(async function test_private_tab_page_is_calm() {
  resetUrlbar();
  const tab = await openPrivatePage();
  const shown = await searchShown(tab.linkedBrowser);
  ok(shown.calm, "Whimsy's private page actor ran");
  ok(!shown.box, "No search box on the private page");
  ok(!shown.banner, "No private search engine banner");
  ok(!gURLBar.focused, "Opening a private tab doesn't open the command bar");
  ok(!gURLBar.view.isOpen, "... nor its results");
  ok(gURLBar.isPrivate, "The address bar still searches privately");

  // Cmd+L still works normally.
  gBrowser.selectedBrowser.focus();
  EventUtils.synthesizeKey("l", { accelKey: true });
  await TestUtils.waitForCondition(() => gURLBar.focused, "Cmd+L focuses the address bar");
  resetUrlbar();
  await closeTab(tab);
});

add_task(async function test_scratch_page_is_calm() {
  resetUrlbar();
  const startSpace = gZenWorkspaces.activeWorkspace;
  const scratch = await WhimsyPrivate.openScratch(window);
  ok(scratch, "Scratch opened");
  await waitForPrivatePage(gBrowser.selectedBrowser);
  const shown = await searchShown(gBrowser.selectedBrowser);
  ok(!shown.box, "Scratch's page has no search box");
  ok(!gURLBar.focused, "Opening Scratch doesn't open the command bar");
  await WhimsyPrivate.closeScratch(window);
  if (gZenWorkspaces.activeWorkspace != startSpace) {
    await gZenWorkspaces.changeWorkspaceWithID(startSpace);
  }
});

add_task(async function test_private_window_page_is_calm() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    await win.delayedStartupPromise;
    await waitForPrivatePage(win.gBrowser.selectedBrowser);
    const shown = await searchShown(win.gBrowser.selectedBrowser);
    ok(!shown.box, "The private window's page has no search box");
    ok(!shown.banner, "... and no search banner");
    await TestUtils.waitForCondition(() => !win.gURLBar.focused, "The private window doesn't open on the command bar");
    await SimpleTest.promiseFocus(win);
    EventUtils.synthesizeKey("l", { accelKey: true }, win);
    await TestUtils.waitForCondition(() => win.gURLBar.focused, "Cmd+L opens the address bar there");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_switch_off_keeps_firefox_page() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.scratch", false]] });
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    await waitForPrivatePage(win.gBrowser.selectedBrowser);
    const shown = await searchShown(win.gBrowser.selectedBrowser);
    ok(!shown.calm, "With the switch off, Whimsy leaves the page alone");
    ok(shown.box, "... and Firefox's search box is back");
  } finally {
    await BrowserTestUtils.closeWindow(win);
    await SpecialPowers.popPrefEnv();
  }
});

// A private tab in a split: its segment of the split pill and its pane are
// marked, the normal tab next to it isn't.
add_task(async function test_private_tab_in_split() {
  const ACCENT = "rgb(152, 110, 255)";
  const normal = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?normal");
  const url = "https://example.com/?private-split";
  const priv = WhimsyPrivate.openPrivateTab(window, { url });
  ok(priv, "A private tab opened");
  await BrowserTestUtils.browserLoaded(priv.linkedBrowser, false, url);
  gZenViewSplitter.splitTabs([normal, priv], "vsep");
  await TestUtils.waitForCondition(
    () => gZenViewSplitter._data.find(group => group.tabs.includes(priv))?.tabs.length == 2,
    "The two tabs are split"
  );
  gBrowser.selectedTab = priv;
  const panel = tab => tab.linkedBrowser.closest(".browserSidebarContainer");
  await TestUtils.waitForCondition(
    () => panel(priv).classList.contains("deck-selected") && panel(priv).getAttribute("zen-split") == "true",
    "The private pane is the active pane"
  );
  ok(priv.closest("tab-group[split-view-group]"), "The private tab sits in the split pill");
  const ring = getComputedStyle(priv.querySelector(".tab-background")).boxShadow;
  ok(ring.includes(ACCENT), `The private tab's segment has the violet ring (${ring})`);
  ok(
    !getComputedStyle(normal.querySelector(".tab-background")).boxShadow.includes(ACCENT),
    "The normal tab's segment doesn't"
  );
  is(getComputedStyle(panel(priv)).outlineColor, ACCENT, "The active private pane's ring is violet");
  isnot(getComputedStyle(panel(priv), "::after").content, "none", "The private pane shows the private badge");
  is(getComputedStyle(panel(normal), "::after").content, "none", "The normal pane has no badge");

  gBrowser.selectedTab = normal;
  await TestUtils.waitForCondition(() => panel(normal).classList.contains("deck-selected"), "The normal pane is active");
  const inactive = getComputedStyle(panel(priv));
  is(inactive.outlineStyle, "solid", "An inactive private pane keeps its ring");
  isnot(inactive.outlineColor, ACCENT, "... fainter than the active one");

  gZenViewSplitter.unsplitCurrentView();
  await TestUtils.waitForCondition(() => !gZenViewSplitter._data.some(group => group.tabs.includes(priv)), "Unsplit");
  await closeTab(priv);
  await closeTab(normal);
});
