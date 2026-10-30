/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// fixC: the private tab's page (about:privatebrowsing) is Whimsy's, and its
// search box opens the address bar like a new tab does, instead of Firefox's
// hidden focus and private-engine search mode.

const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");

async function openPrivatePage() {
  const tab = WhimsyPrivate.openPrivateTab(window);
  ok(tab, "A private tab opened");
  await TestUtils.waitForCondition(
    () =>
      tab.linkedBrowser.browsingContext?.currentWindowGlobal?.documentURI.spec == "about:privatebrowsing" &&
      !tab.linkedBrowser.webProgress.isLoadingDocument,
    "The private page finished opening"
  );
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () => content.document.querySelector("content-search-handoff-ui")?.shadowRoot?.querySelector(".search-handoff-button"),
      "The search box rendered"
    );
  });
  return tab;
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

add_task(async function test_search_box_opens_address_bar() {
  const tab = await openPrivatePage();
  resetUrlbar();
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.querySelector("content-search-handoff-ui").shadowRoot.querySelector(".search-handoff-button").click();
  });
  await TestUtils.waitForCondition(() => gURLBar.focused, "Clicking the box focuses the address bar");
  ok(!gURLBar._hideFocus, "The focus is visible, not Firefox's hidden focus");
  ok(!gURLBar.searchMode, "No search mode chip");
  const fakeFocus = await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const ui = content.document.querySelector("content-search-handoff-ui");
    await ContentTaskUtils.waitForCondition(() => !ui.fakeFocus, "The page drops its fake caret");
    return ui.fakeFocus;
  });
  ok(!fakeFocus, "The page's box doesn't pretend to be focused");

  // Pasting into the box hands the text over, typed in.
  resetUrlbar();
  const actor = tab.linkedBrowser.browsingContext.currentWindowGlobal.getActor("AboutPrivateBrowsing");
  actor.receiveMessage({ name: "SearchHandoff", data: { text: "whimsy private search" } });
  await TestUtils.waitForCondition(() => gURLBar.focused, "The address bar is focused");
  await TestUtils.waitForCondition(() => gURLBar.value == "whimsy private search", "The bar finished opening");
  is(gURLBar.value, "whimsy private search", "The pasted text is in the address bar");
  ok(!gURLBar.searchMode, "Still no search mode chip");
  ok(gURLBar.isPrivate, "The address bar searches privately");
  resetUrlbar();
  await closeTab(tab);
});

add_task(async function test_switch_off_keeps_firefox_handoff() {
  const tab = await openPrivatePage();
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.scratch", false]] });
  try {
    resetUrlbar();
    const actor = tab.linkedBrowser.browsingContext.currentWindowGlobal.getActor("AboutPrivateBrowsing");
    actor.receiveMessage({ name: "SearchHandoff", data: { text: "" } });
    await TestUtils.waitForCondition(() => gURLBar.focused, "The address bar is focused");
    ok(gURLBar._hideFocus, "With the switch off, Firefox's hidden focus is back");
  } finally {
    resetUrlbar();
    await SpecialPowers.popPrefEnv();
  }
  await closeTab(tab);
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
