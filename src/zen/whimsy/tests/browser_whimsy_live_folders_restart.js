/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Whimsy's live folders (Jira, Linear, local servers) must survive a
// restart. Zen restores saved live folders in ZenLiveFoldersManager.init(),
// skipping any whose provider type isn't registered yet, and its next save
// then drops them for good. This drives the manager through the same
// save -> uninit -> init cycle a restart does and checks each folder comes
// back as a live folder of the right type.

const { ZenLiveFoldersManager } = ChromeUtils.importESModule(
  "resource:///modules/zen/ZenLiveFoldersManager.sys.mjs"
);
const { WhimsyJiraLiveFolderProvider } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyJiraLiveFolder.sys.mjs"
);
const { WhimsyLinearLiveFolderProvider } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyLinearLiveFolder.sys.mjs"
);
const { WhimsyLocalServersLiveFolderProvider } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyLocalServersLiveFolder.sys.mjs"
);

const PROVIDERS = [
  { Provider: WhimsyJiraLiveFolderProvider, label: "Jira", extra: { site: "https://example.com" } },
  { Provider: WhimsyLinearLiveFolderProvider, label: "Linear", extra: { team: "" } },
  { Provider: WhimsyLocalServersLiveFolderProvider, label: "Local Servers", extra: {} },
];

async function restartManager() {
  ZenLiveFoldersManager.saveState(false);
  ZenLiveFoldersManager.uninit();
  await ZenLiveFoldersManager.init();
}

add_task(async function test_whimsy_live_folders_survive_restart() {
  ok(
    Object.getPrototypeOf(ZenLiveFoldersManager).init.whimsyWrapped,
    "Whimsy's registration hook wraps the manager's init()"
  );

  const created = [];
  for (const { Provider, label, extra } of PROVIDERS) {
    // Collapsed and just fetched: nothing probes or fetches during the test.
    const folder = await gZenFolders.createFolder([], {
      renameFolder: false,
      label,
      isLiveFolder: true,
      collapsed: true,
    });
    const liveFolder = new Provider({
      id: folder.id,
      manager: ZenLiveFoldersManager,
      state: {
        type: Provider.type,
        interval: 30 * 60 * 1000,
        lastFetched: Date.now(),
        options: {},
        ...extra,
      },
    });
    ZenLiveFoldersManager.liveFolders.set(folder.id, liveFolder);
    liveFolder.start();
    created.push({ folder, type: Provider.type });
  }

  await restartManager();

  for (const { folder, type } of created) {
    const restored = ZenLiveFoldersManager.getFolder(folder.id);
    ok(restored, `The ${type} live folder is restored after a restart`);
    is(restored?.constructor.type, type, `and is still a ${type} folder`);
  }

  // A second restart: the first restore's save must not have dropped them.
  await restartManager();
  for (const { folder, type } of created) {
    is(
      ZenLiveFoldersManager.getFolder(folder.id)?.constructor.type,
      type,
      `The ${type} live folder survives a second restart`
    );
  }

  for (const { folder } of created) {
    ZenLiveFoldersManager.getFolder(folder.id)?.stop();
    ZenLiveFoldersManager.liveFolders.delete(folder.id);
    folder.delete();
  }
  ZenLiveFoldersManager.saveState(false);
});
