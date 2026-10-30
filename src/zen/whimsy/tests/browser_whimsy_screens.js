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
      const firefox = group.closest('setting-group[groupid="updates"]');
      const info = firefox.querySelector("update-information");
      await TestUtils.waitForCondition(() => info.distribution?.includes("Based on Zen"), "Whimsy's version line");
      await TestUtils.waitForCondition(() =>
        doc.getElementById("whimsyUpdatesRollback").getAttribute("label")?.includes("1.24b-w1")
      );
      firefox.scrollIntoView({ block: "start" });
      await new Promise(resolve => browser.contentWindow.requestAnimationFrame(resolve));
      await shot("03-settings-updates", browser.browsingContext.currentWindowGlobal);
    });
  } finally {
    Object.assign(WhimsyUpdates, saved);
    await IOUtils.remove(dir, { recursive: true });
  }
});

// Firefox's About window, with Whimsy's logo and name.
add_task(async function about_dialog() {
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(null, win => win.document.documentURI == "chrome://browser/content/aboutDialog.xhtml");
  window.openAboutDialog();
  const dialog = await opened;
  const logo = dialog.getComputedStyle(dialog.document.getElementById("leftBox")).backgroundImage;
  ok(logo.includes("about-logo"), "The About window shows the branding logo");
  // legacy: Whimsy's wording, no Mozilla donation ask (overlay.py hotfixes).
  await dialog.document.l10n.ready;
  const community = dialog.document.getElementById("communityDesc");
  await TestUtils.waitForCondition(() => community.textContent.includes("built on"), "Whimsy's About wording");
  await new Promise(resolve => dialog.requestAnimationFrame(() => dialog.setTimeout(resolve, 300)));
  await shot("03b-about-dialog", dialog.browsingContext.currentWindowGlobal);
  await BrowserTestUtils.closeWindow(dialog);
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

// wave1/fun: both about:neterror layouts and a real certificate warning.
add_task(async function whimsy_network_errors() {
  for (const felt of [false, true]) {
    await SpecialPowers.pushPrefEnv({ set: [
      ["security.certerrors.felt-privacy-v1", felt],
      ["whimsy.feature.net-error-branding", true],
      ["browser.netError.searchCTA.enabled", false],
    ] });
    try {
      for (const error of ["dnsNotFound", "netOffline", "certificate"]) {
        const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
        const browser = tab.linkedBrowser;
        try {
          const loaded = BrowserTestUtils.waitForErrorPage(browser);
          if (error === "certificate") {
            BrowserTestUtils.startLoadingURIString(browser, "https://expired.example.com/");
          } else {
            await SpecialPowers.spawn(browser, [error], error => {
              content.location = `about:neterror?e=${error}&u=https%3A%2F%2Fexample.com%2F&d=Connection%20failed`;
            });
          }
          await loaded;
          await SpecialPowers.spawn(browser, [], async () => {
            const doc = content.document;
            const root = doc.querySelector("net-error-card")?.shadowRoot || doc;
            await ContentTaskUtils.waitForCondition(
              () => root.querySelector("#whimsy-neterror-brand"), "Whimsy error branding is ready"
            );
            await doc.l10n.translateRoots();
            await ContentTaskUtils.waitForCondition(
              () => root.querySelector("#whimsy-neterror-style")?.sheet, "Whimsy error stylesheet loaded"
            );
            await content.document.fonts.ready;
            await new Promise(resolve => content.requestAnimationFrame(() => content.requestAnimationFrame(resolve)));
          });
          await shot(`20-neterror-${felt ? "felt" : "legacy"}-${error}`, browser.browsingContext.currentWindowGlobal);
        } finally {
          BrowserTestUtils.removeTab(tab);
        }
      }
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
});

// wave2: Mini's destination label and space colors.
add_task(async function mini_whimsy_destination() {
  const { WhimsyQuickWindow } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs"
  );
  const win = WhimsyQuickWindow.open("https://example.com/", { opener: window });
  try {
    await WhimsyQuickWindow.whenReady(win);
    await TestUtils.waitForCondition(() =>
      win.document.getElementById("whimsy-quick-window-move-to-space")?.getAttribute("label")
    );
    await TestUtils.waitForCondition(() =>
      win.document.l10n.getAttributes(win.document.getElementById("whimsy-quick-window-move-to-space"))
        .args?.space == gZenWorkspaces.getActiveWorkspace().name
    );
    await new Promise(resolve => win.requestAnimationFrame(resolve));
    await shot("mini-whimsy-destination", win.browsingContext.currentWindowGlobal);
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

// batch hist: the existing History tab with visit-time space labels.
add_task(async function library_space_history() {
  await SpecialPowers.pushPrefEnv({ set: [
    ["whimsy.feature.space-history", true],
    ["zen.library.history.closed-tabs", false],
  ] });
  const library = document.querySelector("zen-library");
  const previous = library.activeTab;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser,
    "https://example.com/?whimsy-history-screenshot");
  try {
    library.activeTab = "history";
    await library.constructor.animateProgress(1);
    await TestUtils.waitForCondition(() => library.querySelector("whimsy-space-history-section"));
    const section = library.querySelector("whimsy-space-history-section");
    await TestUtils.waitForCondition(async () => {
      await section.refresh();
      return section._flatVisits?.some(visit => visit.url.includes("whimsy-history-screenshot") && visit.spaceId);
    }, "The screenshot includes a recorded space label");
    await section.updateComplete;
    await document.l10n.translateFragment(section);
    ok(section.querySelector(".whimsy-history-space"), "History offers its space filter");
    await shot("history-spaces");
  } finally {
    await library.constructor.animateProgress(0);
    library.activeTab = previous;
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});

// home: every tab, ready for the integration build's screenshot review
// (legacy: 22-privacy is the About dialog's Privacy Notice).
add_task(async function whimsy_home_and_changelog() {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.home", true]] });
  try {
    for (const [suffix, name] of [["", "20-home"], ["?tab=changelog", "21-changelog"], ["?tab=privacy", "22-privacy"]]) {
      await BrowserTestUtils.withNewTab(`about:whimsy${suffix}`, async browser => {
        const doc = browser.contentDocument;
        await doc.l10n.ready;
        if (suffix == "?tab=changelog") {
          await TestUtils.waitForCondition(() => doc.getElementById("whimsy-changelog-list").children.length);
        }
        await shot(name, browser.browsingContext.currentWindowGlobal);
      });
    }
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

// vpnspace: capture the native panel with its scope extension.
add_task(async function vpn_scope_panel() {
  if (!SHOTS || !Services.prefs.getBoolPref("whimsy.feature.vpnspace", true)) {
    return;
  }
  const button = await TestUtils.waitForCondition(() => document.getElementById("ipprotection-button"));
  button.click();
  const scope = await TestUtils.waitForCondition(() => document.getElementById("whimsy-vpn-scope"));
  const panel = scope.closest("panel");
  try {
    await TestUtils.waitForCondition(() => panel?.state === "open");
    await document.l10n.translateFragment(scope);
    await shot("vpn-space-scope");
  } finally {
    panel?.hidePopup();
  }
});

// batch3glance: a Compact and a Wide Glance (Standard is Zen's own).
add_task(async function glance_sizes() {
  const { openGlanceOnTab } = ChromeUtils.importESModule("resource://testing-common/GlanceTestUtils.sys.mjs");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.glance-size", true]] });
  const parent = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  try {
    for (const size of ["compact", "wide"]) {
      Services.prefs.setStringPref("whimsy.glance.size", size);
      await openGlanceOnTab(window, async glanceTab => {
        const wrapper = glanceTab.linkedBrowser.closest(".browserContainer");
        await TestUtils.waitForCondition(() => wrapper.getAttribute("has-finished-animation") == "true");
        ok(wrapper.getBoundingClientRect().width > 0, `${size} Glance is drawn`);
        await shot(`30-glance-${size}`);
      });
    }
  } finally {
    Services.prefs.clearUserPref("whimsy.glance.size");
    BrowserTestUtils.removeTab(parent);
    await SpecialPowers.popPrefEnv();
  }
});

// batch3glance: a three-pane split built Arc's way (Add Bottom Split), then
// turned with Change Orientation.
add_task(async function split_layouts() {
  const { WhimsySplitLayouts } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySplitLayouts.sys.mjs");
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.split-layouts", true]] });
  const tabs = [];
  try {
    for (let i = 0; i < 3; i++) {
      tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, `data:text/html,<h1>Pane ${i + 1}</h1>`));
    }
    gZenViewSplitter.splitTabs(tabs.slice(0, 2), "vsep", 0);
    await TestUtils.waitForCondition(() => tabs[0].splitView);
    WhimsySplitLayouts.insertBeside(window, tabs[0], tabs[2], "bottom");
    ok(tabs[2].splitView, "Three panes");
    await new Promise(resolve => setTimeout(resolve, 400));
    await shot("31-split-add-bottom");
    WhimsySplitLayouts.changeOrientation(window);
    await new Promise(resolve => setTimeout(resolve, 400));
    await shot("32-split-change-orientation");
  } finally {
    if (gZenViewSplitter.currentView >= 0) {
      gZenViewSplitter.unsplitCurrentView();
    }
    for (const tab of tabs) {
      BrowserTestUtils.removeTab(tab);
    }
    await SpecialPowers.popPrefEnv();
  }
});

// wave3/cmdbar: recent tabs when the command bar opens empty.
add_task(async function command_bar_recent_tabs() {
  const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/?recent-screenshot");
  const anchor = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  try {
    gURLBar.value = "";
    await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, waitForFocus, value: "" });
    await TestUtils.waitForCondition(
      () => UrlbarTestUtils.getResultCount(window) && UrlbarTestUtils.getRowAt(window, 0).result.providerName == "WhimsyRecentTabs"
    );
    await document.l10n.translateFragment(gURLBar.view.panel);
    await shot("command-recent-tabs");
  } finally {
    await UrlbarTestUtils.promisePopupClose(window);
    BrowserTestUtils.removeTab(tab);
    BrowserTestUtils.removeTab(anchor);
  }
});

// wave3/cmdbar: a bang in the command bar, and Settings → Search → Bang Shortcuts.
add_task(async function offline_bangs() {
  const { UrlbarTestUtils } = ChromeUtils.importESModule("resource://testing-common/UrlbarTestUtils.sys.mjs");
  try {
    await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, waitForFocus, value: "!w black holes" });
    await TestUtils.waitForCondition(
      () => UrlbarTestUtils.getResultCount(window) && UrlbarTestUtils.getRowAt(window, 0).result.providerName == "WhimsyBangs"
    );
    await shot("command-bang");
  } finally {
    await UrlbarTestUtils.promisePopupClose(window);
  }
  await BrowserTestUtils.withNewTab("about:preferences#search", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(() => doc.getElementById("whimsyBangsList"));
    await doc.l10n.ready;
    doc.getElementById("whimsyBangsGroup").scrollIntoView();
    await shot("settings-bangs", browser.browsingContext.currentWindowGlobal);
  });
});
