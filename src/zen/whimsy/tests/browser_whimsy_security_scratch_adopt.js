/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave9/secfix (security-full-1 M2): a normal tab adopted into Scratch from
// another window (drag between windows, window sync, Mini's Open in Space)
// had no earlier space in this window, so isolation let it stay: violet,
// but still writing history and the normal cookie jar. It now leaves
// Scratch, and Mini no longer offers Scratch at all.

const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const { WhimsyIsolation } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyIsolation.sys.mjs");
const { WhimsyQuickWindow } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs");

const PAGE = "https://example.com/?secfix-m2-adopted";
const ATTR = "zen-workspace-id";

add_task(async function an_adopted_normal_tab_leaves_scratch() {
  WhimsyIsolation.initWindow(window);
  const home = gZenWorkspaces.getActiveWorkspace();
  const before = new Set(gZenWorkspaces.allStoredTabs ?? gBrowser.tabs);
  const scratch = await WhimsyPrivate.openScratch(window, { withTab: true });
  ok(scratch, "Scratch is open");

  const other = await BrowserTestUtils.openNewBrowserWindow();
  const source = await BrowserTestUtils.openNewForegroundTab(other.gBrowser, PAGE);
  ok(!WhimsyPrivate.isPrivateTab(source), "A normal tab in another window");

  const adopted = gBrowser.adoptTab(source, { selectTab: false, spaceId: scratch.uuid });
  ok(adopted, "Adopted into this window");
  await TestUtils.waitForCondition(() => adopted.closing || !adopted.isConnected ||
    adopted.getAttribute(ATTR) != scratch.uuid, "It leaves Scratch");
  if (adopted.isConnected && !adopted.closing) {
    ok(!WhimsyPrivate.isScratchId(window, adopted.getAttribute(ATTR)), "It's in another space");
    is(WhimsyIsolation.containerOf(window, adopted.getAttribute(ATTR)), adopted.userContextId ?? 0,
      "…one of its own profile");
  }
  const inScratch = (gZenWorkspaces.allStoredTabs ?? gBrowser.tabs).filter(t =>
    t.getAttribute(ATTR) == scratch.uuid && !t.closing && !t.hasAttribute("zen-empty-tab"));
  ok(inScratch.every(t => WhimsyPrivate.isPrivateTab(t)), "Scratch holds only private tabs");

  await BrowserTestUtils.closeWindow(other);
  await WhimsyPrivate.closeScratch(window);
  if (gZenWorkspaces.activeWorkspace != home.uuid) {
    await gZenWorkspaces.changeWorkspace(home);
  }
  // The move reopens the tab in its own space: close whatever this made.
  for (const tab of [...(gZenWorkspaces.allStoredTabs ?? gBrowser.tabs)]) {
    if (!before.has(tab) && !tab.closing && !tab.hasAttribute("zen-empty-tab") && !tab.pinned) {
      BrowserTestUtils.removeTab(tab);
    }
  }
});

add_task(async function mini_never_offers_scratch() {
  const scratch = await WhimsyPrivate.openScratch(window, { withTab: true });
  const offered = WhimsyQuickWindow.spaces({ opener: window });
  ok(offered.length, "Mini offers spaces");
  ok(!offered.some(space => space.uuid == scratch.uuid), "…but not Scratch");
  await WhimsyPrivate.closeScratch(window);
});
