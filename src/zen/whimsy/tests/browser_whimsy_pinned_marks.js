/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// fix7/tabs: no stray blue lines on pinned tabs. A pinned tab in its
// space's own container is marked so Zen hides the container line; one in
// another container keeps a short pill; Firefox's multi-drag stack lines
// are cleared once a drag ends.

const startTabs = new Set(gBrowser.tabs);
registerCleanupFunction(() => {
  for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
    BrowserTestUtils.removeTab(tab);
  }
});

function contextLine(tab) {
  return tab.querySelector(".tab-context-line");
}

add_task(async function test_space_container_gets_no_line() {
  const space = gZenWorkspaces.getActiveWorkspaceFromCache();
  const oldContainer = space.containerTabId;
  space.containerTabId = 1;
  registerCleanupFunction(() => {
    space.containerTabId = oldContainer;
  });

  const own = BrowserTestUtils.addTab(gBrowser, "https://example.com/?own", { userContextId: 1 });
  await BrowserTestUtils.browserLoaded(own.linkedBrowser);
  own.removeAttribute("zenDefaultUserContextId");
  gBrowser.pinTab(own);
  await TestUtils.waitForCondition(() => own.getAttribute("zenDefaultUserContextId") == "true",
    "A pinned tab in its space's container is marked as the space's default");
  is(getComputedStyle(contextLine(own)).display, "none", "...so no container line is drawn");

  // wave8/isolation: a tab of another container doesn't stay in this space
  // (it goes to its own profile's space, or reopens here in this space's
  // container). The pill is still drawn while one shows here, e.g. a synced
  // tab in the moment before the guard sorts it out; the guard is held off
  // for that moment.
  const { WhimsyIsolation } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyIsolation.sys.mjs");
  const other = WhimsyIsolation.quietly(window, () => {
    const tab = BrowserTestUtils.addTab(gBrowser, "https://example.org/?other", { userContextId: 2 });
    gBrowser.pinTab(tab);
    return tab;
  });
  ok(!other.hasAttribute("zenDefaultUserContextId"), "Another container keeps its indicator");
  const style = getComputedStyle(contextLine(other));
  is(style.height, "14px", "...drawn as a short pill");
  is(style.width, "3px", "...3px wide");
  ok(WhimsyIsolation.violates(window, other), "That tab crosses, so the guard sorts it out");

  space.containerTabId = oldContainer;
  BrowserTestUtils.removeTab(own);
  BrowserTestUtils.removeTab(other);
});

add_task(async function test_drag_stack_lines_cleared() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?stack");
  gBrowser.pinTab(tab);
  tab.setAttribute("small-stack", "");
  document.documentElement.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
  await TestUtils.waitForCondition(() => !tab.hasAttribute("small-stack"),
    "A finished drag leaves no stack lines behind");
  BrowserTestUtils.removeTab(tab);
});
