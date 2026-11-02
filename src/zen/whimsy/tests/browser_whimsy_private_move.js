/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W11-13: moving private pages out to a space. Zen's "Move To" button in a
// private window's space header moves ALL its tabs (d11); "Move Out of
// Private…" (the tab's right-click menu and a command) moves one tab, from
// a private window or a private tab in a normal window (d13). A surface
// lists the spaces, then asks first (d12). The pages reopen as ordinary
// tabs in that space's profile (never carrying private data), it switches
// there and selects the first, and the private originals close.

const { WhimsyPrivateMove } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivateMove.sys.mjs");
const { WhimsyPrivate } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyPrivate.sys.mjs");
const { WhimsySpaceLock } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySpaceLock.sys.mjs");

let firstSpace, target, container;

add_setup(async function () {
  firstSpace = gZenWorkspaces.getWorkspaces().find(w => w.uuid == gZenWorkspaces.activeWorkspace);
  container = ContextualIdentityService.create("Whimsy Move Profile", "fingerprint", "blue");
  target = await gZenWorkspaces.createAndSaveWorkspace("Work", undefined, true, container.userContextId);
  const startTabs = new Set(gBrowser.tabs);
  registerCleanupFunction(async () => {
    for (const tab of gBrowser.tabs.filter(t => !startTabs.has(t))) {
      if (tab.isConnected && !tab.closing) {
        BrowserTestUtils.removeTab(tab, { animate: false });
      }
    }
    if (gZenWorkspaces.activeWorkspace != firstSpace.uuid) {
      await gZenWorkspaces.changeWorkspaceWithID(firstSpace.uuid);
    }
    const space = gZenWorkspaces.getWorkspaces().find(w => w.uuid == target.uuid);
    if (space) {
      delete space.whimsyLocked;
      gZenWorkspaces.saveWorkspace(space);
      await gZenWorkspaces.removeWorkspace(target.uuid);
    }
    ContextualIdentityService.remove(container.userContextId);
  });
});

function uniqueURL(tag) {
  return `https://example.com/?${tag}=${Date.now()}${Math.random().toString(36).slice(2)}`;
}

async function waitForPanel(win) {
  return TestUtils.waitForCondition(() => {
    const panel = win.document.getElementById(WhimsyPrivateMove.PANEL_ID);
    return panel?.state == "open" ? panel : null;
  }, "The Move to a space surface opens");
}

function spaceRow(panel, uuid) {
  return panel.querySelector(`.whimsy-private-move-space[data-uuid="${uuid}"]`);
}

function movedTabs(url) {
  return gBrowser.tabs.filter(t => !t.closing && t.linkedBrowser.currentURI?.spec == url);
}

add_task(async function test_private_window_move_to_moves_all_tabs() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  await win.gZenWorkspaces?.promiseInitialized;
  const urlA = uniqueURL("a");
  const urlB = uniqueURL("b");
  BrowserTestUtils.startLoadingURIString(win.gBrowser.selectedBrowser, urlA);
  await BrowserTestUtils.browserLoaded(win.gBrowser.selectedBrowser, false, urlA);
  const tabB = BrowserTestUtils.addTab(win.gBrowser, urlB);
  await BrowserTestUtils.browserLoaded(tabB.linkedBrowser, false, urlB);

  const button = await TestUtils.waitForCondition(() =>
    [...win.document.querySelectorAll(".zen-workspaces-actions")].find(b =>
      b.getAttribute("data-l10n-id") == "zen-move-tab-to-workspace-button" && b.checkVisibility()),
  "Zen's Move To button is in the private window's header");
  button.doCommand();
  const panel = await waitForPanel(win);
  is(panel.dataset.scope, "all", "The header's Move To moves every tab");
  ok(!win.document.getElementById("zenMoveTabsToSyncedWorkspacePopup")?.state?.startsWith("open"),
    "Zen's own menu didn't open");
  ok(!spaceRow(panel, WhimsyPrivate.getScratch?.(window)?.uuid ?? "none"), "The Private Space is never a target");
  const row = spaceRow(panel, target.uuid);
  ok(row, "The space is listed");
  row.click();
  const title = panel.querySelector(".whimsy-surface-title");
  await TestUtils.waitForCondition(() => title.textContent == "Move 2 tabs to “Work”?", "It asks first");
  const body = panel.querySelector(".whimsy-private-move-body");
  await TestUtils.waitForCondition(() => body.textContent.includes("Whimsy Move Profile"), "...naming the profile");
  ok(body.textContent.includes("outside private browsing"), "...and what moving means");

  const closed = BrowserTestUtils.domWindowClosed(win);
  panel.querySelector("#whimsy-private-move-confirm").doCommand();
  await closed;
  await TestUtils.waitForCondition(() => gZenWorkspaces.activeWorkspace == target.uuid, "Switched to the space");
  await TestUtils.waitForCondition(() => movedTabs(urlA).length == 1 && movedTabs(urlB).length == 1,
    "Both pages reopened here");
  for (const tab of [...movedTabs(urlA), ...movedTabs(urlB)]) {
    ok(!tab.linkedBrowser.browsingContext.usePrivateBrowsing, "Reopened outside private browsing");
    is(tab.userContextId, container.userContextId, "...in the space's profile");
    is(tab.getAttribute("zen-workspace-id"), target.uuid, "...in that space");
  }
  is(gBrowser.selectedTab, movedTabs(urlA)[0], "The first moved tab is selected");
  for (const tab of [...movedTabs(urlA), ...movedTabs(urlB)]) {
    BrowserTestUtils.removeTab(tab, { animate: false });
  }
  await gZenWorkspaces.changeWorkspaceWithID(firstSpace.uuid);
});

