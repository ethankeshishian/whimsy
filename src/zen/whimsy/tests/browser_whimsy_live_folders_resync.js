/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Live folders: a Resync option that brings back tabs closed by hand (W8-26).
// Clearing the folder's entries in ZenLiveFoldersManager.dismissedItems and
// re-fetching recreates tabs the person closed.

const { WhimsyLiveFolders } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyLiveFolders.sys.mjs"
);
const { WhimsyCommands } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyCommands.sys.mjs"
);
const { nsZenLiveFolderProvider } = ChromeUtils.importESModule(
  "resource:///modules/zen/ZenLiveFolder.sys.mjs"
);

function makeManager(dismissed = []) {
  return {
    window,
    dismissedItems: new Set(dismissed),
    saveStateCalled: false,
    saveState() {
      this.saveStateCalled = true;
    },
    liveFolders: new Map(),
    getFolder(id) {
      return this.liveFolders.get(id);
    },
  };
}

add_setup(async function () {
  WhimsyLiveFolders.init();
  WhimsyLiveFolders.initWindow(window);
});

add_task(async function test_resync_clears_dismissals_and_refreshes() {
  const manager = makeManager([
    "folder-a:item-1",
    "folder-a:item-2",
    "folder-b:item-3",
  ]);

  let refreshed = false;
  const folderA = new (class extends nsZenLiveFolderProvider {
    static type = "mock";
    refresh() {
      refreshed = true;
    }
  })({
    id: "folder-a",
    manager,
    state: { whimsyEtag: "abc" },
  });
  manager.liveFolders.set("folder-a", folderA);

  ok(manager.dismissedItems.has("folder-a:item-1"), "Dismissal is present before resync");
  ok(manager.dismissedItems.has("folder-b:item-3"), "Other folder's dismissal is present");

  WhimsyLiveFolders.resyncFolder(folderA);

  ok(refreshed, "Resync triggered a refresh on the live folder");
  ok(manager.saveStateCalled, "State was saved after clearing dismissals");
  ok(!manager.dismissedItems.has("folder-a:item-1"), "Folder A item 1 was cleared");
  ok(!manager.dismissedItems.has("folder-a:item-2"), "Folder A item 2 was cleared");
  ok(manager.dismissedItems.has("folder-b:item-3"), "Folder B item 3 remains dismissed");
  ok(!("whimsyEtag" in folderA.state), "Cached ETag was cleared to force a fresh sync");
});

add_task(async function test_menu_option_triggers_resync() {
  const manager = makeManager(["folder-menu:item-1"]);
  let refreshed = false;
  const folder = new (class extends nsZenLiveFolderProvider {
    static type = "mock";
    refresh() {
      refreshed = true;
    }
  })({
    id: "folder-menu",
    manager,
    state: {},
  });

  const option = document.createXULElement("menuitem");
  option.setAttribute("option-key", "whimsyResync");
  folder.onOptionTrigger(option);

  ok(refreshed, "Triggering whimsyResync option calls resyncFolder");
  ok(!manager.dismissedItems.has("folder-menu:item-1"), "Dismissed item was cleared");
});

add_task(async function test_resync_menuitem_spliced() {
  // Zen's own Live Options menu when the window has it, else a stand-in.
  let container = document.getElementById("context_zenLiveFolderOptions");
  const standIn = !container;
  if (standIn) {
    container = document.createXULElement("menu");
    container.id = "context_zenLiveFolderOptions";
    container.append(document.createXULElement("menupopup"));
    document.body.appendChild(container);
  }
  const popup = container.querySelector("menupopup");
  const saved = [...popup.childNodes];
  const refresh = document.createXULElement("menuitem");
  refresh.setAttribute("option-key", "refresh");
  popup.replaceChildren(refresh);

  try {
    const fakeUi = { document };
    const folderObj = { id: "foldertest" };
    WhimsyLiveFolders.addResyncMenuItem(fakeUi, folderObj);

    const resyncItem = popup.querySelector('menuitem[option-key="whimsyResync"]');
    ok(resyncItem, "Resync menu item is created in context menu popup");
    is(resyncItem.getAttribute("option-folder"), "foldertest", "option-folder attribute is set");
    is(resyncItem.previousElementSibling, refresh, "Resync is placed directly after refresh");
  } finally {
    popup.replaceChildren(...saved);
    if (standIn) {
      container.remove();
    }
  }
});

add_task(async function test_command_registered() {
  const entry = WhimsyCommands.get("cmd_whimsyResyncLiveFolder");
  ok(entry, "Resync Live Folder command is registered in WhimsyCommands");
  is(entry.l10nId, "whimsy-action-resync-live-folder", "Has the expected l10nId");
});

add_task(async function test_switch_off() {
  const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
  const action = globalActions.find(a => a.whimsyCommand == "cmd_whimsyResyncLiveFolder");
  ok(action, "Resync Live Folder is in the command bar");
  const { ZenLiveFoldersManager } = ChromeUtils.importESModule(
    "resource:///modules/zen/ZenLiveFoldersManager.sys.mjs"
  );
  // A live folder exists, so only the switch decides.
  const added = !ZenLiveFoldersManager.liveFolders.has("whimsy-resync-test");
  if (added) {
    ZenLiveFoldersManager.liveFolders.set("whimsy-resync-test", {});
  }
  try {
    ok(action.isAvailable(window), "Offered while a live folder exists");
    await SpecialPowers.pushPrefEnv({
      set: [["whimsy.feature.live-folders-resync", false]],
    });
    ok(!WhimsyLiveFolders.resyncEnabled, "Feature switch turns Resync off");
    ok(!action.isAvailable(window), "Not offered in the command bar when off");
    await SpecialPowers.popPrefEnv();
  } finally {
    if (added) {
      ZenLiveFoldersManager.liveFolders.delete("whimsy-resync-test");
    }
  }
});
