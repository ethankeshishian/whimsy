/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/security M1: what verbs and page actions open from a private tab
// opens private too (search, maps, Linear, skills, Track, Maps fallback),
// so a private selection never reaches normal history and cookies.

const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const { WhimsyVerbs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyVerbs.sys.mjs");
const { WhimsyPageActions } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPageActions.sys.mjs");

const SOURCE = "https://example.com/?private-source";

async function withPrivateTab(fn) {
  const source = WhimsyPrivate.openPrivateTab(window, { url: SOURCE, force: true });
  ok(source && WhimsyPrivate.isPrivateTab(source), "A private source tab");
  await BrowserTestUtils.browserLoaded(source.linkedBrowser, false, SOURCE);
  gBrowser.selectedTab = source;
  try {
    await fn(source);
  } finally {
    BrowserTestUtils.removeTab(source);
  }
}

async function expectPrivate(url, open) {
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, url);
  open();
  const tab = await opened;
  ok(WhimsyPrivate.isPrivateTab(tab), `${url} opened as a private tab`);
  ok(tab.linkedBrowser.browsingContext.usePrivateBrowsing, "…browsing privately");
  BrowserTestUtils.removeTab(tab);
}

add_task(async function verbs_from_a_private_tab_open_private() {
  await withPrivateTab(async () => {
    await expectPrivate("https://example.com/?verb", () =>
      WhimsyVerbs.openTab(window, "https://example.com/?verb"));
  });
});

add_task(async function page_actions_from_a_private_tab_open_private() {
  WhimsyPageActions._testing = true;
  registerCleanupFunction(() => (WhimsyPageActions._testing = false));
  await withPrivateTab(async () => {
    const action = { kind: "place", name: "Corner Café" };
    const url = `https://maps.apple.com/?${WhimsyPageActions.mapsUrl(action)}`;
    await expectPrivate(url, () => WhimsyPageActions.openInMaps(window, action));
  });
});

add_task(async function normal_tabs_still_open_normal_tabs() {
  const source = await BrowserTestUtils.openNewForegroundTab(gBrowser, SOURCE);
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, "https://example.com/?normal");
  WhimsyVerbs.openTab(window, "https://example.com/?normal");
  const tab = await opened;
  ok(!WhimsyPrivate.isPrivateTab(tab), "A normal page's verb opens a normal tab");
  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(source);
});