add_task(async function test_private_tab_move_out_of_private() {
  const url = uniqueURL("tab");
  const priv = WhimsyPrivate.openPrivateTab(window, { url });
  await TestUtils.waitForCondition(() => priv.linkedBrowser.currentURI?.spec == url, "The private page loaded");
  gBrowser.selectedTab = priv;
  ok(WhimsyPrivateMove.isPrivateTab(window, priv), "A private tab");

  // The tab menu offers it.
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(priv, { type: "contextmenu", button: 2 }, window);
  await shown;
  const item = document.getElementById("context_whimsyMoveOutOfPrivate");
  ok(item && !item.hidden, "Move Out of Private… is in the private tab's menu");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;

  document.getElementById("cmd_whimsyMoveOutOfPrivate").doCommand();
  const panel = await waitForPanel(window);
  is(panel.dataset.scope, "tab", "The command moves this tab");
  spaceRow(panel, target.uuid).click();
  const title = panel.querySelector(".whimsy-surface-title");
  await TestUtils.waitForCondition(() => title.textContent == "Move this tab to “Work”?", "It asks first");
  // Esc in the question goes back to the list.
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  await TestUtils.waitForCondition(() => title.textContent == "Move to a space", "Esc goes back");
  is(panel.state, "open", "...keeping the surface open");
  spaceRow(panel, target.uuid).click();
  await TestUtils.waitForCondition(() => panel.querySelector("#whimsy-private-move-confirm"), "Asked again");
  panel.querySelector("#whimsy-private-move-confirm").doCommand();
  await TestUtils.waitForCondition(() => movedTabs(url).some(t => !t.linkedBrowser.browsingContext.usePrivateBrowsing),
    "The page reopened outside private browsing");
  await TestUtils.waitForCondition(() => !priv.isConnected, "The private original closed");
  const moved = movedTabs(url)[0];
  is(moved.userContextId, container.userContextId, "In the space's profile");
  is(gZenWorkspaces.activeWorkspace, target.uuid, "Switched to the space");
  is(gBrowser.selectedTab, moved, "...and selected it");
  BrowserTestUtils.removeTab(moved, { animate: false });
  await gZenWorkspaces.changeWorkspaceWithID(firstSpace.uuid);
});

add_task(async function test_not_offered_for_normal_tabs() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, uniqueURL("normal"));
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const action = globalActions.find(a => a.l10nId == "whimsy-action-move-out-of-private");
  ok(action, "The command is in the command bar");
  ok(!action.isAvailable(window), "...but not for a normal tab");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_locked_target_cancelled_moves_nothing() {
  const space = gZenWorkspaces.getWorkspaces().find(w => w.uuid == target.uuid);
  space.whimsyLocked = true;
  gZenWorkspaces.saveWorkspace(space);
  const original = WhimsySpaceLock.authenticate;
  WhimsySpaceLock.authenticate = async () => false;
  const url = uniqueURL("locked");
  const priv = WhimsyPrivate.openPrivateTab(window, { url });
  try {
    await TestUtils.waitForCondition(() => priv.linkedBrowser.currentURI?.spec == url, "The private page loaded");
    const moved = await WhimsyPrivateMove.move(window, [priv], target.uuid);
    ok(!moved, "Cancelling the unlock moves nothing");
    ok(priv.isConnected && !priv.closing, "The private tab stays");
    ok(!movedTabs(url).some(t => !t.linkedBrowser.browsingContext.usePrivateBrowsing), "No normal copy");
    is(gZenWorkspaces.activeWorkspace, firstSpace.uuid, "No switch");
  } finally {
    WhimsySpaceLock.authenticate = original;
    delete space.whimsyLocked;
    gZenWorkspaces.saveWorkspace(space);
    BrowserTestUtils.removeTab(priv, { animate: false });
  }
});
