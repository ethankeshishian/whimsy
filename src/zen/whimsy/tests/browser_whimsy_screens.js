/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Whimsy: a screenshot tool, so changes can be checked by eye without macOS
// Screen Recording permission. It draws the real window from inside Gecko.
//   WHIMSY_SHOTS=/some/dir npm test -- ui/browser_whimsy_screens.js
// Without WHIMSY_SHOTS it only does a quick smoke check.

const SHOTS = Services.env.get("WHIMSY_SHOTS");

async function shot(name, windowGlobal = window.browsingContext.currentWindowGlobal) {
  if (!SHOTS) {
    return;
  }
  const bitmap = await windowGlobal.drawSnapshot(null, 1, "white");
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  const blob = await new Promise(resolve => canvas.toBlob(resolve));
  const path = PathUtils.join(SHOTS, `${name}.png`);
  await IOUtils.write(path, new Uint8Array(await blob.arrayBuffer()));
  info(`Saved ${path}`);
}

add_task(async function window_with_tabs() {
  const tabs = [];
  for (const url of ["https://example.com/", "https://example.org/"]) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, url));
  }
  await shot("01-window");

  // The tab context menu: every item labelled, and wide enough to read.
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(tabs[0], { type: "contextmenu", button: 2 });
  await shown;
  const items = [...menu.children].filter(
    el => el.localName == "menuitem" && !el.hidden && el.checkVisibility()
  );
  ok(items.length > 3, "The tab context menu has items");
  // Some labels (like Mute Tab) are set as the menu opens and arrive a moment later.
  await TestUtils.waitForCondition(
    () => items.every(item => item.getAttribute("label")),
    "Every menu item gets a label"
  ).catch(() => {});
  for (const item of items) {
    ok(item.getAttribute("label"), `Menu item ${item.id} has a label`);
  }
  Assert.greater(menu.getBoundingClientRect().width, 150, "The menu is wide enough to read");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;

  for (const tab of tabs) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function settings_app_icon() {
  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const doc = browser.contentDocument;
    const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyAppIconGroup"));
    await TestUtils.waitForCondition(() => group.checkVisibility(), "App icon settings visible");
    group.scrollIntoView({ block: "start" });
    await new Promise(resolve => browser.contentWindow.requestAnimationFrame(resolve));
    await shot("02-settings-app-icon", browser.browsingContext.currentWindowGlobal);
  });
});

add_task(async function settings_updates() {
  const { WhimsyUpdates } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyUpdates.sys.mjs"
  );
  const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "whimsy-shots");
  await IOUtils.writeJSON(PathUtils.join(dir, "state.json"), {
    status: "idle",
    last_run: new Date().toISOString(),
    last_result: "up-to-date",
    installed: { id: "b", version: "1.24b-w2" },
    previous: { id: "a", version: "1.24b-w1" },
  });
  await IOUtils.writeJSON(PathUtils.join(dir, "whimsy-version.json"), {
    version: "1.24b-w2",
    zen: "1.24b",
    zen_label: "dev (2026-10-27)",
    firefox: "159.0",
    released: true,
    history: [
      {
        version: "1.24b-w2", zen: "1.24b", date: "2026-10-28",
        notes: ["GitHub live folders: My Review Requests, Team Review Requests", "Version history in Settings"],
      },
      { version: "1.24b-w1", zen: "1.24b", date: "2026-10-28", notes: ["First public release"] },
      { version: "1.23.4b-w3", zen: "1.23.4b", date: "2026-10-20", notes: [] },
    ],
  });
  await IOUtils.makeDirectory(PathUtils.join(dir, "logs"));
  await IOUtils.writeUTF8(
    PathUtils.join(dir, "logs", "update.log"),
    "[03:30] Checking Zen releases\n[03:31] Zen 1.24b is newer than 1.23.4b\n[04:12] Build passed, tests passed\n[04:13] Staged Zen 1.24b\n"
  );
  const saved = {
    dataDir: WhimsyUpdates.dataDir,
    versionFile: WhimsyUpdates.versionFile,
    isInstalled: WhimsyUpdates.isInstalled,
  };
  WhimsyUpdates.dataDir = dir;
  WhimsyUpdates.versionFile = PathUtils.join(dir, "whimsy-version.json");
  WhimsyUpdates.isInstalled = () => true;
  try {
    await BrowserTestUtils.withNewTab("about:preferences#about", async browser => {
      const doc = browser.contentDocument;
      const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyUpdatesGroup"));
      await TestUtils.waitForCondition(() => group.checkVisibility(), "Updates settings visible");
      doc.getElementById("whimsyUpdatesHistory").open = true;
      await TestUtils.waitForCondition(() =>
        doc.getElementById("whimsyUpdatesHistoryList").textContent.includes("Rebuilt with no")
      );
      await TestUtils.waitForCondition(() =>
        doc.getElementById("whimsyUpdatesRollback").getAttribute("label")?.includes("1.24b-w1")
      );
      group.scrollIntoView({ block: "start" });
      await new Promise(resolve => browser.contentWindow.requestAnimationFrame(resolve));
      await shot("03-settings-updates", browser.browsingContext.currentWindowGlobal);
    });
  } finally {
    Object.assign(WhimsyUpdates, saved);
    await IOUtils.remove(dir, { recursive: true });
  }
});

