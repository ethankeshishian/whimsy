/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave13/edge-line: "a blue line on the right side of the tab after Cmd+O
// in Mini" and "a purple bar on the right side of the tab in a Google Meet
// call". Both were Firefox's container line (.tab-context-line: 3px, the
// full height of the row, at the tab's trailing edge in Zen's sidebar) in
// the colour of the space's profile. Zen hides it only for tabs marked
// zenDefaultUserContextId, and a tab that reaches a space in that space's
// own container by any path that passes the container explicitly (Mini's
// link tab and its adoption on Cmd+O, a link opened in a profile) isn't
// marked. fix7/tabs marked such tabs, but only pinned ones.

const { WhimsyQuickWindow } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs");

const startTabs = new Set(gBrowser.tabs);
let identity = null;
let space = null;
let oldContainer = 0;

add_setup(async function profile_space() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.quick-window.size", ""],
      ["zen.workspaces.hide-default-container-indicator", true],
    ],
  });
  identity = ContextualIdentityService.create("Edge line", "briefcase", "purple");
  space = gZenWorkspaces.getActiveWorkspaceFromCache();
  oldContainer = space.containerTabId;
  space.containerTabId = identity.userContextId;
  registerCleanupFunction(async () => {
    for (const win of WhimsyQuickWindow.windows()) {
      await BrowserTestUtils.closeWindow(win);
    }
    for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
      BrowserTestUtils.removeTab(tab);
    }
    space.containerTabId = oldContainer;
    ContextualIdentityService.remove(identity.userContextId);
  });
});

function lineOf(tab) {
  const line = tab.querySelector(".tab-context-line");
  const rect = line.getBoundingClientRect();
  return { display: getComputedStyle(line).display, width: rect.width, height: rect.height };
}

function expectNoLine(tab, what) {
  is(tab.getAttribute("usercontextid"), String(identity.userContextId), `${what} is in the space's profile`);
  is(tab.getAttribute("zenDefaultUserContextId"), "true", `${what} is marked as the space's own container`);
  const line = lineOf(tab);
  is(line.display, "none", `${what} draws no container line`);
  ok(!line.width || !line.height, `${what}: nothing painted at the row's edge (${line.width}x${line.height})`);
}

add_task(async function test_cmd_o_from_mini_leaves_no_line() {
  const win = WhimsyQuickWindow.open("https://example.com/?edge-line", { opener: window });
  await WhimsyQuickWindow.whenReady(win);
  await TestUtils.waitForCondition(
    () => win.gBrowser.selectedBrowser.currentURI.spec == "https://example.com/?edge-line",
    "Mini loaded its page"
  );
  is(win.gBrowser.selectedTab.getAttribute("usercontextid"), String(identity.userContextId),
    "Mini opened the link in the space's profile");
  await SimpleTest.promiseFocus(win);
  EventUtils.synthesizeKey("o", { accelKey: true }, win);
  await TestUtils.waitForCondition(() => win.closed, "Cmd+O moves the page and closes Mini");
  const adopted = gBrowser.selectedTab;
  is(adopted.linkedBrowser.currentURI.spec, "https://example.com/?edge-line", "The page landed here, selected");
  is(adopted.getAttribute("zen-workspace-id"), space.uuid, "...in the current space");
  await TestUtils.waitForTick();
  expectNoLine(adopted, "The adopted tab");
});

add_task(async function test_background_tab_in_space_container_leaves_no_line() {
  // The Meet case: an ordinary (unpinned, unselected) tab opened with the
  // space's container passed explicitly.
  const tab = BrowserTestUtils.addTab(gBrowser, "https://example.org/?edge-line-meet", {
    userContextId: identity.userContextId,
  });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  tab.removeAttribute("zenDefaultUserContextId");
  gZenWorkspaces.moveTabToWorkspace(tab, space.uuid);
  gBrowser.selectedTab = tab;
  await TestUtils.waitForCondition(() => tab.getAttribute("zenDefaultUserContextId") == "true",
    "An unpinned tab in its space's container is marked as the space's default");
  expectNoLine(tab, "The unpinned tab");
});

add_task(async function test_every_mini_page_lands_without_a_line() {
  // Mini with two pages: Cmd+O moves both, and only the one you were on is
  // selected, so the other is never switched to.
  const win = WhimsyQuickWindow.open("https://example.com/?edge-line-1", { opener: window });
  await WhimsyQuickWindow.whenReady(win);
  await TestUtils.waitForCondition(
    () => win.gBrowser.selectedBrowser.currentURI.spec == "https://example.com/?edge-line-1",
    "Mini loaded its first page"
  );
  const second = WhimsyQuickWindow.openLinkTab(win, "https://example.org/?edge-line-2");
  await BrowserTestUtils.browserLoaded(second.linkedBrowser);
  win.gBrowser.selectedTab = WhimsyQuickWindow.pages(win)[0];
  await SimpleTest.promiseFocus(win);
  EventUtils.synthesizeKey("o", { accelKey: true }, win);
  await TestUtils.waitForCondition(() => win.closed, "Cmd+O moves both pages and closes Mini");
  const landed = url => gBrowser.tabs.find(tab => tab.linkedBrowser.currentURI.spec == url);
  const first = landed("https://example.com/?edge-line-1");
  const other = landed("https://example.org/?edge-line-2");
  ok(first?.selected, "The page you were on is selected");
  ok(other && !other.selected, "The other page landed in the background");
  await TestUtils.waitForTick();
  expectNoLine(first, "The selected page");
  expectNoLine(other, "The background page");
});
