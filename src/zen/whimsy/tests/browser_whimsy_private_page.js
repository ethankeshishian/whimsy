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
  for (const url of [
    "chrome://branding/content/firefox-wordmark.svg",
    "chrome://branding/content/about-logo-private.svg",
  ]) {
    const text = await (await fetch(url)).text();
    ok(text.includes("Whimsy"), `${url} is Whimsy's`);
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
