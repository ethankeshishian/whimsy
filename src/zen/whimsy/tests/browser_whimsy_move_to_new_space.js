/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/small: Move to ▸ New Space… makes a space and moves the tab, or its
// whole split, into it once the form is confirmed; cancelling leaves it.

const { WhimsyNewSpaceMove } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyNewSpaceMove.sys.mjs");

async function form() {
  return TestUtils.waitForCondition(() => document.querySelector("zen-workspace-creation"), "The New Space form opens");
}

async function confirm(name) {
  const f = await form();
  await f.promiseInitialized;
  f.inputName.value = name;
  await f.onCreateButtonCommand();
}

async function cancel() {
  const f = await form();
  await f.promiseInitialized;
  await f.onCancelButtonCommand();
}

async function splitPair() {
  const a = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?a");
  const b = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?b");
  gZenViewSplitter.splitTabs([a, b], "vsep");
  await TestUtils.waitForCondition(() => a.group?.hasAttribute("split-view-group"), "The tabs are split");
  return [a, b];
}

async function cleanup(home, tabs) {
  const made = gZenWorkspaces.getWorkspaces().filter(w => w.uuid != home);
  if (gZenWorkspaces.activeWorkspace != home) {
    await gZenWorkspaces.changeWorkspaceWithID(home);
  }
  for (const tab of tabs) {
    if (tab.isConnected) {
      BrowserTestUtils.removeTab(tab);
    }
  }
  for (const space of made) {
    await gZenWorkspaces.removeWorkspace(space.uuid);
  }
}

add_task(async function test_split_moves_into_the_new_space() {
  const home = gZenWorkspaces.activeWorkspace;
  const [a, b] = await splitPair();
  const result = WhimsyNewSpaceMove.moveToNewSpace(window, [a]);
  await confirm("Moved split");
  is(await result, "moved", "Moved once the space was made");
  const space = gZenWorkspaces.getWorkspaces().find(w => w.name == "Moved split");
  ok(space, "The new space exists");
  is(a.getAttribute("zen-workspace-id"), space.uuid, "The tab is in the new space");
  is(b.getAttribute("zen-workspace-id"), space.uuid, "and so is the other pane of its split");
  ok(a.group?.hasAttribute("split-view-group") && a.group == b.group, "still split together");
  is(gZenWorkspaces.activeWorkspace, space.uuid, "The new space is showing");
  ok([a, b].includes(gBrowser.selectedTab), "with the split selected");
  await cleanup(home, [a, b]);
});

add_task(async function test_cancel_leaves_the_tab() {
  const home = gZenWorkspaces.activeWorkspace;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?stay");
  const result = WhimsyNewSpaceMove.moveToNewSpace(window, [tab]);
  await cancel();
  is(await result, "cancelled", "Cancelled");
  is(tab.getAttribute("zen-workspace-id"), home, "The tab stays where it was");
  await cleanup(home, [tab]);
});

add_task(async function test_tab_menu_item() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?menu");
  const popup = document.getElementById("moveTabOptionsMenu");
  TabContextMenu.contextTab = tab;
  popup.dispatchEvent(new Event("popupshowing"));
  const item = document.getElementById("context_whimsyMoveToNewSpace");
  ok(item, "Move To has New Space…");
  is(item.parentElement, popup, "in the Move To menu");
  ok(!item.hidden && !item.disabled, "offered for a normal tab");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.move-to-new-space", false]] });
  popup.dispatchEvent(new Event("popupshowing"));
  ok(item.hidden, "The switch hides it");
  is(await WhimsyNewSpaceMove.moveToNewSpace(window, [tab]), "off", "and the move does nothing");
  ok(!document.querySelector("zen-workspace-creation"), "No form opened");
  await SpecialPowers.popPrefEnv();
  BrowserTestUtils.removeTab(tab);
});

// The split row menu (wave7/split2) keeps its tab on the root popup; its
// New Space… item is handled here so the split goes along.
add_task(async function test_split_row_item() {
  const home = gZenWorkspaces.activeWorkspace;
  const [a, b] = await splitPair();
  const root = document.createXULElement("menupopup");
  root.whimsyTab = a;
  const sub = document.createXULElement("menupopup");
  const item = document.createXULElement("menuitem");
  item.id = "whimsySplitRow-newSpace";
  let reachedMenu = false;
  root.addEventListener("command", () => (reachedMenu = true));
  sub.append(item);
  root.append(sub);
  document.documentElement.append(root);
  item.doCommand();
  ok(!reachedMenu, "The split row menu's own handler doesn't also run");
  await confirm("Split row space");
  const space = await TestUtils.waitForCondition(
    () => gZenWorkspaces.getWorkspaces().find(w => w.name == "Split row space"),
    "The space was made"
  );
  await TestUtils.waitForCondition(
    () => a.getAttribute("zen-workspace-id") == space.uuid && b.getAttribute("zen-workspace-id") == space.uuid,
    "The whole split moved"
  );
  root.remove();
  await cleanup(home, [a, b]);
});

add_task(async function test_command_bar() {
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const action = globalActions.find(a => a.l10nId == "whimsy-action-move-to-new-space");
  ok(action, "The command bar has Move to New Space…");
  ok(action.isAvailable(window), "offered for the current tab");
});