add_task(async function updated_notice() {
  const notification = await window.WhimsyWindow.showUpdatedNotice(
    { id: "shot", version: "1.24b-w2", zen: "1.24b", notes_url: "https://example.com/notes" },
    { force: true }
  );
  ok(notification, "The after-update notice appears in the sidebar");
  await TestUtils.waitForCondition(
    () => notification.shadowRoot?.textContent.includes("What's new"),
    "The notice is labelled"
  );
  // Let its slide-in animation finish.
  await Promise.all(notification.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {})));
  await new Promise(resolve => setTimeout(resolve, 600));
  await shot("04-updated-notice");
  notification.remove();
});

add_task(async function copy_link_toast() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  await SpecialPowers.pushPrefEnv({ set: [["ui.popup.disable_autohide", true]] });
  document.getElementById("cmd_zenCopyCurrentURL").doCommand();
  const container = document.getElementById("zen-toast-container");
  const toast = await TestUtils.waitForCondition(() =>
    [...container.children].find(t => t._messageId == "whimsy-copy-toast")
  );
  await TestUtils.waitForCondition(() => toast.querySelector("label").textContent, "Toast text arrives");
  await Promise.all(toast.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {})));
  await new Promise(resolve => setTimeout(resolve, 400));
  ok(toast.checkVisibility(), "The copy toast shows");
  await shot("05-copy-toast");
  toast.remove();
  container.setAttribute("hidden", true);
  await SpecialPowers.popPrefEnv();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function settings_strip_tracking() {
  await BrowserTestUtils.withNewTab("about:preferences#privacy", async browser => {
    const doc = browser.contentDocument;
    const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyStripTrackingGroup"));
    await TestUtils.waitForCondition(() => group.checkVisibility(), "Tracking in links visible");
    group.scrollIntoView({ block: "center" });
    await new Promise(resolve => browser.contentWindow.requestAnimationFrame(resolve));
    await shot("06-settings-strip-tracking", browser.browsingContext.currentWindowGlobal);
  });
});

add_task(async function settings_cookie_banners() {
  await BrowserTestUtils.withNewTab("about:preferences#privacy", async browser => {
    const doc = browser.contentDocument;
    const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyCookieBannersGroup"));
    await TestUtils.waitForCondition(() => group.checkVisibility(), "Cookie banners visible");
    group.scrollIntoView({ block: "center" });
    await new Promise(resolve => browser.contentWindow.requestAnimationFrame(resolve));
    await shot("07-settings-cookie-banners", browser.browsingContext.currentWindowGlobal);
  });
});

add_task(async function private_window() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  await win.gZenWorkspaces?.promiseInitialized;
  BrowserTestUtils.startLoadingURIString(win.gBrowser.selectedBrowser, "https://example.com/");
  await BrowserTestUtils.browserLoaded(win.gBrowser.selectedBrowser);
  await BrowserTestUtils.openNewForegroundTab(win.gBrowser, "https://example.org/");
  await new Promise(resolve => win.requestAnimationFrame(resolve));
  await shot("08-private-window", win.browsingContext.currentWindowGlobal);
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function settings_tabs() {
  await BrowserTestUtils.withNewTab("about:preferences#zenTabManagement", async browser => {
    const doc = browser.contentDocument;
    const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyTabsGroup"));
    await TestUtils.waitForCondition(() => group.checkVisibility(), "Tabs group visible");
    group.scrollIntoView({ block: "center" });
    await new Promise(resolve => browser.contentWindow.requestAnimationFrame(resolve));
    await shot("09-settings-tabs", browser.browsingContext.currentWindowGlobal);
  });
});

add_task(async function dim_sleeping_tabs() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.tabs.dim-sleeping", true]] });
  const awake = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const asleep = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  gBrowser.selectedTab = awake;
  await gBrowser.explicitUnloadTabs([asleep]);
  await TestUtils.waitForCondition(() => asleep.hasAttribute("pending"), "Tab asleep");
  // Let the fade finish.
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 400));
  await shot("10-dim-sleeping-tabs");
  BrowserTestUtils.removeTab(asleep);
  BrowserTestUtils.removeTab(awake);
  await SpecialPowers.popPrefEnv();
});

add_task(async function tab_title_lines() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.tabs.title-lines", 2]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const long = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  long.setAttribute("label", "A very long page title that needs more than one line to read in full");
  gBrowser._setTabLabel?.(long, "A very long page title that needs more than one line to read in full");
  await new Promise(resolve => requestAnimationFrame(resolve));
  await shot("11-tab-title-lines");
  BrowserTestUtils.removeTab(long);
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function newtab_button_bottom() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.tabs.newtab-button-bottom", true]] });
  const tabs = [];
  for (const url of ["https://example.com/", "https://example.org/"]) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, url));
  }
  await new Promise(resolve => requestAnimationFrame(resolve));
  await shot("12-newtab-bottom");
  for (const tab of tabs) {
    BrowserTestUtils.removeTab(tab);
  }
  await SpecialPowers.popPrefEnv();
  Services.prefs.clearUserPref("zen.view.show-newtab-button-top");
});

