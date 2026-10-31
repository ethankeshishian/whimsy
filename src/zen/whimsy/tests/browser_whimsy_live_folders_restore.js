/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// wave7/folders: Jira, Linear and Local Servers live folders must survive a
// restart. Zen's restore skips a saved folder whose provider isn't
// registered and then saves without it, so a provider that registers after
// the restore used to lose its folders for good. Here the restore runs with
// Jira unregistered (its switch off) and Jira registers afterwards: the
// folder is held, saved back unchanged, then re-attached to a real Jira
// provider with its own settings.

const { ZenLiveFoldersManager } = ChromeUtils.importESModule(
  "resource:///modules/zen/ZenLiveFoldersManager.sys.mjs"
);
const { WhimsyLiveFolders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLiveFolders.sys.mjs");
const { WhimsyJiraLiveFolderProvider } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyJiraLiveFolder.sys.mjs"
);

const STORE = PathUtils.join(PathUtils.profileDir, "zen-live-folders.jsonlz4");
const JQL = "project = WHIMSY";

async function readStore() {
  try {
    return await IOUtils.readJSON(STORE, { decompress: true });
  } catch {
    return null;
  }
}

add_task(async function test_hooks_installed_before_restore() {
  const proto = Object.getPrototypeOf(ZenLiveFoldersManager);
  ok(proto.init.whimsyWrapped, "Zen's init() is wrapped (installed at startup, before any window restores)");
  ok(ZenLiveFoldersManager.registry.has("jira"), "Jira is registered");
  ok(ZenLiveFoldersManager.registry.has("linear"), "Linear is registered");
  ok(ZenLiveFoldersManager.registry.has("whimsy:local-servers"), "Local Servers is registered");
});

add_task(async function test_late_provider_keeps_folder() {
  const folder = await gZenFolders.createFolder([], {
    renameFolder: false,
    label: "Jira restore",
    isLiveFolder: true,
    collapsed: true,
  });
  const id = folder.id;
  const original = await readStore();
  const entry = {
    id,
    type: "jira",
    data: {
      state: {
        site: "https://example.atlassian.net",
        jql: JQL,
        interval: 30 * 60 * 1000,
        // Fetched just now, so the re-attached provider doesn't fetch.
        lastFetched: Date.now(),
        options: {},
      },
    },
    dismissedItems: [`${id}:ABC-9`],
    tabsState: [],
  };

  // "Restart": Zen's restore runs with Jira not registered.
  ZenLiveFoldersManager.uninit();
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.live-folders-jira", false]] });
  await IOUtils.writeJSON(STORE, [entry], { compress: true });
  await ZenLiveFoldersManager.init();
  ok(!ZenLiveFoldersManager.registry.has("jira"), "Jira wasn't registered during the restore");

  const held = ZenLiveFoldersManager.getFolder(id);
  ok(held, "The Jira folder is still a live folder after the restore");
  ok(held.whimsyPending, "held until its provider registers");
  is(held.constructor.type, "jira", "with its saved type");
  ok(ZenLiveFoldersManager.dismissedItems.has(`${id}:ABC-9`), "Its dismissed items are kept");

  ZenLiveFoldersManager.saveState(false);
  await TestUtils.waitForCondition(async () => {
    const data = await readStore();
    return Array.isArray(data) && data.some(e => e.id === id);
  }, "Saving keeps the held folder on disk instead of dropping it");
  const saved = (await readStore()).find(e => e.id === id);
  is(saved.type, "jira", "Saved with its type");
  is(saved.data.state.jql, JQL, "and its own settings, unchanged");

  // Jira registers late (its switch turns back on).
  await SpecialPowers.popPrefEnv();
  WhimsyLiveFolders.registerProviders(ZenLiveFoldersManager);
  const attached = ZenLiveFoldersManager.getFolder(id);
  ok(attached instanceof WhimsyJiraLiveFolderProvider, "Re-attached to a real Jira provider");
  ok(!attached.whimsyPending, "no longer held");
  is(attached.state.jql, JQL, "with the folder's own query");
  is(attached.state.site, "https://example.atlassian.net", "and site");

  // A held folder whose folder is gone is not held.
  ZenLiveFoldersManager.uninit();
  await IOUtils.writeJSON(STORE, [{ ...entry, id: "whimsy-missing-folder" }], { compress: true });
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.live-folders-jira", false]] });
  await ZenLiveFoldersManager.init();
  ok(!ZenLiveFoldersManager.getFolder("whimsy-missing-folder"), "An entry without its folder isn't held");
  await SpecialPowers.popPrefEnv();

  // Clean up: restore the store and the manager as they were.
  ZenLiveFoldersManager.uninit();
  if (original) {
    await IOUtils.writeJSON(STORE, original, { compress: true });
  } else {
    await IOUtils.remove(STORE, { ignoreAbsent: true });
  }
  await ZenLiveFoldersManager.init();
  folder.delete();
});
