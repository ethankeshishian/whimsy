/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W31 foldertab: a tab in a folder that was unloaded (greyed out) comes back
// on the last page it showed, not its folder page, whether it moved by a real
// load or by pushState (how single-page apps change pages), whether it was
// unloaded by itself or with the folder's Unload button, and after a session
// restore. Only Zen's explicit reset (⌘W with the reset behavior, Reset Pinned
// Tab) sends it back to its folder page.

requestLongerTimeout(2);

const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
const { TabStateFlusher } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs");
const { ZenSessionStore } = ChromeUtils.importESModule("resource:///modules/zen/ZenSessionManager.sys.mjs");

const ORIGIN = "https://example.com";

function uniquePath(tag) {
  return `/browser/whimsy-foldertab-${tag}-${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

// Unloading the selected folder tab moves to another tab, and Zen may open
// its blank tab for that; leave the window with the tabs it started with.
const startingTabs = new Set(gBrowser.tabs);
registerCleanupFunction(async () => {
  for (const tab of [...gBrowser.tabs]) {
    if (!startingTabs.has(tab) && tab.isConnected && !tab.closing) {
      if (tab.pinned) {
        gBrowser.unpinTab(tab);
      }
      await BrowserTestUtils.removeTab(tab);
    }
  }
});

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.pinned-tab-manager.close-shortcut-behavior", "reset-unload-switch"],
      ["zen.pinned-tab-manager.restore-pinned-tabs-to-pinned-url", false],
      ["whimsy.feature.side-panels", false],
    ],
  });
});

// A folder holding one loaded tab on its folder page, plus a tab to stand on.
async function setUpFolderTab(tag) {
  const keep = await BrowserTestUtils.openNewForegroundTab(gBrowser, ORIGIN + uniquePath(`keep-${tag}`));
  const home = ORIGIN + uniquePath(`home-${tag}`);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, home);
  const folder = await gZenFolders.createFolder([tab], { renameFolder: false, label: "Linear" });
  await TestUtils.waitForCondition(
    () => tab.pinned && tab.group == folder && tab._zenPinnedInitialState?.entry?.url == home,
    "The folder tab records its folder page"
  );
  gBrowser.selectedTab = tab;
  return { keep, home, tab, folder };
}

async function navigateByLoad(tab, tag) {
  const url = ORIGIN + uniquePath(`loaded-${tag}`);
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, url);
  await loaded;
  return url;
}

async function navigateByPushState(tab, tag) {
  const path = uniquePath(`pushed-${tag}`);
  await SpecialPowers.spawn(tab.linkedBrowser, [path], p => content.history.pushState({}, "", p));
  await TestUtils.waitForCondition(() => tab.linkedBrowser.currentURI.spec == ORIGIN + path, "pushState moved the tab");
  return ORIGIN + path;
}

async function selectAndWait(tab, url, message) {
  gBrowser.selectedTab = tab;
  await TestUtils.waitForCondition(
    () => !tab.hasAttribute("pending") && tab.linkedBrowser.currentURI.spec != "about:blank",
    "The tab loads"
  );
  // A reset restores the tab's state asynchronously; give it time to land.
  await TestUtils.waitForCondition(() => tab.linkedBrowser.currentURI.spec == url, message).catch(() => {});
  await TabStateFlusher.flush(tab.linkedBrowser);
  is(tab.linkedBrowser.currentURI.spec, url, message);
}

async function cleanUp({ keep, tab, folder }, extra = []) {
  if (folder?.isConnected) {
    const removed = BrowserTestUtils.waitForEvent(folder, "TabGroupRemoved");
    folder.delete();
    await removed;
  }
  for (const t of [tab, keep, ...extra]) {
    if (t?.isConnected && !t.closing) {
      if (t.pinned) {
        gBrowser.unpinTab(t);
      }
      BrowserTestUtils.removeTab(t);
    }
  }
}

const UNLOADS = {
  // Unload Tab, from the tab's context menu.
  async tab({ keep, tab }) {
    gBrowser.selectedTab = keep;
    await gBrowser.explicitUnloadTabs([tab]);
  },
  // The folder's Unload button (and its context menu's Unload All Tabs).
  async folder({ tab, folder }) {
    folder.unloadAllTabs(new CustomEvent("command"));
    await TestUtils.waitForCondition(() => !tab.selected, "The folder's unload moves off its tab");
  },
};

for (const how of ["load", "pushState"]) {
  for (const unload of Object.keys(UNLOADS)) {
    add_task(async function unloaded_folder_tab_shows_its_latest_page() {
      const setup = await setUpFolderTab(`${how}-${unload}`);
      const { tab } = setup;
      const latest = how == "load" ? await navigateByLoad(tab, unload) : await navigateByPushState(tab, unload);
      await UNLOADS[unload](setup);
      await TestUtils.waitForCondition(() => tab.hasAttribute("pending"), "The folder tab is unloaded (greyed out)");
      await selectAndWait(tab, latest, `After ${unload} unload, a folder tab moved by ${how} shows its latest page`);
      await cleanUp(setup);
    });
  }
}

// ⌘W with Zen's reset behavior is the explicit reset: the tab goes home.
add_task(async function command_w_still_resets_the_folder_tab() {
  const setup = await setUpFolderTab("cmdw");
  const { tab, home } = setup;
  await navigateByPushState(tab, "cmdw");
  gBrowser.selectedTab = tab;
  await SimpleTest.promiseFocus(window);
  EventUtils.synthesizeKey("w", { accelKey: true });
  await TestUtils.waitForCondition(() => !tab.selected && tab.hasAttribute("pending"), "⌘W unloads and moves off");
  await selectAndWait(tab, home, "⌘W reset the folder tab to its folder page");
  await cleanUp(setup);
});

// Reset Pinned Tab (the tab's reset button / context menu) still resets.
add_task(async function reset_pinned_tab_still_resets() {
  const setup = await setUpFolderTab("reset");
  const { tab, home } = setup;
  await navigateByLoad(tab, "reset");
  gZenPinnedTabManager.resetPinnedTab(tab);
  await selectAndWait(tab, home, "Reset Pinned Tab sends the folder tab home");
  await cleanUp(setup);
});

// Restart: what the session saves for the unloaded folder tab is its latest
// page, and a window restored from the session opens it there.
add_task(async function restored_folder_tab_shows_its_latest_page() {
  const setup = await setUpFolderTab("restore");
  const { tab } = setup;
  await navigateByLoad(tab, "restore");
  const latest = await navigateByPushState(tab, "restore");
  await UNLOADS.folder(setup);
  await TestUtils.waitForCondition(() => tab.hasAttribute("pending"), "Unloaded");

  // The Zen session file (what a restart restores the sidebar from).
  ZenSessionStore.saveState(SessionStore.getCurrentState(true), true);
  const saved = ZenSessionStore.getSidebarData().tabs.find(t => t.zenSyncId == tab.id);
  ok(saved, "The folder tab is in the saved session");
  is(saved.entries[saved.index - 1]?.url, latest, "The saved session holds the folder tab's latest page");

  const win = await BrowserTestUtils.openNewBrowserWindow();
  await win.gZenWorkspaces.promiseInitialized;
  const copy = await TestUtils.waitForCondition(() => win.document.getElementById(tab.id), "The new window has the folder tab");
  win.gBrowser.selectedTab = copy;
  await TestUtils.waitForCondition(
    () => copy.linkedBrowser.currentURI.spec != "about:blank" && !copy.hasAttribute("pending"),
    "The other window's copy loads"
  );
  is(copy.linkedBrowser.currentURI.spec, latest, "The new window opens the folder tab on its latest page");
  await BrowserTestUtils.closeWindow(win);
  await cleanUp(setup);
});