add_task(async function folder_colors() {
  const folders = [];
  const colors = {};
  for (const [label, color] of [["Work", "blue"], ["Reading", "orange"], ["Fun", "pink"], ["Plain", null]]) {
    const tab = BrowserTestUtils.addTab(gBrowser, "about:blank");
    const folder = await gZenFolders.createFolder([tab], { renameFolder: false, label });
    folders.push(folder);
    if (color) {
      colors[folder.id] = color;
    }
  }
  Services.prefs.setStringPref("whimsy.folders.colors", JSON.stringify(colors));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await shot("13-folder-colors");
  for (const folder of folders) {
    const removed = BrowserTestUtils.waitForEvent(folder, "TabGroupRemoved");
    folder.delete();
    await removed;
  }
  Services.prefs.clearUserPref("whimsy.folders.colors");
});

add_task(async function loading_line() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const url = "http://mochi.test:8888/browser/zen/whimsy/tests/whimsy_slow_load.sjs?delay=3000";
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, url);
  await TestUtils.waitForCondition(() => document.getElementById("zen-loading-progress-bar"), "Loading");
  await new Promise(resolve => setTimeout(resolve, 1200)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
  await shot("14-loading-line");
  await loaded;
  BrowserTestUtils.removeTab(tab);
});

add_task(async function tab_badges() {
  const setTitle = (tab, title) =>
    SpecialPowers.spawn(tab.linkedBrowser, [title], t => {
      content.document.title = t;
    });
  const tabs = [];
  for (const [url, essential] of [["https://example.com/?e1", true], ["https://example.org/?e2", true], ["https://example.com/?p1", false], ["https://example.org/?p2", false]]) {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
    if (essential) {
      gZenPinnedTabManager.addToEssentials(tab);
    } else {
      gBrowser.pinTab(tab);
    }
    tabs.push(tab);
  }
  const current = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.net/");
  await setTitle(tabs[0], "(3) Chat");
  await setTitle(tabs[2], "Inbox (128) - Mail");
  await setTitle(tabs[1], "Something changed");
  await setTitle(tabs[3], "Also changed");
  await TestUtils.waitForCondition(() => tabs[3].hasAttribute("titlechanged"), "Dots");
  await new Promise(resolve => setTimeout(resolve, 300)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
  await shot("15-tab-badges");
  for (const tab of tabs) {
    if (tab.hasAttribute("zen-essential")) {
      gZenPinnedTabManager.removeEssentials(tab);
    }
    BrowserTestUtils.removeTab(tab);
  }
  BrowserTestUtils.removeTab(current);
});

add_task(async function group_by_domain() {
  const { WhimsyTabs } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyTabs.sys.mjs");
  const tabs = [];
  for (const url of ["https://example.com/a", "https://example.org/", "https://example.com/b", "https://example.com/c"]) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, url));
  }
  const folder = WhimsyTabs.groupByDomain(window, tabs[0]);
  await new Promise(resolve => setTimeout(resolve, 500)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
  await shot("16-group-by-domain");
  const removed = BrowserTestUtils.waitForEvent(folder, "TabGroupRemoved");
  folder.delete();
  await removed;
  for (const tab of tabs.filter(t => !t.closing && t.isConnected)) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function space_drop_target() {
  const space = await gZenWorkspaces.createAndSaveWorkspace("Work", "💼", true);
  const button = await TestUtils.waitForCondition(() =>
    document.querySelector(`#zen-workspaces-button toolbarbutton[zen-workspace-id="${space.uuid}"]`)
  );
  button.setAttribute("whimsy-drop-target", "");
  await new Promise(resolve => setTimeout(resolve, 300)); // eslint-disable-line mozilla/no-arbitrary-setTimeout
  await shot("17-space-drop-target");
  button.removeAttribute("whimsy-drop-target");
  await gZenWorkspaces.removeWorkspace(space.uuid);
});

add_task(async function settings_look() {
  await BrowserTestUtils.withNewTab("about:preferences#zenLooks", async browser => {
    const doc = browser.contentDocument;
    const group = await TestUtils.waitForCondition(() => doc.getElementById("whimsyLookGroup"));
    await TestUtils.waitForCondition(() => group.checkVisibility(), "Look group visible");
    group.scrollIntoView({ block: "center" });
    await new Promise(resolve => browser.contentWindow.requestAnimationFrame(resolve));
    await shot("18-settings-look", browser.browsingContext.currentWindowGlobal);
  });
});

add_task(async function tab_volume_panel() {
  const { WhimsyMedia } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMedia.sys.mjs");
  const panel = WhimsyMedia.openVolumePanel(window, gBrowser.selectedTab);
  try {
    await TestUtils.waitForCondition(() => panel.state == "open");
    await document.l10n.translateFragment(panel);
    await shot("19-tab-volume");
  } finally {
    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    panel.hidePopup();
    await hidden;
  }
});
